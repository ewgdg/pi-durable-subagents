import {
	EvidenceUnavailableError,
	type AgentRecord,
} from "./agent-record.ts";
import { ProtocolInvariantError } from "../protocol/identities.ts";
import {
	createMessageDelivery,
	type EntryPointer,
	type MessageDeliveryItem,
} from "../protocol/message-delivery.ts";
import type { MessageDeliveryMode } from "../protocol/message.ts";
import type { ContextPreparation } from "../policy/working-zone-preparation.ts";
import type {
	CommitModeratorReminderIfCurrent,
	AgentRunHandle,
	AgentRunSettlement,
	AgentRuntimeDelivery,
	RunResumptionHandle,
	TranscriptCommitConfirmation,
} from "../runtime/agent-runtime-host.ts";
import type { WorkflowPolicyStore } from "../policy/workflow-policy.ts";

import { DeliveryProgress, type DeliveryBlockageReason, type DeliveryProgressStage } from "./delivery-progress.ts";
import { SYSTEM_OPERATION_REVIEW_CLOCK, type OperationReviewClock } from "./operation-review.ts";

type ScheduledDeliveryBase = Readonly<{
	messageId: string;
	deliveryMode: MessageDeliveryMode;
	inspectProof(): EntryPointer | undefined;
	isSuppressed?(): boolean;
	/** Recovery admission may precede final model-visible receipt construction. */
	isReady?(): boolean;
	afterCommit?(): void;
	isIncomingRequest?: boolean;
	preemptsAgentWait?: boolean;
	isDeliveryBlocked?(): boolean;
	suppressesAfterCommitMessageId?: string;
}>;

export type ScheduledMessageDelivery = ScheduledDeliveryBase & Readonly<{
	deliveryItem: MessageDeliveryItem;
	contextPreparation?: ContextPreparation;
}>;

export type ScheduledCustomDelivery = ScheduledDeliveryBase & Readonly<{
	deliveryMode: "deferred";
	commitIfCurrent?: CommitModeratorReminderIfCurrent;
	customMessage: Extract<AgentRuntimeDelivery, { kind: "custom" }>["message"];
}>;

type ScheduledDelivery = ScheduledMessageDelivery | ScheduledCustomDelivery;

export type ScheduleReleaseEvaluation = (
	context: Readonly<{ agentId: string; runSequence: number }>,
	evaluate: () => void,
) => void;

export type SteerFreezeHandler = (
	context: Readonly<{
		recipientAgentId: string;
		messageIds: readonly string[];
		release(): Promise<void>;
	}>,
) => void | "defer";

export type ResumeReservationHandler = (
	context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		release(): Promise<void>;
	}>,
) => void | "defer";

export type ScheduledDeliveryKind =
	| "message"
	| "request"
	| "answer"
	| "request_cancellation"
	| "custom";

export type ScheduleDeliveryDispatch = (
	context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		kind: ScheduledDeliveryKind;
	}>,
	dispatch: () => void,
) => void;

export type MessageDeliveryAdmission =
	| "pending"
	| "target_unavailable"
	| "capacity_exhausted";

export type IncomingRequestWaitPreemptor = (
	record: AgentRecord,
	reserveDelivery: () => boolean,
) => Promise<void>;

export type MessageDeliveryFailure = Readonly<{
	record: AgentRecord;
	delivery: ScheduledMessageDelivery;
	reason: string;
	outcome: "confirmed_not_delivered" | "uncertain";
}>;

type TrackedDeliveryProgress = {
	record: AgentRecord;
	delivery: ScheduledDelivery;
	watcher: DeliveryProgress;
	dispatched: boolean;
	failed: boolean;
	admitted: boolean;
	notified: boolean;
	failure?: { reason: string; outcome: MessageDeliveryFailure["outcome"] };
};

type BlockedDelivery = Readonly<{
	messageId: string;
	recipientAgentId: string;
	reason: DeliveryBlockageReason;
}>;

type ActivePromptDelivery = {
	deliveries: readonly ScheduledDelivery[];
	completion: Promise<void>;
	committedMessageIds: Set<string>;
};

type FrozenSteerBatch = {
	deliveries: readonly ScheduledMessageDelivery[];
	dispatched: boolean;
	completion?: Promise<void>;
};

type ReservedResume = Readonly<{
	delivery: ScheduledMessageDelivery;
	hold: RunResumptionHandle;
}>;

type ActiveResume = ReservedResume & {
	completion: Promise<void>;
};

export class MessageDeliveryScheduler {
	readonly #progress = new Map<string, TrackedDeliveryProgress>();
	readonly #progressClock: OperationReviewClock;
	readonly #progressChanged: () => void;
	readonly #onDeliveryFailure: ((failure: MessageDeliveryFailure) => void | Promise<void>) | undefined;
	readonly #isWaitingForCapacity: (agentId: string) => boolean;
	readonly #pendingByAgent = new Map<string, Map<string, ScheduledDelivery>>();
	readonly #activeModeratorReminderByAgent = new Map<string, { settled: boolean }>();
	readonly #activeDeferredByAgent = new Map<string, ActivePromptDelivery>();
	readonly #activeWaitPreemptionByAgent = new Map<string, ActivePromptDelivery>();
	readonly #frozenSteerByAgent = new Map<string, FrozenSteerBatch>();
	readonly #reservedResumeByAgent = new Map<string, ReservedResume>();
	readonly #activeResumeByAgent = new Map<string, ActiveResume>();
	readonly #deferredResumeByAgent = new Set<string>();
	readonly #parkedRunByAgent = new Map<string, AgentRunHandle>();
	readonly #integratedAgentIds = new Set<string>();
	readonly #scheduleReleaseEvaluationHook: ScheduleReleaseEvaluation | undefined;
	readonly #scheduleDeliveryDispatchHook: ScheduleDeliveryDispatch | undefined;
	readonly #afterSteerFreeze: SteerFreezeHandler | undefined;
	readonly #afterResumeReservation: ResumeReservationHandler | undefined;
	readonly #preemptAgentWait: IncomingRequestWaitPreemptor | undefined;
	readonly #workflowPolicy: WorkflowPolicyStore;

