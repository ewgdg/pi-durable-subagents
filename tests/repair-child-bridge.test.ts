// Repair tooling through the live child bridge, not around it.
// The production failure was `availableHandlers.repairFreeze is not a function`
// inside child-hosted Moderators: the tools register for the moderator role,
// but the control-backed child proxies never forwarded them. These tests drive
// the exact failing call (registered tool execute -> child proxy -> Control
// request -> owner dispatch) plus the enriched manual-repair Input, headlessly
// and (where feasible) through a full model-run e2e on the shared fixture.
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
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
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import { setupPreadmissionRepairHost } from "../src/bootstrap/preadmission-host.ts";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import type { ControlRequest } from "../src/control/agent-control-channel.ts";
import { agentControlProtocol } from "../src/control/agent-control-protocol.ts";
import {
  MANUAL_REPAIR_PROCEDURE,
  buildManualRepairInput,
} from "../src/coordination/manual-repair.ts";
import type { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { resolveModeratorAgentMetadata } from "../src/protocol/agent-metadata.ts";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
import {
  MODERATOR_INPUT_CUSTOM_TYPE,
  validateColdModeratorInput,
} from "../src/protocol/moderator-input.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
  createControlBackedChildParticipantHandlers,
  dispatchParticipantRequestToOwner,
  type ChildParticipantControlRequester,
  type OwnerParticipantRequestHandlers,
} from "../src/process-runtime/remote-participant-control.ts";
import { registerParticipantCoordinationTools } from "../src/tools/participant-coordination-tools.ts";
import { buildBrokenOwnerSession } from "./support/broken-session-fixture.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FROZEN_SNAPSHOT = {
  snapshotId: "snap-bridge-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  workflowDirectory: "/workflows/owner-1",
  entries: [{ source: "/workflows/owner-1/child.jsonl", sha256: "abc123" }],
};
const VALIDATE_REPORT = {
  advisory: true,
  authorizesBytes: false,
  sealsNothing: true,
  effectsApplied: false,
  resolveInvoked: false,
  diagnostics: [],
  unknowns: [],
  warnings: ["prior validate reports are advisory"],
  outOfScope: [],
  files: [],
  installedSource: {},
};
const COMMIT_RESULT = {
  disposition: "committed",
  attemptId: "attempt-bridge-1",
  snapshotId: "snap-bridge-1",
  generation: 1,
  backupDir: "/backups/snap-bridge-1",
  manifestPath: "/backups/snap-bridge-1/manifest.json",
  files: [],
  committedAt: "2026-01-01T00:00:01.000Z",
  audit: {},
  idle: {},
};

function stubOwnerModerator(overrides?: {
  repairFreeze?: (toolCallId: string, input: unknown) => Promise<unknown>;
}) {
  const calls: Array<[string, string, unknown]> = [];
  const coordination = {
    observe: async () => ({ matches: [], hasMore: false }),
    message: async () => ({ messageId: "m", targetAgentId: "t", messageStatus: "sent" }),
    wait: async () => ({ disposition: "preempted" }),
    control: async () => ({ agentId: "t", disposition: "not_running" }),
    askUser: async () => ({ requestId: "h", answer: "Yes" }),
    reportToUser: async () => ({ reportId: "r", createdAt: "2026-01-01T00:00:00.000Z" }),
    moderatorControl: async () => ({ disposition: "resolved" }),
    repairValidate: async (toolCallId: string, input: unknown) => {
      calls.push(["repairValidate", toolCallId, input]);
      return VALIDATE_REPORT;
    },
    repairFreeze: overrides?.repairFreeze ?? (async (toolCallId: string, input: unknown) => {
      calls.push(["repairFreeze", toolCallId, input]);
      return FROZEN_SNAPSHOT;
    }),
    repairCommit: async (toolCallId: string, input: unknown) => {
      calls.push(["repairCommit", toolCallId, input]);
      return COMMIT_RESULT;
    },
  };
  const handlers = {
    coordination,
    lifecycle: {},
    presentation: {},
  } as unknown as OwnerParticipantRequestHandlers<"moderator">;
  return { handlers, calls };
}

