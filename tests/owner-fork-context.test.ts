import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { prepareBranchEntries, SessionManager, type SessionBeforeCompactEvent, type SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import { projectOwnerForkBranch, projectOwnerForkCompaction, projectOwnerForkContext } from "../src/pi-integration/owner-fork-context.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";

test("Owners without inherited model history receive no identity block or summary instructions", () => {
	for (const prefix of ["none", "settings", "identity-only"] as const) {
		const manager = SessionManager.inMemory();
		if (prefix === "settings") manager.appendCustomEntry("extension.settings", { enabled: true });
		if (prefix === "identity-only") manager.appendCustomEntry("agent-coordination.identity", { agentId: "source-owner" });
		appendOwnerIdentity(manager);
		const leaf = manager.appendMessage({ role: "user", content: "Current work only", timestamp: 1 });
		const transcript = transcriptFromSessionManager(manager).inspect();
		assert.deepEqual(projectOwnerForkContext({ transcript, messages: transcript.context.messages }), transcript.context.messages);
		const preparation: SessionBeforeCompactEvent["preparation"] = {
			messagesToSummarize: [...transcript.context.messages], turnPrefixMessages: [],
			isSplitTurn: false, firstKeptEntryId: leaf, tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		};
		const before = structuredClone(preparation);
		projectOwnerForkCompaction(preparation, transcript);
		assert.deepEqual(preparation, before);
		const branch = { entriesToSummarize: [...transcript.entries], customInstructions: "Keep my focus", userWantsSummary: true } as SessionBeforeTreeEvent["preparation"];
		assert.equal(projectOwnerForkBranch(branch, transcript), undefined);
		assert.deepEqual(branch.entriesToSummarize, transcript.entries);
	}
});

test("Owner identity leads inherited groups even on a branch before the current Identity", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "source-owner" });
	manager.appendMessage(fauxAssistantMessage([
		{ type: "text", text: "Preserve the source explanation." },
		fauxToolCall("bash", { command: "echo historical" }, { id: "old-call" }),
	]));
	manager.appendMessage({ role: "toolResult", toolCallId: "old-call", toolName: "bash", content: [{ type: "text", text: "historical result" }], isError: false, timestamp: 1 });
	const oldLeaf = manager.appendCustomMessageEntry("agent-coordination.message-delivery", "Inherited Request: do source work", true);
	appendOwnerIdentity(manager);
	manager.branch(oldLeaf);
	const before = JSON.stringify(manager.getEntries());
	const transcript = transcriptFromSessionManager(manager).inspect();
	const projected = projectOwnerForkContext({ transcript, messages: transcript.context.messages });
	assert.match(JSON.stringify(projected[0]), /Current Agent identity/);
	assert.match(JSON.stringify(projected[0]), new RegExp(manager.getSessionId()));
	assert.doesNotMatch(JSON.stringify(projected[0]), /Copied conversation|not current responsibilities|Preserve this distinction|only current-scope/);
	assert.equal(projected.filter(message => message.role === "toolResult").length, 0);
	assert.equal(projected.filter(message => message.role === "assistant").length, 1);
	const text = JSON.stringify(projected);
	assert.match(text, /Preserve the source explanation/);
	assert.match(text, /historical result/);
	assert.match(text, /Inherited Request: do source work/);
	assert.match(text, /source-owner/);
	assert.equal(text.split("^ ").length - 1, 2);
	assert.doesNotMatch(text, /! /);
	assert.equal(JSON.stringify(manager.getEntries()), before);
	assert.deepEqual(projectOwnerForkContext({ transcript, messages: projected }), projected);
});

test("new native calls appended beneath an inherited branch stay current across branch switches", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "source-owner" });
	const oldLeaf = manager.appendMessage({ role: "user", content: "Source work", timestamp: 1 });
	appendOwnerIdentity(manager);
	manager.branch(oldLeaf);
	const current = { ...fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request", targetAgent: "peer", title: "Current work", question: "Do current work" }, { id: "new-call" })), timestamp: 2 };
	const currentLeaf = manager.appendMessage(current);
	for (const leaf of [currentLeaf, oldLeaf, currentLeaf]) {
		manager.branch(leaf);
		const transcript = transcriptFromSessionManager(manager).inspect();
		const projected = projectOwnerForkContext({ transcript, messages: transcript.context.messages });
		assert.match(JSON.stringify(projected[0]), new RegExp(manager.getSessionId()));
		assert.doesNotMatch(JSON.stringify(projected), /\^ /);
		if (leaf === currentLeaf) assert.deepEqual(projected.at(-1), current);
	}
});

test("inherited summaries and orphan results retained after compaction remain attributed history", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "source-owner" });
	const call = manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "source-file" }, { id: "compacted-call" })));
	const receipt = manager.appendMessage({ role: "toolResult", toolCallId: "compacted-call", toolName: "read", content: [{ type: "text", text: "Retained source result" }], isError: false, timestamp: 2 });
	manager.appendCompaction("Source summary: finish source duties", receipt, 100);
	appendOwnerIdentity(manager);
	const transcript = transcriptFromSessionManager(manager).inspect();
	assert.equal(transcript.context.messages.some(message => message.role === "assistant"), false);
	const projected = projectOwnerForkContext({ transcript, messages: transcript.context.messages });
	assert.equal(projected.some(message => message.role === "toolResult" || message.role === "compactionSummary"), false);
	assert.match(JSON.stringify(projected), /Retained source result/);
	assert.match(JSON.stringify(projected), /Source summary: finish source duties/);
	assert.equal(JSON.stringify(projected).split("^ ").length - 1, 2);
	assert.ok(call);
});

