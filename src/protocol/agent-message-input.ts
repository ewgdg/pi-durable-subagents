import {
	CONTEXT_DEPENDENCE_LEVELS,
	CONTINUATION_WORK_SCALES,
	type ContextPreparation,
} from "../policy/working-zone-preparation.ts";

export type MessageDeliveryMode = "deferred" | "steer" | "background";

export type MessageSendInput = Readonly<{
	operation: "send";
	targetAgent: string;
	content: string;
	deliveryMode?: MessageDeliveryMode;
}>;

export type RequestSendInput = Readonly<{
	operation: "request";
	targetAgent: string;
	title: string;
	question: string;
	deliveryMode?: MessageDeliveryMode;
	contextPreparation?: ContextPreparation;
}>;

export type MessagePollInput = Readonly<{
	operation: "poll";
	messageId: string;
}>;

export type MessageRetryInput = Readonly<{
	operation: "retry";
	messageId: string;
}>;

export type AnswerInput = Readonly<{
	operation: "answer";
	requestId: string;
	answer: string;
}>;

export type CancellationInput = Readonly<{
	operation: "cancel";
	requestMessageId: string;
	reason: string;
}>;

export type AgentMessageInput =
	| MessageSendInput
	| RequestSendInput
	| AnswerInput
	| CancellationInput
	| MessagePollInput
	| MessageRetryInput;

export function sameAgentMessageInput(
	left: AgentMessageInput,
	right: AgentMessageInput,
): boolean {
	switch (left.operation) {
		case "send":
			return right.operation === "send" &&
				left.targetAgent === right.targetAgent &&
				left.content === right.content &&
				(left.deliveryMode ?? "deferred") ===
					(right.deliveryMode ?? "deferred");
		case "request":
			return right.operation === "request" &&
				left.targetAgent === right.targetAgent &&
				left.title === right.title &&
				left.question === right.question &&
				(left.deliveryMode ?? "deferred") ===
					(right.deliveryMode ?? "deferred") &&
				left.contextPreparation?.workScale ===
					right.contextPreparation?.workScale &&
				left.contextPreparation?.contextDependence ===
					right.contextPreparation?.contextDependence;
		case "answer":
			return right.operation === "answer" && left.requestId === right.requestId && left.answer === right.answer;
		case "cancel":
			return right.operation === "cancel" &&
				left.requestMessageId === right.requestMessageId &&
				left.reason === right.reason;
		case "poll":
			return right.operation === "poll" && left.messageId === right.messageId;
		case "retry":
			return right.operation === "retry" && left.messageId === right.messageId;
	}
}

export function validateAgentMessageInput(
	value: Record<string, unknown>,
): AgentMessageInput {
	if (value.operation === "send") return validateMessageSendInput(value);
	if (value.operation === "request") return validateRequestSendInput(value);
	if (value.operation === "answer") {
		const keys = Object.keys(value).sort();
		if (!sameStringList(keys, ["answer", "operation", "requestId"])) {
			throw new Error("invalid_input: Agent Answer input has an invalid shape");
		}
		if (typeof value.answer !== "string" || value.answer.length === 0) {
			throw new Error("invalid_input: Agent Answer answer must not be empty");
		}
		if (typeof value.requestId !== "string" || !value.requestId.trim()) throw new Error("invalid_input: Agent Answer requestId must not be empty");
		return { operation: "answer", requestId: value.requestId, answer: value.answer };
	}
	if (value.operation === "cancel") {
		const keys = Object.keys(value).sort();
		if (!sameStringList(keys, ["operation", "reason", "requestMessageId"])) {
			throw new Error("invalid_input: Request Cancellation input has an invalid shape");
		}
		if (
			typeof value.requestMessageId !== "string" ||
			value.requestMessageId.length === 0
		) {
			throw new Error(
				"invalid_input: Request Cancellation requestMessageId must not be empty",
			);
		}
		if (typeof value.reason !== "string" || value.reason.length === 0) {
			throw new Error("invalid_input: Request Cancellation reason must not be empty");
		}
		return {
			operation: "cancel",
			requestMessageId: value.requestMessageId,
			reason: value.reason,
		};
	}
	const keys = Object.keys(value).sort();
	if (!sameStringList(keys, ["messageId", "operation"])) {
		throw new Error("invalid_input: Agent Message poll input has an invalid shape");
	}
	if (value.operation !== "poll" && value.operation !== "retry") {
		throw new Error("invalid_input: Agent Message operation is unavailable");
	}
	if (typeof value.messageId !== "string" || value.messageId.length === 0) {
		throw new Error("invalid_input: Agent Message messageId must not be empty");
	}
	return { operation: value.operation, messageId: value.messageId };
}