function bridgeRequester(handlers: OwnerParticipantRequestHandlers<"moderator">): ChildParticipantControlRequester {
  return (async (method: string, payload: unknown, signal?: AbortSignal) =>
    dispatchParticipantRequestToOwner(handlers, {
      method,
      payload,
      signal: signal ?? new AbortController().signal,
    } as ControlRequest<typeof agentControlProtocol>)) as ChildParticipantControlRequester;
}

function captureRegisteredTools(role: "moderator", handlers: Parameters<typeof registerParticipantCoordinationTools>[2]) {
  const registered = new Map<string, { execute: (toolCallId: string, input: never) => Promise<{ details?: unknown; isError?: boolean }> }>();
  const pi = {
    registerTool: (definition: { name: string }) => {
      registered.set(definition.name, definition as never);
    },
  } as unknown as ExtensionAPI;
  registerParticipantCoordinationTools(pi, role, handlers);
  return registered;
}

test("child-hosted moderators drive repair tools through the live bridge path", async () => {
  const { handlers, calls } = stubOwnerModerator();
  const child = createControlBackedChildParticipantHandlers("moderator", bridgeRequester(handlers));
  assert.equal(typeof child.coordination.repairFreeze, "function");
  assert.equal(typeof child.coordination.repairValidate, "function");
  assert.equal(typeof child.coordination.repairCommit, "function");
  const registered = captureRegisteredTools("moderator", child.coordination);
  const freeze = registered.get("repair_freeze");
  assert.ok(freeze, "repair_freeze registers for child-hosted moderators");
  const frozen = await freeze.execute("freeze-call-1", {} as never);
  assert.deepEqual(frozen.details, FROZEN_SNAPSHOT);
  const validate = registered.get("repair_validate");
  assert.ok(validate);
  const validated = await validate.execute("validate-call-1", { transcriptPaths: ["/sessions/owner.jsonl"] } as never);
  assert.deepEqual((validated.details as { advisory: boolean }).advisory, true);
  const commit = registered.get("repair_commit");
  assert.ok(commit);
  const committed = await commit.execute(
    "commit-call-1",
    { snapshotId: "snap-bridge-1", repairedBySource: { "/a": "/b" } } as never,
  );
  assert.deepEqual((committed.details as { snapshotId: string }).snapshotId, "snap-bridge-1");
  assert.deepEqual(calls, [
    ["repairFreeze", "freeze-call-1", {}],
    ["repairValidate", "validate-call-1", { transcriptPaths: ["/sessions/owner.jsonl"] }],
    ["repairCommit", "commit-call-1", { snapshotId: "snap-bridge-1", repairedBySource: { "/a": "/b" } }],
  ]);
});

test("ordinary participants keep no repair surface and owner dispatch refuses repair", async () => {
  const { handlers } = stubOwnerModerator();
  const ordinary = createControlBackedChildParticipantHandlers("ordinary", bridgeRequester(handlers));
  assert.equal("repairFreeze" in ordinary.coordination, false);
  assert.equal("repairValidate" in ordinary.coordination, false);
  assert.equal("repairCommit" in ordinary.coordination, false);
  const ordinaryOwner = {
    coordination: {
      observe: async () => ({ matches: [], hasMore: false }),
      message: async () => ({ messageId: "m", targetAgentId: "t", messageStatus: "sent" }),
      wait: async () => ({ disposition: "preempted" }),
      control: async () => ({ agentId: "t", disposition: "not_running" }),
      askUser: async () => ({ requestId: "h", answer: "Yes" }),
    },
    lifecycle: {},
    presentation: {},
  } as unknown as OwnerParticipantRequestHandlers<"ordinary">;
  await assert.rejects(
    dispatchParticipantRequestToOwner(ordinaryOwner, {
      method: "coordination.repairFreeze",
      payload: { toolCallId: "freeze-ordinary", input: {} },
      signal: new AbortController().signal,
    } as ControlRequest<typeof agentControlProtocol>),
    /child_runtime_owner_request_forbidden/,
  );
});

