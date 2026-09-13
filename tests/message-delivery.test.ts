import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { ModeratorReportStore } from "../src/coordination/moderator-reports.ts";
import { inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import { inspectStandaloneMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createMessageDeliveryItem, inspectMessageDelivery, type Message } from "../src/protocol/message.ts";
import { createCreationRequestDeliveryItem, inspectCreationRequestDelivery } from "../src/protocol/creation-request.ts";
import { inspectAnswerDelivery } from "../src/protocol/message.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";

test("each Message in one ordered batch has independent Delivery proof", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: recipientAgentId,
	});
	const firstSource = {
		agentId: "sender-agent",
		entryId: "sender-entry-one",
		toolCallId: "sender-call-one",
	};
	const secondSource = {
		agentId: "sender-agent",
		entryId: "sender-entry-two",
		toolCallId: "sender-call-two",
	};
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({
			messages: [
				{
					kind: "message",
					messageId: "message-one",
					fromAgentId: "sender-agent",
					content: "First admitted direction.",
				},
				{
					kind: "message",
					messageId: "message-two",
					fromAgentId: "sender-agent",
					content: "Second admitted direction.",
				},
			],
		}),
		true,
		{ messages: [firstSource, secondSource] },
	);
	const delivery = sessionManager.getLeafEntry();
	assert.ok(delivery);

	const first = inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		source: firstSource,
		identity: {
			kind: "message",
			messageId: "message-one",
			fromAgentId: "sender-agent",
		},
		subject: "Message message-one",
	});
	const second = inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		source: secondSource,
		identity: {
			kind: "message",
			messageId: "message-two",
			fromAgentId: "sender-agent",
		},
		subject: "Message message-two",
	});

	assert.deepEqual(first.deliveryEvidence, {
		agentId: recipientAgentId,
		entryId: delivery.id,
	});
	assert.deepEqual(second.deliveryEvidence, {
		agentId: recipientAgentId,
		entryId: delivery.id,
	});
});

test("Agent Request Delivery exposes requestMessageId as its correlation identity", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: recipientAgentId,
	});
	const source = {
		agentId: "requester-agent",
		entryId: "requester-entry",
		toolCallId: "requester-call",
	};
	const projection = {
		title: "Fixture request",
		kind: "request" as const,
		requestMessageId: "request-message",
		fromAgentId: "requester-agent",
		question: "Which identity should the Answer correlate to?",
	};
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({ messages: [projection] }),
		true,
		{ messages: [source] },
	);
	const delivery = sessionManager.getLeafEntry();
	assert.ok(delivery);

	assert.deepEqual(inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		source,
		identity: { kind: projection.kind, messageId: projection.requestMessageId, fromAgentId: projection.fromAgentId },
		subject: "Request request-message",
	}).deliveryEvidence, {
		agentId: recipientAgentId,
		entryId: delivery.id,
	});
});

test("host-authored obligation reminders do not become Agent Message evidence", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: recipientAgentId,
	});
	const source = {
		agentId: "sender-agent",
		entryId: "sender-entry",
		toolCallId: "sender-call",
	};
	const projection = {
		kind: "message" as const,
		messageId: "message-before-reminder",
		fromAgentId: "sender-agent",
		content: "Preserve this Delivery proof.",
	};
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({ messages: [projection] }),
		true,
		{ messages: [source] },
	);
	const delivery = sessionManager.getLeafEntry();
	assert.ok(delivery);
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.obligation-reminder",
		JSON.stringify({
			requestMessageId: "request-1",
			requestTitle: "Answer the pending Request.",
			guidance:
				"This Request still needs an Answer. Choose which outstanding Request to work on or answer; attention order does not prescribe execution order. Send each Answer as a standalone agent_message operation \"answer\" call, then end the turn without a summary.",
		}),
		true,
	);

	sessionManager.appendCustomMessageEntry(
		"agent-coordination.moderator-obligation-reminder",
		"Inspect the original Moderator Input.",
		true,
	);
	assert.deepEqual(inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		source,
		identity: { kind: projection.kind, messageId: projection.messageId, fromAgentId: projection.fromAgentId },
		subject: "Message message-before-reminder",
	}).deliveryEvidence, {
		agentId: recipientAgentId,
		entryId: delivery.id,
	});
});

test("one Delivery batch cannot repeat a Message source", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: recipientAgentId,
	});
	const source = {
		agentId: "sender-agent",
		entryId: "sender-entry",
		toolCallId: "sender-call",
	};
	const projection = {
		kind: "message" as const,
		messageId: "repeated-message",
		fromAgentId: "sender-agent",
		content: "This source must appear only once.",
	};
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({ messages: [projection, projection] }),
		true,
		{ messages: [source, source] },
	);

	assert.throws(
		() => inspectStandaloneMessageDelivery({
			recipientAgentId,
			transcript: transcriptFromSessionManager(sessionManager).inspect(),
			source,
			identity: { kind: projection.kind, messageId: projection.messageId, fromAgentId: projection.fromAgentId },
			subject: "Message repeated-message",
		}),
		/Message Delivery repeats a source/,
	);
});

