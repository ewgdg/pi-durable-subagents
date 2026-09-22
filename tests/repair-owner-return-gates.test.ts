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
import { createAgentSelectionSession } from "../src/process-runtime/remote-agent-selector.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";
test("post-commit Moderator navigation admits without trigger binding", async (t) => {
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
 const toolId = "spawn-gate-admit-a";
 const entryId = ownerMgr.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "gate-child", request: "Work", label: "gate-child" }, { id: toolId })));
 const child = SessionManager.create(ownerMgr.getSessionDir(), workflowDir);
 child.appendCustomEntry("agent-coordination.identity", { agentId: child.getSessionId(), workflowId: identity.workflowId, directSpawnerAgentId: identity.agentId, creationPreset: null, spawnSource: { agentId: identity.agentId, entryId, toolCallId: toolId }, metadata: { label: "gate-child" } });
 child.appendMessage(fauxAssistantMessage("Persist gate-child"));
 host.model.setResponses([() => fauxAssistantMessage("Repair triage holding.")]);
 const receipt = await owner.requestManualRepair("gate admission triage");
 assert.equal(receipt.disposition, "created");
 const moderatorId = receipt.moderatorAgentId as string;
 const snapshot = await owner.freezeRepairSnapshot();
 assert.ok(snapshot.entries.length >= 1);
 const scratch = await mkdtemp(join(tmpdir(), "repair-gate-admit-"));
 const repairedBySource: Record<string, string> = {};
 for (const entry of snapshot.entries) {
 const rp = join(scratch, basename(entry.source) + ".repaired.jsonl");
 await copyFile(entry.source, rp);
 SessionManager.open(rp).appendMessage(fauxAssistantMessage("Repaired note."));
 repairedBySource[entry.source] = rp;
 }
 const drafts = { editor: "gate draft preserved" };
 const result = await owner.commitRepairReplace(repairedBySource, "attempt-gate-1", drafts);
 assert.ok(result.disposition === "committed" || result.disposition === "joined-committed");
 const postEntry = owner.repairedOwnerEntry();
 assert.ok(postEntry);
 assert.equal(postEntry.stage, "admission-pending");
 const modView = coordinator.forModerator(moderatorId) as any;
 const admitted = await modView.admitRepairedOwner();
 assert.equal(admitted.ownerId, identity.agentId);
 assert.equal(admitted.snapshot.agentId, identity.agentId);
 assert.equal(admitted.idle.idle, true);
 assert.equal(admitted.idle.idleUntil, "human-message");
 assert.equal(admitted.idle.humanOnlyHold, true);
 assert.equal(admitted.idle.autoResume, false);
 assert.deepEqual(admitted.idle.drafts, drafts);
 await assert.rejects(owner.beginExecution(), /idle_until_human_message/);
 const ownerAdmitted = await owner.admitRepairedOwner();
 assert.equal(ownerAdmitted.ownerId, identity.agentId);
 assert.ok(ownerAdmitted.freshMarker !== admitted.freshMarker);
 assert.deepEqual(ownerAdmitted.snapshot, admitted.snapshot);
 await coordinator.shutdown(async () => host.runtime.dispose());
});
test("pre-commit Owner entry is disabled until repair completes", async (t) => {
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
const toolId = "spawn-gate-snap-a";
const entryId = ownerMgr.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "snap-child", request: "Work", label: "snap-child" }, { id: toolId })));
const child = SessionManager.create(ownerMgr.getSessionDir(), workflowDir);
child.appendCustomEntry("agent-coordination.identity", { agentId: child.getSessionId(), workflowId: identity.workflowId, directSpawnerAgentId: identity.agentId, creationPreset: null, spawnSource: { agentId: identity.agentId, entryId, toolCallId: toolId }, metadata: { label: "snap-child" } });
child.appendMessage(fauxAssistantMessage("Persist snap-child"));
 host.model.setResponses([() => fauxAssistantMessage("Repair triage holding.")]);
 await owner.requestManualRepair("gate snapshot triage");
 const entry = owner.repairedOwnerEntry();
 assert.ok(entry);
 assert.equal(entry.stage, "snapshot-only");
// Disabled by construction: snapshot-only prepare is a silent no-op.
// No admission attempt, no snapshot routing, no error toast.
let routed = false;
let admitAttempted = false;
const disabledView: any = {
status: () => ({ agentId: identity.agentId }),
repairedOwnerEntry: () => entry,
admitRepairedOwner: async (...args: unknown[]) => { admitAttempted = true; return (owner as any).admitRepairedOwner(...args); },
openAgentPresentation: async () => { routed = true; throw new Error("disabled pre-commit entry must not route to live presentation"); },
humanAttention: () => [],
};
const navigatingModerator = "moderator-gate-snap-1";
const disabledSession = createAgentSelectionSession(disabledView, navigatingModerator);
await disabledSession.prepare({ kind: "select_agent", agentId: identity.agentId });
assert.equal(routed, false);
assert.equal(admitAttempted, false);
// Backend guard stays for direct misuse; UI flows never reach it.
 await assert.rejects(owner.admitRepairedOwner(), /snapshot-only/);
 await coordinator.shutdown(async () => host.runtime.dispose());
});
test("selector silently ignores snapshot-only and admits admission-pending", async () => {
 const ownerId = "owner-gate-1";
 const moderatorId = "moderator-gate-1";
 const snapshotOnly = buildRepairedOwnerEntry({ ownerId, workflowId: ownerId, transcriptPath: "/tmp/repaired-owner.jsonl", stage: "snapshot-only" });
 let admitCalled = false;
 const snapshotView: any = {
 status: () => ({ agentId: moderatorId }),
 repairedOwnerEntry: () => snapshotOnly,
admitRepairedOwner: async () => { admitCalled = true; throw new Error("disabled entry must not attempt admission"); },
 openAgentPresentation: async () => { throw new Error("must not route snapshot-only to live presentation"); },
 humanAttention: () => [],
 };
let snapshotRouted = false;
const snapshotRoutedView: any = { ...snapshotView, openAgentPresentation: async () => { snapshotRouted = true; throw new Error("must not route snapshot-only to live presentation"); } };
const snapshotSilentSession = createAgentSelectionSession(snapshotRoutedView, moderatorId);
await snapshotSilentSession.prepare({ kind: "select_agent", agentId: ownerId });
 assert.equal(admitCalled, false);
 assert.equal(snapshotRouted, false);
 const admissionPending = buildRepairedOwnerEntry({ ownerId, workflowId: ownerId, transcriptPath: "/tmp/repaired-owner.jsonl", stage: "admission-pending" });
 let admitCalled2 = false;
 const admitView: any = {
 status: () => ({ agentId: moderatorId }),
 repairedOwnerEntry: () => admissionPending,
 admitRepairedOwner: async () => { admitCalled2 = true; return { ownerId }; },
 openAgentPresentation: async () => { throw new Error("must not route admission-pending to live presentation"); },
 humanAttention: () => [],
 };
 const admitSession = createAgentSelectionSession(admitView, moderatorId);
 await admitSession.prepare({ kind: "select_agent", agentId: ownerId });
 assert.equal(admitCalled2, true);
});
