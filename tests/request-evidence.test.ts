import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ContextEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { registerParticipantLifecycle } from "../src/pi-integration/participant-lifecycle.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { AgentTranscript } from "../src/transcript/agent-transcript.ts";
import { participant, requestHistory } from "./support/request-history.ts";
import { inspectAnswerDelivery } from "../src/protocol/message.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";

test("a recovered child with skipped spawn has no authored Creation Request but retains its delivered duty", () => {
	const history = requestHistory();
	const entryId = history.requester.manager.appendMessage(
		fauxAssistantMessage(fauxToolCall(
			"agent_spawn",
			{ request: "Rejected missing title" },
			{ id: "spawn" },
		)),
	);
	const source = { agentId: "requester", entryId, toolCallId: "spawn" };
	const requestId = deriveMessageIdentity(source);
	history.responder.record.identity = {
		agentId: "responder",
		workflowId: "requester",
		directSpawnerAgentId: "requester",
		creationPreset: null,
		spawnSource: source,
		metadata: { label: "Responder" },
	};
	appendEvidenceDelivery(history.responder, {
		source,
		projection: {
			kind: "request",
			requestMessageId: requestId,
			fromAgentId: "requester",
			title: "Preserved duty",
			question: "Complete the independently delivered work.",
		},
	});
	for (const fresh of [false, true]) {
		if (fresh) {
			for (const participant of [history.requester, history.responder]) {
				participant.record.transcript = transcriptFromSessionManager(
					participant.manager,
					{ fresh: true },
				);
			}
		}
		const evidence = new RequestEvidence(history.agents);
		assert.equal(evidence.resolveRecoveryMessage(history.requester.record, requestId), undefined);
		assert.deepEqual(
			evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds,
			[requestId],
		);
		assert.deepEqual(
			evidence.openIncomingRequests(history.responder.record).requests
				.map(request => request.requestMessageId),
			[requestId],
		);
	}
});

test("orphan Request Cancellation Delivery still requires its original requester", () => {
	const history = requestHistory();
	const third = participant("third-agent");
	history.agents.set(third.record.identity.agentId, third.record);
	const requestSource = { agentId: "requester", entryId: "rejected-request", toolCallId: "orphan-q" };
	const requestId = deriveMessageIdentity(requestSource);
	appendEvidenceDelivery(history.responder, { source: requestSource, projection: {
		kind: "request", requestMessageId: requestId, fromAgentId: "requester", title: "Preserved duty", question: "Only the requester may withdraw this work.",
	} });
	const evidence = new RequestEvidence(history.agents);
	assert.deepEqual(evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds, [requestId]);
	const cancellationSource = { agentId: "third-agent", entryId: "third-cancel", toolCallId: "cancel-q" };
	appendEvidenceDelivery(history.responder, { source: cancellationSource, projection: {
		kind: "request_cancellation", requestMessageId: requestId, fromAgentId: "third-agent",
		cancellationId: deriveMessageIdentity(cancellationSource), reason: "Not this Agent's Request to cancel.",
	} });
	for (const replay of [false, true]) {
		if (replay) for (const p of [history.requester, history.responder, third]) p.record.transcript = transcriptFromSessionManager(p.manager, { fresh: true });
		const current = replay ? new RequestEvidence(history.agents) : evidence;
		assert.throws(() => current.isLocalCancellationDelivered(history.responder.record, requestId), /invariant_violation.*requester/);
		assert.throws(() => current.residualRelationshipsFor(history.responder.record), /invariant_violation.*requester/);
	}
});

