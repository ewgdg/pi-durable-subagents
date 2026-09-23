import {
	type OperationalIncidentAttention,
	type OperationalIncidentPresentation,
} from "../coordination/operational-incidents.ts";

export class OperationalIncidentSurface implements OperationalIncidentPresentation {
	readonly #attentionByConditionKey = new Map<string, OperationalIncidentAttention>();

	present(conditionKey: string, attention: OperationalIncidentAttention): void {
		this.#attentionByConditionKey.set(conditionKey, attention);
	}

	dismiss(conditionKey: string): void {
		this.#attentionByConditionKey.delete(conditionKey);
	}

	items(): readonly OperationalIncidentAttention[] {
		return [...this.#attentionByConditionKey.values()];
	}
}

export function formatOperationalIncidentHeadline(
	attention: OperationalIncidentAttention,
): string {
	const run = attention.trigger.kind === "run_failure"
		? ` · Run ${attention.trigger.runSequence}`
		: "";
	const affectedAgentLabels = attention.affectedAgents.map(({ label }) => label);
	return `${formatOperationalIncidentKind(attention.trigger.kind)} · ${affectedAgentLabels.join(", ")}${run}`;
}

export function operationalIncidentRequestEvidence(
	attention: OperationalIncidentAttention,
) {
	if ((attention.trigger.kind === "operation_review" || attention.trigger.kind === "moderation_unavailable")) {
		return { total: 0, sources: [] };
	}
	return (attention.trigger.kind === "dependency_deadlock" || attention.trigger.kind === "delivery_stall")
		? attention.trigger.requests
		: attention.trigger.obligations;
}

export function formatOperationalIncidentKind(
	kind: OperationalIncidentAttention["trigger"]["kind"],
): string {
	return kind.split("_").map(
		(word) => word[0]!.toUpperCase() + word.slice(1),
	).join(" ");
}
