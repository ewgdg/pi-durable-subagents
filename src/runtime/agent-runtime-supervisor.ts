import type { CommitModeratorReminderIfCurrent, ModeratorReminderOutcome } from "./agent-runtime-host.ts";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import type { TerminalProjection } from "../presentation/terminal-projection.ts";
import type {
	AgentRetentionReason,
	AgentQuotaSuspension,
	QuotaSuspendedNativeInput,
	AgentRunEndCause,
	AgentRunFailure,
	AgentRunHandle,
	AgentRunSettlement,
	AgentRunState,
	AgentRuntimeDelivery,
	AgentRuntimeDeliveryDispatch,
	AgentRuntimeHost,
	AgentRuntimeWorkState,
	EffectiveRuntimeSnapshot,
	RunResumptionHandle,
	ProjectionInputSubmission,
	ResidualRequestRelationships,
	RuntimeInitializationTermination,
	ToolBatchClassification,
	TranscriptCommitConfirmation,
} from "./agent-runtime-host.ts";
export type {
	AgentRetentionReason,
	AgentRunEndCause,
	AgentRunFailure,
	AgentRunHandle,
	AgentRunSettlement,
	AgentRunState,
	RunResumptionHandle,
	ResidualRequestRelationships,
	RunRetentionReason,
} from "./agent-runtime-host.ts";
import type {
	HostedAgentRuntime,
	HostedRuntimeEvent,
} from "./hosted-agent-runtime.ts";
import { InProcessHostedRuntime } from "./in-process-hosted-runtime.ts";
import { SerialLane } from "./serial-lane.ts";

type RequestRelationshipReason = "awaiting_answer" | "answer_owed";
type RuntimeOwnership = "supervisor" | "native-host";

// Pi publishes public compaction completion immediately before its interactive
// mode can transfer accepted input into a successor Run. Give that transfer a
// bounded opportunity to become visible through public Runtime state.
const RUNTIME_ACTIVITY_SETTLEMENT_GRACE_MS = 100;

export type StartedAgentRuntime = Readonly<{
	runtime: HostedAgentRuntime;
	ready?: Promise<void>;
}>;

type BoundAgentRuntime = {
	handle: AgentRunHandle;
	runtime: HostedAgentRuntime;
	unsubscribe: () => void;
	admitted: boolean;
	hasInput: boolean;
	failed: boolean;
	failure?: AgentRunFailure;
	expectedInterruption: boolean;
	releaseDeferredUntilInputSettles: boolean;
	releaseDeferredUntilActivitySettles: boolean;
	releaseActivitySettlementTimer?: ReturnType<typeof setTimeout>;
};

type HeldNativeQueue = {
	handle: AgentRunHandle;
	steering: string[];
	followUp: string[];
};

type CapturedRunEnd = Readonly<{
	event: Extract<HostedRuntimeEvent, { type: "agent_end" }>;
	expectedInterruption: boolean;
}>;

type StartSession = () => Promise<StartedAgentRuntime>;
type SettledHandler = (handle: AgentRunHandle, settlement: AgentRunSettlement) => void;
type EndedHandler = (handle: AgentRunHandle, cause: AgentRunEndCause, failure?: AgentRunFailure) => void;
type StateChangeHandler = () => void;
type ProjectionInputSettledHandler = () => void;
type RunFenceHandler = (handle: AgentRunHandle) => void;
type RunStartInitializer = () => ResidualRequestRelationships | Promise<ResidualRequestRelationships>;
type RunStartedHandler = (
	handle: AgentRunHandle,
) => void | Promise<void>;
type RunEndingHandler = (
	handle: AgentRunHandle,
	cause: Exclude<AgentRunEndCause, "clean">,
) => void | Promise<void>;

export class AgentRuntimeSupervisor implements AgentRuntimeHost {
	readonly lane = new SerialLane();
	readonly #agentId: string;
	readonly #startSession: StartSession | undefined;
	readonly #runtimeOwnership: RuntimeOwnership;
	readonly #retentionReasons = new Set<AgentRetentionReason>();
	readonly #requestRelationships = new Map<
		RequestRelationshipReason,
		Set<string>
	>();
	readonly #trackedOperations = new Set<Promise<void>>();
	readonly #inputSubmissionProjections = new WeakMap<
		ProjectionInputSubmission,
		NonNullable<HostedAgentRuntime["projection"]>
	>();
	#runtime: BoundAgentRuntime | undefined;
	#starting = false;
	#startingHandle: AgentRunHandle | undefined;
	#passivePreparation = false;
	#startingCancellationRequested = false;
	#pendingInitializationTermination: RuntimeInitializationTermination | undefined;
	#runStartsClosed = false;
	#ending = false;
	#interrupting = false;
	#runSequence = 0;
	#holdSequence = 0;
	readonly #settledHandlers = new Set<SettledHandler>();
	readonly #endedHandlers = new Set<EndedHandler>();
	readonly #stateChangeHandlers = new Set<StateChangeHandler>();
	#projectionInputSettledHandler: ProjectionInputSettledHandler | undefined;
	#runFenceHandler: RunFenceHandler | undefined;
	#runStartInitializer: RunStartInitializer | undefined;
	#runStartedHandler: RunStartedHandler | undefined;
	#runEndingHandler: RunEndingHandler | undefined;
	#inputRequired: { handle: AgentRunHandle; requestId: string } | undefined;
	#agentWait: { handle: AgentRunHandle; toolCallId: string } | undefined;
	#interruptionHold: RunResumptionHandle | undefined;
	#quotaSuspension: AgentQuotaSuspension | undefined;
	#quotaHold: RunResumptionHandle | undefined;
	#restoredQuotaRun: AgentRunHandle | undefined;
	#preparingQuotaResumption = false;
	#quotaSuspensionHandler: ((suspension: AgentQuotaSuspension | undefined, handle: AgentRunHandle, nativeInput?: QuotaSuspendedNativeInput) => void) | undefined;
	#quotaQueueCapture: Promise<void> | undefined;
	#isolatedResumption:
		| { handle: AgentRunHandle; hold: RunResumptionHandle; committed: boolean; pendingEnd?: CapturedRunEnd; settledBeforeCommit: boolean }
		| undefined;
	#heldNativeQueue: HeldNativeQueue | undefined;

	private constructor(options: {
		agentId: string;
		startSession?: StartSession;
		initialRuntime?: HostedAgentRuntime;
		initialRetentionReasons?: readonly AgentRetentionReason[];
		runtimeOwnership?: RuntimeOwnership;
	}) {
		this.#agentId = options.agentId;
		this.#startSession = options.startSession;
		this.#runtimeOwnership = options.runtimeOwnership ?? "supervisor";
		for (const reason of options.initialRetentionReasons ?? []) {
			this.#retentionReasons.add(reason);
		}
		if (options.initialRuntime) {
			this.#bindRuntime({ runtime: options.initialRuntime }, true);
		}
	}

