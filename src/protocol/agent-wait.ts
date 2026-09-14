import { readCoordinationRecord } from "./replay-rejection.ts";
import { validateAgentMessageInput } from "./agent-message-input.ts";
import { validateAgentSpawnInput } from "./agent-spawn-input.ts";
import { CoordinationRecordValidationError } from "./record-validation.ts";
import { resolveMessageReference } from "./message-reference.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import {
	compareCommittedToolCallOrder,
	deriveMessageIdentity,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "./identities.ts";

export type AgentWaitInput = Readonly<{ requestMessageIds?: string[] }>;

export type AgentWaitProgress = Readonly<{
	waitingFor: readonly Readonly<{
		requestMessageId: string;
		requestTitle: string;
		responderAgentId: string;
	}>[];
}>;

export type AgentWaitAnswer =
	| Readonly<{
		disposition: "answer_delivered";
		requestMessageId: string;
		requestTitle: string;
		answerId: string;
		fromAgentId: string;
		answer: string;
		answerSource: ToolCallPointer;
	}>
	| Readonly<{
		disposition: "answer_already_delivered";
		requestMessageId: string;
		requestTitle: string;
		answerId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>;

export type CompletedAgentWaitResult = Readonly<{
	answers: readonly AgentWaitAnswer[];
}>;

export type AgentWaitResult =
	| CompletedAgentWaitResult
	| Readonly<{ disposition: "preempted" }>;

export type AgentWaitResultInspection =
	| Readonly<{ state: "pending" }>
	| Readonly<{ state: "interrupted"; resultEntryId: string }>
	| Readonly<{ state: "preempted"; resultEntryId: string }>
	| Readonly<{
		state: "completed";
		result: CompletedAgentWaitResult;
		resultEntryId: string;
	}>;

export function resolveCommittedAgentWaitCall(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: AgentWaitInput;
}): Readonly<{ source: ToolCallPointer; input: AgentWaitInput }> {
	const committed = committedAgentWaitCall(options);
	const input = committed.input;
	const provided = validateAgentWaitInput(options.providedInput);
	if (!isDeepStrictEqual(input, provided)) {
		throw new Error("invariant_violation: Agent Wait input differs from its committed call");
	}
	return { source: committed.source, input };
}

export function inspectCommittedAgentWaitResult(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): AgentWaitResultInspection {
	const matches = coordinationEntries(options.transcript, options.agentId, `result:${options.toolCallId}`).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === options.toolCallId,
	).filter(entry => {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError || entry.message.toolName !== "agent_wait") return true;
		const message = entry.message;
		return readCoordinationRecord(options.transcript, options.agentId, entry,
			() => validateAgentWaitResultRecord(message.details, message.content), message.toolCallId).accepted;
	});
	if (matches.length > 1) {
		throw new ProtocolInvariantError(
			`Agent Wait ${options.toolCallId} has multiple native results`,
		);
	}
	const match = matches[0];
	if (!match || match.type !== "message" || match.message.role !== "toolResult") {
		return { state: "pending" };
	}
	if (match.message.toolName !== "agent_wait") {
		throw new ProtocolInvariantError(
			`Agent Wait ${options.toolCallId} result names ${match.message.toolName}`,
		);
	}
	if (match.message.isError) {
		return { state: "interrupted", resultEntryId: match.id };
	}
	const message = match.message;
	const parsed = readCoordinationRecord(options.transcript, options.agentId, match,
		() => validateAgentWaitResultRecord(message.details, message.content), options.toolCallId);
	if (!parsed.accepted) return { state: "pending" };
	const result = parsed.value;
	const committed = resolveCommittedToolCall({ agentId: options.agentId, transcript: options.transcript, toolCallId: options.toolCallId, toolName: "agent_wait" });
	const callEntry = options.transcript.entries.find(entry => entry.id === committed.source.entryId)!;
	if (!readCoordinationRecord(options.transcript, options.agentId, callEntry,
		() => validateAgentWaitInput(committed.input), options.toolCallId).accepted) return { state: "pending" };
	const call = committedAgentWaitCall(options);
	if ("disposition" in result) {
		return { state: "preempted", resultEntryId: match.id };
	}
	// A result referencing an absent authored Request cannot restore that source.
	if (result.answers.some(answer => !findCallerRequestSource({ agentId: options.agentId,
		transcript: options.transcript, requestMessageId: answer.requestMessageId }))) return { state: "pending" };
	// The native result materializes the live snapshot. Explicit selection also
	// binds its membership, while every result must preserve caller source order.
	if (call.input.requestMessageIds) {
		const selected = resolveAgentWaitSelection(options.transcript, call.source, call.input.requestMessageIds);
		if (!isDeepStrictEqual(selected, result.answers.map(answer => answer.requestMessageId))) {
			throw new ProtocolInvariantError("Agent Wait result differs from its explicit Request selection");
		}
	}
	const requestSources = result.answers.map(({ requestMessageId }) =>
		requireCallerRequestSource({
			agentId: options.agentId,
			transcript: options.transcript,
			requestMessageId,
		})
	);
	for (let index = 0; index < requestSources.length; index += 1) {
		const source = requestSources[index]!;
		if (result.answers[index]!.requestTitle !== callerRequestTitle({
			agentId: options.agentId, transcript: options.transcript,
			requestMessageId: result.answers[index]!.requestMessageId,
		})) throw new ProtocolInvariantError("Agent Wait Answer title differs from its Request source");
		if (
			compareCommittedToolCallOrder(options.transcript, source, call.source) >= 0 ||
			(index > 0 && compareCommittedToolCallOrder(
				options.transcript,
				requestSources[index - 1]!,
				source,
			) >= 0)
		) {
			throw new ProtocolInvariantError(
				"Agent Wait result does not preserve its outstanding Request snapshot order",
			);
		}
	}
	return { state: "completed", result, resultEntryId: match.id };
}

