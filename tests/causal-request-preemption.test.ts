import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context, type JsonObject } from "@earendil-works/pi-ai";
import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

type Delivered = { kind: string; question?: string; requestMessageId: string; fromAgentId: string };
function delivered(context: Context): Delivered[] {
	return context.messages.flatMap(message => {
		if (message.role !== "user" || !Array.isArray(message.content)) return [];
		return message.content.flatMap(part => {
			if (part.type !== "text") return [];
			try { return (JSON.parse(part.text) as { messages?: Delivered[] }).messages ?? []; }
			catch { return []; }
		});
	});
}
let waitCallSequence = 0;
function call(id: string, name: string, input: Record<string, unknown>) {
	// Resuming after preemption authors a fresh Wait, not a replay of its committed source.
	const toolCallId = name === "agent_wait" ? `${id}-${++waitCallSequence}` : id;
	return fauxAssistantMessage(fauxToolCall(name, input as JsonObject, { id: toolCallId }), { stopReason: "toolUse" });
}
for (const { extra, unrelated, siblings } of [{ extra: false, unrelated: false, siblings: false }, { extra: true, unrelated: false, siblings: false }, { extra: false, unrelated: true, siblings: false }, { extra: false, unrelated: false, siblings: true }]) test(`reverse clarification resumes delegated work with ${extra ? "two" : "one"} outgoing Requests${unrelated ? " behind an unrelated queue head" : ""}${siblings ? " and FIFO sibling clarifications" : ""}`, {
	timeout: 10_000, // Starts two real child processes and exercises their cross-process waits.
}, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	let resumed = false;
	let completed = false;
	const route = (context: Context) => {
		const text = JSON.stringify(context.messages);
		const requests = delivered(context).filter(item => item.kind === "request");
		assert.equal(new Set(requests.map(item => item.requestMessageId)).size, requests.length, "each Request is delivered once");
		const root = requests.find(item => item.question === "IMPLEMENT_ROOT");
		const build = requests.find(item => item.question === "BUILD_CORE");
		if (text.includes("START_CAUSAL")) {
			if (text.includes("IMPLEMENT_COMPLETE") && (!unrelated || text.includes("UNRELATED_COMPLETE"))) { completed = true; return fauxAssistantMessage("Done"); }
			if (unrelated && text.includes("spawn-implement") && !text.includes("queue-unrelated")) {
				const spawn = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "spawn-implement");
				assert.ok(spawn?.role === "toolResult");
				return call("queue-unrelated", "agent_message", { title: "Fixture request", operation: "request", targetAgent: (spawn.details as { agentId: string }).agentId, question: "UNRELATED_WORK" });
			}
			return text.includes("spawn-implement") ? call("owner-wait", "agent_wait", {}) : call("spawn-implement", "agent_spawn", { title: "Fixture request", request: "IMPLEMENT_ROOT" });
		}
		if (root) {
			const other = requests.find(item => item.question === "UNRELATED_WORK");
			if (other && !text.includes("answer-unrelated")) {
				assert.ok(!text.includes("answer-implementation"), "unrelated queued work enters before the open delegation is answered");
				return call("answer-unrelated", "agent_message", { operation: "answer", requestId: other.requestMessageId, answer: "UNRELATED_COMPLETE" });
			}
			const sibling = requests.find(item => item.question === "CLARIFY_SECOND");
			if (sibling && !text.includes("answer-sibling")) {
				assert.ok(requests.find(item => item.question === "CLARIFY_INTERFACE"), "the earlier clarification must be delivered before its sibling");
				return call("answer-sibling", "agent_message", { operation: "answer", requestId: sibling.requestMessageId, answer: "USE_SECOND_A" });
			}
			const clarification = requests.find(item => item.question === "CLARIFY_INTERFACE");
			if (clarification && !text.includes("answer-clarification")) return call("answer-clarification", "agent_message", {
				operation: "answer", requestId: clarification.requestMessageId.slice(-12), answer: "USE_INTERFACE_A",
			});
			if (text.includes("answer-clarification")) {
				assert.match(text, /Outstanding Requests/, "remaining obligations must be available on the subsequent continuation");
				resumed = true;
			}
			if (text.includes("CORE_COMPLETE") && (!extra || text.includes("EXTRA_COMPLETE"))) return call("answer-implementation", "agent_message", {
				operation: "answer", requestId: root.requestMessageId, answer: "IMPLEMENT_COMPLETE",
			});
			if (!text.includes("spawn-core")) return call("spawn-core", "agent_spawn", { title: "Fixture request", request: "BUILD_CORE" });
			if (extra && !text.includes("request-extra")) {
				const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "spawn-core");
				assert.ok(result?.role === "toolResult");
				const receipt = JSON.parse(result.content.find(part => part.type === "text")!.text);
				return call("request-extra", "agent_message", { title: "Fixture request", operation: "request", targetAgent: receipt.agentId, question: "BUILD_EXTRA" });
			}
			return call(resumed ? "resumed-wait" : "implementation-wait", "agent_wait", {});
		}
		if (build) {
			const extraRequest = requests.find(item => item.question === "BUILD_EXTRA");
			if (extraRequest && !text.includes("answer-extra")) return call("answer-extra", "agent_message", { operation: "answer", requestId: extraRequest.requestMessageId, answer: "EXTRA_COMPLETE" });
			if (text.includes("USE_INTERFACE_A") && (!siblings || text.includes("USE_SECOND_A"))) return call("answer-core", "agent_message", { operation: "answer", requestId: build.requestMessageId, answer: "CORE_COMPLETE" });
			if (siblings && !text.includes("request-clarification")) return fauxAssistantMessage([
				fauxToolCall("agent_message", { title: "Fixture request", operation: "request", targetAgent: build.fromAgentId, question: "CLARIFY_INTERFACE" }, { id: "request-clarification" }),
				fauxToolCall("agent_message", { title: "Fixture request", operation: "request", targetAgent: build.fromAgentId, question: "CLARIFY_SECOND" }, { id: "request-sibling" }),
			], { stopReason: "toolUse" });
			return text.includes("request-clarification") ? call("core-wait", "agent_wait", {}) : call("request-clarification", "agent_message", {
				title: "Fixture request",
				operation: "request", targetAgent: build.fromAgentId, question: "CLARIFY_INTERFACE",
			});
		}
		throw new Error(`Unexpected model context: ${text}`);
	};
	host.model.setResponses(Array.from({ length: 30 }, () => route));
	await host.session.prompt("START_CAUSAL");
	await host.session.waitForIdle();
	assert.equal(resumed, true);
	assert.equal(completed, true);
	assert.deepEqual(host.ui.notifications.filter(item => item.type === "error"), []);
});

