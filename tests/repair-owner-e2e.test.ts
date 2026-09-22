// Headless end-to-end proof on the broken-session fixture via wired Moderator tools.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type Context } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import { setupPreadmissionRepairHost } from "../src/bootstrap/preadmission-host.ts";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
import { inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import { transcriptFromSessionFile } from "../src/pi-integration/session-manager-transcript.ts";
import type { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { buildBrokenOwnerSession } from "./support/broken-session-fixture.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, msg: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(msg);
}
function moderatorFileIn(repairDir: string): string {
  for (const name of readdirSync(repairDir)) {
    if (name.endsWith(".jsonl")) return join(repairDir, name);
  }
  return "";
}
function toolResultEntry(moderatorFile: string, toolCallId: string): any {
  const entries = SessionManager.open(moderatorFile).getEntries() as any[];
  return entries.find((e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === toolCallId);
}
function hasToolCall(moderatorFile: string, toolCallId: string): boolean {
  const entries = SessionManager.open(moderatorFile).getEntries() as any[];
  return entries.some((e) => e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message?.content) && e.message.content.some((p: any) => p?.type === "toolCall" && p?.id === toolCallId));
}
test("trigger-freeze-validate-fix-commit-resolve admits repaired Owner", { timeout: 120000 }, async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "repair-e2e-"));
  const built = await buildBrokenOwnerSession(outDir, repoRoot);
  // Admission-failure preserved before repair.
  const before = await transcriptFromSessionFile(built.sessionFile, { fresh: true }).refresh();
  assert.throws(() => inspectMessageDeliveries({ recipientAgentId: built.agentId, transcript: before }), /duplicate Deliveries/);
  let owner!: ReturnType<WorkflowCoordinator["forAgent"]>;
  const hostCwd = await mkdtemp(join(tmpdir(), "repair-e2e-host-"));
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), {
    persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
    sessionFile: built.sessionFile, cwd: hostCwd,
  });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  const { WorkflowCoordinator: Coordinator } = await import("../src/coordination/workflow-coordinator.ts");
  const failed = new Coordinator(host.runtime, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
  let admissionError: unknown;
  try { await failed.initialize(); } catch (e) { admissionError = e; }
  finally { await failed.shutdown(async () => undefined).catch(() => undefined); }
  assert.ok(admissionError instanceof ProtocolInvariantError);
  const failure = new OwnerRecoveryError("Owner coordination initialization", identity.agentId, built.sessionFile, admissionError as never);
  const setup = await setupPreadmissionRepairHost({
    captureRuntime: async () => host.runtime, entryModulePath: "<inline:pi-durable-subagents>",
    failure, identifiedOwnerId: identity.agentId, ownerIdentified: true,
  });
  t.after(() => setup.coordinator.shutdown(async () => undefined).catch(() => undefined));
  const repairView = setup.resolvePreadmissionRepair();
  owner = repairView as ReturnType<WorkflowCoordinator["forAgent"]>;
  await bindTestOwnerHost(host, "tui");
  const workflowDir = setup.coordinator.preadmissionRepairWorkflowDirectory();
  const repairDir = join(workflowDir, "repair");
  const scratch = await mkdtemp(join(tmpdir(), "repair-e2e-scratch-"));
  const route = (context: Context) => {
    if (!getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
      return fauxAssistantMessage("Owner idle; repair Moderator owns this check.");
    }
    let modFile = "";
    try { modFile = moderatorFileIn(repairDir); } catch { modFile = ""; }
    const hasFreezeCall = modFile ? hasToolCall(modFile, "e2e-freeze-1") : false;
    const freezeResult = modFile ? toolResultEntry(modFile, "e2e-freeze-1") : undefined;
    const hasValidateCall = modFile ? hasToolCall(modFile, "e2e-validate-1") : false;
    const validateResult = modFile ? toolResultEntry(modFile, "e2e-validate-1") : undefined;
    const hasCommitCall = modFile ? hasToolCall(modFile, "e2e-commit-1") : false;
    const commitResult = modFile ? toolResultEntry(modFile, "e2e-commit-1") : undefined;
    const hasResolveCall = modFile ? hasToolCall(modFile, "e2e-resolve-1") : false;
    if (!hasFreezeCall) {
      return fauxAssistantMessage(fauxToolCall("repair_freeze", {}, { id: "e2e-freeze-1" }), { stopReason: "toolUse" });
    }
    if (freezeResult && !hasValidateCall) {
      const details = (freezeResult.message as any).details as any;
      const sources = Array.isArray(details?.entries) ? details.entries.map((e: any) => e.source) : [];
      const target = sources[0] ?? built.sessionFile;
      return fauxAssistantMessage(fauxToolCall("repair_validate", { transcriptPaths: [target] }, { id: "e2e-validate-1" }), { stopReason: "toolUse" });
    }
    if (validateResult && !hasCommitCall) {
      const freezeDetails = (freezeResult.message as any).details as any;
      const snapshotId = freezeDetails?.snapshotId as string;
      const source = freezeDetails?.entries?.[0]?.source as string;
      const raw = readFileSync(source, "utf8");
      const lines = raw.trim().split("\n");
      const dupIdx: number[] = [];
      lines.forEach((l, i) => { if (l.includes("message-delivery")) dupIdx.push(i); });
      const fixed = lines.filter((_, i) => i !== dupIdx[1]);
      mkdirSync(scratch, { recursive: true });
      const fixedPath = join(scratch, basename(source).replace(/\.jsonl$/, "") + ".fixed.jsonl");
      writeFileSync(fixedPath, fixed.join("\n") + "\n");
      return fauxAssistantMessage(fauxToolCall("repair_commit", { snapshotId, repairedBySource: { [source]: fixedPath }, attemptId: "attempt-e2e-1" }, { id: "e2e-commit-1" }), { stopReason: "toolUse" });
    }
    if (commitResult && !hasResolveCall) {
      return fauxAssistantMessage(fauxToolCall("moderator_control", { operation: "resolve", summary: "Repair committed and verified", rationale: "Frozen Owner repaired, commit succeeded, repaired copy admits." }, { id: "e2e-resolve-1" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("Repair complete; holding for human direction.");
  };
  host.model.setResponses(Array.from({ length: 24 }, () => route));
  const receipt = await repairView.requestManualRepair("Headless e2e proof.");
  assert.equal(receipt.disposition, "created");
  const moderatorId = receipt.moderatorAgentId;
  // Wired methods exist (zero is-not-a-function guard).
  assert.equal(typeof repairView.freezeRepairSnapshot, "function");
  assert.equal(typeof repairView.commitRepairReplace, "function");
  const modView = setup.coordinator.forModerator(moderatorId) as any;
  for (const m of ["repairFreeze", "repairValidate", "repairCommit", "moderatorControl", "reportToUser"]) {
    assert.equal(typeof modView[m], "function", m + " is not a function");
  }
  let modFile = "";
  await waitFor(() => { try { modFile = moderatorFileIn(repairDir); return modFile.length > 0; } catch { return false; } }, 20000, "no moderator file");
  await waitFor(() => {
    const e = toolResultEntry(modFile, "e2e-freeze-1");
    return e && !e.message.isError;
  }, 60000, "freeze did not succeed");
  // Freeze yields exactly the Owner file.
  const freezeRes = toolResultEntry(modFile, "e2e-freeze-1");
  const snap = (freezeRes.message as any).details as any;
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].source, built.sessionFile);
  await waitFor(() => {
    const e = toolResultEntry(modFile, "e2e-validate-1");
    return e && !e.message.isError;
  }, 60000, "validate did not succeed");
  const validateRes = toolResultEntry(modFile, "e2e-validate-1");
  assert.ok(JSON.stringify(validateRes).toLowerCase().includes("duplicate"), "validate must surface duplicate");
  await waitFor(() => {
    const e = toolResultEntry(modFile, "e2e-commit-1");
    return e && !e.message.isError;
  }, 60000, "commit did not succeed: " + JSON.stringify(toolResultEntry(modFile, "e2e-commit-1"))?.slice(0, 1000));
  const commitRes = toolResultEntry(modFile, "e2e-commit-1");
  assert.ok(JSON.stringify(commitRes).includes("committed"));
  // Repaired Owner admits after commit.
  const after = await transcriptFromSessionFile(built.sessionFile, { fresh: true }).refresh();
  inspectMessageDeliveries({ recipientAgentId: built.agentId, transcript: after });
  await waitFor(() => {
    const e = toolResultEntry(modFile, "e2e-resolve-1");
    return e && !e.message.isError;
  }, 60000, "resolve did not succeed");
  // Dormant after resolve.
  await waitFor(() => {
    try { return (setup.coordinator.forModerator(moderatorId).status() as any).run.phase === "dormant"; }
    catch { return false; }
  }, 30000, "moderator did not reach Dormant");
  // Zero is-not-a-function: every toolResult must be clean.
  for (const id of ["e2e-freeze-1", "e2e-validate-1", "e2e-commit-1", "e2e-resolve-1"]) {
    const e = toolResultEntry(modFile, id);
    assert.ok(e && !e.message.isError, id + " failed");
    assert.ok(!JSON.stringify(e).includes("is not a function"), id + " hit is-not-a-function");
  }
  await host.runtime.dispose();
});
