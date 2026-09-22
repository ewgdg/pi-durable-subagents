// Repro suite for repair-menu robustness. Each test names the symptom it pins:
// SYMPTOM1  the Owner shortcut (o) is impossible with a snapshot-only pending
//           Owner: the surface still prepares a selection and the prepare layer
//           throws instead of silently doing nothing.
// SYMPTOM2a a fresh repair trigger does not reset a committed attempt back to
//           snapshot-only.
// SYMPTOM2c the filtered repair-Moderator snapshot cannot open the selector
//           once the Owner has been admitted (no live Owner row, no repaired
//           entry).
import assert from "node:assert/strict";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { buildRepairedOwnerEntry } from "../src/coordination/manual-repair.ts";
import { openAgentSelectorSurface } from "../src/presentation/agent-selector-surface.ts";
import {
  createAgentSelectionSession,
  filterRepairModeratorSelectorSnapshot,
} from "../src/process-runtime/remote-agent-selector.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";

function rosterStatus(agentId: string, workflowId: string, phase: string) {
  return {
    agentId,
    workflowId,
    label: agentId === workflowId ? "Owner" : "Moderator",
    description: agentId === workflowId ? "Workflow Owner" : "Repair Moderator",
    directSpawnerAgentId: agentId === workflowId ? null : workflowId,
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

function plainTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_background: string, text: string) => text,
    bold: (text: string) => text,
    getBgAnsi: (_background: string) => "",
  } as never;
}