test("non-manual moderator refusal crosses the bridge unmasked", async () => {
  const { handlers } = stubOwnerModerator({
    repairFreeze: async () => {
      throw new Error("wrong_participant: repair_freeze is available only on the manual repair Moderator");
    },
  });
  const child = createControlBackedChildParticipantHandlers("moderator", bridgeRequester(handlers));
  await assert.rejects(
    child.coordination.repairFreeze!("freeze-foreign", {}),
    /wrong_participant: repair_freeze is available only on the manual repair Moderator/,
  );
});

test("manual repair Input carries pointers plus the short procedure", () => {
  const input = buildManualRepairInput("Fix it.", {
    stage: "admitted Owner trigger",
    ownerId: "owner-1",
    workflowId: "owner-1",
    workflowDirectory: "/tmp/wf",
  });
  assert.deepEqual(input.trigger, { kind: "manual_repair", reason: "Fix it." });
  assert.deepEqual(input.inspectedThrough, []);
  assert.deepEqual(input.repairContext, {
    stage: "admitted Owner trigger",
    ownerId: "owner-1",
    workflowId: "owner-1",
    workflowDirectory: "/tmp/wf",
  });
  assert.equal(input.procedure, MANUAL_REPAIR_PROCEDURE);
const procedureLines = MANUAL_REPAIR_PROCEDURE.split("\n");
assert.equal(procedureLines.length, 6);
assert.match(procedureLines[4] as string, /^5\. Unrepairable exit/);
assert.match(procedureLines[5] as string, /^6\. User returns via \/agents/);
  assert.throws(
    () => buildManualRepairInput("", {
      stage: "admitted Owner trigger",
      ownerId: "owner-1",
      workflowId: "owner-1",
      workflowDirectory: "/tmp/wf",
    }),
    /validated reason/,
  );
  assert.throws(
    () => buildManualRepairInput("Fix it.", {
      stage: "",
      ownerId: "owner-1",
      workflowId: "owner-1",
      workflowDirectory: "/tmp/wf",
    }),
    /stage, Owner binding/,
  );
});

async function coldEntries(inputJson: string, details: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "repair-bridge-cold-"));
  const session = SessionManager.create(root, root);
  session.appendCustomMessageEntry(MODERATOR_INPUT_CUSTOM_TYPE, inputJson, true, details);
  session.appendMessage(fauxAssistantMessage("Persist cold input."));
  return { sessionId: session.getSessionId(), entries: session.getEntries() };
}

test("cold validation keeps enriched manual repair Inputs and rejects partial guidance", async () => {
  const enriched = buildManualRepairInput("Triage the stall.", {
    stage: "Owner coordination initialization",
    error: "duplicate Deliveries",
    transcriptPath: "/sessions/owner.jsonl",
    ownerId: "owner-9",
    workflowId: "owner-9",
    workflowDirectory: "/workflows/owner-9",
  });
  const sessionId = "moderator-cold-1";
  const good = await coldEntries(JSON.stringify(enriched), {
    agentId: sessionId,
    workflowId: "owner-9",
    metadata: { ...resolveModeratorAgentMetadata("manual_repair") },
    creationPreset: null,
  });
  const parsed = validateColdModeratorInput({ sessionId, entries: good.entries });
  assert.equal(parsed.input.trigger.kind, "manual_repair");
  assert.deepEqual(parsed.input.repairContext, enriched.repairContext);
  assert.equal(parsed.input.procedure, MANUAL_REPAIR_PROCEDURE);
  const partial = await coldEntries(
    JSON.stringify({
      trigger: { kind: "manual_repair", reason: "Triage." },
      inspectedThrough: [],
      repairContext: enriched.repairContext,
    }),
    {
      agentId: sessionId,
      workflowId: "owner-9",
      metadata: { ...resolveModeratorAgentMetadata("manual_repair") },
      creationPreset: null,
    },
  );
  assert.throws(
    () => validateColdModeratorInput({ sessionId, entries: partial.entries }),
    (error: unknown) =>
      error instanceof ProtocolInvariantError &&
      error.message.indexOf("needs both repairContext and procedure") !== -1,
  );
  const foreign = await coldEntries(
    JSON.stringify({
      trigger: {
        kind: "operation_review",
        toolCall: { agentId: "agent-a", entryId: "entry-1", toolCallId: "call-1" },
        reviewIntervalMs: 5000,
      },
      inspectedThrough: [{ agentId: "agent-a", entryId: "entry-9" }],
      repairContext: enriched.repairContext,
      procedure: MANUAL_REPAIR_PROCEDURE,
    }),
    {
      agentId: sessionId,
      workflowId: "owner-9",
      metadata: { ...resolveModeratorAgentMetadata("operation_review") },
      creationPreset: null,
    },
  );
  assert.throws(
    () => validateColdModeratorInput({ sessionId, entries: foreign.entries }),
    (error: unknown) =>
      error instanceof ProtocolInvariantError &&
      error.message.indexOf("needs a manual_repair trigger") !== -1,
  );
});

