// Generates a genuinely admission-blocking Owner session for the live repair demo.
//
// Broken shape (deterministic on current main): duplicate valid Owner Message
// Deliveries for one committed Request source. Both delivery records pass schema
// validation, so cold discovery cannot quarantine them. WorkflowCoordinator
// initialize -> refreshTranscriptFacts throws ProtocolInvariantError
// with duplicate Deliveries, owner-bootstrap wraps it as OwnerRecoveryError,
// and the TUI offers /agents diagnostics plus manual repair.
//
// Run from the repo root with npx tsx demos/make-broken-session.ts
//
// Output: exactly one self-contained file under demos/broken-session/ (no child
// participant files needed: the contradiction lives entirely in the Owner
// transcript). The script ends with a trailing assistant appendMessage so the
// buffered custom entries actually flush to disk (SessionManager only writes
// the file once the first assistant message arrives).
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { deriveMessageIdentity, ProtocolInvariantError } from "../src/protocol/identities.ts";
import { createMessageDelivery, inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import { transcriptFromSessionFile } from "../src/pi-integration/session-manager-transcript.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = join(repoRoot, "demos", "broken-session");

await mkdir(outDir, { recursive: true });
for (const name of await readdir(outDir)) {
  if (name.endsWith(".jsonl")) await rm(join(outDir, name));
}

// Header cwd is the repo root so pi opened from the repo sees matching native config.
// Session dir is demos/broken-session so the workflow dir (if any children existed)
// would be demos/broken-session/pi-durable-subagents per workflow id.
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
// Both records pass schema validation; their contradiction must still fail admission.
for (let copy = 0; copy < 2; copy++) {
  owner.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
}
// Flush buffered custom entries to disk (custom-only entries buffer until an
// assistant message arrives).
owner.appendMessage(fauxAssistantMessage("Persist broken-session flush."));

const sessionFile = owner.getSessionFile();
if (!sessionFile) throw new Error("Generator failed: broken session has no file");

// Fail fast: the committed file must still carry the duplicate-delivery
// contradiction when read fresh from disk (not just in-memory).
const inspection = await transcriptFromSessionFile(sessionFile, { fresh: true }).refresh();
let duplicate: unknown;
try {
  inspectMessageDeliveries({ recipientAgentId: agentId, transcript: inspection });
} catch (error) {
  duplicate = error;
}
const detail = duplicate instanceof Error ? duplicate.message : String(duplicate);
if (!(duplicate instanceof ProtocolInvariantError) || detail.indexOf("duplicate Deliveries") < 0) {
  throw new Error("Generator verification failed: fresh file read did not throw duplicate Deliveries (got: " + detail + ")");
}

const entryCount = inspection.entries.length;
console.log("broken session: " + sessionFile);
console.log("workflowId (Owner agentId): " + agentId);
console.log("entries: " + entryCount + " (identity + request + result + 2x delivery + flush)");
console.log("fresh-file check: ProtocolInvariantError: " + detail);
console.log("");
console.log("Launch (from repo root, loads CURRENT checkout code, not the stale installed copy):");
// -ne disables extension discovery (the stale installed copy registers the same
// tools and conflicts); the explicit -e path still loads per pi --help.
console.log("pi --session " + JSON.stringify(sessionFile) + " -ne -e " + JSON.stringify(join(repoRoot, "src", "index.ts")));
