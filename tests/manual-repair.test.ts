import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	getAgentsArgumentCompletions,
	parseAgentsCommandArgument,
	parseAgentsRepairCommitSnapshotId,
	parseAgentsRepairReason,
} from "../src/process-runtime/remote-agent-selector.ts";
import {
	assertRepairTargetAdmitted,
	isRepairManagedPath,
	readRepairOwnerSnapshot,
	repairSessionDirectory,
	validateManualRepairReason,
} from "../src/coordination/manual-repair.ts";

test("agents command parses the manual repair trigger", () => {
	assert.equal(parseAgentsCommandArgument(""), "selector");
	assert.equal(parseAgentsCommandArgument("owner"), "owner");
	assert.equal(parseAgentsCommandArgument("repair"), "repair");
	assert.equal(parseAgentsCommandArgument("repair check the stalled handoff"), "repair");
	assert.throws(() => parseAgentsCommandArgument("bogus"), /Usage: \/agents/);
	assert.throws(() => parseAgentsCommandArgument("repairx"), /Usage: \/agents/);
	assert.equal(parseAgentsRepairReason("repair"), undefined);
	assert.equal(parseAgentsRepairReason("repair check the stalled handoff"), "check the stalled handoff");
	assert.equal(parseAgentsRepairReason("repair   trimmed   "), "trimmed");
	assert.equal(parseAgentsCommandArgument("repair-confirm abc123"), "repair-confirm");
	assert.equal(parseAgentsCommandArgument("repair-commit abc123"), "repair-commit");
	assert.equal(parseAgentsRepairCommitSnapshotId("repair-commit abc123"), "abc123");
	assert.throws(() => parseAgentsRepairCommitSnapshotId("repair-commit"), /Usage/);
	assert.throws(() => parseAgentsRepairCommitSnapshotId("repair-commit a b"), /Usage/);
	assert.equal(parseAgentsCommandArgument("repair-freeze"), "repair-freeze");
});

test("agents completions offer repair only where the Owner admits it", () => {
	assert.equal(getAgentsArgumentCompletions("r"), null);
	const offered = getAgentsArgumentCompletions("r", { includeRepair: true });
	assert.deepEqual(offered, [{ value: "repair", label: "repair" }, { value: "repair-confirm", label: "repair-confirm" }, { value: "repair-freeze", label: "repair-freeze" }, { value: "repair-commit", label: "repair-commit" }]);
	const all = getAgentsArgumentCompletions("", { includeRepair: true });
	assert.ok(all?.some(({ value }) => value === "owner"));
	assert.ok(all?.some(({ value }) => value === "repair"));
});

test("manual repair reason stays truthful", () => {
	const fallback = validateManualRepairReason(undefined);
	assert.ok(fallback.length > 0);
	assert.ok(!fallback.includes("\0"));
	assert.equal(validateManualRepairReason("  triage the handoff  "), "triage the handoff");
	assert.throws(() => validateManualRepairReason(""), /manual repair reason/);
	assert.throws(() => validateManualRepairReason("   "), /manual repair reason/);
});

test("repair namespace is canonical under the workflow directory", () => {
	const root = join(tmpdir(), "owner-sessions");
	const workflow = "workflow-id";
	assert.equal(
		repairSessionDirectory(root, workflow),
		join(root, "pi-durable-subagents", workflow, "repair"),
	);
	const directory = join(root, "pi-durable-subagents", workflow);
	assert.equal(isRepairManagedPath(join(directory, "repair", "moderator.jsonl"), directory), true);
	assert.equal(isRepairManagedPath(join(directory, "agent.jsonl"), directory), false);
	assert.equal(isRepairManagedPath(join(root, "owner.jsonl"), directory), false);
	assert.equal(isRepairManagedPath(directory, directory), false);
});

test("repair Owner target is an immutable snapshot with no writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-owner-snapshot-"));
	const owner = SessionManager.create(root, root);
	owner.appendCustomEntry("agent-coordination.identity", {
		agentId: owner.getSessionId(),
		workflowId: owner.getSessionId(),
		directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" },
	});
	owner.appendMessage(fauxAssistantMessage("Owner session persists."));
	const ownerPath = owner.getSessionFile()!;
	const beforeBytes = await readFile(ownerPath, "utf8");
	const beforeListing = await readdir(root);
	const snapshot = await readRepairOwnerSnapshot(ownerPath);
	assert.equal(snapshot.agentId, owner.getSessionId());
	assert.equal(snapshot.workflowId, owner.getSessionId());
	assert.equal(snapshot.header.id, owner.getSessionId());
	assert.ok(snapshot.entries.length >= 1);
	assert.ok(Object.isFrozen(snapshot));
	assert.ok(Object.isFrozen(snapshot.entries));
	const reread = await readRepairOwnerSnapshot(ownerPath);
	assert.deepEqual(reread, snapshot);
	assert.equal(await readFile(ownerPath, "utf8"), beforeBytes);
	assert.deepEqual(await readdir(root), beforeListing);
});

test("routing to unadmitted originals is precisely unavailable without writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "repair-unavailable-"));
	const beforeListing = await readdir(root);
	assertRepairTargetAdmitted(new Set(["admitted-id"]), "admitted-id");
	assert.throws(
		() => assertRepairTargetAdmitted(new Set(["admitted-id"]), "retired-original"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /unavailable/);
			assert.match(error.message, /retired-original/);
			return true;
		},
	);
	assert.deepEqual(await readdir(root), beforeListing);
});