test("Cancellation reaches a parked foreground and leaves downstream cleanup possible", { timeout: 10_000 }, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	let releaseCancellation!: () => void;
	const childWaiting = new Promise<void>(resolve => { releaseCancellation = resolve; });
	t.after(releaseCancellation);
	let cleaned = false;
	const route = async (context: Context) => {
		const text = JSON.stringify(context.messages);
		const spawn = context.messages.find(message => message.role === "toolResult" && message.toolName === "agent_spawn");
		const receipt = spawn?.role === "toolResult" ? spawn.details as { agentId: string; requestMessageId: string } : undefined;
		if (text.includes("CANCEL_PARKED_ROOT")) {
			if (!receipt) return call("spawn-cancel-target", "agent_spawn", { title: "Fixture request", request: "CANCELLABLE_WORK" });
			if (text.includes("cancel-root")) return fauxAssistantMessage("Cancelled");
			await childWaiting;
			return call("cancel-root", "agent_message", { operation: "cancel", requestMessageId: receipt.requestMessageId, reason: "Stop this obligation" });
		}
		if (text.includes("CANCELLABLE_WORK")) {
			if (delivered(context).some(item => item.kind === "request_cancellation")) {
				if (text.includes("cleanup-core")) { cleaned = true; return fauxAssistantMessage("Cleaned up"); }
				assert.ok(receipt);
				return call("cleanup-core", "agent_message", { operation: "cancel", requestMessageId: receipt.requestMessageId, reason: "No longer needed" });
			}
			if (!receipt) return call("spawn-cancel-core", "agent_spawn", { title: "Fixture request", request: "CANCEL_CORE" });
			releaseCancellation();
			return call("wait-cancel-core", "agent_wait", {});
		}
		return fauxAssistantMessage("Waiting for cancellation");
	};
	host.model.setResponses(Array.from({ length: 15 }, () => route));
	await host.session.prompt("CANCEL_PARKED_ROOT");
	const deadline = Date.now() + 3_000;
	while (!cleaned && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(cleaned, true, "the parked responder must receive Cancellation and clean up its own downstream Request");
});

