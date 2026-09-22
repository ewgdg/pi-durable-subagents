import assert from "node:assert/strict";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import type { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { sha256File } from "../src/coordination/repair-freeze.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";

async function makeRepairedCopy(sourcePath: string, scratchDir: string, note: string): Promise<string> {
  const repairedPath = join(scratchDir, basename(sourcePath).replace(".jsonl", "") + ".repaired.jsonl");
  await copyFile(sourcePath, repairedPath);
  const session = SessionManager.open(repairedPath);
  session.appendMessage(fauxAssistantMessage(note));
  return repairedPath;
}

async function setupWithTrigger(t: any, prefix: string, reason: string) {
  let owner: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner as ReturnType<WorkflowCoordinator["forAgent"]>), { persistent: true, processVisibleModel: true, implicitModeratorResponses: false });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  const coordinator = await createTestWorkflowCoordinator(host, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
  owner = coordinator.forAgent(identity.agentId);
  await bindTestOwnerHost(host, "tui");
  const ownerMgr = host.session.sessionManager;
  const toolId = "spawn-" + prefix + "-a";
  const entryId = ownerMgr.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: prefix + "-child", request: "Work", label: prefix + "-child" }, { id: toolId })));
  const workflowDir = workflowSessionDirectory(ownerMgr.getSessionDir(), identity.workflowId);
  const child = SessionManager.create(ownerMgr.getSessionDir(), workflowDir);
  child.appendCustomEntry("agent-coordination.identity", { agentId: child.getSessionId(), workflowId: identity.workflowId, directSpawnerAgentId: identity.agentId, creationPreset: null, spawnSource: { agentId: identity.agentId, entryId, toolCallId: toolId }, metadata: { label: prefix + "-child" } });
  child.appendMessage(fauxAssistantMessage("Persist " + prefix + "-child"));
  host.model.setResponses([() => fauxAssistantMessage("Repair triage holding."), () => fauxAssistantMessage("Repair triage holding.")]);
  const receipt = await (owner as NonNullable<typeof owner>).requestManualRepair(reason);
  assert.equal(receipt.disposition, "created");
  return { host, identity, coordinator, owner: owner as NonNullable<typeof owner> };
}

test("trigger-is-approval: commit under fresh trigger succeeds", async (t) => {
  const fx = await setupWithTrigger(t, "trig-a", "fresh trigger commit");
  const snapshot = await fx.owner.freezeRepairSnapshot();
  assert.ok(snapshot.snapshotId.length > 0);
  const scratch = await mkdtemp(join(tmpdir(), "repair-trig-a-scratch-"));
  const repaired: Record<string, string> = {};
  for (const entry of snapshot.entries) repaired[entry.source] = await makeRepairedCopy(entry.source, scratch, "Trigger repair.");
  const result = await fx.owner.commitRepairReplace(repaired, "attempt-trig-a-1");
  assert.ok(result.disposition === "committed" || result.disposition === "joined-committed");
  assert.equal(result.snapshotId, snapshot.snapshotId);
  assert.equal(result.idle.idle, true);
  await fx.coordinator.shutdown(async () => fx.host.runtime.dispose());
});

test("trigger-is-approval: second commit on same trigger refused without fresh trigger", async (t) => {
  const fx = await setupWithTrigger(t, "trig-b", "second commit refused");
  const snapshot = await fx.owner.freezeRepairSnapshot();
  const scratch = await mkdtemp(join(tmpdir(), "repair-trig-b-scratch-"));
  const repaired: Record<string, string> = {};
  for (const entry of snapshot.entries) repaired[entry.source] = await makeRepairedCopy(entry.source, scratch, "Trigger repair.");
  const first = await fx.owner.commitRepairReplace(repaired, "attempt-trig-b-1");
  assert.ok(first.disposition === "committed" || first.disposition === "joined-committed");
  await assert.rejects(fx.owner.commitRepairReplace(repaired, "attempt-trig-b-2"), /unauthorized|consumed|no pending/);
  await fx.coordinator.shutdown(async () => fx.host.runtime.dispose());
});

test("trigger-is-approval: drift still refuses", async (t) => {
  const fx = await setupWithTrigger(t, "trig-c", "drift refuses");
  const snapshot = await fx.owner.freezeRepairSnapshot();
  const opener = SessionManager.open(snapshot.entries[0].source as string);
  opener.appendMessage(fauxAssistantMessage("Late drift invalidates the frozen snapshot."));
  const scratch = await mkdtemp(join(tmpdir(), "repair-trig-c-scratch-"));
  const repaired: Record<string, string> = {};
  for (const entry of snapshot.entries) repaired[entry.source] = await makeRepairedCopy(entry.source, scratch, "Drift repair.");
  await assert.rejects(fx.owner.commitRepairReplace(repaired, "attempt-trig-c-1"), /drift/);
  await fx.coordinator.shutdown(async () => fx.host.runtime.dispose());
});

test("trigger-is-approval: validation failure still refuses", async (t) => {
  const fx = await setupWithTrigger(t, "trig-d", "validation refuses");
  const snapshot = await fx.owner.freezeRepairSnapshot();
  const scratch = await mkdtemp(join(tmpdir(), "repair-trig-d-scratch-"));
  const repaired: Record<string, string> = {};
  for (const entry of snapshot.entries) repaired[entry.source] = await makeRepairedCopy(entry.source, scratch, "Validation repair.");
  await writeFile(repaired[snapshot.entries[0].source as string] as string, "not-json{{", "utf8");
  await assert.rejects(fx.owner.commitRepairReplace(repaired, "attempt-trig-d-1"), /replay_failed/);
  await fx.coordinator.shutdown(async () => fx.host.runtime.dispose());
});