function selectorHarness() {
  let component: any;
  const ui = {
    custom: (factory: any) => new Promise((resolve) => {
      component = factory(
        { terminal: { rows: 30, columns: 80 }, requestRender: () => undefined } as never,
        plainTheme(),
        {} as never,
        resolve,
      );
    }),
    notify: () => undefined,
  } as never;
  return { ui, getComponent: () => component };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const ESCAPE_INPUT = String.fromCharCode(27);

test("SYMPTOM1: the Owner shortcut stays silent for a snapshot-only pending Owner", async () => {
  const ownerId = "owner-menu-shortcut";
  const moderatorId = "moderator-menu-shortcut";
  const repaired = buildRepairedOwnerEntry({
    ownerId,
    workflowId: ownerId,
    transcriptPath: "/tmp/repaired-owner.jsonl",
    stage: "snapshot-only",
  });
  assert.equal(repaired.stage, "snapshot-only");
  const prepareCalls: unknown[] = [];
  const errors: unknown[] = [];
  const harness = selectorHarness();
  const selection = openAgentSelectorSurface(harness.ui, {
    live: [rosterStatus(moderatorId, ownerId, "live")],
    dormant: [],
    selectedAgentId: moderatorId,
    repairedOwner: repaired,
    prepareSelection: (action: unknown) => { prepareCalls.push(action); },
    onSelectionError: (error: unknown) => { errors.push(error); },
  });
  await tick();
  const component = harness.getComponent();
  assert.ok(component, "selector must open with a snapshot-only pending Owner entry");
  component.handleInput("o");
  await tick();
  await tick();
  assert.deepEqual(prepareCalls, [], "a disabled snapshot-only Owner must not prepare a selection");
  assert.deepEqual(errors, [], "a disabled snapshot-only Owner must not surface an error");
  component.handleInput(ESCAPE_INPUT);
  assert.equal(await selection, undefined, "Esc must close the selector");
});

test("SYMPTOM1: prepare is a silent no-op for a snapshot-only repaired Owner", async () => {
  const ownerId = "owner-menu-prepare";
  const moderatorId = "moderator-menu-prepare";
  const snapshotOnly = buildRepairedOwnerEntry({
    ownerId,
    workflowId: ownerId,
    transcriptPath: "/tmp/repaired-owner.jsonl",
    stage: "snapshot-only",
  });
  let admitCalled = false;
  let routed = false;
  const fakeView: any = {
    status: () => rosterStatus(moderatorId, ownerId, "live"),
    repairedOwnerEntry: () => snapshotOnly,
    admitRepairedOwner: async () => { admitCalled = true; },
    openAgentPresentation: async () => {
      routed = true;
      throw new Error("snapshot-only must never route to a live presentation");
    },
    humanAttention: () => [],
  };
  const session = createAgentSelectionSession(fakeView, moderatorId);
  await session.prepare({ kind: "select_agent", agentId: ownerId });
  assert.equal(admitCalled, false, "snapshot-only must not admit");
  assert.equal(routed, false, "snapshot-only must not route to a live presentation");
});

test("SYMPTOM2a: pre-commit has no Owner entry and commit auto-admits (no snapshot-only, ever)", async (t) => {
  let owner: any;
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), { persistent: true, processVisibleModel: true, implicitModeratorResponses: false });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  const coordinator = new WorkflowCoordinator(host.runtime, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
  t.after(() => coordinator.shutdown(async () => undefined).catch(() => undefined));
  await coordinator.initializePreadmissionRepair();
  owner = coordinator.forAgent(identity.agentId);
  await bindTestOwnerHost(host, "tui");
  const ownerMgr = host.session.sessionManager;
  const workflowDir = workflowSessionDirectory(ownerMgr.getSessionDir(), identity.workflowId);
  const toolId = "spawn-robust-stage-a";
  const entryId = ownerMgr.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "stage-child", request: "Work", label: "stage-child" }, { id: toolId })));
  const child = SessionManager.create(ownerMgr.getSessionDir(), workflowDir);
  child.appendCustomEntry("agent-coordination.identity", { agentId: child.getSessionId(), workflowId: identity.workflowId, directSpawnerAgentId: identity.agentId, creationPreset: null, spawnSource: { agentId: identity.agentId, entryId, toolCallId: toolId }, metadata: { label: "stage-child" } });
  child.appendMessage(fauxAssistantMessage("Persist stage-child"));
  host.model.setResponses([
    () => fauxAssistantMessage("Repair triage holding."),
  ]);
  const first = await owner.requestManualRepair("robust stage first");
  assert.equal(first.disposition, "created");
  assert.equal(owner.repairedOwnerEntry(), undefined);
  // Fast stale-hold repro: a previous commit idle hold persisting across a fresh
  // trigger (both idleHold and trigger set) must stay without an entry, not pending.
  await owner.adoptRepairedOwnerIdleHold();
  assert.equal(owner.repairedOwnerEntry(), undefined);
  const snapshot = await owner.freezeRepairSnapshot();
  assert.ok(snapshot.entries.length >= 1);
  const scratch = await mkdtemp(join(tmpdir(), "repair-robust-stage-"));
  const repairedBySource: Record<string, string> = {};
  for (const entry of snapshot.entries) {
    const repairedPath = join(scratch, basename(entry.source) + ".repaired.jsonl");
    await copyFile(entry.source, repairedPath);
    SessionManager.open(repairedPath).appendMessage(fauxAssistantMessage("Repaired note."));
    repairedBySource[entry.source] = repairedPath;
  }
  const committed = await owner.commitRepairReplace(repairedBySource, "robust-stage-1");
  assert.ok(committed.disposition === "committed" || committed.disposition === "joined-committed");
  // Commit auto-admits under trigger authority: pending is suppressed, live Owner shows.
  assert.equal(owner.repairedOwnerEntry(), undefined);
  assert.ok([...owner.selectionRoster().live, ...owner.selectionRoster().dormant].some((s: any) => s.agentId === s.workflowId));
  await coordinator.shutdown(async () => host.runtime.dispose());
});

