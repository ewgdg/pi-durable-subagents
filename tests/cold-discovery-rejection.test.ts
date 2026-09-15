import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { discoverColdWorkflow } from "../src/bootstrap/cold-host-discovery.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";
import type { OwnerIdentity } from "../src/protocol/owner-identity.ts";

const rejectedSpawns = [
	{
		name: "missing title",
		input: {
			request: "Missing title",
			template: "removed",
			config: { cwd: "/rejected" },
		},
	},
	{
		name: "invalid config",
		input: {
			title: "Invalid config",
			request: "Work",
			config: { tools: 42 },
		},
	},
];

for (const { name, input: rejected } of rejectedSpawns) {
	test("cold discovery retains independently valid ancestry for rejected spawn: " + name, { timeout: 5_000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "cold-rejected-spawn-"));
		const owner = SessionManager.create(root, root);
		const ownerIdentity: OwnerIdentity = {
			agentId: owner.getSessionId(),
			workflowId: owner.getSessionId(),
			directSpawnerAgentId: null,
			metadata: { label: "Owner", description: "Workflow Owner" },
		};
		owner.appendCustomEntry("agent-coordination.identity", ownerIdentity);
		const directory = workflowSessionDirectory(root, ownerIdentity.workflowId);
		function child(parent: SessionManager, input: object, label: string, corrupt = false) {
			const entryId = parent.appendMessage(
				fauxAssistantMessage(fauxToolCall("agent_spawn", input, { id: label })),
			);
			const session = SessionManager.create(root, directory);
			if (corrupt) session.appendMessage(fauxAssistantMessage("Not a root bootstrap"));
			session.appendCustomEntry("agent-coordination.identity", {
				agentId: session.getSessionId(),
				workflowId: ownerIdentity.workflowId,
				directSpawnerAgentId: parent.getSessionId(),
				creationPreset: null,
				spawnSource: {
					agentId: parent.getSessionId(),
					entryId,
					toolCallId: label,
				},
				metadata: { label },
			});
			session.appendMessage(fauxAssistantMessage("Persist"));
			return session;
		}
		const parent = child(owner, rejected, "parent");
		const descendant = child(
			parent,
			{ title: "Valid", request: "Work", label: "descendant" },
			"descendant",
		);
		const corrupt = child(owner, rejected, "corrupt", true);
		const paths = [owner, parent, descendant, corrupt].map(session => session.getSessionFile()!);
		const before = await Promise.all(paths.map(path => readFile(path, "utf8")));
		const recovery = await discoverColdWorkflow({ ownerIdentity, ownerSessionManager: owner });
		assert.deepEqual(
			recovery.agents.map(agent => agent.identity.agentId),
			[parent.getSessionId(), descendant.getSessionId()],
		);
		assert.equal(
			recovery.agents[0]?.role === "ordinary" && recovery.agents[0].creationInput,
			undefined,
		);
		assert.deepEqual([...recovery.quarantinedAgentIds], [corrupt.getSessionId()]);
		assert.deepEqual(await Promise.all(paths.map(path => readFile(path, "utf8"))), before);
	});
}
