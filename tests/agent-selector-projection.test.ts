import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRosterStatus } from "../src/coordination/workflow-coordinator.ts";
import {
	findWorkflowOwner,
	requireWorkflowOwner,
} from "../src/presentation/agent-selector-projection.ts";

function live(agentId: string, directSpawnerAgentId: string | null = "owner"): AgentRosterStatus {
	return {
		agentId,
		workflowId: "owner",
		label: agentId,
		directSpawnerAgentId,
		primaryEvidence: { transcriptPath: null, inspectedThrough: { agentId, entryId: `entry-${agentId}` } },
		run: { phase: "live", work: "settled", attention: "none", retentionReasons: [] },
		model: { provider: "test", modelId: "model" },
		thinking: "off",
		compacting: false,
		queuedInputCount: 0,
	};
}

function dormant(agentId: string, directSpawnerAgentId: string | null = "owner"): AgentRosterStatus {
	return { ...live(agentId, directSpawnerAgentId), run: { phase: "dormant", retentionReasons: [] } };
}

test("the Owner is the roster Agent whose Agent ID is its Workflow ID, live or Dormant", () => {
	const rows: [string, { live: AgentRosterStatus[]; dormant: AgentRosterStatus[] }, string | undefined][] = [
		["live Owner", { live: [live("worker"), live("owner", null)], dormant: [] }, "owner"],
		["Dormant Owner", { live: [live("worker")], dormant: [dormant("owner", null)] }, "owner"],
		["a root Moderator is not the Owner", { live: [live("moderator", null)], dormant: [] }, undefined],
	];
	for (const [scenario, roster, ownerId] of rows) {
		assert.equal(findWorkflowOwner(roster)?.agentId, ownerId, scenario);
		if (ownerId) assert.equal(requireWorkflowOwner(roster).agentId, ownerId, scenario);
		else assert.throws(() => requireWorkflowOwner(roster), /Agent selector roster has no Owner/, scenario);
	}
});
