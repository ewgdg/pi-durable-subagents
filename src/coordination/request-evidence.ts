import type { RequestInspection } from "../protocol/request-inspection.ts";
import { coordinationEntries, indexedState } from "../transcript/retained-transcript.ts";
import {
	EvidenceUnavailableError,
	requireAgentRecord,
	type AgentRecord,
} from "./agent-record.ts";
import {
	inspectCreationRequestDelivery,
	resolveCreationRequest,
} from "../protocol/creation-request.ts";
import {
	deriveMessageIdentity,
	ProtocolInvariantError,
	resolveCommittedToolCall,
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
	answerSourceResultRequestId,
	findAuthoredAgentMessageSource,
	findAuthoredAgentMessageSources,
	inspectCanonicalRequestResolution,
	type CanonicalRequestResolution,
} from "../protocol/request-resolution.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import {
	inspectCommittedAgentMessageTarget,
	resolveCommittedAgentMessageTargetId,
} from "./agent-message-target.ts";

type Request = Extract<Message, { kind: "request" }>;
type Answer = Extract<Message, { kind: "answer" }>;
type Cancellation = Extract<Message, { kind: "request_cancellation" }>;

export class RequestEvidence {
	readonly #agents: Map<string, AgentRecord>;
	readonly #quarantinedAgentIds: ReadonlySet<string>;
	readonly #quarantinedWorkflowAgentIds: ReadonlySet<string>;
	// The transcript is authoritative. These entries only bridge the interval after
	// lane admission and before Pi appends the native tool result.
	readonly #admittedRequestsById = new Map<string, Request>();
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

	rememberAdmittedRequest(request: Request): void {
		this.#admittedRequestsById.set(request.messageId, request);
	}

	/** Initial admission failed, so the Request was never created. */
	forgetAdmittedRequest(requestId: string): void {
		this.#admittedRequestsById.delete(requestId);
	}

	rememberAdmittedAnswer(answer: Answer): void {
		this.#admittedAnswersByRequest.set(answer.requestId, answer);
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

	/**
	 * The author's Requests and Cancellations admitted in its lane whose native
	 * tool result has not committed yet. Once it commits, the transcript decides.
	 */
	admittedAuthorshipBy(author: AgentRecord): Readonly<{
		requestIds: readonly string[];
		cancelledRequestIds: readonly string[];
	}> {
		const authorId = author.identity.agentId;
		const requestIds: string[] = [];
		for (const [requestId, request] of this.#admittedRequestsById) {
			if (request.fromAgentId !== authorId) continue;
			if (this.#hasAuthorResult(author, request.source.toolCallId)) {
				this.#admittedRequestsById.delete(requestId);
			} else requestIds.push(requestId);
		}
		const cancelledRequestIds = [...this.#admittedCancellationsByRequest.values()]
			.filter((cancellation) => cancellation.fromAgentId === authorId &&
				!this.#hasAuthorResult(author, cancellation.source.toolCallId))
			.map(({ requestId }) => requestId);
		return { requestIds, cancelledRequestIds };
	}

	discardAdmittedAuthorshipBy(author: AgentRecord): void {
		for (const [requestId, request] of this.#admittedRequestsById) {
			if (request.fromAgentId === author.identity.agentId) {
				this.#admittedRequestsById.delete(requestId);
			}
		}
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
		const durable = this.canonicalResolution(request).answer;
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
		const durable = this.canonicalResolution(request).cancellation;
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
		const creationRequest = this.findCreationRequest(requestId);
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

	/** The responder's Answer, including one admitted in its lane whose tool result has not committed. */
	findLocalAnswer(responder: AgentRecord, requestId: string): Answer | undefined {
		const canonical = this.#findCanonicalLocalAnswer(responder, requestId);
		const admitted = this.#admittedAnswersByRequest.get(requestId);
		if (canonical && admitted && canonical.messageId !== admitted.messageId) {
			throw new Error(`invariant_violation: Request ${requestId} has conflicting admitted and canonical Answers`);
		}
		return canonical ?? admitted;
	}

	#findCanonicalLocalAnswer(responder: AgentRecord, requestId: string): Answer | undefined {
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
		return canonical[0];
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
			const authored = this.findAuthoredRequest(agent, requestId);
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

	/**
	 * One Agent's stake in one Request: whether it awaits the Answer as requester
	 * and whether it owes the Answer as responder. Durable evidence only.
	 */
	stakeIn(
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
		const request = this.findAuthoredRequest(agent, requestId);
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
					const resolution = this.canonicalResolution(request);
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
				const resolution = this.canonicalResolution(incoming);
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
				// An admitted Answer is only a reservation until its tool result commits,
				// and Run failure can still discard it, so only a canonical Answer ends the stake.
				owed = !this.#findCanonicalLocalAnswer(agent, requestId) && !cancelled;
			}
		}
		return { awaiting, owed };
	}

	/** A Request the Agent authored, including its children's Creation Requests. */
	findAuthoredRequest(agent: AgentRecord, requestId: string): Request | undefined {
		const transcript = agent.transcript.inspect();
		const source = findAuthoredAgentMessageSource({
			authorAgentId: agent.identity.agentId,
			transcript,
			messageId: requestId,
		});
		const creation = this.findCreationRequest(requestId);
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
		if (!authored) return this.findCreationRequest(messageId);
		return this.requireCallerAuthoredMessage(author, messageId);
	}

	requireCallerAuthoredMessage(caller: AgentRecord, messageId: string): Message {
		const ownMessage = this.#resolveAuthoredMessage(caller, messageId);
		if (ownMessage) return ownMessage;
		const creationRequest = this.findCreationRequest(messageId);
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

	/** Durable Answer and Cancellation authority; admitted bridges are not consulted. */
	canonicalResolution(request: Request): CanonicalRequestResolution {
		return inspectCanonicalRequestResolution({
			request,
			requesterTranscript: this.#requireAgent(request.fromAgentId).transcript.inspect(),
			responderTranscript: this.#requireAgent(request.targetAgentId).transcript.inspect(),
		});
	}

	#hasAuthorResult(author: AgentRecord, toolCallId: string): boolean {
		return coordinationEntries(author.transcript.inspect(), author.identity.agentId, `result:${toolCallId}`)
			.some((entry) => entry.type === "message" && entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId);
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

	findCreationRequest(requestId: string): Request | undefined {
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
	validateAnswerResultReferences(responder: AgentRecord): void {
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