for (const oldestFirst of [true, false]) test(`either delivered Request may be answered first, preserving replay isolation (oldest first: ${oldestFirst})`, { timeout: 5_000 }, async t => {
	const { executeAndCommitRegisteredTool: execute, executeRegisteredTool } = await import("./support/agent-session.ts");
	const { obligationStack } = await import("../src/protocol/obligation-focus.ts");
	const { transcriptFromSessionManager } = await import("../src/pi-integration/session-manager-transcript.ts");
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true });
	host.model.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("Keep the Requests open")));
	const agentId = host.session.sessionId;
	const frames = () => obligationStack(transcriptFromSessionManager(host.session.sessionManager).inspect(), agentId);
	const waitForRequest = async (requestId: string) => {
		// Owner settlement now retains all outbound work, including these self Requests.
		// The Answer contract needs Delivery, not a fully settled Owner.
		const deadline = Date.now() + 1_000;
		while (!frames().some(frame => frame.requestId === requestId) && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.ok(frames().some(frame => frame.requestId === requestId), "Request must be delivered before Answer");
	};
	const root = await execute(host.session, "agent_message", "self-root", { title: "Fixture request", operation: "request", targetAgent: agentId, question: "Root work" });
	const rootId = (root.details as { requestMessageId: string }).requestMessageId;
	await waitForRequest(rootId);
	const nested = await execute(host.session, "agent_message", "self-nested", { title: "Fixture request", operation: "request", targetAgent: agentId, question: "New work", deliveryMode: "steer" });
	const nestedId = (nested.details as { requestMessageId: string }).requestMessageId;
	await waitForRequest(nestedId);
	const firstId = oldestFirst ? rootId : nestedId;
	const remainingId = oldestFirst ? nestedId : rootId;
	const answerInput = { operation: "answer", requestId: firstId.slice(-12), answer: "Finished this Request" };
	host.session.sessionManager.appendMessage(fauxAssistantMessage([
		fauxToolCall("agent_message", answerInput, { id: "batched-answer" }),
		fauxToolCall("agent_wait", {}, { id: "batched-wait" }),
	], { stopReason: "toolUse" }));
	await assert.rejects(host.session.getToolDefinition("agent_message")!.execute(
		"batched-answer", answerInput as never, undefined, undefined, host.session.extensionRunner.createContext(),
	), /only tool call/);
	const result = await execute(host.session, "agent_message", "resolve-first", answerInput);
	assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(result.details) }]);
	assert.equal(result.terminate, true);
	assert.equal((result.details as { requestMessageId: string }).requestMessageId, firstId);
	assert.deepEqual(frames().map(frame => frame.requestId), [remainingId]);
	const answerTool = host.session.getToolDefinition("agent_message")!;
	const replay = await answerTool.execute("resolve-first", answerInput as never, undefined, undefined, host.session.extensionRunner.createContext());
	assert.equal((replay.details as { disposition: string }).disposition, "already_answered");
	await assert.rejects(executeRegisteredTool(host.session, "agent_message", "stale-first", answerInput), /unresolved|already|resolved/);
	assert.deepEqual(frames().map(frame => frame.requestId), [remainingId]);
	const final = await execute(host.session, "agent_message", "resolve-remaining", { operation: "answer", requestId: remainingId, answer: "Done" });
	assert.equal(final.terminate, true);
	assert.deepEqual(final.content, [{ type: "text", text: JSON.stringify(final.details) }]);
	assert.deepEqual(frames(), []);
});
