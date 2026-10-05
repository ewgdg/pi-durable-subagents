import { setImmediate as yieldTurn } from "node:timers/promises";
import { resolveMessageReference } from "../protocol/message-reference.ts";
import { obligationStack, type ObligationFrame } from "../protocol/obligation-focus.ts";
import { compareCommittedToolCallOrder, deriveMessageIdentity, type ToolCallPointer } from "../protocol/identities.ts";
import { inspectAnswerDelivery } from "../protocol/message.ts";
import { summarizeRequestObligations, type OpenIncomingRequestList } from "../protocol/request-inspection.ts";
import { cancellationSourcesAfter } from "../protocol/request-resolution.ts";
import type { RequestRelationshipSet } from "../runtime/agent-runtime-host.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { indexedState, type RetainedTranscript } from "../transcript/retained-transcript.ts";
import { withAgentTranscriptObservations, type AgentRecord } from "./agent-record.ts";
import type { RequestEvidence } from "./request-evidence.ts";

const REQUEST_STEPS_PER_TURN = 256;
const REQUEST_CATCH_UP_SLICE_MS = 8;

export type RequestRelationshipSync = Readonly<{ answerOwedShrank: boolean }>;

/**
 * Each Agent's Request Relationships: outgoing Requests awaiting an Answer and
 * incoming Requests that owe one, plus the queries derived from them. This is
 * the only writer of an Agent's `awaiting_answer` and `answer_owed` retention.
 * Each sync writes the whole projection, so a missed event heals at the next
 * sync point.
 *
 * Sync points: Run start (the starting Agent); Request send admitted or its
 * admission failed, and Cancellation admitted (the requester); Spawn integrated
 * the child (the Direct Spawner); Request, Creation Request, and Cancellation
 * Delivery committed (the responder); Answer Delivery committed (the requester,
 * then the responder in its own lane); and the safe boundary and Owner
 * Settlement Parking (the Agent).
 */
