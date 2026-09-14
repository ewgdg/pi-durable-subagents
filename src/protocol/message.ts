import { findCallerRequestSource } from "./agent-wait.ts";
import { validateAgentMessageResultShape } from "./message-result-shape.ts";
import { CoordinationRecordValidationError } from "./record-validation.ts";
import { readCoordinationRecord } from "./replay-rejection.ts";
import { inspectSupervisoryResumeAuthorResult } from "./run-control.ts";
import { resolveAgentMessageReferences } from "./message-reference.ts";
import { coordinationEntries, indexedState } from "../transcript/retained-transcript.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import type { ContextPreparation } from "../policy/working-zone-preparation.ts";

import { callerRequestTitle, inspectCommittedAgentWaitResult, type AgentWaitAnswer } from "./agent-wait.ts";
import {
	deriveMessageIdentity,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	sameToolCallPointer,
	toolCallPointerKey,
	type ToolCallPointer,
} from "./identities.ts";
import {
	inspectStandaloneMessageDelivery,
	deliveriesBySource,
	type DeliveryInspection,
	type DeliveryIdentity,
	type EntryPointer,
	type MessageDeliveryItem,
	type ModelVisibleMessage,
} from "./message-delivery.ts";
import {
	sameAgentMessageInput,
	validateAgentMessageInput,
	type AgentMessageInput,
	type AnswerInput,
	type CancellationInput,
	type MessageDeliveryMode,
	type MessageSendInput,
	type RequestSendInput,
} from "./agent-message-input.ts";

export type { DeliveryInspection, EntryPointer } from "./message-delivery.ts";
export { sameAgentMessageInput, validateAgentMessageInput } from "./agent-message-input.ts";
export type {
	AgentMessageInput,
	AnswerInput,
	CancellationInput,
	MessageDeliveryMode,
	MessagePollInput,
	MessageRetryInput,
	MessageSendInput,
	RequestSendInput,
} from "./agent-message-input.ts";

export type CanonicalMessageInspection =
	| Readonly<{ state: "canonical"; message: Message }>
	| Readonly<{ state: "indeterminate"; message: Message }>
	| Readonly<{ state: "not_created"; message: Message }>;

export type MessageAuthorResultState = CanonicalMessageInspection["state"];

export type AnswerRetrievalEvidence = Readonly<{
	answerId: string;
	requestId: string;
	requestTitle: string;
	fromAgentId: string;
	answer: string;
	answerSource: ToolCallPointer;
	deliveryEvidence: EntryPointer;
}>;

type MessageResultIdentity =
	| Readonly<{ kind: "message"; messageId: string; targetAgentId: string }>
	| Readonly<{ kind: "request"; messageId: string; targetAgentId: string }>
	| Readonly<{ kind: "answer"; messageId: string; requestId: string; requestTitle: string }>
	| Readonly<{
		kind: "request_cancellation";
		messageId: string;
		requestId: string;
		targetAgentId: string;
	}>;

type MessageSource = Readonly<{
	messageId: string;
	workflowId: string;
	fromAgentId: string;
	targetAgentId: string;
	deliveryMode: MessageDeliveryMode;
	source: ToolCallPointer;
}>;

export type Message =
	| (MessageSource & Readonly<{
		kind: "message";
		origin: "agent_message" | "agent_control";
		content: string;
	}>)
	| (MessageSource & Readonly<{
		kind: "request";
		origin: "agent_message" | "agent_spawn";
		title: string;
		question: string;
		contextPreparation?: ContextPreparation;
	}>)
	| (MessageSource & Readonly<{
		kind: "answer";
		requestId: string;
		requestTitle: string;
		answer: string;
	}>)
	| (MessageSource & Readonly<{
		kind: "request_cancellation";
		requestId: string;
		reason: string;
	}>);

