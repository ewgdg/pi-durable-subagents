// Smoke test + live-demo materializer: a genuinely admission-blocking Owner
// session (duplicate valid Message Deliveries for one committed Request
// source). Both delivery records pass schema validation, so cold discovery
// cannot quarantine them; refreshTranscriptFacts throws ProtocolInvariantError
// (duplicate Deliveries), owner-bootstrap wraps it as OwnerRecoveryError, and
// the failed-admission surface offers manual repair.
//
// The session is built in the OS temp dir (never committed). The test prints
// its absolute path plus the pi launch command for a live /agents repair walk.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { deriveMessageIdentity, ProtocolInvariantError } from "../src/protocol/identities.ts";
import { createMessageDelivery, inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import { transcriptFromSessionFile } from "../src/pi-integration/session-manager-transcript.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("broken Owner session blocks admission and prints its live-demo path", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "repair-broken-smoke-"));
  const owner = SessionManager.create(repoRoot, outDir);
  const agentId = owner.getSessionId();
  owner.appendCustomEntry("agent-coordination.identity", {
    agentId,
    workflowId: agentId,
    directSpawnerAgentId: null,
    metadata: { label: "Owner", description: "Workflow Owner" },
  });
  const callId = "duplicate-valid-delivery-source";
  const entryId = owner.appendMessage(
    fauxAssistantMessage(
      fauxToolCall(
        "agent_message",
        {
          operation: "request",
          targetAgent: agentId,
          title: "Conflicting valid delivery",
          question: "One source cannot have two recipient Deliveries.",
        },
        { id: callId },
      ),
      { stopReason: "toolUse" },
    ),
  );
  const source = { agentId, entryId, toolCallId: callId };
  const messageId = deriveMessageIdentity(source);
  owner.appendMessage({
    role: "toolResult",
    toolName: "agent_message",
    toolCallId: callId,
    content: [{ type: "text", text: "sent" }],
    details: { requestMessageId: messageId, targetAgentId: agentId, messageStatus: "sent" },
    isError: false,
    timestamp: Date.now(),
  } as never);
  const delivery = createMessageDelivery([
    {
      source,
      projection: {
        kind: "request",
        requestMessageId: messageId,
        fromAgentId: agentId,
        title: "Conflicting valid delivery",
        question: "One source cannot have two recipient Deliveries.",
      },
    },
  ]);
  for (let copy = 0; copy < 2; copy++) {
    owner.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
  }
  // Custom-only entries buffer until an assistant message arrives.
  owner.appendMessage(fauxAssistantMessage("Persist broken-session flush."));
  const sessionFile = owner.getSessionFile();
  assert.ok(sessionFile, "broken session has no file");
  const inspection = await transcriptFromSessionFile(sessionFile, { fresh: true }).refresh();
  assert.throws(
    () => inspectMessageDeliveries({ recipientAgentId: agentId, transcript: inspection }),
    (error: unknown) => error instanceof ProtocolInvariantError && String((error as Error).message).indexOf("duplicate Deliveries") >= 0,
    "fresh file read must throw duplicate Deliveries",
  );
  console.log("broken session: " + sessionFile);
  console.log("launch: pi --session " + JSON.stringify(sessionFile) + " -ne -e " + JSON.stringify(join(repoRoot, "src", "index.ts")));
});
