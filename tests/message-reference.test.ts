import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { resolveMessageReference } from "../src/protocol/message-reference.ts";

test("Message references reconstruct the original target despite a later suffix collision", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "message-reference-")), "session.jsonl");
	// These two native sources have distinct hash IDs ending in s.
	const firstId = "QXZlXj0lFpyCtwX-RMT9YFphamPL52r6e1I8a0LnPMs";
	const laterId = "-iqhIKrd3olW7SZX1yg-bSxp00YSYC4lmzEDjKSTrNs";
	const timestamp = "2026-09-07T00:00:00.000Z";
	const entries = [
		{ type: "session", version: 3, id: "author", timestamp, cwd: process.cwd() },
		{ type: "custom", id: "identity", parentId: null, timestamp, customType: "agent-coordination.identity", data: { agentId: "author" } },
		call("first-entry", "identity", "first", { operation: "send", targetAgent: "recipient", content: "First" }),
		call("poll-entry", "first-entry", "poll", { operation: "poll", messageId: "s" }),
	];
	const source = { agentId: "author", entryId: "poll-entry", toolCallId: "poll" };
	await writeFile(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const read = () => transcriptFromSessionManager(SessionManager.open(path)).inspect();
	assert.equal(resolveMessageReference(read(), source, " s "), firstId);
	assert.equal(resolveMessageReference(read(), source, laterId), laterId);
	entries.push(
		call("later-entry", "poll-entry", "later-25", { operation: "send", targetAgent: "recipient", content: "Later" }),
		call("new-poll-entry", "later-entry", "new-poll", { operation: "poll", messageId: "s" }),
	);
	await writeFile(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const reopened = read();
	assert.equal(resolveMessageReference(reopened, source, "s"), firstId);
	assert.throws(() => resolveMessageReference(reopened, source, laterId.slice(-8)), /unknown_identity/);
	assert.equal(resolveMessageReference(reopened, source, laterId), laterId);
	const laterSource = { agentId: "author", entryId: "new-poll-entry", toolCallId: "new-poll" };
	assert.throws(() => resolveMessageReference(reopened, laterSource, "s"), /ambiguous_target/);
	assert.equal(resolveMessageReference(reopened, laterSource, firstId), firstId);
	assert.equal(resolveMessageReference(reopened, laterSource, laterId), laterId);
	assert.throws(() => resolveMessageReference(reopened, laterSource, ""), /invalid_input/);
	assert.throws(() => resolveMessageReference(reopened, laterSource, "missing"), /unknown_identity/);

	function call(id: string, parentId: string, toolCallId: string, input: Record<string, unknown>) {
		return { type: "message", id, parentId, timestamp, message: fauxAssistantMessage(fauxToolCall("agent_message", input as JsonObject, { id: toolCallId })) };
	}
});