export function resolveCommittedMessage(options: {
	fromAgentId: string;
	workflowId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: MessageSendInput | RequestSendInput;
	resolvedTargetAgentId: string;
}): Message {
	const { fromAgentId, workflowId, transcript, toolCallId, providedInput, resolvedTargetAgentId } =
		options;
	const { source, input } = resolveCommittedToolCall({
		agentId: fromAgentId,
		transcript,
		toolCallId,
		toolName: "agent_message",
	});
	const committedInput = validateAgentMessageInput(input);
	if (committedInput.operation !== "send" && committedInput.operation !== "request") {
		throw new Error("invalid_input: Agent Message operation does not author a Message");
	}
	if (!sameAgentMessageInput(committedInput, providedInput)) {
		throw new Error("invariant_violation: executed Agent Message input differs from its source");
	}
	return indexedState(transcript).memo(
		resolveCommittedMessage,
		`${workflowId}\0${resolvedTargetAgentId}\0${toolCallId}`,
		source,
		(): Message => {
			const common = {
				messageId: deriveMessageIdentity(source),
				workflowId,
				fromAgentId,
				targetAgentId: resolvedTargetAgentId,
				deliveryMode: committedInput.deliveryMode ?? "deferred",
				source,
			};
			return committedInput.operation === "send"
				? {
						...common,
						kind: "message",
						origin: "agent_message",
						content: committedInput.content,
					}
				: {
						...common,
						kind: "request",
						origin: "agent_message",
						title: committedInput.title,
						question: committedInput.question,
						...(committedInput.contextPreparation === undefined
							? {}
							: { contextPreparation: committedInput.contextPreparation }),
					};
		},
	);
}

export function resolveCommittedAnswer(options: {
	responderAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: AnswerInput;
	request: Pick<Extract<Message, { kind: "request" }>, "messageId" | "workflowId" | "fromAgentId" | "title">;
}): Extract<Message, { kind: "answer" }> {
	const {
		responderAgentId,
		transcript,
		toolCallId,
		providedInput,
		request,
	} = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: responderAgentId,
		transcript,
		toolCallId,
		toolName: "agent_message",
	});
	const committedInput = resolveAgentMessageReferences(transcript, source, validateAgentMessageInput(input));
	if (committedInput.operation !== "answer") {
		throw new Error("invalid_input: Agent Message operation does not author an Answer");
	}
	if (!sameAgentMessageInput(committedInput, providedInput)) {
		throw new Error("invariant_violation: executed Agent Answer input differs from its source");
	}
	if (committedInput.requestId !== request.messageId) throw new Error("invalid_input: Answer names a different Request");
	return {
		kind: "answer",
		messageId: deriveMessageIdentity(source),
		workflowId: request.workflowId,
		fromAgentId: responderAgentId,
		targetAgentId: request.fromAgentId,
		deliveryMode: "steer",
		source,
		requestId: request.messageId,
		requestTitle: request.title,
		answer: committedInput.answer,
	};
}

export function resolveCommittedCancellation(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: CancellationInput;
	request: Extract<Message, { kind: "request" }>;
}): Extract<Message, { kind: "request_cancellation" }> {
	const {
		requesterAgentId,
		transcript,
		toolCallId,
		providedInput,
		request,
	} = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: requesterAgentId,
		transcript,
		toolCallId,
		toolName: "agent_message",
	});
	const committedInput = resolveAgentMessageReferences(transcript, source, validateAgentMessageInput(input));
	if (committedInput.operation !== "cancel") {
		throw new Error("invalid_input: Agent Message operation does not author a Cancellation");
	}
	if (!sameAgentMessageInput(committedInput, providedInput)) {
		throw new Error(
			"invariant_violation: executed Request Cancellation input differs from its source",
		);
	}
	return {
		kind: "request_cancellation",
		messageId: deriveMessageIdentity(source),
		workflowId: request.workflowId,
		fromAgentId: requesterAgentId,
		targetAgentId: request.targetAgentId,
		deliveryMode: "steer",
		source,
		requestId: request.messageId,
		reason: committedInput.reason,
	};
}

export function resolveCommittedAgentMessageInput(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): AgentMessageInput {
	const { input } = resolveCommittedToolCall({
		...options,
		toolName: "agent_message",
	});
	return validateAgentMessageInput(input);
}

export function inspectCanonicalMessage(options: {
	message: Message;
	authorTranscript: TranscriptInspection;
	deliveryEvidence?: EntryPointer;
}): CanonicalMessageInspection {
	const { message, authorTranscript, deliveryEvidence } = options;
	if (message.kind === "message" && message.origin === "agent_control") {
		return { state: inspectSupervisoryResumeAuthorResult({ message, transcript: authorTranscript, deliveryEvidence }), message };
	}
	if (message.kind === "request" && message.origin === "agent_spawn") {
		return { state: "canonical", message };
	}
	return {
		state: inspectMessageAuthorResult({
			authorAgentId: message.fromAgentId,
			transcript: authorTranscript,
			toolCallId: message.source.toolCallId,
			identity: message,
			deliveryEvidence,
		}),
		message,
	};
}

