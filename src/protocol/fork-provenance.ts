import { CURRENT_SESSION_VERSION, type SessionEntry, type SessionManager, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { bootstrapAgent } from "../transcript/retained-transcript.ts";

export const OWNER_FORK_PROVENANCE_CUSTOM_TYPE = "agent-coordination.fork-provenance";
type Evidence = Pick<TranscriptInspection, "sessionId" | "header" | "entries">;
type Origins = ReadonlyMap<string, string | null>;

function cutoffOf(transcript: Evidence): number {
	return transcript.entries.findLastIndex(entry => bootstrapAgent(entry) === transcript.sessionId);
}

function unknownOrigins(entries: readonly SessionEntry[]): Origins {
	return new Map(entries.map(entry => [entry.id, null]));
}

/** Presentation evidence only; this map never establishes identity or protocol scope. */
export function inspectOwnerForkProvenance(transcript: TranscriptInspection): Origins | undefined {
	return inspectCapture(transcript);
}

function inspectCapture(transcript: Evidence): Origins | undefined {
	const cutoff = cutoffOf(transcript);
	if (cutoff < 0) return undefined;
	const identity = transcript.entries[cutoff]!;
	const inherited = transcript.entries.slice(0, cutoff);
	const captures = transcript.entries.slice(cutoff + 1).filter(entry =>
		entry.type === "custom" && entry.customType === OWNER_FORK_PROVENANCE_CUSTOM_TYPE);
	if (!captures.length) return undefined;
	// Contradictory/malformed presentation data must not manufacture source attribution.
	if (captures.length !== 1) return unknownOrigins(inherited);
	const capture = captures[0]!;
	const data = capture.type === "custom" ? capture.data : undefined;
	if (!isRecord(data) || data.version !== 1 || data.agentId !== transcript.sessionId ||
		data.identityEntryId !== identity.id || !Array.isArray(data.origins) ||
		data.origins.length !== inherited.length) return unknownOrigins(inherited);
	const origins = new Map<string, string | null>();
	for (let index = 0; index < inherited.length; index++) {
		const origin: unknown = data.origins[index];
		if (!isRecord(origin) || origin.entryId !== inherited[index]!.id ||
			!(origin.agentId === null || typeof origin.agentId === "string" && origin.agentId.length > 0)) {
			return unknownOrigins(inherited);
		}
		origins.set(origin.entryId as string, origin.agentId as string | null);
	}
	return origins;
}

/**
 * Capture once at fresh Owner admission; subsequent admissions are destination-only.
 * A crash before this append can lose provenance if the source also disappears.
 * Explicit unknown preserves honesty without a sidecar or source transcript repair.
 */
export async function captureOwnerForkProvenance(manager: SessionManager): Promise<void> {
	const transcript: Evidence = {
		sessionId: manager.getSessionId(), header: manager.getHeader(), entries: manager.getEntries(),
	};
	if (!transcript.header?.parentSession || inspectCapture(transcript) !== undefined) return;
	const cutoff = cutoffOf(transcript);
	const identity = transcript.entries[cutoff];
	if (identity?.type !== "custom" || !isRecord(identity.data) ||
		identity.data.workflowId !== transcript.sessionId || identity.data.directSpawnerAgentId !== null ||
		"spawnSource" in identity.data) return;
	const origins = await inheritedOrigins(transcript, new Set());
	manager.appendCustomEntry(OWNER_FORK_PROVENANCE_CUSTOM_TYPE, {
		version: 1, agentId: transcript.sessionId, identityEntryId: identity.id,
		origins: [...origins].map(([entryId, agentId]) => ({ entryId, agentId })),
	});
}

async function inheritedOrigins(transcript: Evidence, visited: Set<string>): Promise<Origins> {
	const captured = inspectCapture(transcript);
	if (captured) return captured;
	const cutoff = cutoffOf(transcript);
	// An interrupted fork may not yet have its own Identity. Its entire prefix is inherited.
	const inherited = cutoff < 0 ? transcript.entries : transcript.entries.slice(0, cutoff);
	const parentPath = transcript.header?.parentSession;
	if (!parentPath || !isAbsolute(parentPath)) return unknownOrigins(inherited);
	const path = resolve(parentPath);
	if (visited.has(path)) return unknownOrigins(inherited);
	visited.add(path);
	const source = await readSource(path);
	if (!source) return unknownOrigins(inherited);
	const sourceCutoff = cutoffOf(source);
	const sourceInherited = await inheritedOrigins(source, visited);
	const byId = new Map(source.entries.map((entry, index) => [entry.id, { entry, index }]));
	return new Map(inherited.map(entry => {
		const original = byId.get(entry.id);
		if (!original || !sameCopiedEntry(entry, original.entry)) return [entry.id, null];
		// Branch parentage can precede Identity while physical authorship follows it.
		const origin = sourceCutoff >= 0 && original.index >= sourceCutoff
			? source.sessionId : sourceInherited.get(entry.id) ?? null;
		return [entry.id, origin];
	}));
}

function sameCopiedEntry(copied: SessionEntry, source: SessionEntry): boolean {
	// Native branch extraction re-chains parents and may remap compaction boundaries around labels.
	const normalize = (entry: SessionEntry) => {
		const { parentId: _parentId, ...rest } = entry;
		if (rest.type === "compaction") {
			const { firstKeptEntryId: _firstKeptEntryId, ...compaction } = rest;
			return compaction;
		}
		return rest;
	};
	return isDeepStrictEqual(normalize(copied), normalize(source));
}

// Read-only: unlike SessionManager.open, a missing source must never create a session.
// Require complete current-version JSONL and coherent physical entry IDs; malformed
// or unavailable evidence yields unknown, while unexpected I/O failures still surface.
async function readSource(path: string): Promise<Evidence | undefined> {
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (error) {
		// A vanished, inaccessible, or non-file parent is unavailable evidence, not an empty session.
		if (isRecord(error) && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"].includes(String(error.code))) return undefined;
		throw error;
	}
	let records: unknown[];
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (!text.endsWith("\n")) return undefined;
		records = text.slice(0, -1).split("\n").map(line => JSON.parse(line));
	} catch (error) {
		if (error instanceof SyntaxError ||
			isRecord(error) && error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") return undefined;
		throw error;
	}
	const header = records[0];
	if (!isRecord(header) || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION ||
		typeof header.id !== "string" || !header.id ||
		!(header.parentSession === undefined || typeof header.parentSession === "string")) return undefined;
	const entries: SessionEntry[] = [];
	const ids = new Set<string>();
	for (const value of records.slice(1)) {
		if (!isRecord(value) || typeof value.type !== "string" || value.type === "session" ||
			typeof value.id !== "string" || !value.id || ids.has(value.id) ||
			!(value.parentId === null || typeof value.parentId === "string" && ids.has(value.parentId)) ||
			typeof value.timestamp !== "string") return undefined;
		ids.add(value.id);
		entries.push(value as unknown as SessionEntry);
	}
	return { sessionId: header.id, header: header as unknown as SessionHeader, entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
