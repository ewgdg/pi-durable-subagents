import { readCoordinationRecord } from "./replay-rejection.ts";
import { CoordinationRecordValidationError } from "./record-validation.ts";
import { coordinationEntries, indexedState } from "../transcript/retained-transcript.ts";
import type { EntryPointer } from "./message-delivery.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import {
	deriveMessageIdentity,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "./identities.ts";
import type { Message } from "./message.ts";

export type RunControlInput =
	| Readonly<{
		operation: "interrupt";
		agentId: string;
	}>
	| Readonly<{
		operation: "resume";
		agentId: string;
		content: string;
	}>
	| Readonly<{
		operation: "terminate";
		agentId: string;
	}>;

export type RunInterruptionReceipt = Readonly<{
	agentId: string;
	disposition: "held" | "already_held" | "not_running";
}>;

export type RunResumeReceipt = Readonly<{
	agentId: string;
	messageId: string;
}> & (
	| Readonly<{ messageStatus: "sent" }>
	| Readonly<{
		delivery: "rejected";
		rejectionReason: "not_held" | "resume_slot_occupied" | "target_unavailable";
	}>
);

export type RunTerminationReceipt = Readonly<{
	agentId: string;
	disposition: "terminated" | "not_running";
	residualRequests: Readonly<{
		incoming: number;
		outgoing: number;
	}>;
}>;

export type RunControlReceipt =
	| RunInterruptionReceipt
	| RunResumeReceipt
	| RunTerminationReceipt;

export function validateRunControlInput(value: unknown): RunControlInput {
	if (!isRecord(value)) throw new CoordinationRecordValidationError("invalid_input: Run control input must be an object");
	if (typeof value.agentId !== "string" || value.agentId.trim().length === 0) {
		throw new CoordinationRecordValidationError("invalid_input: Run control Agent identity must not be blank");
	}
	if (value.operation === "interrupt" && Object.keys(value).length === 2) {
		return { operation: "interrupt", agentId: value.agentId };
	}
	if (value.operation === "terminate" && Object.keys(value).length === 2) {
		return { operation: "terminate", agentId: value.agentId };
	}
	if (
		value.operation === "resume" &&
		Object.keys(value).length === 3 &&
		typeof value.content === "string" &&
		value.content.trim().length > 0
	) {
		return { operation: "resume", agentId: value.agentId, content: value.content };
	}
	throw new CoordinationRecordValidationError("invalid_input: invalid Run control input");
}

export function resolveCommittedRunControl(options: {
	callerAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: RunControlInput;
}): Readonly<{ source: ToolCallPointer; input: RunControlInput }> {
	const { source, input } = resolveCommittedToolCall({
		agentId: options.callerAgentId,
		transcript: options.transcript,
		toolCallId: options.toolCallId,
		toolName: "agent_control",
	});
	const committedInput = validateRunControlInput(input);
	if (!sameRunControlInput(committedInput, options.providedInput)) {
		throw new Error("invariant_violation: executed Run control input differs from its source");
	}
	return { source, input: committedInput };
}

