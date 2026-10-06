import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveModeratorAgentMetadata } from "../src/protocol/agent-metadata.ts";
import { validateColdChildIdentity } from "../src/protocol/child-identity.ts";
import { createModelVisibleModeratorInput } from "../src/protocol/moderator-input.ts";
import {
	AgentTranscript,
	type TranscriptInspection,
	type TranscriptReader,
} from "../src/transcript/agent-transcript.ts";
import {
	materializeNewAgentTranscript,
	transcriptFromSessionFile,
	transcriptFromSessionManager,
} from "../src/pi-integration/session-manager-transcript.ts";

test("AgentTranscript asks its reader for a fresh inspection every time", () => {
	const inspections: TranscriptInspection[] = [
		inspection("agent-1", "entry-1"),
		inspection("agent-1", "entry-2"),
	];
	let reads = 0;
	const reader: TranscriptReader = {
		read() {
			return inspections[reads++]!;
		},
	};
	const transcript = new AgentTranscript(reader);

	assert.equal(transcript.inspect(), inspections[0]);
	assert.equal(transcript.inspect(), inspections[1]);
	assert.equal(reads, 2);
});

test("local SessionManager consumers share retained transcript evidence", () => {
	const sessionManager = SessionManager.inMemory("/workflow", { id: "agent-1" });
	sessionManager.appendCustomEntry("agent-coordination.identity", { agentId: "agent-1" });
	const transcript = transcriptFromSessionManager(sessionManager);

	const before = transcript.inspect();
	sessionManager.appendCustomEntry("agent-coordination.marker", { sequence: 2 });
	const after = transcript.inspect();

	assert.equal(before.sessionId, "agent-1");
	assert.equal(before.transcriptPath, null);
	assert.equal(before.header?.cwd, "/workflow");
	assert.equal(before.entries.length, 2);
	assert.equal(before.activeBranch.length, 2);
	assert.equal(after.entries.length, 2);
	assert.equal(after.activeBranch.length, 2);
	assert.equal(before, after);
	assert.equal(before.entries, after.entries);
	assert.equal(before.activeBranch, after.activeBranch);
});

test("new Agent transcript materialization persists only its creation Identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-materialize-"));
	const prepared = SessionManager.create(root, join(root, "sessions"), {
		id: "agent-materialized",
	});
	prepared.appendCustomEntry("agent-coordination.identity", {
		agentId: "agent-materialized",
		workflowId: "workflow-materialized",
		directSpawnerAgentId: "parent-materialized",
		creationPreset: null,
		spawnSource: {
			agentId: "parent-materialized",
			entryId: "spawn-entry",
			toolCallId: "spawn-tool-call",
		},
		metadata: { label: "materialized" },
	});

	const sessionFile = await materializeNewAgentTranscript(prepared);
	const reopened = SessionManager.open(sessionFile);

	assert.equal(reopened.getSessionId(), "agent-materialized");
	assert.equal(reopened.getEntries().length, 1);
	assert.equal(reopened.getEntries()[0]?.type, "custom");
	await assert.rejects(
		materializeNewAgentTranscript(prepared),
		/transcript already exists/,
	);
});

test("new Agent transcript header uses the first Runtime working directory without storing it in Identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-effective-cwd-"));
	const effectiveCwd = join(root, "child");
	const prepared = SessionManager.create(effectiveCwd, join(root, "sessions"), {
		id: "agent-effective-cwd",
	});
	prepared.appendCustomEntry("agent-coordination.identity", {
		agentId: "agent-effective-cwd",
		workflowId: "workflow-effective-cwd",
		directSpawnerAgentId: "parent-effective-cwd",
		creationPreset: null,
		spawnSource: {
			agentId: "parent-effective-cwd",
			entryId: "spawn-entry",
			toolCallId: "spawn-tool-call",
		},
		metadata: { label: "effective-cwd" },
	});

	const sessionFile = await materializeNewAgentTranscript(prepared);
	const reopened = SessionManager.open(sessionFile);
	assert.equal(reopened.getHeader()?.cwd, effectiveCwd);
	const identityEntry = reopened.getEntries()[0];
	assert.deepEqual(identityEntry?.type === "custom"
		? identityEntry.data
		: undefined, {
		agentId: "agent-effective-cwd",
		workflowId: "workflow-effective-cwd",
		directSpawnerAgentId: "parent-effective-cwd",
		creationPreset: null,
		spawnSource: {
			agentId: "parent-effective-cwd",
			entryId: "spawn-entry",
			toolCallId: "spawn-tool-call",
		},
		metadata: { label: "effective-cwd" },
	});
});