type AgentMessageAuthorInspectionOptions = Readonly<{
	authorAgentId: string;
	transcript: TranscriptInspection;
	source: ToolCallPointer;
}> & (
	| Readonly<{
		input: MessageSendInput | RequestSendInput;
		resolvedTargetAgentId: string;
		requestId?: never;
		requestTitle?: never;
	}>
	| Readonly<{
		input: AnswerInput;
		requestId: string;
		requestTitle: string;
		resolvedTargetAgentId?: never;
	}>
	| Readonly<{
		input: CancellationInput;
		resolvedTargetAgentId: string;
		requestId?: never;
		requestTitle?: never;
	}>
);

export function inspectAgentMessageAuthorResult(
	options: AgentMessageAuthorInspectionOptions,
): MessageAuthorResultState {
	const {
		authorAgentId,
		transcript,
		source,
		input,
		requestId,
		requestTitle,
		resolvedTargetAgentId,
	} = options;
	if (source.agentId !== authorAgentId) {
		throw new ProtocolInvariantError("Agent Message source names another author");
	}
	const messageId = deriveMessageIdentity(source);
	if (input.operation === "answer" && requestId === undefined) {
		throw new Error("invariant_violation: Agent Answer inspection requires its Request");
	}
	if (input.operation === "cancel" && resolvedTargetAgentId === undefined) {
		throw new Error(
			"invariant_violation: Request Cancellation inspection requires its resolved target",
		);
	}
	const identity: MessageResultIdentity = input.operation === "send"
		? {
			kind: "message",
			messageId,
			targetAgentId: resolvedTargetAgentId!,
		}
		: input.operation === "request"
			? {
				kind: "request",
				messageId,
				targetAgentId: resolvedTargetAgentId!,
			}
			: input.operation === "answer"
				? { kind: "answer", messageId, requestId: requestId!, requestTitle: requestTitle! }
				: {
					kind: "request_cancellation",
					messageId,
					requestId: input.requestMessageId,
					targetAgentId: resolvedTargetAgentId!,
				};
	return inspectMessageAuthorResult({
		authorAgentId,
		transcript,
		toolCallId: source.toolCallId,
		identity,
	});
}

function inspectMessageAuthorResult(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	identity: MessageResultIdentity;
	deliveryEvidence?: EntryPointer;
}): MessageAuthorResultState {
	const { authorAgentId, transcript, toolCallId, identity, deliveryEvidence } = options;
	const results = coordinationEntries(transcript, authorAgentId, `result:${toolCallId}`).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "agent_message" &&
			entry.message.toolCallId === toolCallId,
	).filter(entry => {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) return true;
		const details = entry.message.details;
		return readCoordinationRecord(transcript, authorAgentId, entry,
			() => validateAgentMessageResultShape(details, identity.kind === "message" ? "send" : identity.kind === "request_cancellation" ? "cancel" : identity.kind), toolCallId).accepted;
	});
	if (results.length > 1) {
		throw new Error(
			`invariant_violation: Message ${identity.messageId} has multiple author results`,
		);
	}
	const result = results[0];
	if (result && result.type === "message" && result.message.role === "toolResult") {
		if (result.message.isError) {
			if (deliveryEvidence) {
				throw new Error(
					`invariant_violation: Message ${identity.messageId} has an error result and Delivery`,
				);
			}
			return "not_created";
		}
		if (isNonAuthoringMessageResult(result.message.details, identity)) {
			if (deliveryEvidence) {
				throw new Error(
					`invariant_violation: Message ${identity.messageId} has a non-authoring result and Delivery`,
				);
			}
			return "not_created";
		}
		const details = result.message.details;
		const validated = readCoordinationRecord(transcript, authorAgentId, result,
			() => validateMessageAuthorResult(details, identity), toolCallId);
		if (!validated.accepted) return deliveryEvidence ? "canonical" : "indeterminate";
		// Initial definitive non-admission authors no Request. Retry outcomes are
		// separate tool calls and cannot withdraw an already-admitted Request.
		if (
			identity.kind === "request" &&
			isRecord(result.message.details) &&
			result.message.details.messageStatus === "not_sent"
		) {
			if (deliveryEvidence) {
				throw new Error(`invariant_violation: Request ${identity.messageId} has initial non-admission and Delivery`);
			}
			return "not_created";
		}
		return "canonical";
	}
	return deliveryEvidence ? "canonical" : "indeterminate";
}