test("committed receipts trust content for every Message kind while writers preserve it", () => {
	for (const kind of ["message", "request", "answer", "request_cancellation"] as const) {
		const manager = SessionManager.inMemory(process.cwd());
		const recipientAgentId = manager.getSessionId();
		manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: recipientAgentId });
		const common = { messageId: "identity", workflowId: "workflow", fromAgentId: "sender",
			targetAgentId: recipientAgentId, deliveryMode: "deferred" as const,
			source: { agentId: "sender", entryId: "entry", toolCallId: "call" } };
		const message: Message = kind === "message" ? { ...common, kind, origin: "agent_message", content: "intended" }
			: kind === "request" ? { title: "Fixture request", ...common, kind, origin: "agent_message", question: "intended" }
			: kind === "answer" ? { requestTitle: "Fixture request", ...common, kind, requestId: "request", answer: "intended" }
			: { ...common, kind, requestId: "request", reason: "intended" };
		const item = createMessageDeliveryItem(message);
		const textKey = kind === "message" ? "content" : kind === "request" ? "question" : kind === "answer" ? "answer" : "reason";
		assert.equal((item.projection as unknown as Record<string, unknown>)[textKey], "intended");
		const written = createMessageDelivery([item]);
		assert.deepEqual(JSON.parse(written.content), { messages: [item.projection] });
		const inspect = () => inspectMessageDelivery({ recipientAgentId, transcript: transcriptFromSessionManager(manager).inspect(), message });
		assert.equal(inspect().deliveryEvidence, undefined, "not committed is not delivered");
		const entryId = manager.appendCustomMessageEntry(written.customType,
			JSON.stringify({ messages: [{ ...item.projection, [textKey]: "different committed text" }] }),
			written.display, written.details);
		assert.deepEqual(inspect().deliveryEvidence, { agentId: recipientAgentId, entryId });
		for (const changed of [{ messageId: "other" }, { fromAgentId: "other" },
			{ kind: kind === "message" ? "request" : "message" },
			...(kind === "answer" || kind === "request_cancellation" ? [{ requestId: "other" }] : [])]) {
			assert.throws(() => inspectMessageDelivery({ recipientAgentId, transcript: transcriptFromSessionManager(manager).inspect(),
				message: { ...message, ...changed } as Message }), /Delivery differs from its source/);
		}
		assert.equal(inspectMessageDelivery({ recipientAgentId, transcript: transcriptFromSessionManager(manager).inspect(),
			message: { ...message, source: { ...message.source, toolCallId: "unrelated" } } }).deliveryEvidence, undefined);
		assert.throws(() => inspectMessageDelivery({ recipientAgentId: "other", transcript: transcriptFromSessionManager(manager).inspect(), message }), /recipient/);
	}
});

test("Creation Request receipt needs identity, not reconstructed spawn question", () => {
	const manager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = manager.getSessionId();
	manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: recipientAgentId });
	const source = { agentId: "spawner", entryId: "spawn-entry", toolCallId: "spawn-call" };
	const requestId = deriveMessageIdentity(source);
	assert.deepEqual(createCreationRequestDeliveryItem({ title: "Fixture request", requestId, fromAgentId: "spawner", source, question: "Intended spawn input" }),
		{ source, projection: { title: "Fixture request", kind: "request", requestMessageId: requestId, fromAgentId: "spawner", question: "Intended spawn input" } });
	const entryId = manager.appendCustomMessageEntry("agent-coordination.message-delivery",
		JSON.stringify({ messages: [{ title: "Fixture request", kind: "request", requestMessageId: requestId,
			fromAgentId: "spawner", question: "Committed question is authoritative." }] }), true, { messages: [source] });
	const inspect = () => inspectCreationRequestDelivery({ title: "Fixture request", recipientAgentId,
		transcript: transcriptFromSessionManager(manager).inspect(), requestId, fromAgentId: "spawner", source });
	assert.deepEqual(inspect().deliveryEvidence, { agentId: recipientAgentId, entryId });
	assert.throws(() => inspectCreationRequestDelivery({ title: "Fixture request", recipientAgentId,
		transcript: transcriptFromSessionManager(manager).inspect(), requestId: "unrelated", fromAgentId: "spawner", source }),
		/Creation Request .* Delivery differs from its source/);
	manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: recipientAgentId });
	assert.equal(inspect().deliveryEvidence, undefined, "receipt before current identity is not current-scope delivery");
});