test("new Moderator transcript materialization validates its Input bootstrap", async () => {
	const root = await mkdtemp(join(tmpdir(), "moderator-transcript-materialize-"));
	const prepared = SessionManager.create(root, join(root, "sessions"), {
		id: "moderator-materialized",
	});
	const identity = {
		agentId: "moderator-materialized",
		workflowId: "workflow-materialized",
		directSpawnerAgentId: null,
		creationPreset: null,
		metadata: resolveModeratorAgentMetadata("operation_review"),
	} as const;
	const input = {
		trigger: {
			kind: "operation_review" as const,
			toolCall: {
				agentId: "reviewed-agent",
				entryId: "reviewed-entry",
				toolCallId: "reviewed-tool-call",
			},
			reviewIntervalMs: 1_000,
		},
		inspectedThrough: [{ agentId: "reviewed-agent", entryId: "reviewed-tail" }],
	};
	const modelInput = createModelVisibleModeratorInput(identity, input);
	prepared.appendCustomMessageEntry(
		modelInput.customType,
		modelInput.content,
		modelInput.display,
		modelInput.details,
	);

	const sessionFile = await materializeNewAgentTranscript(prepared);
	const reopened = SessionManager.open(sessionFile);
	assert.equal(reopened.getEntries().length, 1);
	assert.equal(reopened.getHeader()?.cwd, root);
});

test("transcript materialization rejects missing role bootstrap evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-invalid-bootstrap-"));
	const prepared = SessionManager.create(root, join(root, "sessions"), {
		id: "agent-invalid-bootstrap",
	});
	prepared.appendCustomEntry("agent-coordination.marker", { invalid: true });

	await assert.rejects(
		materializeNewAgentTranscript(prepared),
		/ordinary Identity/,
	);
});

test("file-backed transcript inspections reopen durable evidence written by another authority", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-"));
	const writer = SessionManager.create(root, join(root, "sessions"), { id: "agent-file" });
	writer.appendCustomEntry("agent-coordination.identity", { agentId: "agent-file" });
	const sessionFile = writer.getSessionFile();
	assert.ok(sessionFile);
	const header = writer.getHeader();
	const [identity] = writer.getEntries();
	assert.ok(header);
	assert.ok(identity);
	await writeFile(
		sessionFile,
		`${[header, identity].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	const transcript = transcriptFromSessionFile(sessionFile);

	assert.equal(transcript.inspect().entries.length, 1);
	await appendFile(sessionFile, `${JSON.stringify({
		type: "custom",
		id: "remote2",
		parentId: identity.id,
		timestamp: "2026-01-01T00:00:01.000Z",
		customType: "agent-coordination.remote-marker",
		data: { sequence: 2 },
	})}\n`);
	const afterRemoteWrite = transcript.inspect();

	assert.equal(afterRemoteWrite.sessionId, "agent-file");
	assert.equal(afterRemoteWrite.transcriptPath, sessionFile);
	assert.equal(afterRemoteWrite.entries.length, 2);
	assert.equal(afterRemoteWrite.entries.at(-1)?.type, "custom");
});

test("file-backed transcript inspection preserves legacy and empty files byte-for-byte", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-read-only-"));
	for (const [name, body] of [
		["empty", ""],
		["legacy", `${JSON.stringify({
			type: "session",
			version: 1,
			id: "legacy-agent",
			timestamp: "2020-01-01T00:00:00.000Z",
			cwd: root,
		})}\n`],
	] as const) {
		const sessionFile = join(root, `${name}.jsonl`);
		await writeFile(sessionFile, body);
		const before = await readFile(sessionFile);

		transcriptFromSessionFile(sessionFile).inspect();

		assert.deepEqual(await readFile(sessionFile), before, name);
	}
});

function inspection(sessionId: string, entryId: string): TranscriptInspection {
	return {
		sessionId,
		transcriptPath: null,
		header: null,
		entries: [{
			type: "custom",
			id: entryId,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "test",
		}],
		activeBranch: [],
		context: { messages: [], thinkingLevel: "off", model: null },
	};
}

test("unchanged local reads reuse evidence without reprocessing prior facts or rebuilding context", () => {
	const manager = SessionManager.inMemory("/workflow", { id: "retained" });
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "retained" });
	const transcript = transcriptFromSessionManager(manager);
	const first = transcript.inspect();
	const getEntries = manager.getEntries.bind(manager);
	let enumerations = 0;
	manager.getEntries = () => { enumerations++; return getEntries(); };
	const before = transcript.diagnostics()!;
	manager.getBranch = () => { throw new Error("branch reconstruction"); };
	manager.buildSessionContext = () => { throw new Error("context reconstruction"); };
	assert.equal(transcript.inspect(), first);
	assert.equal(enumerations, 1);
	assert.equal(transcript.diagnostics()!.entriesConsumed, before.entriesConsumed);
	manager.appendCustomEntry("marker", { value: 2 });
	assert.equal(transcript.inspect().entries.length, 2);
});

test("file consumption publishes only newline-committed UTF-8 entries", async () => {
	const root = await mkdtemp(join(tmpdir(), "transcript-partial-"));
	const file = join(root, "session.jsonl");
	const header = { type: "session", version: 3, id: "partial", timestamp: new Date().toISOString(), cwd: root };
	await writeFile(file, `${JSON.stringify(header)}\n`);
	const transcript = transcriptFromSessionFile(file);
	const line = Buffer.from(`${JSON.stringify({ type: "custom", id: "one", parentId: null, timestamp: new Date().toISOString(), customType: "marker", data: "你好" })}\n`);
	const split = line.indexOf(Buffer.from("你")) + 1;
	await appendFile(file, line.subarray(0, split));
	assert.equal(transcript.inspect().entries.length, 0);
	await appendFile(file, line.subarray(split, -1));
	assert.equal(transcript.inspect().entries.length, 0);
	await appendFile(file, line.subarray(-1));
	assert.equal(transcript.inspect().entries.length, 1);
	assert.deepEqual(transcript.inspect().entries, transcriptFromSessionFile(file).inspect().entries);
});

test("concurrent consumers share catch-up and a current read sees every committed entry", async () => {
	const root = await mkdtemp(join(tmpdir(), "transcript-consumers-"));
	const file = join(root, "session.jsonl");
	const header = { type: "session", version: 3, id: "shared", timestamp: new Date().toISOString(), cwd: root };
	const entries = Array.from({ length: 1200 }, (_, i) => ({ type: "custom", id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, timestamp: header.timestamp, customType: "marker" }));
	await writeFile(file, `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
	const transcript = transcriptFromSessionFile(file);
	const first = transcript.refresh();
	const second = transcript.refresh();
	assert.equal(transcript.inspect().entries.length, entries.length);
	await Promise.all([first, second]);
	assert.deepEqual(transcript.inspect().entries, entries);
});