function isNonAuthoringMessageResult(value: unknown, message: MessageResultIdentity): boolean {
	if (message.kind === "message" && isRecord(value)) {
		return (
			sameStringList(Object.keys(value).sort(), ["disposition", "reason", "requestMessageId"]) &&
			value.disposition === "rejected" &&
			value.reason === "answer_required" &&
			typeof value.requestMessageId === "string" &&
			value.requestMessageId.length > 0
		);
	}
	if (
		(message.kind !== "answer" && message.kind !== "request_cancellation") ||
		!isRecord(value) ||
		(message.kind === "answer" && value.requestMessageId !== message.requestId)
	) {
		return false;
	}
	const keys = Object.keys(value).sort();
	if (message.kind === "request_cancellation") {
		if (value.disposition === "already_answered") {
			return (
				sameStringList(keys, ["answerMessageId", "disposition"]) &&
				typeof value.answerMessageId === "string" &&
				value.answerMessageId.length > 0
			);
		}
		if (value.disposition === "already_cancelled") {
			return (
				sameStringList(keys, ["cancellationMessageId", "disposition"]) &&
				typeof value.cancellationMessageId === "string" &&
				value.cancellationMessageId.length > 0
			);
		}
		return false;
	}
	if (value.disposition === "already_answered") {
		return (
			sameStringList(keys, ["answerId", "disposition", "messageId", "requestMessageId", "requestTitle"]) &&
			value.requestTitle === message.requestTitle &&
			typeof value.answerId === "string" &&
			value.answerId.length > 0 &&
			value.messageId === value.answerId
		);
	}
	return false;
}

function validateMessageAuthorResult(
	value: unknown,
	message: MessageResultIdentity,
): void {
	const { messageId } = message;
	if (!isRecord(value)) {
		throw new CoordinationRecordValidationError(
			`invariant_violation: Message ${messageId} author result has an invalid shape`,
		);
	}
	const keys = Object.keys(value).sort();
	const identityKey = message.kind === "request" ? "requestMessageId" : "messageId";
	const correlationKeys = message.kind === "answer"
		? ["requestMessageId", "requestTitle"]
		: message.kind === "message" ||
				message.kind === "request" ||
				message.kind === "request_cancellation"
			? ["targetAgentId"]
			: [];
	if (message.kind === "answer" && value.disposition === "committed") {
		if (!sameStringList(keys, ["delivery", "disposition", "messageId", "reason", "requestMessageId", "requestTitle"]) ||
			value.delivery !== "omitted" || value.reason !== "request_source_unavailable") {
			throw new CoordinationRecordValidationError(`invariant_violation: Message ${messageId} author result has an invalid shape`);
		}
	} else if (value.messageStatus === "sent") {
		if (!sameStringList(keys, ["messageStatus", identityKey, ...correlationKeys].sort())) {
			throw new CoordinationRecordValidationError(
				`invariant_violation: Message ${messageId} author result has an invalid shape`,
			);
		}
	} else if (value.messageStatus === "unknown") {
		if (
			!sameStringList(
				keys,
				["messageStatus", identityKey, ...correlationKeys, "reason"].sort(),
			) ||
			value.reason !== "confirmation_lost"
		) {
			throw new CoordinationRecordValidationError(
				`invariant_violation: Message ${messageId} author result has an invalid shape`,
			);
		}
	} else if (value.messageStatus === "not_sent") {
		if (
			!sameStringList(
				keys,
				["messageStatus", identityKey, ...correlationKeys, "reason"].sort(),
			) ||
			(value.reason !== "target_unavailable" &&
				value.reason !== "host_shutting_down" &&
				value.reason !== "capacity_exhausted")
		) {
			throw new CoordinationRecordValidationError(
				`invariant_violation: Message ${messageId} author result has an invalid shape`,
			);
		}
	} else {
		throw new CoordinationRecordValidationError(
			`invariant_violation: Message ${messageId} author result has an invalid shape`,
		);
	}
	if (value[identityKey] !== messageId) {
		throw new Error(
			`invariant_violation: Message ${messageId} author result has the wrong identity`,
		);
	}
	if (message.kind === "answer" && value.requestMessageId !== message.requestId) {
		throw new Error(
			`invariant_violation: Answer ${messageId} author result has the wrong Request`,
		);
	}
	if (message.kind === "answer" && value.requestTitle !== message.requestTitle) {
		throw new ProtocolInvariantError(`Answer ${messageId} author result has the wrong Request title`);
	}
	if (
		(message.kind === "message" ||
			message.kind === "request" ||
			message.kind === "request_cancellation") &&
		value.targetAgentId !== message.targetAgentId
	) {
		throw new Error(
			`invariant_violation: Message ${messageId} author result has the wrong target`,
		);
	}
}

