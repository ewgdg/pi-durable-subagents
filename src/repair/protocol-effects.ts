import { isDeepStrictEqual } from "node:util";
import type { AgentEvidence } from "../coordination/agent-record.ts";
import { WorkflowRecoveryEvidence } from "../coordination/workflow-recovery-evidence.ts";
import { deriveMessageIdentity } from "../protocol/identities.ts";
import { createMessageDeliveryItem, inspectAnswerDelivery, inspectAnswerRetrievals, inspectCanonicalMessage, inspectMessageDelivery, type Message } from "../protocol/message.ts";
import { inspectMessageDeliveries, validateDeliveredMessageEvidence, type ModelVisibleMessage } from "../protocol/message-delivery.ts";
import { inspectCoordinationRejections, isCoordinationEvidenceTool, type CoordinationRejection } from "../protocol/replay-rejection.ts";
import { findAuthoredAgentMessageSources } from "../protocol/request-resolution.ts";
import { indexedState } from "../transcript/retained-transcript.ts";

export type ProtocolEffectCategory = "record" | "accepted_source_order" | "authored_message" | "answer_commitment" | "delivery" | "answer_duty" | "awaiting_answer" | "pending_delivery" | "pending_delivery_order" | "continuation";
export type ProtocolEffect = Readonly<{ category: ProtocolEffectCategory; key: string; value: Readonly<Record<string, unknown>> }>;
export type ProtocolEffectChange = Readonly<{
	category: ProtocolEffectCategory; key: string;
	before?: Readonly<Record<string, unknown>>; after?: Readonly<Record<string, unknown>>;
}>;
export type EvidenceError = Readonly<{ path?: string; code: string; message: string }>;
export type ProtocolEffectSnapshot = Readonly<{
	facts: readonly ProtocolEffect[];
	rejections: readonly CoordinationRejection[];
	errors: readonly EvidenceError[];
}>;

