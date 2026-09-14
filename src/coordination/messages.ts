import { scheduleDeliveryFailureNotice } from "./delivery-failure-notifications.ts";
import { findAuthoredSupervisoryResumeMessages } from "../protocol/run-control.ts";
import { findAuthoredAgentMessageSources, inspectCanonicalRequestResolution } from "../protocol/request-resolution.ts";
import { compareCommittedToolCallOrder, deriveMessageIdentity } from "../protocol/identities.ts";
import type { WorkflowResumeDelivery } from "./workflow-recovery-outcomes.ts";
import { resolveCommittedToolCall } from "../protocol/identities.ts";
import { resolveAgentMessageReferences } from "../protocol/message-reference.ts";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import {
	requireAgentRecord,
	type AgentRecord,
} from "./agent-record.ts";
import {
	MessageDeliveryScheduler,
	type MessageDeliveryAdmission,
	type IncomingRequestWaitPreemptor,
	type ScheduledCustomDelivery,
	type ScheduledMessageDelivery,
	type ResumeReservationHandler,
	type ScheduleDeliveryDispatch,
	type ScheduleReleaseEvaluation,
	type SteerFreezeHandler,
} from "./message-delivery-scheduler.ts";
import type {
	AgentAnswerReceipt,
	AgentMessagePollReceipt,
	AgentMessageReceipt,
	AgentMessageRetryReceipt,
	AgentMessageSendReceipt,
	AgentRequestReceipt,
	AgentRequestRetryReceipt,
	RequestCancellationReceipt,
} from "./message-receipts.ts";
import { RequestEvidence } from "./request-evidence.ts";
import type { OpenIncomingRequestList, RequestInspection } from "../protocol/request-inspection.ts";
import {
	createMessageDeliveryItem,
	inspectAnswerDelivery,
	inspectCanonicalMessage,
	inspectMessageDelivery,
	resolveCommittedAnswer,
	resolveCommittedCancellation,
	resolveCommittedMessage,
	resolveCommittedAgentMessageInput,
	sameAgentMessageInput,
	type AgentMessageInput,
	type AnswerInput,
	type CancellationInput,
	type Message,
	type MessagePollInput,
	type MessageRetryInput,
} from "../protocol/message.ts";
import {
	createCreationRequestDeliveryItem,
	inspectCreationRequestDelivery,
} from "../protocol/creation-request.ts";
import type { AgentWaitResult } from "../protocol/agent-wait.ts";
import type { ToolCallPointer } from "../protocol/identities.ts";
import type {
	AgentRunHandle,
	InterruptionHoldHandle,
} from "../runtime/agent-runtime-host.ts";
import type { WorkflowPolicyStore } from "../policy/workflow-policy.ts";
import type { UnresolvedAgentRequest } from "./dependency-deadlock.ts";
import { resolveCommittedAgentMessageTargetId } from "./agent-message-target.ts";

export type { AgentMessageInput } from "../protocol/message.ts";
export type {
	AgentAnswerReceipt,
	AgentMessagePollReceipt,
	AgentMessageReceipt,
	AgentMessageRetryReceipt,
	AgentMessageSendReceipt,
	AgentRequestReceipt,
	AgentRequestRetryReceipt,
	RequestCancellationReceipt,
} from "./message-receipts.ts";

type CreationRequestScheduling = Readonly<{
	recipient: AgentRecord;
	requestId: string;
	fromAgentId: string;
	title: string;
	question: string;
	source: ToolCallPointer;
}>;

export type MessageBoundaryHooks = Readonly<{
	scheduleDeliveryDispatch?: ScheduleDeliveryDispatch;
	beforeDeliveryAdmission?(context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		operation: "send" | "retry" | "answer" | "cancel";
	}>): void | "confirmed_failure";
	beforeRecipientInspection?(context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		operation: "poll" | "retry";
	}>): void | "inspection_incomplete";
	afterDeliveryAdmission?(context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		operation: "send" | "retry" | "answer" | "cancel";
	}>): void | "confirmation_lost";
	afterSteerFreeze?: SteerFreezeHandler;
	afterResumeReservation?: ResumeReservationHandler;
	scheduleReleaseEvaluation?: ScheduleReleaseEvaluation;
}>;