export function inspectMessageDelivery(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
	message: Message;
}): DeliveryInspection {
	const { recipientAgentId, transcript, message } = options;
	if (recipientAgentId !== message.targetAgentId) {
		throw new ProtocolInvariantError("Message Delivery inspection names another recipient");
	}
	for (const { projection } of deliveriesBySource({ recipientAgentId, transcript, source: message.source })) {
		if ((message.kind === "request" && projection.kind === "request" && projection.title !== message.title) ||
			(message.kind === "answer" && projection.kind === "answer" && projection.requestTitle !== message.requestTitle)) {
			throw new ProtocolInvariantError("Message Delivery title differs from its Request source");
		}
	}
	return inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript,
		source: message.source,
		identity: message,
		subject: `${messageSubject(message)} ${message.messageId}`,
	});
}

export function inspectAnswerDelivery(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
	answer: Extract<Message, { kind: "answer" }>;
}): DeliveryInspection {
	const { requesterAgentId, transcript, answer } = options;
	const customDelivery = inspectMessageDelivery({
		recipientAgentId: requesterAgentId,
		transcript,
		message: answer,
	});
	const retrievalEntries = retrievalsBySource({
		requesterAgentId,
		transcript,
		source: answer.source,
	}).filter((retrieval) => {
		if (!sameToolCallPointer(retrieval.answerSource, answer.source)) return false;
		if (
			retrieval.requestId !== answer.requestId ||
			retrieval.requestTitle !== answer.requestTitle ||
			retrieval.answerId !== answer.messageId ||
			retrieval.fromAgentId !== answer.fromAgentId
		) {
			throw new ProtocolInvariantError(
				`Answer ${answer.messageId} Retrieval differs from its source`,
			);
		}
		return true;
	});
	const matches = [
		...(customDelivery.deliveryEvidence ? [customDelivery.deliveryEvidence.entryId] : []),
		...retrievalEntries.map(({ deliveryEvidence }) => deliveryEvidence.entryId),
	];
	if (matches.length > 1) {
		throw new ProtocolInvariantError(`Answer ${answer.messageId} has duplicate Deliveries`);
	}
	return {
		...(matches[0] ? { deliveryEvidence: { agentId: requesterAgentId, entryId: matches[0] } } : {}),
		inspectedThrough: customDelivery.inspectedThrough,
	};
}

export function inspectAnswerRetrievals(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
}): readonly AnswerRetrievalEvidence[] {
	return answerRetrievalFacts(options).retrievals;
}
export function retrievalsForRequest(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
	requestId: string;
}): readonly AnswerRetrievalEvidence[] {
	return answerRetrievalFacts(options).byRequest.get(options.requestId) ?? [];
}
export function retrievalsBySource(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
	source: ToolCallPointer;
}): readonly AnswerRetrievalEvidence[] {
	return answerRetrievalFacts(options).bySource.get(toolCallPointerKey(options.source)) ?? [];
}

