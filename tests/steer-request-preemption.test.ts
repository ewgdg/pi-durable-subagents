import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";

import piAgentCoordination from "../src/index.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

test("a Steer Request preempting Agent Wait commits one Delivery across turn_end", {
	timeout: 5_000,
}, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	const ownerId = host.session.sessionId;
	const question = "Which format should the child use?";
	const decision = "Use the concise format.";
	const result = "The child completed its work.";
	let releaseRequest!: () => void;
	const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
	t.after(releaseRequest);
	const routeResponse = async (context: Context) => {
		const text = JSON.stringify(context.messages);
		if (text.includes("START_OWNER_PREEMPTION")) {
			if (text.includes(result)) return fauxAssistantMessage("The workflow is complete.");
			if (text.includes(question)) {
				return text.includes("answer-child-decision")
					? fauxAssistantMessage("Waiting for the child to finish.")
					: fauxAssistantMessage(fauxToolCall("agent_message", {
						operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: decision,
					}, { id: "answer-child-decision" }), { stopReason: "toolUse" });
			}
			return text.includes("spawn-preempting-child")
				? fauxAssistantMessage(fauxToolCall("agent_wait", {}, {
					id: "wait-for-preempting-child",
				}), { stopReason: "toolUse" })
				: fauxAssistantMessage(fauxToolCall("agent_spawn", {
					title: "Fixture request",
					request: "Ask for a format decision, then complete the work.",
				}, { id: "spawn-preempting-child" }), { stopReason: "toolUse" });
		}
		if (text.includes(decision)) {
			return text.includes("answer-child-work")
				? fauxAssistantMessage("The child has answered.")
				: fauxAssistantMessage(fauxToolCall("agent_message", {
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: result,
				}, { id: "answer-child-work" }), { stopReason: "toolUse" });
		}
		if (text.includes("request-child-decision")) return fauxAssistantMessage("Waiting for the decision.");
		await requestGate;
		return fauxAssistantMessage(fauxToolCall("agent_message", {
			title: "Fixture request",
			operation: "request", targetAgent: ownerId, question, deliveryMode: "steer",
		}, { id: "request-child-decision" }), { stopReason: "toolUse" });
	};
	host.model.setResponses(Array.from({ length: 12 }, () => routeResponse));
	const removeWaitListener = host.session.subscribe((event) => {
		if (event.type !== "tool_execution_start" || event.toolName !== "agent_wait") return;
		removeWaitListener();
		releaseRequest();
	});
	t.after(removeWaitListener);
	await host.session.prompt("START_OWNER_PREEMPTION");
	await host.session.waitForIdle();
	const entries = host.session.sessionManager.getEntries();
	inspectMessageDeliveries({
		recipientAgentId: ownerId,
		transcript: transcriptFromSessionManager(host.session.sessionManager).inspect(),
	});
	const deliveries = entries.filter((entry) =>
		entry.type === "custom_message" &&
		entry.customType === "agent-coordination.message-delivery" &&
		JSON.stringify(entry.content).includes(question)
	);
	assert.equal(deliveries.length, 1, "Steer preemption must not queue the Request again at turn_end");
	const waitResult = entries.find((entry) =>
		entry.type === "message" && entry.message.role === "toolResult" &&
		entry.message.toolCallId === "wait-for-preempting-child"
	);
	assert.ok(waitResult?.type === "message" && waitResult.message.role === "toolResult");
	assert.deepEqual(waitResult.message.details, { disposition: "preempted" });
	assert.deepEqual(host.ui.notifications.filter(({ type }) => type === "error"), []);
});
