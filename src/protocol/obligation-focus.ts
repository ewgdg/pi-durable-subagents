import { readCoordinationRecord } from "./replay-rejection.ts";
import { CoordinationRecordValidationError } from "./record-validation.ts";
import { authoredAgentMessagesByCall } from "./request-resolution.ts";
import { inspectAgentMessageAuthorResult } from "./message.ts";
import { OBLIGATION_FOCUS_CUSTOM_TYPE } from "./custom-entry-types.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { indexedState } from "../transcript/retained-transcript.ts";
import { deliveriesAtEntry, deliveriesForRequest, inspectMessageDeliveries, validateDeliveredMessageEvidence } from "./message-delivery.ts";
import { ProtocolInvariantError, type ToolCallPointer } from "./identities.ts";

export type ObligationFrame = Readonly<{
	requestId: string;
	requesterAgentId: string;
	title: string;
	question: string;
}>;

/** Accepted Delivery and resolution evidence retain local obligations across compaction. */
export function obligationStack(
	transcript: TranscriptInspection,
	agentId: string,
	before?: ToolCallPointer,
): readonly ObligationFrame[] {
	const state = indexedState(transcript).project(
		obligationStack, agentId, indexedState(transcript).scope(agentId),
		() => ({ frames: [] as ObligationFrame[], before: new Map<string, readonly ObligationFrame[]>() }),
		(state, entry) => {
			if (entry.type === "custom" && entry.customType === OBLIGATION_FOCUS_CUSTOM_TYPE) {
				// Historical attention snapshots are diagnostic context, never authority
				// to invent, rewrite, discharge, or resurrect a delivered obligation.
				readCoordinationRecord(transcript, agentId, entry, () => {
					const value = entry.data as { frames?: ObligationFrame[] } | undefined;
					if (!Array.isArray(value?.frames) || value.frames.some(frame =>
						typeof frame !== "object" || frame === null || typeof frame.requestId !== "string" ||
						typeof frame.requesterAgentId !== "string" || typeof frame.title !== "string" ||
						!frame.title.trim() || typeof frame.question !== "string"
					)) throw new CoordinationRecordValidationError("invariant_violation: invalid recovered obligation focus");
				});
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				state.before.set(entry.id, [...state.frames]);
			}
			for (const delivery of entry.type === "custom_message" ? deliveriesAtEntry(transcript, agentId, entry.id) : []) {
				validateDeliveredMessageEvidence(delivery);
				const { projection } = delivery;
				if (projection.kind === "request") {
					state.frames.push({ requestId: projection.requestMessageId,
						requesterAgentId: projection.fromAgentId, title: projection.title, question: projection.question });
				} else if (projection.kind === "request_cancellation") {
					// Only original Delivery establishes who can withdraw this Request,
					// even after its frame has already been resolved locally.
					const request = deliveriesForRequest({ recipientAgentId: agentId, transcript,
						requestId: projection.requestMessageId }).find(candidate => candidate.projection.kind === "request");
					if (request && request.projection.fromAgentId !== projection.fromAgentId)
						throw new ProtocolInvariantError("Request Cancellation Delivery names another requester");
					state.frames = state.frames.filter(frame => frame.requestId !== projection.requestMessageId);
				}
			}
			if (entry.type === "message" && entry.message.role === "toolResult" &&
				entry.message.toolName === "agent_message" && !entry.message.isError) {
				for (const candidate of authoredAgentMessagesByCall({ authorAgentId: agentId, transcript, toolCallId: entry.message.toolCallId })) {
					if (candidate.source.toolCallId !== entry.message.toolCallId || candidate.input.operation !== "answer") continue;
					const input = candidate.input;
					const frame = state.frames.find(frame => frame.requestId === input.requestId);
					if (!frame) continue;
					if (inspectAgentMessageAuthorResult({ authorAgentId: agentId, transcript,
						source: candidate.source, input: candidate.input, requestId: frame.requestId,
						requestTitle: frame.title }) === "canonical") {
						state.frames = state.frames.filter(frame => frame.requestId !== input.requestId);
					}
				}
			}
			return state;
		},
	);
	if (!before) return state.frames;
	const snapshot = state.before.get(before.entryId);
	if (!snapshot) throw new Error("invariant_violation: obligation source is outside retained history");
	return snapshot;
}

export function resolveIncomingRequestReference(
	transcript: TranscriptInspection, source: ToolCallPointer, selector: string,
): string {
	const reference = selector.trim();
	if (!reference) throw new Error("invalid_input: Request reference must not be blank");
	if (/^[A-Za-z0-9_-]{43}$/.test(reference)) return reference;
	const state = indexedState(transcript);
	const boundary = state.positions.get(source.entryId)!;
	const ids = inspectMessageDeliveries({ recipientAgentId: source.agentId, transcript })
		.filter(delivery => state.positions.get(delivery.deliveryEvidence.entryId)! < boundary)
		.flatMap(({ projection }) => projection.kind === "request" ? [projection.requestMessageId] : []);
	if (ids.includes(reference)) return reference;
	const matches = [...new Set(ids.filter(id => id.endsWith(reference)))];
	if (matches.length > 1) throw new Error(`ambiguous_target: Request ID suffix ${reference}`);
	if (matches.length === 0) throw new Error(`unknown_identity: delivered Request ${reference}`);
	return matches[0]!;
}