for (const validSource of [true, false]) test(`${validSource ? "valid" : "rejected"} orphan Answer source with requester Delivery before author result ${validSource ? "resolves" : "preserves"} the obligation`, { timeout: 5_000 }, async () => {
	const history = requestHistory();
	const requestSource = { agentId: "requester", entryId: "rejected-request", toolCallId: "orphan-q" };
	const requestId = deriveMessageIdentity(requestSource);
	appendEvidenceDelivery(history.responder, { source: requestSource, projection: {
		kind: "request", requestMessageId: requestId, fromAgentId: "requester", title: "Preserved duty", question: "Complete this work once.",
	} });
	const evidence = new RequestEvidence(history.agents);
	assert.deepEqual(evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds, [requestId]);
	const toolCallId = "answer-before-author-result";
	const entryId = history.responder.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "answer", requestId, answer: validSource ? "Verified work." : "",
	}, { id: toolCallId })));
	const answerSource = { agentId: "responder", entryId, toolCallId };
	const answerId = deriveMessageIdentity(answerSource);
	appendEvidenceDelivery(history.requester, { source: answerSource, projection: {
		kind: "answer", requestMessageId: requestId, requestTitle: "Preserved duty", answerId, fromAgentId: "responder", answer: "Verified work.",
	} });
	for (const replay of [false, true]) {
		if (replay) for (const p of [history.requester, history.responder]) p.record.transcript = transcriptFromSessionManager(p.manager, { fresh: true });
		const current = replay ? new RequestEvidence(history.agents) : evidence;
		assert.equal(current.findLocalAnswer(history.responder.record, requestId)?.messageId, validSource ? answerId : undefined);
		assert.deepEqual(current.residualRelationshipsFor(history.responder.record).answerOwedRequestIds, validSource ? [] : [requestId]);
		assert.deepEqual(current.openIncomingRequests(history.responder.record).requests.map(request => request.requestMessageId), validSource ? [] : [requestId]);
		assert.equal(current.resolveRecoveryMessage(history.responder.record, answerId), undefined);
		const original = JSON.stringify(history.responder.manager.getEntries());
		const { beforeStartup, afterStartup } = await recoveredObligationContext(current, history.responder);
		// Without the coordinator's cross-Agent proof, the local Delivery still presents this duty.
		assert.match(JSON.stringify(beforeStartup), new RegExp(requestId));
		if (validSource) assert.doesNotMatch(JSON.stringify(afterStartup), new RegExp(requestId));
		else assert.match(JSON.stringify(afterStartup), new RegExp(requestId));
		assert.equal(JSON.stringify(history.responder.manager.getEntries()), original,
			"verified startup reconciliation must not persist obligation authority");
	}
});

async function recoveredObligationContext(evidence: RequestEvidence, responder: ReturnType<typeof participant>) {
	type Hook = (event: never, context: ExtensionContext) => unknown;
	const hooks = new Map<string, Hook>();
	const api = {
		on(name: string, hook: Hook) { hooks.set(name, hook); },
		appendEntry(type: string, data: unknown) { responder.manager.appendCustomEntry(type, data); },
		sendMessage() { assert.fail("context reconciliation must not enqueue a continuation"); },
	} as unknown as ExtensionAPI;
	registerParticipantLifecycle(api, {
		async executionStarted() { return evidence.obligationFrames(responder.record); },
		async humanInputSubmitted() { return "continue"; },
		async primaryInputQueued() {},
		async humanInputMode() { return "agent"; },
		async toolResultCommitting() {},
		async toolExecutionStarted() {},
		async safeBoundaryReached() {},
		async executionEnded() {},
	}, { registerInput: false });
	const context = { sessionManager: responder.manager } as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown) => {
		assert.ok(hooks.has(name), `registered ${name} hook`);
		return hooks.get(name)!(event as never, context);
	};
	const beforeStartup = await emit("context", { type: "context", messages: [] }) as { messages: ContextEvent["messages"] };
	await emit("agent_start", { type: "agent_start" });
	const afterStartup = await emit("context", { type: "context", messages: beforeStartup.messages });
	return { beforeStartup, afterStartup };
}

function appendEvidenceDelivery(recipient: ReturnType<typeof participant>, item: Parameters<typeof createMessageDelivery>[0][number]) {
	const delivery = createMessageDelivery([item]);
	recipient.manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
}

for (const outcome of [
	{ messageStatus: "not_sent", reason: "target_unavailable" },
	{ messageStatus: "not_sent", reason: "host_shutting_down" },
	{ messageStatus: "not_sent", reason: "capacity_exhausted" },
	{ messageStatus: "unknown", reason: "confirmation_lost" },
	{ messageStatus: "sent" },
] as const) {
	test(`Request reconstruction distinguishes initial ${outcome.messageStatus} ${"reason" in outcome ? outcome.reason : ""} from retry failure`, () => {
		const history = requestHistory();
		const author = history.requester;
		const toolCallId = "initial-request";
		const entryId = author.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
			title: "Fixture request",
			operation: "request", targetAgent: "responder", question: "Only admitted or uncertain work remains outstanding.",
		}, { id: toolCallId })));
		const requestMessageId = deriveMessageIdentity({ agentId: "requester", entryId, toolCallId });
		author.manager.appendMessage({
			role: "toolResult", toolName: "agent_message", toolCallId, content: [], isError: false, timestamp: Date.now(),
			details: { requestMessageId, targetAgentId: "responder", ...outcome },
		});
		// A later retry failure cannot redefine the original authoring outcome.
		author.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
			operation: "retry", messageId: requestMessageId,
		}, { id: "failed-retry" })));
		author.manager.appendMessage({
			role: "toolResult", toolName: "agent_message", toolCallId: "failed-retry", content: [], isError: false, timestamp: Date.now(),
			details: { requestMessageId, targetAgentId: "responder", messageStatus: "not_sent", reason: "target_unavailable" },
		});
		for (let reopen = 0; reopen < 2; reopen++) {
			const evidence = new RequestEvidence(history.agents);
			assert.deepEqual(evidence.outstandingRequestIdsFor(author.record), outcome.messageStatus === "not_sent" ? [] : [requestMessageId]);
			assert.deepEqual(evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds, []);
			if (outcome.messageStatus === "not_sent") assert.throws(() => evidence.requireRequest(requestMessageId), /unknown_identity/);
			else assert.equal(evidence.requireRequest(requestMessageId).messageId, requestMessageId);
		}
	});
}

