import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import type { AgentCreationPreset } from "../templates/agent-templates.ts";
import { validateAgentCreationPreset } from "./agent-creation-preset.ts";
import { resolveModeratorAgentMetadata } from "./agent-metadata.ts";
import type { ToolCallPointer } from "./identities.ts";
import { ProtocolInvariantError } from "./identities.ts";
import {
	AGENT_IDENTITY_CUSTOM_TYPE,
	MODERATOR_INPUT_CUSTOM_TYPE,
	MODERATOR_ROUTINE_START_CUSTOM_TYPE,
} from "./custom-entry-types.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

export { MODERATOR_INPUT_CUSTOM_TYPE } from "./custom-entry-types.ts";

export const MODERATOR_ROUTINE_START_INSTRUCTION = "Begin moderation.";

export const MAX_MODERATOR_REQUEST_SOURCES = 16;

export type EntryPointer = Readonly<{
	agentId: string;
	entryId: string;
}>;

export type ModeratorIdentity = Readonly<{
	agentId: string;
	workflowId: string;
	directSpawnerAgentId: null;
	/** Rules captured with this atomic bootstrap, not role/authority metadata. */
	creationPreset: AgentCreationPreset;
	metadata: Readonly<{
		label: "Moderator";
		description: string;
	}>;
}>;

export function isModeratorIdentity(
	identity: Readonly<{
		agentId: string;
		workflowId: string;
		directSpawnerAgentId: string | null;
	}>,
): identity is ModeratorIdentity {
	return identity.agentId !== identity.workflowId &&
		identity.directSpawnerAgentId === null;
}

export type ModeratorRequestSet = Readonly<{
	total: number;
	sources: readonly ToolCallPointer[];
}>;

export type DeliveryProgressStage = "eligible" | "reserved" | "dispatched";
export type DeliveryBlockageReason =
	| Readonly<{ kind: "scheduling_failure"; diagnostic: string }>
	| Readonly<{ kind: "progress_deadline"; stage: DeliveryProgressStage; intervalMs: number }>;

export type ModeratorTrigger =
	| Readonly<{
		kind: "delivery_stall";
		agentIds: readonly string[];
		requests: ModeratorRequestSet;
		delivery: Readonly<{ messageId: string; recipientAgentId: string }>;
		reason: DeliveryBlockageReason;
	}>
	| Readonly<{
		kind: "obligation_stall";
		agentId: string;
		obligations: ModeratorRequestSet;
	}>
	| Readonly<{
		kind: "run_failure";
		agentId: string;
		runSequence: number;
		obligations: ModeratorRequestSet;
	}>
	| Readonly<{
		kind: "dependency_deadlock";
		agentIds: readonly string[];
		requests: ModeratorRequestSet;
	}>
	| Readonly<{
		kind: "operation_review";
		toolCall: ToolCallPointer;
		reviewIntervalMs: number;
	}>;

export type ModeratorInput = Readonly<{
	trigger: ModeratorTrigger;
	inspectedThrough: readonly EntryPointer[];
	previousAttempt?: EntryPointer;
}>;

export type ModelVisibleModeratorInput = Readonly<{
	customType: typeof MODERATOR_INPUT_CUSTOM_TYPE;
	content: string;
	display: true;
	details: Readonly<{
		agentId: string;
		workflowId: string;
		metadata: ModeratorIdentity["metadata"];
		creationPreset: AgentCreationPreset;
	}>;
}>;

export type ModelVisibleModeratorRoutineStart = Readonly<{
	customType: typeof MODERATOR_ROUTINE_START_CUSTOM_TYPE;
	content: typeof MODERATOR_ROUTINE_START_INSTRUCTION;
	display: false;
}>;

export function createModelVisibleModeratorInput(
	identity: ModeratorIdentity,
	input: ModeratorInput,
): ModelVisibleModeratorInput {
	return {
		customType: MODERATOR_INPUT_CUSTOM_TYPE,
		content: JSON.stringify(input),
		display: true,
		details: {
			agentId: identity.agentId,
			workflowId: identity.workflowId,
			metadata: identity.metadata,
			creationPreset: identity.creationPreset,
		},
	};
}

