import { resolveMessageReference } from "../protocol/message-reference.ts";
import { obligationStack, type ObligationFrame } from "../protocol/obligation-focus.ts";
import { summarizeRequestObligations, type OpenIncomingRequestList, type RequestInspection } from "../protocol/request-inspection.ts";
import { indexedState, type RetainedTranscript } from "../transcript/retained-transcript.ts";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
	withAgentTranscriptObservations,
	EvidenceUnavailableError,
	requireAgentRecord,
	type AgentRecord,
} from "./agent-record.ts";
import {
	inspectCreationRequestDelivery,
	resolveCreationRequest,
} from "../protocol/creation-request.ts";
import {
	compareCommittedToolCallOrder,
	deriveMessageIdentity,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "../protocol/identities.ts";
import {
	inspectAnswerDelivery,
	retrievalsForRequest,
	inspectAgentMessageAuthorResult,
	inspectCanonicalMessage,
	inspectMessageDelivery,
	resolveCommittedAnswer,
	resolveCommittedCancellation,
	resolveCommittedMessage,
	type Message,
} from "../protocol/message.ts";
import {
	inspectMessageDeliveries,
	deliveriesForRequest,
	type DeliveredMessageEvidence,
	validateDeliveredMessageEvidence,
} from "../protocol/message-delivery.ts";
import {
	answerSourceDeliveryRequestId,
	answerSourcesForRequest,
	answerResultSources,
	cancellationSourcesForRequest,
	cancellationSourcesAfter,
	answerSourceResultRequestId,
	findAuthoredAgentMessageSource,
	findAuthoredAgentMessageSources,
	inspectCanonicalRequestResolution,
} from "../protocol/request-resolution.ts";
import type { AgentWaitAnswer } from "../protocol/agent-wait.ts";
import type { ResidualRequestRelationships } from "../runtime/agent-runtime-host.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import {
	inspectCommittedAgentMessageTarget,
	resolveCommittedAgentMessageTargetId,
} from "./agent-message-target.ts";

const REQUEST_STEPS_PER_TURN = 256;
const REQUEST_CATCH_UP_SLICE_MS = 8;

type Request = Extract<Message, { kind: "request" }>;
type Answer = Extract<Message, { kind: "answer" }>;
type Cancellation = Extract<Message, { kind: "request_cancellation" }>;

export class RequestEvidence {
	readonly #agents: Map<string, AgentRecord>;
	readonly #quarantinedAgentIds: ReadonlySet<string>;
	readonly #quarantinedWorkflowAgentIds: ReadonlySet<string>;
	// The transcript is authoritative. These entries only bridge the interval after
	// lane admission and before Pi appends the native tool result.
	readonly #admittedAnswersByRequest = new Map<string, Answer>();
	readonly #admittedCancellationsByRequest = new Map<string, Cancellation>();

	constructor(
		agents: Map<string, AgentRecord>,
		quarantinedAgentIds: ReadonlySet<string> = new Set(),
		quarantinedWorkflowAgentIds: ReadonlySet<string> = quarantinedAgentIds,
	) {
		this.#agents = agents;
		this.#quarantinedAgentIds = quarantinedAgentIds;
		this.#quarantinedWorkflowAgentIds = quarantinedWorkflowAgentIds;
	}

	rememberAdmittedAnswer(answer: Answer): void {
		this.#admittedAnswersByRequest.set(answer.requestId, answer);
	}

	isAnswerAwaitingAuthorResult(answer: Answer): boolean {
		const responder = this.#requireAgent(answer.fromAgentId);
		const resultRequestId = answerSourceResultRequestId({
			transcript: responder.transcript.inspect(),
			source: answer.source,
		});
		return (
			resultRequestId === undefined &&
			responder.host.currentHandle() !== undefined &&
			!responder.host.currentRunFailed()
		);
	}