async function waitForBridge(predicate: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function scanBridgeJsonl(path: string, needle: string): number {
  const entries = SessionManager.open(path).getEntries();
  return entries.filter((entry) => JSON.stringify(entry).indexOf(needle) !== -1).length;
}

function findBridgeToolResult(path: string, toolCallId: string) {
  const entry = SessionManager.open(path).getEntries().find(
    (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId,
  );
  return entry?.type === "message" && entry.message.role === "toolResult" ? entry.message : undefined;
}

test("preadmission repair Moderator drives freeze and validate over the live bridge", { timeout: 150000 }, async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "repair-bridge-e2e-"));
  const built = await buildBrokenOwnerSession(outDir, repoRoot);
  let owner!: ReturnType<WorkflowCoordinator["forAgent"]>;
  const hostCwd = await mkdtemp(join(tmpdir(), "repair-bridge-e2e-host-"));
  const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), {
    persistent: true,
    processVisibleModel: true,
    implicitModeratorResponses: false,
    sessionFile: built.sessionFile,
    cwd: hostCwd,
  });
  const identity = adoptOrValidateOwnerIdentity(host.runtime);
  assert.equal(identity.agentId, built.agentId);
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
  const setup = await setupPreadmissionRepairHost({
    captureRuntime: async () => host.runtime,
    entryModulePath: "<inline:pi-durable-subagents>",
    failure: new OwnerRecoveryError(
      "Owner coordination initialization",
      identity.agentId,
      built.sessionFile,
      admissionError,
    ),
    identifiedOwnerId: identity.agentId,
    ownerIdentified: true,
  });
  t.after(() => setup.coordinator.shutdown(async () => undefined).catch(() => undefined));
  const repairView = setup.resolvePreadmissionRepair();
  owner = repairView as ReturnType<WorkflowCoordinator["forAgent"]>;
  await bindTestOwnerHost(host, "tui");
  const frozenEntries = SessionManager.open(built.sessionFile).getEntries().length;
  let froze = false;
  let validated = false;
  let resolved = false;
  const moderatorRoute = (context: Context) => {
    if (!getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
      return fauxAssistantMessage("Owner idle; the repair Moderator owns this check.");
    }
    if (!froze) {
      froze = true;
      return fauxAssistantMessage(fauxToolCall("repair_freeze", {}, { id: "repair-freeze-bridge" }), { stopReason: "toolUse" });
    }
    if (!validated) {
      validated = true;
      return fauxAssistantMessage(
        fauxToolCall("repair_validate", { transcriptPaths: [built.sessionFile] }, { id: "repair-validate-bridge" }),
        { stopReason: "toolUse" },
      );
    }
    if (!resolved) {
      resolved = true;
      return fauxAssistantMessage(
        fauxToolCall("moderator_control", {
          operation: "resolve",
          summary: "Bridge repair triage complete",
          rationale: "Freeze and validate crossed the child bridge without dispatch errors.",
        }, { id: "repair-resolve-bridge" }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage("Repair triage complete; holding for human direction.");
  };
  host.model.setResponses(Array.from({ length: 12 }, () => moderatorRoute));
  const receipt = await repairView.requestManualRepair("Bridge drives freeze and validate.");
  assert.equal(receipt.disposition, "created");
  const moderatorId = receipt.moderatorAgentId;
  const repairDir = join(setup.coordinator.preadmissionRepairWorkflowDirectory(), "repair");
  let moderatorFile = "";
  await waitForBridge(async () => {
    for (const name of await readdir(repairDir).catch(() => [])) {
      if (name.endsWith(".jsonl")) {
        moderatorFile = join(repairDir, name);
        return true;
      }
    }
    return false;
  }, 30000, "repair Moderator transcript was not committed under repair/");
  const inputEntry = SessionManager.open(moderatorFile).getEntries()[0];
  assert.ok(inputEntry && inputEntry.type === "custom_message");
  const parsedInput = JSON.parse(inputEntry.content as string) as {
    trigger: { kind: string; reason: string };
    repairContext?: Record<string, unknown>;
    procedure?: string;
  };
  assert.deepEqual(parsedInput.trigger, { kind: "manual_repair", reason: "Bridge drives freeze and validate." });
  assert.equal(parsedInput.repairContext?.stage, "Owner coordination initialization");
  assert.ok(String(parsedInput.repairContext?.error).indexOf("duplicate Deliveries") !== -1);
  assert.equal(parsedInput.repairContext?.transcriptPath, built.sessionFile);
  assert.equal(parsedInput.repairContext?.ownerId, identity.agentId);
  assert.equal(parsedInput.repairContext?.workflowId, identity.agentId);
  assert.equal(parsedInput.repairContext?.workflowDirectory, setup.coordinator.preadmissionRepairWorkflowDirectory());
  assert.equal(parsedInput.procedure, MANUAL_REPAIR_PROCEDURE);
  await waitForBridge(() => {
    const result = findBridgeToolResult(moderatorFile, "repair-freeze-bridge");
    return result !== undefined && !result.isError;
  }, 60000, "repair_freeze did not succeed through the child bridge");
  const frozen = findBridgeToolResult(moderatorFile, "repair-freeze-bridge");
  assert.ok(frozen && !frozen.isError);
  assert.equal(typeof (frozen.details as { snapshotId?: unknown }).snapshotId, "string");
  assert.ok(Array.isArray((frozen.details as { entries?: unknown }).entries));
  await waitForBridge(() => {
    const result = findBridgeToolResult(moderatorFile, "repair-validate-bridge");
    return result !== undefined && !result.isError;
  }, 60000, "repair_validate did not succeed through the child bridge");
  const validatedResult = findBridgeToolResult(moderatorFile, "repair-validate-bridge");
  assert.ok(validatedResult && !validatedResult.isError);
  assert.equal((validatedResult.details as { advisory?: unknown }).advisory, true);
  assert.deepEqual(
    (validatedResult.details as { files?: Array<{ path: string }> }).files?.map((file) => file.path),
    [built.sessionFile],
  );
  await waitForBridge(() => {
    const result = findBridgeToolResult(moderatorFile, "repair-resolve-bridge");
    return result !== undefined && !result.isError;
  }, 60000, "repair Moderator resolve was not committed");
  await waitForBridge(
    () => setup.coordinator.forModerator(moderatorId).status().run.phase === "dormant",
    30000,
    "repair Moderator did not release to Dormant after resolve",
  );
  assert.equal(scanBridgeJsonl(moderatorFile, "is not a function"), 0);
  assert.equal(SessionManager.open(built.sessionFile).getEntries().length, frozenEntries);
});
