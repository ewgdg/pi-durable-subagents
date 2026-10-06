import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";

import { requestCoordination } from "./support/request-coordination.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { participant, requestHistory } from "./support/request-history.ts";
import { fauxAssistantMessage, fauxToolCall, type JsonObject, type JsonValue } from "@earendil-works/pi-ai";
import { deriveMessageIdentity, type ToolCallPointer } from "../src/protocol/identities.ts";
import type { RequestRelationships } from "../src/coordination/request-relationships.ts";
import { createCreationRequestDeliveryItem } from "../src/protocol/creation-request.ts";
import { resolveCommittedAnswer } from "../src/protocol/message.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedAgentRuntime } from "../src/runtime/hosted-agent-runtime.ts";
import { inspectCoordinationRejections } from "../src/protocol/replay-rejection.ts";

for (const size of [40, 80]) {
	test(`warm relationship refresh audits ${size} sources without per-Agent roster scans`, async () => {
		const participants = Array.from({ length: size }, (_, index) => participant(`agent-${index}`));
		const agents = new Map(participants.map(({ record }) => [record.identity.agentId, record]));
		const relationships = requestCoordination(agents).requestRelationships;
		await relationships.refresh();
		let inspections = 0;
		let refreshes = 0;
		for (const { record } of participants) {
			const inspect = record.transcript.inspect.bind(record.transcript);
			const refresh = record.transcript.refresh.bind(record.transcript);
			record.transcript.inspect = () => { inspections++; return inspect(); };
			record.transcript.refresh = async () => { refreshes++; return refresh(); };
		}
		await relationships.refresh();
		assert.equal(refreshes, size, "the authoritative all-source freshness audit remains required");
		assert.ok(inspections <= 12 * size,
			`warm refresh used ${inspections} transcript inspections for ${size} Agents; expected linear work`);
	});
}

test("scoped and global readers independently catch up to shared Request changes", async () => {
	const history = requestHistory();
	const third = participant("third");
	history.agents.set("third", third.record);
	const relationships = requestCoordination(history.agents).requestRelationships;
	await relationships.refresh();
	const first = history.request();
	assert.deepEqual(relationships.relationshipsFor(history.requester.record).awaitingAnswerRequestIds, [first]);
	const second = history.request(third, history.responder);
	history.answer(first);
	assert.deepEqual((await relationships.catchUp(history.requester.record)).awaitingAnswerRequestIds, []);
	await relationships.refresh();
	assert.deepEqual(relationships.relationshipsFor(history.responder.record).answerOwedRequestIds, [second]);
	assert.deepEqual(relationships.relationshipsFor(third.record).awaitingAnswerRequestIds, [second]);
	for (const record of history.agents.values()) {
		assert.deepEqual(relationships.relationshipsFor(record), requestCoordination(history.agents).requestRelationships.relationshipsFor(record));
	}
});

test("non-coordination appends preserve relationship results while silent Answers are observed", async () => {
	const history = requestHistory();
	const requestId = history.request();
	const relationships = requestCoordination(history.agents).requestRelationships;
	await relationships.refresh();
	const before = relationships.relationshipsFor(history.requester.record);
	history.responder.manager.appendCustomEntry("marker", { unrelated: true });
	await relationships.refresh();
	assert.equal(relationships.relationshipsFor(history.requester.record), before);
	history.answer(requestId); // No dirty hint: reads must still verify the authority.
	await relationships.refresh();
	assert.deepEqual(relationships.relationshipsFor(history.requester.record).awaitingAnswerRequestIds, []);
	assert.deepEqual(relationships.relationshipsFor(history.responder.record).answerOwedRequestIds, []);
});

