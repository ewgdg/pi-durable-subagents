import assert from "node:assert/strict";
import test from "node:test";

import { AnswerArbitration } from "../src/coordination/answer-arbitration.ts";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { resolveCommittedAnswer } from "../src/protocol/message.ts";
import { requestHistory } from "./support/request-history.ts";

/** One committed history plus a stub for the scheduler's direct-Delivery question. */
function arbitrationHistory() {
	const history = requestHistory();
	const evidence = new RequestEvidence(history.agents);
	const inFlight = new Set<string>();
	const arbitration = new AnswerArbitration({
		requestEvidence: evidence,
		isDirectDeliveryInFlight: (recipientAgentId, messageId) => inFlight.has(`${recipientAgentId}/${messageId}`),
	});
	return {
		history,
		arbitration,
		inspect: (requestId: string) => arbitration.inspect(history.requester.record, [requestId])[0],
		reserveDirectDelivery: (answerId: string) => inFlight.add(`requester/${answerId}`),
		admitAnswer(requestId: string, answer: ReturnType<typeof history.answer>) {
			evidence.rememberAdmittedAnswer(resolveCommittedAnswer({
				responderAgentId: "responder",
				transcript: history.responder.record.transcript.inspect(),
				toolCallId: answer.source.toolCallId,
				providedInput: { operation: "answer", requestId, answer: "Completed." },
				request: evidence.requireRequest(requestId),
			}));
		},
	};
}

function retrievedSlot(requestId: string, answer: { answerId: string; source: unknown }) {
	return {
		disposition: "answer_delivered",
		requestMessageId: requestId,
		requestTitle: "Fixture request",
		answerId: answer.answerId,
		fromAgentId: "responder",
		answer: "Completed.",
		answerSource: answer.source,
	};
}

function proofSlot(requestId: string, answerId: string, entryId: string) {
	return {
		disposition: "answer_already_delivered",
		requestMessageId: requestId,
		requestTitle: "Fixture request",
		answerId,
		deliveryEvidence: { agentId: "requester", entryId },
	};
}

test("inspect gives each Request exactly one way to the committed Answer", () => {
	const rows: [string, (h: ReturnType<typeof arbitrationHistory>, requestId: string) => unknown][] = [
		["no Answer is unanswered", () => ({ state: "unanswered" })],
		["an Answer without author result or admission is unanswered", (h, requestId) => {
			h.history.answer(requestId, undefined, undefined, { authorResult: false, delivered: false });
			return { state: "unanswered" };
		}],
		["an admitted Answer whose author result is pending is indeterminate", (h, requestId) => {
			const answer = h.history.answer(requestId, undefined, undefined, { authorResult: false, delivered: false });
			h.admitAnswer(requestId, answer);
			h.reserveDirectDelivery(answer.answerId);
			return { state: "indeterminate" };
		}],
		["a canonical Answer without proof or direct Delivery is retrievable", (h, requestId) => {
			const answer = h.history.answer(requestId, undefined, undefined, { delivered: false });
			return { state: "retrievable", slot: retrievedSlot(requestId, answer) };
		}],
		["a requester-side proof is delivered", (h, requestId) => {
			const answer = h.history.answer(requestId);
			return { state: "delivered", slot: proofSlot(requestId, answer.answerId, answer.deliveryEntryId!) };
		}],
		["proof wins over a reservation that has not released yet", (h, requestId) => {
			const answer = h.history.answer(requestId);
			h.reserveDirectDelivery(answer.answerId);
			return { state: "delivered", slot: proofSlot(requestId, answer.answerId, answer.deliveryEntryId!) };
		}],
		["frozen or dispatched direct Delivery is in flight", (h, requestId) => {
			const answer = h.history.answer(requestId, undefined, undefined, { delivered: false });
			h.reserveDirectDelivery(answer.answerId);
			return { state: "direct_delivery_in_flight" };
		}],
	];
	for (const [name, arrange] of rows) {
		const h = arbitrationHistory();
		const requestId = h.history.request();
		const expected = arrange(h, requestId);
		assert.deepEqual(h.inspect(requestId), expected, name);
	}
});

test("inspect keeps the caller's Request order", () => {
	const h = arbitrationHistory();
	const answered = h.history.request();
	const open = h.history.request();
	const answer = h.history.answer(answered, undefined, undefined, { delivered: false });
	assert.deepEqual(h.arbitration.inspect(h.history.requester.record, [open, answered]), [
		{ state: "unanswered" },
		{ state: "retrievable", slot: retrievedSlot(answered, answer) },
	]);
});

test("reconfirm re-checks prepared retrievals at the commit edge", () => {
	const rows: [string, (h: ReturnType<typeof arbitrationHistory>, requestId: string, answer: ReturnType<ReturnType<typeof requestHistory>["answer"]>) => unknown][] = [
		["a retrieval with nothing new stays unchanged", () => ({ outcome: "unchanged" })],
		["a direct proof committed first makes the slot proof-only", (h, requestId, answer) => {
			const entryId = answer.deliver();
			return { outcome: "replaced", slots: [proofSlot(requestId, answer.answerId, entryId)] };
		}],
		["a direct Delivery reserved after retrieval loses the retrieval", (h, _requestId, answer) => {
			h.reserveDirectDelivery(answer.answerId);
			return { outcome: "lost" };
		}],
	];
	for (const [name, arrange] of rows) {
		const h = arbitrationHistory();
		const requestId = h.history.request();
		const answer = h.history.answer(requestId, undefined, undefined, { delivered: false });
		const prepared = h.inspect(requestId);
		assert.equal(prepared?.state, "retrievable", name);
		if (prepared?.state !== "retrievable") continue;
		const expected = arrange(h, requestId, answer);
		assert.deepEqual(h.arbitration.reconfirm(h.history.requester.record, [prepared.slot]), expected, name);
	}
});

test("reconfirm keeps proof-only slots and replaces only the slots whose proof committed", () => {
	const h = arbitrationHistory();
	const delivered = h.history.request();
	const retrieved = h.history.request();
	const deliveredAnswer = h.history.answer(delivered);
	const retrievedAnswer = h.history.answer(retrieved, undefined, undefined, { delivered: false });
	const prepared = h.arbitration.inspect(h.history.requester.record, [delivered, retrieved])
		.map(state => "slot" in state ? state.slot : assert.fail(`unexpected ${state.state}`));
	const entryId = retrievedAnswer.deliver();
	assert.deepEqual(h.arbitration.reconfirm(h.history.requester.record, prepared), {
		outcome: "replaced",
		slots: [
			proofSlot(delivered, deliveredAnswer.answerId, deliveredAnswer.deliveryEntryId!),
			proofSlot(retrieved, retrievedAnswer.answerId, entryId),
		],
	});
});
