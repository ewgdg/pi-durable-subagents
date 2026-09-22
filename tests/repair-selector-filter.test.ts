// Item 3: the /agents switcher stays available in repair context but hides the
// broken Owner and every other agent. Red test: the selector snapshot served
// to the repair Moderator contains exactly itself.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createOwnerAgentPresentationHandlers,
  filterRepairModeratorSelectorSnapshot,
} from "../src/process-runtime/remote-agent-selector.ts";
import type { RemoteAgentSelectorSnapshot } from "../src/control/agent-control-protocol.ts";
import type { HumanPresentationCoordinatorView } from "../src/coordination/workflow-coordinator.ts";

function rosterStatus(agentId: string, phase: "live" | "dormant" = "live") {
  return {
    agentId,
    workflowId: "owner-1",
    label: agentId === "moderator-1" ? "Moderator" : agentId,
    directSpawnerAgentId: agentId === "owner-1" ? null : "owner-1",
    primaryEvidence: { transcriptPath: null, inspectedThrough: { agentId, entryId: "tail" } },
    run: phase === "live"
      ? { phase: "live", work: "active", attention: "none", retentionReasons: [] }
      : { phase: "dormant" },
    model: { provider: "steady-provider", modelId: "v1" },
    thinking: "off",
    compacting: false,
    queuedInputCount: 0,
  } as never;
}

function fullSnapshot(): RemoteAgentSelectorSnapshot {
  return {
    live: [rosterStatus("owner-1"), rosterStatus("moderator-1")],
    dormant: [rosterStatus("child-1", "dormant")],
    selectedAgentId: "owner-1",
    humanAttention: [],
    operationalAttention: [],
    reports: [],
  };
}

function stubView(): HumanPresentationCoordinatorView {
  return {
    status: () => rosterStatus("moderator-1"),
    selectionRoster: () => ({ live: fullSnapshot().live, dormant: fullSnapshot().dormant }),
    humanAttention: () => [],
    operationalAttention: () => [],
    reportHistory: () => [],
  } as unknown as HumanPresentationCoordinatorView;
}

test("repair filter keeps only the repair Moderator", () => {
  const filtered = filterRepairModeratorSelectorSnapshot(fullSnapshot(), "moderator-1");
  assert.deepEqual(
    [...filtered.live.map((status: { agentId: string }) => status.agentId), ...filtered.dormant.map((status: { agentId: string }) => status.agentId)],
    ["moderator-1"],
  );
  assert.equal(filtered.selectedAgentId, "moderator-1");
});

test("presentation boundary serves the filtered snapshot to the repair Moderator", async () => {
  const handlers = createOwnerAgentPresentationHandlers(stubView, "moderator-1", undefined, {
    repairModeratorAgentId: "moderator-1",
  });
  const snapshot = await handlers.snapshot();
  const visible = [...snapshot.live, ...snapshot.dormant].map((status: { agentId: string }) => status.agentId);
  assert.deepEqual(visible, ["moderator-1"]);
});

test("presentation boundary without repair context still serves the full roster", async () => {
  const handlers = createOwnerAgentPresentationHandlers(stubView, "owner-1");
  const snapshot = await handlers.snapshot();
  const visible = [...snapshot.live, ...snapshot.dormant].map((status: { agentId: string }) => status.agentId);
  assert.deepEqual(visible, ["owner-1", "moderator-1", "child-1"]);
});