test("a backlog arriving during relationship catch-up stays within the physical consumption budget", async () => {
	const history = requestHistory();
	for (let i = 0; i < 400; i++) history.answer(history.request());
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	const evidence = new RequestEvidence(history.agents);
	const pending = evidence.refreshRelationshipsFor(history.requester.record);
	const before = history.responder.record.transcript.diagnostics()!.entriesConsumed;
	const backlog = 20_000;
	for (let i = 0; i < backlog; i++) history.responder.manager.appendCustomEntry("marker", { i });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.ok(history.responder.record.transcript.diagnostics()!.entriesConsumed - before < backlog,
		"new evidence must yield before consuming the complete backlog");
	await pending;
	assert.equal(history.responder.record.transcript.diagnostics()!.entriesConsumed - before, backlog);
});

test("a scope replacement discards a yielding relationship reconstruction", async () => {
	const history = requestHistory();
	for (let i = 0; i < 400; i++) history.answer(history.request());
	history.request();
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	const evidence = new RequestEvidence(history.agents);
	const pending = evidence.refreshRelationshipsFor(history.requester.record);
	for (const participant of [history.requester, history.responder]) {
		const agentId = participant.record.identity.agentId;
		participant.manager.newSession({ id: agentId });
		participant.manager.appendCustomEntry("agent-coordination.identity", { agentId });
	}
	assert.deepEqual(evidence.residualRelationshipsFor(history.requester.record), { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
	assert.deepEqual(await pending, { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
});

test("Answer Delivery rejects a Retrieval that reuses its source for another Request", () => {
	const history = requestHistory();
	const requestId = history.request();
	history.answer(requestId);
	const evidence = new RequestEvidence(history.agents);
	const answer = evidence.findAnswer(evidence.requireRequest(requestId))!;
	assert.ok(answer);
	assert.deepEqual(
		evidence.residualRelationshipsFor(history.requester.record).awaitingAnswerRequestIds,
		[],
	);
	const differentRequestId = history.request();
	history.requester.manager.appendMessage({
		role: "toolResult",
		toolCallId: "conflicting-retrieval",
		toolName: "agent_message",
		content: [],
		isError: false,
		timestamp: Date.now(),
		details: {
			requestTitle: "Fixture request",
			disposition: "answer_delivered",
			requestMessageId: differentRequestId,
			answerId: answer.messageId,
			fromAgentId: answer.fromAgentId,
			answer: answer.answer,
			answerSource: answer.source,
		},
	});
	assert.throws(
		() =>
			inspectAnswerDelivery({
				requesterAgentId: "requester",
				transcript: history.requester.record.transcript.inspect(),
				answer,
			}),
		/Retrieval differs from its source/,
	);
	assert.throws(
		() => evidence.residualRelationshipsFor(history.requester.record),
		/invariant_violation/,
	);
});

test("a rejected later Cancellation cannot invalidate an earlier Agent Wait", () => {
	const history = requestHistory();
	const requestId = history.request();
	const manager = history.requester.manager;
	const toolCallId = "wait-before-rejected-cancel";
	const entryId = manager.appendMessage(
		fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: toolCallId }), {
			stopReason: "toolUse",
		}),
	);
	const evidence = new RequestEvidence(history.agents);
	const waitSource = { agentId: "requester", entryId, toolCallId };
	assert.deepEqual(evidence.outstandingRequestIdsAt(history.requester.record, waitSource), [
		requestId,
	]);
	manager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "cancel", requestMessageId: "no-such-request", reason: "Bad call" },
				{ id: "bad-cancel" },
			),
			{ stopReason: "toolUse" },
		),
	);
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "bad-cancel",
		toolName: "agent_message",
		content: [],
		details: {},
		isError: true,
		timestamp: Date.now(),
	});
	assert.deepEqual(evidence.outstandingRequestIdsAt(history.requester.record, waitSource), [
		requestId,
	]);
});

test("synchronous relationship reads catch commits made during a yielding reconstruction", async () => {
	const history = requestHistory();
	const requestId = history.request();
	for (let i = 0; i < 400; i++) history.answer(history.request());
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	const evidence = new RequestEvidence(history.agents);
	const pending = evidence.refreshRelationshipsFor(history.requester.record);
	history.answer(requestId);
	const result = evidence.residualRelationshipsFor(history.requester.record);
	assert.deepEqual(result.awaitingAnswerRequestIds, []);
	assert.deepEqual((await pending).awaitingAnswerRequestIds, []);
});

