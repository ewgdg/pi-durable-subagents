// Item 1: Owner model exclusions must propagate into the hosted manual-repair run.
// Red test: an excluded inherited model must never be selected for the repair
// Moderator run, on both the admitted and the preadmission paths.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentRunConfiguration } from "../src/templates/agent-configuration.ts";
import { readWorkflowPolicy, writeExcludedModels } from "../src/policy/workflow-policy.ts";
import { setupPreadmissionRepairHost } from "../src/bootstrap/preadmission-host.ts";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import type { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";

const inherited = (model: { provider: string; modelId: string }) => ({
  cwd: "/",
  model,
  thinking: "off" as const,
  extensions: [] as readonly string[],
});

test("excluded inherited model is refused instead of selected", () => {
  assert.throws(
    () =>
      resolveAgentRunConfiguration({
        inherited: inherited({ provider: "banned-provider", modelId: "old" }),
        isModelAvailable: () => true,
        isModelExcluded: (model) => model.provider === "banned-provider",
      }),
    /excluded by model policy: banned-provider\/old/,
  );
});

test("allowed inherited model still resolves", () => {
  const resolved = resolveAgentRunConfiguration({
    inherited: inherited({ provider: "steady-provider", modelId: "v1" }),
    isModelAvailable: () => true,
    isModelExcluded: () => false,
  });
  assert.deepEqual(resolved.model, { provider: "steady-provider", modelId: "v1" });
});

test("explicitly inherited model id honors exclusions", () => {
  assert.throws(
    () =>
      resolveAgentRunConfiguration({
        inherited: inherited({ provider: "banned-provider", modelId: "old" }),
        overrides: { model: { id: "inherit" } },
        isModelAvailable: () => true,
        isModelExcluded: (model) => model.provider === "banned-provider",
      }),
    /excluded by model policy/,
  );
});

test("preadmission repair host loads effective exclusions from the policy file", async (t) => {
  const host = await createUnboundTestOwnerHost(t, (() => {}) as never, { persistent: true });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  await writeExcludedModels(host.runtime.services.agentDir, ["banned-provider/*"]);
  const reread = await readWorkflowPolicy(host.runtime.services.agentDir);
  assert.equal(reread.ok, true);
  const failure = new OwnerRecoveryError(
    "Owner coordination initialization",
    identity.agentId,
    host.session.sessionManager.getSessionFile() ?? undefined,
    new ProtocolInvariantError("synthetic policy propagation probe"),
  );
  const setup = await setupPreadmissionRepairHost({
    captureRuntime: async () => host.runtime,
    entryModulePath: "<inline:pi-durable-subagents>",
    failure,
    identifiedOwnerId: identity.agentId,
    ownerIdentified: true,
  });
  try {
    assert.deepEqual(
      [...setup.coordinator.modelPolicy().excludedModels],
      ["banned-provider/*"],
    );
  } finally {
    await setup.coordinator.shutdown(async () => undefined);
    await host.runtime.dispose();
  }
});

test("admitted repair trigger refuses an excluded Owner model instead of selecting it", async (t) => {
  let owner!: ReturnType<WorkflowCoordinator["forAgent"]>;
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), { persistent: true });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  const coordinator = await createTestWorkflowCoordinator(host, identity, {
    entryModulePath: "<inline:pi-durable-subagents>",
  });
  owner = coordinator.forAgent(identity.agentId);
  const ownerModel = host.runtime.session.model;
  assert.ok(ownerModel, "test Owner has a current model");
  await owner.setModelExclusions([ownerModel.provider + "/*"]);
  // Preparation fails before any child launch: the banned model is refused,
  // never silently selected for the repair Moderator run.
  await assert.rejects(
    owner.requestManualRepair("Repair under an excluded Owner model."),
    /excluded by model policy/,
  );
  await host.runtime.dispose();
});
