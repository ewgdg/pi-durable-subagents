import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface } from "../src/presentation/agent-selector-surface.ts";
import { buildRepairedOwnerEntry } from "../src/coordination/manual-repair.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";
import { preadmissionRepairJournalDir, preadmissionRepairBackupRoot } from "../src/coordination/preadmission-repair.ts";
function rosterStatus(agentId: string, workflowId: string, phase: string) {
 return { agentId, workflowId, label: agentId === workflowId ? "Owner" : "Moderator", description: agentId === workflowId ? "Workflow Owner" : "Repair Moderator", directSpawnerAgentId: agentId === workflowId ? null : workflowId, primaryEvidence: { transcriptPath: null, inspectedThrough: { agentId, entryId: "tail" } }, run: phase === "live" ? { phase: "live", work: "active", attention: "none", retentionReasons: [] } : { phase: "dormant" }, model: { provider: "steady-provider", modelId: "v1" }, thinking: "off", compacting: false, queuedInputCount: 0 } as never;
}
function plainTheme() {
 return { fg: (_c: string, t: string) => t, bg: (_b: string, t: string) => t, bold: (t: string) => t, getBgAnsi: (_b: string) => "" } as never;
}
function selectorHarness() {
 let component: any;
 let doneResolve: any;
 const ui = { custom: (factory: any) => new Promise((resolve) => { doneResolve = resolve; component = factory({ terminal: { rows: 30, columns: 80 }, requestRender: () => undefined } as never, plainTheme(), {} as never, resolve); }), notify: () => undefined } as never;
 return { ui, getComponent: () => component };
}
test("stale snapshot-only entry stays non-selectable (backend defense)", async () => {
 const moderatorId = "moderator-1";
 const ownerId = "owner-1";
 const repaired = buildRepairedOwnerEntry({ ownerId, workflowId: ownerId, transcriptPath: "/tmp/repaired-owner.jsonl", stage: "snapshot-only" });
 assert.equal(repaired.stage, "snapshot-only");
 const prepareCalls: unknown[] = [];
 const errors: unknown[] = [];
 const harness = selectorHarness();
 const ESC = String.fromCharCode(27);
 const selection = openAgentSelectorSurface(harness.ui, { live: [rosterStatus(moderatorId, ownerId, "live")], dormant: [], selectedAgentId: moderatorId, repairedOwner: repaired, prepareSelection: (action: unknown) => { prepareCalls.push(action); }, onSelectionError: (error: unknown) => { errors.push(error); } });
 await Promise.resolve();
 await Promise.resolve();
 const component = harness.getComponent();
 assert.ok(component);
 component.handleInput("o");
 await Promise.resolve();
 await Promise.resolve();
 assert.deepEqual(prepareCalls, []);
 assert.deepEqual(errors, []);
 component.handleInput(ESC);
 assert.equal(await selection, undefined);
});
test("selector opens post-commit admission-pending greyed and non-selectable", async () => {
 const moderatorId = "moderator-1";
 const ownerId = "owner-1";
 const repaired = buildRepairedOwnerEntry({ ownerId, workflowId: ownerId, transcriptPath: "/tmp/repaired-owner.jsonl", stage: "admission-pending" });
 assert.equal(repaired.stage, "admission-pending");
 const prepareCalls: unknown[] = [];
 const errors: unknown[] = [];
 const harness = selectorHarness();
 const ESC = String.fromCharCode(27);
 const selection = openAgentSelectorSurface(harness.ui, { live: [rosterStatus(moderatorId, ownerId, "live")], dormant: [], selectedAgentId: moderatorId, repairedOwner: repaired, prepareSelection: (action: unknown) => { prepareCalls.push(action); }, onSelectionError: (error: unknown) => { errors.push(error); } });
 await Promise.resolve();
 await Promise.resolve();
 const component = harness.getComponent();
 assert.ok(component);
 component.handleInput("o");
 await Promise.resolve();
 await Promise.resolve();
 assert.deepEqual(prepareCalls, []);
 assert.deepEqual(errors, []);
 component.handleInput(ESC);
 assert.equal(await selection, undefined);
});
test("commit auto-admits live-idle Owner with no click (preadmission)", async (t) => {
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
 const ownerMgr = host.session.sessionManager;
 const toolId = "spawn-return-admit-a";
 const entryId = ownerMgr.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "return-child", request: "Work", label: "return-child" }, { id: toolId })));
 const child = SessionManager.create(ownerMgr.getSessionDir(), workflowDir);
 child.appendCustomEntry("agent-coordination.identity", { agentId: child.getSessionId(), workflowId: identity.workflowId, directSpawnerAgentId: identity.agentId, creationPreset: null, spawnSource: { agentId: identity.agentId, entryId, toolCallId: toolId }, metadata: { label: "return-child" } });
 child.appendMessage(fauxAssistantMessage("Persist return-child"));
 host.model.setResponses([() => fauxAssistantMessage("Repair triage holding.")]);
 assert.equal(owner.repairedOwnerEntry(), undefined);
 const receipt = await owner.requestManualRepair("return admission triage");
 assert.equal(owner.repairedOwnerEntry(), undefined);
 assert.equal(receipt.disposition, "created");
 const snapshot = await owner.freezeRepairSnapshot();
 assert.ok(snapshot.entries.length >= 1);
 const scratch = await mkdtemp(join(tmpdir(), "repair-return-admit-"));
 const repairedBySource: Record<string, string> = {};
 for (const entry of snapshot.entries) {
 const rp = join(scratch, basename(entry.source) + ".repaired.jsonl");
 await copyFile(entry.source, rp);
 SessionManager.open(rp).appendMessage(fauxAssistantMessage("Repaired note."));
 repairedBySource[entry.source] = rp;
 }
 const drafts = { editor: "owner draft preserved" };
 const result = await owner.commitRepairReplace(repairedBySource, "attempt-return-1", drafts);
 assert.ok(result.disposition === "committed" || result.disposition === "joined-committed");
 // Commit auto-admits under trigger authority: no click, pending suppressed,
 // live Owner roster item with the idle hold and preserved drafts.
 assert.equal((result as any).idle.draftsPreserved, true);
 assert.deepEqual((result as any).idle.drafts, drafts);
 assert.equal(owner.repairedOwnerEntry(), undefined);
 const liveOwner = [...owner.selectionRoster().live, ...owner.selectionRoster().dormant].find((s: any) => s.agentId === s.workflowId);
 assert.ok(liveOwner);
 assert.equal(liveOwner.agentId, identity.agentId);
 await assert.rejects(owner.beginExecution(), /idle_until_human_message/);
 // Repeated manual admits stay fresh while idle (backend defense path).
 const fresh1: any = await owner.admitRepairedOwner(drafts);
 assert.equal(fresh1.ownerId, identity.agentId);
 assert.equal(fresh1.snapshot.agentId, identity.agentId);
 assert.equal(fresh1.idle.idleUntil, "human-message");
 assert.deepEqual(fresh1.idle.drafts, drafts);
 const fresh2: any = await owner.admitRepairedOwner(drafts);
 assert.ok(fresh2.freshMarker !== fresh1.freshMarker);
 assert.deepEqual(fresh2.snapshot, fresh1.snapshot);
 await assert.rejects(owner.beginExecution(), /idle_until_human_message/);
 await owner.resumeFromHuman("human takes over after repair", undefined);
 await owner.beginExecution();
 await coordinator.shutdown(async () => host.runtime.dispose());
});
test("post-admission tamper is detected on re-admit; data plus journal kept, menu still opens", async (t) => {
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
 const ownerMgr = host.session.sessionManager;
 const toolId = "spawn-return-fail-a";
 const entryId = ownerMgr.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "fail-child", request: "Work", label: "fail-child" }, { id: toolId })));
 const child = SessionManager.create(ownerMgr.getSessionDir(), workflowDir);
 child.appendCustomEntry("agent-coordination.identity", { agentId: child.getSessionId(), workflowId: identity.workflowId, directSpawnerAgentId: identity.agentId, creationPreset: null, spawnSource: { agentId: identity.agentId, entryId, toolCallId: toolId }, metadata: { label: "fail-child" } });
 child.appendMessage(fauxAssistantMessage("Persist fail-child"));
 host.model.setResponses([() => fauxAssistantMessage("Repair triage holding.")]);
 await owner.requestManualRepair("fail admission triage");
 const snapshot = await owner.freezeRepairSnapshot();
 const scratch = await mkdtemp(join(tmpdir(), "repair-return-fail-"));
 const repairedBySource: Record<string, string> = {};
 for (const entry of snapshot.entries) {
 const rp = join(scratch, basename(entry.source) + ".repaired.jsonl");
 await copyFile(entry.source, rp);
 SessionManager.open(rp).appendMessage(fauxAssistantMessage("Repaired note."));
 repairedBySource[entry.source] = rp;
 }
 const result = await owner.commitRepairReplace(repairedBySource, "attempt-fail-1");
 assert.ok(result.disposition === "committed" || result.disposition === "joined-committed");
 const journalDir = preadmissionRepairJournalDir(workflowDir);
 const backupRoot = preadmissionRepairBackupRoot(workflowDir);
 const journalFiles = await readdir(journalDir);
 assert.ok(journalFiles.some((n: string) => n.indexOf("repair-journal-attempt-fail-1") !== -1));
 assert.ok(journalFiles.some((n: string) => n.indexOf("repair-generation.json") !== -1));
 const backupEntries = await readdir(backupRoot);
 assert.ok(backupEntries.length >= 1);
 const backupDir = join(backupRoot, backupEntries[0] as string);
 assert.ok((await stat(backupDir)).isDirectory());
 const transcriptPath = ((result as any).files?.[0]?.source ?? owner.repairedOwnerEntry()?.transcriptPath) as string;
 assert.ok(transcriptPath);
 const corrupting = SessionManager.open(transcriptPath);
 corrupting.appendCustomEntry("agent-coordination.identity", { agentId: identity.agentId, workflowId: "different-workflow", directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } });
 let message = "";
 try {
 await owner.admitRepairedOwner();
 } catch (error) {
 message = error instanceof Error ? error.message : String(error);
 }
 assert.ok(message.indexOf("evidence_unavailable") !== -1);
 const journalAfter = await readdir(journalDir);
 assert.ok(journalAfter.some((n: string) => n.indexOf("repair-journal-attempt-fail-1") !== -1));
 assert.ok((await stat(backupDir)).isDirectory());
 // Auto-admission already succeeded at commit, so the entry stays suppressed
 // (prefer-live) even though a later re-admit fails on tampered bytes.
 assert.equal(owner.repairedOwnerEntry(), undefined);
 assert.ok(Array.isArray(owner.reportHistory()));
 const liveRoster = owner.selectionRoster();
 assert.ok([...liveRoster.live, ...liveRoster.dormant].some((s: any) => s.agentId === identity.agentId && s.agentId === s.workflowId));
 const harness = selectorHarness();
 const ESC2 = String.fromCharCode(27);
 const selection = openAgentSelectorSurface(harness.ui, { live: [...liveRoster.live], dormant: [...liveRoster.dormant], selectedAgentId: identity.agentId, reports: owner.reportHistory() });
 await Promise.resolve();
 await Promise.resolve();
 assert.ok(harness.getComponent());
 harness.getComponent().handleInput(ESC2);
 assert.equal(await selection, undefined);
 await coordinator.shutdown(async () => host.runtime.dispose());
});
