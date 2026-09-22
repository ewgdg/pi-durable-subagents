import {
	buildSessionProjection,
	type SessionContext,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { TranscriptInspection } from "./agent-transcript.ts";

/** Disposable physical history and indexes, owned by one transcript adapter. */
export class RetainedTranscript {
	readonly entries: SessionEntry[] = [];
	branchBuilds = 0;
	contextBuilds = 0;
	readonly byId = new Map<string, SessionEntry>();
	readonly requestChanges: string[] = [];
	scopeVersion = 0;
	readonly #requestsByToolCall = new Map<string, Set<string>>();
	readonly #requestsByMessageSource = new Map<string, Set<string>>();
	readonly #requestVersions = new Map<string, number>();
	readonly positions = new Map<string, number>();
	readonly scopes = new Map<string, SessionEntry[]>();
	readonly #settings = new Map<string, TranscriptSettings>();
	recency: number | undefined;
	readonly #buckets = new Map<string, SessionEntry[]>();
	readonly #memo = new Map<unknown, Map<string, { version: unknown; value: unknown }>>();
	readonly #derived = new Map<unknown, Map<string, Projection>>();
	#leaf: string | null = null;
	#branch: SessionEntry[] | undefined;
	#context: SessionContext | undefined;
	readonly inspection: TranscriptInspection;
	readonly #initializeProjections:
		((transcript: TranscriptInspection, agentId: string) => void) | undefined;

	constructor(
		header: SessionHeader | null,
		path: string | null,
		initializeProjections?: (transcript: TranscriptInspection, agentId: string) => void,
	) {
		this.#initializeProjections = initializeProjections;
		const state = this;
		this.inspection = {
			sessionId: header?.id ?? "",
			transcriptPath: path,
			header,
			entries: this.entries,
			get activeBranch() {
				return state.branch();
			},
			get context() {
				return state.context();
			},
		};
		states.set(this.inspection, this);
	}

	append(entry: SessionEntry): void {
		// Finish indexing before exposing the new physical tail. There is no await
		// inside an entry commit, so consumers cannot observe half an update.
		this.positions.set(entry.id, this.entries.length);
		this.byId.set(entry.id, entry);
		const parentSettings =
			(entry.parentId ? this.#settings.get(entry.parentId) : undefined) ?? DEFAULT_SETTINGS;
		let settings = parentSettings;
		if (entry.type === "model_change")
			settings = { ...settings, model: { provider: entry.provider, modelId: entry.modelId } };
		if (entry.type === "thinking_level_change")
			settings = { ...settings, thinkingLevel: entry.thinkingLevel, hasRecordedThinking: true };
		if (entry.type === "message" && entry.message.role === "assistant")
			settings = {
				...settings,
				model: { provider: entry.message.provider, modelId: entry.message.model },
			};
		this.#settings.set(entry.id, settings);
		if (
			entry.type === "message" &&
			(entry.message.role === "assistant" || entry.message.role === "user")
		) {
			const timestamp =
				typeof entry.message.timestamp === "number"
					? entry.message.timestamp
					: Date.parse(entry.timestamp);
			if (!Number.isNaN(timestamp)) this.recency = Math.max(this.recency ?? 0, timestamp);
		}
		const bootstrap = bootstrapAgent(entry);
		if (bootstrap) {
			this.scopes.set(bootstrap, []);
			this.scopeVersion++;
			this.requestChanges.length = 0;
			this.#requestVersions.clear();
			this.#requestsByToolCall.clear();
			this.#requestsByMessageSource.clear();
		}
		for (const [agentId, scope] of this.scopes) {
			if (agentId === bootstrap) {
				for (const key of this.#buckets.keys()) {
					if (key.startsWith(`${agentId}\0`)) this.#buckets.delete(key);
				}
				this.#derived.clear();
				this.#memo.clear();
				continue;
			}
			scope.push(entry);
			for (const key of entryKeys(entry)) {
				const bucketKey = `${agentId}\0${key}`;
				let bucket = this.#buckets.get(bucketKey);
				if (!bucket) this.#buckets.set(bucketKey, (bucket = []));
				bucket.push(entry);
			}
		}
		this.entries.push(entry);
		if (bootstrap === this.inspection.sessionId)
			this.#initializeProjections?.(this.inspection, bootstrap);
		if (entry.type === "message" && entry.message.role === "toolResult") {
			for (const requestId of this.#requestsByToolCall.get(entry.message.toolCallId) ?? [])
				this.touchRequest(requestId);
			const details = entry.message.details;
			if (
				typeof details === "object" &&
				details !== null &&
				"requestMessageId" in details &&
				typeof details.requestMessageId === "string"
			)
				this.touchRequest(details.requestMessageId);
		}
		for (const projections of this.#derived.values()) {
			for (const projection of projections.values()) this.#advance(projection);
		}
	}

	setLeaf(leaf: string | null): void {
		if (leaf === this.#leaf) return;
		this.#leaf = leaf;
		this.#branch = undefined;
		this.#context = undefined;
	}

	bucket(agentId: string, key: string): readonly SessionEntry[] {
		this.scope(agentId);
		const bucketKey = `${agentId}\0${key}`;
		let bucket = this.#buckets.get(bucketKey);
		if (!bucket) this.#buckets.set(bucketKey, (bucket = []));
		return bucket;
	}

	scope(agentId: string): readonly SessionEntry[] {
		const scope = this.scopes.get(agentId);
		if (!scope) throw new Error(`invariant_violation: Agent ${agentId} has no current Identity`);
		return scope;
	}

	bindRequestSource(toolCallId: string, requestId: string): void {
		let requests = this.#requestsByToolCall.get(toolCallId);
		if (!requests) this.#requestsByToolCall.set(toolCallId, (requests = new Set()));
		if (requests.has(requestId)) return;
		requests.add(requestId);
		this.touchRequest(requestId);
	}

	observeMessageRequest(sourceKey: string, requestId: string): void {
		let requests = this.#requestsByMessageSource.get(sourceKey);
		if (!requests) this.#requestsByMessageSource.set(sourceKey, (requests = new Set()));
		requests.add(requestId);
		// Conflicting correlation must invalidate the earlier Request too.
		for (const related of requests) this.touchRequest(related);
	}

	touchRequest(requestId: string): void {
		this.requestChanges.push(requestId);
		this.#requestVersions.set(requestId, (this.#requestVersions.get(requestId) ?? 0) + 1);
	}

	requestVersion(requestId: string): number {
		return this.#requestVersions.get(requestId) ?? 0;
	}

	memo<T>(owner: unknown, key: string, version: unknown, compute: () => T): T {
		let values = this.#memo.get(owner);
		if (!values) this.#memo.set(owner, (values = new Map()));
		const existing = values.get(key);
		if (existing && sameVersion(existing.version, version)) return existing.value as T;
		const value = compute();
		values.set(key, { version, value });
		return value;
	}

	/** A projection consumes only new entries from its shared indexed bucket. */
	project<T>(
		owner: unknown,
		key: string,
		entries: readonly SessionEntry[],
		initial: () => T,
		consume: (value: T, entry: SessionEntry) => T,
	): T {
		let projections = this.#derived.get(owner);
		if (!projections) this.#derived.set(owner, (projections = new Map()));
		let projection = projections.get(key);
		if (!projection) {
			projection = {
				count: 0,
				value: initial(),
				entries,
				consume: consume as Projection["consume"],
			};
			projections.set(key, projection);
		}
		this.#advance(projection);
		if (projection.error !== undefined) throw projection.error;
		return projection.value as T;
	}

	#advance(projection: Projection): void {
		if (projection.error !== undefined) return;
		try {
			while (projection.count < projection.entries.length) {
				projection.value = projection.consume(
					projection.value,
					projection.entries[projection.count]!,
				);
				projection.count++;
			}
		} catch (error) {
			// Corrupt evidence remains observable by its consumer. It does not stop
			// other projections from consuming the same committed physical entry.
			projection.error = error;
		}
	}

	branch(): SessionEntry[] {
		if (this.#branch) return this.#branch;
		this.branchBuilds++;
		const branch: SessionEntry[] = [];
		const visited = new Set<string>();
		let id = this.#leaf;
		while (id && !visited.has(id)) {
			visited.add(id);
			const entry = this.byId.get(id);
			if (!entry) break;
			branch.push(entry);
			id = entry.parentId;
		}
		return (this.#branch = branch.reverse());
	}

	settings(): TranscriptSettings {
		return this.#settings.get(this.#leaf ?? this.entries.at(-1)?.id ?? "") ?? DEFAULT_SETTINGS;
	}

	context(): SessionContext {
		if (!this.#context) {
			this.contextBuilds++;
			// Project from the canonical session projection so append-only context
			// edits (e.g. hidden resolved attention) apply to model context. The
			// SessionContext shape is preserved for existing callers.
			const projection = buildSessionProjection(this.entries, this.#leaf, this.byId);
			this.#context = { messages: projection.messages, thinkingLevel: projection.thinkingLevel, model: projection.model };
		}
		return this.#context;
	}
}

const states = new WeakMap<TranscriptInspection, RetainedTranscript>();
export function retainedState(transcript: TranscriptInspection): RetainedTranscript | undefined {
	return states.get(transcript);
}

export function entryKeys(entry: SessionEntry): string[] {
	const keys: string[] = [entry.type];
	if (entry.type === "message") {
		keys.push(`role:${entry.message.role}`);
		if (entry.message.role === "toolResult") keys.push(`result:${entry.message.toolCallId}`);
		if (entry.message.role === "assistant") {
			for (const part of entry.message.content) {
				if (part.type === "toolCall") {
					keys.push(`call:${part.id}`, `tool:${part.name}`);
					if (
						part.name === "agent_spawn" ||
						(part.name === "agent_message" && part.arguments?.operation === "request")
					)
						keys.push("request-source");
				}
			}
		}
	}
	if (entry.type === "custom" || entry.type === "custom_message") {
		keys.push(`custom:${entry.customType}`);
		if (entry.customType.startsWith("agent-coordination.")) keys.push("coordination");
	}
	return [...new Set(keys)];
}

export function bootstrapAgent(entry: SessionEntry): string | undefined {
	const data =
		entry.type === "custom" && entry.customType === "agent-coordination.identity"
			? entry.data
			: entry.type === "custom_message" && entry.customType === "agent-coordination.moderator-input"
				? entry.details
				: undefined;
	return typeof data === "object" &&
		data !== null &&
		"agentId" in data &&
		typeof data.agentId === "string"
		? data.agentId
		: undefined;
}

/** Use the transcript's one shared index, including plain inspection fixtures. */
export function indexedState(transcript: TranscriptInspection): RetainedTranscript {
	const existing = states.get(transcript);
	if (existing) return existing;
	const state = new RetainedTranscript(transcript.header, transcript.transcriptPath);
	for (const entry of transcript.entries) state.append(entry);
	states.set(transcript, state);
	return state;
}

export function coordinationEntries(
	transcript: TranscriptInspection,
	agentId: string,
	key: string,
): readonly SessionEntry[] {
	return indexedState(transcript).bucket(agentId, key);
}

export type TranscriptSettings = Pick<SessionContext, "model" | "thinkingLevel"> & {
	hasRecordedThinking: boolean;
};
const DEFAULT_SETTINGS: TranscriptSettings = {
	model: null,
	thinkingLevel: "off",
	hasRecordedThinking: false,
};

type Projection = {
	count: number;
	value: unknown;
	entries: readonly SessionEntry[];
	consume(value: unknown, entry: SessionEntry): unknown;
	error?: unknown;
};

function sameVersion(left: unknown, right: unknown): boolean {
	return (
		left === right ||
		(Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => value === right[index]))
	);
}
