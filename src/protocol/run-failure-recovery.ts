import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readCoordinationRecord } from "./replay-rejection.ts";
import { CoordinationRecordValidationError } from "./record-validation.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { ProtocolInvariantError } from "./identities.ts";
import { RUN_FAILURE_RECOVERY_CUSTOM_TYPE } from "./custom-entry-types.ts";
import type { EntryPointer } from "./moderator-input.ts";

export { RUN_FAILURE_RECOVERY_CUSTOM_TYPE } from "./custom-entry-types.ts";

export const RUN_FAILURE_RECOVERY_DIRECTIVE =
	"Call moderator_control.resolve now. The remaining Answer Obligation is ordinary Workflow work.";

export type RunFailureRecovery = Readonly<{
	trigger: Readonly<{
		kind: "run_failure";
		agentId: string;
		failedRunSequence: number;
	}>;
	recovery: Readonly<{
		kind: "successor_run_started";
		successorRunSequence: number;
	}>;
	originalObligationsRemain: boolean;
	requiredAction: "resolve";
	guidance: typeof RUN_FAILURE_RECOVERY_DIRECTIVE;
}>;

export type ModelVisibleRunFailureRecovery = Readonly<{
	customType: typeof RUN_FAILURE_RECOVERY_CUSTOM_TYPE;
	content: string;
	display: true;
}>;

export function createModelVisibleRunFailureRecovery(
	recovery: RunFailureRecovery,
): ModelVisibleRunFailureRecovery {
	return {
		customType: RUN_FAILURE_RECOVERY_CUSTOM_TYPE,
		content: JSON.stringify(recovery),
		display: true,
	};
}

export function runFailureRecoveryDeliveryId(recovery: RunFailureRecovery): string {
	return JSON.stringify([
		"run_failure_recovery",
		recovery.trigger.agentId,
		recovery.trigger.failedRunSequence,
		recovery.recovery.successorRunSequence,
	]);
}

export function inspectRunFailureRecovery(options: {
	moderatorAgentId: string;
	transcript: TranscriptInspection;
	recovery: RunFailureRecovery;
}): EntryPointer | undefined {
	const matches: string[] = [];
	for (const entry of coordinationEntries(options.transcript, options.moderatorAgentId, `custom:${RUN_FAILURE_RECOVERY_CUSTOM_TYPE}`)) {
		const parsed = readCoordinationRecord(options.transcript, options.moderatorAgentId, entry, () => validateRunFailureRecoveryRecord(entry));
		if (!parsed.accepted) continue;
		const committed = parsed.value;
		if (!isDeepStrictEqual(committed, options.recovery)) {
			throw new ProtocolInvariantError(
				"Run Failure Recovery contradicts its runtime-authored delivery",
			);
		}
		matches.push(entry.id);
	}
	if (matches.length > 1) {
		throw new ProtocolInvariantError("Run Failure Recovery has duplicate Deliveries");
	}
	return matches[0]
		? { agentId: options.moderatorAgentId, entryId: matches[0] }
		: undefined;
}

function parseRunFailureRecovery(content: string): RunFailureRecovery {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new CoordinationRecordValidationError("Run Failure Recovery content is not valid JSON");
	}
	if (!isRecord(parsed) || !hasExactKeys(parsed, [
		"trigger",
		"recovery",
		"originalObligationsRemain",
		"requiredAction",
		"guidance",
	])) {
		throw new CoordinationRecordValidationError("Run Failure Recovery has an invalid shape");
	}
	const trigger = parsed.trigger;
	const recovery = parsed.recovery;
	if (
		!isRecord(trigger) ||
		!hasExactKeys(trigger, ["kind", "agentId", "failedRunSequence"]) ||
		trigger.kind !== "run_failure" ||
		!isProtocolString(trigger.agentId) ||
		!isRunSequence(trigger.failedRunSequence) ||
		!isRecord(recovery) ||
		!hasExactKeys(recovery, ["kind", "successorRunSequence"]) ||
		recovery.kind !== "successor_run_started" ||
		!isRunSequence(recovery.successorRunSequence) ||
		(recovery.successorRunSequence as number) <=
			(trigger.failedRunSequence as number) ||
		typeof parsed.originalObligationsRemain !== "boolean" ||
		parsed.requiredAction !== "resolve" ||
		parsed.guidance !== RUN_FAILURE_RECOVERY_DIRECTIVE
	) {
		throw new CoordinationRecordValidationError("Run Failure Recovery is invalid");
	}
	return {
		trigger: {
			kind: "run_failure",
			agentId: trigger.agentId,
			failedRunSequence: trigger.failedRunSequence as number,
		},
		recovery: {
			kind: "successor_run_started",
			successorRunSequence: recovery.successorRunSequence as number,
		},
		originalObligationsRemain: parsed.originalObligationsRemain,
		requiredAction: "resolve",
		guidance: RUN_FAILURE_RECOVERY_DIRECTIVE,
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

function isRunSequence(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocolString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function validateRunFailureRecoveryRecord(entry: SessionEntry): RunFailureRecovery {
	if (entry.type !== "custom_message" || entry.customType !== RUN_FAILURE_RECOVERY_CUSTOM_TYPE || !entry.display || typeof entry.content !== "string")
		throw new CoordinationRecordValidationError("RunFailureRecovery must be model-visible text");
	return parseRunFailureRecovery(entry.content);
}