export function validateAgentWaitResult(value: unknown): AgentWaitResult {
	if (
		isRecord(value) &&
		sameKeys(value, ["disposition"]) &&
		value.disposition === "preempted"
	) return { disposition: "preempted" };
	if (!isRecord(value) || !sameKeys(value, ["answers"]) || !Array.isArray(value.answers)) {
		throw new CoordinationRecordValidationError("Agent Wait result has an invalid shape");
	}
	const answers = value.answers.map((candidate): AgentWaitAnswer => {
		if (!isRecord(candidate) || typeof candidate.disposition !== "string") {
			throw new CoordinationRecordValidationError("Agent Wait Answer has an invalid shape");
		}
		if (candidate.disposition === "answer_delivered") {
			if (
				!sameKeys(candidate, [
					"answer", "answerId", "answerSource", "disposition",
					"fromAgentId", "requestMessageId", "requestTitle",
				]) ||
				!isToolCallPointer(candidate.answerSource) ||
				typeof candidate.requestMessageId !== "string" ||
				typeof candidate.requestTitle !== "string" || !candidate.requestTitle.trim() ||
				typeof candidate.answerId !== "string" ||
				typeof candidate.fromAgentId !== "string" ||
				typeof candidate.answer !== "string" || candidate.answer.length === 0
			) throw new CoordinationRecordValidationError("Agent Wait delivered Answer is invalid");
			if (candidate.answerId !== deriveMessageIdentity(candidate.answerSource) || candidate.fromAgentId !== candidate.answerSource.agentId)
				throw new ProtocolInvariantError("Agent Wait delivered Answer identity is invalid");
			return candidate as AgentWaitAnswer;
		}
		if (
			candidate.disposition !== "answer_already_delivered" ||
			!sameKeys(candidate, [
				"answerId", "deliveryEvidence", "disposition", "requestMessageId", "requestTitle",
			]) ||
			typeof candidate.requestMessageId !== "string" ||
			typeof candidate.requestTitle !== "string" || !candidate.requestTitle.trim() ||
			typeof candidate.answerId !== "string" || candidate.answerId.length === 0 ||
			!isEntryPointer(candidate.deliveryEvidence)
		) throw new CoordinationRecordValidationError("Agent Wait prior Answer Delivery is invalid");
		return candidate as AgentWaitAnswer;
	});
	const requestIds = answers.map(({ requestMessageId }) => requestMessageId);
	if (
		answers.length === 0 ||
		requestIds.some((requestId) => requestId.length === 0) ||
		new Set(requestIds).size !== requestIds.length
	) throw new CoordinationRecordValidationError("Agent Wait result has invalid Request identities");
	return { answers };
}

/** Receipt labels are bound to the author's immutable Request, including Creation Requests. */
export function callerRequestTitle(options: {
	agentId: string;
	transcript: TranscriptInspection;
	requestMessageId: string;
}): string {
	const source = requireCallerRequestSource(options);
	const calls = coordinationEntries(options.transcript, options.agentId, `call:${source.toolCallId}`)
		.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
			? entry.message.content.filter(part => part.type === "toolCall" && part.id === source.toolCallId)
			: []);
	const call = calls[0];
	if (calls.length !== 1 || call?.type !== "toolCall" ||
		typeof call.arguments.title !== "string" || !call.arguments.title.trim()) {
		throw new ProtocolInvariantError("Answer receipt Request source has an invalid title");
	}
	return call.arguments.title;
}

