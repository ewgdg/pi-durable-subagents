import { readCoordinationRecord } from "./replay-rejection.ts";
import { resolveIncomingRequestReference } from "./obligation-focus.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { coordinationEntries, indexedState } from "../transcript/retained-transcript.ts";
import { validateAgentSpawnInput } from "./agent-spawn-input.ts";
import { validateAgentMessageInput, type AgentMessageInput } from "./agent-message-input.ts";
import { compareCommittedToolCallOrder, deriveMessageIdentity, type ToolCallPointer } from "./identities.ts";

/** A selector is bound to its author's history at the referring call, not today's roster. */
export function resolveMessageReference(
	transcript: TranscriptInspection,
	source: ToolCallPointer,
	selector: string,
): string {
	const reference = selector.trim();
	if (!reference) throw new Error("invalid_input: Message reference must not be blank");
	// A complete SHA-256 base64url ID is already an immutable reference. Preserve
	// the existing evidence and wrong-participant checks for literal full IDs.
	if (/^[A-Za-z0-9_-]{43}$/.test(reference)) return reference;
	const candidates: string[] = [];
	for (const toolName of ["agent_message", "agent_spawn"]) {
		const sources = indexedState(transcript).project(
			resolveMessageReference,
			`${source.agentId}:${toolName}`,
			coordinationEntries(transcript, source.agentId, `tool:${toolName}`),
			() => [] as Array<{ id: string; source: ToolCallPointer }>,
			(sources, entry) => {
				if (entry.type !== "message" || entry.message.role !== "assistant") return sources;
				for (const part of entry.message.content) {
					if (part.type !== "toolCall" || part.name !== toolName) continue;
					if (toolName === "agent_spawn") {
						if (!readCoordinationRecord(transcript, source.agentId, entry, () => validateAgentSpawnInput(part.arguments), part.id).accepted) continue;
					}
					if (toolName === "agent_message") {
						const parsed = readCoordinationRecord(transcript, source.agentId, entry, () => validateAgentMessageInput(part.arguments), part.id);
						if (!parsed.accepted) continue;
						const input = parsed.value;
						if (input.operation === "poll" || input.operation === "retry") continue;
					}
					const pointer = { agentId: source.agentId, entryId: entry.id, toolCallId: part.id };
					sources.push({ id: deriveMessageIdentity(pointer), source: pointer });
				}
				return sources;
			},
		);
		for (const candidate of sources) {
			if (compareCommittedToolCallOrder(transcript, candidate.source, source) < 0) candidates.push(candidate.id);
		}
	}
	if (candidates.includes(reference)) return reference;
	const matches = [...new Set(candidates.filter(id => id.endsWith(reference)))];
	if (matches.length > 1) throw new Error(`ambiguous_target: Message ID suffix ${reference} matches ${matches.length} Messages`);
	if (matches.length === 0) throw new Error(`unknown_identity: Message ${reference}`);
	return matches[0]!;
}

export function resolveAgentMessageReferences(
	transcript: TranscriptInspection,
	source: ToolCallPointer,
	input: AgentMessageInput,
): AgentMessageInput {
	if (input.operation === "poll" || input.operation === "retry") {
		return { ...input, messageId: resolveMessageReference(transcript, source, input.messageId) };
	}
	if (input.operation === "answer") {
		return { ...input, requestId: resolveIncomingRequestReference(transcript, source, input.requestId) };
	}
	if (input.operation === "cancel") {
		return { ...input, requestMessageId: resolveMessageReference(transcript, source, input.requestMessageId) };
	}
	return input;
}
