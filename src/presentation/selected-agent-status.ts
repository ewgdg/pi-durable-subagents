import type { Theme } from "@earendil-works/pi-coding-agent";

import type { AgentRunState } from "../runtime/agent-runtime-supervisor.ts";
import type { QuotaEvidence } from "../runtime/quota-evidence.ts";
import { compactAgentIdentity } from "./agent-identity.ts";

export type AgentWorkStatus =
	| Readonly<{ kind: "suspended"; evidence: QuotaEvidence }>
	| Readonly<{ kind: "active" | "compacting" }>
	| Readonly<{ kind: "dormant" | "idle" }>
	| Readonly<{
		kind: "waiting";
		reason: "human input" | "agent answer" | "resumption";
	}>
	| Readonly<{ kind: "starting" | "ending" | "failed" }>;

export type SelectedAgentIdentity = Readonly<{
	label: string;
	agentId: string;
	status: AgentWorkStatus;
}>;

export function selectedAgentWorkStatus(
	run: AgentRunState,
	failed: boolean,
	compacting = false,
): AgentWorkStatus {
	if (failed) return { kind: "failed" };
	if (run.phase === "starting") return { kind: "starting" };
	if (run.phase === "ending") return { kind: "ending" };
	if (run.phase === "dormant") return { kind: "dormant" };
	if (run.suspension) return { kind: "suspended", evidence: run.suspension.evidence };
	if (compacting) return { kind: "compacting" };
	if (run.attention === "input_required") {
		return { kind: "waiting", reason: "human input" };
	}
	if (run.attention === "agent_wait") {
		return { kind: "waiting", reason: "agent answer" };
	}
	if (run.retentionReasons.some(({ reason }) => reason === "interruption_hold")) {
		return { kind: "waiting", reason: "resumption" };
	}
	if (run.work === "active") return { kind: "active" };
	if (run.retentionReasons.some(({ reason }) => reason === "awaiting_answer")) {
		return { kind: "waiting", reason: "agent answer" };
	}
	return { kind: "idle" };
}

export function formatSelectedAgentIdentity(
	identity: SelectedAgentIdentity,
	theme: Theme,
): string {
	const label = theme.fg("accent", theme.bold(identity.label));
	const compactIdentity = compactAgentIdentity(identity.agentId);
	const separator = theme.fg("dim", ` · ${compactIdentity} · `);
	return `${label}${separator}${formatAgentWorkStatus(identity.status, theme)}`;
}

export function formatAgentWorkStatus(
	status: AgentWorkStatus,
	theme: Theme,
): string {
	const label = status.kind === "suspended"
		? "Suspended · Usage limit reached"
		: status.kind === "waiting"
		? `waiting (${status.reason})`
		: status.kind;
	const role = status.kind === "active"
		? "success"
		: status.kind === "waiting" || status.kind === "suspended"
			? "warning"
			: (status.kind === "starting" || status.kind === "compacting")
				? "accent"
				: status.kind === "failed"
					? "error"
					: "dim";
	return theme.fg(role, label);
}
