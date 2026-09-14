import { resolveAgentMessageReferences } from "./message-reference.ts";
import { indexedState, coordinationEntries } from "../transcript/retained-transcript.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import {
	deriveMessageIdentity,
	compareCommittedToolCallOrder,
	ProtocolInvariantError,
	sameToolCallPointer,
	type ToolCallPointer,
} from "./identities.ts";
import {
	inspectAnswerDelivery,
	retrievalsBySource,
	retrievalsForRequest,
	inspectCanonicalMessage,
	inspectMessageDelivery,
	resolveCommittedAnswer,
	resolveCommittedCancellation,
	type AgentMessageInput,
	type Message,
	type RequestSendInput,
	validateAgentMessageInput,
} from "./message.ts";
import {
	inspectMessageDeliveries,
	deliveriesBySource,
	deliveriesForRequest,
	type DeliveredMessageEvidence,
	validateDeliveredMessageEvidence,
} from "./message-delivery.ts";

type Request = Extract<Message, { kind: "request" }>;
type Answer = Extract<Message, { kind: "answer" }>;
type Cancellation = Extract<Message, { kind: "request_cancellation" }>;

export type AuthoredAgentMessageSource = Readonly<{
	source: ToolCallPointer;
	input: Exclude<AgentMessageInput, { operation: "poll" | "retry" }>;
}>;

export type AuthoredRequestSource = Readonly<{
	source: ToolCallPointer;
	input: RequestSendInput;
}>;

export type CanonicalRequestResolution = Readonly<{
	answer?: Answer;
	cancellation?: Cancellation;
}>;

export function findAuthoredAgentMessageSource(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
	messageId: string;
}): AuthoredAgentMessageSource | undefined {
	const matches = authoredFacts(options).byMessage.get(options.messageId) ?? [];
	if (matches.length > 1) {
		throw new ProtocolInvariantError(
			`Message ${options.messageId} has multiple author sources`,
		);
	}
	return matches[0];
}

export function findAuthoredRequestSources(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
}): readonly AuthoredRequestSource[] {
	return authoredFacts(options).requests;
}