test("residual relationships retain unchanged results and consume new Requests and Answers", async () => {
	const history = requestHistory();
	for (let i = 0; i < 400; i++) history.answer(history.request());
	const evidence = new RequestEvidence(history.agents);
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	const settled = await evidence.refreshRelationshipsFor(history.requester.record);
	assert.deepEqual(settled, { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
	for (let i = 0; i < 20; i++)
		assert.equal(evidence.residualRelationshipsFor(history.requester.record), settled);
	const requestId = history.request();
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	assert.deepEqual(await evidence.refreshRelationshipsFor(history.requester.record), {
		awaitingAnswerRequestIds: [requestId],
		answerOwedRequestIds: [],
	});
	assert.deepEqual(await evidence.refreshRelationshipsFor(history.responder.record), {
		awaitingAnswerRequestIds: [],
		answerOwedRequestIds: [requestId],
	});
	history.answer(requestId);
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	const refresh = evidence.refreshRelationshipsFor(history.requester.record);
	assert.deepEqual(evidence.residualRelationshipsFor(history.requester.record), settled);
	assert.deepEqual(await refresh, settled);
	assert.deepEqual(await evidence.refreshRelationshipsFor(history.responder.record), settled);
});

test("Creation Request lookup trusts loaded identity and creation input without Spawner reads", () => {
	const ownerSession = SessionManager.inMemory(process.cwd(), { id: "owner" });
	const owner = record("owner", ownerSession);
	const toolCallId = "spawn-worker";
	const entryId = ownerSession.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", { title: "Fixture request", request: "Review the result." }, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const source = { agentId: "owner", entryId, toolCallId };
	const child = record("worker");
	child.identity = {
		agentId: "worker",
		workflowId: "owner",
		directSpawnerAgentId: "owner",
		creationPreset: null,
		spawnSource: source,
		metadata: { label: "Worker" },
	};
	child.creationInput = { title: "Fixture request", request: "Review the result." };
	owner.transcript = new AgentTranscript({
		read() {
			throw new Error("Spawner history must not be revalidated");
		},
	});
	const unrelated = record("unrelated");
	unrelated.transcript = new AgentTranscript({
		read() {
			throw new Error("Creation Request resolution must not acquire unrelated history");
		},
	});
	const evidence = new RequestEvidence(
		new Map([
			[unrelated.identity.agentId, unrelated],
			[owner.identity.agentId, owner],
			[child.identity.agentId, child],
		]),
	);
	const requestId = deriveMessageIdentity(source);

	assert.deepEqual(evidence.requireRequest(requestId), {
		title: "Fixture request",
		kind: "request",
		origin: "agent_spawn",
		messageId: requestId,
		workflowId: "owner",
		fromAgentId: "owner",
		targetAgentId: "worker",
		deliveryMode: "deferred",
		source,
		question: "Review the result.",
	});
});

function record(
	agentId: string,
	manager = SessionManager.inMemory(process.cwd(), { id: agentId }),
): AgentRecord {
	manager.appendCustomEntry("agent-coordination.identity", { agentId });
	return {
		identity: {
			agentId,
			workflowId: "owner",
			directSpawnerAgentId: null,
			metadata: { label: "Owner", description: "Workflow Owner" },
		},
		host: {} as AgentRecord["host"],
		transcript: transcriptFromSessionManager(manager),
		children: [],
	};
}

test("a committed Cancellation resolves a responder that never received it", () => {
	const history = requestHistory();
	const requestId = history.request();
	const source = {
		agentId: history.requester.record.identity.agentId,
		entryId: history.requester.manager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{ operation: "cancel", requestMessageId: requestId, reason: "Withdrawn" },
					{ id: "cancel-withdrawn" },
				),
				{ stopReason: "toolUse" },
			),
		),
		toolCallId: "cancel-withdrawn",
	};
	// The Cancellation Message is admitted but never delivered to the responder.
	history.requester.manager.appendMessage({
		role: "toolResult",
		toolCallId: source.toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Committed." }],
		details: {
			messageId: deriveMessageIdentity(source),
			targetAgentId: history.responder.record.identity.agentId,
			messageStatus: "sent",
		},
		isError: false,
		timestamp: Date.now(),
	});

	const evidence = new RequestEvidence(history.agents);
	assert.deepEqual(
		evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds,
		[],
		"the requester's withdrawal ends the responder's duty without Delivery",
	);
	assert.deepEqual(
		evidence.residualRelationshipsFor(history.requester.record).awaitingAnswerRequestIds,
		[],
	);
});
