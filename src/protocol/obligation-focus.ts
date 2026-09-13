import { OBLIGATION_FOCUS_CUSTOM_TYPE } from "./custom-entry-types.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { indexedState } from "../transcript/retained-transcript.ts";
import { deliveriesAtEntry, inspectMessageDeliveries, validateDeliveredMessageEvidence } from "./message-delivery.ts";
import type { ToolCallPointer } from "./identities.ts";

export type ObligationFrame = Readonly<{
	requestId: string;
	requesterAgentId: string;
	title: string;
	question: string;
}>;

/** Physical attention history survives compaction; snapshots preserve scheduling ancestry. */
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
				const value = entry.data as { frames?: ObligationFrame[] } | undefined;
				if (!Array.isArray(value?.frames) || value.frames.some(frame =>
					typeof frame.requestId !== "string" || typeof frame.requesterAgentId !== "string" || typeof frame.title !== "string" || !frame.title.trim() || typeof frame.question !== "string"
				)) throw new Error("invariant_violation: invalid recovered obligation focus");
				state.frames = [...value.frames];
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
					state.frames = state.frames.filter(frame => frame.requestId !== projection.requestMessageId);
				}
			}
			if (entry.type === "message" && entry.message.role === "toolResult" &&
				entry.message.toolName === "agent_message" && !entry.message.isError) {
				const result = entry.message.details as Record<string, unknown> | undefined;
				// Only Answer receipts name both the authored Message and its Request.
				if (result && typeof result.messageId === "string" && typeof result.requestMessageId === "string" &&
					(typeof result.messageStatus === "string" || result.disposition === "already_answered")) {
					state.frames = state.frames.filter(frame => frame.requestId !== result.requestMessageId);
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