test("multiple inherited identities retain per-source attribution without trusting copied identities", () => {
	const manager = SessionManager.inMemory();
	for (const source of ["original-owner", "intermediate-owner"]) {
		manager.appendCustomEntry("agent-coordination.identity", { agentId: source });
		manager.appendCustomMessageEntry("agent-coordination.workflow-continuation", `Continue ${source} work`, true);
	}
	appendOwnerIdentity(manager);
	const transcript = transcriptFromSessionManager(manager).inspect();
	const projected = projectOwnerForkContext({ transcript, messages: transcript.context.messages });
	assert.match(JSON.stringify(projected[1]), /"agentId":"original-owner"/);
	assert.match(JSON.stringify(projected[2]), /"agentId":"intermediate-owner"/);
	assert.match(JSON.stringify(projected[0]), new RegExp(manager.getSessionId()));
});

test("without a canonical current Owner Identity projection does not invent Owner authority", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "copied-owner" });
	manager.appendMessage({ role: "user", content: "No current identity", timestamp: 1 });
	const transcript = transcriptFromSessionManager(manager).inspect();
	assert.deepEqual(projectOwnerForkContext({ transcript, messages: transcript.context.messages }), transcript.context.messages);
});

test("native history before any source Identity stays explicitly unattributed", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "pre-bootstrap-file" }, { id: "pre-bootstrap-call" })));
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "later-source-owner" });
	appendOwnerIdentity(manager);
	const transcript = transcriptFromSessionManager(manager).inspect();
	const projected = projectOwnerForkContext({ transcript, messages: transcript.context.messages });
	const marked = projected.find(message => message.role === "custom" && message.customType === "agent-coordination.context-only");
	assert.ok(marked?.role === "custom" && Array.isArray(marked.content));
	const text = marked.content.find(part => part.type === "text");
	assert.ok(text?.type === "text");
	assert.match(JSON.parse(text.text.slice(2)).source.agentId, /unknown/);
});

test("compaction annotates inherited previous summaries and split-turn input without modifying durable entries", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "source-owner" });
	const leaf = manager.appendMessage({ role: "user", content: "Source task", timestamp: 1 });
	manager.appendCompaction("Old source duties", leaf, 100);
	appendOwnerIdentity(manager);
	const transcript = transcriptFromSessionManager(manager).inspect();
	const before = JSON.stringify(transcript.entries);
	const preparation: SessionBeforeCompactEvent["preparation"] = {
		messagesToSummarize: [], turnPrefixMessages: [{ role: "user", content: "Retained source text", timestamp: 2 }],
		isSplitTurn: true, firstKeptEntryId: leaf, tokensBefore: 100, previousSummary: "Old source duties",
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
	};
	projectOwnerForkCompaction(preparation, transcript);
	assert.match(JSON.stringify(preparation.messagesToSummarize[0]), /Current Agent identity/);
	assert.match(JSON.stringify(preparation.turnPrefixMessages[0]), /Current Agent identity/);
	assert.match(JSON.stringify(preparation.messagesToSummarize), /not current responsibilities/);
	assert.match(JSON.stringify(preparation.turnPrefixMessages), /not current responsibilities/);
	assert.match(preparation.previousSummary!, /^\^ /);
	assert.match(preparation.previousSummary!, /Old source duties/);
	assert.equal(preparation.firstKeptEntryId, leaf);
	assert.equal(preparation.tokensBefore, 100);
	assert.equal(JSON.stringify(transcript.entries), before);
	const projected = structuredClone(preparation);
	projectOwnerForkCompaction(preparation, transcript);
	assert.deepEqual(preparation, projected, "repeated preparation must not accumulate identity or guidance");
});

test("branch annotation preserves native file tracking, summaries, and user summary instructions", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "source-owner" });
	const leaf = manager.appendMessage(fauxAssistantMessage([
		{ type: "thinking", thinking: "Source reasoning", thinkingSignature: "signed" },
		fauxToolCall("read", { path: "source.txt" }, { id: "source-read" }),
	]));
	manager.appendCustomMessageEntry("agent-coordination.message-delivery", "Source Delivery", true);
	manager.appendCompaction("Source summary", leaf, 100);
	appendOwnerIdentity(manager);
	const transcript = transcriptFromSessionManager(manager).inspect();
	const original = JSON.stringify(transcript.entries);
	const preparation = {
		entriesToSummarize: [...transcript.entries], customInstructions: "Preserve my chosen summary focus", userWantsSummary: true,
	} as SessionBeforeTreeEvent["preparation"];
	const instructions = projectOwnerForkBranch(preparation, transcript);
	assert.match(instructions!, /Preserve my chosen summary focus/);
	assert.match(instructions!, /Current Agent identity/);
	assert.match(instructions!, /not current responsibilities/);
	const native = prepareBranchEntries(preparation.entriesToSummarize);
	assert.deepEqual([...native.fileOps.read], ["source.txt"]);
	assert.match(JSON.stringify(native.messages), /\^ .*source-read/);
	assert.match(JSON.stringify(native.messages), /\^ .*Source Delivery/);
	assert.match(JSON.stringify(native.messages), /\^ .*Source summary/);
	assert.equal(JSON.stringify(transcript.entries), original);
});

function appendOwnerIdentity(manager: SessionManager): void {
	manager.appendCustomEntry("agent-coordination.identity", {
		agentId: manager.getSessionId(), workflowId: manager.getSessionId(), directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" },
	});
}
