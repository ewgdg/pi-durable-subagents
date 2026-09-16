import assert from "node:assert/strict";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { parseRepairTranscript } from "../src/repair/native-transcript.ts";

const header = { type: "session", version: CURRENT_SESSION_VERSION, id: "session-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" };
const entry = (id: string, parentId: string | null, fields: object) => ({ id, parentId, timestamp: header.timestamp, ...fields });
const encode = (...entries: object[]) => [header, ...entries].map(value => JSON.stringify(value)).join("\n") + "\n";

test("repair inspection retains inactive physical entries and selects the last physical leaf", () => {
	const entries = [
		entry("a", null, { type: "message", message: { role: "user", content: "hello", timestamp: 1 } }),
		entry("b", "a", { type: "custom", customType: "extension", data: [null, { arbitrary: true }] }),
		entry("c", "a", { type: "session_info", name: "branch" }),
	];
	const result = parseRepairTranscript(encode(...entries), "/tmp/repair.jsonl");
	assert.deepEqual(result.entries, entries);
	assert.deepEqual(result.activeBranch.map(value => value.id), ["a", "c"]);
	assert.equal(result.transcriptPath, "/tmp/repair.jsonl");
});

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 1, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = { role: "assistant", timestamp: 1, api: "custom-api", provider: "custom-provider", model: "model", content: [{ type: "text", text: "answer", textSignature: "opaque" }, { type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" }, { type: "toolCall", id: "call", name: "tool", arguments: { arbitrary: null }, namespace: "tools", thoughtSignature: "opaque" }], usage, stopReason: "deferred", deferred: { provider: "p", modelId: "m", api: "a", id: "job", expiresAt: 1, pollAfterMs: 2, data: [null] }, diagnostics: [{ type: "provider-event", timestamp: 1, error: { message: "error", code: 123 }, details: { arbitrary: [] } }], endTurn: false };

test("all installed native entry and message variants preserve optional and extension payloads", () => {
	const messages = [assistant,
		{ role: "toolResult", timestamp: 1, toolCallId: "call", toolName: "tool", content: [{ type: "image", data: "abc", mimeType: "image/png" }], isError: false, usage, addedToolNames: ["extra"], details: [null] },
		{ role: "bashExecution", timestamp: 1, command: "true", output: "", cancelled: false, truncated: false, excludeFromContext: true },
		{ role: "custom", timestamp: 1, customType: "extension", content: "custom", display: false, details: 1 },
		{ role: "branchSummary", timestamp: 1, fromId: null, summary: "branch" },
		{ role: "compactionSummary", timestamp: 1, tokensBefore: 3, summary: "compact" },
	];
	const fields = [...messages.map(message => ({ type: "message", message })),
		{ type: "model_change", provider: "p", modelId: "m" }, { type: "thinking_level_change", thinkingLevel: "custom-level" },
		{ type: "compaction", summary: "summary", firstKeptEntryId: "0", tokensBefore: 3, usage, fromHook: true, details: null },
		{ type: "branch_summary", summary: "branch", fromId: "0", usage, fromHook: false },
		{ type: "custom_message", customType: "extension", content: [{ type: "text", text: "custom" }], display: true, details: null },
		{ type: "label", targetId: "0" }, { type: "session_info" },
	];
	const entries = fields.map((fields, index) => entry(String(index), index ? String(index - 1) : null, fields));
	assert.deepEqual(parseRepairTranscript(encode(...entries), "native").entries, entries);
});

test("rejects malformed JSONL, headers and graph records with physical line diagnostics", () => {
	const valid = entry("a", null, { type: "custom", customType: "extension" });
	for (const contents of ["", "[]", JSON.stringify({ ...header, version: 2 }), JSON.stringify({ ...header, cwd: 3 }), encode(valid) + "{", encode(valid) + "\n", encode(valid, valid), encode(entry("b", "missing", { type: "session_info" })), encode(valid, header), encode(entry("b", null, { type: "unknown" }))]) {
		assert.throws(() => parseRepairTranscript(contents, "broken.jsonl"), /broken\.jsonl: line \d+/);
	}
});

test("rejects malformed native messages and known optional fields", () => {
	for (const message of [
		{ ...assistant, timestamp: null }, { ...assistant, stopReason: "pending" }, { ...assistant, content: [{ type: "audio" }] },
		{ ...assistant, usage: { ...usage, cost: {} } }, { ...assistant, deferred: { id: "job" } },
		{ ...assistant, diagnostics: [{ type: "event", timestamp: "wrong" }] },
		{ role: "user", timestamp: 1, content: [{ type: "toolCall", id: "a", name: "tool", arguments: {} }] },
		{ role: "toolResult", timestamp: 1, toolCallId: "a", toolName: "tool", content: [], isError: false, addedToolNames: [1] },
		{ role: "custom", timestamp: 1, customType: "extension", content: "text", display: "true" },
		{ role: "unrecognized", timestamp: 1 },
	]) assert.throws(() => parseRepairTranscript(encode(entry("a", null, { type: "message", message })), "bad-message"), /line 2 entry a/);
});

test("native references accept non-message targets and reset roots but reject missing targets", () => {
	const base = entry("a", null, { type: "model_change", provider: "p", modelId: "m" });
	assert.doesNotThrow(() => parseRepairTranscript(encode(base, entry("b", "a", { type: "compaction", firstKeptEntryId: "a", tokensBefore: 1, summary: "" })), "valid"));
	assert.doesNotThrow(() => parseRepairTranscript(encode(entry("a", null, { type: "branch_summary", fromId: "root", summary: "" })), "valid"));
	for (const fields of [{ type: "label", targetId: "missing" }, { type: "branch_summary", fromId: "missing", summary: "" }, { type: "compaction", firstKeptEntryId: "missing", tokensBefore: 1, summary: "" }]) {
		assert.throws(() => parseRepairTranscript(encode(base, entry("b", "a", fields)), "bad-reference"), /line 3 entry b/);
	}
	assert.throws(() => parseRepairTranscript(encode(base, entry("b", null, { type: "session_info" }), entry("c", "b", { type: "compaction", firstKeptEntryId: "a", tokensBefore: 1, summary: "" })), "wrong-branch"), /parent branch/);
	const fork = { ...header, parentSession: "/original.jsonl" };
	assert.doesNotThrow(() => parseRepairTranscript([fork, entry("a", null, { type: "branch_summary", fromId: "omitted-origin", summary: "" })].map(value => JSON.stringify(value)).join("\n"), "fork"));
});

test("fails closed on newer retained-tail checkpoints the installed runtime cannot rebuild", () => {
	const base = entry("a", null, { type: "session_info" });
	assert.throws(() => parseRepairTranscript(encode(base, entry("b", "a", { type: "compaction", firstKeptEntryId: "a", retainedTail: [], tokensBefore: 1, summary: "" })), "checkpoint"), /line 3 entry b: retainedTail compactions are unsupported/);
});

test("requires exact supported header fields and an absolute working directory", () => {
	for (const invalid of [{ ...header, futureField: true }, { ...header, cwd: "relative/path" }, { ...header, id: "bad\0id" }]) {
		assert.throws(() => parseRepairTranscript(JSON.stringify(invalid), "header"), /line 1/);
	}
});

test("rejects NUL in native entry identifiers and references including fork origins", () => {
	const fork = { ...header, parentSession: "/original.jsonl" };
	for (const invalid of [
		entry("bad\0id", null, { type: "session_info" }),
		entry("a", "bad\0id", { type: "session_info" }),
		entry("a", null, { type: "branch_summary", fromId: "bad\0id", summary: "" }),
		entry("a", null, { type: "label", targetId: "bad\0id" }),
		entry("a", null, { type: "compaction", firstKeptEntryId: "bad\0id", summary: "", tokensBefore: 1 }),
		entry("a", null, { type: "message", message: { role: "branchSummary", fromId: "bad\0id", summary: "", timestamp: 1 } }),
	]) assert.throws(() => parseRepairTranscript([fork, invalid].map(value => JSON.stringify(value)).join("\n"), "nul"), /NUL/);
});

test("accepts a native fixture generated by the repository-resolved Pi runtime", () => {
	const manager = SessionManager.inMemory("/tmp");
	const userId = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	manager.appendModelChange("custom-provider", "model");
	manager.appendThinkingLevelChange("high");
	manager.appendCustomEntry("extension", { arbitrary: [null] });
	manager.appendCustomMessageEntry("extension", "custom", true, { arbitrary: true });
	manager.appendCompaction("summary", userId, 1);
	manager.appendLabelChange(userId, "bookmark");
	manager.appendSessionInfo("fixture");
	manager.branchWithSummary(userId, "branch");
	const contents = [manager.getHeader(), ...manager.getEntries()].map(value => JSON.stringify(value)).join("\n");
	const result = parseRepairTranscript(contents, "native-fixture");
	assert.deepEqual(result.entries, JSON.parse(JSON.stringify(manager.getEntries())));
	assert.deepEqual(result.activeBranch, JSON.parse(JSON.stringify(manager.getBranch())));
	assert.deepEqual(result.context, manager.buildSessionContext());
});
