import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { resolveCommittedToolCall } from "../src/protocol/identities.ts";

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