	static bindOwner(runtime: AgentSessionRuntime): AgentRuntimeSupervisor {
		return new AgentRuntimeSupervisor({
			agentId: runtime.session.sessionId,
			initialRuntime: InProcessHostedRuntime.fromSession({
				session: runtime.session,
				services: runtime.services,
				projection: undefined,
			}),
			initialRetentionReasons: ["owner_host_binding"],
			runtimeOwnership: "native-host",
		});
	}

	static createChild(options: {
		agentId: string;
		startSession: StartSession;
	}): AgentRuntimeSupervisor {
		return new AgentRuntimeSupervisor(options);
	}

	observe(): AgentRunState {
		const retentionReasons = [
			...[...this.#retentionReasons].map((reason) => ({ reason, count: 1 })),
			...[...this.#requestRelationships].map(([reason, requestIds]) => ({
				reason,
				count: requestIds.size,
			})),
			...(this.#interruptionHold ? [{ reason: "interruption_hold" as const, count: 1 }] : []),
		];
		if (this.#starting && !this.#passivePreparation) {
			return {
				phase: "starting",
				attention: "none",
				retentionReasons,
			};
		}
		const run = this.#runtime;
		if (this.#quotaSuspension) return {
			phase: "live", work: "settled", attention: "none", retentionReasons,
			suspension: this.#quotaSuspension,
		};
		if (!run?.admitted) return { phase: "dormant", retentionReasons: [] };
		return {
			phase: this.#ending ? "ending" : "live",
			work: this.#agentWait?.handle === run.handle
				? "settled"
				: run.runtime.workState() === "active" ? "active" : "settled",
			attention: this.#inputRequired?.handle === run.handle
				? "input_required"
				: this.#agentWait?.handle === run.handle
					? "agent_wait"
					: "none",
			retentionReasons,
		};
	}

	addSettledHandler(handler: SettledHandler): () => void {
		this.#settledHandlers.add(handler);
		return () => this.#settledHandlers.delete(handler);
	}

	addEndedHandler(handler: EndedHandler): () => void {
		this.#endedHandlers.add(handler);
		return () => this.#endedHandlers.delete(handler);
	}

	addStateChangeHandler(handler: StateChangeHandler): () => void {
		this.#stateChangeHandlers.add(handler);
		return () => this.#stateChangeHandlers.delete(handler);
	}

	setProjectionInputSettledHandler(handler: ProjectionInputSettledHandler): void {
		this.#projectionInputSettledHandler = handler;
	}

	setRunFenceHandler(handler: RunFenceHandler): void {
		this.#runFenceHandler = handler;
	}

	setRunStartInitializer(initializer: RunStartInitializer): void {
		this.#runStartInitializer = initializer;
	}

	setRunStartedHandler(handler: RunStartedHandler): void {
		this.#runStartedHandler = handler;
	}

	setRunEndingHandler(handler: RunEndingHandler): void {
		this.#runEndingHandler = handler;
	}

