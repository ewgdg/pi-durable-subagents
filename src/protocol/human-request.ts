import { CoordinationRecordValidationError } from "./record-validation.ts";
import { readCoordinationRecord } from "./replay-rejection.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import {
	deriveHumanRequestIdentity,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "./identities.ts";

export type HumanRequestInput = Readonly<{
	question: string;
}>;

export type HumanAnswer = Readonly<{
	requestId: string;
	answer: string;
}>;

export type HumanAnswerCandidate = HumanAnswer;

export type HumanRequest = Readonly<{
	requestId: string;
	requesterAgentId: string;
	source: ToolCallPointer;
	question: string;
}>;

export type HumanRequestResultInspection =
	| Readonly<{ state: "pending" }>
	| Readonly<{
		state: "answered";
		answer: HumanAnswer;
		resultEntryId: string;
	}>
	| Readonly<{
		state: "interrupted";
		resultEntryId: string;
	}>;

export function resolveCommittedHumanRequest(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: HumanRequestInput;
}): HumanRequest {
	const committed = resolveCommittedToolCall({
		agentId: options.agentId,
		transcript: options.transcript,
		toolCallId: options.toolCallId,
		toolName: "ask_user",
	});
	const input = validateHumanRequestInput(committed.input);
	const provided = validateHumanRequestInput(
		options.providedInput as unknown as Record<string, unknown>,
	);
	if (!isDeepStrictEqual(input, provided)) {
		throw new Error("invariant_violation: Human Request input differs from its committed call");
	}
	return {
		requestId: deriveHumanRequestIdentity(committed.source),
		requesterAgentId: options.agentId,
		source: committed.source,
		question: input.question,
	};
}

export function validateHumanRequestInput(
	value: Record<string, unknown>,
): HumanRequestInput {
	if (!isRecord(value) || !sameKeys(value, ["question"])) {
		throw new CoordinationRecordValidationError("invalid_input: Human Request input has an invalid shape");
	}
	return {
		question: requireNonBlank(value.question, "Human Request question"),
	};
}

export function validateHumanAnswer(
	requestId: string,
	value: unknown,
): HumanAnswer {
	if (!isRecord(value) || !sameKeys(value, ["answer", "requestId"])) {
		throw new CoordinationRecordValidationError(`invalid_input: Human Answer ${requestId} has an invalid shape`);
	}
	if (value.requestId !== requestId) {
		throw new Error(`invalid_correlation: Human Answer ${requestId} has invalid correlation`);
	}
	return {
		requestId,
		answer: requireNonBlank(value.answer, "Human Answer text"),
	};
}

export function inspectCommittedHumanRequestResult(options: {
	request: HumanRequest;
	transcript: TranscriptInspection;
}): HumanRequestResultInspection {
	const matches = coordinationEntries(options.transcript, options.request.requesterAgentId, `result:${options.request.source.toolCallId}`).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === options.request.source.toolCallId,
	).filter(entry => {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError || entry.message.toolName !== "ask_user") return true;
		const message = entry.message;
		return readCoordinationRecord(options.transcript, options.request.requesterAgentId, entry,
			() => validateHumanAnswerResult(message.details, message.content), message.toolCallId).accepted;
	});
	if (matches.length > 1) {
		throw new ProtocolInvariantError(
			`Human Request ${options.request.requestId} has multiple native results`,
		);
	}
	const match = matches[0];
	if (!match || match.type !== "message" || match.message.role !== "toolResult") {
		return { state: "pending" };
	}
	if (match.message.toolName !== "ask_user") {
		throw new ProtocolInvariantError(
			`Human Request ${options.request.requestId} result names ${match.message.toolName}`,
		);
	}
	if (match.message.isError) {
		return { state: "interrupted", resultEntryId: match.id };
	}
	const message = match.message;
	const parsed = readCoordinationRecord(options.transcript, options.request.requesterAgentId, match,
		() => validateHumanAnswerResult(message.details, message.content), message.toolCallId);
	if (!parsed.accepted) return { state: "pending" };
	const answer = validateHumanAnswer(options.request.requestId, parsed.value);
	return { state: "answered", answer, resultEntryId: match.id };
}

function requireNonBlank(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new CoordinationRecordValidationError(`invalid_input: ${name} must not be blank`);
	}
	return value;
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateHumanAnswerResult(details: unknown, content: unknown): HumanAnswer {
	if (!isRecord(details) || typeof details.requestId !== "string" || !details.requestId)
		throw new CoordinationRecordValidationError("Human Answer result has an invalid shape");
	const answer = validateHumanAnswer(details.requestId, details);
	if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string")
		throw new CoordinationRecordValidationError("Human Answer content has an invalid shape");
	let parsed: unknown;
	try { parsed = JSON.parse(content[0].text); }
	catch { throw new CoordinationRecordValidationError("Human Answer content is not valid JSON"); }
	if (!isDeepStrictEqual(parsed, answer)) throw new CoordinationRecordValidationError("Human Answer content differs from its details");
	return answer;
}
