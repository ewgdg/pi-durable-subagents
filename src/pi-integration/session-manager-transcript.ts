import { initializeCoordinationProjections } from "../protocol/coordination-projections.ts";
import {
	SessionManager,
	type FileEntry,
	type ExtensionContext,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { RetainedTranscript } from "../transcript/retained-transcript.ts";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
	validateChildIdentityBootstrap,
	validateColdChildIdentity,
} from "../protocol/child-identity.ts";
import {
	MODERATOR_INPUT_CUSTOM_TYPE,
	validateColdModeratorInput,
} from "../protocol/moderator-input.ts";
import {
	AgentTranscript,
	type TranscriptInspection,
	type TranscriptReader,
} from "../transcript/agent-transcript.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

const READ_CHUNK_BYTES = 64 * 1024;
const ENTRIES_PER_TURN = 256;
const CURSOR_ANCHOR_BYTES = 128;

class SessionManagerTranscriptReader implements TranscriptReader {
	readonly #manager: ReadonlySessionManager;

	#cursor = 0;
	#state: RetainedTranscript | undefined;
	readonly #counts = {
		bytesRead: 0,
		entriesParsed: 0,
		entriesConsumed: 0,
		reconstructions: 0,
		localEnumerations: 0,
		localEntriesEnumerated: 0,
	};
	snapshot() {
		return this.#state?.inspection;
	}
	diagnostics() {
		return {
			...this.#counts,
			retainedEntries: this.#state?.entries.length ?? 0,
			branchBuilds: this.#state?.branchBuilds ?? 0,
			contextBuilds: this.#state?.contextBuilds ?? 0,
		};
	}
	constructor(manager: ReadonlySessionManager) {
		this.#manager = manager;
	}
	read(): TranscriptInspection {
		const entries = this.#prepare();
		while (this.#cursor < entries.length) this.#consume(entries);
		this.#state!.setLeaf(this.#manager.getLeafId());
		return this.#state!.inspection;
	}
	#prepare(): readonly SessionEntry[] {
		const entries = this.#manager.getEntries();
		this.#counts.localEnumerations++;
		this.#counts.localEntriesEnumerated += entries.length;
		const header = this.#manager.getHeader();
		const path = this.#manager.getSessionFile() ?? null;
		const previous = this.#state?.entries;
		// getEntries returns a fresh shallow list. Public entries are immutable;
		// retain endpoint references to detect a reset/reload without reprocessing history.
		if (
			!this.#state ||
			header !== this.#state.inspection.header ||
			path !== this.#state.inspection.transcriptPath ||
			entries.length < this.#cursor ||
			(this.#cursor > 0 &&
				(entries[0] !== previous?.[0] ||
					entries[this.#cursor - 1] !== previous?.[this.#cursor - 1]))
		) {
			this.#cursor = 0;
			this.#counts.reconstructions++;
			this.#state = new RetainedTranscript(header, path, initializeCoordinationProjections);
		}
		return entries;
	}

	#consume(entries: readonly SessionEntry[]): void {
		const entry = entries[this.#cursor]!;
		this.#state!.append(entry);
		this.#counts.entriesConsumed++;
		this.#cursor++;
	}
	async refresh(): Promise<TranscriptInspection> {
		let entries = this.#prepare();
		while (this.#cursor < entries.length) {
			const end = Math.min(entries.length, this.#cursor + ENTRIES_PER_TURN);
			while (this.#cursor < end) this.#consume(entries);
			this.#state!.setLeaf(this.#manager.getLeafId());
			await yieldTurn();
			entries = this.#prepare();
		}
		this.#state!.setLeaf(this.#manager.getLeafId());
		return this.#state!.inspection;
	}
}

/** Byte cursor advances only across complete JSONL records. */
class SessionFileTranscriptReader implements TranscriptReader {
	readonly #path: string;
	#state: RetainedTranscript | undefined;
	readonly #counts = {
		bytesRead: 0,
		entriesParsed: 0,
		entriesConsumed: 0,
		reconstructions: 0,
		localEnumerations: 0,
		localEntriesEnumerated: 0,
	};
	snapshot() {
		return this.#state?.inspection;
	}
	diagnostics() {
		return {
			...this.#counts,
			retainedEntries: this.#state?.entries.length ?? 0,
			branchBuilds: this.#state?.branchBuilds ?? 0,
			contextBuilds: this.#state?.contextBuilds ?? 0,
		};
	}
	#cursor = 0;
	#device = -1;
	#inode = -1;
	#size = -1;
	#mtime = -1;
	#ctime = -1;
	#pending: { fd: number; iterator: Generator<void> } | undefined;
	#partial = Buffer.alloc(0);
	#readPosition = 0;
	#anchor = Buffer.alloc(0);
	constructor(path: string) {
		if (!isAbsolute(path) || path.includes("\0"))
			throw new Error("invalid_transcript_path: session file must be absolute");
		this.#path = path;
	}
	#open(): { fd: number; size: number } | undefined {
		const stat = statSync(this.#path);
		if (
			this.#state &&
			stat.dev === this.#device &&
			stat.ino === this.#inode &&
			stat.size === this.#size &&
			stat.mtimeMs === this.#mtime &&
			stat.ctimeMs === this.#ctime
		)
			return undefined;
		const fd = openSync(this.#path, "r");
		const actual = fstatSync(fd);
		if (
			!this.#state ||
			actual.dev !== this.#device ||
			actual.ino !== this.#inode ||
			actual.size < this.#readPosition ||
			(actual.size === this.#size &&
				(actual.mtimeMs !== this.#mtime || actual.ctimeMs !== this.#ctime))
		) {
			this.#reset();
		}
		if (this.#cursor && this.#anchor.length) {
			const anchor = Buffer.alloc(this.#anchor.length);
			this.#counts.bytesRead += readSync(
				fd,
				anchor,
				0,
				anchor.length,
				this.#cursor - anchor.length,
			);
			if (!anchor.equals(this.#anchor)) this.#reset();
		}
		// An incomplete tail is not committed evidence. A writer may replace it
		// while growing the file, so restart that tail at the committed cursor.
		this.#partial = Buffer.alloc(0);
		this.#readPosition = this.#cursor;
		this.#device = actual.dev;
		this.#inode = actual.ino;
		this.#size = actual.size;
		this.#mtime = actual.mtimeMs;
		this.#ctime = actual.ctimeMs;
		return { fd, size: actual.size };
	}
	#reset(): void {
		this.#counts.reconstructions++;
		this.#state = new RetainedTranscript(null, this.#path, initializeCoordinationProjections);
		this.#cursor = 0;
		this.#readPosition = 0;
		this.#partial = Buffer.alloc(0);
		this.#anchor = Buffer.alloc(0);
	}
	*#consume(fd: number, size: number): Generator<void> {
		let position = this.#readPosition;
		let pending = this.#partial;
		let count = 0;
		while (position < size) {
			const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - position));
			const read = readSync(fd, buffer, 0, buffer.length, position);
			if (!read) break;
			position += read;
			this.#counts.bytesRead += read;
			pending = Buffer.concat([pending, buffer.subarray(0, read)]);
			let offset = 0;
			let newline: number;
			while ((newline = pending.indexOf(10, offset)) !== -1) {
				const line = new TextDecoder("utf-8", { fatal: true }).decode(
					pending.subarray(offset, newline),
				);
				if (line.trim()) {
					const entry = JSON.parse(line) as FileEntry;
					this.#counts.entriesParsed++;
					if (entry.type === "session") {
						if (this.#cursor !== 0)
							throw new Error("invalid_transcript: unexpected session header");
						this.#state = new RetainedTranscript(
							entry,
							this.#path,
							initializeCoordinationProjections,
						);
					} else {
						if (!entry.id || !("parentId" in entry))
							throw new Error("invalid_transcript: entry has no physical identity");
						this.#state!.append(entry);
						this.#counts.entriesConsumed++;
						this.#state!.setLeaf(entry.id);
					}
				}
				this.#anchor = Buffer.from(
					pending.subarray(Math.max(offset, newline + 1 - CURSOR_ANCHOR_BYTES), newline + 1),
				);
				this.#cursor += newline + 1 - offset;
				offset = newline + 1;
				if (++count === ENTRIES_PER_TURN) {
					count = 0;
					yield;
				}
			}
			pending = Buffer.from(pending.subarray(offset));
			this.#partial = pending;
			this.#readPosition = position;
			yield;
		}
	}
	#start(): void {
		if (this.#pending) return;
		const source = this.#open();
		if (source) this.#pending = { fd: source.fd, iterator: this.#consume(source.fd, source.size) };
	}
	#step(): boolean {
		const pending = this.#pending;
		if (!pending) return false;
		try {
			if (!pending.iterator.next().done) return true;
		} catch (error) {
			// Retry from the last committed cursor after an unsuccessful decode.
			this.#size = -1;
			this.#readPosition = this.#cursor;
			this.#partial = Buffer.alloc(0);
			closeSync(pending.fd);
			this.#pending = undefined;
			throw error;
		}
		closeSync(pending.fd);
		this.#pending = undefined;
		return false;
	}
	read(): TranscriptInspection {
		this.#start();
		while (this.#step()) {
			/* current synchronous read drains the shared cursor */
		}
		this.#start();
		while (this.#step()) {
			/* observe a replacement or append during catch-up */
		}
		return this.#state!.inspection;
	}
	async refresh(): Promise<TranscriptInspection> {
		do {
			this.#start();
			while (this.#step()) await yieldTurn();
			this.#start();
		} while (this.#pending);
		return this.#state!.inspection;
	}
}

const localTranscripts = new WeakMap<ReadonlySessionManager, AgentTranscript>();
export function transcriptFromSessionManager(manager: ReadonlySessionManager, options?: { fresh: boolean }): AgentTranscript {
	let transcript = options?.fresh ? undefined : localTranscripts.get(manager);
	if (!transcript) {
		transcript = new AgentTranscript(new SessionManagerTranscriptReader(manager));
		localTranscripts.set(manager, transcript);
	}
	return transcript;
}

const fileTranscripts = new Map<string, WeakRef<AgentTranscript>>();
const releasedFiles = new FinalizationRegistry<string>((path) => {
	if (!fileTranscripts.get(path)?.deref()) fileTranscripts.delete(path);
});
export function transcriptFromSessionFile(path: string, options?: { fresh: boolean }): AgentTranscript {
	let transcript = options?.fresh ? undefined : fileTranscripts.get(path)?.deref();
	if (!transcript) {
		transcript = new AgentTranscript(new SessionFileTranscriptReader(path));
		fileTranscripts.set(path, new WeakRef(transcript));
		releasedFiles.register(transcript, path);
	}
	return transcript;
}

export async function materializeNewAgentTranscript(
	sessionManager: SessionManager,
): Promise<string> {
	const sessionFile = sessionManager.getSessionFile();
	const header = sessionManager.getHeader();
	if (!sessionFile || !header) {
		throw new Error("transcript_materialization_failed: persisted session header is unavailable");
	}
	const entries = sessionManager.getEntries();
	if (entries.length === 0) {
		throw new Error("transcript_materialization_failed: Agent Identity evidence is unavailable");
	}
	if (header.id !== sessionManager.getSessionId()) {
		throw new Error("transcript_materialization_failed: header does not match the Agent session");
	}
	const coldIdentityOptions = {
		sessionId: sessionManager.getSessionId(),
		entries,
	};
	if (
		entries[0]?.type === "custom_message" &&
		entries[0].customType === MODERATOR_INPUT_CUSTOM_TYPE
	) {
		validateColdModeratorInput(coldIdentityOptions);
	} else {
		const identity = validateColdChildIdentity(coldIdentityOptions);
		validateChildIdentityBootstrap({
			entries,
			identity,
		});
	}
	const body = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	try {
		await writeFile(sessionFile, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if (hasCode(error, "EEXIST")) {
			throw new Error("transcript_materialization_failed: transcript already exists", {
				cause: error,
			});
		}
		throw error;
	}
	return sessionFile;
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === code
	);
}
