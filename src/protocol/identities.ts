import { indexedState, coordinationEntries } from "../transcript/retained-transcript.ts";
import { createHash } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";


const IDENTITY_PREFIX = "agent-coordination";

export type ToolCallPointer = Readonly<{
	agentId: string;
	entryId: string;
	toolCallId: string;
}>;

export class ProtocolInvariantError extends Error {
	readonly source?: ToolCallPointer;
	readonly transcriptPath?: string | null;
	constructor(message: string, options?: ErrorOptions & { source?: ToolCallPointer; transcriptPath?: string | null }) {
		super(`invariant_violation: ${message}`, options);
		this.name = "ProtocolInvariantError";
		this.source = options?.source;
		this.transcriptPath = options?.transcriptPath;
	}
}

export function resolveCommittedSpawnSource(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): { source: ToolCallPointer; input: Record<string, unknown> } {
	return resolveCommittedToolCall({ ...options, toolName: "agent_spawn" });
}

export function resolveCommittedToolCall(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	toolName: string;
}): { source: ToolCallPointer; input: Record<string, unknown> } {
	const { agentId, transcript, toolCallId, toolName } = options;
	const entries = coordinationEntries(transcript, agentId, `call:${toolCallId}`);
	return indexedState(transcript).memo(
		resolveCommittedToolCall,
		`${agentId}\0${toolName}\0${toolCallId}`,
		entries.length,
		() => {
			const matches: Array<{ entry: SessionEntry; input: Record<string, unknown> }> = [];

			for (const entry of entries) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				for (const part of entry.message.content) {
					if (part.type !== "toolCall" || part.id !== toolCallId) continue;
					if (part.name !== toolName) {
						throw new ProtocolInvariantError(
							`tool call ${toolCallId} is ${part.name}, not ${toolName}`,
						);
					}
					matches.push({ entry, input: part.arguments });
				}
			}

			if (matches.length !== 1) {
				throw new ProtocolInvariantError(
					`expected one committed ${toolName} source for ${toolCallId}, found ${matches.length}`,
				);
			}
			const match = matches[0];
			if (!match) throw new Error("Tool call source narrowing failed");
			return {
				source: { agentId, entryId: match.entry.id, toolCallId },
				input: match.input,
			};
		},
	);
}

export function compareCommittedToolCallOrder(
	transcript: TranscriptInspection,
	left: ToolCallPointer,
	right: ToolCallPointer,
): number {
	if (left.agentId !== right.agentId || left.agentId !== transcript.sessionId) {
		throw new ProtocolInvariantError("tool call order comparison crosses Agent identities");
	}
	const leftEntry = (indexedState(transcript).positions.get(left.entryId) ?? -1);
	const rightEntry = (indexedState(transcript).positions.get(right.entryId) ?? -1);
	if (leftEntry < 0 || rightEntry < 0) {
		throw new ProtocolInvariantError("tool call order comparison has unavailable evidence");
	}
	if (leftEntry !== rightEntry) return leftEntry - rightEntry;
	const entry = transcript.entries[leftEntry];
	if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
		throw new ProtocolInvariantError("tool call order comparison has no assistant source");
	}
	const message = entry.message;
	const callIndex = (toolCallId: string) => message.content.findIndex(
		(part) => part.type === "toolCall" && part.id === toolCallId,
	);
	const leftCall = callIndex(left.toolCallId);
	const rightCall = callIndex(right.toolCallId);
	if (leftCall < 0 || rightCall < 0) {
		throw new ProtocolInvariantError("tool call order comparison has unavailable calls");
	}
	return leftCall - rightCall;
}

export function deriveMessageIdentity(source: ToolCallPointer): string {
	return deriveProtocolIdentity("message", source);
}

export function deriveHumanRequestIdentity(source: ToolCallPointer): string {
	return deriveProtocolIdentity("human_request", source);
}

function deriveProtocolIdentity(
	kind: "message" | "human_request",
	source: ToolCallPointer,
): string {
	for (const [name, value] of Object.entries(source)) {
		if (value.length === 0 || value.includes("\0")) {
			throw new ProtocolInvariantError(`${name} is not a valid identity constituent`);
		}
	}
	return createHash("sha256")
		.update(
			[
				IDENTITY_PREFIX,
				kind,
				source.agentId,
				source.entryId,
				source.toolCallId,
			].join("\0"),
			"utf8",
		)
		.digest("base64url");
}

export function sameToolCallPointer(
	left: ToolCallPointer,
	right: ToolCallPointer,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.entryId === right.entryId &&
		left.toolCallId === right.toolCallId
	);
}

export function toolCallPointerKey(pointer: ToolCallPointer): string {
	return JSON.stringify([
		pointer.agentId,
		pointer.entryId,
		pointer.toolCallId,
	]);
}

export function currentCoordinationScope(
	transcript: TranscriptInspection,
	agentId: string,
): readonly SessionEntry[] {
	return indexedState(transcript).scope(agentId);
}
