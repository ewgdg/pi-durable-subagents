import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { discoverColdWorkflow } from "../src/bootstrap/cold-host-discovery.ts";
import { isRepairManagedPath, repairSessionDirectory } from "../src/coordination/manual-repair.ts";
import { MODERATOR_INPUT_CUSTOM_TYPE } from "../src/protocol/moderator-input.ts";
import { resolveModeratorAgentMetadata } from "../src/protocol/agent-metadata.ts";
import type { OwnerIdentity } from "../src/protocol/owner-identity.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "repair-discovery-"));
	const owner = SessionManager.create(root, root);
	const ownerIdentity: OwnerIdentity = {
		agentId: owner.getSessionId(),
		workflowId: owner.getSessionId(),
		directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" },
	};
	owner.appendCustomEntry("agent-coordination.identity", ownerIdentity);
	return { root, owner, ownerIdentity };
}

function ordinaryChild(owner: SessionManager, ownerIdentity: OwnerIdentity, toolCallId: string, label: string) {
	const directory = workflowSessionDirectory(owner.getSessionDir(), ownerIdentity.workflowId);
	const entryId = owner.appendMessage(
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: label, request: "Work", label } as JsonObject, { id: toolCallId })),
	);
	const session = SessionManager.create(owner.getSessionDir(), directory);
	session.appendCustomEntry("agent-coordination.identity", {
		agentId: session.getSessionId(),
		workflowId: ownerIdentity.workflowId,
		directSpawnerAgentId: owner.getSessionId(),
		creationPreset: null,
		spawnSource: { agentId: owner.getSessionId(), entryId, toolCallId },
		metadata: { label },
	});
	session.appendMessage(fauxAssistantMessage("Persist"));
	return session;
}

function repairModerator(root: string, ownerIdentity: OwnerIdentity, reason: string, workflowId?: string) {
	const directory = repairSessionDirectory(root, ownerIdentity.workflowId);
	const session = SessionManager.create(root, directory);
	const metadata = resolveModeratorAgentMetadata("manual_repair");
	session.appendCustomMessageEntry(
		MODERATOR_INPUT_CUSTOM_TYPE,
		JSON.stringify({ trigger: { kind: "manual_repair", reason }, inspectedThrough: [] }),
		true,
		{
			agentId: session.getSessionId(),
			workflowId: workflowId ?? ownerIdentity.workflowId,
			metadata: { ...metadata },
			creationPreset: null,
		},
	);
	session.appendMessage(fauxAssistantMessage("Persist"));
	return session;
}

async function snapshotTranscripts(root: string): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	async function walk(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.name.endsWith(".jsonl")) continue;
			found.set(path, await readFile(path, "utf8"));
		}
	}
	await walk(root);
	return found;
}

test("cold discovery finds the Dormant repair Moderator beside ordinary Agents", { timeout: 5000 }, async () => {
	const { root, owner, ownerIdentity } = await setup();
	const directory = workflowSessionDirectory(root, ownerIdentity.workflowId);
	const child = ordinaryChild(owner, ownerIdentity, "spawn-child", "child");
	const moderator = repairModerator(root, ownerIdentity, "Investigate the stalled handoff.");
	const before = await snapshotTranscripts(root);
	const recovery = await discoverColdWorkflow({ ownerIdentity, ownerSessionManager: owner });
	const roles = new Map(recovery.agents.map((agent) => [agent.identity.agentId, agent.role]));
	assert.equal(roles.get(child.getSessionId()), "ordinary");
	assert.equal(roles.get(moderator.getSessionId()), "moderator");
	assert.equal(recovery.transcriptPathByAgentId.get(moderator.getSessionId()), moderator.getSessionFile());
	assert.ok(isRepairManagedPath(moderator.getSessionFile()!, directory));
	assert.equal(isRepairManagedPath(child.getSessionFile()!, directory), false);
	assert.deepEqual([...recovery.quarantinedAgentIds], []);
	assert.deepEqual(await snapshotTranscripts(root), before);
});

test("cold discovery quarantines repair alias, duplicate, conflict, and foreign bindings", { timeout: 5000 }, async () => {
	const { root, owner, ownerIdentity } = await setup();
	const child = ordinaryChild(owner, ownerIdentity, "spawn-child", "child");
	const moderator = repairModerator(root, ownerIdentity, "Triage.");
	const directory = workflowSessionDirectory(root, ownerIdentity.workflowId);
	const repairDir = repairSessionDirectory(root, ownerIdentity.workflowId);
	await copyFile(moderator.getSessionFile()!, join(directory, "aliased.jsonl"));
	await copyFile(moderator.getSessionFile()!, join(repairDir, "copy.jsonl"));
	const foreign = repairModerator(root, ownerIdentity, "Foreign.", "foreign-workflow");
	const conflict = ordinaryChild(owner, ownerIdentity, "spawn-conflict", "conflict");
	await copyFile(conflict.getSessionFile()!, join(repairDir, basename(conflict.getSessionFile()!)));
	const before = await snapshotTranscripts(root);
	const recovery = await discoverColdWorkflow({ ownerIdentity, ownerSessionManager: owner });
	const recoveredIds = new Set(recovery.agents.map((agent) => agent.identity.agentId));
	assert.ok(recoveredIds.has(child.getSessionId()));
	assert.ok(!recoveredIds.has(moderator.getSessionId()));
	assert.ok(!recoveredIds.has(conflict.getSessionId()));
	assert.ok(!recoveredIds.has(foreign.getSessionId()));
	assert.ok(recovery.quarantinedAgentIds.has(moderator.getSessionId()));
	assert.ok(recovery.quarantinedAgentIds.has(conflict.getSessionId()));
	assert.ok(recovery.quarantinedAgentIds.has(foreign.getSessionId()));
	assert.deepEqual(await snapshotTranscripts(root), before);
});
