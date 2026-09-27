import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type Context,
} from "@earendil-works/pi-ai";

import piAgentCoordination from "../src/index.ts";
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

test("a headless Owner parked in agent_wait learns that its child suspended", { timeout: 30_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "rpc");
	const ownerPrompt = "Delegate the quota work.";
	const spawnCallId = "spawn-quota-child";
	const waitCallId = "wait-for-quota-child";
	let ownerSawSuspension = false;
	const route = (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		if (!serialized.includes(ownerPrompt)) {
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: '{"error":{"code":"usage_limit_reached"}}' });
		}
		if (!serialized.includes(spawnCallId)) {
			return fauxAssistantMessage(
				fauxToolCall("agent_spawn", { title: "Quota work", request: "Do the work." }, { id: spawnCallId }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(waitCallId)) {
			return fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: waitCallId }), { stopReason: "toolUse" });
		}
		ownerSawSuspension = serialized.includes('\\"reason\\":\\"provider_quota\\"') &&
			serialized.includes('\\"disposition\\":\\"preempted\\"');
		return fauxAssistantMessage("The Owner handled the suspended child.");
	};
	host.model.setResponses(Array.from({ length: 6 }, () => route));

	await host.session.prompt(ownerPrompt, { source: "rpc" });

	assert.equal(host.session.getLastAssistantText(), "The Owner handled the suspended child.");
	assert.equal(ownerSawSuspension, true);
});
