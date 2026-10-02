import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readCoordinationRecord } from "./replay-rejection.ts";
import { CoordinationRecordValidationError } from "./record-validation.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { OBLIGATION_REMINDER_CUSTOM_TYPE } from "./custom-entry-types.ts";
import {
	ProtocolInvariantError,
} from "./identities.ts";

export { OBLIGATION_REMINDER_CUSTOM_TYPE } from "./custom-entry-types.ts";

export const OBLIGATION_REMINDER_GUIDANCE =
	"This Request still needs an Answer. Choose which outstanding Request to work on or answer; attention order does not prescribe execution order. Send each Answer as a standalone agent_message operation \"answer\" call, then end the turn without a summary.";

export type ObligationReminder = Readonly<{
	requestMessageId: string;
	requestTitle: string;
	guidance: typeof OBLIGATION_REMINDER_GUIDANCE;
}>;

export type ModelVisibleObligationReminder = Readonly<{
	customType: typeof OBLIGATION_REMINDER_CUSTOM_TYPE;
	content: string;
	display: true;
}>;

export function createModelVisibleObligationReminder(options: {
	requestMessageId: string;
	requestTitle: string;
}): ModelVisibleObligationReminder {
	return {
		customType: OBLIGATION_REMINDER_CUSTOM_TYPE,
		content: JSON.stringify(reminderFor(options)),
		display: true,
	};
}

/**
 * A free reminder is keyed by its position among the Request's reminders, so it
 * is not deduplicated against the standing reminder or an earlier free one.
 */
export function obligationReminderDeliveryId(
	requestMessageId: string,
	freeReminderIndex?: number,
): string {
	return JSON.stringify(
		freeReminderIndex === undefined
			? ["obligation_reminder", requestMessageId]
			: ["obligation_reminder", requestMessageId, "after_human_interruption", freeReminderIndex],
	);
}

/**
 * Committed reminders for one Request, in transcript order. A Request may have
 * several: free reminders after human interruption are tracked only in memory,
 * so the transcript alone cannot tell them from the standing reminder.
 */
export function obligationReminderEntryIds(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
	requestMessageId: string;
	requestTitle: string;
}): string[] {
	const expected = reminderFor(options);
	const matches: string[] = [];
	for (const entry of coordinationEntries(options.transcript, options.recipientAgentId, `custom:${OBLIGATION_REMINDER_CUSTOM_TYPE}`)) {
		const parsed = readCoordinationRecord(options.transcript, options.recipientAgentId, entry, () => validateObligationReminderRecord(entry));
		if (!parsed.accepted) continue;
		const committed = parsed.value;
		if (committed.requestMessageId !== options.requestMessageId) continue;
		if (!isDeepStrictEqual(committed, expected)) {
			throw new ProtocolInvariantError(
				"Obligation Reminder contradicts its runtime-authored Delivery",
			);
		}
		matches.push(entry.id);
	}
	return matches;
}

function reminderFor(options: {
	requestMessageId: string;
	requestTitle: string;
}): ObligationReminder {
	if (typeof options.requestTitle !== "string" || !options.requestTitle.trim()) {
		throw new ProtocolInvariantError("Obligation Reminder Request title must not be blank");
	}
	return {
		requestMessageId: options.requestMessageId,
		requestTitle: options.requestTitle,
		guidance: OBLIGATION_REMINDER_GUIDANCE,
	};
}

function parseObligationReminder(content: string): ObligationReminder {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new CoordinationRecordValidationError(
			"Obligation Reminder content is not valid JSON",
		);
	}
	if (
		!isRecord(parsed) ||
		!hasExactKeys(parsed, ["requestMessageId", "requestTitle", "guidance"]) ||
		!isProtocolString(parsed.requestMessageId) ||
		typeof parsed.requestTitle !== "string" || !parsed.requestTitle.trim() ||
		parsed.guidance !== OBLIGATION_REMINDER_GUIDANCE
	) {
		throw new CoordinationRecordValidationError("Obligation Reminder has an invalid shape");
	}
	return {
		requestMessageId: parsed.requestMessageId,
		requestTitle: parsed.requestTitle,
		guidance: OBLIGATION_REMINDER_GUIDANCE,
	};
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

function isProtocolString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function validateObligationReminderRecord(entry: SessionEntry): ObligationReminder {
	if (entry.type !== "custom_message" || entry.customType !== OBLIGATION_REMINDER_CUSTOM_TYPE || !entry.display || typeof entry.content !== "string")
		throw new CoordinationRecordValidationError("ObligationReminder must be model-visible text");
	return parseObligationReminder(entry.content);
}