	constructor(options: {
		scheduleReleaseEvaluation?: ScheduleReleaseEvaluation;
		scheduleDeliveryDispatch?: ScheduleDeliveryDispatch;
		afterSteerFreeze?: SteerFreezeHandler;
		afterResumeReservation?: ResumeReservationHandler;
		preemptAgentWait?: IncomingRequestWaitPreemptor;
		workflowPolicy: WorkflowPolicyStore;
		deliveryProgressClock?: OperationReviewClock;
		onDeliveryProgressChanged?(): void;
		onDeliveryFailure?(failure: MessageDeliveryFailure): void | Promise<void>;
		isWaitingForCapacity?(agentId: string): boolean;
	}) {
		this.#onDeliveryFailure = options.onDeliveryFailure;
		this.#progressClock = options.deliveryProgressClock ?? SYSTEM_OPERATION_REVIEW_CLOCK;
		this.#progressChanged = options.onDeliveryProgressChanged ?? (() => undefined);
		this.#isWaitingForCapacity = options.isWaitingForCapacity ?? (() => false);
		this.#scheduleReleaseEvaluationHook = options.scheduleReleaseEvaluation;
		this.#scheduleDeliveryDispatchHook = options.scheduleDeliveryDispatch;
		this.#afterSteerFreeze = options.afterSteerFreeze;
		this.#afterResumeReservation = options.afterResumeReservation;
		this.#preemptAgentWait = options.preemptAgentWait;
		this.#workflowPolicy = options.workflowPolicy;
	}

