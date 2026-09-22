// No clickable repair rows: pre-commit shows Moderator only, pending is greyed
// non-selectable, commit auto-admits under trigger authority with no click.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface } from "../src/presentation/agent-selector-surface.ts";
import {
  createAgentSelectionSession,
  createAgentSelectorSnapshot,
  filterRepairModeratorSelectorSnapshot,
} from "../src/process-runtime/remote-agent-selector.ts";
import { buildRepairedOwnerEntry } from "../src/coordination/manual-repair.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";
import { preadmissionRepairJournalDir, preadmissionRepairBackupRoot } from "../src/coordination/preadmission-repair.ts";

function rosterStatus(agentId: string, workflowId: string, phase: string) {
  return {
    agentId, workflowId,
    label: agentId === workflowId ? "Owner" : "Moderator",
    description: agentId === workflowId ? "Workflow Owner" : "Repair Moderator",
    directSpawnerAgentId: agentId === workflowId ? null : workflowId,
    primaryEvidence: { transcriptPath: null, inspectedThrough: { agentId, entryId: "tail" } },
    run: phase === "live"
      ? { phase: "live", work: "active", attention: "none", retentionReasons: [] }
      : { phase: "dormant" },
    model: { provider: "steady-provider", modelId: "v1" },
    thinking: "off", compacting: false, queuedInputCount: 0,
  } as never;
}

function plainTheme() {
  return {
    fg: (_c: string, t: string) => t,
    bg: (_b: string, t: string) => t,
    bold: (t: string) => t,
    getBgAnsi: (_b: string) => "",
  } as never;
}

function selectorHarness() {
  let component: any;
  const ui = {
    custom: (factory: any) => new Promise((resolve) => {
      component = factory(
        { terminal: { rows: 30, columns: 80 }, requestRender: () => undefined } as never,
        plainTheme(), {} as never, resolve,
      );
    }),
    notify: () => undefined,
  } as never;
  return { ui, getComponent: () => component };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const ESC = String.fromCharCode(27);

async function makeChild(ownerMgr: any, workflowDir: string, identity: any, tag: string) {
  const toolId = "spawn-npc-" + tag;
  const entryId = ownerMgr.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: tag, request: "Work", label: tag }, { id: toolId })));
  const child = SessionManager.create(ownerMgr.getSessionDir(), workflowDir);
  child.appendCustomEntry("agent-coordination.identity", {
    agentId: child.getSessionId(), workflowId: identity.workflowId,
    directSpawnerAgentId: identity.agentId, creationPreset: null,
    spawnSource: { agentId: identity.agentId, entryId, toolCallId: toolId },
    metadata: { label: tag },
  });
  child.appendMessage(fauxAssistantMessage("Persist " + tag));
}

async function repairedMap(snapshot: { entries: readonly { source: string }[] }, note: string): Promise<Record<string, string>> {
  const scratch = await mkdtemp(join(tmpdir(), "repair-npc-"));
  const out: Record<string, string> = {};
  for (const entry of snapshot.entries) {
    const rp = join(scratch, basename(entry.source) + ".repaired.jsonl");
    await copyFile(entry.source, rp);
    SessionManager.open(rp).appendMessage(fauxAssistantMessage(note));
    out[entry.source] = rp;
  }
  return out;
}

