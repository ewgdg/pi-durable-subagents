import type { AgentRosterStatus } from "../coordination/workflow-coordinator.ts";

type AgentRoster = Readonly<{
	live: readonly AgentRosterStatus[];
	dormant: readonly AgentRosterStatus[];
}>;

/**
 * The canonical Owner lookup: the roster Agent whose Agent ID equals its
 * Workflow ID. The Owner exists whatever its Run phase: a stopped Owner Run is
 * Dormant, not absent.
 */
export function findWorkflowOwner(roster: AgentRoster): AgentRosterStatus | undefined {
	return [...roster.live, ...roster.dormant].find(
		(status) => status.agentId === status.workflowId,
	);
}

/** The canonical Owner lookup for callers that cannot proceed without an Owner. */
export function requireWorkflowOwner(roster: AgentRoster): AgentRosterStatus {
	const owner = findWorkflowOwner(roster);
	if (!owner) throw new Error("Agent selector roster has no Owner");
	return owner;
}
