const MAX_AGENT_LABEL_CODE_POINTS = 64;
const MAX_AGENT_DESCRIPTION_CODE_POINTS = 240;
const CONTROL_OR_LINE_BREAK = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
const OWNER_METADATA = {
	label: "Owner",
	description: "Workflow Owner",
} as const;
const MODERATOR_INCIDENT_BY_TRIGGER = {
	run_failure: "run failure",
	obligation_stall: "obligation stall",
	dependency_deadlock: "dependency deadlock",
	operation_review: "operation review",
	delivery_stall: "delivery stall",
} as const;

export type ModeratorTriggerKind = keyof typeof MODERATOR_INCIDENT_BY_TRIGGER;

export function normalizeAgentLabel(value: string): string {
	return normalizeAgentMetadata(value, "label", MAX_AGENT_LABEL_CODE_POINTS);
}

export function normalizeAgentDescription(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return normalizeAgentMetadata(
		value,
		"description",
		MAX_AGENT_DESCRIPTION_CODE_POINTS,
	);
}

export function resolveOrdinaryAgentMetadata(options: {
	explicitLabel?: string;
	explicitDescription?: string;
	templateName?: string;
}): Readonly<{ label: string; description?: string }> {
	const label = normalizeAgentLabel(
		options.explicitLabel ?? options.templateName ?? "agent",
	);
	const description = normalizeAgentDescription(options.explicitDescription);
	return {
		label,
		...(description === undefined ? {} : { description }),
	};
}

export function resolveOwnerAgentMetadata(): Readonly<{
	label: "Owner";
	description: "Workflow Owner";
}> {
	return OWNER_METADATA;
}

export function resolveModeratorAgentMetadata(
	triggerKind: ModeratorTriggerKind,
): Readonly<{ label: "Moderator"; description: string }> {
	return {
		label: "Moderator",
		description: normalizeAgentMetadata(
			`Incident: ${MODERATOR_INCIDENT_BY_TRIGGER[triggerKind]}`,
			"description",
			MAX_AGENT_DESCRIPTION_CODE_POINTS,
		),
	};
}

function normalizeAgentMetadata(
	value: string,
	field: "label" | "description",
	maxCodePoints: number,
): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new Error(`invalid_input: Agent ${field} must not be empty`);
	}
	if (CONTROL_OR_LINE_BREAK.test(normalized)) {
		throw new Error(`invalid_input: Agent ${field} must not contain line breaks or control characters`);
	}
	if ([...normalized].length > maxCodePoints) {
		throw new Error(
			`invalid_input: Agent ${field} exceeds ${maxCodePoints} Unicode code points`,
		);
	}
	return normalized;
}