test("a yielding shared batch preserves concurrent Answers and roster admission", { timeout: 5_000 }, async () => {
	const history = requestHistory();
	const requests = Array.from({ length: 400 }, () => history.request());
	for (const record of history.agents.values()) await record.transcript.refresh();
	const relationships = requestCoordination(history.agents).requestRelationships;
	let completed = false;
	const pending = relationships.refresh().then(() => { completed = true; });
	await yieldTurn();
	assert.equal(completed, false, "shared Request collection must yield for this backlog");
	history.answer(requests[0]!);
	const third = participant("third");
	history.agents.set("third", third.record);
	const incoming = history.request(third, history.responder);
	await Promise.all([pending, relationships.catchUp(history.requester.record)]);
	assert.deepEqual(relationships.relationshipsFor(history.requester.record).awaitingAnswerRequestIds, requests.slice(1));
	assert.deepEqual(relationships.relationshipsFor(third.record).awaitingAnswerRequestIds, [incoming]);
	const expectedOwed = [...requests.slice(1), incoming].sort();
	assert.deepEqual([...relationships.relationshipsFor(history.responder.record).answerOwedRequestIds].sort(), expectedOwed);
	assert.deepEqual([...requestCoordination(history.agents).requestRelationships.relationshipsFor(history.responder.record).answerOwedRequestIds].sort(), expectedOwed);
});

test("failed relationship evaluation remains visible on retry and recovers after an authoritative cutoff", async () => {
	const history = requestHistory();
	const requestId = history.request();
	const relationships = requestCoordination(history.agents).requestRelationships;
	await relationships.refresh();
	history.answer(requestId);
	history.answer(requestId);
	for (let attempt = 0; attempt < 2; attempt++) {
		await assert.rejects(relationships.refresh(), /invariant_violation/);
	}
	for (const p of [history.requester, history.responder]) {
		p.manager.appendCustomEntry("agent-coordination.identity", { agentId: p.record.identity.agentId });
	}
	const next = history.request();
	await relationships.refresh();
	assert.deepEqual(relationships.relationshipsFor(history.requester.record).awaitingAnswerRequestIds, [next]);
	assert.deepEqual(relationships.relationshipsFor(history.responder.record).answerOwedRequestIds, [next]);
});

test("same-size Agent replacement invalidates old membership without reusing the old record's graph", async () => {
	const history = requestHistory();
	const requestId = history.request();
	const relationships = requestCoordination(history.agents).requestRelationships;
	await relationships.refresh();
	const replacement = participant("responder");
	history.agents.set("responder", replacement.record);
	await relationships.refresh();
	assert.deepEqual(relationships.relationshipsFor(history.requester.record).awaitingAnswerRequestIds, [requestId]);
	assert.deepEqual(relationships.relationshipsFor(replacement.record).answerOwedRequestIds, []);
});

