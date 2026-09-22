import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { commitHostedModerator } from "../src/coordination/hosted-moderator.ts";
import type { MessageCoordinator } from "../src/coordination/messages.ts";
import { OperationalIncidentCoordinator } from "../src/coordination/operational-incidents.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { resolveModeratorAgentMetadata } from "../src/protocol/agent-metadata.ts";
import type { ModeratorIdentity } from "../src/protocol/moderator-input.ts";
import type { OwnerIdentity } from "../src/protocol/owner-identity.ts";
import type { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
async function setupHostedFixture() {
  const root = await mkdtemp(join(tmpdir(), "manual-repair-orphan-"));
  const ownerIdentity: OwnerIdentity = { agentId: "owner-1", workflowId: "owner-1", directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } };
  const agents = new Map<string, AgentRecord>();
  agents.set(ownerIdentity.agentId, {
    identity: ownerIdentity,
    transcript: { inspect: () => ({ transcriptPath: undefined }) },
  } as unknown as AgentRecord);
  let failStart = true;
  let shuttingDown = false;
  const created: AgentRecord[] = [];
  const released: string[] = [];
  const retentionRemoved: Array<{ agentId: string; reason: string }> = [];
  const reported: unknown[] = [];
  const sessionFactory = {
    workflowSessionDirectory: () => join(root, "pi-durable-subagents", ownerIdentity.workflowId),
    admitProcessRuntimePlatform() {},
    async prepareModeratorRun({ agentId }: { agentId: string }) {
      return { agentId, creationPreset: null, configuration: { cwd: root } };
    },
    createStagingSession(prepared: { agentId: string }, subdirectory?: string) {
      return SessionManager.create(root, subdirectory ? join(root, subdirectory) : root, { id: prepared.agentId });
    },
    createModeratorRecord({ identity }: { identity: ModeratorIdentity }) {
      const record = {
        identity,
        host: {
          lane: { run: (task: () => Promise<void>) => task() },
          startInLane: async () => {
            if (failStart) throw new Error("injected-start-failure");
          },
          removeRetentionReason: (reason: string) => {
            retentionRemoved.push({ agentId: identity.agentId, reason });
          },
          observe: () => ({ phase: "live" }),
          currentRunFailed: () => false,
        },
      } as unknown as AgentRecord;
      created.push(record);
      return record;
    },
  } as unknown as ProcessChildSessionFactory;
  const messages = {
    admitCustomDeliveryInLane: async () => "pending",
    requestRelease: async (moderator: AgentRecord) => {
      released.push(moderator.identity.agentId);
    },
    shutdownDeliveryProgress() {},
  } as unknown as MessageCoordinator;
  const dependencies = {
    agents,
    ownerIdentity,
    sessionFactory,
    messages,
    integrateAgent: (record: AgentRecord) => {
      agents.set(record.identity.agentId, record);
    },
    isShuttingDown: () => shuttingDown,
  };
  const incidents = new OperationalIncidentCoordinator({
    ...dependencies,
    workflowPolicy: new WorkflowPolicyStore(),
    reportError: (error: unknown) => {
      reported.push(error);
    },
    retainDiagnostic: () => ({ agentId: ownerIdentity.agentId, entryId: "diag-1" }),
    publishRuntimeReport: () => undefined,
    runtimeReportSourceForIncident: () => undefined,
    appendRuntimeReportFinding: () => undefined,
  });
  return { root, incidents, dependencies, created, released, retentionRemoved, reported, setFailStart: (value: boolean) => {
    failStart = value;
  }, setShuttingDown: (value: boolean) => {
    shuttingDown = value;
  } };
}
test("manual repair start failure releases the orphan; next trigger creates one Moderator", async () => {
  const fx = await setupHostedFixture();
  await assert.rejects(fx.incidents.requestManualRepair("Investigate the stall."), /injected-start-failure/);
  assert.equal(fx.created.length, 1);
  const orphanId = fx.created[0]!.identity.agentId;
  assert.deepEqual(fx.retentionRemoved, [{ agentId: orphanId, reason: "moderator_handling" }]);
  assert.deepEqual(fx.released, [orphanId]);
  assert.equal(fx.incidents.isManualRepairModerator(orphanId), false);
  fx.setFailStart(false);
  const receipt = await fx.incidents.requestManualRepair("Retry after failure.");
  assert.equal(receipt.disposition, "created");
  assert.notEqual(receipt.moderatorAgentId, orphanId);
  assert.equal(fx.created.length, 2);
  assert.equal(fx.incidents.isManualRepairModerator(receipt.moderatorAgentId), true);
});
test("bootstrap commit honors shutdown requested by the pre-commit hook", async () => {
  const fx = await setupHostedFixture();
  const result = await commitHostedModerator(fx.dependencies, {
    metadata: () => resolveModeratorAgentMetadata("manual_repair"),
    input: () => ({
      trigger: { kind: "manual_repair", reason: "Shutdown probe." },
      inspectedThrough: [],
    }),
    sessionSubdirectory: "repair",
    beforeBootstrapCommit: () => {
      fx.setShuttingDown(true);
    },
  });
  assert.equal(result, undefined);
  assert.equal(fx.created.length, 0);
});
