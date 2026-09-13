import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { latestRequestFromContext } from "./support/model-requests.ts";

test("public Background delivery waits for Creation Answer then delivers Message and Request FIFO", { timeout: 5_000 }, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	let releaseCreation!: () => void;
	const queued = new Promise<void>(resolve => { releaseCreation = resolve; });
	t.after(releaseCreation);
	const observed: string[] = [];
	const call = (name: string, args: Record<string, unknown>, id: string) =>
		fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
	const result = (context: Context, id: string) => context.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
	const route = async (context: Context) => {
		const text = JSON.stringify(context.messages);
		if (text.includes("START_BACKGROUND_OWNER")) {
			const spawned = result(context, "spawn-worker");
			if (!spawned) return call("agent_spawn", { title: "Initial duty", request: "Complete initial duty" }, "spawn-worker");
			assert.equal(spawned.role, "toolResult");
			if (spawned.role !== "toolResult") throw new Error("Missing Spawn receipt");
			assert.equal(spawned.isError, false);
			const agentId = (spawned.details as { agentId: string }).agentId;
			if (!result(context, "queue-note")) return call("agent_message", { operation: "send", targetAgent: agentId, content: "OPTIONAL_BACKGROUND_NOTE", deliveryMode: "background" }, "queue-note");
			if (!result(context, "queue-request")) return call("agent_message", { operation: "request", targetAgent: agentId, title: "Optional later work", question: "OPTIONAL_BACKGROUND_WORK", deliveryMode: "background" }, "queue-request");
			releaseCreation();
			return result(context, "join-worker") ? fauxAssistantMessage("Done") : call("agent_wait", {}, "join-worker");
		}
		if (text.includes("OPTIONAL_BACKGROUND_WORK")) {
			observed.push("request");
			return call("agent_message", { operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "Optional work completed" }, "answer-optional");
		}
		if (text.includes("OPTIONAL_BACKGROUND_NOTE")) {
			observed.push("message");
			return fauxAssistantMessage("Optional note read");
		}
		await queued;
		observed.push("creation-answer");
		return call("agent_message", { operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "Initial duty completed" }, "answer-initial");
	};
	host.model.setResponses(Array.from({ length: 16 }, () => route));
	await host.session.prompt("START_BACKGROUND_OWNER");
	await host.session.waitForIdle();
	assert.deepEqual(observed, ["creation-answer", "message", "request"]);
	const entries = host.session.sessionManager.getEntries();
	const wait = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "join-worker");
	assert.ok(wait?.type === "message" && wait.message.role === "toolResult");
	assert.equal(wait.message.isError, false);
	const details = wait.message.details as { answers: unknown[] };
	assert.equal(details.answers.length, 2);
	assert.deepEqual(host.ui.notifications.filter(({ type }) => type === "error"), []);
});