	findAnswerBySource(responder: AgentRecord, toolCallId: string): Answer | undefined {
		const matches = new Map<string, Answer>();
		for (const answer of this.#admittedAnswersByRequest.values()) {
			if (
				answer.fromAgentId === responder.identity.agentId &&
				answer.source.toolCallId === toolCallId
			)
				matches.set(answer.messageId, answer);
		}
		const committed = resolveCommittedToolCall({
			agentId: responder.identity.agentId,
			transcript: responder.transcript.inspect(),
			toolCallId,
			toolName: "agent_message",
		});
		const durable = this.#resolveAuthoredMessage(
			responder,
			deriveMessageIdentity(committed.source),
		);
		if (durable?.kind === "answer") matches.set(durable.messageId, durable);
		if (matches.size > 1) {
			throw new Error(
				`invariant_violation: Agent Answer source ${toolCallId} resolved multiple Requests`,
			);
		}
		return matches.values().next().value;
	}

	rememberAdmittedCancellation(cancellation: Cancellation): void {
		this.#admittedCancellationsByRequest.set(
			cancellation.requestId,
			cancellation,
		);
	}

	discardAdmittedAuthorshipBy(author: AgentRecord): void {
		for (const [requestId, answer] of this.#admittedAnswersByRequest) {
			if (answer.fromAgentId === author.identity.agentId) {
				this.#admittedAnswersByRequest.delete(requestId);
			}
		}
		for (const [requestId, cancellation] of this.#admittedCancellationsByRequest) {
			if (cancellation.fromAgentId === author.identity.agentId) {
				this.#admittedCancellationsByRequest.delete(requestId);
			}
		}
	}

	findAnswer(request: Request): Answer | undefined {
		const durable = this.#inspectResolution(request).answer;
		const admitted = this.#admittedAnswersByRequest.get(request.messageId);
		if (durable && admitted && durable.messageId !== admitted.messageId) {
			throw new Error(
				`invariant_violation: Request ${request.messageId} has conflicting admitted and canonical Answers`,
			);
		}
		if (durable) this.#admittedAnswersByRequest.delete(request.messageId);
		return durable ?? admitted;
	}

	findCancellation(request: Request): Cancellation | undefined {
		const durable = this.#inspectResolution(request).cancellation;
		const admitted = this.#admittedCancellationsByRequest.get(request.messageId);
		if (durable && admitted && durable.messageId !== admitted.messageId) {
			throw new Error(
				`invariant_violation: Request ${request.messageId} has conflicting admitted and canonical Cancellations`,
			);
		}
		if (durable) this.#admittedCancellationsByRequest.delete(request.messageId);
		return durable ?? admitted;
	}

	requireRequest(requestId: string): Request {
		const request = this.findRequest(requestId);
		if (request) return request;
		throw new Error(`unknown_identity: Request ${requestId}`);
	}

	/** Authored authority only; recipient Delivery never recreates a missing source. */
	findRequest(requestId: string): Request | undefined {
		// A child's Identity already locates its Creation Request. Searching every
		// history first makes each deadlock check reparse the whole workflow per child.
		const creationRequest = this.#findCreationRequest(requestId);
		if (creationRequest) return creationRequest;
		for (const author of this.#agents.values()) {
			const authorTranscript = author.transcript.inspect();
			const authored = findAuthoredAgentMessageSource({
				authorAgentId: author.identity.agentId,
				transcript: authorTranscript,
				messageId: requestId,
			});
			if (!authored) continue;
			if (authored.input.operation !== "request") {
				throw new Error(`wrong_message_kind: Message ${requestId} is not a Request`);
			}
			const target = this.#inspectMessageTarget(
				author,
				authorTranscript,
				authored.source.toolCallId,
				authored.input.targetAgent,
			);
			if (target.state === "not_created") continue;
			const resolvedTargetAgentId = target.state === "resolved"
				? target.targetAgentId
				: this.#resolveMessageTargetId(
					author,
					authorTranscript,
					authored.source.toolCallId,
					authored.input.targetAgent,
				);
			const request = resolveCommittedMessage({
				fromAgentId: author.identity.agentId,
				workflowId: author.identity.workflowId,
				transcript: authorTranscript,
				toolCallId: authored.source.toolCallId,
				providedInput: authored.input,
				resolvedTargetAgentId,
			});
			if (request.kind !== "request") {
				throw new Error(`wrong_message_kind: Message ${requestId} is not a Request`);
			}
			if (inspectCanonicalMessage({ message: request, authorTranscript }).state === "not_created") {
				throw new Error(`unknown_identity: Request ${requestId} was not created`);
			}
			return request;
		}
		this.#throwIfUnavailableDeliveryEvidence(
			`Request ${requestId} depends on quarantined Agent proof`,
			({ projection }) =>
				projection.kind === "request" &&
				projection.requestMessageId === requestId,
		);
		return undefined;
	}

	/** Independently valid recipient evidence remains useful without authored authority. */
	findDeliveredRequest(responder: AgentRecord, requestId: string) {
		const deliveries = deliveriesForRequest({
			recipientAgentId: responder.identity.agentId, transcript: responder.transcript.inspect(), requestId,
		}).filter(delivery => delivery.projection.kind === "request");
		if (deliveries.length > 1) throw new Error(`invariant_violation: Request ${requestId} has duplicate Deliveries`);
		const delivery = deliveries[0];
		if (!delivery || delivery.projection.kind !== "request") return undefined;
		validateDeliveredMessageEvidence(delivery);
		const requester = this.#requireAgent(delivery.projection.fromAgentId);
		if (requester.identity.workflowId !== responder.identity.workflowId) {
			throw new Error("wrong_workflow: delivered Request belongs to another Workflow");
		}
		return { ...delivery.projection, source: delivery.source, deliveryEvidence: delivery.deliveryEvidence };
	}

	requestMetadata(requestId: string): Pick<Request, "messageId" | "fromAgentId" | "targetAgentId" | "title" | "source"> {
		const request = this.findRequest(requestId);
		if (request) return request;
		for (const responder of this.#agents.values()) {
			const delivered = this.findDeliveredRequest(responder, requestId);
			if (delivered) return {
				messageId: requestId, fromAgentId: delivered.fromAgentId,
				targetAgentId: responder.identity.agentId, title: delivered.title, source: delivered.source,
			};
		}
		throw new Error(`unknown_identity: Request ${requestId}`);
	}

	findLocalAnswer(responder: AgentRecord, requestId: string): Answer | undefined {
		const transcript = responder.transcript.inspect();
		const delivered = deliveriesForRequest({ recipientAgentId: responder.identity.agentId, transcript, requestId })
			.find(delivery => delivery.projection.kind === "request");
		const requester = delivered ? this.#agents.get(delivered.projection.fromAgentId) : undefined;
		const sources = requester ? answerSourcesForRequest({
			request: { messageId: requestId, fromAgentId: requester.identity.agentId, targetAgentId: responder.identity.agentId },
			requesterTranscript: requester.transcript.inspect(), responderTranscript: transcript,
		}) : answerResultSources({ authorAgentId: responder.identity.agentId, transcript }).get(requestId) ?? [];
		const canonical = sources.flatMap(({ source }) => {
			const answer = this.#resolveAuthoredMessage(responder, deriveMessageIdentity(source));
			return answer?.kind === "answer" ? [answer] : [];
		});
		if (canonical.length > 1) throw new Error(`invariant_violation: Request ${requestId} has multiple canonical Answers`);
		const admitted = this.#admittedAnswersByRequest.get(requestId);
		if (canonical[0] && admitted && canonical[0].messageId !== admitted.messageId) {
			throw new Error(`invariant_violation: Request ${requestId} has conflicting admitted and canonical Answers`);
		}
		return canonical[0] ?? admitted;
	}

	isLocalCancellationDelivered(responder: AgentRecord, requestId: string): boolean {
		const deliveries = deliveriesForRequest({ recipientAgentId: responder.identity.agentId, transcript: responder.transcript.inspect(), requestId });
		const request = deliveries.find(delivery => delivery.projection.kind === "request");
		if (!request) return false;
		const cancellations = deliveries.filter(delivery => delivery.projection.kind === "request_cancellation");
		for (const cancellation of cancellations) {
			validateDeliveredMessageEvidence(cancellation);
			if (cancellation.projection.fromAgentId !== request.projection.fromAgentId) {
				throw new ProtocolInvariantError(`Request ${requestId} Cancellation Delivery is not from its requester`);
			}
		}
		return cancellations.length > 0;
	}

	outstandingRequestIdsAt(author: AgentRecord, waitSource: ToolCallPointer, selectors?: readonly string[]): readonly string[] {
		if (waitSource.agentId !== author.identity.agentId) {
			throw new Error("wrong_participant: Agent Wait source belongs to another Agent");
		}
		const transcript = author.transcript.inspect();
		const requestIds = new Set(this.residualRelationshipsFor(author).awaitingAnswerRequestIds);
		for (const candidate of cancellationSourcesAfter({
			authorAgentId: author.identity.agentId,
			transcript,
			source: waitSource,
		})) {
			if (
				candidate.input.operation === "cancel" &&
				this.#findBoundAuthoredRequest(author, candidate.input.requestMessageId)
			)
				requestIds.add(candidate.input.requestMessageId);
		}
		const outstanding = [...requestIds]
			.map((requestId) => this.requireRequest(requestId))
			.filter(request => compareCommittedToolCallOrder(transcript, request.source, waitSource) < 0)
			.sort((left, right) => compareCommittedToolCallOrder(transcript, left.source, right.source))
			.flatMap((request) => {
				const cancellation = this.findCancellation(request);
				if (
					cancellation &&
					compareCommittedToolCallOrder(transcript, cancellation.source, waitSource) < 0
				)
					return [];

				const answer = this.findAnswer(request);
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
			const message = this.requireCallerAuthoredMessage(author, id);
			if (message.kind !== "request") throw new Error(`wrong_message_kind: Message ${id} is not a Request`);
			if (!outstanding.includes(id)) throw new Error(`invalid_state: Request ${id} is not outstanding`);
		}
		return outstanding.filter(id => selected.has(id));
	}

	obligationFrames(agent: AgentRecord): readonly ObligationFrame[] {
		const owed = new Set(this.residualRelationshipsFor(agent).answerOwedRequestIds);
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
		if (this.#findCreationRequest(foreground.requestId) === undefined) return false;
		const run = responder.host.observe();
		return !(run.phase === "live" && run.attention === "agent_wait");
	}

	openIncomingRequests(agent: AgentRecord): OpenIncomingRequestList {
		return summarizeRequestObligations(this.obligationFrames(agent));
	}

	inspectRequest(agent: AgentRecord, selector: string): RequestInspection {
		const reference = selector.trim();
		if (!reference) throw new Error("invalid_input: Request reference must not be blank");
		const agentId = agent.identity.agentId;
		const transcript = agent.transcript.inspect();
		const incoming = new Set(inspectMessageDeliveries({ recipientAgentId: agentId, transcript })
			.flatMap(({ projection }) => projection.kind === "request" ? [projection.requestMessageId] : []));
		const candidates = new Set([...indexedState(transcript).requestChanges, ...incoming]);
		// A committed child Identity can establish a Creation Request before the
		// parent's native Spawn result exists in its transcript index.
		for (const child of this.#agents.values()) {
			if ("spawnSource" in child.identity && child.identity.spawnSource.agentId === agentId) {
				candidates.add(deriveMessageIdentity(child.identity.spawnSource));
			}
		}
		const matchingIds = candidates.has(reference) ? [reference]
			: [...candidates].filter(id => id.endsWith(reference));
		const visible = matchingIds.flatMap<RequestInspection>(requestId => {
			const authored = this.#findBoundAuthoredRequest(agent, requestId);
			if (!authored && !incoming.has(requestId)) return [];
			const request = authored ?? this.findRequest(requestId);
			if (!request) {
				const delivered = this.findDeliveredRequest(agent, requestId);
				return delivered ? [{ requestMessageId: requestId, requesterAgentId: delivered.fromAgentId,
					responderAgentId: agentId, title: delivered.title, question: delivered.question }] : [];
			}
			if (!authored && request.targetAgentId !== agentId) {
				throw new Error(
					`invariant_violation: Incoming Request evidence on ${agentId} targets another responder ${request.targetAgentId}`,
				);
			}
			const recipient = this.#agents.get(request.targetAgentId);
			const deliveryEvidence = recipient ? this.#inspectRequestDelivery(request, recipient).deliveryEvidence : undefined;
			const canonical = inspectCanonicalMessage({
				message: request,
				authorTranscript: this.#requireAgent(request.fromAgentId).transcript.inspect(),
				deliveryEvidence,
			});
			if (canonical.state === "not_created") return [];
			if (canonical.state === "indeterminate") {
				throw new EvidenceUnavailableError(`Request ${requestId} has no canonical admission evidence`);
			}
			return [{ requestMessageId: request.messageId, requesterAgentId: request.fromAgentId,
				responderAgentId: request.targetAgentId, title: request.title, question: request.question }];
		});
		if (visible.length > 1) throw new Error(`ambiguous_target: Request ID suffix ${reference}`);
		const request = visible[0];
		if (!request) throw new Error(`unknown_identity: Request ${reference}`);
		return request;
	}

	outstandingRequestIdsFor(agent: AgentRecord): readonly string[] {
		return this.residualRelationshipsFor(agent).awaitingAnswerRequestIds;
	}

	residualRelationshipsFor(agent: AgentRecord): ResidualRequestRelationships {
		return withAgentTranscriptObservations(this.#agents.values(), () => {
			const graph = this.#relationshipGraph(agent);
			do {
				this.#startRelationshipUpdate(agent, graph);
				while (this.#advanceRelationshipUpdate(graph)) {
					/* Finish the shared cursor. */
				}
				this.#startRelationshipUpdate(agent, graph);
			} while (graph.pending);
			return graph.result;
		});
	}

	async refreshRelationships(): Promise<ReadonlyMap<AgentRecord, TranscriptInspection>> {
		let result: ReadonlyMap<AgentRecord, TranscriptInspection> | undefined;
		do {
			const records = [...this.#agents.values()];
			const inspections = new Map<AgentRecord, TranscriptInspection>();
			for (const record of records) inspections.set(record, await record.transcript.refresh());
			if (records.length !== this.#agents.size || records.some(record => this.#agents.get(record.identity.agentId) !== record)) { await yieldTurn(); continue; }
			let allComplete = true;
			withAgentTranscriptObservations(records, () => {
				for (const agent of records) {
					const graph = this.#relationshipGraph(agent);
					this.#startRelationshipUpdate(agent, graph);
					const started = performance.now();
					let consumed = 0;
					while (consumed++ < REQUEST_STEPS_PER_TURN && performance.now() - started < REQUEST_CATCH_UP_SLICE_MS) {
						if (!this.#advanceRelationshipUpdate(graph)) {
							this.#startRelationshipUpdate(agent, graph);
							if (!graph.pending) break;
						}
					}
					if (graph.pending) allComplete = false;
				}
			}, inspections);
			if (allComplete) result = inspections;
			else await yieldTurn();
			} while (!result);
		return result;
	}

	async refreshRelationshipsFor(agent: AgentRecord): Promise<ResidualRequestRelationships> {
		let result: ResidualRequestRelationships | undefined;
		do {
			const records = [...this.#agents.values()];
			const inspections = new Map<AgentRecord, TranscriptInspection>();
			for (const record of records) inspections.set(record, await record.transcript.refresh());
			if (records.length !== this.#agents.size || records.some(record => this.#agents.get(record.identity.agentId) !== record)) { await yieldTurn(); continue; }
			// Pin these already-refreshed views. A synchronous read here would drain
			// a concurrent append outside both the physical and relationship budgets.
			withAgentTranscriptObservations(records, () => {
				const graph = this.#relationshipGraph(agent);
				this.#startRelationshipUpdate(agent, graph);
				const updating = graph.pending !== undefined;
				const started = performance.now();
				let consumed = 0;
				while (consumed++ < REQUEST_STEPS_PER_TURN && performance.now() - started < REQUEST_CATCH_UP_SLICE_MS) {
					if (!this.#advanceRelationshipUpdate(graph)) {
						this.#startRelationshipUpdate(agent, graph);
						if (!graph.pending) {
							if (!updating) result = graph.result;
							break;
						}
					}
				}
			}, inspections);
			if (!result) await yieldTurn();
		} while (!result);
		return result;
	}

	#relationshipGraph(agent: AgentRecord): RelationshipGraph {
		return indexedState(agent.transcript.inspect()).memo(
			RequestEvidence.prototype.residualRelationshipsFor,
			agent.identity.agentId,
			this.#agents,
			(): RelationshipGraph => ({
				cursors: new Map(),
				awaiting: new Set(),
				owed: new Set(),
				roster: [],
				result: { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] },
			}),
		);
	}

	#startRelationshipUpdate(agent: AgentRecord, graph: RelationshipGraph): void {
		const observations = [...this.#agents.values()].map((record) => ({
			record,
			state: indexedState(record.transcript.inspect()),
		}));
		if (graph.pending) {
			if (
				observations.length === graph.pendingSources?.size &&
				observations.every(({ record, state }) => {
					const cursor = graph.pendingSources!.get(record);
					return cursor?.state === state && cursor.scope === state.scopeVersion;
				})
			)
				return;
			graph.pending = undefined;
			graph.cursors.clear();
		}
		const reset =
			observations.length !== graph.roster.length ||
			observations.some(({ record, state }, index) => {
				const cursor = graph.cursors.get(record);
				return (
					graph.roster[index] !== record ||
					!cursor ||
					cursor.state !== state ||
					cursor.scope !== state.scopeVersion
				);
			});
		const creationIds: string[] = [];
		if (reset) {
			graph.cursors.clear();
			graph.awaiting.clear();
			graph.owed.clear();
			graph.roster = observations.map(({ record }) => record);
			for (const child of graph.roster) {
				if (
					"spawnSource" in child.identity &&
					child.identity.directSpawnerAgentId === agent.identity.agentId
				)
					creationIds.push(deriveMessageIdentity(child.identity.spawnSource));
			}
		}
		const cursors = new Map<AgentRecord, RelationshipCursor>();
		for (const { record, state } of observations) {
			cursors.set(record, {
				state,
				scope: state.scopeVersion,
				count: state.requestChanges.length,
				physicalCount: state.entries.length,
			});
		}
		if (
			!reset &&
			[...cursors].every(([record, cursor]) => cursor.count === graph.cursors.get(record)?.count)
		)
			return;
		graph.pendingSources = cursors;
		graph.pending = this.#updateRelationships(agent, graph, creationIds, cursors);
	}

	*#updateRelationships(
		agent: AgentRecord,
		graph: RelationshipGraph,
		creationIds: readonly string[],
		cursors: Map<AgentRecord, RelationshipCursor>,
	): Generator<void> {
		this.#validateAnswerResultReferences(agent);
		const changed = new Set(creationIds);
		for (const [record, cursor] of cursors) {
			for (let index = graph.cursors.get(record)?.count ?? 0; index < cursor.count; index++) {
				changed.add(cursor.state.requestChanges[index]!);
				yield;
			}
		}
		for (const requestId of changed) {
			const contribution = this.#relationshipForRequest(agent, requestId);
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
		for (const cursor of cursors.values()) {
			if (
				cursor.state.scopeVersion === cursor.scope &&
				cursor.state.entries.length === cursor.physicalCount
			)
				cursor.count = cursor.state.requestChanges.length;
		}
		graph.cursors = cursors;
	}

	#advanceRelationshipUpdate(graph: RelationshipGraph): boolean {
		if (!graph.pending) return false;
		try {
			if (!graph.pending.next().done) return true;
		} catch (error) {
			// No cursor is committed on failure; the next observation reconstructs.
			graph.cursors.clear();
			graph.pending = undefined;
			throw error;
		}
		graph.pending = undefined;
		return false;
	}

	#relationshipForRequest(
		agent: AgentRecord,
		requestId: string,
	): { awaiting: boolean; owed: boolean } {
		const transcript = agent.transcript.inspect();
		const localDeliveries = deliveriesForRequest({
			recipientAgentId: agent.identity.agentId,
			transcript,
			requestId,
		});
		let awaiting = false;
		let owed = false;
		const request = this.#findBoundAuthoredRequest(agent, requestId);
		if (request?.kind === "request") {
			const responder = this.#agents.get(request.targetAgentId);
			const delivery = responder
				? this.#inspectRequestDelivery(request, responder).deliveryEvidence
				: undefined;
			if (
				inspectCanonicalMessage({
					message: request,
					authorTranscript: transcript,
					deliveryEvidence: delivery,
				}).state === "canonical"
			) {
				if (responder) {
					const resolution = this.#inspectResolution(request);
					const answered =
						resolution.answer &&
						inspectAnswerDelivery({
							requesterAgentId: agent.identity.agentId,
							transcript,
							answer: resolution.answer,
						}).deliveryEvidence;
					awaiting = !resolution.cancellation && !answered;
				} else {
					const delivered = localDeliveries.some((delivery) => {
						if (delivery.projection.kind !== "answer") return false;
						validateDeliveredMessageEvidence(delivery);
						return true;
					});
					awaiting =
						!this.#hasCanonicalAuthoredCancellation(agent, requestId) &&
						!delivered &&
						retrievalsForRequest({
							requesterAgentId: agent.identity.agentId,
							transcript,
							requestId,
						}).length === 0;
				}
			}
		}
		for (const delivery of localDeliveries) {
			if (delivery.projection.kind !== "request") continue;
			const requester = this.#agents.get(delivery.source.agentId);
			const incoming = requester ? this.findRequest(requestId) : undefined;
			if (incoming) {
				if (!this.#inspectRequestDelivery(incoming, agent).deliveryEvidence) continue;
				const resolution = this.#inspectResolution(incoming);
				// A responder can only learn of a withdrawal through Delivery, so a canonical
				// Cancellation leaves this obligation open until it lands here
				// (docs/agent-messaging.md: "Answer commitment or Cancellation Delivery
				// removes the corresponding entry"). The requester's own accounting is the
				// other half of the split: its committed Cancellation withdraws its own
				// `awaiting` entry without Delivery, because that is its own decision.
				// A delivered but non-canonical Cancellation never discharges the duty either:
				// Delivery proves notification, never authoring.
				const withdrawal = resolution.cancellation;
				const deliveredWithdrawal =
					withdrawal !== undefined &&
					inspectMessageDelivery({
						recipientAgentId: agent.identity.agentId,
						transcript,
						message: withdrawal,
					}).deliveryEvidence !== undefined;
				owed = !resolution.answer && !deliveredWithdrawal;
			} else {
				validateDeliveredMessageEvidence(delivery);
				const cancelled = this.isLocalCancellationDelivered(agent, requestId);
				owed = !this.findLocalAnswer(agent, requestId) && !cancelled;
			}
		}
		return { awaiting, owed };
	}

	#findBoundAuthoredRequest(agent: AgentRecord, requestId: string): Request | undefined {
		const transcript = agent.transcript.inspect();
		const source = findAuthoredAgentMessageSource({
			authorAgentId: agent.identity.agentId,
			transcript,
			messageId: requestId,
		});
		const creation = this.#findCreationRequest(requestId);
		let request: Request | undefined =
			creation?.fromAgentId === agent.identity.agentId ? creation : undefined;
		if (source?.input.operation === "request") {
			const target = this.#inspectMessageTarget(
				agent,
				transcript,
				source.source.toolCallId,
				source.input.targetAgent,
			);
			// Authorship alone does not bind a target or establish a Request obligation.
			if (target.state === "resolved") {
				const message = resolveCommittedMessage({
					fromAgentId: agent.identity.agentId,
					workflowId: agent.identity.workflowId,
					transcript,
					toolCallId: source.source.toolCallId,
					providedInput: source.input,
					resolvedTargetAgentId: target.targetAgentId,
				});
				if (message.kind === "request") request = message;
			}
		}
		return request;
	}

	callerWaitAnswer(
		caller: AgentRecord,
		requestId: string,
	): AgentWaitAnswer | undefined {
		const message = this.requireCallerAuthoredMessage(caller, requestId);
		if (message.kind !== "request") {
			throw new Error(`wrong_message_kind: Message ${requestId} is not a Request`);
		}
		const resolution = this.#inspectResolution(message);
		if (resolution.cancellation) {
			throw new Error(`invalid_state: Request ${requestId} was cancelled`);
		}
		const answer = resolution.answer;
		if (!answer) return undefined;
		const delivery = inspectAnswerDelivery({
			requesterAgentId: caller.identity.agentId,
			transcript: caller.transcript.inspect(),
			answer,
		});
		return delivery.deliveryEvidence
			? {
				disposition: "answer_already_delivered",
				requestMessageId: requestId,
				requestTitle: message.title,
				answerId: answer.messageId,
				deliveryEvidence: delivery.deliveryEvidence,
			}
			: {
				disposition: "answer_delivered",
				requestMessageId: requestId,
				requestTitle: message.title,
				answerId: answer.messageId,
				fromAgentId: answer.fromAgentId,
				answer: answer.answer,
				answerSource: answer.source,
			};
	}

	resolveRecoveryMessage(author: AgentRecord, messageId: string): Message | undefined {
		const authored = findAuthoredAgentMessageSource({
			authorAgentId: author.identity.agentId,
			transcript: author.transcript.inspect(),
			messageId,
		});
		if (authored && (authored.input.operation === "send" || authored.input.operation === "request")) {
			// Failed authoring is not recovery work, but Delivery or unavailable proof must still be inspected.
			const target = this.#inspectMessageTarget(
				author, author.transcript.inspect(), authored.source.toolCallId, authored.input.targetAgent,
			);
			if (target.state === "not_created") return undefined;
		}
		if (authored && (authored.input.operation === "answer" || authored.input.operation === "cancel")) {
			const requestId = authored.input.operation === "answer" ? authored.input.requestId : authored.input.requestMessageId;
			if (!this.findRequest(requestId)) return undefined;
		}
		if (!authored) return this.#findCreationRequest(messageId);
		return this.requireCallerAuthoredMessage(author, messageId);
	}

	requireCallerAuthoredMessage(caller: AgentRecord, messageId: string): Message {
		const ownMessage = this.#resolveAuthoredMessage(caller, messageId);
		if (ownMessage) return ownMessage;
		const creationRequest = this.#findCreationRequest(messageId);
		if (creationRequest) {
			if (creationRequest.fromAgentId === caller.identity.agentId) {
				return creationRequest;
			}
			throw this.#wrongParticipant(caller, messageId);
		}
		for (const candidateAuthor of this.#agents.values()) {
			if (candidateAuthor.identity.agentId === caller.identity.agentId) continue;
			if (this.#resolveAuthoredMessage(candidateAuthor, messageId)) {
				throw this.#wrongParticipant(caller, messageId);
			}
		}
		this.#throwIfUnavailableDeliveryEvidence(
			`Message ${messageId} depends on quarantined Agent proof`,
			({ source }) => deriveMessageIdentity(source) === messageId,
		);
		throw new Error(`unknown_identity: Message ${messageId}`);
	}

	#inspectResolution(request: Request) {
		return inspectCanonicalRequestResolution({
			request,
			requesterTranscript: this.#requireAgent(request.fromAgentId).transcript.inspect(),
			responderTranscript: this.#requireAgent(request.targetAgentId).transcript.inspect(),
		});
	}

	#hasCanonicalAuthoredCancellation(author: AgentRecord, requestId: string): boolean {
		const transcript = author.transcript.inspect();
		const canonical = cancellationSourcesForRequest({ authorAgentId: author.identity.agentId, transcript, requestId })
			.filter(({ source, input }) => input.operation === "cancel" && input.requestMessageId === requestId &&
				inspectAgentMessageAuthorResult({ authorAgentId: author.identity.agentId, transcript, source, input,
					resolvedTargetAgentId: this.requireRequest(requestId).targetAgentId }) === "canonical");
		if (canonical.length > 1) {
			throw new Error(`invariant_violation: Request ${requestId} has multiple canonical Cancellations`);
		}
		return canonical.length === 1;
	}

	#inspectRequestDelivery(request: Request, recipient: AgentRecord) {
		return request.origin === "agent_spawn"
			? inspectCreationRequestDelivery({
				recipientAgentId: recipient.identity.agentId,
				transcript: recipient.transcript.inspect(),
				requestId: request.messageId,
				fromAgentId: request.fromAgentId,
				title: request.title,
				source: request.source,
			})
			: inspectMessageDelivery({
				recipientAgentId: recipient.identity.agentId,
				transcript: recipient.transcript.inspect(),
				message: request,
			});
	}

	#findCreationRequest(requestId: string): Request | undefined {
		for (const child of this.#agents.values()) {
			if (!("spawnSource" in child.identity)) continue;
			if (child.identity.spawnSource.toolCallId.length === 0) continue;
			if (
				(child.creationRequest?.messageId ?? deriveMessageIdentity(child.identity.spawnSource)) !==
				requestId
			)
				continue;
			if (!child.creationInput) {
				// Skipped spawn history has no authored Request; recipient Delivery can still stand alone.
				continue;
			}
			return (child.creationRequest ??= resolveCreationRequest({
				childIdentity: child.identity,
				creationInput: child.creationInput,
			}));
		}
		return undefined;
	}

	#resolveAuthoredMessage(author: AgentRecord, messageId: string): Message | undefined {
		const authored = findAuthoredAgentMessageSource({
			authorAgentId: author.identity.agentId,
			transcript: author.transcript.inspect(),
			messageId,
		});
		if (!authored) return undefined;
		if (authored.input.operation === "send" || authored.input.operation === "request") {
			const authorTranscript = author.transcript.inspect();
			const target = this.#inspectMessageTarget(
				author,
				authorTranscript,
				authored.source.toolCallId,
				authored.input.targetAgent,
			);
			if (target.state === "not_created") return undefined;
			const resolvedTargetAgentId =
				target.state === "resolved"
					? target.targetAgentId
					: this.#resolveMessageTargetId(
							author,
							authorTranscript,
							authored.source.toolCallId,
							authored.input.targetAgent,
						);
			return resolveCommittedMessage({
				fromAgentId: author.identity.agentId,
				workflowId: author.identity.workflowId,
				transcript: authorTranscript,
				toolCallId: authored.source.toolCallId,
				providedInput: authored.input,
				resolvedTargetAgentId,
			});
		}
		if (authored.input.operation === "answer") {
			const answerInput = authored.input;
			const resultRequestId = answerSourceResultRequestId({
				transcript: author.transcript.inspect(),
				source: authored.source,
			});
			if (!this.findRequest(answerInput.requestId)) {
				const delivered = this.findDeliveredRequest(author, answerInput.requestId);
				if (!delivered) return undefined;
				if (resultRequestId !== undefined && resultRequestId !== answerInput.requestId) {
					throw new Error("invariant_violation: Agent Answer result names a different Request");
				}
				const answer = resolveCommittedAnswer({
					responderAgentId: author.identity.agentId, transcript: author.transcript.inspect(),
					toolCallId: authored.source.toolCallId, providedInput: answerInput,
					request: { messageId: delivered.requestMessageId, workflowId: author.identity.workflowId,
						fromAgentId: delivered.fromAgentId, title: delivered.title },
				});
				// Delivery can win the crash window before the responder's native
				// result. This observes existing proof; it never schedules a new Answer.
				const requester = this.#requireAgent(delivered.fromAgentId);
				const deliveryEvidence = inspectAnswerDelivery({ requesterAgentId: requester.identity.agentId,
					transcript: requester.transcript.inspect(), answer }).deliveryEvidence;
				return inspectCanonicalMessage({ message: answer, authorTranscript: author.transcript.inspect(), deliveryEvidence }).state === "canonical"
					? answer : undefined;
			}
			if (resultRequestId !== undefined) {
				this.#requireResponderRequest(author, resultRequestId);
			}
			const matches = [...this.#agents.values()].flatMap((requester) => {
				const deliveryRequestId = answerSourceDeliveryRequestId({
					requesterAgentId: requester.identity.agentId,
					transcript: requester.transcript.inspect(),
					source: authored.source,
				});
				if (
					resultRequestId !== undefined &&
					deliveryRequestId !== undefined &&
					resultRequestId !== deliveryRequestId
				) {
					throw new Error(
						`invariant_violation: Agent Answer ${messageId} result and Delivery name different Requests`,
					);
				}
				const requestId = resultRequestId ?? deliveryRequestId;
				if (requestId === undefined) return [];
				const request = this.#requireResponderRequest(author, requestId);
				if (request.fromAgentId !== requester.identity.agentId) return [];
				const answer = resolveCommittedAnswer({
					responderAgentId: author.identity.agentId,
					transcript: author.transcript.inspect(),
					toolCallId: authored.source.toolCallId,
					providedInput: answerInput,
					request,
				});
				const delivery = inspectAnswerDelivery({
					requesterAgentId: requester.identity.agentId,
					transcript: requester.transcript.inspect(),
					answer,
				});
				return inspectCanonicalMessage({
					message: answer,
					authorTranscript: author.transcript.inspect(),
					deliveryEvidence: delivery.deliveryEvidence,
				}).state === "canonical"
					? [answer]
					: [];
			});
			if (matches.length > 1) {
				throw new Error(
					`invariant_violation: Agent Answer ${messageId} correlates multiple Requests`,
				);
			}
			return matches[0];
		}
		const request = this.findRequest(authored.input.requestMessageId);
		if (!request) return undefined;
		return resolveCommittedCancellation({
			requesterAgentId: author.identity.agentId,
			transcript: author.transcript.inspect(),
			toolCallId: authored.source.toolCallId,
			providedInput: authored.input,
			request,
		});
	}

	#requireResponderRequest(responder: AgentRecord, requestId: string): Request {
		const request = this.requireRequest(requestId);
		if (request.targetAgentId !== responder.identity.agentId) {
			throw new Error(
				`invariant_violation: Agent Answer result names a Request for another responder`,
			);
		}
		return request;
	}

	/**
	 * Reject only an Answer result that names a Request with no evidence anywhere.
	 * A delivered Request whose authored source was skipped during replay keeps its
	 * obligation (docs/request-lifetime-decision-matrix.md, alternative B); the
	 * recipient-side Delivery is the evidence, so that Answer stays answerable.
	 */
	#validateAnswerResultReferences(responder: AgentRecord): void {
		const transcript = responder.transcript.inspect();
		// A record without a bootstrap Identity in this transcript has no authored
		// coordination facts to validate (test-only records, unadopted histories).
		if (!indexedState(transcript).scopes.has(responder.identity.agentId)) return;
		for (const { source, input } of findAuthoredAgentMessageSources({
			authorAgentId: responder.identity.agentId,
			transcript,
		})) {
			if (input.operation !== "answer") continue;
			const requestId = answerSourceResultRequestId({ transcript, source });
			if (requestId === undefined) continue;
			if (this.findRequest(requestId)) {
				this.#requireResponderRequest(responder, requestId);
				continue;
			}
			if (this.findDeliveredRequest(responder, requestId)) continue;
			throw new Error(`unknown_identity: Request ${requestId}`);
		}
	}

	#inspectMessageTarget(
		author: AgentRecord,
		authorTranscript: TranscriptInspection,
		toolCallId: string,
		targetAgent: string,
	) {
		return inspectCommittedAgentMessageTarget({
			agents: this.#agents,
			quarantinedWorkflowAgentIds: this.#quarantinedWorkflowAgentIds,
			authorAgentId: author.identity.agentId,
			authorTranscript,
			toolCallId,
			targetAgent,
		});
	}

	#resolveMessageTargetId(
		author: AgentRecord,
		authorTranscript: TranscriptInspection,
		toolCallId: string,
		targetAgent: string,
	): string {
		return resolveCommittedAgentMessageTargetId({
			agents: this.#agents,
			quarantinedWorkflowAgentIds: this.#quarantinedWorkflowAgentIds,
			authorAgentId: author.identity.agentId,
			authorTranscript,
			toolCallId,
			targetAgent,
		});
	}

	#requireAgent(agentId: string): AgentRecord {
		return requireAgentRecord(
			this.#agents,
			this.#quarantinedAgentIds,
			agentId,
		);
	}

	#throwIfUnavailableDeliveryEvidence(
		message: string,
		matches: (delivery: DeliveredMessageEvidence) => boolean,
	): void {
		for (const delivery of this.#allDeliveredMessages()) {
			if (matches(delivery) && this.#quarantinedAgentIds.has(delivery.source.agentId)) {
				validateDeliveredMessageEvidence(delivery);
				throw new EvidenceUnavailableError(message);
			}
		}
	}

	#allDeliveredMessages(): DeliveredMessageEvidence[] {
		return [...this.#agents.values()].flatMap((record) =>
			inspectMessageDeliveries({
				recipientAgentId: record.identity.agentId,
				transcript: record.transcript.inspect(),
			}));
	}

	#wrongParticipant(caller: AgentRecord, messageId: string): Error {
		return new Error(
			`wrong_participant: Agent ${caller.identity.agentId} did not author Message ${messageId}`,
		);
	}
}

type RelationshipCursor = {
	state: RetainedTranscript;
	scope: number;
	count: number;
	physicalCount: number;
};
type RelationshipGraph = {
	cursors: Map<AgentRecord, RelationshipCursor>;
	roster: AgentRecord[];
	awaiting: Set<string>;
	owed: Set<string>;
	result: ResidualRequestRelationships;
	pending?: Generator<void>;
	pendingSources?: Map<AgentRecord, RelationshipCursor>;
};
