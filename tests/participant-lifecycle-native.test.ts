import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerParticipantLifecycle, type ParticipantLifecycleHandlers } from "../src/pi-integration/participant-lifecycle.ts";
import { OBLIGATION_FOCUS_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import type { ObligationFrame } from "../src/protocol/obligation-focus.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const frames: ObligationFrame[] = [
	{ title: "Fixture request", requestId: "request-a", requesterAgentId: "author-a", question: "OUTSTANDING_A" },
	{ title: "Fixture request", requestId: "request-b", requesterAgentId: "author-b", question: "OUTSTANDING_B" },
];

function handlers(currentFrames: () => readonly ObligationFrame[]): ParticipantLifecycleHandlers {
	return {
		async executionStarted() { return currentFrames(); },
		async humanInputSubmitted() { return "continue"; },
		async primaryInputQueued() {},
		async humanInputMode() { return "agent"; },
		async toolResultCommitting() {},
		async toolExecutionStarted() {},
		async safeBoundaryReached() {},
		async executionEnded() {},
	};
}

test("native first generation sees reconciled outstanding Requests before authoring", { timeout: 5_000 }, async t => {
	const host = await createTestOwnerHost(t, pi => {
		pi.on("session_start", (_event, ctx) => pi.appendEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: ctx.sessionManager.getSessionId() }));
		registerParticipantLifecycle(pi, handlers(() => frames));
	});
	let firstContext = "";
	let recoveryBeforeGeneration = false;
	host.model.setResponses([context => {
		firstContext = JSON.stringify(context);
		recoveryBeforeGeneration = host.session.sessionManager.getEntries().some(entry =>
			entry.type === "custom" && entry.customType === OBLIGATION_FOCUS_CUSTOM_TYPE);
		return fauxAssistantMessage("Pause without choosing a Request.");
	}]);
	await host.session.prompt("Continue recovered work.");
	assert.equal(recoveryBeforeGeneration, true);
	assert.match(firstContext, /OUTSTANDING_A/);
	assert.match(firstContext, /OUTSTANDING_B/);
	assert.match(firstContext, /Choose/);
});

for (const queuedInput of ["steer", "followUp", undefined] as const) {
	test(`native Answer continuation does not duplicate already consumed input (${queuedInput ?? "no input"})`, { timeout: 5_000 }, async t => {
		let currentFrames = frames;
		let generations = 0;
		const extension: ExtensionFactory = pi => {
			pi.on("session_start", (_event, ctx) => pi.appendEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: ctx.sessionManager.getSessionId() }));
			registerParticipantLifecycle(pi, handlers(() => currentFrames));
			pi.registerTool({
				name: "agent_message", label: "Answer", description: "Commit one final Answer",
				parameters: Type.Object({}),
				async execute() {
					currentFrames = frames.slice(1);
					pi.appendEntry(OBLIGATION_FOCUS_CUSTOM_TYPE, { frames: currentFrames });
					if (queuedInput) pi.sendUserMessage("QUEUED_DIRECTION: pause now.", { deliverAs: queuedInput });
					return { content: [{ type: "text", text: "sent" }], details: {
						requestTitle: "Fixture request",
						messageId: "answer-a", requestMessageId: "request-a", messageStatus: "sent",
					}, terminate: true };
				},
			});
		};
		const host = await createTestOwnerHost(t, extension);
		host.model.setResponses([
			() => {
				generations++;
				return fauxAssistantMessage(fauxToolCall("agent_message", {}, { id: "answer-call" }), { stopReason: "toolUse" });
			},
			context => {
				generations++;
				const modelContext = JSON.stringify(context);
				if (queuedInput) assert.match(modelContext, /QUEUED_DIRECTION/);
				assert.equal(modelContext.match(/OUTSTANDING_B/g)?.length, 1, "one fresh outstanding set");
				assert.doesNotMatch(modelContext, /OUTSTANDING_A/, "resolved work is not re-presented");
				return fauxAssistantMessage("Pause here.");
			},
			() => { generations++; return fauxAssistantMessage("Unwanted repeated continuation."); },
		]);
		await host.session.prompt("Answer A, leaving B open.");
		assert.equal(generations, 2, "one continuation, whether native input or outstanding-work notification");
	});
}

test("native final Answer settles without a summary generation", { timeout: 5_000 }, async t => {
	let currentFrames = frames.slice(0, 1);
	let generations = 0;
	const host = await createTestOwnerHost(t, pi => {
		pi.on("session_start", (_event, ctx) => pi.appendEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: ctx.sessionManager.getSessionId() }));
		registerParticipantLifecycle(pi, handlers(() => currentFrames));
		pi.registerTool({
			name: "agent_message", label: "Answer", description: "Commit the final Answer",
			parameters: Type.Object({}),
			async execute() {
				currentFrames = [];
				pi.appendEntry(OBLIGATION_FOCUS_CUSTOM_TYPE, { frames: [] });
				return { content: [{ type: "text", text: "sent" }], details: {
					requestTitle: "Fixture request",
					messageId: "answer-a", requestMessageId: "request-a", messageStatus: "sent",
				}, terminate: true };
			},
		});
	});
	host.model.setResponses([
		() => { generations++; return fauxAssistantMessage(fauxToolCall("agent_message", {}, { id: "final-answer" }), { stopReason: "toolUse" }); },
		() => { generations++; return fauxAssistantMessage("Unwanted summary."); },
	]);
	await host.session.prompt("Answer the final Request.");
	assert.equal(generations, 1);
});
