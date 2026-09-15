import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { indexedState } from "../transcript/retained-transcript.ts";
import { validateAgentMessageInput, type AgentMessageInput } from "./agent-message-input.ts";
import { validateAgentSpawnInput } from "./agent-spawn-input.ts";
import { validateAgentWaitInput, validateAgentWaitResultRecord } from "./agent-wait.ts";
import {
	OBLIGATION_REMINDER_CUSTOM_TYPE,
	RUN_FAILURE_RECOVERY_CUSTOM_TYPE,
	MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE,
} from "./custom-entry-types.ts";
import { validateHumanRequestInput, validateHumanAnswerResult } from "./human-request.ts";
import { inspectMessageDeliveries } from "./message-delivery.ts";
import { validateAgentMessageResultShape } from "./message-result-shape.ts";
import { validateModeratorControlInput } from "./moderator-control.ts";
import { validateModeratorObligationReminderRecord } from "./moderator-obligation-reminder.ts";
import {
	validateReportToUserInput, validateModeratorReport, validateModeratorReportReadState, validateReportFinding,
	MODERATOR_REPORT_CUSTOM_TYPE, MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE, MODERATOR_REPORT_FINDING_CUSTOM_TYPE,
} from "./moderator-report.ts";
import { obligationStack } from "./obligation-focus.ts";
import { validateObligationReminderRecord } from "./obligation-reminder.ts";
import { CoordinationRecordValidationError } from "./record-validation.ts";
import { findAuthoredAgentMessageSources } from "./request-resolution.ts";
import { validateRunControlInput, validateSupervisoryResumeResultShape } from "./run-control.ts";
import { validateRunFailureRecoveryRecord } from "./run-failure-recovery.ts";

export type ContextOnlyReason = "invalid" | "inherited";
export type CoordinationRejection = Readonly<{
	reason: "invalid";
	source: Readonly<{ agentId: string; entryId: string; toolCallId?: string }>;
	recordKind: "tool-call" | "tool-result" | "custom";
	diagnostic: string;
}>;

const CALL_VALIDATORS: Readonly<Record<string, (value: Record<string, unknown>) => unknown>> = {
	agent_message: validateAgentMessageInput,
	agent_spawn: validateAgentSpawnInput,
	agent_wait: validateAgentWaitInput,
	agent_control: validateRunControlInput,
	ask_user: validateHumanRequestInput,
	report_to_user: validateReportToUserInput,
	moderator_control: validateModeratorControlInput,
};
const CUSTOM_VALIDATORS: Readonly<Record<string, (entry: SessionEntry) => unknown>> = {
	[MODERATOR_REPORT_CUSTOM_TYPE]: entry => validateModeratorReport(customData(entry)),
	[MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE]: entry => validateModeratorReportReadState(customData(entry)),
	[MODERATOR_REPORT_FINDING_CUSTOM_TYPE]: entry => validateReportFinding(customData(entry)),
	[OBLIGATION_REMINDER_CUSTOM_TYPE]: validateObligationReminderRecord,
	[RUN_FAILURE_RECOVERY_CUSTOM_TYPE]: validateRunFailureRecoveryRecord,
	[MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE]: validateModeratorObligationReminderRecord,
};

function rejections(transcript: TranscriptInspection, agentId: string) {
	const state = indexedState(transcript);
	return state.memo(rejections, agentId, state.scopeVersion, () => new Map<string, CoordinationRejection>());
}

/** Catch only validators' declared failures; no reference or identity repair. */
export function readCoordinationRecord<T>(
	transcript: TranscriptInspection,
	agentId: string,
	entry: SessionEntry,
	validate: () => T,
	toolCallId?: string,
): { accepted: true; value: T } | { accepted: false } {
	try {
		return { accepted: true, value: validate() };
	} catch (error) {
		if (!(error instanceof CoordinationRecordValidationError)) throw error;
		const source = { agentId, entryId: entry.id, ...(toolCallId === undefined ? {} : { toolCallId }) };
		const recordKind = entry.type === "message"
			? entry.message.role === "assistant" ? "tool-call" : "tool-result"
			: "custom";
		rejections(transcript, agentId).set(`${entry.id}:${toolCallId ?? ""}`, {
			reason: "invalid", source, recordKind, diagnostic: error.message,
		});
		return { accepted: false };
	}
}

/** Enumerate physical current-scope rejections, independent of selected leaf or reader order. */
export function inspectCoordinationRejections(
	transcript: TranscriptInspection,
	agentId: string,
): readonly CoordinationRejection[] {
	const state = indexedState(transcript);
	state.project(inspectCoordinationRejections, agentId, state.scope(agentId), () => undefined, (_, entry) => {
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const part of entry.message.content) {
				if (part.type !== "toolCall") continue;
				const validate = CALL_VALIDATORS[part.name];
				if (validate) readCoordinationRecord(transcript, agentId, entry, () => validate(part.arguments), part.id);
			}
		}
		if (entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError) {
			const message = entry.message;
			const sourceEntry = state.bucket(agentId, `call:${message.toolCallId}`)
				.find(candidate => candidate.type === "message" && candidate.message.role === "assistant");
			const source = sourceEntry?.type === "message" && sourceEntry.message.role === "assistant"
				? sourceEntry.message.content.find(part => part.type === "toolCall" && part.id === message.toolCallId)
				: undefined;
			let operation: AgentMessageInput["operation"] | undefined;
			if (message.toolName === "agent_message" && source?.type === "toolCall" && sourceEntry) {
				const parsed = readCoordinationRecord(transcript, agentId, sourceEntry,
					() => validateAgentMessageInput(source.arguments), source.id);
				if (parsed.accepted) operation = parsed.value.operation;
			}
			const validate = message.toolName === "agent_message"
				? () => validateAgentMessageResultShape(message.details, operation)
				: message.toolName === "agent_wait"
					? () => validateAgentWaitResultRecord(message.details, message.content)
					: message.toolName === "ask_user"
						? () => validateHumanAnswerResult(message.details, message.content)
						: message.toolName === "agent_control" && source?.type === "toolCall" && source.arguments?.operation === "resume"
							? () => validateSupervisoryResumeResultShape(message.details)
							: undefined;
			if (validate) readCoordinationRecord(transcript, agentId, entry, validate, message.toolCallId);
		}
		if (entry.type === "custom" || entry.type === "custom_message") {
			const validate = CUSTOM_VALIDATORS[entry.customType];
			if (validate) readCoordinationRecord(transcript, agentId, entry, () => validate(entry));
		}
		return undefined;
	});
	// These readers validate complete envelopes before contributing protocol effects.
	findAuthoredAgentMessageSources({ authorAgentId: agentId, transcript });
	inspectMessageDeliveries({ recipientAgentId: agentId, transcript });
	obligationStack(transcript, agentId);
	return [...rejections(transcript, agentId).values()].sort((left, right) =>
		state.positions.get(left.source.entryId)! - state.positions.get(right.source.entryId)! ||
		(left.source.toolCallId ?? "").localeCompare(right.source.toolCallId ?? ""));
}

function customData(entry: SessionEntry): unknown {
	if (entry.type !== "custom") throw new CoordinationRecordValidationError("Moderator report record must be a custom entry");
	return entry.data;
}