export function createModelVisibleModeratorRoutineStart(): ModelVisibleModeratorRoutineStart {
	return {
		customType: MODERATOR_ROUTINE_START_CUSTOM_TYPE,
		content: MODERATOR_ROUTINE_START_INSTRUCTION,
		display: false,
	};
}

export function validateCommittedModeratorInput(options: {
	transcript: TranscriptInspection;
	identity: ModeratorIdentity;
	input: ModeratorInput;
}): void {
	const { transcript, identity, input } = options;
	if (transcript.sessionId !== identity.agentId) {
		throw new ProtocolInvariantError(
			"Moderator Input does not match its Pi session identity",
		);
	}
	const entries = transcript.entries;
	const inputs = entries.filter(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === MODERATOR_INPUT_CUSTOM_TYPE,
	);
	if (inputs.length !== 1) {
		throw new ProtocolInvariantError(
			`Moderator transcript contains ${inputs.length} Input entries`,
		);
	}
	const entry = inputs[0];
	if (
		!entry ||
		entry.type !== "custom_message" ||
		entries[0] !== entry ||
		entry.parentId !== null ||
		entry.display !== true
	) {
		throw new ProtocolInvariantError(
			"Moderator Input is not the model-visible transcript bootstrap entry",
		);
	}
	let committedInput: unknown;
	try {
		if (typeof entry.content !== "string") {
			throw new Error("non-text content");
		}
		committedInput = JSON.parse(entry.content);
	} catch {
		throw new ProtocolInvariantError("Moderator Input content is not valid JSON");
	}
	const expectedDetails = {
		agentId: identity.agentId,
		workflowId: identity.workflowId,
		metadata: identity.metadata,
		creationPreset: identity.creationPreset,
	};
	if (
		!isDeepStrictEqual(committedInput, input) ||
		!isDeepStrictEqual(entry.details, expectedDetails)
	) {
		throw new ProtocolInvariantError(
			"Moderator Input contradicts its runtime-authored bootstrap",
		);
	}
}

export function validateColdModeratorInput(options: {
	sessionId: string;
	entries: readonly SessionEntry[];
}): Readonly<{
	identity: ModeratorIdentity;
	input: ModeratorInput;
}> {
	const ordinaryIdentities = options.entries.filter(
		(entry) => entry.type === "custom" &&
			entry.customType === AGENT_IDENTITY_CUSTOM_TYPE,
	);
	const inputs = options.entries.filter(
		(entry) => entry.type === "custom_message" &&
			entry.customType === MODERATOR_INPUT_CUSTOM_TYPE,
	);
	if (ordinaryIdentities.length > 0 || inputs.length !== 1) {
		throw new ProtocolInvariantError(
			"Moderator transcript must contain one Input and no ordinary Identity",
		);
	}
	const entry = inputs[0];
	if (
		!entry ||
		entry.type !== "custom_message" ||
		options.entries[0] !== entry ||
		entry.parentId !== null ||
		entry.display !== true ||
		typeof entry.content !== "string"
	) {
		throw new ProtocolInvariantError(
			"Moderator Input is not the model-visible transcript bootstrap entry",
		);
	}

	let inputValue: unknown;
	try {
		inputValue = JSON.parse(entry.content);
	} catch {
		throw new ProtocolInvariantError("Moderator Input content is not valid JSON");
	}
	const input = validateModeratorInput(inputValue);
	const details = requireExactRecord(entry.details, [
		"agentId",
		"workflowId",
		"metadata",
		"creationPreset",
	]);
	if (
		details.agentId !== options.sessionId ||
		!isIdentifier(details.workflowId) ||
		details.workflowId === options.sessionId
	) {
		throw new ProtocolInvariantError("Moderator Input Workflow relationship is invalid");
	}
	const committedMetadata = requireExactRecord(details.metadata, [
		"label",
		"description",
	]);
	const metadata = resolveModeratorAgentMetadata(input.trigger.kind);
	if (
		committedMetadata.label !== metadata.label ||
		committedMetadata.description !== metadata.description
	) {
		throw new ProtocolInvariantError("Moderator Input metadata is invalid");
	}
	return {
		identity: {
			agentId: options.sessionId,
			workflowId: details.workflowId,
			directSpawnerAgentId: null,
			creationPreset: validateAgentCreationPreset(details.creationPreset),
			metadata,
		},
		input,
	};
}

