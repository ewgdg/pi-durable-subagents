import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context, type JsonObject } from "@earendil-works/pi-ai";
import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { latestRequestFromContext } from "./support/model-requests.ts";

test("public observation lists and inspects a Creation Request across the child transport", {
	timeout: 5_000,
}, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true, processVisibleModel: true,
	});
	const title = "Inspect the exact creation instructions";
	const question = "Read this complete body.\n\nPreserve this final constraint: 禁止改写。  ";
	const answer = "Creation inspection verified.";
	let childInspected = false;
	let ownerInspected = false;
	function result(context: Context, id: string) {
		return context.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
	}
	function call(name: string, args: Record<string, unknown>, id: string) {
		return fauxAssistantMessage(fauxToolCall(name, args as JsonObject, { id }), { stopReason: "toolUse" });
	}
	const route = (context: Context) => {
		if (JSON.stringify(context.messages).includes("START_CREATION_INSPECTION")) {
			const spawn = result(context, "spawn-inspected-child");
			if (!spawn) return call("agent_spawn", { title, request: question, label: "Different agent label" }, "spawn-inspected-child");
			assert.equal(spawn.role, "toolResult");
			if (spawn.role !== "toolResult") throw new Error("Missing Spawn result");
			assert.equal(spawn.isError, false);
			const receipt = spawn.details as { requestMessageId: string; agentId: string };
			const inspected = result(context, "owner-inspect");
			if (!inspected) return call("agent_observe", { operation: "request", requestId: receipt.requestMessageId.slice(-12) }, "owner-inspect");
			assert.equal(inspected.role, "toolResult");
			if (inspected.role !== "toolResult") throw new Error("Missing owner inspection");
			assert.equal(inspected.isError, false);
			assert.deepEqual(inspected.details, { requestMessageId: receipt.requestMessageId,
				requesterAgentId: host.session.sessionId, responderAgentId: receipt.agentId, title, question });
			ownerInspected = true;
			return JSON.stringify(context.messages).includes(answer)
				? fauxAssistantMessage("Done.") : call("agent_wait", {}, "wait-inspected-child");
		}
		const incoming = latestRequestFromContext(context);
		const listed = result(context, "child-list");
		if (!listed) return call("agent_observe", { operation: "obligations" }, "child-list");
		assert.equal(listed.role, "toolResult");
		if (listed.role !== "toolResult") throw new Error("Missing child list");
		assert.equal(listed.isError, false);
		assert.deepEqual(listed.details, { requests: [{ requestMessageId: incoming.requestMessageId,
			requesterAgentId: host.session.sessionId, title }] });
		assert.ok(!JSON.stringify(listed).includes(question));
		const inspected = result(context, "child-inspect");
		if (!inspected) return call("agent_observe", { operation: "request", requestId: incoming.requestMessageId.slice(-12) }, "child-inspect");
		assert.equal(inspected.role, "toolResult");
		if (inspected.role !== "toolResult") throw new Error("Missing child inspection");
		assert.equal(inspected.isError, false);
		const details = inspected.details as { question: string; title: string; requestMessageId: string };
		assert.equal(details.question, question);
		assert.equal(details.title, title);
		assert.equal(details.requestMessageId, incoming.requestMessageId);
		childInspected = true;
		return call("agent_message", { operation: "answer", requestId: incoming.requestMessageId, answer }, "answer-inspected-child");
	};
	host.model.setResponses(Array.from({ length: 14 }, () => route));
	await host.session.prompt("START_CREATION_INSPECTION");
	await host.session.waitForIdle();
	assert.ok(childInspected);
	assert.ok(ownerInspected);
	assert.deepEqual(host.ui.notifications.filter(({ type }) => type === "error"), []);
});
