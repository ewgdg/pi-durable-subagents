import { isDeepStrictEqual } from "node:util";

import type { AgentRecord } from "./agent-record.ts";
import type { RequestEvidence } from "./request-evidence.ts";
import type { AgentWaitAnswer } from "../protocol/agent-wait.ts";
import { inspectAnswerDelivery } from "../protocol/message.ts";

export type RetrievedAnswerSlot = Extract<AgentWaitAnswer, { disposition: "answer_delivered" }>;
export type AnswerProofSlot = Extract<AgentWaitAnswer, { disposition: "answer_already_delivered" }>;

/**
 * How the requester gets one Request's committed Answer. Only `retrievable`
 * lets the caller's committed tool result become the requester-side proof.
 */
export type AnswerArbitrationState =
	| Readonly<{ state: "unanswered" }>
	/** Admitted, but the author result is not canonical yet. */
	| Readonly<{ state: "indeterminate" }>
	| Readonly<{ state: "retrievable"; slot: RetrievedAnswerSlot }>
	| Readonly<{ state: "delivered"; slot: AnswerProofSlot }>
	/** The scheduler holds a frozen or dispatched direct Answer Delivery. */
	| Readonly<{ state: "direct_delivery_in_flight" }>;

export type AnswerReconfirmation =
	| Readonly<{ outcome: "unchanged" }>
	/** Slots whose direct proof committed first become proof-only. */
	| Readonly<{ outcome: "replaced"; slots: readonly AgentWaitAnswer[] }>
	/** Direct Delivery got reserved for at least one retrieved slot. */
	| Readonly<{ outcome: "lost" }>;

/** The scheduler's one shared fact: is this direct Delivery frozen or dispatched? */
export type DirectDeliveryInFlight = (recipientAgentId: string, messageId: string) => boolean;

/** True while the Request has no canonical Answer for the requester to receive. */
export function awaitsCanonicalAnswer(state: AnswerArbitrationState): boolean {
	return state.state === "unanswered" || state.state === "indeterminate";
}

/**
 * Decides, per Request, whether the requester receives the committed Answer by
 * Answer Retrieval or waits for direct Answer Delivery, so exactly one of them
 * produces the requester-side Delivery proof.
 */
export class AnswerArbitration {
	readonly #requestEvidence: RequestEvidence;
	readonly #isDirectDeliveryInFlight: DirectDeliveryInFlight;

	constructor(options: {
		requestEvidence: RequestEvidence;
		isDirectDeliveryInFlight: DirectDeliveryInFlight;
	}) {
		this.#requestEvidence = options.requestEvidence;
		this.#isDirectDeliveryInFlight = options.isDirectDeliveryInFlight;
	}

	inspect(requester: AgentRecord, requestIds: readonly string[]): readonly AnswerArbitrationState[] {
		return requestIds.map((requestId) => this.#inspectOne(requester, requestId));
	}

	/**
	 * Runs inside Pi's final awaited hook before a tool result is published, after
	 * the transcript refresh. Direct Delivery reserves or proves only at requester
	 * boundaries, so this synchronous re-check cannot be overtaken before Pi appends.
	 */
	reconfirm(requester: AgentRecord, slots: readonly AgentWaitAnswer[]): AnswerReconfirmation {
		const current = this.inspect(requester, slots.map(({ requestMessageId }) => requestMessageId));
		if (current.some(({ state }) => state === "direct_delivery_in_flight")) return { outcome: "lost" };
		const replacement = current.map((state, index): AgentWaitAnswer => {
			const prepared = slots[index]!;
			if ((state.state !== "retrievable" && state.state !== "delivered") || state.slot.answerId !== prepared.answerId) {
				throw new Error(
					`invariant_violation: retrieved Answer ${prepared.answerId} is no longer the canonical Answer of Request ${prepared.requestMessageId}`,
				);
			}
			return state.slot;
		});
		return isDeepStrictEqual(replacement, slots)
			? { outcome: "unchanged" }
			: { outcome: "replaced", slots: replacement };
	}

	#inspectOne(requester: AgentRecord, requestId: string): AnswerArbitrationState {
		const request = this.#requestEvidence.requireCallerAuthoredMessage(requester, requestId);
		if (request.kind !== "request") {
			throw new Error(`wrong_message_kind: Message ${requestId} is not a Request`);
		}
		const resolution = this.#requestEvidence.canonicalResolution(request);
		if (resolution.cancellation) {
			throw new Error(`invalid_state: Request ${requestId} was cancelled`);
		}
		// The admitted bridge covers an Answer whose author result Pi has not appended.
		const answer = this.#requestEvidence.findAnswer(request);
		if (!answer) return { state: "unanswered" };
		if (!resolution.answer) return { state: "indeterminate" };
		const requesterAgentId = requester.identity.agentId;
		const { deliveryEvidence } = inspectAnswerDelivery({
			requesterAgentId,
			transcript: requester.transcript.inspect(),
			answer,
		});
		const identity = { requestMessageId: requestId, requestTitle: request.title, answerId: answer.messageId };
		if (deliveryEvidence) {
			return { state: "delivered", slot: { disposition: "answer_already_delivered", ...identity, deliveryEvidence } };
		}
		if (this.#isDirectDeliveryInFlight(requesterAgentId, answer.messageId)) {
			return { state: "direct_delivery_in_flight" };
		}
		return {
			state: "retrievable",
			slot: {
				disposition: "answer_delivered",
				...identity,
				fromAgentId: answer.fromAgentId,
				answer: answer.answer,
				answerSource: answer.source,
			},
		};
	}
}