export function createSupervisoryResumeMessage(options: {
	workflowId: string;
	fromAgentId: string;
	input: Extract<RunControlInput, { operation: "resume" }>;
	source: ToolCallPointer;
}): Extract<Message, { kind: "message" }> {
	return {
		kind: "message",
		origin: "agent_control",
		messageId: deriveMessageIdentity(options.source),
		workflowId: options.workflowId,
		fromAgentId: options.fromAgentId,
		targetAgentId: options.input.agentId,
		deliveryMode: "steer",
		source: options.source,
		content: options.input.content,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameRunControlInput(left: RunControlInput, right: RunControlInput): boolean {
	if (left.operation !== right.operation || left.agentId !== right.agentId) return false;
	return left.operation !== "resume" ||
		(right.operation === "resume" && left.content === right.content);
}

/** Resume authors a Message; interrupt and terminate do not. */
export function findAuthoredSupervisoryResumeMessages(options: {
	workflowId: string;
	authorAgentId: string;
	transcript: TranscriptInspection;
}): readonly Extract<Message, { kind: "message" }>[] {
	const { workflowId, authorAgentId, transcript } = options;
	return indexedState(transcript).project(
		findAuthoredSupervisoryResumeMessages,
		authorAgentId,
		coordinationEntries(transcript, authorAgentId, "tool:agent_control"),
		() => [] as Extract<Message, { kind: "message" }>[],
		(messages, entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") return messages;
			for (const part of entry.message.content) {
				if (part.type !== "toolCall" || part.name !== "agent_control") continue;
				const parsed = readCoordinationRecord(transcript, authorAgentId, entry, () => validateRunControlInput(part.arguments), part.id);
				if (!parsed.accepted) continue;
				const input = parsed.value;
				if (input.operation !== "resume") continue;
				messages.push(createSupervisoryResumeMessage({
					workflowId, fromAgentId: authorAgentId, input,
					source: { agentId: authorAgentId, entryId: entry.id, toolCallId: part.id },
				}));
			}
			return messages;
		},
	);
}

export function inspectSupervisoryResumeAuthorResult(options: {
	message: Extract<Message, { kind: "message" }>;
	transcript: TranscriptInspection;
	deliveryEvidence?: EntryPointer;
}): "canonical" | "not_created" | "indeterminate" {
	const { message, transcript, deliveryEvidence } = options;
	const results = coordinationEntries(transcript, message.fromAgentId, `result:${message.source.toolCallId}`)
		.filter(entry => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolName === "agent_control" && entry.message.toolCallId === message.source.toolCallId)
		.filter(entry => {
			if(entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) return true;
			const details = entry.message.details;
			return readCoordinationRecord(transcript, message.fromAgentId, entry, () => validateSupervisoryResumeResultShape(details), message.source.toolCallId).accepted;
		});
	if (results.length > 1) throw new Error(`invariant_violation: Message ${message.messageId} has multiple author results`);
	const result = results[0];
	if (!result || result.type !== "message" || result.message.role !== "toolResult") {
		return deliveryEvidence ? "canonical" : "indeterminate";
	}
	const details = result.message.details;
	let created = false;
	if (!result.message.isError) {
		if (!isRecord(details) || details.agentId !== message.targetAgentId || details.messageId !== message.messageId) {
			throw new Error(`invariant_violation: resume Message ${message.messageId} author result has invalid identity`);
		}
		const keys = Object.keys(details).sort().join(",");
		if (keys === "agentId,messageId,messageStatus" && details.messageStatus === "sent") {
			created = true;
		} else if (!(keys === "agentId,delivery,messageId,rejectionReason" && details.delivery === "rejected" &&
			["not_held", "resume_slot_occupied", "target_unavailable"].includes(String(details.rejectionReason)))) {
			throw new Error(`invariant_violation: resume Message ${message.messageId} author result has invalid shape`);
		}
	}
	if (!created && deliveryEvidence) {
		throw new Error(`invariant_violation: resume Message ${message.messageId} has a non-authoring result and Delivery`);
	}
	return created ? "canonical" : "not_created";
}

export function validateSupervisoryResumeResultShape(value: unknown): void {
	if (!isRecord(value) || typeof value.agentId !== "string" || !value.agentId || typeof value.messageId !== "string" || !value.messageId)
		throw new CoordinationRecordValidationError("Resume result has an invalid shape");
	const keys = Object.keys(value).sort().join(",");
	if (keys === "agentId,messageId,messageStatus" && value.messageStatus === "sent") return;
	if (keys === "agentId,delivery,messageId,rejectionReason" && value.delivery === "rejected" &&
		["not_held", "resume_slot_occupied", "target_unavailable"].includes(String(value.rejectionReason))) return;
	throw new CoordinationRecordValidationError("Resume result has an invalid shape");
}