test("local physical appends survive moving back to a previously inspected branch", () => {
	const manager = SessionManager.inMemory("/workflow", { id: "branches" });
	const root = manager.appendCustomEntry("agent-coordination.identity", { agentId: "branches" });
	const transcript = transcriptFromSessionManager(manager);
	transcript.inspect();
	manager.appendCustomEntry("hidden-branch", {});
	manager.branch(root);
	assert.equal(transcript.inspect().entries.length, 2);
	assert.equal(transcript.inspect().activeBranch.length, 1);
});

test("file replacement and truncate-regrowth reconstruct disposable state", async () => {
	const root = await mkdtemp(join(tmpdir(), "transcript-replace-"));
	const file = join(root, "session.jsonl");
	const manager = SessionManager.inMemory(root, { id: "replace" });
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "replace" });
	const body = () => `${[manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n")}\n`;
	await writeFile(file, body());
	const transcript = transcriptFromSessionFile(file);
	assert.equal(transcript.inspect().entries.length, 1);
	manager.newSession({ id: "replacement" });
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "replacement" });
	manager.appendCustomEntry("large-marker", { text: "larger".repeat(100) });
	await writeFile(file, body());
	assert.equal(transcript.inspect().sessionId, "replacement");
	assert.equal(transcript.inspect().entries.length, 2);
	await writeFile(file, "");
	assert.equal(transcript.inspect().entries.length, 0);
});

test("async catch-up yields and includes appends made while consuming a backlog", async () => {
	const root = await mkdtemp(join(tmpdir(), "transcript-backlog-"));
	const file = join(root, "session.jsonl");
	const manager = SessionManager.inMemory(root, { id: "backlog" });
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "backlog" });
	for (let i = 0; i < 2000; i++) manager.appendCustomEntry("marker", { i });
	await writeFile(file, `${[manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n")}\n`);
	const transcript = transcriptFromSessionFile(file);
	let nativeEventRan = false;
	const event = new Promise<void>((resolve) => setImmediate(async () => {
		nativeEventRan = true;
		const id = manager.appendCustomEntry("concurrent-append", {});
		await appendFile(file, `${JSON.stringify(manager.getEntry(id))}\n`);
		resolve();
	}));
	await transcript.refresh();
	await event;
	await transcript.refresh();
	assert.equal(nativeEventRan, true);
	assert.deepEqual(transcript.inspect().entries, manager.getEntries());
});

