import type { AgentMessageInput } from "./agent-message-input.ts";
import { CoordinationRecordValidationError } from "./record-validation.ts";
import { validateAgentWaitResult } from "./agent-wait.ts";

const AUTHOR_REJECTIONS = ["target_unavailable", "host_shutting_down", "capacity_exhausted"];
const RETRY_REJECTIONS = [...AUTHOR_REJECTIONS, "evidence_unavailable", "policy_rejected"];

/** Validate one native receipt without resolving cross-record identities. */
export function validateAgentMessageResultShape(
	value: unknown,
	operation?: AgentMessageInput["operation"],
): Record<string, unknown> {
	if (!isRecord(value)) return invalid();
	const authoring = operation !== undefined && operation !== "poll" && operation !== "retry";
	if (authoring && typeof value.messageStatus !== "string") {
		const allowed = operation === "send" ? ["rejected"]
			: operation === "answer" ? ["committed", "already_answered"]
				: operation === "cancel" ? ["already_answered", "already_cancelled"] : [];
		if (!allowed.includes(String(value.disposition))) return invalid();
	}
	const keys = Object.keys(value).sort();
	const strings = (names: string[]) => names.every(name =>
		typeof value[name] === "string" && (value[name] as string).trim().length > 0);
	const exact = (names: string[]) => keys.join("\0") === [...names].sort().join("\0");
	if (typeof value.messageStatus === "string") {
		const identity = "messageId" in value ? "messageId" : "requestMessageId";
		const correlation = "requestTitle" in value ? ["requestMessageId", "requestTitle"] : ["targetAgentId"];
		if (authoring && (identity !== (operation === "request" ? "requestMessageId" : "messageId") ||
			(operation === "answer") !== ("requestTitle" in value))) return invalid();
		const expected = [identity, ...correlation, "messageStatus"];
		if (value.messageStatus !== "sent") expected.push("reason");
		const unknownReasons = authoring ? ["confirmation_lost"] : ["confirmation_lost", "inspection_incomplete"];
		const rejectedReasons = authoring ? AUTHOR_REJECTIONS : RETRY_REJECTIONS;
		const validStatus = value.messageStatus === "sent" ||
			value.messageStatus === "unknown" && unknownReasons.includes(String(value.reason)) ||
			value.messageStatus === "not_sent" && rejectedReasons.includes(String(value.reason));
		if (!exact(expected) || !strings([identity, ...correlation]) || !validStatus) return invalid();
		return value;
	}
	if (value.disposition === "committed") {
		if (!exact(["messageId", "requestMessageId", "requestTitle", "disposition", "delivery", "reason"]) ||
			!strings(["messageId", "requestMessageId", "requestTitle"]) ||
			value.delivery !== "omitted" || value.reason !== "request_source_unavailable") return invalid();
		return value;
	}
	if (value.disposition === "answer_delivered" || value.disposition === "answer_already_delivered") {
		validateAgentWaitResult({ answers: [value] });
		return value;
	}
	if (value.disposition === "already_answered") {
		if (exact(["disposition", "answerMessageId"]) && strings(["answerMessageId"])) return value;
		if (exact(["disposition", "messageId", "requestMessageId", "requestTitle", "answerId"]) &&
			strings(["messageId", "requestMessageId", "requestTitle", "answerId"])) return value;
	}
	if (value.disposition === "already_cancelled" && exact(["disposition", "cancellationMessageId"]) && strings(["cancellationMessageId"])) return value;
	if (value.disposition === "rejected" && exact(["disposition", "reason", "requestMessageId"]) && value.reason === "answer_required" && strings(["requestMessageId"])) return value;
	if (value.disposition === "indeterminate" && exact(["disposition", "messageId", "reason"]) && value.reason === "inspection_incomplete" && strings(["messageId"])) return value;
	if (value.disposition === "delivered" || value.disposition === "request_delivered" || value.disposition === "not_observed") {
		const identity = value.disposition === "request_delivered" ? "requestMessageId" : "messageId";
		const evidence = value.disposition === "not_observed" ? "inspectedThrough" : "deliveryEvidence";
		if (exact(["disposition", identity, evidence]) && strings([identity]) && isPointer(value[evidence])) return value;
	}
	return invalid();
}

function invalid(): never {
	throw new CoordinationRecordValidationError("Agent Message result has an invalid shape");
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPointer(value: unknown): boolean {
	return isRecord(value) && Object.keys(value).sort().join(",") === "agentId,entryId" &&
		typeof value.agentId === "string" && value.agentId.length > 0 &&
		typeof value.entryId === "string" && value.entryId.length > 0;
}
