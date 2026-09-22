// Repair scope with prefer-live: while a repaired entry is present the switcher
// hides the broken Owner and other agents (Moderator only); once the entry is
// suppressed post-admission the live/dormant Owner returns so the menu opens.
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

test("repair filter keeps only the repair Moderator while repaired entry present", () => {
  const pending = { ...fullSnapshot(), repairedOwner: { ownerId: "owner-1", workflowId: "owner-1", stage: "admission-pending", label: "Owner" } } as unknown as RemoteAgentSelectorSnapshot;
  const filtered = filterRepairModeratorSelectorSnapshot(pending, "moderator-1");
  assert.deepEqual(
    [...filtered.live.map((status: { agentId: string }) => status.agentId), ...filtered.dormant.map((status: { agentId: string }) => status.agentId)],
    ["moderator-1"],
  );
  assert.equal(filtered.selectedAgentId, "moderator-1");
});

test("repair filter prefers live Owner once repaired entry suppressed", () => {
  const filtered = filterRepairModeratorSelectorSnapshot(fullSnapshot(), "moderator-1");
  assert.deepEqual(
    [...filtered.live.map((status: { agentId: string }) => status.agentId), ...filtered.dormant.map((status: { agentId: string }) => status.agentId)],
    ["moderator-1", "owner-1"],
  );
  assert.equal(filtered.selectedAgentId, "moderator-1");
  // Other agents stay hidden.
  assert.ok(![...filtered.live, ...filtered.dormant].some((status: { agentId: string }) => status.agentId === "child-1"));
});

test("presentation boundary serves the filtered snapshot to the repair Moderator", async () => {
  const handlers = createOwnerAgentPresentationHandlers(stubView, "moderator-1", undefined, {
    repairModeratorAgentId: "moderator-1",
  });
  const snapshot = await handlers.snapshot();
  const visible = [...snapshot.live, ...snapshot.dormant].map((status: { agentId: string }) => status.agentId);
  // No repaired entry in the stub: prefer-live includes the Owner so the menu opens.
  assert.deepEqual(visible, ["moderator-1", "owner-1"]);
});

test("presentation boundary without repair context still serves the full roster", async () => {
  const handlers = createOwnerAgentPresentationHandlers(stubView, "owner-1");
  const snapshot = await handlers.snapshot();
  const visible = [...snapshot.live, ...snapshot.dormant].map((status: { agentId: string }) => status.agentId);
  assert.deepEqual(visible, ["owner-1", "moderator-1", "child-1"]);
});
