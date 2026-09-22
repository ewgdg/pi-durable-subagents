// Shared builder: a genuinely admission-blocking Owner session.
// Duplicate valid Message Deliveries for one committed Request source pass
// schema validation, so cold discovery cannot quarantine them;
// refreshTranscriptFacts throws ProtocolInvariantError (duplicate Deliveries).
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { deriveMessageIdentity } from "../../src/protocol/identities.ts";
import { createMessageDelivery } from "../../src/protocol/message-delivery.ts";

export async function buildBrokenOwnerSession(outDir: string, repoRoot: string): Promise<{ sessionFile: string; agentId: string }> {
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
  if (!sessionFile) throw new Error("Fixture failed: broken session has no file");
  return { sessionFile, agentId };
}
