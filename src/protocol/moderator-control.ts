import { CoordinationRecordValidationError } from "./record-validation.ts";
import type { ToolCallPointer } from "./identities.ts";
import type { EntryPointer } from "./moderator-input.ts";
import { isDeepStrictEqual } from "node:util";

export type EvidencePointer = EntryPointer | ToolCallPointer;

export type ModeratorControlInput =
	| Readonly<{
		operation: "renew_review_deadline";
		toolCall: ToolCallPointer;
		nextReviewInMs: number;
		rationale: string;
	}>
	| Readonly<{
		operation: "resolve";
		summary: string;
		rationale: string;
		evidencePointers?: readonly EvidencePointer[];
	}>;

export type ModeratorResolutionBlocker =
	| "incoming_requests"
	| "outgoing_requests"
	| "obligation_stall"
	| "run_failure"
	| "dependency_deadlock"
	| "operation_review"
	| "delivery_stall";

export type ModeratorControlReceipt =
	| Readonly<{
		disposition: "renewed";
		toolCall: ToolCallPointer;
		nextReviewInMs: number;
	}>
	| Readonly<{
		disposition: "stale";
		toolCall: ToolCallPointer;
	}>
	| Readonly<{ disposition: "resolved" }>
	| Readonly<{ disposition: "already_cleared" }>
	| Readonly<{
		disposition: "blocked";
		predicates: readonly ModeratorResolutionBlocker[];
	}>;

export function sameModeratorControlInput(
	left: ModeratorControlInput,
	right: ModeratorControlInput,
): boolean {
	return isDeepStrictEqual(left, right);
}

export function validateModeratorControlInput(
	value: unknown,
): ModeratorControlInput {
	if (!isRecord(value)) {
		throw new CoordinationRecordValidationError("invalid_input: Moderator control input must be an object");
	}
	if (value.operation === "renew_review_deadline") {
		if (
			!hasExactKeys(value, [
				"operation",
				"toolCall",
				"nextReviewInMs",
				"rationale",
			]) ||
			!isEvidencePointer(value.toolCall) ||
			!("toolCallId" in value.toolCall) ||
			!Number.isSafeInteger(value.nextReviewInMs) ||
			(value.nextReviewInMs as number) <= 0 ||
			!isNonEmptyString(value.rationale)
		) {
			throw new CoordinationRecordValidationError("invalid_input: Moderator review renewal input is invalid");
		}
		return {
			operation: "renew_review_deadline",
			toolCall: value.toolCall,
			nextReviewInMs: value.nextReviewInMs as number,
			rationale: value.rationale,
		};
	}
	const expectedKeys = [
		"operation",
		"summary",
		"rationale",
		...(value.evidencePointers === undefined ? [] : ["evidencePointers"]),
	];
	if (!hasExactKeys(value, expectedKeys) || value.operation !== "resolve") {
		throw new CoordinationRecordValidationError("invalid_input: Moderator control input has an invalid shape");
	}
	if (!isNonEmptyString(value.summary) || !isNonEmptyString(value.rationale)) {
		throw new CoordinationRecordValidationError(
			"invalid_input: Moderator Resolution requires summary and rationale",
		);
	}
	const evidencePointers = value.evidencePointers;
	if (
		evidencePointers !== undefined &&
		(!Array.isArray(evidencePointers) || !evidencePointers.every(isEvidencePointer))
	) {
		throw new CoordinationRecordValidationError("invalid_input: Moderator Resolution evidence pointers are invalid");
	}
	return {
		operation: "resolve",
		summary: value.summary,
		rationale: value.rationale,
		...(evidencePointers === undefined
			? {}
			: { evidencePointers: evidencePointers as EvidencePointer[] }),
	};
}

function isEvidencePointer(value: unknown): value is EvidencePointer {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (
		keys.length !== 2 &&
		keys.length !== 3
	) return false;
	if (!isNonEmptyString(value.agentId) || !isNonEmptyString(value.entryId)) {
		return false;
	}
	return keys.length === 2
		? hasExactKeys(value, ["agentId", "entryId"])
		: hasExactKeys(value, ["agentId", "entryId", "toolCallId"]) &&
			isNonEmptyString(value.toolCallId);
}

function hasExactKeys(
	record: Record<string, unknown>,
	expectedKeys: readonly string[],
): boolean {
	const actual = Object.keys(record).sort();
	const expected = [...expectedKeys].sort();
	return actual.length === expected.length &&
		actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
