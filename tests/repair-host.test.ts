import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRepairHost, readRepairHost } from "../src/repair/repair-host.ts";

test("repair host is independently persisted and identified without becoming an Owner", async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-host-"));
	const path = await createRepairHost({ directory: root, cwd: root, attemptId: "attempt", ownerPath: join(root, "owner.jsonl"), bootstrapPath: join(root, "launch.json") });
	const manager = SessionManager.open(path);
	const host = readRepairHost(manager);
	assert.equal(host?.attemptId, "attempt");
	assert.equal(host?.hostSessionId, manager.getSessionId());
	assert.doesNotMatch(await readFile(path, "utf8"), /agent-coordination.identity/);
	const copied = { getSessionId: () => "copied-session", getEntries: () => manager.getEntries() };
	assert.equal(readRepairHost(copied), undefined);
});