export class RequestRelationships {
	readonly #agents: Map<string, AgentRecord>;
	readonly #requestEvidence: RequestEvidence;
	readonly #relationshipGraphs = new WeakMap<AgentRecord, RelationshipGraph>();
	#relationshipSources?: RelationshipSources;
	#pendingRelationshipSources?: {
		cursors: Map<AgentRecord, RelationshipCursor>;
		pending: Generator<void>;
	};

	constructor(options: { agents: Map<string, AgentRecord>; requestEvidence: RequestEvidence }) {
		this.#agents = options.agents;
		this.#requestEvidence = options.requestEvidence;
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
			await this.catchUp(agent);
			this.sync(agent);
		});
	}

	/** The Agent's projection, caught up synchronously. */
	relationshipsFor(agent: AgentRecord): RequestRelationshipSet {
		return this.#withAdmittedAuthorship(agent, this.#committedRelationshipsFor(agent));
	}

	/** Incoming Requests whose Answer the Agent still owes. */
	answerOwedRequestIds(agent: AgentRecord): readonly string[] {
		return this.relationshipsFor(agent).answerOwedRequestIds;
	}

	hasUnsettledAnswerObligation(agent: AgentRecord, requestIds: readonly string[]): boolean {
		const owed = new Set(this.answerOwedRequestIds(agent));
		return requestIds.some((requestId) => owed.has(requestId));
	}

	foregroundRequestId(agent: AgentRecord): string | undefined {
		return this.obligationFrames(agent).at(-1)?.requestId;
	}

	outstandingRequestIdsAt(author: AgentRecord, waitSource: ToolCallPointer, selectors?: readonly string[]): readonly string[] {
		if (waitSource.agentId !== author.identity.agentId) {
			throw new Error("wrong_participant: Agent Wait source belongs to another Agent");
		}
		const transcript = author.transcript.inspect();
		const requestIds = new Set(this.relationshipsFor(author).awaitingAnswerRequestIds);
		for (const candidate of cancellationSourcesAfter({
			authorAgentId: author.identity.agentId,
			transcript,
			source: waitSource,
		})) {
			if (
				candidate.input.operation === "cancel" &&
				this.#requestEvidence.findAuthoredRequest(author, candidate.input.requestMessageId)
			)
				requestIds.add(candidate.input.requestMessageId);
		}
		const outstanding = [...requestIds]
			.map((requestId) => this.#requestEvidence.requireRequest(requestId))
			.filter(request => compareCommittedToolCallOrder(transcript, request.source, waitSource) < 0)
			.sort((left, right) => compareCommittedToolCallOrder(transcript, left.source, right.source))
			.flatMap((request) => {
				const cancellation = this.#requestEvidence.findCancellation(request);
				if (
					cancellation &&
					compareCommittedToolCallOrder(transcript, cancellation.source, waitSource) < 0
				)
					return [];

				const answer = this.#requestEvidence.findAnswer(request);
				if (!answer) return [request.messageId];
				const delivery = inspectAnswerDelivery({
					requesterAgentId: author.identity.agentId,
					transcript,
					answer,
				}).deliveryEvidence;
				if (delivery) return [];
				return [request.messageId];
			});
		if (selectors === undefined) return outstanding;
		if (!selectors.length) throw new Error("invalid_input: Agent Wait selection must not be empty");
		const selected = new Set(selectors.map(selector => resolveMessageReference(transcript, waitSource, selector)));
		// Validate every identity before returning the selected source-ordered snapshot.
		for (const id of selected) {
			const message = this.#requestEvidence.requireCallerAuthoredMessage(author, id);
			if (message.kind !== "request") throw new Error(`wrong_message_kind: Message ${id} is not a Request`);
			if (!outstanding.includes(id)) throw new Error(`invalid_state: Request ${id} is not outstanding`);
		}
		return outstanding.filter(id => selected.has(id));
	}

	obligationFrames(agent: AgentRecord): readonly ObligationFrame[] {
		const owed = new Set(this.relationshipsFor(agent).answerOwedRequestIds);
		return obligationStack(agent.transcript.inspect(), agent.identity.agentId).filter(frame => owed.has(frame.requestId));
	}

	/**
	 * A Creation Request holds the incoming Request slot until it is answered or
	 * withdrawn: the child's activation contract comes before ordinary Requests,
	 * so nothing may overtake it while the child has not yielded yet.
	 * Delivered ordinary Requests are attention, not exclusive ownership, so later
	 * Requests (including Steer Requests) may still reach the same responder.
	 *
	 * A responder parked in Agent Wait has already yielded for inbound work; the
	 * activation contract can no longer be overtaken, and the slot must not
	 * withhold attention from the Requests that park is waiting for
	 * (docs/agent-messaging.md: a Deferred Request preempts the parked Wait with
	 * one Request in live admission order regardless of Request ancestry).
	 */
	isIncomingRequestBlocked(responder: AgentRecord, requestId: string): boolean {
		const foreground = this.obligationFrames(responder).at(-1);
		// The Request already occupying the slot may be redelivered (retry) or
		// cancelled; neither competes with itself.
		if (!foreground || foreground.requestId === requestId) return false;
		if (this.#requestEvidence.findCreationRequest(foreground.requestId) === undefined) return false;
		const run = responder.host.observe();
		return !(run.phase === "live" && run.attention === "agent_wait");
	}

	openIncomingRequests(agent: AgentRecord): OpenIncomingRequestList {
		return summarizeRequestObligations(this.obligationFrames(agent));
	}

	/** Outgoing Requests still awaiting an Answer. */
	outstandingRequestIds(agent: AgentRecord): readonly string[] {
		return this.relationshipsFor(agent).awaitingAnswerRequestIds;
	}

	#committedRelationshipsFor(agent: AgentRecord): RequestRelationshipSet {
		return withAgentTranscriptObservations(this.#agents.values(), () => {
			const graph = this.#relationshipGraph(agent);
			for (;;) {
				this.#startRelationshipSourceUpdate();
				while (this.#advanceRelationshipSourceUpdate()) { /* Synchronous read barrier. */ }
				this.#startRelationshipUpdate(agent, graph, this.#relationshipSources!);
				if (!graph.pending) return graph.result;
				while (this.#advanceRelationshipUpdate(graph)) { /* Finish the shared cursor. */ }
				// Evaluation can bind another Request source without a physical append.
				// Collect those changes before declaring this reader caught up.
			}
		});
	}

	/** Refreshes every transcript and catches up every projection; reconcile step 1. */
	async refresh(): Promise<ReadonlyMap<AgentRecord, TranscriptInspection>> {
		let result: ReadonlyMap<AgentRecord, TranscriptInspection> | undefined;
		do {
			const records = [...this.#agents.values()];
			const inspections = new Map<AgentRecord, TranscriptInspection>();
			for (const record of records) inspections.set(record, await record.transcript.refresh());
			if (records.length !== this.#agents.size || records.some(record => this.#agents.get(record.identity.agentId) !== record)) { await yieldTurn(); continue; }
			let allComplete = true;
			withAgentTranscriptObservations(records, () => {
				if (!this.#refreshRelationshipSourcesSlice()) { allComplete = false; return; }
				const sources = this.#relationshipSources!;
				for (const agent of records) {
					const graph = this.#relationshipGraph(agent);
					this.#startRelationshipUpdate(agent, graph, sources);
					const started = performance.now();
					let consumed = 0;
					while (consumed++ < REQUEST_STEPS_PER_TURN && performance.now() - started < REQUEST_CATCH_UP_SLICE_MS) {
						if (!this.#advanceRelationshipUpdate(graph)) {
							this.#startRelationshipUpdate(agent, graph, sources);
							if (!graph.pending) break;
						}
					}
					if (graph.pending) allComplete = false;
				}
				this.#startRelationshipSourceUpdate();
				if (this.#pendingRelationshipSources) allComplete = false;
			}, inspections);
			if (allComplete) result = inspections;
			else await yieldTurn();
			} while (!result);
		return result;
	}

	/** A budgeted, yielding catch-up of one Agent's projection. */
	async catchUp(agent: AgentRecord): Promise<RequestRelationshipSet> {
		let result: RequestRelationshipSet | undefined;
		do {
			const records = [...this.#agents.values()];
			const inspections = new Map<AgentRecord, TranscriptInspection>();
			for (const record of records) inspections.set(record, await record.transcript.refresh());
			if (records.length !== this.#agents.size || records.some(record => this.#agents.get(record.identity.agentId) !== record)) { await yieldTurn(); continue; }
			// Pin these already-refreshed views. A synchronous read here would drain
			// a concurrent append outside both the physical and relationship budgets.
			withAgentTranscriptObservations(records, () => {
				if (!this.#refreshRelationshipSourcesSlice()) return;
				const sources = this.#relationshipSources!;
				const graph = this.#relationshipGraph(agent);
				this.#startRelationshipUpdate(agent, graph, sources);
				const updating = graph.pending !== undefined;
				const started = performance.now();
				let consumed = 0;
				while (consumed++ < REQUEST_STEPS_PER_TURN && performance.now() - started < REQUEST_CATCH_UP_SLICE_MS) {
					if (!this.#advanceRelationshipUpdate(graph)) {
						this.#startRelationshipUpdate(agent, graph, sources);
						if (!graph.pending) {
							if (!updating) result = graph.result;
							break;
						}
					}
				}
			}, inspections);
			if (!result) await yieldTurn();
		} while (!result);
		return this.#withAdmittedAuthorship(agent, result);
	}

	#relationshipGraph(agent: AgentRecord): RelationshipGraph {
		let graph = this.#relationshipGraphs.get(agent);
		if (!graph) {
			graph = {
				count: 0,
				initialized: false,
				awaiting: new Set(),
				owed: new Set(),
				result: { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] },
			};
			this.#relationshipGraphs.set(agent, graph);
		}
		return graph;
	}

	#startRelationshipSourceUpdate(): void {
		const cursors = new Map<AgentRecord, RelationshipCursor>();
		for (const record of this.#agents.values()) {
			const state = indexedState(record.transcript.inspect());
			cursors.set(record, { state, scope: state.scopeVersion, count: state.requestChanges.length });
		}
		if (this.#pendingRelationshipSources) {
			if (sameRelationshipSources(this.#pendingRelationshipSources.cursors, cursors)) return;
			// A source/identity reset invalidates an in-flight batch, including any
			// partially collected journal entries. No old-epoch graph can publish it.
			this.#pendingRelationshipSources = undefined;
			this.#relationshipSources = undefined;
		}
		const previous = this.#relationshipSources;
		const reset = !previous || !sameRelationshipSources(previous.cursors, cursors);
		if (!reset && [...cursors].every(([record, cursor]) => cursor.count === previous.cursors.get(record)!.count))
			return;
		const sources: RelationshipSources = reset
			? { cursors: new Map(), changes: [], creationIds: new Map() }
			: previous;
		this.#pendingRelationshipSources = {
			cursors,
			pending: this.#collectRelationshipSources(sources, cursors, reset),
		};
	}

	*#collectRelationshipSources(
		sources: RelationshipSources,
		cursors: Map<AgentRecord, RelationshipCursor>,
		reset: boolean,
	): Generator<void> {
		for (const [record, cursor] of cursors) {
			if (reset && "spawnSource" in record.identity) {
				const spawner = record.identity.directSpawnerAgentId;
				let ids = sources.creationIds.get(spawner);
				if (!ids) sources.creationIds.set(spawner, (ids = []));
				ids.push(deriveMessageIdentity(record.identity.spawnSource));
			}
			const start = sources.cursors.get(record)?.count ?? 0;
			// The captured end must not grow while this generator yields. Later
			// changes, including lazy Request bindings, belong to a successor batch.
			for (let index = start; index < cursor.count; index++) {
				sources.changes.push(cursor.state.requestChanges[index]!);
				yield;
			}
			yield;
		}
		sources.cursors = cursors;
		this.#relationshipSources = sources;
	}

	#advanceRelationshipSourceUpdate(): boolean {
		const update = this.#pendingRelationshipSources;
		if (!update) return false;
		if (!update.pending.next().done) return true;
		this.#pendingRelationshipSources = undefined;
		return false;
	}

	#refreshRelationshipSourcesSlice(): boolean {
		this.#startRelationshipSourceUpdate();
		const started = performance.now();
		let consumed = 0;
		while (consumed++ < REQUEST_STEPS_PER_TURN && performance.now() - started < REQUEST_CATCH_UP_SLICE_MS) {
			if (!this.#advanceRelationshipSourceUpdate()) {
				this.#startRelationshipSourceUpdate();
				return !this.#pendingRelationshipSources;
			}
		}
		return !this.#pendingRelationshipSources;
	}

	#startRelationshipUpdate(agent: AgentRecord, graph: RelationshipGraph, sources: RelationshipSources): void {
		if (graph.sources !== sources) {
			graph.pending = undefined;
			graph.sources = sources;
			graph.count = 0;
			graph.initialized = false;
			graph.awaiting.clear();
			graph.owed.clear();
		}
		if (graph.pending || (graph.initialized && graph.count === sources.changes.length)) return;
		const creationIds = graph.initialized ? [] : sources.creationIds.get(agent.identity.agentId) ?? [];
		graph.pending = this.#updateRelationships(agent, graph, sources, creationIds, sources.changes.length);
	}

	*#updateRelationships(
		agent: AgentRecord,
		graph: RelationshipGraph,
		sources: RelationshipSources,
		creationIds: readonly string[],
		end: number,
	): Generator<void> {
		this.#requestEvidence.validateAnswerResultReferences(agent);
		const changed = new Set(creationIds);
		for (let index = graph.count; index < end; index++) {
			changed.add(sources.changes[index]!);
			yield;
		}
		for (const requestId of changed) {
			const contribution = this.#requestEvidence.stakeIn(agent, requestId);
			if (contribution.awaiting) graph.awaiting.add(requestId);
			else graph.awaiting.delete(requestId);
			if (contribution.owed) graph.owed.add(requestId);
			else graph.owed.delete(requestId);
			yield;
		}
		graph.result = {
			awaitingAnswerRequestIds: [...graph.awaiting],
			answerOwedRequestIds: [...graph.owed],
		};
		graph.count = end;
		graph.initialized = true;
	}

	#advanceRelationshipUpdate(graph: RelationshipGraph): boolean {
		if (!graph.pending) return false;
		try {
			if (!graph.pending.next().done) return true;
		} catch (error) {
			// Shared source progress is reusable, but this graph must reconstruct
			// from the journal after an error rather than accept partial membership.
			graph.sources = undefined;
			graph.pending = undefined;
			throw error;
		}
		graph.pending = undefined;
		return false;
	}

	/**
	 * Transcript evidence plus the Agent's own admitted, not yet committed
	 * authorship, so a sync in the middle of a tool batch keeps a Request that is
	 * still being committed. Admitted Answers never end an incoming stake.
	 */
	#withAdmittedAuthorship(agent: AgentRecord, committed: RequestRelationshipSet): RequestRelationshipSet {
		const admitted = this.#requestEvidence.admittedAuthorshipBy(agent);
		if (admitted.requestIds.length === 0 && admitted.cancelledRequestIds.length === 0) return committed;
		const awaiting = new Set([...committed.awaitingAnswerRequestIds, ...admitted.requestIds]);
		for (const requestId of admitted.cancelledRequestIds) awaiting.delete(requestId);
		return { awaitingAnswerRequestIds: [...awaiting], answerOwedRequestIds: committed.answerOwedRequestIds };
	}
}

type RelationshipCursor = {
	state: RetainedTranscript;
	scope: number;
	count: number;
};
/** One shared, disposable journal per roster/source epoch, not one cursor map per graph. */
type RelationshipSources = {
	cursors: Map<AgentRecord, RelationshipCursor>;
	changes: string[];
	creationIds: Map<string, string[]>;
};
type RelationshipGraph = {
	sources?: RelationshipSources;
	count: number;
	initialized: boolean;
	awaiting: Set<string>;
	owed: Set<string>;
	result: RequestRelationshipSet;
	pending?: Generator<void>;
};

function sameRelationshipSources(
	previous: ReadonlyMap<AgentRecord, RelationshipCursor>,
	current: ReadonlyMap<AgentRecord, RelationshipCursor>,
): boolean {
	if (previous.size !== current.size) return false;
	const order = previous.keys();
	for (const [record, cursor] of current) {
		const before = previous.get(record);
		if (order.next().value !== record || before?.state !== cursor.state || before.scope !== cursor.scope)
			return false;
	}
	return true;
}