test("pre-commit menu has zero Owner rows on every surface", async (t) => {
  for (const shape of ["admitted", "preadmission"] as const) {
    let owner: any;
    const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), { persistent: true, processVisibleModel: true, implicitModeratorResponses: false });
    const identity = adoptOrValidateOwnerIdentity(host.runtime);
    const coordinator = shape === "admitted"
      ? await createTestWorkflowCoordinator(host, identity, { entryModulePath: "<inline:pi-durable-subagents>" })
      : new WorkflowCoordinator(host.runtime, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
    t.after(() => coordinator.shutdown(async () => undefined).catch(() => undefined));
    if (shape === "preadmission") await coordinator.initializePreadmissionRepair();
    owner = coordinator.forAgent(identity.agentId);
    await bindTestOwnerHost(host, "tui");
    const workflowDir = workflowSessionDirectory(host.session.sessionManager.getSessionDir(), identity.workflowId);
    await makeChild(host.session.sessionManager, workflowDir, identity, shape + "-pre");
    host.model.setResponses([() => fauxAssistantMessage("Repair triage holding.")]);
    const receipt = await owner.requestManualRepair("npc pre-commit " + shape);
    assert.equal(receipt.disposition, "created");
    assert.equal(owner.repairedOwnerEntry(), undefined);
    const roster = owner.selectionRoster();
    assert.ok(![...roster.live, ...roster.dormant].some((s: any) => s.agentId === s.workflowId), shape + ": roster must have zero Owner rows pre-commit");
    assert.ok([...roster.live, ...roster.dormant].some((s: any) => s.agentId === receipt.moderatorAgentId), shape + ": roster must show the Moderator");
    const snap = createAgentSelectorSnapshot(owner, owner.status().agentId);
    assert.ok(![...snap.live, ...snap.dormant].some((s: any) => s.agentId === s.workflowId), shape + ": snapshot must have zero Owner rows");
    assert.equal((snap as any).repairedOwner, undefined);
    const harness = selectorHarness();
    const prepareCalls: unknown[] = [];
    const errors: unknown[] = [];
    const selection = openAgentSelectorSurface(harness.ui, {
      live: [...snap.live], dormant: [...snap.dormant], selectedAgentId: receipt.moderatorAgentId,
      repairedOwner: undefined,
      prepareSelection: (a: unknown) => { prepareCalls.push(a); },
      onSelectionError: (e: unknown) => { errors.push(e); },
    });
    await tick(); await tick();
    assert.ok(harness.getComponent(), shape + ": selector must open pre-commit");
    harness.getComponent().handleInput("o");
    await tick(); await tick();
    assert.deepEqual(prepareCalls, []);
    assert.deepEqual(errors, []);
    harness.getComponent().handleInput(ESC);
    assert.equal(await selection, undefined);
    for (const phase of ["live", "dormant"] as const) {
      const original: any = {
        live: phase === "live" ? [rosterStatus("mod-" + shape, "owner-" + shape, "live")] : [],
        dormant: phase === "live" ? [] : [rosterStatus("mod-" + shape, "owner-" + shape, "dormant")],
        selectedAgentId: "mod-" + shape, humanAttention: [], operationalAttention: [], reports: [],
      };
      const filtered = filterRepairModeratorSelectorSnapshot(original, "mod-" + shape);
      const h2 = selectorHarness();
      const sel2 = openAgentSelectorSurface(h2.ui, filtered);
      void sel2.catch(() => undefined);
      await tick(); await tick();
      assert.ok(h2.getComponent(), shape + "/" + phase + ": filtered menu must open");
      h2.getComponent().handleInput(ESC);
      assert.equal(await sel2, undefined);
    }
    await coordinator.shutdown(async () => host.runtime.dispose());
  }
});

test("pending row is not selectable (no admit path reachable from selection)", async () => {
  const ownerId = "owner-npc-pending";
  const moderatorId = "moderator-npc-pending";
  const pending = buildRepairedOwnerEntry({ ownerId, workflowId: ownerId, transcriptPath: "/tmp/repaired-owner.jsonl", stage: "admission-pending" });
  const harness = selectorHarness();
  const prepareCalls: unknown[] = [];
  const errors: unknown[] = [];
  const selection = openAgentSelectorSurface(harness.ui, {
    live: [rosterStatus(moderatorId, ownerId, "live")], dormant: [], selectedAgentId: moderatorId,
    repairedOwner: pending,
    prepareSelection: (a: unknown) => { prepareCalls.push(a); },
    onSelectionError: (e: unknown) => { errors.push(e); },
  });
  await tick(); await tick();
  assert.ok(harness.getComponent());
  harness.getComponent().handleInput("o");
  await tick(); await tick();
  assert.deepEqual(prepareCalls, []);
  assert.deepEqual(errors, []);
  harness.getComponent().handleInput(ESC);
  assert.equal(await selection, undefined);
  let admitCalled = false;
  let routed = false;
  const fakeView: any = {
    status: () => ({ agentId: moderatorId }),
    repairedOwnerEntry: () => pending,
    admitRepairedOwner: async () => { admitCalled = true; return { ownerId }; },
    openAgentPresentation: async () => { routed = true; throw new Error("pending must not route"); },
    humanAttention: () => [],
  };
  const session = createAgentSelectionSession(fakeView, moderatorId);
  await session.prepare({ kind: "select_agent", agentId: ownerId });
  assert.equal(admitCalled, false);
  assert.equal(routed, false);
});