/** Reads the very same recovery selection as workflow_resume; no runtime, admission or scheduler exists here. */
export function inspectProtocolEffects(agents: ReadonlyMap<string, AgentEvidence>): ProtocolEffectSnapshot {
	const recovery = new WorkflowRecoveryEvidence(agents);
	const facts = new Map<string, ProtocolEffect>();
	const errors: EvidenceError[] = [];
	const rejections: CoordinationRejection[] = [];
	const put = (category: ProtocolEffectCategory, key: string, value: Readonly<Record<string, unknown>>) => {
		const fullKey = `${category}:${key}`;
		if (facts.has(fullKey)) throw new Error(`duplicate_protocol_evidence: ${fullKey}`);
		facts.set(fullKey, { category, key, value });
	};
	for (const agent of [...agents.values()].sort((a, b) => a.identity.agentId.localeCompare(b.identity.agentId))) {
		const agentId = agent.identity.agentId;
		const transcript = agent.transcript.inspect();
		const inspect = (work: () => void) => {
			try { work(); } catch (error) {
				errors.push({ path: transcript.transcriptPath ?? undefined, code: "protocol_unverifiable", message: describeError(error) });
			}
		};
		inspect(() => {
			const rejected = inspectCoordinationRejections(transcript, agentId);
			rejections.push(...rejected);
			const rejectedBySource = new Map(rejected.map(item => [`${item.source.entryId}:${item.source.toolCallId ?? ""}`, item]));
			const acceptedSourceKeys: string[] = [];
			const record = (entryId: string, value: unknown, toolCallId?: string) => {
				const source = { agentId, entryId, ...(toolCallId === undefined ? {} : { toolCallId }) };
				const rejection = rejectedBySource.get(`${entryId}:${toolCallId ?? ""}`);
				const sourceKey = `${agentId}:${entryId}:${toolCallId ?? ""}`;
				if (!rejection) acceptedSourceKeys.push(sourceKey);
				put("record", sourceKey, {
					source, path: transcript.transcriptPath, status: rejection ? "rejected" : "accepted", value,
					...(rejection ? { diagnostic: rejection.diagnostic } : {}),
				});
			};
			for (const entry of indexedState(transcript).scope(agentId)) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					for (const part of entry.message.content) {
						if (part.type === "toolCall" && isCoordinationEvidenceTool(part.name)) record(entry.id, part, part.id);
					}
				} else if (entry.type === "message" && entry.message.role === "toolResult" && isCoordinationEvidenceTool(entry.message.toolName)) {
					record(entry.id, entry.message, entry.message.toolCallId);
				} else if ((entry.type === "custom" || entry.type === "custom_message") && entry.customType.startsWith("agent-coordination.")) {
					record(entry.id, entry);
				}
			}
			// Physical entry order and same-entry call order are authority; unrelated content positions are not.
			put("accepted_source_order", agentId, { agentId, path: transcript.transcriptPath, sourceKeys: acceptedSourceKeys });
		});
		inspect(() => {
			const relationships = recovery.requests.residualRelationshipsFor(agent);
			for (const requestId of relationships.answerOwedRequestIds) put("answer_duty", `${agentId}:${requestId}`, { agentId, requestId });
			for (const requestId of relationships.awaitingAnswerRequestIds) put("awaiting_answer", `${agentId}:${requestId}`, { agentId, requestId });
			for (const requestId of recovery.requestIds(agent)) put("continuation", `${agentId}:${requestId}`, { agentId, requestId });
		});
		inspect(() => {
			const pendingMessageIds: string[] = [];
			for (const candidate of recovery.messageCandidates(agent)) {
				const message = recovery.message(candidate.authorAgentId, candidate.messageId);
				if (!message) continue;
				const outcome = recovery.inspectMessage(message);
				if (outcome?.disposition === "indeterminate" || outcome?.disposition === "blocked") {
					throw new Error(`${message.messageId}: ${outcome.reason ?? outcome.disposition}`);
				}
				if (outcome?.reason === "not_created") continue;
				put("authored_message", message.messageId, { ...message });
				if (!outcome) {
					put("pending_delivery", message.messageId, { ...message });
					pendingMessageIds.push(message.messageId);
				}
			}
			// Keep the shared recovery selector's per-author order, not the audit map's presentation sort.
			put("pending_delivery_order", agentId, { agentId, messageIds: pendingMessageIds });
		});
		inspect(() => {
			// Recovery deliberately omits orphan Answers. Local commitment still matters and is audited separately.
			for (const source of findAuthoredAgentMessageSources({ authorAgentId: agentId, transcript })) {
				if (source.input.operation !== "answer") continue;
				const answer = recovery.requests.findAnswerBySource(agent, source.source.toolCallId);
				if (answer) put("answer_commitment", answer.messageId, { ...answer });
			}
		});
		inspect(() => {
			for (const delivery of inspectMessageDeliveries({ recipientAgentId: agentId, transcript })) {
				validateDeliveredMessageEvidence(delivery);
				const author = agents.get(delivery.source.agentId);
				if (!author) throw new Error(`missing_referenced_agent: ${delivery.source.agentId}`);
				const messageId = deriveMessageIdentity(delivery.source);
				const message = recovery.message(author.identity.agentId, messageId);
				if (message) validateDelivery(message, agent, author, delivery.projection);
				put("delivery", `${agentId}:${messageId}`, { agentId, messageId, method: "custom", ...delivery });
			}
			for (const retrieval of inspectAnswerRetrievals({ requesterAgentId: agentId, transcript })) {
				const author = agents.get(retrieval.fromAgentId);
				if (!author) throw new Error(`missing_referenced_agent: ${retrieval.fromAgentId}`);
				const answer = recovery.requests.findAnswerBySource(author, retrieval.answerSource.toolCallId);
				if (!answer) throw new Error(`unverifiable_answer_retrieval: ${retrieval.answerId}`);
				if (answer.answer !== retrieval.answer) throw new Error(`contradictory_answer_retrieval: ${retrieval.answerId}`);
				validateDelivery(answer, agent, author);
				put("delivery", `${agentId}:${retrieval.answerId}`, { agentId, messageId: retrieval.answerId, method: "retrieval", ...retrieval });
			}
		});
	}
	return { facts: [...facts.values()].sort((a, b) => `${a.category}:${a.key}`.localeCompare(`${b.category}:${b.key}`)), rejections, errors };
}

function validateDelivery(message: Message, recipient: AgentEvidence, author: AgentEvidence, projection?: ModelVisibleMessage): void {
	if (message.targetAgentId !== recipient.identity.agentId) throw new Error(`wrong_delivery_recipient: ${message.messageId}`);
	// Ordinary replay compares routing/correlation identity; repair also certifies the complete delivered body.
	if (projection && !isDeepStrictEqual(createMessageDeliveryItem(message).projection, projection)) {
		throw new Error(`contradictory_delivery_body: ${message.messageId}`);
	}
	const transcript = recipient.transcript.inspect();
	const evidence = message.kind === "answer"
		? inspectAnswerDelivery({ requesterAgentId: recipient.identity.agentId, transcript, answer: message })
		: inspectMessageDelivery({ recipientAgentId: recipient.identity.agentId, transcript, message });
	if (!evidence.deliveryEvidence || inspectCanonicalMessage({ message, authorTranscript: author.transcript.inspect(),
		deliveryEvidence: evidence.deliveryEvidence }).state !== "canonical") throw new Error(`unverifiable_delivery: ${message.messageId}`);
}

export function diffProtocolEffects(before: readonly ProtocolEffect[], after: readonly ProtocolEffect[]): ProtocolEffectChange[] {
	const old = new Map(before.map(fact => [`${fact.category}:${fact.key}`, fact]));
	const next = new Map(after.map(fact => [`${fact.category}:${fact.key}`, fact]));
	return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap(key => {
		const a = old.get(key), b = next.get(key);
		if (isDeepStrictEqual(a?.value, b?.value)) return [];
		return [{ category: (b ?? a)!.category, key: (b ?? a)!.key,
			...(a ? { before: a.value } : {}), ...(b ? { after: b.value } : {}) }];
	});
}

export function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
