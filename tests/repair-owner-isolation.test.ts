// Item 2: corruption must never leak into the repair run. Drives the real
// Owner bootstrap against the shared broken-session fixture (duplicate valid
// Owner Deliveries), falls into the preadmission repair host, triggers
// /agents repair, and runs the repair Moderator's first turn to completion.
// Zero duplicate-Deliveries may surface anywhere on the trigger path.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  type Context,
} from "@earendil-works/pi-ai";
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function scanJsonl(path: string, needle: string): number {
  const entries = SessionManager.open(path).getEntries();
  return entries.filter((entry) => JSON.stringify(entry).indexOf(needle) !== -1).length;
}

test("trigger-to-first-moderator-turn surfaces zero duplicate-Deliveries", { timeout: 110000 }, async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "repair-isolation-"));
  const built = await buildBrokenOwnerSession(outDir, repoRoot);
  let owner!: ReturnType<WorkflowCoordinator["forAgent"]>;
  // The host cwd/agentDir stay isolated: the broken session file carries its
  // own recorded cwd, and nothing in this flow may write beside the repo.
  const hostCwd = await mkdtemp(join(tmpdir(), "repair-isolation-host-"));
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), {
    persistent: true,
    processVisibleModel: true,
    implicitModeratorResponses: false,
    sessionFile: built.sessionFile,
    cwd: hostCwd,
  });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  assert.equal(identity.agentId, built.agentId);
  // Real bootstrap first: admission must block on the broken fixture exactly
  // like the live report, and nothing else may throw before the repair host.
  const { WorkflowCoordinator: Coordinator } = await import("../src/coordination/workflow-coordinator.ts");
  const failed = new Coordinator(host.runtime, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
  let admissionError: unknown;
  try {
    await failed.initialize();
  } catch (error) {
    admissionError = error;
  } finally {
    await failed.shutdown(async () => undefined).catch(() => undefined);
  }
  assert.ok(
    admissionError instanceof ProtocolInvariantError && String(admissionError.message).indexOf("duplicate Deliveries") !== -1,
    "admission must block on duplicate Deliveries, got: " + String(admissionError),
  );
  const failure = new OwnerRecoveryError(
    "Owner coordination initialization",
    identity.agentId,
    built.sessionFile,
    admissionError,
  );
  const setup = await setupPreadmissionRepairHost({
    captureRuntime: async () => host.runtime,
    entryModulePath: "<inline:pi-durable-subagents>",
    failure,
    identifiedOwnerId: identity.agentId,
    ownerIdentified: true,
  });
  t.after(() => setup.coordinator.shutdown(async () => undefined).catch(() => undefined));
  const repairView = setup.resolvePreadmissionRepair();
  owner = repairView as ReturnType<WorkflowCoordinator["forAgent"]>;
  await bindTestOwnerHost(host, "tui");
  // Frozen-evidence proof: the broken Owner transcript must gain no entries
  // anywhere on the repair path (no refresh writes, no fault reports).
  const ownerEntryCount = () => SessionManager.open(built.sessionFile).getEntries().length;
  const frozenEntries = ownerEntryCount();
  let observed = false;
  let resolved = false;
  const moderatorRoute = (context: Context) => {
    if (!getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
      return fauxAssistantMessage("Owner idle; the repair Moderator owns this check.");
    }
    if (!observed) {
      observed = true;
      return fauxAssistantMessage(
        fauxToolCall("agent_observe", { operation: "status" }, { id: "repair-observe-1" }),
        { stopReason: "toolUse" },
      );
    }
    if (!resolved) {
      resolved = true;
      return fauxAssistantMessage(
        fauxToolCall("moderator_control", {
          operation: "resolve",
          summary: "Repair triage complete",
          rationale: "First-turn isolation check finished with no incident handling remaining.",
        }, { id: "repair-resolve-1" }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage("Repair triage complete; holding for human direction.");
  };
  host.model.setResponses(Array.from({ length: 12 }, () => moderatorRoute));
  const receipt = await repairView.requestManualRepair("Isolate the broken Owner session.");
  assert.equal(receipt.disposition, "created");
  const moderatorPath = setup.coordinator.preadmissionRepairWorkflowDirectory() + "/repair";
  const { readdir } = await import("node:fs/promises");
  let moderatorFile = "";
  await waitFor(async () => {
    for (const name of await readdir(moderatorPath).catch(() => [])) {
      if (name.endsWith(".jsonl")) {
        moderatorFile = join(moderatorPath, name);
        return true;
      }
    }
    return false;
  }, 20000, "repair Moderator transcript was not committed under repair/");
  await waitFor(() => {
    const result = SessionManager.open(moderatorFile).getEntries().find(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "repair-resolve-1",
    );
    return result?.type === "message" && result.message.role === "toolResult" && !result.message.isError;
  }, 60000, "repair Moderator first turn (observe + resolve) did not complete cleanly");
  // The trigger-time Input carries the admission-failure error pointer, so the
  // phrase occurs exactly once, inside repairContext.error. Anything beyond
  // the Input entry would be traversed broken evidence, which stays forbidden.
  assert.equal(scanJsonl(moderatorFile, "duplicate Deliveries"), 1);
  const moderatorEntries = SessionManager.open(moderatorFile).getEntries();
  assert.ok(moderatorEntries[0]?.type === "custom_message" && JSON.stringify(moderatorEntries[0]).indexOf("duplicate Deliveries") !== -1);
  for (const entry of moderatorEntries.slice(1)) assert.equal(JSON.stringify(entry).indexOf("duplicate Deliveries"), -1);
  assert.equal(scanJsonl(built.sessionFile, "duplicate Deliveries"), 0);
  assert.equal(ownerEntryCount(), frozenEntries);
  // No automatic incident inspection may run in the repair host: no fault
  // attention, no auto-created handling for the retired broken evidence.
  assert.deepEqual(repairView.operationalAttention(), []);
  const observeResult = SessionManager.open(moderatorFile).getEntries().find(
    (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "repair-observe-1",
  );
  assert.ok(observeResult?.type === "message" && observeResult.message.role === "toolResult");
  assert.equal(observeResult.message.isError, false);
  await host.runtime.dispose();
});
