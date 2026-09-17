import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { launchRepairHelper } from "../src/repair/helper-process.ts";

test("CLI lifetime shutdown is a real helper control action and joins native process exit", { timeout: 20000, skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-helper-shutdown-"));
	const moderatorAgentId = randomUUID();
	const bootstrapPath = join(root, "launch.json");
	const sessionPath = join(root, "moderator.jsonl");
	const ownerPath = join(root, "owner.jsonl");
	await writeFile(bootstrapPath, JSON.stringify({ version: 1, attemptId: "shutdown", moderatorAgentId,
		owner: { path: ownerPath, workflowId: "owner", sessionId: "owner", identityEntryId: "identity" },
		admissionFailure: { stage: "Owner transcript recovery", reason: "invariant_violation: Message demo has duplicate Deliveries", transcriptPath: ownerPath, agentId: "owner" },
		storageRoot: join(root, "storage"), participantDirectory: join(root, "participants"), cwd: root, agentDir: join(root, "agent"),
		model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinking: "off", creationPreset: null }));
	const manager = SessionManager.inMemory(root, { id: moderatorAgentId });
	manager.appendMessage(fauxAssistantMessage("Waiting for verified retirement."));
	await writeFile(sessionPath, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const helper = await launchRepairHelper({ cwd: root, agentDir: join(root, "agent"), bootstrapPath, sessionPath,
		extensionPath: resolve("src/repair/helper-entry.ts"), logDirectory: root, model: "anthropic/claude-sonnet-4-5", thinking: "off" });
	try {
		assert.equal(await helper.request("shutdown"), null);
		const exit = await helper.exited;
		assert.equal(exit.code, 0);
	} finally { await helper.stop(); }
});
