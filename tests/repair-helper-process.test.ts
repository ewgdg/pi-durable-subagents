import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { launchRepairHelper } from "../src/repair/helper-process.ts";
import { readRepairArchiveLaunch } from "../src/repair/repair-launch.ts";
import { attachNativeChildDisplay, nativeChildDisplayText } from "./support/native-child-display.ts";

async function nativeFixture() {
	const root = await mkdtemp(join(tmpdir(), "repair-native-editor-"));
	const bootstrapPath = join(root, "launch.json");
	const sessionPath = join(root, "moderator.jsonl");
	const moderatorId = "019a6b4d-1b22-7000-8000-000000000095";
	await writeFile(bootstrapPath, JSON.stringify({ version: 1, attemptId: "native-attempt", moderatorAgentId: moderatorId,
		owner: { path: join(root, "owner.jsonl"), workflowId: "owner", sessionId: "owner", identityEntryId: "identity" },
		admissionFailure: { stage: "Owner transcript recovery", reason: "invariant_violation: Message demo has duplicate Deliveries", transcriptPath: join(root, "owner.jsonl"), agentId: "owner" },
		storageRoot: join(root, "storage"), participantDirectory: join(root, "participants"), cwd: root, agentDir: root,
		model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinking: "off", creationPreset: null }));
	await writeFile(sessionPath, [
		{ type: "session", version: 3, id: moderatorId, timestamp: new Date().toISOString(), cwd: root },
		{ type: "custom", id: "abcdef01", parentId: null, timestamp: new Date().toISOString(), customType: "repair-test-seed", data: {} },
		{ type: "message", id: "abcdef02", parentId: "abcdef01", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Repair-only Moderator ready for verified retirement." }], api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
	].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	return { root, bootstrapPath, sessionPath };
}

test("repair helper owns a real native editor across detach and reattach", { timeout: 20_000 }, async () => {
	const { root, bootstrapPath, sessionPath } = await nativeFixture();
	const helper = await launchRepairHelper({ cwd: root, agentDir: join(root, "agent"), bootstrapPath, sessionPath,
		extensionPath: resolve("src/repair/helper-entry.ts"), logDirectory: root, model: "anthropic/claude-sonnet-4-5", thinking: "off" });
	try {
		await attachNativeChildDisplay(helper);
		helper.writeInput("A native Moderator draft");
		const deadline = Date.now() + 5000;
		while (!nativeChildDisplayText(helper).includes("A native Moderator draft")) {
			assert.ok(Date.now() < deadline, "native editor displays direct terminal input");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		helper.writeInput("\u0015!touch forbidden-shell-write\r");
		await new Promise(resolve => setTimeout(resolve, 100));
		await assert.rejects(readFile(join(root, "forbidden-shell-write")), { code: "ENOENT" });
		helper.writeInput("/new\r");
		await new Promise(resolve => setTimeout(resolve, 100));
		helper.writeInput("A native Moderator draft");
		await helper.hidePresentation();
		await helper.request("visible", true);
		assert.match(nativeChildDisplayText(helper), /A native Moderator draft/);
		assert.equal((await helper.request("inspect") as { phase: string }).phase, "waiting");
	} finally { await helper.stop(); }
});

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

for (const corruptBootstrap of [false, true]) test(`native repair reload exits with fences intact: corrupt bootstrap=${corruptBootstrap}`, { timeout: 15_000 }, async () => {
	const { root, bootstrapPath, sessionPath } = await nativeFixture();
	const helper = await launchRepairHelper({ cwd: root, agentDir: join(root, "agent"), bootstrapPath, sessionPath,
		extensionPath: resolve("src/repair/helper-entry.ts"), logDirectory: root, model: "anthropic/claude-sonnet-4-5", thinking: "off" });
	let exited = false;
	void helper.exited.then(() => { exited = true; }, () => { exited = true; });
	try {
		await attachNativeChildDisplay(helper);
		if (corruptBootstrap) await writeFile(bootstrapPath, "{}");
		helper.writeInput("/reload\r");
		await new Promise(resolve => setTimeout(resolve, 200));
		if (!exited) helper.writeInput("!touch forbidden-reload-shell\r/new\r");
		const deadline = Date.now() + 3000;
		while (!exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(exited, true, "reload must retire the helper rather than leave an unguarded or stranded TUI");
		await assert.rejects(readFile(join(root, "forbidden-reload-shell")), { code: "ENOENT" });
	} finally {
		if (!exited) process.kill(helper.pid, "SIGKILL");
		await helper.exited;
	}
});

test("helper exit before bootstrap readiness refuses rather than authorizing repair", async () => {
	const { root, bootstrapPath, sessionPath } = await nativeFixture();
	const extensionPath = join(root, "fixture.mjs");
	await writeFile(extensionPath, "export default function(pi) { pi.on('session_start', () => process.exit(1)); }");
	await assert.rejects(launchRepairHelper({
		cwd: root, agentDir: join(root, "agent"), extensionPath, bootstrapPath,
		sessionPath, logDirectory: root,
		model: "anthropic/claude-sonnet-4-5", thinking: "off",
	}), /exited/);
});