function validateModeratorInput(value: unknown): ModeratorInput {
	const input = requireRecord(value);
	requireExactKeys(input, input.previousAttempt === undefined
		? ["trigger", "inspectedThrough"]
		: ["trigger", "inspectedThrough", "previousAttempt"]);
	const triggerValue = requireRecord(input.trigger);
	let trigger: ModeratorTrigger;
	let affectedAgentIds: readonly string[];
	if (triggerValue.kind === "obligation_stall") {
		requireExactKeys(triggerValue, ["kind", "agentId", "obligations"]);
		if (!isIdentifier(triggerValue.agentId)) {
			throw new ProtocolInvariantError("Moderator Input trigger is invalid");
		}
		affectedAgentIds = [triggerValue.agentId];
		trigger = {
			kind: "obligation_stall",
			agentId: triggerValue.agentId,
			obligations: validateRequestSet(triggerValue.obligations),
		};
	} else if (triggerValue.kind === "run_failure") {
		requireExactKeys(triggerValue, [
			"kind",
			"agentId",
			"runSequence",
			"obligations",
		]);
		if (
			!isIdentifier(triggerValue.agentId) ||
			!Number.isSafeInteger(triggerValue.runSequence) ||
			(triggerValue.runSequence as number) < 1
		) {
			throw new ProtocolInvariantError("Moderator Input Run is invalid");
		}
		affectedAgentIds = [triggerValue.agentId];
		trigger = {
			kind: "run_failure",
			agentId: triggerValue.agentId,
			runSequence: triggerValue.runSequence as number,
			obligations: validateRequestSet(triggerValue.obligations),
		};
	} else if (triggerValue.kind === "dependency_deadlock" || triggerValue.kind === "delivery_stall") {
		requireExactKeys(triggerValue, triggerValue.kind === "delivery_stall"
			? ["kind", "agentIds", "requests", "delivery", "reason"]
			: ["kind", "agentIds", "requests"]);
		if (
			!Array.isArray(triggerValue.agentIds) ||
			triggerValue.agentIds.length === 0 ||
			!triggerValue.agentIds.every(isIdentifier)
		) {
			throw new ProtocolInvariantError("Moderator Input affected Agents are invalid");
		}
		affectedAgentIds = [...triggerValue.agentIds] as string[];
		if (
			new Set(affectedAgentIds).size !== affectedAgentIds.length ||
			affectedAgentIds.some(
				(agentId, index) => index > 0 && affectedAgentIds[index - 1]!.localeCompare(agentId) >= 0,
			)
		) {
			throw new ProtocolInvariantError("Moderator Input affected Agents are not normalized");
		}
		const requests = validateRequestSet(triggerValue.requests);
		if (triggerValue.kind === "delivery_stall") {
			const delivery = requireExactRecord(triggerValue.delivery, ["messageId", "recipientAgentId"]);
			if (!isIdentifier(delivery.messageId) || !isIdentifier(delivery.recipientAgentId) ||
				!affectedAgentIds.includes(delivery.recipientAgentId)) {
				throw new ProtocolInvariantError("Moderator Input blocked Delivery is invalid");
			}
			const reason = requireRecord(triggerValue.reason);
			let blockage: Extract<ModeratorTrigger, { kind: "delivery_stall" }>["reason"];
			if (reason.kind === "scheduling_failure") {
				requireExactKeys(reason, ["kind", "diagnostic"]);
				if (typeof reason.diagnostic !== "string") throw new ProtocolInvariantError("Moderator Input diagnostic is invalid");
				blockage = { kind: reason.kind, diagnostic: reason.diagnostic };
			} else {
				requireExactKeys(reason, ["kind", "stage", "intervalMs"]);
				if (reason.kind !== "progress_deadline" ||
					!["eligible", "reserved", "dispatched"].includes(reason.stage as string) ||
					!Number.isSafeInteger(reason.intervalMs) || (reason.intervalMs as number) <= 0) {
					throw new ProtocolInvariantError("Moderator Input Delivery interval is invalid");
				}
				blockage = { kind: reason.kind, stage: reason.stage as "eligible" | "reserved" | "dispatched", intervalMs: reason.intervalMs as number };
			}
			trigger = { kind: "delivery_stall", agentIds: affectedAgentIds, requests,
				delivery: { messageId: delivery.messageId, recipientAgentId: delivery.recipientAgentId }, reason: blockage };
		} else {
			trigger = { kind: "dependency_deadlock", agentIds: affectedAgentIds, requests };
		}
	} else if (triggerValue.kind === "operation_review") {
		requireExactKeys(triggerValue, ["kind", "toolCall", "reviewIntervalMs"]);
		const toolCall = validateToolCallPointer(triggerValue.toolCall);
		if (
			!Number.isSafeInteger(triggerValue.reviewIntervalMs) ||
			(triggerValue.reviewIntervalMs as number) <= 0
		) {
			throw new ProtocolInvariantError("Moderator Input review interval is invalid");
		}
		affectedAgentIds = [toolCall.agentId];
		trigger = {
			kind: "operation_review",
			toolCall,
			reviewIntervalMs: triggerValue.reviewIntervalMs as number,
		};
	} else {
		throw new ProtocolInvariantError("Moderator Input trigger is invalid");
	}
	if (
		!Array.isArray(input.inspectedThrough) ||
		input.inspectedThrough.length !== affectedAgentIds.length
	) {
		throw new ProtocolInvariantError("Moderator Input inspection watermarks are invalid");
	}
	const inspectedThrough = input.inspectedThrough.map((value, index) => {
		const pointer = validateEntryPointer(value);
		if (pointer.agentId !== affectedAgentIds[index]) {
			throw new ProtocolInvariantError("Moderator Input inspection watermark is invalid");
		}
		return pointer;
	});
	const previousAttempt = input.previousAttempt === undefined
		? undefined
		: validateEntryPointer(input.previousAttempt);
	return {
		trigger,
		inspectedThrough,
		...(previousAttempt === undefined ? {} : { previousAttempt }),
	};
}

