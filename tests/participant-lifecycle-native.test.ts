import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerParticipantLifecycle, type ParticipantLifecycleHandlers } from "../src/pi-integration/participant-lifecycle.ts";
import { OBLIGATION_FOCUS_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { deriveMessageIdentity, resolveCommittedToolCall } from "../src/protocol/identities.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import { obligationStack, type ObligationFrame } from "../src/protocol/obligation-focus.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const requestSources = ["a", "b"].map(id => ({ agentId: `author-${id}`, entryId: `request-entry-${id}`, toolCallId: `request-call-${id}` }));
const frames: ObligationFrame[] = requestSources.map((source, index) => ({
	title: `Fixture request ${index === 0 ? "A" : "B"}`, requestId: deriveMessageIdentity(source),
	requesterAgentId: source.agentId, question: index === 0 ? "OUTSTANDING_A" : "OUTSTANDING_B",
}));
const answerInput = { operation: "answer" as const, requestId: frames[0]!.requestId, answer: "Completed A." };
const answerParameters = Type.Object({ operation: Type.Literal("answer"), requestId: Type.String(), answer: Type.String() });

function appendDeliveries(manager: SessionManager, count = frames.length): void {
	for (let index = 0; index < count; index++) {
		const frame = frames[index]!;
		const delivery = createMessageDelivery([{ source: requestSources[index]!, projection: {
			kind: "request", requestMessageId: frame.requestId, fromAgentId: frame.requesterAgentId,
			title: frame.title, question: frame.question,
		} }]);
		manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	}
}

function latestAttention(context: Context): string {
	const attention = context.messages.filter(message => message.role === "user")
		.flatMap(message => typeof message.content === "string" ? [message.content]
			: message.content.flatMap(part => part.type === "text" ? [part.text] : []))
		.filter(text => text.startsWith("Outstanding Requests."));
	assert.equal(attention.length, 1, "one current outstanding Request presentation");
	return attention[0]!;
}

function answerReceipt(ctx: ExtensionContext, toolCallId: string, omitted: boolean) {
	const { source } = resolveCommittedToolCall({ agentId: ctx.sessionManager.getSessionId(),
		transcript: transcriptFromSessionManager(ctx.sessionManager).inspect(), toolCallId, toolName: "agent_message" });
	const identity = { messageId: deriveMessageIdentity(source), requestMessageId: frames[0]!.requestId, requestTitle: frames[0]!.title };
	return omitted
		? { ...identity, disposition: "committed" as const, delivery: "omitted" as const, reason: "request_source_unavailable" as const }
		: { ...identity, messageStatus: "sent" as const };
}

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

test("native first generation sees reconciled outstanding Requests without durable focus authority", { timeout: 5_000 }, async t => {
	const host = await createTestOwnerHost(t, pi => {
		pi.on("session_start", (_event, ctx) => pi.appendEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: ctx.sessionManager.getSessionId() }));
		registerParticipantLifecycle(pi, handlers(() => frames));
	});
	appendDeliveries(host.session.sessionManager);
	let firstAttention = "";
	let recoveryBeforeGeneration = false;
	host.model.setResponses([context => {
		firstAttention = latestAttention(context);
		recoveryBeforeGeneration = host.session.sessionManager.getEntries().some(entry =>
			entry.type === "custom" && entry.customType === OBLIGATION_FOCUS_CUSTOM_TYPE);
		return fauxAssistantMessage("Pause without choosing a Request.");
	}]);
	await host.session.prompt("Continue recovered work.");
	assert.equal(recoveryBeforeGeneration, false);
	assert.ok(firstAttention.includes(frames[0]!.requestId));
	assert.ok(firstAttention.includes(frames[1]!.requestId));
	assert.match(firstAttention, /Fixture request A/);
	assert.match(firstAttention, /Fixture request B/);
	assert.doesNotMatch(firstAttention, /OUTSTANDING_A|OUTSTANDING_B/, "attention lists metadata rather than repeating Request bodies");
});

for (const omitted of [false, true]) for (const queuedInput of ["steer", "followUp", undefined] as const) {
	test(`native Answer continuation does not duplicate consumed input (${queuedInput ?? "no input"}, ${omitted ? "omitted Delivery" : "sent"})`, { timeout: 5_000 }, async t => {
		let currentFrames = frames;
		let generations = 0;
		const extension: ExtensionFactory = pi => {
			pi.on("session_start", (_event, ctx) => pi.appendEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: ctx.sessionManager.getSessionId() }));
			registerParticipantLifecycle(pi, handlers(() => currentFrames));
			pi.registerTool({
				name: "agent_message", label: "Answer", description: "Commit one final Answer",
				parameters: answerParameters,
				async execute(toolCallId, _input, _signal, _onUpdate, ctx) {
					currentFrames = frames.slice(1);
					if (queuedInput) pi.sendUserMessage("QUEUED_DIRECTION: pause now.", { deliverAs: queuedInput });
					return { content: [{ type: "text", text: "Answer committed" }],
						details: answerReceipt(ctx, toolCallId, omitted), terminate: true };
				},
			});
		};
		const host = await createTestOwnerHost(t, extension);
		appendDeliveries(host.session.sessionManager);
		host.model.setResponses([
			() => {
				generations++;
				return fauxAssistantMessage(fauxToolCall("agent_message", answerInput, { id: "answer-call" }), { stopReason: "toolUse" });
			},
			context => {
				generations++;
				if (queuedInput) assert.match(JSON.stringify(context), /QUEUED_DIRECTION/);
				const attention = latestAttention(context);
				assert.ok(attention.includes(frames[1]!.requestId), "remaining obligation is presented");
				assert.equal(attention.includes(frames[0]!.requestId), false, "resolved work is absent from current attention");
				return fauxAssistantMessage("Pause here.");
			},
			() => { generations++; return fauxAssistantMessage("Unwanted repeated continuation."); },
		]);
		await host.session.prompt("Answer A, leaving B open.");
		assert.equal(generations, 2, "one continuation, whether native input or outstanding-work notification");
		assert.deepEqual(obligationStack(transcriptFromSessionManager(host.session.sessionManager).inspect(), host.session.sessionManager.getSessionId()), frames.slice(1));
	});
}

for (const omitted of [false, true]) test(`native final Answer settles without a summary generation (${omitted ? "omitted Delivery" : "sent"})`, { timeout: 5_000 }, async t => {
	let currentFrames = frames.slice(0, 1);
	let generations = 0;
	const host = await createTestOwnerHost(t, pi => {
		pi.on("session_start", (_event, ctx) => pi.appendEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: ctx.sessionManager.getSessionId() }));
		registerParticipantLifecycle(pi, handlers(() => currentFrames));
		pi.registerTool({
			name: "agent_message", label: "Answer", description: "Commit the final Answer",
			parameters: answerParameters,
			async execute(toolCallId, _input, _signal, _onUpdate, ctx) {
				currentFrames = [];
				return { content: [{ type: "text", text: "Answer committed" }],
					details: answerReceipt(ctx, toolCallId, omitted), terminate: true };
			},
		});
	});
	appendDeliveries(host.session.sessionManager, 1);
	host.model.setResponses([
		() => { generations++; return fauxAssistantMessage(fauxToolCall("agent_message", answerInput, { id: "final-answer" }), { stopReason: "toolUse" }); },
		() => { generations++; return fauxAssistantMessage("Unwanted summary."); },
	]);
	await host.session.prompt("Answer the final Request.");
	assert.equal(generations, 1);
	assert.deepEqual(obligationStack(transcriptFromSessionManager(host.session.sessionManager).inspect(), host.session.sessionManager.getSessionId()), []);
});
