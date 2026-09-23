import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";

import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { participant, requestHistory } from "./support/request-history.ts";

for (const size of [40, 80]) {
	test(`warm relationship refresh audits ${size} sources without per-Agent roster scans`, async () => {
		const participants = Array.from({ length: size }, (_, index) => participant(`agent-${index}`));
		const agents = new Map(participants.map(({ record }) => [record.identity.agentId, record]));
		const evidence = new RequestEvidence(agents);
		await evidence.refreshRelationships();
		let inspections = 0;
		let refreshes = 0;
		for (const { record } of participants) {
			const inspect = record.transcript.inspect.bind(record.transcript);
			const refresh = record.transcript.refresh.bind(record.transcript);
			record.transcript.inspect = () => { inspections++; return inspect(); };
			record.transcript.refresh = async () => { refreshes++; return refresh(); };
		}
		await evidence.refreshRelationships();
		assert.equal(refreshes, size, "the authoritative all-source freshness audit remains required");
		assert.ok(inspections <= 12 * size,
			`warm refresh used ${inspections} transcript inspections for ${size} Agents; expected linear work`);
	});
}

test("scoped and global readers independently catch up to shared Request changes", async () => {
	const history = requestHistory();
	const third = participant("third");
	history.agents.set("third", third.record);
	const evidence = new RequestEvidence(history.agents);
	await evidence.refreshRelationships();
	const first = history.request();
	assert.deepEqual(evidence.residualRelationshipsFor(history.requester.record).awaitingAnswerRequestIds, [first]);
	const second = history.request(third, history.responder);
	history.answer(first);
	assert.deepEqual((await evidence.refreshRelationshipsFor(history.requester.record)).awaitingAnswerRequestIds, []);
	await evidence.refreshRelationships();
	assert.deepEqual(evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds, [second]);
	assert.deepEqual(evidence.residualRelationshipsFor(third.record).awaitingAnswerRequestIds, [second]);
	for (const record of history.agents.values()) {
		assert.deepEqual(evidence.residualRelationshipsFor(record), new RequestEvidence(history.agents).residualRelationshipsFor(record));
	}
});

test("non-coordination appends preserve relationship results while silent Answers are observed", async () => {
	const history = requestHistory();
	const requestId = history.request();
	const evidence = new RequestEvidence(history.agents);
	await evidence.refreshRelationships();
	const before = evidence.residualRelationshipsFor(history.requester.record);
	history.responder.manager.appendCustomEntry("marker", { unrelated: true });
	await evidence.refreshRelationships();
	assert.equal(evidence.residualRelationshipsFor(history.requester.record), before);
	history.answer(requestId); // No dirty hint: reads must still verify the authority.
	await evidence.refreshRelationships();
	assert.deepEqual(evidence.residualRelationshipsFor(history.requester.record).awaitingAnswerRequestIds, []);
	assert.deepEqual(evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds, []);
});

test("a yielding shared batch preserves concurrent Answers and roster admission", { timeout: 5_000 }, async () => {
	const history = requestHistory();
	const requests = Array.from({ length: 400 }, () => history.request());
	for (const record of history.agents.values()) await record.transcript.refresh();
	const evidence = new RequestEvidence(history.agents);
	let completed = false;
	const pending = evidence.refreshRelationships().then(() => { completed = true; });
	await yieldTurn();
	assert.equal(completed, false, "shared Request collection must yield for this backlog");
	history.answer(requests[0]!);
	const third = participant("third");
	history.agents.set("third", third.record);
	const incoming = history.request(third, history.responder);
	await Promise.all([pending, evidence.refreshRelationshipsFor(history.requester.record)]);
	assert.deepEqual(evidence.residualRelationshipsFor(history.requester.record).awaitingAnswerRequestIds, requests.slice(1));
	assert.deepEqual(evidence.residualRelationshipsFor(third.record).awaitingAnswerRequestIds, [incoming]);
	const expectedOwed = [...requests.slice(1), incoming].sort();
	assert.deepEqual([...evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds].sort(), expectedOwed);
	assert.deepEqual([...new RequestEvidence(history.agents).residualRelationshipsFor(history.responder.record).answerOwedRequestIds].sort(), expectedOwed);
});

test("failed relationship evaluation remains visible on retry and recovers after an authoritative cutoff", async () => {
	const history = requestHistory();
	const requestId = history.request();
	const evidence = new RequestEvidence(history.agents);
	await evidence.refreshRelationships();
	history.answer(requestId);
	history.answer(requestId);
	for (let attempt = 0; attempt < 2; attempt++) {
		await assert.rejects(evidence.refreshRelationships(), /invariant_violation/);
	}
	for (const p of [history.requester, history.responder]) {
		p.manager.appendCustomEntry("agent-coordination.identity", { agentId: p.record.identity.agentId });
	}
	const next = history.request();
	await evidence.refreshRelationships();
	assert.deepEqual(evidence.residualRelationshipsFor(history.requester.record).awaitingAnswerRequestIds, [next]);
	assert.deepEqual(evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds, [next]);
});

test("same-size Agent replacement invalidates old membership without reusing the old record's graph", async () => {
	const history = requestHistory();
	const requestId = history.request();
	const evidence = new RequestEvidence(history.agents);
	await evidence.refreshRelationships();
	const replacement = participant("responder");
	history.agents.set("responder", replacement.record);
	await evidence.refreshRelationships();
	assert.deepEqual(evidence.residualRelationshipsFor(history.requester.record).awaitingAnswerRequestIds, [requestId]);
	assert.deepEqual(evidence.residualRelationshipsFor(replacement.record).answerOwedRequestIds, []);
});

test("source replacement and same-record identity cutoff invalidate shared relationship progress", async () => {
	const history = requestHistory();
	const requestId = history.request();
	const evidence = new RequestEvidence(history.agents);
	await evidence.refreshRelationships();
	assert.deepEqual(evidence.residualRelationshipsFor(history.requester.record).awaitingAnswerRequestIds, [requestId]);
	for (const p of [history.requester, history.responder]) {
		p.manager.appendCustomEntry("agent-coordination.identity", { agentId: p.record.identity.agentId });
	}
	await evidence.refreshRelationships();
	for (const p of [history.requester, history.responder]) {
		assert.deepEqual(evidence.residualRelationshipsFor(p.record), { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
		p.record.transcript = transcriptFromSessionManager(p.manager, { fresh: true });
	}
	const next = history.request();
	await evidence.refreshRelationships();
	assert.deepEqual(evidence.residualRelationshipsFor(history.requester.record).awaitingAnswerRequestIds, [next]);
	assert.deepEqual(evidence.residualRelationshipsFor(history.responder.record).answerOwedRequestIds, [next]);
});