function answerRetrievalFacts(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
}) {
	const { requesterAgentId, transcript } = options;
	return indexedState(transcript).project(
		answerRetrievalFacts,
		requesterAgentId,
		coordinationEntries(transcript, requesterAgentId, "role:toolResult"),
		() => ({
			retrievals: [] as AnswerRetrievalEvidence[],
			byRequest: new Map<string, AnswerRetrievalEvidence[]>(),
			bySource: new Map<string, AnswerRetrievalEvidence[]>(),
		}),
		(facts, committedEntry) => {
			const retrievals: AnswerRetrievalEvidence[] = [];
			for (const entry of [committedEntry]) {
				if (
					entry.type !== "message" ||
					entry.message.role !== "toolResult" ||
					entry.message.isError ||
					!isRecord(entry.message.details)
				)
					continue;
				const resultMessage = entry.message;
				if (resultMessage.toolName === "agent_message" && !readCoordinationRecord(transcript, requesterAgentId,
					entry, () => validateAgentMessageResultShape(resultMessage.details), resultMessage.toolCallId).accepted) continue;
				const candidates =
					entry.message.toolName === "agent_message" &&
					entry.message.details.disposition === "answer_delivered"
						? [entry.message.details]
						: entry.message.toolName === "agent_wait"
							? completedAgentWaitAnswers({
									requesterAgentId,
									transcript,
									toolCallId: entry.message.toolCallId,
								})
							: [];
				for (const details of candidates) {
					if (typeof details.requestMessageId === "string" && !findCallerRequestSource({ agentId: requesterAgentId,
						transcript, requestMessageId: details.requestMessageId })) continue;
					const expectedKeys = [
						"answer",
						"answerId",
						"answerSource",
						"disposition",
						"fromAgentId",
						"requestMessageId",
						"requestTitle",
					];
					if (
						!sameStringList(Object.keys(details).sort(), expectedKeys) ||
						!isToolCallPointer(details.answerSource) ||
						typeof details.answerId !== "string" ||
						typeof details.requestMessageId !== "string" ||
						typeof details.requestTitle !== "string" || !details.requestTitle.trim() ||
						typeof details.fromAgentId !== "string" ||
						typeof details.answer !== "string" ||
						details.requestTitle !== callerRequestTitle({ agentId: requesterAgentId, transcript, requestMessageId: details.requestMessageId }) ||
						details.answerId !== deriveMessageIdentity(details.answerSource) ||
						details.fromAgentId !== details.answerSource.agentId
					) {
						throw new ProtocolInvariantError("Answer Retrieval evidence is invalid");
					}
					retrievals.push({
						answerId: details.answerId,
						requestId: details.requestMessageId,
						requestTitle: details.requestTitle,
						fromAgentId: details.fromAgentId,
						answer: details.answer,
						answerSource: details.answerSource,
						deliveryEvidence: { agentId: requesterAgentId, entryId: entry.id },
					});
				}
			}
			for (const retrieval of retrievals) {
				const forRequest = facts.byRequest.get(retrieval.requestId) ?? [];
				forRequest.push(retrieval);
				facts.byRequest.set(retrieval.requestId, forRequest);
				const key = toolCallPointerKey(retrieval.answerSource);
				const forSource = facts.bySource.get(key) ?? [];
				forSource.push(retrieval);
				facts.bySource.set(key, forSource);
				indexedState(transcript).observeMessageRequest(key, retrieval.requestId);
			}
			facts.retrievals.push(...retrievals);
			return facts;
		},
	);
}

function completedAgentWaitAnswers(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): readonly Extract<AgentWaitAnswer, { disposition: "answer_delivered" }>[] {
	const inspection = inspectCommittedAgentWaitResult({
		agentId: options.requesterAgentId,
		transcript: options.transcript,
		toolCallId: options.toolCallId,
	});
	if (inspection.state !== "completed") return [];
	return inspection.result.answers.filter(
		(answer): answer is Extract<
			AgentWaitAnswer,
			{ disposition: "answer_delivered" }
		> => answer.disposition === "answer_delivered",
	);
}

export function createMessageDeliveryItem(message: Message): MessageDeliveryItem {
	return {
		source: message.source,
		projection: modelVisibleProjection(message),
	};
}

function modelVisibleProjection(message: Message): ModelVisibleMessage {
	switch (message.kind) {
		case "message":
			return {
				kind: "message",
				messageId: message.messageId,
				fromAgentId: message.fromAgentId,
				content: message.content,
			};
		case "request":
			return {
				kind: "request",
				requestMessageId: message.messageId,
				fromAgentId: message.fromAgentId,
				title: message.title,
				question: message.question,
			};
		case "answer":
			return {
				kind: "answer",
				answerId: message.messageId,
				requestMessageId: message.requestId,
				requestTitle: message.requestTitle,
				fromAgentId: message.fromAgentId,
				answer: message.answer,
			};
		case "request_cancellation":
			return {
				kind: "request_cancellation",
				cancellationId: message.messageId,
				requestMessageId: message.requestId,
				fromAgentId: message.fromAgentId,
				reason: message.reason,
			};
	}
}

function messageSubject(message: Pick<Message, "kind">): string {
	switch (message.kind) {
		case "message":
			return "Message";
		case "request":
			return "Request";
		case "answer":
			return "Answer";
		case "request_cancellation":
			return "Request Cancellation";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCallPointer(value: unknown): value is ToolCallPointer {
	return (
		isRecord(value) &&
		typeof value.agentId === "string" &&
		value.agentId.length > 0 &&
		typeof value.entryId === "string" &&
		value.entryId.length > 0 &&
		typeof value.toolCallId === "string" &&
		value.toolCallId.length > 0
	);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