async function commitAutoAdmits(t: any, shape: "admitted" | "preadmission") {
  let owner: any;
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), { persistent: true, processVisibleModel: true, implicitModeratorResponses: false });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  const coordinator = shape === "admitted"
    ? await createTestWorkflowCoordinator(host, identity, { entryModulePath: "<inline:pi-durable-subagents>" })
    : new WorkflowCoordinator(host.runtime, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
  t.after(() => coordinator.shutdown(async () => undefined).catch(() => undefined));
  if (shape === "preadmission") await coordinator.initializePreadmissionRepair();
  owner = coordinator.forAgent(identity.agentId);
  await bindTestOwnerHost(host, "tui");
  const workflowDir = workflowSessionDirectory(host.session.sessionManager.getSessionDir(), identity.workflowId);
  await makeChild(host.session.sessionManager, workflowDir, identity, shape + "-commit");
  host.model.setResponses([() => fauxAssistantMessage("Repair triage holding.")]);
  const receipt = await owner.requestManualRepair("npc commit " + shape);
  const moderatorBefore = (coordinator.forModerator(receipt.moderatorAgentId) as any).status();
  const snapshot = await owner.freezeRepairSnapshot();
  assert.ok(snapshot.entries.length >= 1);
  const repairedBySource = await repairedMap(snapshot, "Repaired note " + shape + ".");
  const result: any = await owner.commitRepairReplace(repairedBySource, "attempt-npc-" + shape);
  assert.equal(result.disposition, "committed");
  assert.equal(owner.repairedOwnerEntry(), undefined);
  const roster = owner.selectionRoster();
  const liveOwner = [...roster.live, ...roster.dormant].find((s: any) => s.agentId === s.workflowId);
  assert.ok(liveOwner, shape + ": roster must show live Owner post-admission");
  assert.equal(liveOwner.agentId, identity.agentId);
  const snap = createAgentSelectorSnapshot(owner, owner.status().agentId);
  assert.equal((snap as any).repairedOwner, undefined);
  assert.ok([...snap.live, ...snap.dormant].some((s: any) => s.agentId === identity.agentId && s.agentId === s.workflowId));
  await assert.rejects(owner.beginExecution(), /idle_until_human_message/);
  const moderatorAfter = (coordinator.forModerator(receipt.moderatorAgentId) as any).status();
  assert.equal(moderatorAfter.agentId, moderatorBefore.agentId);
  assert.ok(moderatorAfter.run.phase === "live" || moderatorAfter.run.phase === "starting", shape + ": Moderator run undisturbed, got " + moderatorAfter.run.phase);
  const joined = await owner.requestManualRepair("npc second trigger " + shape);
  assert.deepEqual(joined, { disposition: "joined", moderatorAgentId: receipt.moderatorAgentId });
  await owner.resumeFromHuman("human takes over after repair", undefined);
  await owner.beginExecution();
  await coordinator.shutdown(async () => host.runtime.dispose());
}

test("commit success yields live-idle Owner with no click (admitted)", async (t) => {
  await commitAutoAdmits(t, "admitted");
});

test("commit success yields live-idle Owner with no click (preadmission)", async (t) => {
  await commitAutoAdmits(t, "preadmission");
});

test("commit-admission failure keeps data plus journal with truthful error", async (t) => {
  let owner: any;
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), { persistent: true, processVisibleModel: true, implicitModeratorResponses: false });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  const coordinator = new WorkflowCoordinator(host.runtime, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
  t.after(() => coordinator.shutdown(async () => undefined).catch(() => undefined));
  await coordinator.initializePreadmissionRepair();
  owner = coordinator.forAgent(identity.agentId);
  await bindTestOwnerHost(host, "tui");
  const sessionDir = host.session.sessionManager.getSessionDir();
  const workflowDir = workflowSessionDirectory(sessionDir, identity.workflowId);
  await makeChild(host.session.sessionManager, workflowDir, identity, "fail");
  host.model.setResponses([() => fauxAssistantMessage("Repair triage holding.")]);
  await owner.requestManualRepair("npc failure triage");
  const snapshot = await owner.freezeRepairSnapshot();
  assert.ok(snapshot.entries.length >= 1);
  const foreignRoot = await mkdtemp(join(tmpdir(), "repair-npc-foreign-"));
  const foreign = SessionManager.create(foreignRoot, foreignRoot);
  const foreignWorkflowId = foreign.getSessionId();
  foreign.appendCustomEntry("agent-coordination.identity", { agentId: foreign.getSessionId(), workflowId: foreignWorkflowId, directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } });
  foreign.appendMessage(fauxAssistantMessage("Foreign Owner session."));
  const foreignPath = foreign.getSessionFile() as string;
  const ownerSource = snapshot.entries.find((e: any) => e.source === (host.session.sessionManager.getSessionFile() as string))?.source ?? (snapshot.entries[0] as any).source;
  const repairedBySource: Record<string, string> = {};
  for (const entry of snapshot.entries as any[]) {
    if (entry.source === ownerSource) {
      repairedBySource[entry.source] = foreignPath;
    } else {
      const rp = join(await mkdtemp(join(tmpdir(), "repair-npc-fail-")), basename(entry.source) + ".repaired.jsonl");
      await copyFile(entry.source, rp);
      SessionManager.open(rp).appendMessage(fauxAssistantMessage("Repaired note."));
      repairedBySource[entry.source] = rp;
    }
  }
  const result: any = await owner.commitRepairReplace(repairedBySource, "attempt-npc-fail-1");
  assert.equal(result.disposition, "committed-admission-failed");
  assert.ok(typeof result.admissionError === "string" && result.admissionError.length > 0, "truthful admission error, got: " + JSON.stringify(result));
  assert.ok(result.admissionError.includes("evidence_unavailable"), "truthful identity error, got: " + result.admissionError);
  const journalDir = preadmissionRepairJournalDir(workflowDir);
  const backupRoot = preadmissionRepairBackupRoot(workflowDir);
  const journals = await readdir(journalDir);
  assert.ok(journals.some((n: string) => n.includes("repair-journal-attempt-npc-fail-1")));
  assert.ok(journals.some((n: string) => n.includes("repair-generation.json")));
  assert.ok((await readdir(backupRoot)).length >= 1);
  const pending = owner.repairedOwnerEntry();
  assert.ok(pending);
  assert.equal(pending.stage, "admission-pending");
  const snap = createAgentSelectorSnapshot(owner, owner.status().agentId);
  assert.equal((snap as any).repairedOwner?.stage, "admission-pending");
  const harness = selectorHarness();
  const selection = openAgentSelectorSurface(harness.ui, {
    live: [...(snap as any).live], dormant: [...(snap as any).dormant], selectedAgentId: owner.status().agentId,
    repairedOwner: (snap as any).repairedOwner,
  });
  await tick(); await tick();
  assert.ok(harness.getComponent(), "menu must open after admission failure");
  harness.getComponent().handleInput("o");
  harness.getComponent().handleInput(ESC);
  assert.equal(await selection, undefined);
  await assert.rejects(owner.beginExecution(), /idle_until_human_message/);
  await coordinator.shutdown(async () => host.runtime.dispose());
});