	async initializeCurrentRunRelationships(): Promise<void> {
		if (!this.currentHandle() || this.#starting || this.#ending) {
			throw new Error("invariant_violation: Request relationships require a bound Agent Run");
		}
		const handle = this.currentHandle()!;
		const relationships = await this.#runStartInitializer?.();
		if (!this.isCurrent(handle) || this.#ending || this.#runStartsClosed) return;
		this.#initializeRequestRelationships(relationships);
	}

	currentHandle(): AgentRunHandle | undefined {
		return this.#runtime?.admitted ? this.#runtime.handle : this.#restoredQuotaRun ?? this.#startingHandle;
	}

	currentProjection(): TerminalProjection | undefined {
		return this.#runtime?.runtime.projection;
	}

	captureProjectionInputSubmission(
		sequence: number,
	): ProjectionInputSubmission | undefined {
		const projection = this.#runtime?.runtime.projection;
		if (!projection) return undefined;
		const submission = Object.freeze({ sequence });
		this.#inputSubmissionProjections.set(submission, projection);
		return submission;
	}

	projectionInputSubmissionIsFenced(submission: ProjectionInputSubmission): boolean {
		const projection = this.#inputSubmissionProjections.get(submission);
		return projection?.inputSubmissionIsFenced(submission.sequence) ?? true;
	}

	effectiveRuntimeSnapshot(): EffectiveRuntimeSnapshot | undefined {
		return this.#runtime?.admitted ? this.#runtime.runtime.snapshot() : undefined;
	}

	async synchronizeRuntimeState(): Promise<EffectiveRuntimeSnapshot> {
		const runtime = this.#requireLiveRuntime();
		await runtime.synchronizeState();
		return runtime.snapshot();
	}

	currentWorkState(): AgentRuntimeWorkState {
		if (this.#quotaSuspension) return "settled";
		const run = this.#runtime;
		if (!run?.admitted) return "unavailable";
		return run.runtime.workState();
	}

	currentRunHasInput(): boolean {
		const run = this.#runtime;
		return !!run?.admitted && (run.hasInput || run.runtime.workState() !== "settled" ||
			run.runtime.hasPendingActivity() || run.runtime.queuedInputCount() > 0 ||
			hasInFlightProjectionInput(run));
	}

	classifyToolBatch(toolNames: readonly string[]): ToolBatchClassification {
		return this.#requireLiveRuntime().classifyToolBatch(toolNames);
	}

	exactRunCancellationSignal(handle: AgentRunHandle): AbortSignal {
		const run = this.#runtime;
		if (!run?.admitted || run.handle !== handle) {
			throw new Error("stale_run: cancellation signal does not target the current Agent Run");
		}
		return run.runtime.cancellationSignal();
	}

	deliverInLane(
		delivery: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	): AgentRuntimeDeliveryDispatch {
		if (this.quotaSuspensionBlocksExecution()) {
			throw new Error("quota_suspended: explicit agent_control resume is required");
		}
		const dispatched = this.#requireLiveRuntime().deliver(delivery, confirmation);
		this.#runtime!.hasInput = true;
		this.#trackOperation(dispatched.completion);
		return dispatched;
	}

	async deliverModeratorReminderInLane(commitIfCurrent: CommitModeratorReminderIfCurrent): Promise<ModeratorReminderOutcome> {
		if (this.#quotaSuspension) return "suppressed";
		const operation = this.#requireLiveRuntime().deliverModeratorReminder(commitIfCurrent);
		this.#trackOperation(operation.then(() => undefined));
		return operation;
	}

	async beginShutdown(): Promise<boolean> {
		this.#runStartsClosed = true;
		const projection = this.#runtime?.runtime.projection;
		return projection
			? this.cancelRuntimeInitialization(
				projection,
				new Error("Workflow shutdown during Agent Run initialization"),
			)
			: false;
	}

	async cancelRuntimeInitialization(
		projection: TerminalProjection,
		error: unknown,
	): Promise<boolean> {
		const run = this.#runtime;
		if (!this.#starting || !run || run.runtime.projection !== projection) return false;
		const cancellation = run.runtime.projection.cancelInitialization(error);
		if (!cancellation) return false;
		this.#startingCancellationRequested = true;
		await cancellation;
		return true;
	}

	requestRuntimeInitializationTermination(
		projection: TerminalProjection,
		error: unknown,
	): RuntimeInitializationTermination | undefined {
		const run = this.#runtime;
		if (
			this.#pendingInitializationTermination ||
			!this.#starting ||
			!run ||
			run.runtime.projection !== projection
		) return undefined;
		// Fence the exact projection before cancellation can release its occupied
		// startup lane. Late continuations retain this projection identity even
		// after initialization cleanup disposes it.
		run.runtime.projection.fenceInputSubmissions();
		const cancellation = run.runtime.projection.cancelInitialization(error);
		if (cancellation) this.#startingCancellationRequested = true;
		const request = Object.freeze({
			cancellation: cancellation
				? cancellation.then(() => true)
				: Promise.resolve(false),
		});
		this.#pendingInitializationTermination = request;
		return request;
	}

	completeRuntimeInitializationTerminationInLane(
		request: RuntimeInitializationTermination,
	): boolean {
		if (this.#pendingInitializationTermination !== request) return false;
		this.#pendingInitializationTermination = undefined;
		return true;
	}

	latestStartedRunSequence(): number {
		return this.#runSequence;
	}

	currentRunFailed(): boolean {
		return this.#runtime?.admitted ? this.#runtime.failed : false;
	}

	isCurrent(handle: AgentRunHandle): boolean {
		return this.#restoredQuotaRun === handle ||
			(this.#runtime?.admitted === true && this.#runtime.handle === handle);
	}

	blocksOrdinaryDelivery(): boolean {
		return this.#quotaSuspension !== undefined || this.#interruptionHold !== undefined || this.#isolatedResumption !== undefined;
	}

	isInterrupting(): boolean {
		return this.#interrupting;
	}

	currentInterruptionHold(): RunResumptionHandle | undefined {
		return this.#interruptionHold;
	}

	currentResumptionHold(): RunResumptionHandle | undefined {
		return this.#quotaHold ?? this.#interruptionHold;
	}

	currentQuotaSuspension(): AgentQuotaSuspension | undefined {
		return this.#quotaSuspension;
	}

	quotaSuspensionBlocksExecution(): boolean {
		return this.#isolatedResumption?.pendingEnd !== undefined ||
			(this.#quotaSuspension !== undefined && this.#isolatedResumption?.hold !== this.#quotaHold);
	}

	setQuotaSuspensionHandler(handler: (suspension: AgentQuotaSuspension | undefined, handle: AgentRunHandle, nativeInput?: QuotaSuspendedNativeInput) => void): void {
		this.#quotaSuspensionHandler = handler;
	}

	restoreQuotaSuspension(suspension: AgentQuotaSuspension, runSequence: number, nativeInput?: QuotaSuspendedNativeInput): void {
		if (this.#quotaSuspension) throw new Error("invariant_violation: quota suspension already restored");
		const handle = Object.freeze({ sequence: runSequence });
		this.#runSequence = Math.max(this.#runSequence, runSequence);
		if (this.#runtime) this.#runtime.handle = handle;
		else this.#restoredQuotaRun = handle;
		this.#quotaSuspension = suspension;
		this.#quotaHold = { run: handle, sequence: ++this.#holdSequence };
		if (nativeInput) this.#heldNativeQueue = { handle, steering: [...nativeInput.steering], followUp: [...nativeInput.followUp] };
		this.#notifyStateChanged();
	}

	async prepareQuotaResumptionInLane(): Promise<void> {
		await this.#quotaQueueCapture;
		if (!this.#restoredQuotaRun) {
			if (this.#quotaSuspension) await this.#runtime?.runtime.waitForIdle();
			return;
		}
		this.#preparingQuotaResumption = true;
		try {
			await this.#ensureRuntimeInLane(true, []);
			this.#restoredQuotaRun = undefined;
		} finally {
			this.#preparingQuotaResumption = false;
		}
	}

	isCurrentResumptionHold(hold: RunResumptionHandle): boolean {
		return this.currentResumptionHold() === hold && this.currentHandle() === hold.run;
	}

	beginIsolatedResumptionInLane(hold: RunResumptionHandle): boolean {
		if (!this.isCurrentResumptionHold(hold) || this.#isolatedResumption) return false;
		this.#isolatedResumption = { handle: hold.run, hold, committed: false, settledBeforeCommit: false };
		return true;
	}

	commitIsolatedResumptionInLane(hold: RunResumptionHandle): boolean {
		if (
			!this.isCurrentResumptionHold(hold) ||
			this.#isolatedResumption?.hold !== hold
		) return false;
		const resumption = this.#isolatedResumption;
		const run = this.#runtime!;
		if (this.#quotaHold === hold && resumption.pendingEnd?.event.outcome === "aborted") {
			// An unqualified aborted attempt is not proof of quota recovery or of a
			// human interruption. Keep the original stop, notice and queued input.
			this.#isolatedResumption = undefined;
			this.#notifyStateChanged();
			if (resumption.settledBeforeCommit) this.#notifySettled(run);
			return true;
		}
		if (this.#quotaHold === hold) {
			this.#quotaSuspensionHandler?.(undefined, hold.run);
			this.#quotaSuspension = undefined;
			this.#quotaHold = undefined;
		}
		this.#interruptionHold = undefined;
		resumption.committed = true;
		const pendingEnd = resumption.pendingEnd;
		resumption.pendingEnd = undefined;
		// One outcome path owns both normal event order and events that outran the
		// transcript ACK: success drains held input, quota suspends, other errors fail.
		if (pendingEnd) this.#processRunEnd(run, pendingEnd);
		this.#notifyStateChanged();
		if (resumption.settledBeforeCommit) this.#notifySettled(run);
		return true;
	}

	cancelIsolatedResumptionInLane(hold: RunResumptionHandle): void {
		if (this.#isolatedResumption?.hold === hold) {
			this.#isolatedResumption = undefined;
		}
	}

	finishIsolatedResumptionInLane(handle: AgentRunHandle): void {
		if (this.#isolatedResumption?.handle === handle) this.#isolatedResumption = undefined;
	}

	async interruptCurrentRunInLane(): Promise<
		"held" | "already_held" | "not_running"
	> {
		// Interrupting a quota-suspended Run must not convert it to an editor-resumable Hold.
		if (this.#quotaSuspension) return "already_held";
		const run = this.#runtime;
		if (
			!run?.admitted ||
			this.#starting ||
			this.#ending ||
			run.failed
		) return "not_running";
		if (this.#interruptionHold?.run === run.handle) return "already_held";
		this.#isolatedResumption = undefined;
		run.expectedInterruption = true;
		this.#interrupting = true;
		try {
			const cleared = await run.runtime.clearQueue();
			if (
				cleared.steering.length > 0 ||
				cleared.followUp.length > 0 ||
				this.#heldNativeQueue?.handle === run.handle
			) {
				const existing = this.#heldNativeQueue?.handle === run.handle
					? this.#heldNativeQueue
					: { handle: run.handle, steering: [], followUp: [] };
				existing.steering.push(...cleared.steering);
				existing.followUp.push(...cleared.followUp);
				this.#heldNativeQueue = existing;
			}
			await run.runtime.abort();
			if (
				this.#runtime !== run ||
				this.#ending ||
				run.failed ||
				run.runtime.workState() !== "settled"
			) {
				return "not_running";
			}
			this.#holdSequence += 1;
			this.#interruptionHold = {
				run: run.handle,
				sequence: this.#holdSequence,
			};
			this.#notifyStateChanged();
			return "held";
		} finally {
			this.#interrupting = false;
			run.expectedInterruption = false;
		}
	}

	prepareInterruption(): void {
		const run = this.#runtime;
		if (
			!run?.admitted ||
			this.#starting ||
			this.#ending ||
			run.failed ||
			this.#interruptionHold?.run === run.handle
		) return;
		// Pi 0.84 can emit agent_end(error) from an AbortSignal before the
		// serialized interruption lane reaches interruptCurrentRunInLane(). Arm
		// the exact Run at the human boundary so that event is not Run Failure.
		run.expectedInterruption = true;
	}

	beginInputRequired(handle: AgentRunHandle, requestId: string): void {
		const run = this.#runtime;
		if (
			!run ||
			run.handle !== handle ||
			this.#starting ||
			this.#ending ||
			run.failed
		) {
			throw new Error("stale_run: Human Request does not target the current Agent Run");
		}
		if (requestId.length === 0) {
			throw new Error("invariant_violation: Human Request identity must not be empty");
		}
		if (this.#inputRequired) {
			throw new Error("invalid_input: Agent Run already has an unresolved Human Request");
		}
		this.#inputRequired = { handle, requestId };
		this.#notifyStateChanged();
	}

	acceptsInputRequired(handle: AgentRunHandle, requestId: string): boolean {
		const run = this.#runtime;
		return run?.handle === handle &&
			!this.#starting &&
			!this.#ending &&
			!run.failed &&
			this.#inputRequired?.handle === handle &&
			this.#inputRequired.requestId === requestId;
	}

	failExactRun(handle: AgentRunHandle): void {
		const run = this.#runtime;
		if (!run || run.handle !== handle || this.#ending) return;
		this.#markRunFailed(run, handle);
		this.#trackOperation(run.runtime.abort());
	}

	endInputRequired(handle: AgentRunHandle, requestId: string): void {
		const inputRequired = this.#inputRequired;
		if (!inputRequired) return;
		if (inputRequired.handle !== handle || inputRequired.requestId !== requestId) {
			throw new Error("invariant_violation: Human Request does not match input-required attention");
		}
		this.#inputRequired = undefined;
		this.#notifyStateChanged();
	}

	beginAgentWait(handle: AgentRunHandle, toolCallId: string): void {
		const run = this.#runtime;
		if (
			!run || run.handle !== handle || this.#starting || this.#ending || run.failed
		) throw new Error("stale_run: Agent Wait does not target the current Agent Run");
		if (toolCallId.length === 0) {
			throw new Error("invariant_violation: Agent Wait tool call identity must not be empty");
		}
		if (this.#agentWait) {
			throw new Error("invariant_violation: Agent Run already has an active Agent Wait");
		}
		this.#agentWait = { handle, toolCallId };
		this.#notifyStateChanged();
	}

	endAgentWait(handle: AgentRunHandle, toolCallId: string): void {
		const wait = this.#agentWait;
		if (!wait) return;
		if (wait.handle !== handle || wait.toolCallId !== toolCallId) {
			throw new Error("invariant_violation: Agent Wait does not match waiting attention");
		}
		this.#agentWait = undefined;
		this.#notifyStateChanged();
	}

	#requireLiveRuntime(): HostedAgentRuntime {
		const runtime = this.#runtime?.admitted ? this.#runtime.runtime : undefined;
		if (!runtime) {
			throw new Error(`Agent Run is unavailable: ${this.#agentId}`);
		}
		return runtime;
	}

	async startInLane(
		initialRetentionReasons: readonly AgentRetentionReason[] = [],
	): Promise<AgentRunHandle> {
		await this.#ensureRuntimeInLane(true, initialRetentionReasons);
		const handle = this.currentHandle();
		if (!handle) {
			throw new Error("invariant_violation: admitted Agent Run has no handle");
		}
		return handle;
	}

	async prepareInLane(
		initialRetentionReasons: readonly AgentRetentionReason[] = [],
	): Promise<void> {
		await this.#ensureRuntimeInLane(false, initialRetentionReasons);
	}

	async #ensureRuntimeInLane(
		admitRun: boolean,
		initialRetentionReasons: readonly AgentRetentionReason[],
	): Promise<HostedAgentRuntime> {
		if (this.#quotaSuspension && !this.#preparingQuotaResumption) {
			throw new Error("quota_suspended: explicit agent_control resume is required");
		}
		if (this.#pendingInitializationTermination) {
			// Cancellation releases the occupied startup lane before its termination
			// receipt can run. Earlier lane waiters must not fill that gap with Run B.
			throw new Error("run_termination_pending: Agent Run startup is fenced");
		}
		const existing = this.#runtime;
		if (existing) {
			if (admitRun && !existing.admitted && this.#runStartsClosed) {
				throw new Error("host_shutting_down: Agent Run startup is closed");
			}
			for (const reason of initialRetentionReasons) this.#retentionReasons.add(reason);
			if (!admitRun || existing.admitted) return existing.runtime;
			this.#starting = true;
			this.#passivePreparation = false;
			this.#notifyStateChanged();
			try {
				await this.#admitPreparedRun(existing);
				return existing.runtime;
			} catch (error) {
				const cleanupErrors = [error, ...await this.#discardFailedStart(this.#startingCancellationRequested ? "termination" : "failure", startupFailure(error))];
				this.#clearRunScopedState();
				if (cleanupErrors.length > 1) {
					throw new AggregateError(cleanupErrors, "Agent Run admission cleanup failed");
				}
				throw error;
			} finally {
				this.#starting = false;
				this.#passivePreparation = false;
				this.#notifyStateChanged();
			}
		}
		if (this.#runStartsClosed) {
			throw new Error("host_shutting_down: Agent Run startup is closed");
		}
		if (!this.#startSession) {
			throw new Error(`Agent Run cannot restart: ${this.#agentId}`);
		}
		this.#starting = true;
		this.#passivePreparation = !admitRun;
		// Admission must survive failures before a child Runtime or transcript exists.
		if (admitRun) this.#startingHandle = this.#restoredQuotaRun ?? Object.freeze({ sequence: ++this.#runSequence });
		for (const reason of initialRetentionReasons) this.#retentionReasons.add(reason);
		this.#notifyStateChanged();
		let startedRun: StartedAgentRuntime | undefined;
		let readiness: Promise<void> | undefined;
		let readinessObserved = false;
		try {
			startedRun = await this.#startSession();
			readiness = startedRun.ready ?? Promise.resolve();
			this.#bindRuntime(startedRun);
			if (admitRun) await this.#markPreparedRunAdmitted(this.#runtime!);
			if (this.#runStartsClosed) {
				const shutdownError = new Error(
					"Workflow shutdown during Agent Run initialization",
				);
				const cancellation = requireRuntimeProjection(startedRun.runtime)
					.cancelInitialization(shutdownError);
				if (cancellation) {
					this.#startingCancellationRequested = true;
					const [cancellationResult] = await Promise.allSettled([
						cancellation,
						readiness,
					]);
					readinessObserved = true;
					if (cancellationResult.status === "rejected") {
						throw cancellationResult.reason;
					}
					throw shutdownError;
				}
				// Cancellation can lose to readiness or natural failure. Observe that exact
				// result before choosing termination versus Run Failure classification.
				await readiness;
				readinessObserved = true;
				this.#startingCancellationRequested = true;
				throw shutdownError;
			}
			if (admitRun) {
				await this.#runStartedHandler?.(this.#runtime!.handle);
			}
			await readiness;
			readinessObserved = true;
			return startedRun.runtime;
		} catch (error) {
			const cleanupErrors: unknown[] = [error];
			if (this.#preparingQuotaResumption && this.#quotaHold) {
				// A failed explicit restart attempt did not resume the suspended Run.
				// Dispose only the new Runtime; retain the exact logical Run and stop.
				const run = this.#runtime;
				if (run) {
					run.unsubscribe();
					try {
						await run.runtime.projection?.dispose();
						await run.runtime.dispose();
					} finally {
						this.#runtime = undefined;
					}
				}
				this.#restoredQuotaRun = this.#quotaHold.run;
				throw error;
			}
			if (startedRun && readiness && !readinessObserved) {
				const cancellation = requireRuntimeProjection(startedRun.runtime)
					.cancelInitialization(error);
				const results = await Promise.allSettled([
					...(cancellation ? [cancellation] : []),
					readiness,
				]);
				readinessObserved = true;
				for (const result of results) {
					if (
						result.status === "rejected" &&
						!cleanupErrors.includes(result.reason)
					) cleanupErrors.push(result.reason);
				}
			}
			const endCause = this.#startingCancellationRequested
				? "termination" as const
				: "failure" as const;
			const failure = startupFailure(error);
			if (this.#runtime && this.#startingHandle && !this.#runtime.admitted) {
				this.#runtime.handle = this.#startingHandle;
				this.#runtime.admitted = true;
				this.#startingHandle = undefined;
			}
			if (!this.#runtime && this.#startingHandle) {
				const handle = this.#startingHandle;
				this.#startingHandle = undefined;
				this.#starting = false;
				this.#clearRunScopedState();
				this.#notifyStateChanged();
				this.#notifyEnded(handle, endCause, endCause === "failure" ? failure : undefined);
			}
			cleanupErrors.push(...await this.#discardFailedStart(endCause, failure));
			this.#clearRunScopedState();
			if (cleanupErrors.length > 1) {
				throw new AggregateError(
					cleanupErrors,
					admitRun
						? "Agent Run startup cleanup failed"
						: "Agent runtime preparation cleanup failed",
				);
			}
			throw error;
		} finally {
			this.#startingHandle = undefined;
			if (this.#starting) {
				this.#starting = false;
				this.#passivePreparation = false;
				this.#notifyStateChanged();
			}
		}
	}

	async #admitPreparedRun(run: BoundAgentRuntime): Promise<void> {
		if (run.admitted) return;
		await this.#markPreparedRunAdmitted(run);
		if (this.#runStartsClosed) {
			this.#startingCancellationRequested = true;
			throw new Error("host_shutting_down: Agent Run startup is closed");
		}
		await this.#runStartedHandler?.(run.handle);
	}

	async #markPreparedRunAdmitted(run: BoundAgentRuntime): Promise<void> {
		this.#cancelReleaseAfterActivitySettlement(run);
		run.releaseDeferredUntilActivitySettles = false;
		run.handle = this.#startingHandle ?? Object.freeze({ sequence: ++this.#runSequence });
		this.#startingHandle = undefined;
		run.admitted = true;
		run.hasInput = false;
		// Startup owns an exact Run before readiness. Keep that identity for terminal
		// cleanup, while #starting fences execution/release during yielding catch-up.
		const relationships = await this.#runStartInitializer?.();
		if (this.#runStartsClosed) return;
		if (this.#runtime !== run) throw new Error("invariant_violation: Agent Runtime changed during Run initialization");
		this.#initializeRequestRelationships(relationships);
		this.#notifyStateChanged();
	}

	#initializeRequestRelationships(relationships: ResidualRequestRelationships | undefined): void {
		this.#requestRelationships.clear();
		if (!relationships) return;
		for (const requestId of relationships.awaitingAnswerRequestIds) {
			this.addRetentionReason("awaiting_answer", requestId);
		}
		for (const requestId of relationships.answerOwedRequestIds) {
			this.addRetentionReason("answer_owed", requestId);
		}
	}

	addRetentionReason(reason: AgentRetentionReason, requestId?: string): void {
		if (!this.#runtime && !this.#starting && !this.#restoredQuotaRun) return;
		if (isRequestRelationshipReason(reason)) {
			const exactRequestId = requireRequestRelationshipId(reason, requestId);
			let relationships = this.#requestRelationships.get(reason);
			if (!relationships) {
				relationships = new Set();
				this.#requestRelationships.set(reason, relationships);
			}
			if (relationships.has(exactRequestId)) return;
			relationships.add(exactRequestId);
			this.#notifyStateChanged();
			return;
		}
		if (this.#retentionReasons.has(reason)) return;
		this.#retentionReasons.add(reason);
		this.#notifyStateChanged();
	}

	removeRetentionReason(reason: AgentRetentionReason, requestId?: string): void {
		if (isRequestRelationshipReason(reason)) {
			const exactRequestId = requireRequestRelationshipId(reason, requestId);
			const relationships = this.#requestRelationships.get(reason);
			if (!relationships?.delete(exactRequestId)) return;
			if (relationships?.size === 0) this.#requestRelationships.delete(reason);
			this.#notifyStateChanged();
			return;
		}
		if (this.#retentionReasons.delete(reason)) this.#notifyStateChanged();
	}

	hasRetentionReason(reason: AgentRetentionReason, requestId?: string): boolean {
		if (isRequestRelationshipReason(reason)) {
			const relationships = this.#requestRelationships.get(reason);
			return requestId === undefined
				? (relationships?.size ?? 0) > 0
				: relationships?.has(requestId) ?? false;
		}
		if (reason === "interruption_hold") {
			return this.#interruptionHold !== undefined;
		}
		return this.#retentionReasons.has(reason);
	}

	requestRelationshipIds(
		reason: RequestRelationshipReason,
	): readonly string[] {
		return [...(this.#requestRelationships.get(reason) ?? [])];
	}

	residualRequestCounts(): Readonly<{ incoming: number; outgoing: number }> {
		return {
			incoming: this.#requestRelationships.get("answer_owed")?.size ?? 0,
			outgoing: this.#requestRelationships.get("awaiting_answer")?.size ?? 0,
		};
	}

	isCompacting(): boolean {
		return this.#runtime?.runtime.isCompacting() ?? false;
	}

	queuedInputCount(): number {
		const held = this.#heldNativeQueue;
		return (this.#runtime?.runtime.queuedInputCount() ?? 0) +
			(held ? held.steering.length + held.followUp.length : 0);
	}

	#trackOperation(operation: Promise<unknown>): void {
		const tracked = operation.then(
			() => undefined,
			() => undefined,
		);
		this.#trackedOperations.add(tracked);
		void tracked.finally(() => this.#trackedOperations.delete(tracked));
	}

	async releaseIfEligibleInLane(
		handle: AgentRunHandle,
	): Promise<"released" | "retained" | "stale"> {
		if (this.#quotaSuspension && this.isCurrent(handle)) return "retained";
		const run = this.#runtime;
		if (!run?.admitted || run.handle !== handle) return "stale";
		if (hasInFlightProjectionInput(run)) {
			this.#deferReleaseUntilProjectionInputSettles(run);
			return "retained";
		}
		if (run.runtime.hasPendingActivity()) {
			this.#deferReleaseUntilRuntimeActivitySettles(run);
			return "retained";
		}
		if (run.releaseActivitySettlementTimer) return "retained";
		if (
			this.#starting ||
			this.#ending ||
			run.runtime.workState() !== "settled"
		) return "retained";
		// Selection owns Runtime availability, not the exact Run. Release an
		// otherwise unretained Run without tearing down its attached Pi mode.
		const retainRuntime = this.#runtimeOwnership === "native-host" ||
			this.#retentionReasons.has("interactive_selection");
		const runRetentionReasonCount = this.#retentionReasons.size -
			(this.#retentionReasons.has("interactive_selection") ? 1 : 0);
		if (
			runRetentionReasonCount > 0 ||
			this.#requestRelationships.size > 0 ||
			this.#inputRequired !== undefined ||
			this.#agentWait !== undefined ||
			this.#interruptionHold !== undefined
		) {
			return "retained";
		}
		this.#ending = true;
		this.#notifyStateChanged();
		const cleanupErrors: unknown[] = [];
		const attemptCleanup = async (cleanup: () => unknown | Promise<unknown>) => {
			try {
				await cleanup();
			} catch (error) {
				cleanupErrors.push(error);
			}
		};
		try {
			if (!retainRuntime) {
				await attemptCleanup(() => run.unsubscribe());
				await attemptCleanup(() => run.runtime.projection?.dispose());
				await attemptCleanup(() => run.runtime.dispose());
			}
		} finally {
			if (retainRuntime) {
				run.admitted = false;
				run.failed = false;
				run.expectedInterruption = false;
			} else {
				this.#runtime = undefined;
			}
			this.#clearRunScopedState(retainRuntime);
			this.#ending = false;
			this.#notifyStateChanged();
			this.#notifyEnded(run.handle, "clean");
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Agent Run cleanup failed");
		}
		return "released";
	}

	async releasePreparedRuntimeInLane(): Promise<"released" | "retained" | "stale"> {
		const run = this.#runtime;
		if (!run || run.admitted) return "stale";
		if (hasInFlightProjectionInput(run)) {
			this.#deferReleaseUntilProjectionInputSettles(run);
			return "retained";
		}
		if (run.runtime.hasPendingActivity()) {
			this.#deferReleaseUntilRuntimeActivitySettles(run);
			return "retained";
		}
		if (run.releaseActivitySettlementTimer) return "retained";
		if (
			this.#starting ||
			this.#ending ||
			this.#runtimeOwnership === "native-host" ||
			this.#retentionReasons.size > 0
		) {
			return "retained";
		}
		this.#ending = true;
		this.#notifyStateChanged();
		const cleanupErrors: unknown[] = [];
		const attemptCleanup = async (cleanup: () => unknown | Promise<unknown>) => {
			try {
				await cleanup();
			} catch (error) {
				cleanupErrors.push(error);
			}
		};
		try {
			await attemptCleanup(() => run.unsubscribe());
			await attemptCleanup(() => run.runtime.projection?.dispose());
			await attemptCleanup(() => run.runtime.dispose());
		} finally {
			this.#runtime = undefined;
			this.#clearRunScopedState();
			this.#ending = false;
			this.#notifyStateChanged();
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Prepared Agent runtime cleanup failed");
		}
		return "released";
	}

	async discardAndEndInLane(
		cause: Exclude<AgentRunEndCause, "clean">,
		disposeRuntime?: () => Promise<void>,
	): Promise<void> {
		const run = this.#runtime;
		if (!run) {
			const restored = this.#restoredQuotaRun;
			if (restored && cause !== "shutdown") this.#quotaSuspensionHandler?.(undefined, restored);
			this.#clearRunScopedState();
			if (restored) this.#notifyEnded(restored, cause);
			// The Owner's native Runtime owns process-wide infrastructure beyond its
			// Agent Run. A terminal Run may already be gone when Workflow shutdown
			// reaches this boundary, but that infrastructure still must be disposed.
			if (disposeRuntime) await disposeRuntime();
			return;
		}
		this.#cancelReleaseAfterActivitySettlement(run);
		if (cause === "termination") run.runtime.projection?.fenceInputSubmissions();
		// Pi owns the native Owner Runtime across coordination Runs. A selected child
		// is supervisor-owned but temporarily retained to preserve its attached view
		// when its exact Run ends in a terminal event that bypasses Run Retention.
		const retainRuntime = disposeRuntime === undefined && (
			this.#runtimeOwnership === "native-host" ||
			(
				(cause === "failure" || cause === "termination") &&
				run.runtime.projection !== undefined &&
				this.#retentionReasons.has("interactive_selection")
			)
		);
		const endedHandle = run.handle;
		// Shutdown preserves the durable stop; only explicit termination/resumption clears it.
		if (this.#quotaSuspension && cause !== "shutdown") this.#quotaSuspensionHandler?.(undefined, endedHandle);
		const failure = cause === "failure" ? run.failure : undefined;
		const cleanupErrors: unknown[] = [];
		const attemptCleanup = async (cleanup: () => unknown | Promise<unknown>) => {
			try {
				await cleanup();
			} catch (error) {
				cleanupErrors.push(error);
			}
		};
		this.#ending = true;
		this.#notifyStateChanged();
		if (run.admitted) this.#runFenceHandler?.(run.handle);
		try {
			if (run.admitted) {
				await attemptCleanup(() =>
					this.#runEndingHandler?.(run.handle, cause)
				);
			}
			if (!retainRuntime) await attemptCleanup(() => run.unsubscribe());
			// A terminal Runtime fault already owns cancellation and queue fencing.
			// Do not turn its dead-Control fallout into duplicate cleanup failures.
			const runtimeAvailable = () => run.runtime.workState() !== "unavailable";
			if (runtimeAvailable()) {
				await attemptCleanup(async () => {
					try {
						await run.runtime.clearQueue();
					} catch (error) {
						if (runtimeAvailable()) throw error;
					}
				});
			}
			if (disposeRuntime) {
				await attemptCleanup(disposeRuntime);
			} else if (runtimeAvailable()) {
				await attemptCleanup(() => run.runtime.abort());
				await attemptCleanup(() => run.runtime.waitForIdle());
			}
			if (!retainRuntime) await attemptCleanup(() => run.runtime.projection?.dispose());
			if (!disposeRuntime && !retainRuntime) {
				await attemptCleanup(() => run.runtime.dispose());
			}
			await attemptCleanup(() => Promise.all([...this.#trackedOperations]).then(
				() => undefined,
			));
		} finally {
			if (retainRuntime) {
				run.admitted = false;
				run.failed = false;
				run.failure = undefined;
				run.expectedInterruption = false;
			} else {
				this.#runtime = undefined;
			}
			this.#clearRunScopedState(retainRuntime);
			this.#ending = false;
			this.#notifyStateChanged();
			if (endedHandle.sequence > 0) this.#notifyEnded(endedHandle, cause, failure);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Agent Run cleanup failed");
		}
	}

	#clearRunScopedState(preserveInteractiveSelection = false): void {
		const interactiveSelectionRetained = preserveInteractiveSelection &&
			this.#retentionReasons.has("interactive_selection");
		const nativeHostBindingRetained = this.#runtimeOwnership === "native-host" &&
			this.#runtime !== undefined &&
			this.#retentionReasons.has("owner_host_binding");
		this.#retentionReasons.clear();
		if (interactiveSelectionRetained) {
			this.#retentionReasons.add("interactive_selection");
		}
		if (nativeHostBindingRetained) {
			this.#retentionReasons.add("owner_host_binding");
		}
		this.#requestRelationships.clear();
		this.#startingCancellationRequested = false;
		this.#passivePreparation = false;
		this.#inputRequired = undefined;
		this.#agentWait = undefined;
		this.#interruptionHold = undefined;
		this.#quotaSuspension = undefined;
		this.#quotaHold = undefined;
		this.#restoredQuotaRun = undefined;
		this.#quotaQueueCapture = undefined;
		this.#isolatedResumption = undefined;
		this.#interrupting = false;
		this.#heldNativeQueue = undefined;
	}

	async #discardFailedStart(
		cause: Extract<AgentRunEndCause, "failure" | "termination">,
		failure?: AgentRunFailure,
	): Promise<unknown[]> {
		const failedStart = this.#runtime;
		if (!failedStart) return [];
		const admitted = failedStart.admitted;
		this.#cancelReleaseAfterActivitySettlement(failedStart);
		const retainRuntime = this.#runtimeOwnership === "native-host";
		const cleanupErrors: unknown[] = [];
		const attemptCleanup = async (cleanup: () => unknown | Promise<unknown>) => {
			try {
				await cleanup();
			} catch (error) {
				cleanupErrors.push(error);
			}
		};
		if (failedStart.admitted) this.#runFenceHandler?.(failedStart.handle);
		try {
			// An initializing projection may already be the human's active view.
			// Publish terminal failure before disposal so its owner closes the invalid
			// attachment before the Runtime disappears.
			if (failedStart.admitted) {
				await attemptCleanup(() =>
					this.#runEndingHandler?.(
						failedStart.handle,
						cause,
					)
				);
			}
			if (!retainRuntime) {
				await attemptCleanup(() => failedStart.unsubscribe());
				await attemptCleanup(() => failedStart.runtime.projection?.dispose());
				await attemptCleanup(() => failedStart.runtime.dispose());
			}
		} finally {
			if (retainRuntime) {
				failedStart.admitted = false;
				failedStart.failed = false;
				failedStart.failure = undefined;
				failedStart.expectedInterruption = false;
			} else {
				this.#runtime = undefined;
			}
			this.#clearRunScopedState();
			this.#starting = false;
			this.#notifyStateChanged();
			if (admitted) this.#notifyEnded(failedStart.handle, cause, cause === "failure" ? failure : undefined);
		}
		return cleanupErrors;
	}

	#markRunFailed(run: BoundAgentRuntime, handle: AgentRunHandle): void {
		if (!run.admitted || run.failed) return;
		run.failed = true;
		this.#runFenceHandler?.(handle);
		this.#notifyStateChanged();
	}

	#bindRuntime(startedRun: StartedAgentRuntime, admitted = false): void {
		const { runtime } = startedRun;
		if (admitted) this.#runSequence += 1;
		const handle = Object.freeze({
			sequence: admitted ? this.#runSequence : 0,
		});
		const run: BoundAgentRuntime = {
			handle,
			runtime,
			unsubscribe: () => undefined,
			admitted,
			// A bound native Run can already own input before this supervisor exists.
			hasInput: admitted,
			failed: false,
			expectedInterruption: false,
			releaseDeferredUntilInputSettles: false,
			releaseDeferredUntilActivitySettles: false,
			releaseActivitySettlementTimer: undefined,
		};
		// Publish ownership before subscription so startup rollback can still dispose
		// the exact hosted Runtime if event binding itself fails.
		this.#runtime = run;
		run.unsubscribe = runtime.subscribe((event) => {
			if (run.admitted && (event.type === "agent_end" || runtime.workState() === "active")) {
				run.hasInput = true;
			}
			if (event.type === "state_changed") {
				this.#notifyStateChanged();
				if (
					run.releaseActivitySettlementTimer &&
					run.runtime.hasPendingActivity()
				) {
					clearTimeout(run.releaseActivitySettlementTimer);
					run.releaseActivitySettlementTimer = undefined;
					run.releaseDeferredUntilActivitySettles = true;
				}
				if (
					run.releaseDeferredUntilActivitySettles &&
					!run.runtime.hasPendingActivity()
				) {
					run.releaseDeferredUntilActivitySettles = false;
					this.#scheduleReleaseAfterActivitySettlement(run);
				}
			}
			if (event.type === "agent_end") {
				const expectedInterruption = run.expectedInterruption;
				run.expectedInterruption = false;
				const resumption = this.#isolatedResumption;
				if (resumption?.handle === run.handle && !resumption.committed && !event.willRetry) {
					resumption.pendingEnd = { event, expectedInterruption };
					this.#notifyStateChanged();
				} else {
					this.#processRunEnd(run, { event, expectedInterruption });
				}
			}
			if (event.type === "agent_settled") {
				run.expectedInterruption = false;
				const resumption = this.#isolatedResumption;
				if (resumption?.handle === run.handle && !resumption.committed) {
					resumption.settledBeforeCommit = true;
				} else {
					this.#notifySettled(run);
				}
			}
		});
		this.#ending = false;
		this.#notifyStateChanged();
	}

	#processRunEnd(run: BoundAgentRuntime, { event, expectedInterruption }: CapturedRunEnd): void {
		if (event.quota && !event.willRetry && !this.#ending && !expectedInterruption && !this.#quotaSuspension) {
			this.#quotaSuspension = { reason: "provider_quota", evidence: event.quota };
			this.#quotaHold = { run: run.handle, sequence: ++this.#holdSequence };
			this.#quotaSuspensionHandler?.(this.#quotaSuspension, run.handle, this.#heldNativeQueue);
			this.#notifyStateChanged();
			this.#quotaQueueCapture = run.runtime.clearQueue().then((queue) => {
				if (this.#runtime !== run || !this.#quotaSuspension) return;
				const previous = this.#heldNativeQueue?.handle === run.handle ? this.#heldNativeQueue : undefined;
				this.#heldNativeQueue = {
					handle: run.handle,
					steering: [...(previous?.steering ?? []), ...queue.steering],
					followUp: [...(previous?.followUp ?? []), ...queue.followUp],
				};
				this.#quotaSuspensionHandler?.(this.#quotaSuspension, run.handle, this.#heldNativeQueue);
			});
			this.#trackOperation(this.#quotaQueueCapture);
		}
		// Pi may report error for a tool rejection racing an explicit interruption;
		// that interruption, not Run Failure, owns the pending Hold transition.
		if (event.outcome === "error" && !this.#quotaSuspension && !event.willRetry &&
			!this.#interrupting && !expectedInterruption) {
			if (!run.failed) run.failure = event.failure;
			this.#markRunFailed(run, run.handle);
		}
		this.#restoreHeldNativeQueueAfterIsolatedTurn(run, run.handle, event);
	}

	#notifySettled(run: BoundAgentRuntime): void {
		for (const handler of this.#settledHandlers) handler(run.handle, run.failed ? "failed" : "settled");
	}

	#notifyStateChanged(): void {
		for (const handler of this.#stateChangeHandlers) handler();
	}

	#notifyEnded(handle: AgentRunHandle, cause: AgentRunEndCause, failure?: AgentRunFailure): void {
		for (const handler of this.#endedHandlers) handler(handle, cause, failure);
	}

	#restoreHeldNativeQueueAfterIsolatedTurn(
		run: BoundAgentRuntime,
		handle: AgentRunHandle,
		event: Extract<HostedRuntimeEvent, { type: "agent_end" }>,
	): void {
		const queue = this.#heldNativeQueue;
		if (
			this.#quotaSuspension ||
			this.#isolatedResumption?.handle !== handle ||
			queue?.handle !== handle
		) return;
		if (event.outcome === "error" || event.outcome === "aborted") return;
		this.#heldNativeQueue = undefined;
		for (const message of queue.steering) {
			this.#trackOperation(run.runtime.deliver({
				kind: "user",
				content: message,
				deliverAs: "steer",
			}).completion);
		}
		for (const message of queue.followUp) {
			this.#trackOperation(run.runtime.deliver({
				kind: "user",
				content: message,
				deliverAs: "followUp",
			}).completion);
		}
	}

	#deferReleaseUntilProjectionInputSettles(run: BoundAgentRuntime): void {
		// agent_settled can request release before the projection loop leaves
		// session.prompt(); retry only after that exact input lifecycle closes.
		if (run.releaseDeferredUntilInputSettles || !run.runtime.projection) return;
		run.releaseDeferredUntilInputSettles = true;
		void run.runtime.projection.whenInputIdle().then(() => {
			if (this.#runtime !== run || !run.releaseDeferredUntilInputSettles) return;
			run.releaseDeferredUntilInputSettles = false;
			this.#projectionInputSettledHandler?.();
		});
	}

	#deferReleaseUntilRuntimeActivitySettles(run: BoundAgentRuntime): void {
		run.releaseDeferredUntilActivitySettles = true;
	}

	#scheduleReleaseAfterActivitySettlement(run: BoundAgentRuntime): void {
		if (run.releaseActivitySettlementTimer) return;
		run.releaseActivitySettlementTimer = setTimeout(() => {
			run.releaseActivitySettlementTimer = undefined;
			if (this.#runtime !== run) return;
			this.#projectionInputSettledHandler?.();
		}, RUNTIME_ACTIVITY_SETTLEMENT_GRACE_MS);
	}

	#cancelReleaseAfterActivitySettlement(run: BoundAgentRuntime): void {
		if (!run.releaseActivitySettlementTimer) return;
		clearTimeout(run.releaseActivitySettlementTimer);
		run.releaseActivitySettlementTimer = undefined;
	}
}

function requireRuntimeProjection(
	runtime: HostedAgentRuntime,
): NonNullable<HostedAgentRuntime["projection"]> {
	if (!runtime.projection) {
		throw new Error("invariant_violation: started Agent Runtime has no projection");
	}
	return runtime.projection;
}

function hasInFlightProjectionInput(run: BoundAgentRuntime): boolean {
	// Pi remains session-idle during async input and prompt preflight. The process
	// projection keeps this true until its child admits the resulting Agent Run.
	return run.runtime.projection?.isProcessingInput() ?? false;
}

function startupFailure(error: unknown): AgentRunFailure {
	return {
		stage: "startup",
		error: error instanceof Error ? error.message : String(error),
		provenance: "agent-runtime-supervisor",
	};
}

function isRequestRelationshipReason(
	reason: AgentRetentionReason,
): reason is RequestRelationshipReason {
	return reason === "awaiting_answer" || reason === "answer_owed";
}

function requireRequestRelationshipId(
	reason: RequestRelationshipReason,
	requestId: string | undefined,
): string {
	if (requestId === undefined || requestId.length === 0) {
		throw new Error(`${reason} requires an exact Request identity`);
	}
	return requestId;
}