export function inspectCanonicalRequestResolution(options: {
	request: Request;
	requesterTranscript: TranscriptInspection;
	responderTranscript: TranscriptInspection;
}): CanonicalRequestResolution {
	const { request, requesterTranscript, responderTranscript } = options;
	const candidates = answerSourcesForRequest(options);
	const requesterState = indexedState(requesterTranscript);
	const responderState = indexedState(responderTranscript);
	return requesterState.memo(
		inspectCanonicalRequestResolution,
		request.messageId,
		[
			requesterState.requestVersion(request.messageId),
			responderState,
			responderState.scopeVersion,
			responderState.requestVersion(request.messageId),
		],
		() => {
			const answers = candidates.flatMap(({ source, input }) => {
				if (input.operation !== "answer") return [];
				const resultRequestId = answerSourceResultRequestId({
					transcript: responderTranscript,
					source,
				});
				const deliveryRequestId = answerSourceDeliveryRequestId({
					requesterAgentId: request.fromAgentId,
					transcript: requesterTranscript,
					source,
				});
				if (
					resultRequestId !== undefined &&
					deliveryRequestId !== undefined &&
					resultRequestId !== deliveryRequestId
				) {
					throw new ProtocolInvariantError(
						`Agent Answer ${deriveMessageIdentity(source)} result and Delivery name different Requests`,
					);
				}
				const correlatedRequestId = resultRequestId ?? deliveryRequestId;
				if (correlatedRequestId !== request.messageId) return [];
				const answer = resolveCommittedAnswer({
					responderAgentId: request.targetAgentId,
					transcript: responderTranscript,
					toolCallId: source.toolCallId,
					providedInput: input,
					request,
				});
				const delivery = inspectAnswerDelivery({
					requesterAgentId: request.fromAgentId,
					transcript: requesterTranscript,
					answer,
				});
				return inspectCanonicalMessage({
					message: answer,
					authorTranscript: responderTranscript,
					deliveryEvidence: delivery.deliveryEvidence,
				}).state === "canonical"
					? [answer]
					: [];
			});
			const cancellations = (
				authoredFacts({
					authorAgentId: request.fromAgentId,
					transcript: requesterTranscript,
				}).cancellations.get(request.messageId) ?? []
			)
				.filter(
					(
						source,
					): source is AuthoredAgentMessageSource & {
						input: Extract<AgentMessageInput, { operation: "cancel" }>;
					} =>
						source.input.operation === "cancel" &&
						source.input.requestMessageId === request.messageId,
				)
				.map(({ source, input }) =>
					resolveCommittedCancellation({
						requesterAgentId: request.fromAgentId,
						transcript: requesterTranscript,
						toolCallId: source.toolCallId,
						providedInput: input,
						request,
					}),
				)
				.filter((cancellation) => {
					const delivery = inspectMessageDelivery({
						recipientAgentId: request.targetAgentId,
						transcript: responderTranscript,
						message: cancellation,
					});
					return (
						inspectCanonicalMessage({
							message: cancellation,
							authorTranscript: requesterTranscript,
							deliveryEvidence: delivery.deliveryEvidence,
						}).state === "canonical"
					);
				});
			if (answers.length > 1) {
				throw new ProtocolInvariantError(
					`Request ${request.messageId} has multiple canonical Answers`,
				);
			}
			if (cancellations.length > 1) {
				throw new ProtocolInvariantError(
					`Request ${request.messageId} has multiple canonical Cancellations`,
				);
			}
			return {
				...(answers[0] === undefined ? {} : { answer: answers[0] }),
				...(cancellations[0] === undefined ? {} : { cancellation: cancellations[0] }),
			};
		},
	);
}

export function answerCallTargetAgentId(options: {
	responderAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): string | undefined {
	const { responderAgentId, transcript, toolCallId } = options;
	const candidate = findAuthoredAgentMessageSources({ authorAgentId: responderAgentId, transcript })
		.find(candidate => candidate.source.toolCallId === toolCallId && candidate.input.operation === "answer");
	if (!candidate || candidate.input.operation !== "answer") return undefined;
	const requestId = candidate.input.requestId;
	return inspectMessageDeliveries({ recipientAgentId: responderAgentId, transcript })
		.find(({ projection }) => projection.kind === "request" && projection.requestMessageId === requestId)?.projection.fromAgentId;
}

export function answerSourceResultRequestId(options: {
	transcript: TranscriptInspection;
	source: ToolCallPointer;
}): string | undefined {
	const results = coordinationEntries(options.transcript, options.source.agentId, `result:${options.source.toolCallId}`).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "agent_message" &&
			entry.message.toolCallId === options.source.toolCallId,
	);
	if (results.length > 1) {
		throw new ProtocolInvariantError(
			`Agent Answer source ${options.source.toolCallId} has multiple results`,
		);
	}
	const result = results[0];
	if (!result) return undefined;
	if (result.type !== "message" || result.message.role !== "toolResult") {
		return undefined;
	}
	// An error result carries no authoritative correlation. Candidate Delivery
	// inspection still enforces the error-result-plus-Delivery crash invariant.
	if (result.message.isError) return undefined;
	const details = result.message.details;
	if (
		typeof details !== "object" ||
		details === null ||
		!("requestMessageId" in details) ||
		typeof details.requestMessageId !== "string" ||
		details.requestMessageId.length === 0
	) {
		throw new ProtocolInvariantError(
			`Agent Answer source ${options.source.toolCallId} has malformed correlation evidence`,
		);
	}
	return details.requestMessageId;
}

