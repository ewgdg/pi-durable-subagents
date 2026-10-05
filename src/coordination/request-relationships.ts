import type { AgentRecord } from "./agent-record.ts";
import type { RequestEvidence } from "./request-evidence.ts";
import type { RequestRelationshipSet } from "../runtime/agent-runtime-host.ts";

export type RequestRelationshipSync = Readonly<{ answerOwedShrank: boolean }>;

/**
 * The only writer of an Agent's Request Relationship retention. Each sync
 * writes the whole projection, so a missed event heals at the next sync point.
 *
 * Sync points: Run start (the starting Agent); Request send admitted or its
 * admission failed, and Cancellation admitted (the requester); Spawn integrated
 * the child (the Direct Spawner); Request, Creation Request, and Cancellation
 * Delivery committed (the responder); Answer Delivery committed (the requester,
 * then the responder in its own lane); and the safe boundary and Owner
 * Settlement Parking (the Agent).
 */
export class RequestRelationships {
	readonly #requestEvidence: RequestEvidence;

	constructor(options: { requestEvidence: RequestEvidence }) {
		this.#requestEvidence = options.requestEvidence;
	}

	/**
	 * Transcript evidence plus the Agent's own admitted, not yet committed
	 * authorship. Admitted Answers never end an incoming stake.
	 */
	relationshipsFor(agent: AgentRecord): RequestRelationshipSet {
		const committed = this.#requestEvidence.residualRelationshipsFor(agent);
		const admitted = this.#requestEvidence.admittedAuthorshipBy(agent);
		if (admitted.requestIds.length === 0 && admitted.cancelledRequestIds.length === 0) return committed;
		const awaiting = new Set([...committed.awaitingAnswerRequestIds, ...admitted.requestIds]);
		for (const requestId of admitted.cancelledRequestIds) awaiting.delete(requestId);
		return { awaitingAnswerRequestIds: [...awaiting], answerOwedRequestIds: committed.answerOwedRequestIds };
	}

	/** Writes the Agent's projection into its current Run's retention as one set. */
	sync(agent: AgentRecord): RequestRelationshipSync {
		if (!agent.host.currentHandle()) return { answerOwedShrank: false };
		const previouslyOwed = agent.host.requestRelationshipIds("answer_owed");
		const relationships = this.relationshipsFor(agent);
		agent.host.replaceRequestRelationships(relationships);
		const owed = new Set(relationships.answerOwedRequestIds);
		return { answerOwedShrank: previouslyOwed.some((requestId) => !owed.has(requestId)) };
	}

	/** Each new Run rebuilds its relationships from evidence before it proceeds. */
	integrate(agent: AgentRecord): void {
		agent.host.setRunStartInitializer(async () => {
			await this.#requestEvidence.refreshRelationshipsFor(agent);
			this.sync(agent);
		});
	}
}
