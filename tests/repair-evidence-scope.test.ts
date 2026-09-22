// Item 2 (isolation at the source): RequestEvidence honors the repair-host
// evidence scope. The retired broken Owner record never enters relationship,
// inspection, or delivery-evidence traversals, so the repair Moderator's
// start/view/validate reads stay clean with no ProtocolInvariantError to catch.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { transcriptFromSessionFile } from "../src/pi-integration/session-manager-transcript.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { buildBrokenOwnerSession } from "./support/broken-session-fixture.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function makeRecords() {
  const outDir = await mkdtemp(join(tmpdir(), "repair-evidence-scope-"));
  const built = await buildBrokenOwnerSession(outDir, repoRoot);
  const modManager = SessionManager.inMemory(repoRoot);
  const modId = "moderator-scope-1";
  modManager.appendCustomEntry("agent-coordination.identity", {
    agentId: modId, workflowId: built.agentId, directSpawnerAgentId: null,
    creationPreset: null, metadata: { label: "Moderator", description: "Repair Moderator" },
  });
  modManager.appendMessage(fauxAssistantMessage("Repair triage holding."));
  const stubHost = { observe: () => ({ phase: "dormant" }) } as never;
  const agents = new Map<string, never>([
    [built.agentId, {
      identity: {
        agentId: built.agentId, workflowId: built.agentId, directSpawnerAgentId: null,
        metadata: { label: "Owner", description: "Workflow Owner" },
      },
      host: stubHost,
      transcript: transcriptFromSessionFile(built.sessionFile, { fresh: true }),
      children: [],
    } as never],
    [modId, {
      identity: {
        agentId: modId, workflowId: built.agentId, directSpawnerAgentId: null,
        creationPreset: null, metadata: { label: "Moderator", description: "Repair Moderator" },
      },
      host: stubHost,
      transcript: transcriptFromSessionManager(modManager),
      children: [],
    } as never],
  ]);
  const deliveryEntry = SessionManager.open(built.sessionFile).getEntries().find(
    (entry) => entry.type === "custom_message" && entry.customType === "agent-coordination.message-delivery",
  );
  assert.ok(deliveryEntry?.type === "custom_message");
  const dupId = (JSON.parse((deliveryEntry as unknown as { content: string }).content) as {
    messages: { requestMessageId: string }[];
  }).messages[0]!.requestMessageId;
  return { agents, modId, ownerId: built.agentId, dupId };
}

test("unscoped traversals over broken Owner evidence throw duplicate Deliveries", async () => {
  const { agents } = await makeRecords();
  const evidence = new RequestEvidence(agents as never);
  await assert.rejects(
    evidence.refreshRelationships(),
    (error: unknown) =>
      error instanceof ProtocolInvariantError && error.message.indexOf("duplicate Deliveries") !== -1,
  );
});

test("scoped repair evidence never touches retired Owner bytes", async () => {
  const { agents, modId, ownerId, dupId } = await makeRecords();
  const evidence = new RequestEvidence(
    agents as never,
    new Set(),
    new Set(),
    (agentId) => agentId !== ownerId,
  );
  const mod = agents.get(modId) as never;
  assert.deepEqual(evidence.obligationFrames(mod), []);
  assert.deepEqual(evidence.openIncomingRequests(mod), { requests: [] });
  assert.deepEqual(evidence.outstandingRequestIdsFor(mod), []);
  assert.equal(evidence.findRequest(dupId), undefined);
  await assert.rejects(
    (async () => evidence.requestMetadata(dupId))(),
    (error: unknown) =>
      error instanceof Error &&
      error.message.indexOf("unknown_identity") !== -1 &&
      error.message.indexOf("duplicate Deliveries") === -1,
  );
  const inspections = await evidence.refreshRelationships();
  assert.deepEqual(
    [...inspections.keys()].map((record) => (record as { identity: { agentId: string } }).identity.agentId),
    [modId],
  );
});