export function answerSourceDeliveryRequestId(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
	source: ToolCallPointer;
}): string | undefined {
	const direct = deliveriesBySource({
		recipientAgentId: options.requesterAgentId,
		transcript: options.transcript,
		source: options.source,
	});
	const requestIds: string[] = [];
	for (const delivery of direct) {
		validateDeliveredMessageEvidence(delivery);
		if (delivery.projection.kind !== "answer") {
			throw new ProtocolInvariantError(
				`Agent Answer source ${options.source.toolCallId} has non-Answer Delivery`,
			);
		}
		requestIds.push(delivery.projection.requestMessageId);
	}
	for (const retrieval of retrievalsBySource({
		requesterAgentId: options.requesterAgentId,
		transcript: options.transcript,
		source: options.source,
	})) {
		if (sameToolCallPointer(retrieval.answerSource, options.source)) {
			requestIds.push(retrieval.requestId);
		}
	}
	if (requestIds.length > 1) {
		throw new ProtocolInvariantError(
			`Agent Answer source ${options.source.toolCallId} has duplicate Deliveries`,
		);
	}
	return requestIds[0];
}

export function findAuthoredAgentMessageSources(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
}): AuthoredAgentMessageSource[] {
	return authoredFacts(options).sources;
}

function authoredFacts(options: { authorAgentId: string; transcript: TranscriptInspection }) {
	const { transcript, authorAgentId } = options;
	const facts = indexedState(transcript).project(
		authoredFacts,
		authorAgentId,
		coordinationEntries(transcript, authorAgentId, "tool:agent_message"),
		() => ({
			sources: [] as AuthoredAgentMessageSource[],
			requests: [] as AuthoredRequestSource[],
			invalidCalls: [] as Array<{ source: ToolCallPointer; cause: unknown }>,
			byMessage: new Map<string, AuthoredAgentMessageSource[]>(),
			byCall: new Map<string, AuthoredAgentMessageSource[]>(),
			cancellations: new Map<string, AuthoredAgentMessageSource[]>(),
			cancellationOrder: [] as AuthoredAgentMessageSource[],
		}),
		(facts, entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") return facts;
			for (const part of entry.message.content) {
				if (part.type !== "toolCall" || part.name !== "agent_message") continue;
				let input: AgentMessageInput;
				try {
					input = validateAgentMessageInput(part.arguments);
					if (input.operation === "poll" || input.operation === "retry") continue;
					input = resolveAgentMessageReferences(transcript, { agentId: authorAgentId, entryId: entry.id, toolCallId: part.id }, input);
				} catch (cause) {
					facts.invalidCalls.push({
						source: { agentId: authorAgentId, entryId: entry.id, toolCallId: part.id },
						cause,
					});
					continue;
				}
				if (input.operation === "poll" || input.operation === "retry") continue;
				const source = {
					source: { agentId: authorAgentId, entryId: entry.id, toolCallId: part.id },
					input,
				};
				const messageId = deriveMessageIdentity(source.source);
				const matches = facts.byMessage.get(messageId) ?? [];
				matches.push(source);
				facts.byMessage.set(messageId, matches);
				facts.sources.push(source);
				const calls = facts.byCall.get(part.id) ?? [];
				calls.push(source);
				facts.byCall.set(part.id, calls);
				if (input.operation === "request")
					indexedState(transcript).bindRequestSource(part.id, messageId);
				if (input.operation === "cancel") {
					const cancellations = facts.cancellations.get(input.requestMessageId) ?? [];
					cancellations.push(source);
					facts.cancellations.set(input.requestMessageId, cancellations);
					facts.cancellationOrder.push(source);
					indexedState(transcript).bindRequestSource(part.id, input.requestMessageId);
				}
				if (input.operation === "request") facts.requests.push({ source: source.source, input });
			}
			return facts;
		},
	);
	// Invalid calls remain candidates until their native validation result commits.
	// A cached absence cannot hide a later contradictory successful result.
	for (const { source, cause } of facts.invalidCalls) {
		const { toolCallId } = source;
		const results = coordinationEntries(transcript, authorAgentId, `result:${toolCallId}`).filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "agent_message",
		);
		if (results.length === 0) continue;
		if (
			results.length === 1 &&
			results[0]?.type === "message" &&
			results[0].message.role === "toolResult" &&
			results[0].message.isError
		)
			continue;
		throw new ProtocolInvariantError(`committed agent_message source ${toolCallId} is invalid`, {
			source, cause, transcriptPath: transcript.transcriptPath,
		});
	}
	return facts;
}

