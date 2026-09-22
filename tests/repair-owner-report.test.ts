// Repair reports must never append to the broken Owner transcript.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type Context } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import { setupPreadmissionRepairHost } from "../src/bootstrap/preadmission-host.ts";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
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
test("repair report lands in journal, Owner bytes unchanged", { timeout: 110000 }, async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "repair-report-"));
  const built = await buildBrokenOwnerSession(outDir, repoRoot);
  let owner!: ReturnType<WorkflowCoordinator["forAgent"]>;
  const hostCwd = await mkdtemp(join(tmpdir(), "repair-report-host-"));
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
  const ownerBefore = await readFile(built.sessionFile, "utf8");
  const input = {
    symptom: "Broken Owner blocks admission", suspectedDefect: "Duplicate Deliveries",
    uncertainty: "Fix not yet applied", recoveryActions: "Freeze and fix isolated copy",
    recoveryOutcome: "Not yet attempted", evidence: ["repairContext.error"],
  };
  let reported = false;
  let resolved = false;
  const route = (context: Context) => {
    if (!getCurrentTools(context.messages).some(({ name }) => name === "report_to_user")) {
      return fauxAssistantMessage("Owner idle.");
    }
    if (!reported) {
      reported = true;
      return fauxAssistantMessage(fauxToolCall("report_to_user", input, { id: "repair-report-1" }), { stopReason: "toolUse" });
    }
    if (!resolved) {
      resolved = true;
      return fauxAssistantMessage(fauxToolCall("moderator_control", { operation: "resolve", summary: "Blocker reported without commit", rationale: "Unrepairable path: report then resolve to Dormant." }, { id: "repair-resolve-1" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("Holding.");
  };
  host.model.setResponses(Array.from({ length: 12 }, () => route));
  const receipt = await repairView.requestManualRepair("Report routing triage.");
  assert.equal(receipt.disposition, "created");
  const repairDir = setup.coordinator.preadmissionRepairWorkflowDirectory() + "/repair";
  const { readdir } = await import("node:fs/promises");
  let moderatorFile = "";
  await waitFor(async () => {
    for (const name of await readdir(repairDir).catch(() => [] as string[])) {
      if (name.endsWith(".jsonl")) { moderatorFile = join(repairDir, name); return true; }
    }
    return false;
  }, 20000, "no moderator file");
  await waitFor(() => {
    const e = SessionManager.open(moderatorFile).getEntries().find((en) => en.type === "message" && en.message.role === "toolResult" && en.message.toolCallId === "repair-report-1");
    return e?.type === "message" && e.message.role === "toolResult" && !e.message.isError;
  }, 60000, "report_to_user did not succeed");
  await waitFor(() => {
    const e = SessionManager.open(moderatorFile).getEntries().find((en) => en.type === "message" && en.message.role === "toolResult" && en.message.toolCallId === "repair-resolve-1");
    return e?.type === "message" && e.message.role === "toolResult" && !e.message.isError;
  }, 60000, "resolve did not succeed");
  // Owner bytes must be unchanged: report went to the journal, never the broken file.
  assert.equal(await readFile(built.sessionFile, "utf8"), ownerBefore);
  // Journal holds the report.
  const journalDir = join(dirname(setup.coordinator.preadmissionRepairWorkflowDirectory()), "repair-journal");
  const journalRaw = await readFile(join(journalDir, "repair-reports.jsonl"), "utf8");
  assert.ok(journalRaw.includes("Broken Owner blocks admission"));
  // History exposes it without touching the Owner file.
  const history = repairView.reportHistory();
  assert.ok(history.some((h) => JSON.stringify(h).includes("Broken Owner blocks admission")));
  await host.runtime.dispose();
});