test("SYMPTOM2c: the filtered repair-Moderator snapshot still opens the selector", async () => {
  const ownerId = "owner-menu-filter";
  const moderatorId = "moderator-menu-filter";
  const openFiltered = async (moderatorPhase: string) => {
    const original = {
      live: moderatorPhase === "live"
        ? [rosterStatus(moderatorId, ownerId, "live"), rosterStatus(ownerId, ownerId, "live")]
        : [],
      dormant: moderatorPhase === "live"
        ? []
        : [rosterStatus(moderatorId, ownerId, "dormant"), rosterStatus(ownerId, ownerId, "dormant")],
      selectedAgentId: ownerId,
      humanAttention: [],
      operationalAttention: [],
      reports: [],
    };
    const filtered = filterRepairModeratorSelectorSnapshot(original as never, moderatorId);
    const harness = selectorHarness();
    const selection = openAgentSelectorSurface(harness.ui, filtered);
    // A construction failure is reported by the component assertion below.
    void selection.catch(() => undefined);
    await tick();
    await tick();
    const component = harness.getComponent();
    assert.ok(component, "filtered " + moderatorPhase + " repair Moderator snapshot must open the selector");
    component.handleInput(ESCAPE_INPUT);
    assert.equal(await selection, undefined, "Esc must close the selector");
  };
  await openFiltered("live");
  await openFiltered("dormant");
});

test("post-commit admit still works and keeps the idle-until-human-message hold", async (t) => {
  let owner: any;
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), { persistent: true, processVisibleModel: true, implicitModeratorResponses: false });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  const coordinator = new WorkflowCoordinator(host.runtime, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
  t.after(() => coordinator.shutdown(async () => undefined).catch(() => undefined));
  await coordinator.initializePreadmissionRepair();
  owner = coordinator.forAgent(identity.agentId);
  await bindTestOwnerHost(host, "tui");
  const ownerMgr = host.session.sessionManager;
  const workflowDir = workflowSessionDirectory(ownerMgr.getSessionDir(), identity.workflowId);
  const toolId = "spawn-robust-admit-a";
  const entryId = ownerMgr.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "admit-child", request: "Work", label: "admit-child" }, { id: toolId })));
  const child = SessionManager.create(ownerMgr.getSessionDir(), workflowDir);
  child.appendCustomEntry("agent-coordination.identity", { agentId: child.getSessionId(), workflowId: identity.workflowId, directSpawnerAgentId: identity.agentId, creationPreset: null, spawnSource: { agentId: identity.agentId, entryId, toolCallId: toolId }, metadata: { label: "admit-child" } });
  child.appendMessage(fauxAssistantMessage("Persist admit-child"));
  host.model.setResponses([
    () => fauxAssistantMessage("Repair triage holding."),
    () => fauxAssistantMessage("Repair triage holding."),
  ]);
  const receipt = await owner.requestManualRepair("robust admit triage");
  assert.equal(receipt.disposition, "created");
  const snapshot = await owner.freezeRepairSnapshot();
  assert.ok(snapshot.entries.length >= 1);
  const scratch = await mkdtemp(join(tmpdir(), "repair-robust-admit-"));
  const repairedBySource: Record<string, string> = {};
  for (const entry of snapshot.entries) {
    const repairedPath = join(scratch, basename(entry.source) + ".repaired.jsonl");
    await copyFile(entry.source, repairedPath);
    SessionManager.open(repairedPath).appendMessage(fauxAssistantMessage("Repaired note."));
    repairedBySource[entry.source] = repairedPath;
  }
  const committed = await owner.commitRepairReplace(repairedBySource, "robust-stage-2");
  assert.ok(committed.disposition === "committed" || committed.disposition === "joined-committed");
  const admitted = await owner.admitRepairedOwner();
  assert.equal(admitted.ownerId, identity.agentId);
  assert.equal(admitted.snapshot.agentId, identity.agentId);
  assert.equal(admitted.idle.idle, true);
  assert.equal(admitted.idle.idleUntil, "human-message");
  await assert.rejects(owner.beginExecution(), /idle_until_human_message/);
  await coordinator.shutdown(async () => host.runtime.dispose());
});