export function validateAgentWaitInput(value: unknown): AgentWaitInput {
	if (!isRecord(value) || Object.keys(value).some(key => key !== "requestMessageIds")) {
		throw new CoordinationRecordValidationError("invalid_input: Agent Wait accepts only requestMessageIds");
	}
	if (!("requestMessageIds" in value)) return {};
	if (!Array.isArray(value.requestMessageIds) || value.requestMessageIds.length === 0 ||
		value.requestMessageIds.some(id => typeof id !== "string" || id.trim().length === 0)) {
		throw new CoordinationRecordValidationError("invalid_input: Agent Wait requestMessageIds must be a nonempty array of nonblank strings");
	}
	return { requestMessageIds: value.requestMessageIds };
}

/** Resolve the entire selection before the coordinator can renew delivery intent. */
export function resolveAgentWaitSelection(
	transcript: TranscriptInspection,
	source: ToolCallPointer,
	selectors: readonly string[],
): readonly string[] {
	const ids = [...new Set(selectors.map(selector => resolveMessageReference(transcript, source, selector)))];
	const sources = new Map(ids.map(requestMessageId => [requestMessageId, requireCallerRequestSource({
		agentId: source.agentId, transcript, requestMessageId,
	})]));
	for (const requestSource of sources.values()) {
		if (compareCommittedToolCallOrder(transcript, requestSource, source) >= 0) {
			throw new Error("invalid_input: Agent Wait selection must precede its call");
		}
	}
	return ids.sort((left, right) => compareCommittedToolCallOrder(transcript, sources.get(left)!, sources.get(right)!));
}

function committedAgentWaitCall(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): Readonly<{ source: ToolCallPointer; input: AgentWaitInput }> {
	const committed = resolveCommittedToolCall({
		agentId: options.agentId,
		transcript: options.transcript,
		toolCallId: options.toolCallId,
		toolName: "agent_wait",
	});
	return { source: committed.source, input: validateAgentWaitInput(committed.input) };
}

export function findCallerRequestSource(options: {
	agentId: string;
	transcript: TranscriptInspection;
	requestMessageId: string;
}): ToolCallPointer | undefined {
	const matches: ToolCallPointer[] = [];
	for (const entry of coordinationEntries(options.transcript, options.agentId, "request-source")) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (
				part.type !== "toolCall" ||
				(part.name !== "agent_spawn" &&
					(part.name !== "agent_message" || part.arguments?.operation !== "request"))
			) continue;
			const parsed = readCoordinationRecord(options.transcript, options.agentId, entry,
				() => part.name === "agent_spawn" ? validateAgentSpawnInput(part.arguments) : validateAgentMessageInput(part.arguments), part.id);
			if (!parsed.accepted) continue;
			const source = {
				agentId: options.agentId,
				entryId: entry.id,
				toolCallId: part.id,
			};
			if (deriveMessageIdentity(source) === options.requestMessageId) matches.push(source);
		}
	}
	if (matches.length > 1) {
		throw new ProtocolInvariantError(
			`Agent Wait result Request ${options.requestMessageId} has ${matches.length} caller sources`,
		);
	}
	return matches[0];
}

function requireCallerRequestSource(options: Parameters<typeof findCallerRequestSource>[0]): ToolCallPointer {
	const source = findCallerRequestSource(options);
	if (!source) throw new Error(`unknown_identity: Request ${options.requestMessageId}`);
	return source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return keys.length === sortedExpected.length &&
		keys.every((key, index) => key === sortedExpected[index]);
}

function isToolCallPointer(value: unknown): value is ToolCallPointer {
	return isRecord(value) &&
		sameKeys(value, ["agentId", "entryId", "toolCallId"]) &&
		typeof value.agentId === "string" && value.agentId.length > 0 &&
		typeof value.entryId === "string" && value.entryId.length > 0 &&
		typeof value.toolCallId === "string" && value.toolCallId.length > 0;
}

function isEntryPointer(
	value: unknown,
): value is Readonly<{ agentId: string; entryId: string }> {
	return isRecord(value) &&
		sameKeys(value, ["agentId", "entryId"]) &&
		typeof value.agentId === "string" && value.agentId.length > 0 &&
		typeof value.entryId === "string" && value.entryId.length > 0;
}

/** A Wait receipt's model content and details are one atomic record. */
export function validateAgentWaitResultRecord(details: unknown, content: unknown): AgentWaitResult {
	const result = validateAgentWaitResult(details);
	if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string")
		throw new CoordinationRecordValidationError("Agent Wait result content has an invalid shape");
	let parsed: unknown;
	try { parsed = JSON.parse(content[0].text); }
	catch { throw new CoordinationRecordValidationError("Agent Wait result content is not valid JSON"); }
	if (!isDeepStrictEqual(parsed, result)) throw new CoordinationRecordValidationError("Agent Wait result content differs from its details");
	return result;
}
