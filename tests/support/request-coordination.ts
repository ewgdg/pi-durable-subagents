import type { AgentRecord } from "../../src/coordination/agent-record.ts";
import { RequestEvidence } from "../../src/coordination/request-evidence.ts";
import { RequestRelationships } from "../../src/coordination/request-relationships.ts";

/** The shared Request readers a Workflow root builds before Message coordination. */
export function requestCoordination(
	agents: Map<string, AgentRecord>,
	quarantinedAgentIds: ReadonlySet<string> = new Set(),
	quarantinedWorkflowAgentIds: ReadonlySet<string> = quarantinedAgentIds,
) {
	const requestEvidence = new RequestEvidence(agents, quarantinedAgentIds, quarantinedWorkflowAgentIds);
	const requestRelationships = new RequestRelationships({ agents, requestEvidence });
	return { requestEvidence, requestRelationships };
}