test("committed Answer retrieval trusts text but preserves source and Request correlation", () => {
	const manager = SessionManager.inMemory(process.cwd());
	const requesterAgentId = manager.getSessionId();
	manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: requesterAgentId });
	const requestEntryId = manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: "responder", title: "Fixture request", question: "Provide an Answer.",
	}, { id: "request-call" }), { stopReason: "toolUse" }));
	const requestId = deriveMessageIdentity({ agentId: requesterAgentId, entryId: requestEntryId, toolCallId: "request-call" });
	const source = { agentId: "responder", entryId: "answer-entry", toolCallId: "answer-call" };
	const answer = { workflowId: "workflow", deliveryMode: "deferred" as const, requestTitle: "Fixture request", kind: "answer" as const, messageId: deriveMessageIdentity(source),
		requestId, fromAgentId: "responder", targetAgentId: requesterAgentId, source,
		answer: "Different original answer" };
	const entryId = manager.appendMessage({ role: "toolResult", toolCallId: "retrieve",
		toolName: "agent_message", content: [], isError: false, timestamp: Date.now(),
		details: { requestTitle: "Fixture request", disposition: "answer_delivered", requestMessageId: answer.requestId,
			answerId: answer.messageId, fromAgentId: answer.fromAgentId, answer: "Authoritative retrieved text", answerSource: source } });
	assert.deepEqual(inspectAnswerDelivery({ requesterAgentId, transcript: transcriptFromSessionManager(manager).inspect(), answer }).deliveryEvidence,
		{ agentId: requesterAgentId, entryId });
	assert.throws(() => inspectAnswerDelivery({ requesterAgentId, transcript: transcriptFromSessionManager(manager).inspect(),
		answer: { ...answer, requestId: "other" } }), /Retrieval differs from its source/);
});

test("receipt trust does not relax exact schemas, visibility or duplicate policy", () => {
	for (const scenario of ["extra-field", "hidden", "duplicate"] as const) {
		const manager = SessionManager.inMemory(process.cwd());
		const recipientAgentId = manager.getSessionId();
		manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: recipientAgentId });
		const source = { agentId: "sender", entryId: "entry", toolCallId: "call" };
		const identity = { kind: "message" as const, messageId: "message", fromAgentId: "sender" };
		const content = JSON.stringify({ messages: [{ ...identity, content: "committed",
			...(scenario === "extra-field" ? { extra: true } : {}) }] });
		manager.appendCustomMessageEntry("agent-coordination.message-delivery", content,
			scenario !== "hidden", { messages: [source] });
		if (scenario === "duplicate") manager.appendCustomMessageEntry(
			"agent-coordination.message-delivery", content, true, { messages: [source] });
		assert.throws(() => inspectStandaloneMessageDelivery({ recipientAgentId,
			transcript: transcriptFromSessionManager(manager).inspect(), source, identity, subject: "Message" }),
			scenario === "extra-field" ? /invalid shape/ : scenario === "hidden" ? /model-visible/ : /duplicate Deliveries/);
	}
});

test("retained delivery projection consumes report publication and read-state changes without Message proof", async () => {
	const manager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = manager.getSessionId();
	manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: recipientAgentId });
	const transcript = transcriptFromSessionManager(manager);
	await transcript.refresh();
	const reports = new ModeratorReportStore({
		transcript,
		appendCustomEntry: (type, data) => manager.appendCustomEntry(type, data),
	});
	const report = reports.publish({
		symptom: "Stalled", suspectedDefect: "Lost wake", uncertainty: "Unconfirmed",
		recoveryActions: "Inspected", recoveryOutcome: "Recovered", evidence: ["entry:call"],
	}, { agentId: "moderator", label: "Moderator" }, {
		agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/moderator.jsonl",
	});
	assert.deepEqual(inspectMessageDeliveries({ recipientAgentId, transcript: await transcript.refresh() }), []);
	reports.setRead(report.reportId, true);
	assert.deepEqual(inspectMessageDeliveries({ recipientAgentId, transcript: await transcript.refresh() }), []);
	assert.ok(reports.history()[0]?.readAt);
	reports.setRead(report.reportId, false);
	assert.deepEqual(inspectMessageDeliveries({ recipientAgentId, transcript: await transcript.refresh() }), []);

	const source = { agentId: "sender", entryId: "message", toolCallId: "send" };
	const projection = { kind: "message" as const, messageId: deriveMessageIdentity(source), fromAgentId: source.agentId, content: "Continue" };
	const delivery = createMessageDelivery([{ source, projection }]);
	const entryId = manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	const expected = [{ source, projection, deliveryEvidence: { agentId: recipientAgentId, entryId } }];
	assert.deepEqual(inspectMessageDeliveries({ recipientAgentId, transcript: await transcript.refresh() }), expected);
	assert.deepEqual(inspectMessageDeliveries({ recipientAgentId, transcript: transcriptFromSessionManager(manager).inspect() }), expected);
});

test("delivery projection still rejects unknown current-scope coordination entries", () => {
	const manager = SessionManager.inMemory(process.cwd());
	manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: manager.getSessionId() });
	manager.appendCustomEntry("agent-coordination.unknown", {});
	assert.throws(() => inspectMessageDeliveries({ recipientAgentId: manager.getSessionId(), transcript: transcriptFromSessionManager(manager).inspect() }), /unexpected current-scope coordination entry agent-coordination\.unknown/);
});
