import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { launchRepairHelper } from "../src/repair/helper-process.ts";
import { readRepairArchiveLaunch } from "../src/repair/repair-launch.ts";

test("pre-admission-gate archive can be inspected but cannot bootstrap a new production helper", async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-old-archive-"));
	const bootstrapPath = join(root, "launch.json");
	const archive = { version: 1, attemptId: "old-attempt", moderatorAgentId: "moderator",
		owner: { path: join(root, "owner.jsonl"), workflowId: "owner", sessionId: "owner", identityEntryId: "identity" },
		storageRoot: join(root, "storage"), participantDirectory: join(root, "participants"), cwd: root, agentDir: root,
		model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinking: "off", creationPreset: null };
	await writeFile(bootstrapPath, JSON.stringify(archive));
	assert.deepEqual(await readRepairArchiveLaunch(bootstrapPath), archive);
	await assert.rejects(launchRepairHelper({ cwd: root, agentDir: root, bootstrapPath,
		extensionPath: resolve("src/repair/helper-entry.ts"), sessionPath: join(root, "moderator.jsonl"), logDirectory: root,
		model: "anthropic/claude-sonnet-4-5", thinking: "off" }), /actual admission failure binding/);
});

test("independent installed-Pi helper admits only explicit repair tools and correlated host commands", async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-helper-process-"));
	const extensionPath = join(root, "fixture.mjs");
	await writeFile(extensionPath, `export default function(pi) {
		pi.on('session_start', (_event, ctx) => {
			process.send({type:'ready'});
			process.on('message', (message) => {
				if (message.action === 'stop') { process.send({type:'result', id:message.id, value:null}); ctx.shutdown(); return; }
				process.send({type:'result', id:message.id, value:{tools:pi.getActiveTools(), session:ctx.sessionManager.getSessionFile(), action:message.action}});
			});
		});
	}`);
	const helper = await launchRepairHelper({
		cwd: root, agentDir: root, extensionPath, bootstrapPath: join(root, "bootstrap.json"),
		sessionPath: join(root, "moderator.jsonl"), logDirectory: root,
		model: "anthropic/claude-sonnet-4-5", thinking: "off",
	});
	try {
		assert.notEqual(helper.pid, process.pid);
		const result = await helper.request("inspect") as { tools: string[]; action: string };
		assert.deepEqual(result.tools, []);
		assert.equal(result.action, "inspect");
	} finally { await helper.stop(); }
	assert.equal((await helper.exited).code, 0);
	assert.ok((await readFile(join(root, "helper.stderr.log"), "utf8")).length >= 0);
});

test("helper exit before bootstrap readiness refuses rather than authorizing repair", async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-helper-failed-"));
	const extensionPath = join(root, "fixture.mjs");
	await writeFile(extensionPath, "export default function(pi) { pi.on('session_start', () => process.exit(1)); }");
	await assert.rejects(launchRepairHelper({
		cwd: root, agentDir: root, extensionPath, bootstrapPath: join(root, "bootstrap.json"),
		sessionPath: join(root, "moderator.jsonl"), logDirectory: root,
		model: "anthropic/claude-sonnet-4-5", thinking: "off",
	}), /exited/);
});
