import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { callerRequestTitle } from "../src/protocol/agent-wait.ts";
import { deriveMessageIdentity, resolveCommittedToolCall } from "../src/protocol/identities.ts";

function sessionWithDuplicateExecCall(): {
	manager: SessionManager;
	agentId: string;
	secondEntryId: string;
} {
	const agentId = "agent-duplicate-exec";
	const manager = SessionManager.inMemory("/workflow", { id: agentId });
	manager.appendCustomEntry("agent-coordination.identity", { agentId });
	manager.appendMessage(
		fauxAssistantMessage(fauxToolCall("exec", { command: "echo first" }, { id: "call_dup" })),
	);
	const secondEntryId = manager.appendMessage(
		fauxAssistantMessage(fauxToolCall("exec", { command: "echo second" }, { id: "call_dup" })),
	);
	return { manager, agentId, secondEntryId };
}

test("a reused native tool call id resolves to its latest committed source", () => {
	const { manager, agentId, secondEntryId } = sessionWithDuplicateExecCall();
	const transcript = transcriptFromSessionManager(manager).inspect();
	const { source, input } = resolveCommittedToolCall({
		agentId,
		transcript,
		toolCallId: "call_dup",
		toolName: "exec",
	});
	assert.equal(source.entryId, secondEntryId);
	assert.deepEqual(input, { command: "echo second" });
});

test("a missing tool call still fails its commit proof", () => {
	const { manager, agentId } = sessionWithDuplicateExecCall();
	const transcript = transcriptFromSessionManager(manager).inspect();
	assert.throws(
		() =>
			resolveCommittedToolCall({
				agentId,
				transcript,
				toolCallId: "call_missing",
				toolName: "exec",
			}),
		/found 0/,
	);
});

test("a tool call committed under another name still fails", () => {
	const { manager, agentId } = sessionWithDuplicateExecCall();
	const transcript = transcriptFromSessionManager(manager).inspect();
	assert.throws(
		() =>
			resolveCommittedToolCall({
				agentId,
				transcript,
				toolCallId: "call_dup",
				toolName: "agent_message",
			}),
		/not agent_message/,
	);
});

test("a reused request call id resolves its title from the source entry", () => {
	const agentId = "agent-duplicate-request";
	const manager = SessionManager.inMemory("/workflow", { id: agentId });
	manager.appendCustomEntry("agent-coordination.identity", { agentId });
	const firstEntryId = manager.appendMessage(
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Original title", request: "Do the work." }, { id: "call_req" })),
	);
	// A retried turn reuses the same native id for an unrelated tool.
	manager.appendMessage(
		fauxAssistantMessage(fauxToolCall("exec", { command: "echo reuse" }, { id: "call_req" })),
	);
	const transcript = transcriptFromSessionManager(manager).inspect();
	const requestMessageId = deriveMessageIdentity({ agentId, entryId: firstEntryId, toolCallId: "call_req" });
	assert.equal(callerRequestTitle({ agentId, transcript, requestMessageId }), "Original title");
});
