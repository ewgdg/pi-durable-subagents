import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context, type JsonObject } from "@earendil-works/pi-ai";
import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { hasDeliveredRequest, latestRequestFromContext } from "./support/model-requests.ts";

test("a child Deferred clarification wakes a passively parked Owner", { timeout: 10_000 }, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	let releaseChild!: () => void;
	const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
	t.after(releaseChild);
	let releaseClarification!: () => void;
	const clarificationGate = new Promise<void>(resolve => { releaseClarification = resolve; });
	t.after(releaseClarification);
	let ownerResponded = false;
	let clarificationAnswered = false;
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		const tool = (name: string, args: Record<string, unknown>, id: string) =>
			fauxAssistantMessage(fauxToolCall(name, args as JsonObject, { id }), { stopReason: "toolUse" });
		if (hasDeliveredRequest(context) && !serialized.includes("spawn-clarifier")) {
			const creation = latestRequestFromContext(context);
			if (serialized.includes("USE_BLUE")) return tool("agent_message", {
				operation: "answer", requestId: creation.requestMessageId, answer: "CHILD_FINISHED",
			}, "finish-child");
			if (serialized.includes("ask-owner")) {
				// Keep background work active: a clarification should wake the parked
				// Owner without relying on a child Wait to end passive parking.
				await clarificationGate;
				return tool("agent_wait", {}, "wait-for-choice");
			}
			await childGate;
			return tool("agent_message", {
				operation: "request", targetAgent: creation.fromAgentId,
				title: "Choose a color", question: "Which color should I use?",
			}, "ask-owner");
		}
		if (!serialized.includes("spawn-clarifier")) return tool("agent_spawn", {
			title: "Apply the selected color", request: "Ask Owner for a color, then finish.",
		}, "spawn-clarifier");
		if (serialized.includes("Which color should I use?")) {
			if (!serialized.includes("answer-choice")) {
				clarificationAnswered = true;
				releaseClarification();
				return tool("agent_message", {
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "USE_BLUE",
				}, "answer-choice");
			}
			return fauxAssistantMessage("All work finished.");
		}
		ownerResponded = true;
		return fauxAssistantMessage("The child can continue independently.");
	};
	host.model.setResponses(Array.from({ length: 16 }, () => routeResponse));
	const prompt = host.session.prompt("Delegate this task.");
	// The native assistant response is committed, but passive settlement parking
	// keeps the prompt active until the child can finish or require attention.
	await waitUntil(() => ownerResponded && host.session.sessionManager.getEntries().some(entry =>
		entry.type === "message" && entry.message.role === "assistant" &&
		entry.message.content.some(part => part.type === "text" && part.text === "The child can continue independently.")));
	assert.equal(host.session.isIdle, false);
	releaseChild();
	await waitUntil(() => clarificationAnswered);
	await prompt;
	await waitUntil(() => JSON.stringify(host.session.sessionManager.getEntries()).includes("CHILD_FINISHED"));
});

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Expected parked Owner clarification to advance");
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}