export class MessageCoordinator {
	readonly #agents: Map<string, AgentRecord>;
	readonly #isShuttingDown: () => boolean;
	readonly #boundaryHooks: MessageBoundaryHooks;
	readonly #deliveryScheduler: MessageDeliveryScheduler;
	readonly #requestEvidence: RequestEvidence;
	readonly #quarantinedAgentIds: ReadonlySet<string>;
	readonly #quarantinedWorkflowAgentIds: ReadonlySet<string>;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		quarantinedAgentIds?: ReadonlySet<string>;
		quarantinedWorkflowAgentIds?: ReadonlySet<string>;
		isShuttingDown(): boolean;
		boundaryHooks?: MessageBoundaryHooks;
		preemptAgentWait?: IncomingRequestWaitPreemptor;
		workflowPolicy: WorkflowPolicyStore;
		deliveryProgressClock?: import("./operation-review.ts").OperationReviewClock;
		onDeliveryProgressChanged?(): void;
		isWaitingForCapacity?(agentId: string): boolean;
	}) {
		this.#agents = options.agents;
		this.#quarantinedAgentIds = options.quarantinedAgentIds ?? new Set();
		this.#quarantinedWorkflowAgentIds =
			options.quarantinedWorkflowAgentIds ?? this.#quarantinedAgentIds;
		this.#isShuttingDown = options.isShuttingDown;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#requestEvidence = new RequestEvidence(
			this.#agents,
			this.#quarantinedAgentIds,
			this.#quarantinedWorkflowAgentIds,
		);
		this.#deliveryScheduler = new MessageDeliveryScheduler({
			scheduleReleaseEvaluation: this.#boundaryHooks.scheduleReleaseEvaluation,
			scheduleDeliveryDispatch: this.#boundaryHooks.scheduleDeliveryDispatch,
			afterSteerFreeze: this.#boundaryHooks.afterSteerFreeze,
			afterResumeReservation: this.#boundaryHooks.afterResumeReservation,
			preemptAgentWait: options.preemptAgentWait,
			workflowPolicy: options.workflowPolicy,
			deliveryProgressClock: options.deliveryProgressClock,
			onDeliveryProgressChanged: options.onDeliveryProgressChanged,
			isWaitingForCapacity: options.isWaitingForCapacity,
			onDeliveryFailure: failure => scheduleDeliveryFailureNotice({
				failure, author: this.#requireAgent(failure.delivery.deliveryItem.source.agentId),
				scheduler: this.#deliveryScheduler, isShuttingDown: this.#isShuttingDown,
			}),
		});
	}


	/** Fixed candidate membership is captured before recovery admits any work. */
	recoveryMessageCandidates(record: AgentRecord): readonly { messageId: string; authorAgentId: string }[] {
		const sources = findAuthoredAgentMessageSources({
			authorAgentId: record.identity.agentId,
			transcript: record.transcript.inspect(),
		});
		const transcript = record.transcript.inspect();
		return [
			...sources.map(({ source }) => source),
			...findAuthoredSupervisoryResumeMessages({ workflowId: record.identity.workflowId, authorAgentId: record.identity.agentId, transcript }).map(message => message.source),
			...[...this.#agents.values()].flatMap(child =>
				"spawnSource" in child.identity && child.identity.directSpawnerAgentId === record.identity.agentId
					? [child.identity.spawnSource]
					: []),
		].sort((a, b) => compareCommittedToolCallOrder(transcript, a, b))
			.map(source => ({ messageId: deriveMessageIdentity(source), authorAgentId: record.identity.agentId }));
	}

	recoveryMessage(authorAgentId: string, messageId: string): Message | undefined {
		const author = this.#requireAgent(authorAgentId);
		return findAuthoredSupervisoryResumeMessages({
			workflowId: author.identity.workflowId, authorAgentId, transcript: author.transcript.inspect(),
		}).find(message => message.messageId === messageId) ??
			this.#requestEvidence.resolveRecoveryMessage(author, messageId);
	}

	recoveryRequestIds(record: AgentRecord): readonly string[] {
		return this.#requestEvidence.obligationFrames(record).flatMap(frame => {
			const request = this.#requestEvidence.findRequest(frame.requestId);
			// Recovery may continue a retained duty; this is not Request redelivery.
			if (!request) return [frame.requestId];
			const resolution = this.#recoveryResolution(request);
			return resolution.cancellation || resolution.answer ? [] : [frame.requestId];
		});
	}

	inspectRecoveryMessage(message: Message): WorkflowResumeDelivery | undefined {
		const recipient = this.#requireAgent(message.targetAgentId);
		const identity = { messageId: message.messageId, targetAgentId: message.targetAgentId, kind: message.kind };
		const delivery = message.kind === "answer"
			? inspectAnswerDelivery({ requesterAgentId: message.targetAgentId, transcript: recipient.transcript.inspect(), answer: message })
			: inspectMessageDelivery({ recipientAgentId: message.targetAgentId, transcript: recipient.transcript.inspect(), message });
		const canonical = inspectCanonicalMessage({
			message, authorTranscript: this.#requireAgent(message.fromAgentId).transcript.inspect(), deliveryEvidence: delivery.deliveryEvidence,
		});
		if (canonical.state === "not_created") return { ...identity, disposition: "skipped", reason: "not_created" };
		if (canonical.state === "indeterminate") return { ...identity, disposition: "indeterminate", reason: "inspection_incomplete" };
		const resolution = message.kind === "request" ? this.#recoveryResolution(message) : undefined;
		if (resolution?.cancellation || resolution?.answer) {
			return { ...identity, disposition: "skipped", reason: "request_resolved" };
		}
		if (delivery.deliveryEvidence) return { ...identity, disposition: "skipped", reason: "delivered" };
		return undefined;
	}

	#recoveryResolution(request: Extract<Message, { kind: "request" }>) {
		// Recovery candidates require durable commitment, not the live admission bridge.
		return inspectCanonicalRequestResolution({
			request,
			requesterTranscript: this.#requireAgent(request.fromAgentId).transcript.inspect(),
			responderTranscript: this.#requireAgent(request.targetAgentId).transcript.inspect(),
		});
	}

	async resumeMessage(message: Message): Promise<WorkflowResumeDelivery> {
		const recipient = this.#requireAgent(message.targetAgentId);
		return recipient.host.lane.run(async () => {
			const current = this.inspectRecoveryMessage(message);
			if (current) return current;
			const identity = { messageId: message.messageId, targetAgentId: message.targetAgentId, kind: message.kind };
			if (this.#isShuttingDown()) return { ...identity, disposition: "blocked", reason: "host_shutting_down" };
			const alreadyScheduled = this.#deliveryScheduler.hasScheduling(recipient.identity.agentId, message.messageId);
			const scheduled = this.#scheduleGeneralMessage(recipient, message);
			// Cancellation or completion can commit after admission but before dispatch.
			const delivery = message.kind === "request" ? { ...scheduled, isSuppressed: () =>
				this.#requestEvidence.findCancellation(message) !== undefined || this.#requestEvidence.findAnswer(message) !== undefined } : scheduled;
			const admission = await this.#deliveryScheduler.admitInLane(recipient, delivery);
			return admission === "pending"
				? { ...identity, disposition: alreadyScheduled ? "skipped" : "scheduled", ...(alreadyScheduled ? { reason: "already_scheduled" } : {}) }
				: { ...identity, disposition: "blocked", reason: admission };
		});
	}

	blockedDeliveries() { return this.#deliveryScheduler.blockedDeliveries(); }
	hasAutonomousDeliveryProgress(): boolean { return this.#deliveryScheduler.hasAutonomousProgress(); }

	hasDeliveryProgress(record: AgentRecord): boolean { return this.#deliveryScheduler.hasProgress(record); }

	obligationFrames(agentId: string) { return this.#requestEvidence.obligationFrames(this.#requireAgent(agentId)); }

	openIncomingRequests(agentId: string): OpenIncomingRequestList {
		return this.#requestEvidence.openIncomingRequests(this.#requireAgent(agentId));
	}

	inspectRequest(agentId: string, requestId: string): RequestInspection {
		return this.#requestEvidence.inspectRequest(this.#requireAgent(agentId), requestId);
	}

	foregroundRequestId(record: AgentRecord): string | undefined {
		return this.#requestEvidence.obligationFrames(record).at(-1)?.requestId;
	}

	shutdownDeliveryProgress(): void { this.#deliveryScheduler.shutdownProgress(); }

	integrate(record: AgentRecord): void {
		record.host.setRunStartInitializer(
			() => this.#requestEvidence.refreshRelationshipsFor(record),
		);
		record.host.addSettledHandler((_handle, settlement) => {
			if (settlement === "failed") {
				this.#requestEvidence.discardAdmittedAuthorshipBy(record);
			}
		});
		this.#deliveryScheduler.integrate(record);
	}

	async refreshTranscriptFacts(): Promise<void> {
		for (const record of this.#agents.values()) await this.#requestEvidence.refreshRelationshipsFor(record);
	}

	requestSources(requestIds: readonly string[]): readonly ToolCallPointer[] {
		return requestIds.map(
			(requestId) => this.#requestEvidence.requestMetadata(requestId).source,
		);
	}

	requestTitle(requestId: string): string {
		return this.#requestEvidence.requestMetadata(requestId).title;
	}

	// Re-arbitrate retrieval at the native commit edge so a direct Delivery that
	// won after tool execution cannot leave a second requester-side proof.
	guardResultCommit(
		callerAgentId: string,
		message: MessageEndEvent["message"],
	): Readonly<{ message: MessageEndEvent["message"] }> | undefined {
		if (
			message.role !== "toolResult" ||
			message.toolName !== "agent_message" ||
			message.isError ||
			typeof message.details !== "object" ||
			message.details === null ||
			!("disposition" in message.details) ||
			message.details.disposition !== "answer_delivered"
		) return undefined;
		const caller = this.#requireAgent(callerAgentId);
		let input = resolveCommittedAgentMessageInput({
			agentId: callerAgentId,
			transcript: caller.transcript.inspect(),
			toolCallId: message.toolCallId,
		});
		input = resolveAgentMessageReferences(caller.transcript.inspect(), resolveCommittedToolCall({
			agentId: callerAgentId, transcript: caller.transcript.inspect(), toolCallId: message.toolCallId, toolName: "agent_message",
		}).source, input);
		if (input.operation !== "retry") return undefined;
		const request = this.#requestEvidence.requireCallerAuthoredMessage(
			caller,
			input.messageId,
		);
		if (request.kind !== "request") return undefined;
		const answer = this.#requestEvidence.findAnswer(request);
		if (!answer) return undefined;
		const expected = {
			disposition: "answer_delivered" as const,
			requestMessageId: request.messageId,
			requestTitle: request.title,
			answerId: answer.messageId,
			fromAgentId: answer.fromAgentId,
			answer: answer.answer,
			answerSource: answer.source,
		};
		if (!isDeepStrictEqual(message.details, expected)) return undefined;
		const deliveryEvidence = inspectAnswerDelivery({
			requesterAgentId: callerAgentId,
			transcript: caller.transcript.inspect(),
			answer,
		}).deliveryEvidence;
		const result = deliveryEvidence
			? {
				disposition: "answer_already_delivered" as const,
				requestMessageId: request.messageId,
				requestTitle: request.title,
				answerId: answer.messageId,
				deliveryEvidence,
			}
			: this.#deliveryScheduler.hasDispatchReservation(
				callerAgentId,
				answer.messageId,
			)
				? {
					requestMessageId: request.messageId,
					messageStatus: "unknown" as const,
					reason: "inspection_incomplete" as const,
				}
				: undefined;
		if (!result) return undefined;
		return {
			message: {
				...message,
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			},
		};
	}

	outstandingRequestIds(
		callerAgentId: string,
		waitSource: ToolCallPointer,
		selectors?: readonly string[],
	): readonly string[] {
		const caller = this.#requireAgent(callerAgentId);
		const requestMessageIds = this.#requestEvidence.outstandingRequestIdsAt(
			caller,
			waitSource,
			selectors,
		);
		if (requestMessageIds.length === 0) {
			throw new Error(
				"invalid_input: Agent Wait requires at least one outstanding outbound Agent Request",
			);
		}
		return requestMessageIds;
	}

	waitAnswers(
		callerAgentId: string,
		requestMessageIds: readonly string[],
	): AgentWaitResult | undefined {
		const caller = this.#requireAgent(callerAgentId);
		const answers = requestMessageIds.map((requestId) => {
			const answer = this.#requestEvidence.callerWaitAnswer(caller, requestId);
			return answer?.disposition === "answer_delivered" &&
				this.#deliveryScheduler.hasDispatchReservation(
					callerAgentId,
					answer.answerId,
				)
				? undefined
				: answer;
		});
		return answers.every((answer) => answer !== undefined)
			? { answers }
			: undefined;
	}

	requestTargetAgentIds(requestIds: readonly string[]): readonly string[] {
		return requestIds.map(
			(requestId) => this.#requestEvidence.requestMetadata(requestId).targetAgentId,
		);
	}

	requestRelationships(requestIds: readonly string[]): readonly (UnresolvedAgentRequest & { requestTitle: string })[] {
		return requestIds.map((requestId) => {
			const request = this.#requestEvidence.requestMetadata(requestId);
			return {
				requestId,
				requestTitle: request.title,
				fromAgentId: request.fromAgentId,
				targetAgentId: request.targetAgentId,
			};
		});
	}

	unansweredRequestRelationships(
		callerAgentId: string,
		requestIds: readonly string[],
	): readonly UnresolvedAgentRequest[] {
		const caller = this.#requireAgent(callerAgentId);
		return this.requestRelationships(requestIds).filter(
			({ requestId }) =>
				this.#requestEvidence.callerWaitAnswer(caller, requestId) === undefined,
		);
	}

	/**
	 * Explicit Wait renews delivery intent once; later passes are confined to
	 * those exact recipient Runs. Cold recovery never creates this reconciler.
	 */
	createRequestDeliveryReconciler(
		callerAgentId: string,
		requestIds: readonly string[],
		isWaiting: () => boolean,
	): () => Promise<void> {
		const requester = this.#requireAgent(callerAgentId);
		const recipients = new Map<AgentRecord, {
			handle: AgentRunHandle | undefined;
			sequence: number;
			requestIds: string[];
			reconciling: boolean;
		}>();
		for (const requestId of requestIds) {
			const request = this.#requestEvidence.requireCallerAuthoredMessage(requester, requestId);
			if (request.kind !== "request") throw new Error(`invariant_violation: ${requestId} is not a Request`);
			const responder = this.#requireAgent(request.targetAgentId);
			let intent = recipients.get(responder);
			if (!intent) {
				intent = {
					handle: responder.host.currentHandle(),
					sequence: responder.host.latestStartedRunSequence(),
					requestIds: [],
					reconciling: false,
				};
				recipients.set(responder, intent);
			}
			intent.requestIds.push(requestId);
		}
		return async () => {
			await Promise.all([...recipients].map(async ([responder, intent]) => {
				// A busy lane owns only its own pass. Later ticks still maintain
				// other recipients without accumulating work behind this lane.
				if (intent.reconciling) return;
				intent.reconciling = true;
				try {
					await responder.host.lane.run(async () => {
						for (const requestId of intent.requestIds) {
							if (!isWaiting() || this.#isShuttingDown() || responder.host.currentRunFailed() ||
								responder.host.observe().phase === "ending") return;
							const request = this.#requestEvidence.requireRequest(requestId);
							if (this.#requestEvidence.findAnswer(request) || this.#requestEvidence.findCancellation(request)) continue;
							// A fresh Wait may start a Dormant recipient. A later termination,
							// failure or successor Run ends this Wait's readmission authority.
							// Inspecting delivered work leaves dormant admission available.
							if (intent.handle
								? !responder.host.isCurrent(intent.handle)
								: responder.host.latestStartedRunSequence() !== intent.sequence ||
									responder.host.currentHandle() !== undefined
							) return;
							const receipt = await this.#retryRequestInLane(requester, responder, request);
							intent.handle = responder.host.currentHandle();
							if ("messageStatus" in receipt && receipt.messageStatus !== "sent" &&
								receipt.reason !== "policy_rejected") {
								throw new Error(`Agent Wait cannot ensure Request ${requestId} Delivery: ${receipt.reason}`);
							}
						}
					});
				} finally {
					intent.reconciling = false;
				}
			}));
		};
	}

	answerObligationRequestIds(responder: AgentRecord): readonly string[] {
		return this.#requestEvidence.residualRelationshipsFor(responder)
			.answerOwedRequestIds;
	}

	outstandingRequestIdsFor(requester: AgentRecord): readonly string[] {
		return this.#requestEvidence.outstandingRequestIdsFor(requester);
	}

	hasUnsettledAnswerObligation(
		responder: AgentRecord,
		requestIds: readonly string[],
	): boolean {
		const remaining = new Set(this.answerObligationRequestIds(responder));
		return requestIds.some((requestId) => remaining.has(requestId));
	}

	async send(
		callerAgentId: string,
		toolCallId: string,
		input: Extract<AgentMessageInput, { operation: "send" | "request" }>,
	): Promise<AgentMessageSendReceipt | AgentRequestReceipt> {
		const sender = this.#requireAgent(callerAgentId);
		const senderTranscript = sender.transcript.inspect();
		const resolvedTargetAgentId = resolveCommittedAgentMessageTargetId({
			agents: this.#agents,
			quarantinedWorkflowAgentIds: this.#quarantinedWorkflowAgentIds,
			authorAgentId: callerAgentId,
			authorTranscript: senderTranscript,
			toolCallId,
			targetAgent: input.targetAgent,
		});
		const recipient = this.#requireAgent(resolvedTargetAgentId);
		const message = resolveCommittedMessage({
			fromAgentId: callerAgentId,
			workflowId: sender.identity.workflowId,
			transcript: senderTranscript,
			toolCallId,
			providedInput: input,
			resolvedTargetAgentId,
		});
		if (recipient.identity.workflowId !== message.workflowId) {
			throw new Error("wrong_workflow: Message recipient is outside the sender Workflow");
		}
		if (message.kind === "message") {
			const frames = await sender.host.lane.run(
				() => this.#requestEvidence.obligationFrames(sender),
			);
			for (const frame of frames) {
				if (frame.requesterAgentId === message.targetAgentId) {
					return {
						disposition: "rejected",
						reason: "answer_required",
						requestMessageId: frame.requestId,
					};
				}
			}
		}
		const identity = message.kind === "request"
			? {
				requestMessageId: message.messageId,
				targetAgentId: message.targetAgentId,
			}
			: {
				messageId: message.messageId,
				targetAgentId: message.targetAgentId,
			};
		if (this.#isShuttingDown()) {
			return {
				...identity,
				messageStatus: "not_sent",
				reason: "host_shutting_down",
			};
		}
		if (message.kind === "request") {
			sender.host.addRetentionReason("awaiting_answer", message.messageId);
		}
		const delivery = this.#scheduleGeneralMessage(recipient, message);
		if (
			this.#boundaryHooks.beforeDeliveryAdmission?.({
				recipientAgentId: recipient.identity.agentId,
				messageId: message.messageId,
				operation: "send",
			}) === "confirmed_failure"
		) {
			this.#deliveryScheduler.recordAdmissionFailure(recipient, delivery, new Error("Confirmed Delivery admission failure"));
			if (message.kind === "request") sender.host.removeRetentionReason("awaiting_answer", message.messageId);
			return {
				...identity,
				messageStatus: "not_sent",
				reason: "target_unavailable",
			};
		}
		const admission = await this.#deliveryScheduler.admit(recipient, delivery);
		if (admission === "pending") {
			return this.#boundaryHooks.afterDeliveryAdmission?.({
				recipientAgentId: recipient.identity.agentId,
				messageId: message.messageId,
				operation: "send",
			}) === "confirmation_lost"
				? { ...identity, messageStatus: "unknown", reason: "confirmation_lost" }
				: { ...identity, messageStatus: "sent" };
		}
		if (message.kind === "request") sender.host.removeRetentionReason("awaiting_answer", message.messageId);
		return {
			...identity,
			messageStatus: "not_sent",
			reason: admission,
		};
	}

	recordCreationRequestFailure(options: CreationRequestScheduling, error: unknown): void {
		this.#deliveryScheduler.recordAdmissionFailure(options.recipient, this.#creationRequestDelivery(options), error);
	}

	async admitCreationRequest(options: CreationRequestScheduling): Promise<MessageDeliveryAdmission> {
		return this.#deliveryScheduler.admit(options.recipient, this.#creationRequestDelivery(options));
	}

	#creationRequestDelivery(options: CreationRequestScheduling): ScheduledMessageDelivery {
		const { recipient, requestId, fromAgentId, title, question, source } = options;
		return {
			messageId: requestId,
			deliveryMode: "deferred",
			deliveryItem: createCreationRequestDeliveryItem({
				requestId,
				fromAgentId,
				title,
				question,
				source,
			}),
			inspectProof: () =>
				inspectCreationRequestDelivery({
					recipientAgentId: recipient.identity.agentId,
					transcript: recipient.transcript.inspect(),
					requestId,
					fromAgentId,
					title,
					source,
				}).deliveryEvidence,
			isSuppressed: () => this.#isCancellationDelivered(requestId, recipient),
			isIncomingRequest: true,
			isDeliveryBlocked: () =>
				this.#deliveryScheduler.isDeliveryBlocked(recipient, "deferred"),
			afterCommit: () => {
				const request = this.#requestEvidence.requireRequest(requestId);
				if (
					this.#requestEvidence.findAnswer(request) === undefined &&
					!this.#isCancellationDelivered(requestId, recipient)
				) {
					recipient.host.addRetentionReason("answer_owed", requestId);
				}
			},
		};
	}

	admitCustomDeliveryInLane(
		recipient: AgentRecord,
		delivery: ScheduledCustomDelivery,
	): Promise<MessageDeliveryAdmission> {
		return this.#deliveryScheduler.admitCustomInLane(recipient, delivery);
	}

	admitCustomDelivery(
		recipient: AgentRecord,
		delivery: ScheduledCustomDelivery,
	): Promise<"pending" | "target_unavailable" | "capacity_exhausted"> {
		return this.#deliveryScheduler.admitCustom(recipient, delivery);
	}

	requestRelease(record: AgentRecord): Promise<"released" | "retained" | "stale"> {
		return this.#deliveryScheduler.requestRelease(record);
	}

	deliveryEligibilityChanged(record: AgentRecord): Promise<void> {
		return this.#deliveryScheduler.requestQueueAdvanced(record);
	}

	async beginParkingInLane(
		record: AgentRecord,
		handle: AgentRunHandle,
	): Promise<boolean> {
		this.#reconcileAnswerDeliveries(record);
		if (this.#reconcileCommittedAnswerAuthorship(record)) {
			await this.#deliveryScheduler.requestQueueAdvancedInLane(record);
		}
		// Workflow activity, not Request retention, owns parking eligibility. A
		// different child can still be working after the last Answer is reconciled.
		return this.#deliveryScheduler.beginParkingInLane(record, handle);
	}

	endParkingInLane(record: AgentRecord, handle: AgentRunHandle): void {
		this.#deliveryScheduler.endParkingInLane(record, handle);
	}

	async reachSafeBoundary(agentId: string): Promise<void> {
		await this.refreshTranscriptFacts();
		if (this.#isShuttingDown()) return Promise.resolve();
		const record = this.#requireAgent(agentId);
		// Confirmed Run disposal already owns this Agent lane and fences its volatile
		// scheduling. Re-entering the lane from Pi's awaited turn_end would deadlock
		// disposal while it waits for the same turn to settle.
		if (record.host.observe().phase === "ending" || record.host.isInterrupting()) {
			return Promise.resolve();
		}
		await record.host.lane.run(async () => {
			this.#reconcileAnswerDeliveries(record);
			if (this.#reconcileCommittedAnswerAuthorship(record)) {
				await this.#deliveryScheduler.requestQueueAdvancedInLane(record);
			}
		});
		return this.#deliveryScheduler.reachSafeBoundary(record);
	}

	discardSchedulingInLane(record: AgentRecord): void {
		this.#requestEvidence.discardAdmittedAuthorshipBy(record);
		this.#deliveryScheduler.discardInLane(record);
	}

	prepareInterruptionInLane(record: AgentRecord): void {
		this.#deliveryScheduler.prepareInterruptionInLane(record);
	}

	admitResumeInLane(
		record: AgentRecord,
		message: Extract<Message, { kind: "message" }>,
		hold: InterruptionHoldHandle,
	) {
		return this.#deliveryScheduler.admitResumeInLane(
			record,
			this.#scheduleGeneralMessage(record, message),
			hold,
		);
	}

	async execute(
		callerAgentId: string,
		toolCallId: string,
		providedInput: AgentMessageInput,
	): Promise<AgentMessageReceipt> {
		await this.refreshTranscriptFacts();
		const caller = this.#requireAgent(callerAgentId);
		let committedInput = resolveCommittedAgentMessageInput({
			agentId: callerAgentId,
			transcript: caller.transcript.inspect(),
			toolCallId,
		});
		if (!sameAgentMessageInput(committedInput, providedInput)) {
			throw new Error("invariant_violation: executed Agent Message input differs from its source");
		}
		committedInput = resolveAgentMessageReferences(caller.transcript.inspect(), resolveCommittedToolCall({
			agentId: callerAgentId, transcript: caller.transcript.inspect(), toolCallId, toolName: "agent_message",
		}).source, committedInput);
		if (committedInput.operation === "send" || committedInput.operation === "request") {
			return this.send(callerAgentId, toolCallId, committedInput);
		}
		if (committedInput.operation === "answer") {
			return this.#answer(caller, toolCallId, committedInput);
		}
		if (committedInput.operation === "cancel") {
			return this.#cancel(caller, toolCallId, committedInput);
		}
		return committedInput.operation === "poll"
			? this.#poll(caller, committedInput)
			: this.#retry(caller, committedInput);
	}

	async #answer(
		caller: AgentRecord,
		toolCallId: string,
		input: AnswerInput,
	): Promise<AgentAnswerReceipt> {
		// Recipient Delivery establishes the duty independently of its rejected source.
		// This branch never turns those local instructions into retryable authorship.
		if (!this.#requestEvidence.findRequest(input.requestId)) {
			return caller.host.lane.run(() => this.#answerWithoutRequestSource(caller, toolCallId, input));
		}
		const admitted = await caller.host.lane.run(async () => {
			const repeatedAnswer = this.#requestEvidence.findAnswerBySource(
				caller,
				toolCallId,
			);
			const request = repeatedAnswer
				? this.#requestEvidence.requireRequest(repeatedAnswer.requestId)
				: this.#requestEvidence.requireRequest(input.requestId);
			if (request.targetAgentId !== caller.identity.agentId) {
				throw new Error("wrong_participant: Answer Request belongs to another responder");
			}
			const requester = this.#requireAgent(request.fromAgentId);
			const delivery = inspectMessageDelivery({
				recipientAgentId: caller.identity.agentId,
				transcript: caller.transcript.inspect(),
				message: request,
			});
			const canonical = inspectCanonicalMessage({
				message: request,
				authorTranscript: requester.transcript.inspect(),
				deliveryEvidence: delivery.deliveryEvidence,
			});
			if (canonical.state !== "canonical" || !delivery.deliveryEvidence) {
				throw new Error(
					`invalid_input: Request ${request.messageId} has not been delivered to its responder`,
				);
			}
			const existing = this.#requestEvidence.findAnswer(request);
			if (existing) {
				if (!repeatedAnswer) throw new Error(`invalid_state: Request ${request.messageId} is already answered`);
				return { disposition: "existing", request, requester, answer: existing } as const;
			}
			const cancellation = this.#requestEvidence.findCancellation(request);
			if (
				cancellation &&
				inspectMessageDelivery({
					recipientAgentId: caller.identity.agentId,
					transcript: caller.transcript.inspect(),
					message: cancellation,
				}).deliveryEvidence
			) {
				throw new Error(`invalid_state: Request ${request.messageId} was cancelled`);
			}
			const answer = resolveCommittedAnswer({
				responderAgentId: caller.identity.agentId,
				transcript: caller.transcript.inspect(),
				toolCallId,
				providedInput: input,
				request,
			});
			this.#requestEvidence.rememberAdmittedAnswer(answer);
			return { disposition: "admitted", request, requester, answer } as const;
		});
		if (admitted.disposition === "existing") {
			return {
				messageId: admitted.answer.messageId,
				requestMessageId: admitted.request.messageId,
				requestTitle: admitted.request.title,
				answerId: admitted.answer.messageId,
				disposition: "already_answered",
			};
		}
		const { answer, request, requester } = admitted;
		if (this.#isShuttingDown()) {
			return {
				messageId: answer.messageId,
				requestMessageId: request.messageId,
				requestTitle: request.title,
				messageStatus: "not_sent",
				reason: "host_shutting_down",
			};
		}
		if (
			this.#boundaryHooks.beforeDeliveryAdmission?.({
				recipientAgentId: requester.identity.agentId,
				messageId: answer.messageId,
				operation: "answer",
			}) === "confirmed_failure"
		) {
			return {
				messageId: answer.messageId,
				requestMessageId: request.messageId,
				requestTitle: request.title,
				messageStatus: "not_sent",
				reason: "target_unavailable",
			};
		}
		const admission = await this.#deliveryScheduler.admit(
			requester,
			this.#scheduleGeneralMessage(requester, answer),
		);
		if (admission === "pending") {
			return this.#boundaryHooks.afterDeliveryAdmission?.({
				recipientAgentId: requester.identity.agentId,
				messageId: answer.messageId,
				operation: "answer",
			}) === "confirmation_lost"
				? {
					messageId: answer.messageId,
					requestMessageId: request.messageId,
					requestTitle: request.title,
					messageStatus: "unknown",
					reason: "confirmation_lost",
				}
				: {
					messageId: answer.messageId,
					requestMessageId: request.messageId,
					requestTitle: request.title,
					messageStatus: "sent",
				};
		}
		return {
			messageId: answer.messageId,
			requestMessageId: request.messageId,
			requestTitle: request.title,
			messageStatus: "not_sent",
			reason: admission,
		};
	}

	#answerWithoutRequestSource(caller: AgentRecord, toolCallId: string, input: AnswerInput): AgentAnswerReceipt {
		const delivered = this.#requestEvidence.findDeliveredRequest(caller, input.requestId);
		if (!delivered) throw new Error(`unknown_identity: delivered Request ${input.requestId}`);
		const repeatedAnswer = this.#requestEvidence.findAnswerBySource(caller, toolCallId);
		const existing = this.#requestEvidence.findLocalAnswer(caller, input.requestId);
		if (existing) {
			if (!repeatedAnswer) throw new Error(`invalid_state: Request ${input.requestId} is already answered`);
			return { disposition: "already_answered", messageId: existing.messageId, answerId: existing.messageId,
				requestMessageId: input.requestId, requestTitle: delivered.title };
		}
		if (this.#requestEvidence.isLocalCancellationDelivered(caller, input.requestId)) {
			throw new Error(`invalid_state: Request ${input.requestId} was cancelled`);
		}
		const answer = resolveCommittedAnswer({
			responderAgentId: caller.identity.agentId, transcript: caller.transcript.inspect(), toolCallId, providedInput: input,
			request: { messageId: delivered.requestMessageId, fromAgentId: delivered.fromAgentId,
				workflowId: caller.identity.workflowId, title: delivered.title },
		});
		this.#requestEvidence.rememberAdmittedAnswer(answer);
		return { disposition: "committed", delivery: "omitted", reason: "request_source_unavailable",
			messageId: answer.messageId, requestMessageId: input.requestId, requestTitle: delivered.title };
	}

	async #cancel(
		caller: AgentRecord,
		toolCallId: string,
		input: CancellationInput,
	): Promise<RequestCancellationReceipt> {
		const admitted = await caller.host.lane.run(() => {
			const request = this.#requestEvidence.requireRequest(input.requestMessageId);
			if (request.fromAgentId !== caller.identity.agentId) {
				throw new Error(
					`wrong_participant: Agent ${caller.identity.agentId} is not the requester for Request ${request.messageId}`,
				);
			}
			const responder = this.#requireAgent(request.targetAgentId);
			const answer = this.#requestEvidence.findAnswer(request);
			if (answer) {
				const delivery = inspectAnswerDelivery({
					requesterAgentId: caller.identity.agentId,
					transcript: caller.transcript.inspect(),
					answer,
				});
				if (delivery.deliveryEvidence) {
					return { disposition: "answered", request, responder, answer } as const;
				}
			}
			const existing = this.#requestEvidence.findCancellation(request);
			if (existing) {
				return { disposition: "existing", request, responder, cancellation: existing } as const;
			}
			const cancellation = resolveCommittedCancellation({
				requesterAgentId: caller.identity.agentId,
				transcript: caller.transcript.inspect(),
				toolCallId,
				providedInput: input,
				request,
			});
			this.#requestEvidence.rememberAdmittedCancellation(cancellation);
			caller.host.removeRetentionReason("awaiting_answer", request.messageId);
			return { disposition: "admitted", request, responder, cancellation } as const;
		});
		if (admitted.disposition === "answered") {
			return {
				disposition: "already_answered",
				answerMessageId: admitted.answer.messageId,
			};
		}
		if (admitted.disposition === "existing") {
			return {
				disposition: "already_cancelled",
				cancellationMessageId: admitted.cancellation.messageId,
			};
		}
		const { cancellation, responder } = admitted;
		const identity = {
			messageId: cancellation.messageId,
			targetAgentId: cancellation.targetAgentId,
		};
		if (this.#isShuttingDown()) {
			return {
				...identity,
				messageStatus: "not_sent",
				reason: "host_shutting_down",
			};
		}
		if (
			this.#boundaryHooks.beforeDeliveryAdmission?.({
				recipientAgentId: responder.identity.agentId,
				messageId: cancellation.messageId,
				operation: "cancel",
			}) === "confirmed_failure"
		) {
			return {
				...identity,
				messageStatus: "not_sent",
				reason: "target_unavailable",
			};
		}
		const admission = await this.#deliveryScheduler.admit(
			responder,
			this.#scheduleGeneralMessage(responder, cancellation),
		);
		if (admission === "pending") {
			return this.#boundaryHooks.afterDeliveryAdmission?.({
				recipientAgentId: responder.identity.agentId,
				messageId: cancellation.messageId,
				operation: "cancel",
			}) === "confirmation_lost"
				? { ...identity, messageStatus: "unknown", reason: "confirmation_lost" }
				: { ...identity, messageStatus: "sent" };
		}
		return { ...identity, messageStatus: "not_sent", reason: admission };
	}

	async #retry(
		caller: AgentRecord,
		input: MessageRetryInput,
	): Promise<AgentMessageRetryReceipt | AgentRequestRetryReceipt> {
		const authorTranscript = caller.transcript.inspect();
		const message = this.#requestEvidence.requireCallerAuthoredMessage(
			caller,
			input.messageId,
		);
		if (message.kind === "request") {
			return this.#retryRequest(caller, message);
		}
		if (message.kind === "answer" && !this.#requestEvidence.findRequest(message.requestId)) {
			throw new Error(`unknown_identity: Request ${message.requestId}`);
		}
		const recipient = this.#requireAgent(message.targetAgentId);
		const retryIdentity = {
			messageId: message.messageId,
			targetAgentId: message.targetAgentId,
		};
		return recipient.host.lane.run(async () => {
			if (
				this.#boundaryHooks.beforeRecipientInspection?.({
					recipientAgentId: recipient.identity.agentId,
					messageId: message.messageId,
					operation: "retry",
				}) === "inspection_incomplete"
			) {
				return {
					...retryIdentity,
					messageStatus: "not_sent",
					reason: "evidence_unavailable",
				};
			}
			const delivery = inspectMessageDelivery({
				recipientAgentId: recipient.identity.agentId,
				transcript: recipient.transcript.inspect(),
				message,
			});
			const canonical = inspectCanonicalMessage({
				message,
				authorTranscript,
				deliveryEvidence: delivery.deliveryEvidence,
			});
			if (canonical.state === "not_created") {
				throw new Error(`unknown_identity: Message ${input.messageId} was not created`);
			}
			if (canonical.state === "indeterminate") {
				return {
					...retryIdentity,
					messageStatus: "unknown",
					reason: "inspection_incomplete",
				};
			}
			if (delivery.deliveryEvidence) {
				return {
					disposition: "delivered",
					messageId: message.messageId,
					deliveryEvidence: delivery.deliveryEvidence,
				};
			}
			if (this.#isShuttingDown()) {
				return {
					...retryIdentity,
					messageStatus: "not_sent",
					reason: "host_shutting_down",
				};
			}
			const admission = await this.#deliveryScheduler.admitInLane(
				recipient,
				this.#scheduleGeneralMessage(recipient, message),
			);
			if (admission === "pending") {
				return this.#boundaryHooks.afterDeliveryAdmission?.({
					recipientAgentId: recipient.identity.agentId,
					messageId: message.messageId,
					operation: "retry",
				}) === "confirmation_lost"
					? {
						...retryIdentity,
						messageStatus: "unknown",
						reason: "confirmation_lost",
					}
					: { ...retryIdentity, messageStatus: "sent" };
			}
			return {
				...retryIdentity,
				messageStatus: "not_sent",
				reason: admission,
			};
		});
	}

	async #retryRequest(
		requester: AgentRecord,
		request: Extract<Message, { kind: "request" }>,
	): Promise<AgentRequestRetryReceipt> {
		const responder = this.#requireAgent(request.targetAgentId);
		return responder.host.lane.run(() => this.#retryRequestInLane(requester, responder, request));
	}

	async #retryRequestInLane(
		requester: AgentRecord,
		responder: AgentRecord,
		request: Extract<Message, { kind: "request" }>,
	): Promise<AgentRequestRetryReceipt> {
		const retryIdentity = {
			requestMessageId: request.messageId,
			targetAgentId: request.targetAgentId,
		};
		if (this.#requestEvidence.findCancellation(request)) {
			return {
				...retryIdentity,
				messageStatus: "not_sent",
				reason: "policy_rejected",
			};
		}
		if (
			this.#boundaryHooks.beforeRecipientInspection?.({
				recipientAgentId: responder.identity.agentId,
				messageId: request.messageId,
				operation: "retry",
			}) === "inspection_incomplete"
		) {
			return {
				...retryIdentity,
				messageStatus: "not_sent",
				reason: "evidence_unavailable",
			};
		}
		const requestDelivery = inspectMessageDelivery({
			recipientAgentId: responder.identity.agentId,
			transcript: responder.transcript.inspect(),
			message: request,
		});
		const canonicalRequest = inspectCanonicalMessage({
			message: request,
			authorTranscript: requester.transcript.inspect(),
			deliveryEvidence: requestDelivery.deliveryEvidence,
		});
		if (canonicalRequest.state === "not_created") {
			throw new Error(`unknown_identity: Request ${request.messageId} was not created`);
		}
		if (canonicalRequest.state === "indeterminate") {
			return {
				...retryIdentity,
				messageStatus: "unknown",
				reason: "inspection_incomplete",
			};
		}
		const answer = this.#requestEvidence.findAnswer(request);
		if (answer) {
			const answerDelivery = inspectAnswerDelivery({
				requesterAgentId: requester.identity.agentId,
				transcript: requester.transcript.inspect(),
				answer,
			});
			const canonicalAnswer = inspectCanonicalMessage({
				message: answer,
				authorTranscript: responder.transcript.inspect(),
				deliveryEvidence: answerDelivery.deliveryEvidence,
			});
			if (canonicalAnswer.state !== "canonical") {
				return {
					...retryIdentity,
					messageStatus: "unknown",
					reason: "inspection_incomplete",
				};
			}
			if (
				!answerDelivery.deliveryEvidence &&
				this.#deliveryScheduler.hasDispatchReservation(
					requester.identity.agentId,
					answer.messageId,
				)
			) {
				return {
					...retryIdentity,
					messageStatus: "unknown",
					reason: "inspection_incomplete",
				};
			}
			return answerDelivery.deliveryEvidence
				? {
					disposition: "answer_already_delivered",
					requestMessageId: request.messageId,
					requestTitle: request.title,
					answerId: answer.messageId,
					deliveryEvidence: answerDelivery.deliveryEvidence,
				}
				: {
					disposition: "answer_delivered",
					requestMessageId: request.messageId,
					requestTitle: request.title,
					answerId: answer.messageId,
					fromAgentId: answer.fromAgentId,
					answer: answer.answer,
					answerSource: answer.source,
				};
		}
		if (requestDelivery.deliveryEvidence) {
			return {
				disposition: "request_delivered",
				requestMessageId: request.messageId,
				deliveryEvidence: requestDelivery.deliveryEvidence,
			};
		}
		if (this.#isShuttingDown()) {
			return {
				...retryIdentity,
				messageStatus: "not_sent",
				reason: "host_shutting_down",
			};
		}
		const admission = await this.#deliveryScheduler.admitInLane(
			responder,
			this.#scheduleGeneralMessage(responder, request),
		);
		if (admission === "pending") {
			return this.#boundaryHooks.afterDeliveryAdmission?.({
				recipientAgentId: responder.identity.agentId,
				messageId: request.messageId,
				operation: "retry",
			}) === "confirmation_lost"
				? {
					...retryIdentity,
					messageStatus: "unknown",
					reason: "confirmation_lost",
				}
				: {
					...retryIdentity,
					messageStatus: "sent",
				};
		}
		return {
			...retryIdentity,
			messageStatus: "not_sent",
			reason: admission,
		};
	}

	async #poll(
		caller: AgentRecord,
		input: MessagePollInput,
	): Promise<AgentMessagePollReceipt> {
		const authorTranscript = caller.transcript.inspect();
		const message = this.#requestEvidence.requireCallerAuthoredMessage(
			caller,
			input.messageId,
		);
		const recipient = this.#requireAgent(message.targetAgentId);
		return recipient.host.lane.run(() => {
			if (
				this.#boundaryHooks.beforeRecipientInspection?.({
					recipientAgentId: recipient.identity.agentId,
					messageId: message.messageId,
					operation: "poll",
				}) === "inspection_incomplete"
			) {
				return {
					disposition: "indeterminate",
					messageId: message.messageId,
					reason: "inspection_incomplete",
				};
			}
			const delivery = inspectMessageDelivery({
				recipientAgentId: recipient.identity.agentId,
				transcript: recipient.transcript.inspect(),
				message,
			});
			const canonical = inspectCanonicalMessage({
				message,
				authorTranscript,
				deliveryEvidence: delivery.deliveryEvidence,
			});
			if (canonical.state === "not_created") {
				throw new Error(`unknown_identity: Message ${input.messageId} was not created`);
			}
			if (canonical.state === "indeterminate") {
				return {
					disposition: "indeterminate",
					messageId: message.messageId,
					reason: "inspection_incomplete",
				};
			}
			return delivery.deliveryEvidence
				? {
					disposition: "delivered",
					messageId: message.messageId,
					deliveryEvidence: delivery.deliveryEvidence,
				}
				: {
					disposition: "not_observed",
					messageId: message.messageId,
					inspectedThrough: delivery.inspectedThrough,
				};
		});
	}

	#scheduleGeneralMessage(
		recipient: AgentRecord,
		message: Message,
	): ScheduledMessageDelivery {
		return {
			messageId: message.messageId,
			deliveryMode: message.deliveryMode,
			deliveryItem: createMessageDeliveryItem(message),
			...(message.kind === "request" && message.contextPreparation !== undefined
				? { contextPreparation: message.contextPreparation }
				: {}),
			inspectProof: () => message.kind === "answer"
				? inspectAnswerDelivery({
					requesterAgentId: recipient.identity.agentId,
					transcript: recipient.transcript.inspect(),
					answer: message,
				}).deliveryEvidence
				: inspectMessageDelivery({
					recipientAgentId: recipient.identity.agentId,
					transcript: recipient.transcript.inspect(),
					message,
				}).deliveryEvidence,
			isSuppressed: message.kind === "request"
				? () => this.#isCancellationDelivered(message.messageId, recipient)
				: undefined,
			preemptsAgentWait: message.kind === "request_cancellation" ||
				(message.kind === "message" && message.deliveryMode === "steer"),
			isIncomingRequest: message.kind === "request"
				? true
				: undefined,
			isDeliveryBlocked: message.kind === "request" || message.deliveryMode === "background"
				? () => this.#deliveryScheduler.isDeliveryBlocked(recipient, message.deliveryMode) ||
					(message.deliveryMode === "background" && this.answerObligationRequestIds(recipient).length > 0)
				: undefined,
			suppressesAfterCommitMessageId: message.kind === "request_cancellation"
				? message.requestId
				: undefined,
			afterCommit: message.kind === "request"
				? () => {
					if (
						this.#requestEvidence.findAnswer(message) === undefined &&
						!this.#isCancellationDelivered(message.messageId, recipient)
					) {
						recipient.host.addRetentionReason("answer_owed", message.messageId);
					}
				}
					: message.kind === "answer"
					? () => {
						recipient.host.removeRetentionReason(
							"awaiting_answer",
							message.requestId,
						);
						if (!this.#requestEvidence.isAnswerAwaitingAuthorResult(message)) {
							const responder = this.#requireAgent(message.fromAgentId);
							void responder.host.lane.run(async () => {
								responder.host.removeRetentionReason(
									"answer_owed",
									message.requestId,
								);
								await this.#deliveryScheduler.requestQueueAdvancedInLane(responder);
							});
						}
					}
					: message.kind === "request_cancellation"
						? () => {
							recipient.host.removeRetentionReason(
								"answer_owed",
								message.requestId,
							);
							const requester = this.#requireAgent(message.fromAgentId);
							void requester.host.lane.run(() =>
								requester.host.removeRetentionReason(
									"awaiting_answer",
									message.requestId,
								)
							);
						}
						: undefined,
		};
	}

	#reconcileCommittedAnswerAuthorship(responder: AgentRecord): boolean {
		const unresolved = new Set(this.answerObligationRequestIds(responder));
		let changed = false;
		for (const requestId of responder.host.requestRelationshipIds("answer_owed")) {
			if (unresolved.has(requestId)) continue;
			responder.host.removeRetentionReason("answer_owed", requestId);
			changed = true;
		}
		return changed;
	}

	#reconcileAnswerDeliveries(requester: AgentRecord): void {
		for (const requestId of requester.host.requestRelationshipIds("awaiting_answer")) {
			const request = this.#requestEvidence.findRequest(requestId);
			if (!request) {
				requester.host.removeRetentionReason("awaiting_answer", requestId);
				continue;
			}
			const answer = this.#requestEvidence.findAnswer(request);
			if (!answer) continue;
			if (answer.targetAgentId !== requester.identity.agentId) continue;
			const delivery = inspectAnswerDelivery({
				requesterAgentId: requester.identity.agentId,
				transcript: requester.transcript.inspect(),
				answer,
			});
			if (delivery.deliveryEvidence) {
				requester.host.removeRetentionReason(
					"awaiting_answer",
					answer.requestId,
				);
			}
		}
	}

	#isCancellationDelivered(requestId: string, responder: AgentRecord): boolean {
		const request = this.#requestEvidence.findRequest(requestId);
		if (!request) return this.#requestEvidence.isLocalCancellationDelivered(responder, requestId);
		const cancellation = this.#requestEvidence.findCancellation(request);
		return cancellation !== undefined &&
			inspectMessageDelivery({
				recipientAgentId: responder.identity.agentId,
				transcript: responder.transcript.inspect(),
				message: cancellation,
			}).deliveryEvidence !== undefined;
	}

	#requireAgent(agentId: string): AgentRecord {
		return requireAgentRecord(
			this.#agents,
			this.#quarantinedAgentIds,
			agentId,
		);
	}
}