test("source replacement and same-record identity cutoff invalidate shared relationship progress", async () => {
	const history = requestHistory();
	const requestId = history.request();
	const relationships = requestCoordination(history.agents).requestRelationships;
	await relationships.refresh();
	assert.deepEqual(relationships.relationshipsFor(history.requester.record).awaitingAnswerRequestIds, [requestId]);
	for (const p of [history.requester, history.responder]) {
		p.manager.appendCustomEntry("agent-coordination.identity", { agentId: p.record.identity.agentId });
	}
	await relationships.refresh();
	for (const p of [history.requester, history.responder]) {
		assert.deepEqual(relationships.relationshipsFor(p.record), { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
		p.record.transcript = transcriptFromSessionManager(p.manager, { fresh: true });
	}
	const next = history.request();
	await relationships.refresh();
	assert.deepEqual(relationships.relationshipsFor(history.requester.record).awaitingAnswerRequestIds, [next]);
	assert.deepEqual(relationships.relationshipsFor(history.responder.record).answerOwedRequestIds, [next]);
});

test("a backlog arriving during relationship catch-up stays within the physical consumption budget", async () => {
	const history = requestHistory();
	for (let i = 0; i < 400; i++) history.answer(history.request());
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	const relationships = requestCoordination(history.agents).requestRelationships;
	const pending = relationships.catchUp(history.requester.record);
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
	const relationships = requestCoordination(history.agents).requestRelationships;
	const pending = relationships.catchUp(history.requester.record);
	for (const participant of [history.requester, history.responder]) {
		const agentId = participant.record.identity.agentId;
		participant.manager.newSession({ id: agentId });
		participant.manager.appendCustomEntry("agent-coordination.identity", { agentId });
	}
	assert.deepEqual(relationships.relationshipsFor(history.requester.record), { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
	assert.deepEqual(await pending, { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
});

test("synchronous relationship reads catch commits made during a yielding reconstruction", async () => {
	const history = requestHistory();
	const requestId = history.request();
	for (let i = 0; i < 400; i++) history.answer(history.request());
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	const relationships = requestCoordination(history.agents).requestRelationships;
	const pending = relationships.catchUp(history.requester.record);
	history.answer(requestId);
	const result = relationships.relationshipsFor(history.requester.record);
	assert.deepEqual(result.awaitingAnswerRequestIds, []);
	assert.deepEqual((await pending).awaitingAnswerRequestIds, []);
});

test("residual relationships retain unchanged results and consume new Requests and Answers", async () => {
	const history = requestHistory();
	for (let i = 0; i < 400; i++) history.answer(history.request());
	const relationships = requestCoordination(history.agents).requestRelationships;
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	const settled = await relationships.catchUp(history.requester.record);
	assert.deepEqual(settled, { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
	for (let i = 0; i < 20; i++)
		assert.equal(relationships.relationshipsFor(history.requester.record), settled);
	const requestId = history.request();
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	assert.deepEqual(await relationships.catchUp(history.requester.record), {
		awaitingAnswerRequestIds: [requestId],
		answerOwedRequestIds: [],
	});
	assert.deepEqual(await relationships.catchUp(history.responder.record), {
		awaitingAnswerRequestIds: [],
		answerOwedRequestIds: [requestId],
	});
	history.answer(requestId);
	for (const agent of history.agents.values()) await agent.transcript.refresh();
	const refresh = relationships.catchUp(history.requester.record);
	assert.deepEqual(relationships.relationshipsFor(history.requester.record), settled);
	assert.deepEqual(await refresh, settled);
	assert.deepEqual(await relationships.catchUp(history.responder.record), settled);
});

test("a rejected Request receipt cannot block unrelated relationship refreshes", async () => {
	const history = requestHistory();
	const healthyRequestId = history.request();
	const toolCallId = "malformed-request-receipt";
	const entryId = history.requester.manager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", {
			title: "Fixture request",
			operation: "request",
			targetAgent: history.responder.record.identity.agentId,
			question: "Malformed receipt.",
		}, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	history.requester.manager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Committed." }],
		details: {
			requestMessageId: deriveMessageIdentity({ agentId: "requester", entryId, toolCallId }),
			targetAgentId: 42,
			messageStatus: "sent",
		},
		isError: false,
		timestamp: Date.now(),
	});
	const warm = requestCoordination(history.agents).requestRelationships;
	for (const agent of history.agents.values()) await agent.transcript.refresh();

	for (const relationships of [warm, requestCoordination(history.agents).requestRelationships]) {
		await relationships.refresh();
		assert.deepEqual(await relationships.catchUp(history.responder.record), {
			awaitingAnswerRequestIds: [],
			answerOwedRequestIds: [healthyRequestId],
		});
		assert.ok((await relationships.catchUp(history.requester.record))
			.awaitingAnswerRequestIds.includes(healthyRequestId));
	}
	assert.deepEqual(
		inspectCoordinationRejections(history.requester.record.transcript.inspect(), "requester")
			.map(({ source }) => source.toolCallId),
		[toolCallId],
	);
});

// Projection and sync tables at the Request Relationships seam. Admission goes
// through the same Request evidence bridges Message coordination uses.

type Participant = ReturnType<typeof participant>;
type Stake = Readonly<{ awaiting: boolean; owed: boolean }>;

function relationshipHistory() {
	const history = requestHistory();
	const { requestEvidence, requestRelationships } = requestCoordination(history.agents);
	let sequence = 0;
	const call = (author: Participant, input: Record<string, unknown>) => {
		const toolCallId = `call-${++sequence}`;
		const entryId = author.manager.appendMessage(fauxAssistantMessage(
			fauxToolCall("agent_message", input as JsonObject, { id: toolCallId }), { stopReason: "toolUse" }));
		return { agentId: author.record.identity.agentId, entryId, toolCallId };
	};
	const result = (author: Participant, source: ToolCallPointer, details: Record<string, unknown>) => {
		author.manager.appendMessage({ role: "toolResult", toolCallId: source.toolCallId, toolName: "agent_message",
			content: [{ type: "text", text: "Committed." }], details: details as JsonValue, isError: false, timestamp: Date.now() });
	};
	const deliver = (recipient: Participant, item: Parameters<typeof createMessageDelivery>[0][number]) => {
		const delivery = createMessageDelivery([item]);
		return recipient.manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	};
	const { requester, responder } = history;
	return {
		history, requestEvidence, requestRelationships, requester, responder,
		/** A Request admitted in the requester's lane whose tool result has not committed. */
		admitRequest() {
			const input = { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Admitted work" };
			const source = call(requester, input);
			const requestId = deriveMessageIdentity(source);
			requestEvidence.rememberAdmittedRequest({
				kind: "request", origin: "agent_message", messageId: requestId, workflowId: "requester",
				fromAgentId: "requester", targetAgentId: "responder", deliveryMode: "deferred", source,
				title: input.title, question: input.question,
			});
			return { requestId, commit: (messageStatus: "sent" | "not_sent") => result(requester, source, messageStatus === "sent"
				? { requestMessageId: requestId, targetAgentId: "responder", messageStatus }
				: { requestMessageId: requestId, targetAgentId: "responder", messageStatus, reason: "target_unavailable" }) };
		},
		/** A Cancellation in one of its stages: admitted, canonical, or delivered to the responder. */
		cancel(requestId: string, stage: "admitted" | "canonical" | "delivered") {
			const source = call(requester, { operation: "cancel", requestMessageId: requestId, reason: "Withdrawn" });
			const cancellationId = deriveMessageIdentity(source);
			if (stage === "admitted") {
				requestEvidence.rememberAdmittedCancellation({
					kind: "request_cancellation", messageId: cancellationId, workflowId: "requester", fromAgentId: "requester",
					targetAgentId: "responder", deliveryMode: "steer", source, requestId, reason: "Withdrawn",
				});
				return;
			}
			result(requester, source, { messageId: cancellationId, targetAgentId: "responder", messageStatus: "sent" });
			if (stage === "delivered") deliver(responder, { source, projection: {
				kind: "request_cancellation", cancellationId, requestMessageId: requestId, fromAgentId: "requester", reason: "Withdrawn",
			} });
		},
		admitAnswer(requestId: string) {
			const answer = history.answer(requestId, responder, requester, { authorResult: false, delivered: false });
			requestEvidence.rememberAdmittedAnswer(resolveCommittedAnswer({
				responderAgentId: "responder", transcript: responder.record.transcript.inspect(), toolCallId: answer.source.toolCallId,
				providedInput: { operation: "answer", requestId, answer: "Completed." }, request: requestEvidence.requireRequest(requestId),
			}));
		},
		/** Answer Retrieval: the requester's retry result carries the committed Answer. */
		retrieve(requestId: string, answer: ReturnType<typeof history.answer>) {
			const source = call(requester, { operation: "retry", messageId: requestId });
			result(requester, source, { requestTitle: "Fixture request", disposition: "answer_delivered", requestMessageId: requestId,
				answerId: answer.answerId, fromAgentId: "responder", answer: "Completed.", answerSource: answer.source });
		},
		stake(agent: Participant, requestId: string): Stake {
			const relationships = requestRelationships.relationshipsFor(agent.record);
			return {
				awaiting: relationships.awaitingAnswerRequestIds.includes(requestId),
				owed: relationships.answerOwedRequestIds.includes(requestId),
			};
		},
	};
}

/** A Spawned child whose Creation Request the Direct Spawner authored. */
function spawnChild(h: ReturnType<typeof relationshipHistory>, delivered: boolean) {
	const creationInput = { title: "Fixture request", request: "Complete the child work." };
	const toolCallId = "spawn-child";
	const entryId = h.requester.manager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_spawn", creationInput, { id: toolCallId }), { stopReason: "toolUse" }));
	const spawnSource = { agentId: "requester", entryId, toolCallId };
	const child = participant("child");
	child.record.identity = { agentId: "child", workflowId: "requester", directSpawnerAgentId: "requester",
		creationPreset: null, spawnSource, metadata: { label: "Child", description: "Creation Request fixture" } };
	child.record.creationInput = creationInput;
	h.history.agents.set("child", child.record);
	h.requester.record.children.push("child");
	const requestId = deriveMessageIdentity(spawnSource);
	if (delivered) {
		const delivery = createMessageDelivery([createCreationRequestDeliveryItem({
			requestId, fromAgentId: "requester", title: creationInput.title, question: creationInput.request, source: spawnSource,
		})]);
		child.manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	}
	return { child, requestId };
}

test("the projection follows each Request evidence state", () => {
	type Row = [name: string, arrange: (h: ReturnType<typeof relationshipHistory>) => string, requester: Stake, responder: Stake];
	const none = { awaiting: false, owed: false };
	const awaiting = { awaiting: true, owed: false };
	const owed = { awaiting: false, owed: true };
	const rows: Row[] = [
		["an admitted Request awaits its Answer", h => h.admitRequest().requestId, awaiting, none],
		["a rolled-back admission ends the outgoing stake", h => {
			const { requestId } = h.admitRequest();
			h.requestEvidence.forgetAdmittedRequest(requestId);
			return requestId;
		}, none, none],
		["an admission committed as not sent ends the outgoing stake", h => {
			const admitted = h.admitRequest();
			admitted.commit("not_sent");
			return admitted.requestId;
		}, none, none],
		["an admitted Request whose result commits stays outgoing from the transcript", h => {
			const admitted = h.admitRequest();
			admitted.commit("sent");
			return admitted.requestId;
		}, awaiting, none],
		["a canonical undelivered Request is not yet owed", h => h.history.request(h.requester, h.responder, false), awaiting, none],
		["a delivered Request is owed", h => h.history.request(), awaiting, owed],
		["an admitted Cancellation ends only the outgoing stake", h => {
			const requestId = h.history.request();
			h.cancel(requestId, "admitted");
			return requestId;
		}, none, owed],
		["a canonical undelivered Cancellation leaves the Request owed", h => {
			const requestId = h.history.request();
			h.cancel(requestId, "canonical");
			return requestId;
		}, none, owed],
		["a delivered Cancellation ends both stakes", h => {
			const requestId = h.history.request();
			h.cancel(requestId, "delivered");
			return requestId;
		}, none, none],
		["an admitted Answer never ends the incoming stake", h => {
			const requestId = h.history.request();
			h.admitAnswer(requestId);
			return requestId;
		}, awaiting, owed],
		["an Answer with its author result ends the incoming stake", h => {
			const requestId = h.history.request();
			h.history.answer(requestId, h.responder, h.requester, { delivered: false });
			return requestId;
		}, awaiting, none],
		["an Answer delivered before its author result ends both stakes", h => {
			const requestId = h.history.request();
			h.history.answer(requestId, h.responder, h.requester, { authorResult: false });
			return requestId;
		}, none, none],
		["Answer Retrieval ends the outgoing stake", h => {
			const requestId = h.history.request();
			h.retrieve(requestId, h.history.answer(requestId, h.responder, h.requester, { delivered: false }));
			return requestId;
		}, none, none],
	];
	for (const [name, arrange, requester, responder] of rows) {
		const h = relationshipHistory();
		const requestId = arrange(h);
		assert.deepEqual(h.stake(h.requester, requestId), requester, `${name}: requester`);
		assert.deepEqual(h.stake(h.responder, requestId), responder, `${name}: responder`);
	}
});

test("with the requester absent, an admitted Answer never ends the incoming stake", () => {
	type Row = [name: string, arrange: (h: ReturnType<typeof relationshipHistory>, requestId: string) => void, owed: boolean];
	const rows: Row[] = [
		["a delivered Request stays owed", () => undefined, true],
		["an admitted Answer leaves it owed", (h, requestId) => h.admitAnswer(requestId), true],
	];
	for (const [name, arrange, owed] of rows) {
		const h = relationshipHistory();
		const requestId = h.history.request();
		arrange(h, requestId);
		// Recovery reads only the responder's transcript when the requester's record is gone.
		h.history.agents.delete("requester");
		assert.deepEqual(h.stake(h.responder, requestId), { awaiting: false, owed }, name);
	}
});

test("a Creation Request is outgoing once the child exists and owed once it is delivered", () => {
	for (const delivered of [false, true]) {
		const h = relationshipHistory();
		const { child, requestId } = spawnChild(h, delivered);
		assert.deepEqual(h.stake(h.requester, requestId), { awaiting: true, owed: false });
		assert.deepEqual(h.stake(child, requestId), { awaiting: false, owed: delivered });
	}
});

/** Binds a Run so sync has retention to write. */
async function startRun(agent: Participant, relationships: RequestRelationships) {
	const runtime = {
		subscribe: () => () => undefined, workState: () => "settled", hasPendingActivity: () => false,
		queuedInputCount: () => 0, clearQueue: async () => ({ steering: [], followUp: [] }),
		abort: async () => undefined, waitForIdle: async () => undefined, dispose: async () => undefined,
	} as unknown as HostedAgentRuntime;
	const host = AgentRuntimeSupervisor.createChild({ agentId: agent.record.identity.agentId, startSession: async () => ({ runtime }) });
	agent.record.host = host;
	relationships.integrate(agent.record);
	await host.lane.run(() => host.startInLane());
	return host;
}

const retained = (host: AgentRuntimeSupervisor) => ({
	awaitingAnswerRequestIds: [...host.requestRelationshipIds("awaiting_answer")].sort(),
	answerOwedRequestIds: [...host.requestRelationshipIds("answer_owed")].sort(),
});

test("sync writes the whole projection as one set and reports a shrinking owed set", async () => {
	const h = relationshipHistory();
	const kept = h.history.request(h.responder, h.requester);
	const answered = h.history.request(h.responder, h.requester);
	const outgoing = h.history.request(h.requester, h.responder, false);
	const host = await startRun(h.requester, h.requestRelationships);
	assert.deepEqual(retained(host), { awaitingAnswerRequestIds: [outgoing], answerOwedRequestIds: [answered, kept].sort() },
		"Run start initializes the projection");
	const answer = h.history.answer(answered, h.requester, h.responder, { authorResult: false, delivered: false });
	const added = h.history.request(h.requester, h.responder, false);
	assert.deepEqual(h.requestRelationships.sync(h.requester.record), { answerOwedShrank: false });
	assert.deepEqual(retained(host).awaitingAnswerRequestIds, [added, outgoing].sort());
	answer.deliver();
	h.cancel(outgoing, "canonical");
	assert.deepEqual(h.requestRelationships.sync(h.requester.record), { answerOwedShrank: true },
		"one call adds nothing and removes from both reasons");
	assert.deepEqual(retained(host), { awaitingAnswerRequestIds: [added], answerOwedRequestIds: [kept] });
	assert.deepEqual(h.requestRelationships.sync(h.requester.record), { answerOwedShrank: false }, "an unchanged set reports no shrink");
});

test("sync writes nothing when no Run is bound", () => {
	const h = relationshipHistory();
	h.history.request();
	assert.deepEqual(h.requestRelationships.sync(h.responder.record), { answerOwedShrank: false });
	assert.deepEqual(retained(h.responder.record.host as AgentRuntimeSupervisor), { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
});

test("a sync in the middle of a tool batch keeps the responder's still-admitted Request", async () => {
	const h = relationshipHistory();
	const incoming = h.history.request();
	const host = await startRun(h.responder, h.requestRelationships);
	// The responder answers, then sends its own Request in the same tool batch;
	// the Answer Delivery commits before either tool result.
	const answer = h.history.answer(incoming, h.responder, h.requester, { authorResult: false, delivered: false });
	const input = { title: "Fixture request", operation: "request", targetAgent: "requester", question: "Follow-up" };
	const entryId = h.responder.manager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", input, { id: "follow-up" }), { stopReason: "toolUse" }));
	const source = { agentId: "responder", entryId, toolCallId: "follow-up" };
	const followUp = deriveMessageIdentity(source);
	h.requestEvidence.rememberAdmittedRequest({
		kind: "request", origin: "agent_message", messageId: followUp, workflowId: "requester", fromAgentId: "responder",
		targetAgentId: "requester", deliveryMode: "deferred", source, title: input.title, question: input.question,
	});
	answer.deliver();
	assert.deepEqual(h.requestRelationships.sync(h.responder.record), { answerOwedShrank: true });
	assert.deepEqual(retained(host), { awaitingAnswerRequestIds: [followUp], answerOwedRequestIds: [] });
});