	isDeliveryBlocked(record: AgentRecord, deliveryMode: MessageDeliveryMode): boolean {
		if (deliveryMode === "steer") return false;
		const run = record.host.observe();
		if (deliveryMode === "background") {
			return run.phase !== "live" || run.attention === "agent_wait" || !this.#isDeliveryBoundary(record);
		}
		// Passive Owner parking is a cooperative boundary even while Pi keeps
		// its native prompt active; the scheduler owns that volatile reservation.
		return run.phase !== "live" ||
			(run.attention !== "agent_wait" && run.work !== "settled" && !this.#isDeliveryBoundary(record));
	}

	blockedDeliveries(): readonly BlockedDelivery[] {
		const blocked: BlockedDelivery[] = [];
		for (const [messageId, item] of this.#progress) {
			const { record, delivery, watcher } = item;
			if (delivery.inspectProof() || delivery.isSuppressed?.()) {
				watcher.dispose();
				this.#progress.delete(messageId);
				continue;
			}
			const reason = watcher.observe(this.#deliveryWaitIsLegitimate(item));
			if (reason) blocked.push({ messageId, recipientAgentId: record.identity.agentId, reason });
		}
		return blocked;
	}

	hasAutonomousProgress(): boolean {
		for (const item of this.#progress.values()) {
			const { record, delivery, watcher } = item;
			if (delivery.inspectProof() || delivery.isSuppressed?.() || item.failed ||
				delivery.isReady?.() === false || record.host.blocksOrdinaryDelivery() ||
				this.#isWaitingForCapacity(record.identity.agentId)) continue;
			const run = record.host.observe();
			if (run.phase === "dormant" || (run.phase === "live" && run.attention === "input_required")) continue;
			if (watcher.observe(this.#deliveryWaitIsLegitimate(item))) continue;
			if (item.dispatched) return true;
			if (run.phase === "live" && run.attention === "agent_wait" &&
				!delivery.isIncomingRequest && !delivery.preemptsAgentWait) continue;
			// Pending work only counts when its existing scheduling can advance;
			// dormant recipients and ineligible deliveries are not recovery.
			const pending = this.#pendingByAgent.get(record.identity.agentId);
			if (pending && this.#eligibleDeliveries(pending).includes(delivery)) return true;
		}
		return false;
	}

	#deliveryWaitIsLegitimate(item: TrackedDeliveryProgress): boolean {
		const { record, delivery } = item;
		const run = record.host.observe();
		if (
			record.host.hasRetentionReason("interactive_selection") ||
			record.host.blocksOrdinaryDelivery() ||
			(run.phase !== "dormant" && run.attention === "input_required") ||
			this.#isWaitingForCapacity(record.identity.agentId)
		) return true;
		// Dispatched work belongs to delivery machinery until proof commits; its
		// prompt Promise must not turn subsequent model duration into a deadline.
		// Unrelated recipient work cannot restore a lost scheduling continuation.
		// Only renewed scheduling progress, proof or suppression clears that failure.
		if (item.dispatched || item.failed) return false;
		if (delivery.isDeliveryBlocked?.()) return true;
		const atDeliveryBoundary = this.#isDeliveryBoundary(record);
		if (run.phase === "live" && run.work === "active" &&
			run.attention === "none" && !atDeliveryBoundary) return true;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending || !this.#eligibleDeliveries(pending).includes(delivery)) return true;
		const canPreemptWait = run.phase === "live" && run.attention === "agent_wait" &&
			(delivery.isIncomingRequest || delivery.preemptsAgentWait);
		return !atDeliveryBoundary && !canPreemptWait;
	}

	recordAdmissionFailure(record: AgentRecord, delivery: ScheduledMessageDelivery, error: unknown): void {
		this.#trackProgress(record, delivery);
		this.#failDeliveryProgress(delivery, error);
	}

	discardUncreatedDeliveryProgress(messageId: string): void {
		this.#progress.get(messageId)?.watcher.dispose();
		this.#progress.delete(messageId);
		this.#progressChanged();
	}

	shutdownProgress(): void {
		for (const { watcher } of this.#progress.values()) watcher.dispose();
		this.#progress.clear();
	}

	#trackProgress(record: AgentRecord, delivery: ScheduledDelivery): void {
		if (this.#progress.has(delivery.messageId)) return;
		this.#progress.set(delivery.messageId, {
			record, delivery, dispatched: false, failed: false, admitted: false, notified: false,
			watcher: new DeliveryProgress(this.#progressClock,
				this.#workflowPolicy.current().deliveryProgressIntervalMs, this.#progressChanged),
		});
		this.#progressChanged();
	}

	#advanceProgress(delivery: ScheduledDelivery, stage: DeliveryProgressStage): void {
		const item = this.#progress.get(delivery.messageId);
		if (!item || item.delivery !== delivery) return;
		item.failed = false;
		if (stage === "dispatched") item.dispatched = true;
		item.watcher.advance(stage);
	}

	#failDeliveryProgress(delivery: ScheduledDelivery, error: unknown): void {
		const item = this.#progress.get(delivery.messageId);
		if (!item || item.delivery !== delivery) return;
		item.failed = true;
		item.watcher.fail(error);
		item.failure ??= {
			reason: error instanceof Error ? error.message : String(error),
			outcome: item.dispatched ? "uncertain" : "confirmed_not_delivered",
		};
		this.#notifyFailure(item);
	}

	#notifyFailure(item: TrackedDeliveryProgress): void {
		if (!item.admitted || item.notified || !item.failure || !("deliveryItem" in item.delivery)) return;
		item.notified = true;
		// Notification startup failure remains visible to operational progress; never
		// recursively notify a notice or retry the original Message.
		void Promise.resolve(this.#onDeliveryFailure?.({ record: item.record, delivery: item.delivery, ...item.failure }))
			.catch(error => {
				if (this.#progress.get(item.delivery.messageId) === item) {
					item.watcher.fail(new Error(`Author notification failed: ${error instanceof Error ? error.message : String(error)}`));
				}
			});
	}

	integrate(record: AgentRecord): void {
		this.#ensureSettlementHandler(record);
		record.host.addEndedHandler((_handle, cause) => {
			for (const [messageId, item] of this.#progress) {
				if (item.record !== record) continue;
				// Run termination does not cancel Requests: without proof, the
				// upstream obligation still depends on this stranded Delivery.
				if (cause === "failure" || cause === "termination") {
					this.#failDeliveryProgress(item.delivery, new Error("Recipient Run ended before Delivery proof"));
				} else if (cause === "shutdown") {
					item.watcher.dispose();
					this.#progress.delete(messageId);
				}
			}
			this.#progressChanged();
		});
	}

	admit(
		record: AgentRecord,
		delivery: ScheduledMessageDelivery,
	): Promise<MessageDeliveryAdmission> {
		return record.host.lane.run(() => this.admitInLane(record, delivery));
	}

	admitCustom(
		record: AgentRecord,
		delivery: ScheduledCustomDelivery,
	): Promise<MessageDeliveryAdmission> {
		return record.host.lane.run(() => this.admitCustomInLane(record, delivery));
	}

	admitCustomInLane(
		record: AgentRecord,
		delivery: ScheduledCustomDelivery,
	): Promise<MessageDeliveryAdmission> {
		return this.#admitInLane(record, delivery);
	}

	admitInLane(
		record: AgentRecord,
		delivery: ScheduledMessageDelivery,
	): Promise<MessageDeliveryAdmission> {
		return this.#admitInLane(record, delivery);
	}

	async #admitInLane(
		record: AgentRecord,
		delivery: ScheduledDelivery,
	): Promise<MessageDeliveryAdmission> {
		this.#ensureSettlementHandler(record);
		let pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) {
			pending = new Map();
			this.#pendingByAgent.set(record.identity.agentId, pending);
		}
		if (this.hasScheduling(record.identity.agentId, delivery.messageId)) {
			// Coalesce identity while rechecking progress. An earlier admission may
			// have stopped before dispatch; existing reservations still prevent repeats.
			await this.#drainInLane(record);
			return "pending";
		}
		const policy = this.#workflowPolicy.current();
		if (
			"deliveryItem" in delivery &&
			this.#countPendingIdentities(pending) >=
			policy.maxPendingDeliveriesPerAgent
		) {
			this.recordAdmissionFailure(record, delivery, new Error("Pending Delivery admission capacity exhausted without a queued continuation"));
			return "capacity_exhausted";
		}
		// A fresh scheduling attempt follows loss of all reservations; old completion
		// callbacks must not report against the new attempt for the same identity.
		this.#progress.get(delivery.messageId)?.watcher.dispose();
		this.#progress.delete(delivery.messageId);
		this.#trackProgress(record, delivery);
		if (delivery.isSuppressed?.()) {
			this.#progress.get(delivery.messageId)?.watcher.dispose();
			this.#progress.delete(delivery.messageId);
			if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
			return "pending";
		}
		if (!record.host.currentHandle()) {
			try {
				await record.host.startInLane(["pending_delivery"]);
			} catch (error) {
				this.#failDeliveryProgress(delivery, error);
				if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
				if (
					error instanceof ProtocolInvariantError ||
					error instanceof EvidenceUnavailableError
				) throw error;
				return "target_unavailable";
			}
		}
		pending.set(delivery.messageId, delivery);
		this.#addPendingDeliveryReason(record);
		try {
			await this.#drainInLane(record);
		} catch (error) {
			this.#failDeliveryProgress(delivery, error);
			// A failed pre-dispatch inspection must not leave an abandoned item that
			// later retries merely coalesce with. Dispatched or proven work is owned
			// by normal transcript reconciliation and must retain its reservation.
			if (
				!this.hasDispatchReservation(record.identity.agentId, delivery.messageId) &&
				!delivery.inspectProof()
			) {
				pending.delete(delivery.messageId);
				if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
				this.#removePendingDeliveryReason(record);
			}
			throw error;
		}
		const progress = this.#progress.get(delivery.messageId);
		if (progress) {
			progress.admitted = true;
			this.#notifyFailure(progress);
		}
		return "pending";
	}

	async admitResumeInLane(
		record: AgentRecord,
		delivery: ScheduledMessageDelivery,
		hold: RunResumptionHandle,
	): Promise<MessageDeliveryAdmission> {
		this.#ensureSettlementHandler(record);
		const agentId = record.identity.agentId;
		if (
			this.#reservedResumeByAgent.has(agentId) ||
			this.#activeResumeByAgent.has(agentId)
		) return "capacity_exhausted";
		if (!record.host.isCurrentResumptionHold(hold)) return "target_unavailable";
		this.#reservedResumeByAgent.set(agentId, { delivery, hold });
		this.#addPendingDeliveryReason(record);
		const release = () => record.host.lane.run(async () => {
			const current = this.#reservedResumeByAgent.get(agentId);
			if (current?.delivery.messageId !== delivery.messageId) return;
			this.#deferredResumeByAgent.delete(agentId);
			await this.#drainInLane(record);
		});
		if (
			this.#afterResumeReservation?.({
				recipientAgentId: agentId,
				messageId: delivery.messageId,
				release,
			}) === "defer"
		) {
			this.#deferredResumeByAgent.add(agentId);
			return "pending";
		}
		await this.#drainInLane(record);
		return "pending";
	}

	reachSafeBoundary(record: AgentRecord): Promise<void> {
		return record.host.lane.run(() => {
			if (!record.host.currentHandle()) return;
			this.#removeProvenDeliveriesInLane(record);
			if (record.host.blocksOrdinaryDelivery()) return;
			this.#freezeSteerInLane(record);
		});
	}

	requestQueueAdvanced(record: AgentRecord): Promise<void> {
		return record.host.lane.run(() => this.#drainInLane(record));
	}

	requestQueueAdvancedInLane(record: AgentRecord): Promise<void> {
		return this.#drainInLane(record);
	}

	async beginParkingInLane(
		record: AgentRecord,
		handle: AgentRunHandle,
	): Promise<boolean> {
		if (!record.host.isCurrent(handle)) {
			throw new Error("stale_run: Owner parking does not target the current Agent Run");
		}
		this.#parkedRunByAgent.set(record.identity.agentId, handle);
		try {
			if (!this.#completeProvenPromptOwnedDeliveriesInLane(record)) {
				this.endParkingInLane(record, handle);
				return false;
			}
			this.#removeProvenDeliveriesInLane(record);
			await this.#drainInLane(record);
			return true;
		} catch (error) {
			this.endParkingInLane(record, handle);
			throw error;
		}
	}

	endParkingInLane(record: AgentRecord, handle: AgentRunHandle): void {
		if (this.#parkedRunByAgent.get(record.identity.agentId) === handle) {
			this.#parkedRunByAgent.delete(record.identity.agentId);
		}
	}

	hasScheduling(recipientAgentId: string, messageId: string): boolean {
		return this.#reservedResumeByAgent.get(recipientAgentId)?.delivery.messageId === messageId ||
			this.#pendingByAgent.get(recipientAgentId)?.has(messageId) === true ||
			this.hasDispatchReservation(recipientAgentId, messageId);
	}

	hasDispatchReservation(recipientAgentId: string, messageId: string): boolean {
		return this.#activeDeferredByAgent.get(recipientAgentId)?.deliveries.some(delivery => delivery.messageId === messageId) === true ||
			this.#activeWaitPreemptionByAgent.get(recipientAgentId)?.deliveries.some(delivery => delivery.messageId === messageId) === true ||
			this.#frozenSteerByAgent.get(recipientAgentId)?.deliveries.some(
				(delivery) => delivery.messageId === messageId,
			) === true ||
			this.#activeResumeByAgent.get(recipientAgentId)?.delivery.messageId === messageId;
	}

	prepareInterruptionInLane(record: AgentRecord): void {
		this.#frozenSteerByAgent.delete(record.identity.agentId);
	}

	requestRelease(record: AgentRecord): Promise<"released" | "retained" | "stale"> {
		return record.host.lane.run(() => {
			// Spawn reserves delivery retention before admission. Release that reason
			// only when no queued or dispatched scheduling still owns it.
			this.#removePendingDeliveryReason(record);
			const handle = record.host.currentHandle();
			return handle
				? record.host.releaseIfEligibleInLane(handle)
				: record.host.releasePreparedRuntimeInLane();
		});
	}

	discardInLane(record: AgentRecord): void {
		this.#activeModeratorReminderByAgent.delete(record.identity.agentId);
		this.#activeDeferredByAgent.delete(record.identity.agentId);
		this.#activeWaitPreemptionByAgent.delete(record.identity.agentId);
		this.#frozenSteerByAgent.delete(record.identity.agentId);
		this.#reservedResumeByAgent.delete(record.identity.agentId);
		this.#activeResumeByAgent.delete(record.identity.agentId);
		this.#deferredResumeByAgent.delete(record.identity.agentId);
		this.#parkedRunByAgent.delete(record.identity.agentId);
		this.#pendingByAgent.delete(record.identity.agentId);
		record.host.removeRetentionReason("pending_delivery");
	}

	#countPendingIdentities(
		pending: ReadonlyMap<string, ScheduledDelivery>,
	): number {
		let count = 0;
		for (const delivery of pending.values()) {
			if (
				"deliveryItem" in delivery &&
				!delivery.inspectProof() &&
				!delivery.isSuppressed?.()
			) count += 1;
		}
		return count;
	}

	#ensureSettlementHandler(record: AgentRecord): void {
		if (this.#integratedAgentIds.has(record.identity.agentId)) return;
		record.host.addSettledHandler((handle, settlement) => {
			void record.host.lane.run(() => this.#settledInLane(record, handle, settlement));
		});
		this.#integratedAgentIds.add(record.identity.agentId);
	}

	#settledInLane(
		record: AgentRecord,
		handle: AgentRunHandle,
		settlement: AgentRunSettlement,
	): Promise<void> | void {
		if (!record.host.isCurrent(handle)) return;
		this.endParkingInLane(record, handle);
		const agentId = record.identity.agentId;
		const reservations = [
			[this.#activeResumeByAgent, this.#activeResumeByAgent.get(agentId)],
			[this.#frozenSteerByAgent, this.#frozenSteerByAgent.get(agentId)],
			[this.#activeDeferredByAgent, this.#activeDeferredByAgent.get(agentId)],
			[this.#activeWaitPreemptionByAgent, this.#activeWaitPreemptionByAgent.get(agentId)],
		] as const;
		const completions = reservations.flatMap(([, active]) => active?.completion ? [active.completion] : []);
		if (completions.length === 0) return this.#finishSettledInLane(record, handle, settlement);
		// A preparation replacement can settle before the actual Delivery turn.
		// That turn still needs this lane for awaited safe-boundary callbacks.
		void Promise.allSettled(completions).then(() => record.host.lane.run(async () => {
			if (!record.host.isCurrent(handle)) return;
			if (reservations.some(([activeByAgent, active]) => activeByAgent.get(agentId) !== active)) {
				// Cancelled/consumed reservations cannot reconcile a later dispatch.
				// Failure still belongs to this exact Run even if its tracking changed.
				if (settlement === "failed") {
					this.discardInLane(record);
					await record.host.discardAndEndInLane("failure");
				}
				return;
			}
			// Every completion awaited by reconciliation is now terminal.
			await this.#finishSettledInLane(record, handle, settlement);
		}));
	}

	async #finishSettledInLane(
		record: AgentRecord,
		handle: AgentRunHandle,
		settlement: AgentRunSettlement,
	): Promise<void> {
		if (record.host.observe().suspension) {
			// Quota interrupted this delivery turn, not its admitted Messages. Keep
			// unproven work queued rather than translating it into terminal failure.
			this.#removeProvenDeliveriesInLane(record);
			this.#activeDeferredByAgent.delete(record.identity.agentId);
			this.#activeWaitPreemptionByAgent.delete(record.identity.agentId);
			this.#frozenSteerByAgent.delete(record.identity.agentId);
			this.#activeResumeByAgent.delete(record.identity.agentId);
			record.host.finishIsolatedResumptionInLane(handle);
			return;
		}
		const reminder = this.#activeModeratorReminderByAgent.get(record.identity.agentId);
		if (reminder) reminder.settled = true;
		const activeResume = this.#activeResumeByAgent.get(record.identity.agentId);
		if (activeResume) {
			let failed = false;
			try {
				await activeResume.completion;
			} catch {
				failed = true;
			}
			if (!record.host.isCurrent(handle)) return;
			const proof = activeResume.delivery.inspectProof();
			this.#activeResumeByAgent.delete(record.identity.agentId);
			record.host.finishIsolatedResumptionInLane(handle);
			if (failed || !proof) {
				this.discardInLane(record);
				await record.host.discardAndEndInLane("failure");
				return;
			}
		}
		for (const [activeByAgent, active] of [
			[this.#activeDeferredByAgent, this.#activeDeferredByAgent.get(record.identity.agentId)],
			[
				this.#activeWaitPreemptionByAgent,
				this.#activeWaitPreemptionByAgent.get(record.identity.agentId),
			],
		] as const) {
			if (!active) continue;
			let failed = false;
			try {
				await active.completion;
			} catch {
				failed = true;
			}
			if (!record.host.isCurrent(handle)) return;
			activeByAgent.delete(record.identity.agentId);
			for (const delivery of active.deliveries) {
				const proof = delivery.inspectProof();
				this.#pendingByAgent.get(record.identity.agentId)?.delete(delivery.messageId);
				if (proof && !active.committedMessageIds.has(delivery.messageId)) delivery.afterCommit?.();
				if (!proof) failed = true;
			}
			if (failed) {
				this.discardInLane(record);
				await record.host.discardAndEndInLane("failure");
				return;
			}
		}

		this.#removeProvenDeliveriesInLane(record);
		if (settlement === "failed" || this.#hasUnprovenFrozenBatch(record)) {
			this.discardInLane(record);
			await record.host.discardAndEndInLane("failure");
			return;
		}

		record.host.finishIsolatedResumptionInLane(handle);
		await this.#drainInLane(record);
		if (!this.#hasPendingScheduling(record)) {
			this.#removePendingDeliveryReason(record);
			this.#scheduleReleaseEvaluation(record, handle);
		}
	}

	#scheduleReleaseEvaluation(record: AgentRecord, handle: AgentRunHandle): void {
		const evaluate = () => {
			void record.host.lane.run(() => record.host.releaseIfEligibleInLane(handle));
		};
		if (this.#scheduleReleaseEvaluationHook) {
			this.#scheduleReleaseEvaluationHook(
				{ agentId: record.identity.agentId, runSequence: handle.sequence },
				evaluate,
			);
			return;
		}
		evaluate();
	}

	async #drainInLane(record: AgentRecord, bypassDeliveryDispatchHook = false): Promise<void> {
		try {
			await this.#advanceDeliveryInLane(record, bypassDeliveryDispatchHook);
		} catch (error) {
			// Only scheduling still owned by this drain lost its continuation.
			// A different dispatched Message keeps its existing Pi continuation.
			for (const delivery of this.#pendingByAgent.get(record.identity.agentId)?.values() ?? []) {
				if (this.hasDispatchReservation(record.identity.agentId, delivery.messageId)) continue;
				this.#failDeliveryProgress(delivery, error);
				this.#pendingByAgent.get(record.identity.agentId)?.delete(delivery.messageId);
			}
			this.#removePendingDeliveryReason(record);
			throw error;
		}
	}

	async #advanceDeliveryInLane(
		record: AgentRecord,
		bypassDeliveryDispatchHook = false,
	): Promise<void> {
		this.#removeProvenDeliveriesInLane(record);
		if (this.#activeResumeByAgent.has(record.identity.agentId)) return;
		const reservedResume = this.#reservedResumeByAgent.get(record.identity.agentId);
		if (reservedResume) {
			if (this.#deferredResumeByAgent.has(record.identity.agentId)) return;
			if (record.host.isCurrentResumptionHold(reservedResume.hold)) {
				if (record.host.currentWorkState() === "settled") {
					await this.#startResumeInLane(record, reservedResume);
				}
				return;
			}
			this.#reservedResumeByAgent.delete(record.identity.agentId);
			let pending = this.#pendingByAgent.get(record.identity.agentId);
			if (!pending) {
				pending = new Map();
				this.#pendingByAgent.set(record.identity.agentId, pending);
			}
			pending.set(reservedResume.delivery.messageId, reservedResume.delivery);
		}
		if (record.host.blocksOrdinaryDelivery()) return;
		if (this.#activeWaitPreemptionByAgent.has(record.identity.agentId)) return;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending || pending.size === 0) return;
		const eligible = this.#eligibleDeliveries(pending);
		const waitTrigger = eligible.find(
			(delivery) => delivery.deliveryMode === "steer" && (delivery.isIncomingRequest || delivery.preemptsAgentWait),
		) ?? eligible.find((delivery) => delivery.isIncomingRequest || delivery.preemptsAgentWait);
		const run = record.host.observe();
		if ("attention" in run && run.attention === "agent_wait") {
			if (waitTrigger && this.#preemptAgentWait) {
				void this.#preemptAgentWait(record, () =>
					this.#reserveWaitPreemptionInLane(record, waitTrigger)
				);
			}
			// Steer input acquires Wait as one batch; Deferred Requests acquire it
			// singly. Answers remain owned by Wait aggregation and retrieval.
			return;
		}
		if (
			this.#activeModeratorReminderByAgent.has(record.identity.agentId) ||
			this.#activeDeferredByAgent.has(record.identity.agentId) ||
			this.#hasUnprovenFrozenBatch(record)
		) return;
		if (!this.#isDeliveryBoundary(record)) return;
		const steer = this.#eligibleSteerDeliveries(record, eligible);
		const selected = steer.length > 0 ? steer : eligible.slice(0, 1);
		const delivery = selected[0];
		if (!delivery) return;
		if (!bypassDeliveryDispatchHook && this.#scheduleDeliveryDispatchHook) {
			this.#scheduleDeliveryDispatchHook(
				{
					recipientAgentId: record.identity.agentId,
					messageId: delivery.messageId,
					kind: scheduledDeliveryKind(delivery),
				},
				() => {
					void record.host.lane.run(() =>
						this.#continueDeliveryDispatchInLane(record, selected)
					);
				},
			);
			return;
		}
		if (steer.length > 0) {
			this.#freezeSteerInLane(record, steer);
			return;
		}
		if ("commitIfCurrent" in delivery && delivery.commitIfCurrent) {
			this.#dispatchModeratorReminderInLane(record, delivery, delivery.commitIfCurrent);
			return;
		}
		// A parked Owner is settled-equivalent but still natively active. After an
		// Answer, Pi continues from a tool result without first draining followUp;
		// use its steering queue so this Delivery precedes that continuation.
		// Truly settled Runs retain followUp ordering if they become active during admission.
		const parked = this.#parkedRunByAgent.get(record.identity.agentId);
		const deliverAs = parked && record.host.isCurrent(parked) ? "steer" : "followUp";
		const { completion } = this.#dispatchInLane(record, [delivery],
			"customMessage" in delivery
				? {
					kind: "custom",
					message: delivery.customMessage,
					triggerTurn: true,
					deliverAs,
				}
				: createRuntimeMessageDelivery([delivery], deliverAs),
		);
		this.#activeDeferredByAgent.set(record.identity.agentId, {
			deliveries: [delivery],
			completion,
			committedMessageIds: new Set(),
		});
	}

	#dispatchModeratorReminderInLane(
		record: AgentRecord, delivery: ScheduledCustomDelivery, commitIfCurrent: CommitModeratorReminderIfCurrent,
	): void {
		const agentId = record.identity.agentId;
		const active = { settled: false };
		this.#activeModeratorReminderByAgent.set(agentId, active);
		// Preparation/commit must not hold the scheduler lane: the operational
		// reconciliation lane orders episode clearance against the native commit ACK.
		void record.host.deliverModeratorReminderInLane(commitIfCurrent).then(
			outcome => record.host.lane.run(async () => {
				if (this.#activeModeratorReminderByAgent.get(agentId) !== active) return;
				this.#activeModeratorReminderByAgent.delete(agentId);
				if (outcome !== "busy") {
					const removed = this.#pendingByAgent.get(agentId)?.delete(delivery.messageId);
					if (removed && outcome === "committed") delivery.afterCommit?.();
				}
				this.#removeProvenDeliveriesInLane(record);
				this.#removePendingDeliveryReason(record);
				// A settlement can arrive before the busy response; do not lose that edge.
				if (outcome !== "busy" || active.settled) await this.#drainInLane(record);
				else this.#progressChanged();
				const handle = record.host.currentHandle();
				if (handle) this.#scheduleReleaseEvaluation(record, handle);
			}),
			error => record.host.lane.run(async () => {
				if (this.#activeModeratorReminderByAgent.get(agentId) !== active) return;
				this.#activeModeratorReminderByAgent.delete(agentId);
				this.#pendingByAgent.get(agentId)?.delete(delivery.messageId);
				this.#failDeliveryProgress(delivery, error);
				this.#removeProvenDeliveriesInLane(record);
				this.#removePendingDeliveryReason(record);
				// Failed preparation starts no native turn to advance queued deliveries later.
				await this.#drainInLane(record);
				const handle = record.host.currentHandle();
				if (handle) this.#scheduleReleaseEvaluation(record, handle);
			}),
		).catch(error => this.#failDeliveryProgress(delivery, error));
	}

	#dispatchInLane(
		record: AgentRecord,
		deliveries: readonly ScheduledDelivery[],
		input: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	) {
		try {
			// Once handed to a Runtime, an exception alone cannot prove non-Delivery.
			for (const delivery of deliveries) this.#advanceProgress(delivery, "dispatched");
			const handle = record.host.currentHandle();
			const dispatched = record.host.deliverInLane(input, confirmation);
			// The Pi prompt Promise can outlive Delivery proof by an entire model
			// turn. Observe rejection, but let transcript proof end delivery timing.
			void dispatched.completion.catch((error: unknown) => {
				for (const delivery of deliveries) this.#failDeliveryProgress(delivery, error);
				// Rejection before a native turn starts has no settlement event. Fence
				// this exact failed Run before explicit retry can acquire its identity.
				void record.host.lane.run(async () => {
					if (!handle || !record.host.isCurrent(handle)) return;
					const owned = deliveries.filter(delivery =>
						this.#progress.get(delivery.messageId)?.delivery === delivery &&
						this.hasDispatchReservation(record.identity.agentId, delivery.messageId));
					if (owned.length === 0) return;
					try {
						if (!owned.some(delivery => !delivery.inspectProof())) return;
						await this.#finishSettledInLane(record, handle, "failed");
					} catch (error) {
						if (!(error instanceof EvidenceUnavailableError)) throw error;
						// The rejected dispatch is terminal even when its transcript cannot
						// be read. Fence this Run, but leave Delivery truth to restored proof.
						if (!record.host.isCurrent(handle)) return;
						this.discardInLane(record);
						await record.host.discardAndEndInLane("failure");
					}
				}).catch(error => {
					for (const delivery of deliveries) this.#failDeliveryProgress(delivery,
						new Error("Delivery failure cleanup failed: " + (error instanceof Error ? error.message : String(error))));
				});
			});
			return dispatched;
		} catch (error) {
			for (const delivery of deliveries) this.#failDeliveryProgress(delivery, error);
			throw error;
		}
	}

	#completeProvenPromptOwnedDeliveriesInLane(record: AgentRecord): boolean {
		for (const [activeByAgent, active] of [
			[this.#activeDeferredByAgent, this.#activeDeferredByAgent.get(record.identity.agentId)],
			[
				this.#activeWaitPreemptionByAgent,
				this.#activeWaitPreemptionByAgent.get(record.identity.agentId),
			],
		] as const) {
			if (!active) continue;
			if (!active.deliveries.every(delivery => delivery.inspectProof())) return false;
			// An idle Deferred dispatch owns the whole Pi prompt Promise. Its custom
			// message proof commits before the model response, but the Promise cannot
			// resolve until native settlement, which this listener is delaying.
			activeByAgent.delete(record.identity.agentId);
			for (const delivery of active.deliveries) {
				this.#pendingByAgent.get(record.identity.agentId)?.delete(delivery.messageId);
				if (!active.committedMessageIds.has(delivery.messageId)) delivery.afterCommit?.();
			}
		}
		return true;
	}

	#isDeliveryBoundary(record: AgentRecord): boolean {
		const parked = this.#parkedRunByAgent.get(record.identity.agentId);
		return record.host.currentWorkState() === "settled" ||
			(parked !== undefined && record.host.isCurrent(parked));
	}

	#reserveWaitPreemptionInLane(
		record: AgentRecord,
		trigger: ScheduledDelivery,
	): boolean {
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (
			!pending ||
			pending.get(trigger.messageId) !== trigger ||
			!this.#eligibleDeliveries(pending).includes(trigger) ||
			this.#activeWaitPreemptionByAgent.has(record.identity.agentId)
		) return false;
		// Native steering is one-at-a-time: earlier input can start Agent Wait
		// while this input is still queued. Its reservation already owns Delivery.
		if (this.hasDispatchReservation(record.identity.agentId, trigger.messageId)) return true;
		const steer = trigger.deliveryMode === "steer"
			? this.#eligibleSteerDeliveries(record, this.#eligibleDeliveries(pending))
				// Preemption leaves partial Answers available for a fresh aggregate;
				// joining the batch would create requester-side Answer Delivery proof.
				.filter(delivery => delivery.deliveryItem.projection.kind !== "answer")
			: undefined;
		const deliveries = steer ?? [trigger];
		// Cancellation suppression may remove a Request selected before this
		// reservation. At least one preempting input must remain after suppression.
		if (!deliveries.some(delivery => delivery.isIncomingRequest || delivery.preemptsAgentWait)) return false;
		// Freeze once after Wait's complete-Answer check. One native queue item
		// carries the whole batch, so later arrivals cannot join this preemption.
		const { completion } = this.#dispatchInLane(record, deliveries,
			"customMessage" in trigger
				? {
					kind: "custom",
					message: trigger.customMessage,
					triggerTurn: true,
					deliverAs: "steer",
				}
				: createRuntimeMessageDelivery(steer ?? [trigger], "steer"),
		);
		this.#activeWaitPreemptionByAgent.set(record.identity.agentId, {
			deliveries,
			completion,
			committedMessageIds: new Set(),
		});
		return true;
	}

	#continueDeliveryDispatchInLane(
		record: AgentRecord,
		selected: readonly ScheduledDelivery[],
	): Promise<void> {
		this.#removeProvenDeliveriesInLane(record);
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) return this.#drainInLane(record);
		const eligible = this.#eligibleDeliveries(pending);
		const steer = this.#eligibleSteerDeliveries(record, eligible);
		const current = steer.length > 0 ? steer : eligible.slice(0, 1);
		const stillSelected = current.length === selected.length &&
			current.every((delivery, index) => delivery === selected[index]);
		return this.#drainInLane(record, stillSelected);
	}

	async #startResumeInLane(record: AgentRecord, reserved: ReservedResume): Promise<void> {
		if (!record.host.beginIsolatedResumptionInLane(reserved.hold)) return;
		try {
			const delivery = this.#dispatchInLane(record, [reserved.delivery],
				createRuntimeMessageDelivery([reserved.delivery]),
				{ inspectCommit: () => reserved.delivery.inspectProof() !== undefined },
			);
			this.#activeResumeByAgent.set(record.identity.agentId, {
				...reserved,
				completion: delivery.completion,
			});
			const committed = await delivery.transcriptCommit;
			if (!committed) {
				throw new Error("Supervisory Resume Delivery did not commit");
			}
			if (!record.host.commitIsolatedResumptionInLane(reserved.hold)) {
				throw new Error("invariant_violation: committed resume Delivery lost its exact Hold");
			}
			this.#reservedResumeByAgent.delete(record.identity.agentId);
			reserved.delivery.afterCommit?.();
		} catch (error) {
			this.#cancelResumeAttemptInLane(record, reserved);
			throw error;
		}
	}

	#cancelResumeAttemptInLane(record: AgentRecord, reserved: ReservedResume): void {
		record.host.cancelIsolatedResumptionInLane(reserved.hold);
		this.#activeResumeByAgent.delete(record.identity.agentId);
		this.#reservedResumeByAgent.delete(record.identity.agentId);
		this.#deferredResumeByAgent.delete(record.identity.agentId);
		this.#removePendingDeliveryReason(record);
	}

	#freezeSteerInLane(
		record: AgentRecord,
		steer: readonly ScheduledMessageDelivery[] = [],
	): void {
		if (this.#hasUnprovenFrozenBatch(record)) return;
		if (steer.length === 0) {
			const pending = this.#pendingByAgent.get(record.identity.agentId);
			if (!pending) return;
			steer = this.#eligibleSteerDeliveries(record, this.#eligibleDeliveries(pending));
		}
		if (steer.length === 0) return;
		const frozen: FrozenSteerBatch = { deliveries: steer, dispatched: false };
		this.#frozenSteerByAgent.set(record.identity.agentId, frozen);
		for (const delivery of steer) this.#advanceProgress(delivery, "reserved");
		const release = () => record.host.lane.run(() =>
			this.#dispatchFrozenSteerInLane(record, frozen)
		);
		if (
			this.#afterSteerFreeze?.({
				recipientAgentId: record.identity.agentId,
				messageIds: steer.map(({ messageId }) => messageId),
				release,
			}) === "defer"
		) return;
		this.#dispatchFrozenSteerInLane(record, frozen);
	}

	#dispatchFrozenSteerInLane(
		record: AgentRecord,
		frozen: FrozenSteerBatch,
	): void {
		if (record.host.blocksOrdinaryDelivery()) return;
		if (
			this.#frozenSteerByAgent.get(record.identity.agentId) !== frozen ||
			frozen.dispatched
		) return;
		// Retrieval can commit at the freeze boundary. Revalidate before handing the
		// immutable batch to Pi, where an individual queued Delivery cannot be recalled.
		this.#removeProvenDeliveriesInLane(record);
		if (this.#frozenSteerByAgent.get(record.identity.agentId) !== frozen) return;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		const unprovenSteer = frozen.deliveries.filter(
			(delivery) => pending?.get(delivery.messageId) === delivery,
		);
		if (unprovenSteer.length === 0) return;
		frozen.dispatched = true;
		// Idle Steer preparation can settle a replacement before this dispatch
		// finishes, just like Deferred. Keep its completion with the exact batch.
		frozen.completion = this.#dispatchInLane(record, unprovenSteer,
			createRuntimeMessageDelivery(unprovenSteer, "steer"),
		).completion;
	}

	#removeProvenDeliveriesInLane(record: AgentRecord): void {
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) return;
		const active = this.#activeDeferredByAgent.get(record.identity.agentId);
		const preemption = this.#activeWaitPreemptionByAgent.get(
			record.identity.agentId,
		);
		for (const [messageId, delivery] of pending) {
			const proof = delivery.inspectProof();
			const activeDelivery = active?.deliveries.some(delivery => delivery.messageId === messageId);
			const preemptingDelivery = preemption?.deliveries.some(delivery => delivery.messageId === messageId);
			const suppressed =
				!proof && !activeDelivery && !preemptingDelivery && delivery.isSuppressed?.();
			if (!proof && !suppressed) continue;
			pending.delete(messageId);
			if (active && activeDelivery) active.committedMessageIds.add(messageId);
			if (preemption && preemptingDelivery) preemption.committedMessageIds.add(messageId);
			if (proof) delivery.afterCommit?.();
		}
		// A resumed Agent may re-Wait before its original prompt settles. Release
		// the reservation only once every member of this batch has Delivery proof.
		if (preemption && preemption.deliveries.every(delivery => preemption.committedMessageIds.has(delivery.messageId))) {
			this.#activeWaitPreemptionByAgent.delete(record.identity.agentId);
		}
		if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
		const frozen = this.#frozenSteerByAgent.get(record.identity.agentId);
		if (
			frozen &&
			frozen.deliveries.every(({ messageId }) => !pending.has(messageId))
		) this.#frozenSteerByAgent.delete(record.identity.agentId);
		this.#removePendingDeliveryReason(record);
	}

	#eligibleDeliveries(
		pending: ReadonlyMap<string, ScheduledDelivery>,
	): ScheduledDelivery[] {
		const deliveries = [...pending.values()];
		// An admitted recovery continuation owns the next turn until its
		// recipient-relative receipt is ready; no queued input may overtake it.
		if (deliveries.some(delivery => delivery.isReady?.() === false)) return [];
		const foreground = deliveries.filter(delivery => delivery.deliveryMode !== "background");
		const frontDeferredRequest = foreground.find(
			delivery => delivery.isIncomingRequest && delivery.deliveryMode === "deferred",
		);
		const eligible = foreground.filter(delivery =>
			(!delivery.isIncomingRequest || delivery.deliveryMode === "steer" || delivery === frontDeferredRequest) &&
			!delivery.isDeliveryBlocked?.()
		);
		if (eligible.length > 0) return eligible;
		// One shared FIFO for Background Messages and Requests. Delivering a
		// Request establishes its obligation before considering the next item.
		const background = deliveries.find(delivery => delivery.deliveryMode === "background");
		return background && !background.isDeliveryBlocked?.()
			? [background] : [];
	}

	#eligibleSteerDeliveries(
		record: AgentRecord,
		eligible: readonly ScheduledDelivery[],
	): ScheduledMessageDelivery[] {
		const steer = eligible.filter(
			(delivery): delivery is ScheduledMessageDelivery =>
				delivery.deliveryMode === "steer" && "deliveryItem" in delivery &&
				// Wait preemption queues before turn_end, but its Delivery proof may
				// not exist yet. The reservation already owns that dispatch.
				!this.hasDispatchReservation(record.identity.agentId, delivery.messageId),
		);
		const suppressedAfterBatch = new Set(
			steer.flatMap(({ suppressesAfterCommitMessageId }) =>
				suppressesAfterCommitMessageId
					? [suppressesAfterCommitMessageId]
					: []
			),
		);
		// Deliver a Cancellation before its still-waiting Request. Batching both
		// would wake the responder with work that the same batch withdraws.
		return steer.filter(({ messageId }) => !suppressedAfterBatch.has(messageId));
	}

	#hasUnprovenFrozenBatch(record: AgentRecord): boolean {
		const frozen = this.#frozenSteerByAgent.get(record.identity.agentId);
		if (!frozen) return false;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		return frozen.deliveries.some(({ messageId }) => pending?.has(messageId));
	}

	hasProgress(record: AgentRecord): boolean {
		const activeDeferred = this.#activeDeferredByAgent.get(record.identity.agentId);
		// A proven Delivery may still own its native prompt while agent_wait parks it.
		// Keep that reservation for serialization, not as an external progress source.
		if (this.#activeModeratorReminderByAgent.has(record.identity.agentId) ||
			(activeDeferred !== undefined && activeDeferred.deliveries.some(delivery =>
				!activeDeferred.committedMessageIds.has(delivery.messageId))) ||
			this.#activeWaitPreemptionByAgent.has(record.identity.agentId) ||
			this.#reservedResumeByAgent.has(record.identity.agentId) ||
			this.#activeResumeByAgent.has(record.identity.agentId) ||
			this.#hasUnprovenFrozenBatch(record)) return true;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) return false;
		const run = record.host.observe();
		return this.#eligibleDeliveries(pending).some(delivery =>
			this.#isDeliveryBoundary(record) ||
			(run.phase === "live" && run.attention === "agent_wait" && (delivery.isIncomingRequest || delivery.preemptsAgentWait))
		);
	}

	#hasPendingScheduling(record: AgentRecord): boolean {
		return this.#activeModeratorReminderByAgent.has(record.identity.agentId) ||
			this.#activeDeferredByAgent.has(record.identity.agentId) ||
			this.#activeWaitPreemptionByAgent.has(record.identity.agentId) ||
			this.#reservedResumeByAgent.has(record.identity.agentId) ||
			this.#activeResumeByAgent.has(record.identity.agentId) ||
			this.#hasUnprovenFrozenBatch(record) ||
			(this.#pendingByAgent.get(record.identity.agentId)?.size ?? 0) > 0;
	}

	#addPendingDeliveryReason(record: AgentRecord): void {
		record.host.addRetentionReason("pending_delivery");
	}

	#removePendingDeliveryReason(record: AgentRecord): void {
		if (this.#hasPendingScheduling(record)) return;
		record.host.removeRetentionReason("pending_delivery");
	}
}

function createRuntimeMessageDelivery(
	deliveries: readonly ScheduledMessageDelivery[],
	deliverAs?: "steer" | "followUp",
): Extract<AgentRuntimeDelivery, { kind: "custom" }> {
	const preparedRequest = deliveries.find((delivery) =>
		delivery.contextPreparation !== undefined &&
		delivery.deliveryItem.projection.kind === "request"
	);
	return {
		kind: "custom",
		message: createMessageDelivery(deliveries.map(({ deliveryItem }) => deliveryItem)),
		triggerTurn: true,
		...(deliverAs === undefined ? {} : { deliverAs }),
		...(preparedRequest?.contextPreparation !== undefined &&
			preparedRequest.deliveryItem.projection.kind === "request"
			? {
				workingZonePreparation: {
					intent: preparedRequest.contextPreparation,
					prospectiveRequest: preparedRequest.deliveryItem.projection,
				},
			}
			: {}),
	};
}

function scheduledDeliveryKind(delivery: ScheduledDelivery): ScheduledDeliveryKind {
	return "deliveryItem" in delivery
		? delivery.deliveryItem.projection.kind
		: "custom";
}