test("full switch sequence (repair -> Moderator -> Dormant -> /agents opens)", async (t) => {
  let owner: any;
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), { persistent: true, processVisibleModel: true, implicitModeratorResponses: false });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  const coordinator = await createTestWorkflowCoordinator(host, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
  owner = coordinator.forAgent(identity.agentId);
  await bindTestOwnerHost(host, "tui");
  const workflowDir = workflowSessionDirectory(host.session.sessionManager.getSessionDir(), identity.workflowId);
  await makeChild(host.session.sessionManager, workflowDir, identity, "switch");
  host.model.setResponses([() => fauxAssistantMessage("Repair triage holding.")]);
  const receipt = await owner.requestManualRepair("npc switch triage");
  assert.equal(owner.repairedOwnerEntry(), undefined);
  const preSnap = createAgentSelectorSnapshot(owner, owner.status().agentId);
  assert.ok(![...preSnap.live, ...preSnap.dormant].some((s: any) => s.agentId === s.workflowId));
  const hPre = selectorHarness();
  const selPre = openAgentSelectorSurface(hPre.ui, { live: [...preSnap.live], dormant: [...preSnap.dormant], selectedAgentId: receipt.moderatorAgentId });
  await tick(); await tick();
  assert.ok(hPre.getComponent());
  hPre.getComponent().handleInput(ESC);
  assert.equal(await selPre, undefined);
  const modSel: any = await owner.openAgentPresentation(receipt.moderatorAgentId);
  assert.equal(modSel.kind, "selected");
  const snapshot = await owner.freezeRepairSnapshot();
  const repairedBySource = await repairedMap(snapshot, "Repaired note switch.");
  const result: any = await owner.commitRepairReplace(repairedBySource, "attempt-npc-switch-1");
  assert.equal(result.disposition, "committed");
  const dormantFiltered = filterRepairModeratorSelectorSnapshot({
    live: [],
    dormant: [rosterStatus(receipt.moderatorAgentId, identity.agentId, "dormant"), rosterStatus(identity.agentId, identity.agentId, "dormant")],
    selectedAgentId: receipt.moderatorAgentId, humanAttention: [], operationalAttention: [], reports: [],
  } as never, receipt.moderatorAgentId);
  const hDormant = selectorHarness();
  const selDormant = openAgentSelectorSurface(hDormant.ui, dormantFiltered);
  void selDormant.catch(() => undefined);
  await tick(); await tick();
  assert.ok(hDormant.getComponent(), "dormant Moderator menu must open");
  hDormant.getComponent().handleInput(ESC);
  assert.equal(await selDormant, undefined);
  const postSnap = createAgentSelectorSnapshot(owner, owner.status().agentId);
  assert.equal((postSnap as any).repairedOwner, undefined);
  assert.ok([...postSnap.live, ...postSnap.dormant].some((s: any) => s.agentId === identity.agentId && s.agentId === s.workflowId));
  const hPost = selectorHarness();
  const selPost = openAgentSelectorSurface(hPost.ui, { live: [...postSnap.live], dormant: [...postSnap.dormant], selectedAgentId: identity.agentId });
  await tick(); await tick();
  assert.ok(hPost.getComponent());
  hPost.getComponent().handleInput(ESC);
  assert.equal(await selPost, undefined);
  await coordinator.shutdown(async () => host.runtime.dispose());
});