test("unchanged reads do no history work and fixed appends consume only their bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "transcript-work-"));
	const file = join(root, "session.jsonl");
	const manager = SessionManager.inMemory(root, { id: "work" });
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "work" });
	for (let i = 0; i < 1000; i++) manager.appendCustomEntry("marker", { i });
	await writeFile(file, `${[manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n")}\n`);
	const transcript = transcriptFromSessionFile(file);
	await transcript.refresh();
	const before = transcript.diagnostics()!;
	for (let i = 0; i < 20; i++) transcript.inspect();
	assert.deepEqual(transcript.diagnostics(), before);
	const id = manager.appendCustomEntry("marker", { appended: true });
	const line = `${JSON.stringify(manager.getEntry(id))}\n`;
	await appendFile(file, line);
	await transcript.refresh();
	const after = transcript.diagnostics()!;
	assert.equal(after.entriesConsumed - before.entriesConsumed, 1);
	assert.equal(after.entriesParsed - before.entriesParsed, 1);
	assert.equal(after.reconstructions, before.reconstructions);
	assert.ok(after.bytesRead - before.bytesRead <= Buffer.byteLength(line) + 128);
	assert.equal(after.branchBuilds, 0);
	assert.equal(after.contextBuilds, 0);
});

test("a second refresh observes an append after the first read finished but before its promise settled", async () => {
	const manager = SessionManager.inMemory("/workflow", { id: "refresh-race" });
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "refresh-race" });
	const transcript = transcriptFromSessionManager(manager);
	await transcript.refresh();
	const first = transcript.refresh();
	manager.appendCustomEntry("marker", { afterRead: true });
	const second = transcript.refresh();
	const [, current] = await Promise.all([first, second]);
	assert.equal(current.entries.length, 2);
});

test("rewriting an incomplete tail never splices old bytes into a new committed entry", async () => {
	const root = await mkdtemp(join(tmpdir(), "transcript-tail-rewrite-"));
	const file = join(root, "session.jsonl");
	const header = `${JSON.stringify({ type: "session", version: 3, id: "tail", timestamp: new Date().toISOString(), cwd: root })}\n`;
	await writeFile(file, `${header}{"type":"custom","id":"old`);
	const transcript = transcriptFromSessionFile(file);
	await transcript.refresh();
	assert.equal(transcript.inspect().entries.length, 0);
	const replacement = { type: "custom", id: "new-complete", parentId: null, timestamp: new Date().toISOString(), customType: "marker" };
	await writeFile(file, `${header}${JSON.stringify(replacement)}\n`);
	assert.deepEqual((await transcript.refresh()).entries, [replacement]);
});

test("cold child bootstrap accepts only creation rules, not effective configuration or discovery metadata", () => {
	const session = SessionManager.inMemory("/project", { id: "preset-child" });
	const identity = {
		agentId: "preset-child", workflowId: "owner", directSpawnerAgentId: "owner",
		spawnSource: { agentId: "owner", entryId: "spawn-entry", toolCallId: "spawn-call" },
		metadata: { label: "preset-child" },
		creationPreset: { systemPromptMode: "append", systemPrompt: "", loadContextFiles: true },
	};
	session.appendCustomEntry("agent-coordination.identity", identity);
	assert.deepEqual(validateColdChildIdentity({ sessionId: "preset-child", entries: session.getEntries() }), identity);
	for (const invalid of [
		{ ...identity.creationPreset, name: "discovery-name" },
		{ ...identity.creationPreset, cwd: "/resolved-parent" },
		{ ...identity.creationPreset, extensions: ["/resolved-extension.mjs"] },
		{ ...identity.creationPreset, models: [{ model: { provider: "provider", modelId: "model" }, thinking: "invalid" }] },
	]) {
		const entries = session.getEntries().map((entry) => entry.type === "custom"
			? { ...entry, data: { ...identity, creationPreset: invalid } }
			: entry);
		assert.throws(() => validateColdChildIdentity({ sessionId: "preset-child", entries }), /creation preset has an invalid shape/);
	}
});