function validateRequestSendInput(value: Record<string, unknown>): RequestSendInput {
	if (!("title" in value)) {
		throw new Error('invalid_input: Agent Request required field "title" is missing');
	}
	const keys = Object.keys(value).sort();
	const expectedKeys = [
		...(value.contextPreparation === undefined ? [] : ["contextPreparation"]),
		...(value.deliveryMode === undefined ? [] : ["deliveryMode"]),
		"operation",
		"question",
		"targetAgent",
		"title",
	].sort();
	if (!sameStringList(keys, expectedKeys)) {
		throw new Error("invalid_input: Agent Request input has an invalid shape");
	}
	if (typeof value.targetAgent !== "string" || value.targetAgent.length === 0) {
		throw new Error("invalid_input: Agent Request targetAgent must not be empty");
	}
	if (typeof value.question !== "string" || value.question.length === 0) {
		throw new Error("invalid_input: Agent Request question must not be empty");
	}
	if (typeof value.title !== "string" || !value.title.trim()) {
		throw new Error("invalid_input: Agent Request title must not be blank");
	}
	if (
		value.deliveryMode !== undefined &&
		value.deliveryMode !== "deferred" &&
		value.deliveryMode !== "steer" &&
		value.deliveryMode !== "background"
	) {
		throw new Error("invalid_input: Agent Request deliveryMode is unavailable");
	}
	const contextPreparation = value.contextPreparation === undefined
		? undefined
		: validateContextPreparation(value.contextPreparation);
	return {
		operation: "request",
		targetAgent: value.targetAgent,
		title: value.title,
		question: value.question,
		...(value.deliveryMode === undefined
			? {}
			: { deliveryMode: value.deliveryMode }),
		...(contextPreparation === undefined ? {} : { contextPreparation }),
	};
}

function validateContextPreparation(value: unknown): ContextPreparation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("invalid_input: Agent Request contextPreparation has an invalid shape");
	}
	const preparation = value as Record<string, unknown>;
	if (!sameStringList(Object.keys(preparation).sort(), ["contextDependence", "workScale"])) {
		throw new Error("invalid_input: Agent Request contextPreparation has an invalid shape");
	}
	if (!CONTINUATION_WORK_SCALES.includes(preparation.workScale as never)) {
		throw new Error("invalid_input: Agent Request contextPreparation workScale is unavailable");
	}
	if (!CONTEXT_DEPENDENCE_LEVELS.includes(preparation.contextDependence as never)) {
		throw new Error(
			"invalid_input: Agent Request contextPreparation contextDependence is unavailable",
		);
	}
	return {
		workScale: preparation.workScale as ContextPreparation["workScale"],
		contextDependence: preparation.contextDependence as ContextPreparation["contextDependence"],
	};
}

function validateMessageSendInput(
	value: Record<string, unknown>,
): MessageSendInput {
	const keys = Object.keys(value).sort();
	const expectedKeys = value.deliveryMode === undefined
		? ["content", "operation", "targetAgent"]
		: ["content", "deliveryMode", "operation", "targetAgent"];
	if (!sameStringList(keys, expectedKeys)) {
		throw new Error("invalid_input: Agent Message send input has an invalid shape");
	}
	if (typeof value.targetAgent !== "string" || value.targetAgent.length === 0) {
		throw new Error("invalid_input: Agent Message targetAgent must not be empty");
	}
	if (typeof value.content !== "string" || value.content.length === 0) {
		throw new Error("invalid_input: Agent Message content must not be empty");
	}
	if (
		value.deliveryMode !== undefined &&
		value.deliveryMode !== "deferred" &&
		value.deliveryMode !== "steer" &&
		value.deliveryMode !== "background"
	) {
		throw new Error("invalid_input: Agent Message deliveryMode is unavailable");
	}
	return {
		operation: "send",
		targetAgent: value.targetAgent,
		content: value.content,
		...(value.deliveryMode === undefined
			? {}
			: { deliveryMode: value.deliveryMode }),
	};
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