function validateEntryPointer(value: unknown): EntryPointer {
	const pointer = requireExactRecord(value, ["agentId", "entryId"]);
	if (!isIdentifier(pointer.agentId) || !isIdentifier(pointer.entryId)) {
		throw new ProtocolInvariantError("Moderator Input entry pointer is invalid");
	}
	return { agentId: pointer.agentId, entryId: pointer.entryId };
}

function validateRequestSet(value: unknown): ModeratorRequestSet {
	const obligations = requireExactRecord(value, ["total", "sources"]);
	if (
		!Number.isSafeInteger(obligations.total) ||
		(obligations.total as number) < 1 ||
		!Array.isArray(obligations.sources) ||
		obligations.sources.length < 1 ||
		obligations.sources.length > MAX_MODERATOR_REQUEST_SOURCES ||
		obligations.sources.length > (obligations.total as number)
	) {
		throw new ProtocolInvariantError("Moderator Input obligations are invalid");
	}
	const sources = obligations.sources.map(validateToolCallPointer);
	if (new Set(sources.map(pointerKey)).size !== sources.length) {
		throw new ProtocolInvariantError("Moderator Input Request sources contain duplicates");
	}
	return {
		total: obligations.total as number,
		sources,
	};
}

function validateToolCallPointer(value: unknown): ToolCallPointer {
	const pointer = requireExactRecord(value, ["agentId", "entryId", "toolCallId"]);
	if (
		!isIdentifier(pointer.agentId) ||
		!isIdentifier(pointer.entryId) ||
		!isIdentifier(pointer.toolCallId)
	) {
		throw new ProtocolInvariantError("Moderator Input Request source is invalid");
	}
	return {
		agentId: pointer.agentId,
		entryId: pointer.entryId,
		toolCallId: pointer.toolCallId,
	};
}

function pointerKey(pointer: ToolCallPointer): string {
	return `${pointer.agentId}\0${pointer.entryId}\0${pointer.toolCallId}`;
}

function requireExactRecord(
	value: unknown,
	expectedKeys: readonly string[],
): Record<string, unknown> {
	const record = requireRecord(value);
	requireExactKeys(record, expectedKeys);
	return record;
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ProtocolInvariantError("Moderator Input value must be an object");
	}
	return value as Record<string, unknown>;
}

function requireExactKeys(
	record: Record<string, unknown>,
	expectedKeys: readonly string[],
): void {
	const actual = Object.keys(record).sort();
	const expected = [...expectedKeys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new ProtocolInvariantError("Moderator Input value has an invalid shape");
	}
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