/** Correlation is indexed when each Answer result arrives. */
export function answerResultSources(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
}) {
	const { authorAgentId, transcript } = options;
	const authored = authoredFacts(options);
	return indexedState(transcript).project(
		answerResultSources,
		authorAgentId,
		coordinationEntries(transcript, authorAgentId, "role:toolResult"),
		() => new Map<string, AuthoredAgentMessageSource[]>(),
		(byRequest, entry) => {
			if (
				entry.type !== "message" ||
				entry.message.role !== "toolResult" ||
				entry.message.toolName !== "agent_message"
			)
				return byRequest;
			for (const candidate of authored.byCall.get(entry.message.toolCallId) ?? []) {
				if (candidate.input.operation !== "answer") continue;
				const requestId = answerSourceResultRequestId({ transcript, source: candidate.source });
				if (requestId === undefined) continue;
				const sources = byRequest.get(requestId) ?? [];
				sources.push(candidate);
				byRequest.set(requestId, sources);
				indexedState(transcript).bindRequestSource(candidate.source.toolCallId, requestId);
			}
			return byRequest;
		},
	);
}

function answerSourcesForRequest(options: {
	request: Request;
	requesterTranscript: TranscriptInspection;
	responderTranscript: TranscriptInspection;
}): AuthoredAgentMessageSource[] {
	const { request, requesterTranscript, responderTranscript } = options;
	const candidates = new Map<string, AuthoredAgentMessageSource>();
	for (const source of answerResultSources({
		authorAgentId: request.targetAgentId,
		transcript: responderTranscript,
	}).get(request.messageId) ?? [])
		candidates.set(source.source.toolCallId, source);
	const deliveredSources = [
		...deliveriesForRequest({
			recipientAgentId: request.fromAgentId,
			transcript: requesterTranscript,
			requestId: request.messageId,
		})
			.filter((delivery) => delivery.projection.kind === "answer")
			.map((delivery) => delivery.source),
		...retrievalsForRequest({
			requesterAgentId: request.fromAgentId,
			transcript: requesterTranscript,
			requestId: request.messageId,
		}).map((retrieval) => retrieval.answerSource),
	];
	for (const pointer of deliveredSources) {
		if (pointer.agentId !== request.targetAgentId) continue;
		const source = findAuthoredAgentMessageSource({
			authorAgentId: request.targetAgentId,
			transcript: responderTranscript,
			messageId: deriveMessageIdentity(pointer),
		});
		if (source) candidates.set(source.source.toolCallId, source);
	}
	for (const candidate of candidates.values())
		indexedState(responderTranscript).bindRequestSource(
			candidate.source.toolCallId,
			request.messageId,
		);
	return [...candidates.values()];
}

export function cancellationSourcesForRequest(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
	requestId: string;
}): readonly AuthoredAgentMessageSource[] {
	return authoredFacts(options).cancellations.get(options.requestId) ?? [];
}
export function cancellationSourcesAfter(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
	source: ToolCallPointer;
}): readonly AuthoredAgentMessageSource[] {
	const ordered = authoredFacts(options).cancellationOrder;
	let low = 0,
		high = ordered.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (
			compareCommittedToolCallOrder(options.transcript, ordered[middle]!.source, options.source) <=
			0
		)
			low = middle + 1;
		else high = middle;
	}
	return ordered.slice(low);
}