test("trigger-is-approval: unknown snapshot and repaired-set mismatch still refuse", async (t) => {
  const fx = await setupWithTrigger(t, "trig-e", "unknown snapshot refuses");
  await assert.rejects(fx.owner.commitRepairReplace({ "/tmp/unknown-source": "/tmp/unknown-copy" }, "attempt-trig-e-0"), /unauthorized|no pending|invalid_input/);
  const snapshot = await fx.owner.freezeRepairSnapshot();
  const scratch = await mkdtemp(join(tmpdir(), "repair-trig-e-scratch-"));
  const repaired: Record<string, string> = {};
  for (const entry of snapshot.entries) repaired[entry.source] = await makeRepairedCopy(entry.source, scratch, "Mismatch repair.");
  const extra = { ...repaired, "/tmp/extra-source": "/tmp/extra-copy" };
  await assert.rejects(fx.owner.commitRepairReplace(extra, "attempt-trig-e-1"), /invalid_input/);
  const missing = { ...repaired };
  delete (missing as Record<string, string>)[snapshot.entries[0].source as string];
  await assert.rejects(fx.owner.commitRepairReplace(missing, "attempt-trig-e-2"), /invalid_input/);
  await fx.coordinator.shutdown(async () => fx.host.runtime.dispose());
});

test("trigger-is-approval: Esc aborts the step only; retry succeeds without fresh trigger", async (t) => {
  const fx = await setupWithTrigger(t, "trig-f", "esc preserves authority");
  const snapshot = await fx.owner.freezeRepairSnapshot();
  const before = new Map<string, string>();
  for (const entry of snapshot.entries) before.set(entry.source, await sha256File(entry.source as string));
  // Esc aborts the in-flight step with no partial apply: the signal itself
  // writes nothing and preserves trigger authority.
  await fx.owner.notifyRepairHumanInput("esc");
  for (const entry of snapshot.entries) assert.equal(await sha256File(entry.source as string), before.get(entry.source));
  // Retry in the same attempt proceeds WITHOUT a fresh trigger after fresh
  // drift + validation rechecks.
  const scratch = await mkdtemp(join(tmpdir(), "repair-trig-f-scratch-"));
  const repaired: Record<string, string> = {};
  for (const entry of snapshot.entries) repaired[entry.source] = await makeRepairedCopy(entry.source, scratch, "Esc-retry repair.");
  const result = await fx.owner.commitRepairReplace(repaired, "attempt-trig-f-1");
  assert.ok(result.disposition === "committed" || result.disposition === "joined-committed");
  assert.equal(result.snapshotId, snapshot.snapshotId);
  for (const entry of snapshot.entries) assert.equal(await sha256File(entry.source as string), await sha256File(repaired[entry.source] as string));
  await fx.coordinator.shutdown(async () => fx.host.runtime.dispose());
});
test("trigger-is-approval: new human message preserves authority; retry succeeds", async (t) => {
  const fx = await setupWithTrigger(t, "trig-g", "human message preserves authority");
  const snapshot = await fx.owner.freezeRepairSnapshot();
  const before = new Map<string, string>();
  for (const entry of snapshot.entries) before.set(entry.source, await sha256File(entry.source as string));
  await fx.owner.resumeFromHuman("new human direction (preserves trigger)", undefined);
  for (const entry of snapshot.entries) assert.equal(await sha256File(entry.source as string), before.get(entry.source));
  const scratch = await mkdtemp(join(tmpdir(), "repair-trig-g-scratch-"));
  const repaired: Record<string, string> = {};
  for (const entry of snapshot.entries) repaired[entry.source] = await makeRepairedCopy(entry.source, scratch, "Human-retry repair.");
  const result = await fx.owner.commitRepairReplace(repaired, "attempt-trig-g-1");
  assert.ok(result.disposition === "committed" || result.disposition === "joined-committed");
  assert.equal(result.snapshotId, snapshot.snapshotId);
  await fx.coordinator.shutdown(async () => fx.host.runtime.dispose());
});
test("trigger-is-approval: explicit cancel clears authority; commit needs fresh trigger", async (t) => {
  const fx = await setupWithTrigger(t, "trig-h", "explicit cancel clears");
  const snapshot = await fx.owner.freezeRepairSnapshot();
  await fx.owner.cancelRepairTrigger();
  const scratch = await mkdtemp(join(tmpdir(), "repair-trig-h-scratch-"));
  const repaired: Record<string, string> = {};
  for (const entry of snapshot.entries) repaired[entry.source] = await makeRepairedCopy(entry.source, scratch, "Cancel repair.");
  await assert.rejects(fx.owner.commitRepairReplace(repaired, "attempt-trig-h-1"), /unauthorized|revoked|no pending|consumed/);
  await assert.rejects(fx.owner.freezeRepairSnapshot(), /unauthorized|no pending/);
  await fx.coordinator.shutdown(async () => fx.host.runtime.dispose());
});
