import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { AgentTranscript } from "../src/transcript/agent-transcript.ts";
import { requestHistory } from "./support/request-history.ts";
import { inspectAnswerDelivery } from "../src/protocol/message.ts";

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
