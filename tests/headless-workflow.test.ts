import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
} from "@earendil-works/pi-ai";

import type { WorkflowInteraction } from "../src/pi-integration/workflow-interaction.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestCleanupRegistrar,
} from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";

const MAX_CONDITION_POLL_ATTEMPTS = 5_000;

async function childToolsFor(
	t: TestCleanupRegistrar,
	interaction: WorkflowInteraction,
): Promise<string[]> {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, interaction === "terminal" ? "tui" : "rpc");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let observedTools: string[] | undefined;
	host.model.setResponses([
		(context) => {
			observedTools = getCurrentTools(context.messages).map(({ name }) => name);
			return fauxAssistantMessage("Child Run observed.");
		},
	]);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		interaction,
	});
	const input = { title: "Fixture request", request: "Report your tool surface." };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(fauxToolCall("agent_spawn", input, { id: "spawn-child" }), { stopReason: "toolUse" }),
	);
	const receipt = await coordinator.forAgent(identity.agentId).spawn("spawn-child", input);
	assert.equal(receipt.spawnStatus, "created", JSON.stringify(receipt));
	for (let attempt = 0; !observedTools; attempt += 1) {
		if (attempt >= MAX_CONDITION_POLL_ATTEMPTS) throw new Error("Child never called the model");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return observedTools;
}

test("a headless Workflow's children cannot ask the absent human", async (t) => {
	const tools = await childToolsFor(t, "headless");

	assert.equal(tools.includes("ask_user"), false);
	for (const tool of ["agent_message", "agent_wait", "agent_spawn", "agent_observe", "agent_control"]) {
		assert.equal(tools.includes(tool), true, tool);
	}
});

test("a terminal Workflow's children keep ask_user", async (t) => {
	assert.equal((await childToolsFor(t, "terminal")).includes("ask_user"), true);
});
