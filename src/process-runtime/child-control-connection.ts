import { AsyncLocalStorage } from "node:async_hooks";

import type {
	AgentSessionRuntime,
	SessionBeforeCompactEvent,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

import type { FramedAgentControlChannel } from "../control/agent-control-channel.ts";
import type { agentControlProtocol } from "../control/agent-control-protocol.ts";
import {
	NativeSessionDriver,
	type NativeSessionEvent,
	type TurnAdmission,
} from "../pi-integration/native-session-driver.ts";
import {
	createParticipantInputHandler,
	deferPrimaryInputQueued,
	type ParticipantLifecycleHandlers,
} from "../pi-integration/participant-lifecycle.ts";
import { bindSessionStartup } from "../pi-integration/session-startup.ts";
import type { AgentWaitProgress } from "../protocol/agent-wait.ts";
import { createModelVisibleModeratorObligationReminder } from "../protocol/moderator-obligation-reminder.ts";
import type { ChildRuntimeInputHandler } from "./child-runtime-input-registry.ts";
import {
	inspectChildRuntimeSnapshot,
	type ChildLaunchFacts,
	type ChildRuntimeSnapshot,
} from "./child-runtime-snapshot.ts";
import { ChildTurnCompactionGateway } from "./child-turn-compaction-gateway.ts";
import { ModeratorReminderAdmission } from "./moderator-reminder-admission.ts";
import { NativeInputSubmissionIdentity } from "./native-input-submission-identity.ts";
import { RemoteAgentActivitySource } from "./remote-agent-activity-source.ts";
import type {
	ChildAgentWaitProgressSource,
	ChildNativeInputIdentity,
	ChildParticipantControlRequester,
} from "./remote-participant-control.ts";
import { TerminalInputSubmissionAcknowledger } from "./terminal-input-submission-acknowledger.ts";

export type ChildControlChannel = FramedAgentControlChannel<typeof agentControlProtocol>;
type OwnerRequest = Parameters<Parameters<ChildControlChannel["onRequest"]>[0]>[0];
type OwnerEvent = Parameters<Parameters<ChildControlChannel["onEvent"]>[0]>[0];

/** The only host actions a binding needs from the bridge extension shell. */
export type ChildHostShellPort = Readonly<{
	/** Gateway warnings and failed forwarded input. */
	notify(message: string, type: "warning" | "error"): void;
	setPresentationVisible(visible: boolean): void;
	shutDown(): void;
}>;

export type ChildRuntimeBindingInput = Readonly<{
	runtime: AgentSessionRuntime;
	launchFacts: ChildLaunchFacts;
	participantLifecycle: ParticipantLifecycleHandlers;
	hostShell: ChildHostShellPort;
}>;

/** One Pi extension generation bound to the child's surviving Control connection. */
export type ChildRuntimeBinding = Readonly<{
	activity: RemoteAgentActivitySource;
	runtimeSnapshot(): Promise<ChildRuntimeSnapshot>;
	publishRuntimeSnapshot(): Promise<void>;
	/** Raw physical-terminal bytes; submissions advance native input identity. */
	terminalInput(data: string | Buffer): void;
	/** An interactive input entered Pi's input hooks. */
	beginInteractiveInput(): void;
	/** The interactive loop accepted one submission, before any input preflight. */
	inputStarted(): Promise<number>;
	/** The interactive loop finished the prompt it started. */
	inputCompleted(sequence: number): Promise<void>;
	/** Pi started a model cycle; only native input owns its transport identity here. */
	nativeTurnStarted(): void;
	/** The last input hook: participant input, forwarded-input handoff, and turn reservation. */
	handleInput: ChildRuntimeInputHandler;
	beforeCompaction(event: SessionBeforeCompactEvent): ReturnType<ChildTurnCompactionGateway["beforeCompaction"]>;
	dispose(): void;
}>;

type DeliveryExecution = {
	admitted: boolean;
	finished: boolean;
	started: boolean;
	signal?: AbortSignal;
	checkpoint?: () => void;
};

/** State that survives Pi /reload: one per child process and Control channel. */
type ConnectionState = {
	readonly channel: ChildControlChannel;
	readonly waitProgressHandlers: Map<string, (progress: AgentWaitProgress) => void>;
	readonly nativeInputIdentity: NativeInputSubmissionIdentity;
	readonly inputSubmissionAcknowledger: TerminalInputSubmissionAcknowledger;
	current: Generation | undefined;
	currentRunId: string | undefined;
	latestRunId: string | undefined;
	nativeRunSequence: number;
	queueIntentionTail: Promise<void>;
	shutdownStarted: boolean;
	closed: boolean;
};

type Generation = Readonly<{
	binding: ChildRuntimeBinding;
	handleOwnerRequest(request: OwnerRequest): Promise<unknown>;
	handleOwnerEvent(event: OwnerEvent): void;
	handleControlClose(): void;
}>;

/**
 * The child's side of one authenticated Control channel. It keeps run identity,
 * queue-intention order, and native input identity across Pi reloads, and routes
 * Owner requests to the generation bound now. It never reads process globals.
 */
export class ChildControlConnection {
	readonly #state: ConnectionState;
	readonly request: ChildParticipantControlRequester;
	readonly waitProgress: ChildAgentWaitProgressSource;
	readonly nativeInputIdentity: ChildNativeInputIdentity;

	constructor(channel: ChildControlChannel) {
		const nativeInputIdentity = new NativeInputSubmissionIdentity();
		const state: ConnectionState = {
			channel,
			waitProgressHandlers: new Map(),
			nativeInputIdentity,
			inputSubmissionAcknowledger: new TerminalInputSubmissionAcknowledger((sequence) => {
				nativeInputIdentity.observeTerminalSubmission(sequence);
				// Pi resolves getUserInput() in this same input turn. Delay only to
				// the check phase so runtime.input.started enters ordered Control first.
				setImmediate(() => void channel.sendEvent(
					"runtime.input.submissionAcknowledged",
					{ sequence },
				).catch(() => undefined));
			}),
			current: undefined,
			currentRunId: undefined,
			latestRunId: undefined,
			nativeRunSequence: 0,
			queueIntentionTail: Promise.resolve(),
			shutdownStarted: false,
			closed: false,
		};
		this.#state = state;
		this.request = (method, payload, signal) => channel.request(method, payload, signal);
		this.waitProgress = {
			subscribe(toolCallId, handler) {
				if (state.waitProgressHandlers.has(toolCallId)) {
					throw new Error(`child_runtime_wait_progress_exists: ${toolCallId}`);
				}
				state.waitProgressHandlers.set(toolCallId, handler);
				return () => state.waitProgressHandlers.delete(toolCallId);
			},
		};
		this.nativeInputIdentity = {
			current: () => nativeInputIdentity.current(),
			take: () => nativeInputIdentity.take(),
		};
		channel.onRequest((request) => requireGeneration(state).handleOwnerRequest(request));
		channel.onEvent((event) => requireGeneration(state).handleOwnerEvent(event));
		channel.onClose(() => {
			state.closed = true;
			state.current?.handleControlClose();
		});
	}

	get channel(): ChildControlChannel {
		return this.#state.channel;
	}

	get currentBinding(): ChildRuntimeBinding | undefined {
		return this.#state.current?.binding;
	}

	/** Bind a fresh generation; the previous one is disposed first. */
	bind(input: ChildRuntimeBindingInput): ChildRuntimeBinding {
		const state = this.#state;
		state.current?.binding.dispose();
		const generation = bindGeneration(state, input);
		state.current = generation;
		state.shutdownStarted = false;
		// Control closed while no generation was bound: this one can never serve.
		if (state.closed) generation.handleControlClose();
		return generation.binding;
	}

	/**
	 * Pi is shutting this generation down. Reload keeps the connection for the next
	 * generation; requests arriving in between are rejected, never served by a
	 * disposed binding.
	 */
	async endGeneration(reason: SessionShutdownEvent["reason"]): Promise<void> {
		const state = this.#state;
		if (reason !== "reload") state.shutdownStarted = true;
		const generation = state.current;
		generation?.binding.dispose();
		if (state.current === generation) state.current = undefined;
		await state.channel.sendEvent("session.shutdown", { reason }).catch(() => undefined);
	}

	reportFault(code: string, error: unknown): Promise<void> {
		return reportFault(this.#state.channel, code, error);
	}
}

function requireGeneration(state: ConnectionState): Generation {
	if (!state.current) {
		throw new Error("child_runtime_control_unavailable: Runtime binding is unavailable");
	}
	return state.current;
}

function bindGeneration(
	state: ConnectionState,
	{ runtime, launchFacts, participantLifecycle, hostShell }: ChildRuntimeBindingInput,
): Generation {
	let generation!: Generation;
	let disposed = false;
	const session = runtime.session;
	const activity = new RemoteAgentActivitySource(launchFacts.agentId);
	const deliveryExecution = new AsyncLocalStorage<DeliveryExecution>();
	const pendingDeliveries = new Map<string, () => Promise<void>>();
	let nativeInputHandoff: { submissionSequence: number; transfer: () => void; transferred: boolean } | undefined;
	const inputSubmissionAcknowledgment = state.inputSubmissionAcknowledger.bind();
	const startupAdmission = bindSessionStartup(session);
	const removeNativeStartupObserver = startupAdmission.observeNativeStartup({
		beforeStart() {
			const execution = deliveryExecution.getStore();
			if (!execution?.admitted || execution.finished || execution.started) return;
			execution.checkpoint!();
		},
		started(signal) {
			const execution = deliveryExecution.getStore();
			if (!execution?.admitted || execution.finished || execution.started) return;
			execution.started = true;
			execution.signal = signal;
		},
	});
	const turnCompaction = new ChildTurnCompactionGateway(
		session,
		(message) => hostShell.notify(message, "warning"),
	);
	const driver = new NativeSessionDriver(session);
	const reminderAdmission = new ModeratorReminderAdmission({
		admit: operation => turnCompaction.admit(operation),
		prepare: () => turnCompaction.prepareIdleCustomTurn(),
		isIdle: () => driver.canStartIdleTurn(),
		// Proof is child-local: no Owner reconciliation or host lane is needed. The
		// reservation already holds the gateway admission, so only its generation fences.
		commit: signal => driver.commitIdleCustom(createModelVisibleModeratorObligationReminder(), {
			signal,
			admission: { admit: attempt => attempt(() => turnCompaction.signal.throwIfAborted()) },
		}),
	});
	const removeLifecycleSubscription = driver.subscribe((event) => {
		void reportRuntimeLifecycle(event).catch((error: unknown) =>
			reportFault(state.channel, "runtime_lifecycle_failed", error)
		);
	});
	const runtimeSnapshot = () => inspectChildRuntimeSnapshot(runtime, launchFacts);
	const publishRuntimeSnapshot = async () => {
		await state.channel.sendEvent("runtime.snapshot.changed", await runtimeSnapshot());
	};
	const inputStarted = async () => {
		const sequence = state.nativeInputIdentity.beginInput();
		await state.channel.sendEvent("runtime.input.started", { sequence });
		return sequence;
	};
	const inputCompleted = async (sequence: number) => {
		turnCompaction.completeNativeTurn(sequence);
		if (!state.nativeInputIdentity.complete(sequence)) return;
		await state.channel.sendEvent("runtime.input.completed", { sequence });
	};
	const participantInput = createParticipantInputHandler(
		participantLifecycle,
		async () => {
			const sequence = state.nativeInputIdentity.current();
			if (sequence === undefined) {
				throw new Error("child_runtime_active_input_identity_unavailable");
			}
			await inputCompleted(sequence);
		},
		{ deferPrimaryInputQueued: false },
	);
	const handleInput: ChildRuntimeInputHandler = async (input, context) => {
		const submissionSequence = state.nativeInputIdentity.current();
		const transfer = input.source === "interactive" && input.streamingBehavior !== "followUp"
			? startupAdmission.captureInputHandoff()
			: undefined;
		const handoff = transfer && submissionSequence !== undefined
			? { submissionSequence, transfer, transferred: false }
			: undefined;
		if (handoff) nativeInputHandoff = handoff;
		let result: Awaited<ReturnType<typeof participantInput>>;
		try {
			result = await participantInput(input, context);
		} catch (error) {
			if (!handoff?.transferred) throw error;
			hostShell.notify(`Agent input failed: ${errorMessage(error)}`, "error");
			result = { action: "handled" };
		} finally {
			if (nativeInputHandoff === handoff) nativeInputHandoff = undefined;
		}
		// The forwarded prompt owns this exact input now. Even a failed remote
		// acknowledgment must not let the original input enter preparation again.
		if (handoff?.transferred) return { action: "handled" };
		if (
			input.source === "extension" &&
			result.action === "continue" &&
			turnCompaction.shouldDiscardActiveDeliveryInput()
		) return { action: "handled" };
		const sequence = state.nativeInputIdentity.current();
		if (
			input.source === "interactive" &&
			result.action === "continue" &&
			input.streamingBehavior === undefined
		) {
			if (sequence === undefined) {
				throw new Error("child_runtime_active_input_identity_unavailable");
			}
			await turnCompaction.reserveNativeTurn(sequence);
		}
		// Pi queues a direct streaming steer inside the current model cycle. It
		// produces no successor agent_start to consume this submission identity.
		if (
			input.source === "interactive" &&
			input.streamingBehavior === "steer" &&
			sequence !== undefined
		) {
			await inputCompleted(sequence);
		}
		if (
			input.source === "interactive" &&
			input.streamingBehavior === "steer" &&
			result.action === "continue"
		) deferPrimaryInputQueued(participantLifecycle, context);
		return result;
	};

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		reminderAdmission.cancel();
		turnCompaction.dispose();
		removeNativeStartupObserver();
		driver.dispose();
		deliveryExecution.disable();
		inputSubmissionAcknowledgment.dispose();
		removeLifecycleSubscription();
	};

	async function reportRuntimeLifecycle(event: NativeSessionEvent): Promise<void> {
		if (state.current !== generation) return;
		if (event.type === "compaction_changed") {
			await state.channel.sendEvent(event.compacting ? "runtime.compaction.started" : "runtime.compaction.completed", {});
			return;
		}
		if (event.type === "run_started") {
			activity.setScopeFailed(false);
			// Only actual Pi execution owns transport cycle identity; Delivery admission does not.
			state.currentRunId ??= nativeRunId(++state.nativeRunSequence);
			state.latestRunId = state.currentRunId;
			await state.channel.sendEvent("agent.start", {
				runId: state.currentRunId,
				queuedInputCount: driver.queuedInputCount(),
			});
			return;
		}
		if (event.type === "run_ended") {
			if (!state.currentRunId) return;
			const { type: _type, ...runEnd } = event;
			activity.setScopeFailed(runEnd.outcome === "error");
			// The driver already retained queued input of a terminal error, before this
			// listener's first transport await could let Pi consume it.
			await state.channel.sendEvent("agent.end", {
				runId: state.currentRunId,
				...runEnd,
				queuedInputCount: driver.queuedInputCount(),
			});
			return;
		}
		if (event.type !== "run_settled" || !state.currentRunId) return;
		// Pi awaits extension settlement hooks before notifying session listeners.
		// A hook can already have started a successor; the old edge cannot settle it.
		if (session.isStreaming) return;
		const runId = state.currentRunId;
		await state.channel.sendEvent("agent.settled", {
			runId,
			queuedInputCount: driver.queuedInputCount(),
		});
		if (state.current !== generation) return;
		if (state.currentRunId === runId) state.currentRunId = undefined;
	}

	/**
	 * The child's turn admission for one Delivery: the Turn Compaction Gateway holds
	 * its gate per attempt, and the native submission keeps queue-intention order and
	 * the per-Delivery execution context that native startup observes.
	 */
	function childTurnAdmission(
		{ deliveryId, delivery }: Readonly<{ deliveryId: string; delivery: Parameters<NativeSessionDriver["deliver"]>[0] }>,
		execution: DeliveryExecution,
		admissionSignal: AbortSignal,
	): TurnAdmission {
		return {
			admit: attempt => turnCompaction.admitDelivery(deliveryId, async checkpoint => {
				admissionSignal.throwIfAborted();
				await turnCompaction.waitForCompaction();
				checkpoint();
				if (session.isIdle && delivery.kind === "custom" && delivery.triggerTurn) {
					await turnCompaction.prepareIdleCustomTurn(delivery.workingZonePreparation);
				}
				checkpoint();
				admissionSignal.throwIfAborted();
				return attempt(checkpoint);
			}),
			submit(submission, fence) {
				const submit = () => {
					fence();
					execution.checkpoint = fence;
					// Active queue admission belongs to this actual native execution.
					execution.signal = session.agent.signal;
					execution.admitted = delivery.kind === "custom" && !session.isIdle;
					const handoff = nativeInputHandoff;
					if (
						delivery.kind === "user" && handoff && !handoff.transferred &&
						delivery.forwardedInput?.submissionSequence === handoff.submissionSequence
					) {
						handoff.transfer();
						handoff.transferred = true;
					}
					return deliveryExecution.run(execution, submission);
				};
				return session.isIdle ? submit() : sequenceQueueIntention(state, submit);
			},
			accepted() {
				execution.admitted = true;
			},
		};
	}

	async function handleOwnerRequest(request: OwnerRequest): Promise<unknown> {
		switch (request.method) {
			case "runtime.snapshot":
				return runtimeSnapshot();
			case "moderatorReminder.prepare": {
				const cancel = () => reminderAdmission.cancel();
				request.signal.addEventListener("abort", cancel, { once: true });
				try {
					if (request.signal.aborted) throw requestCancellationError(request.signal);
					return { prepared: await reminderAdmission.prepare(request.payload.reservationId) };
				} finally { request.signal.removeEventListener("abort", cancel); }
			}
			case "moderatorReminder.finish": {
				const cancel = () => reminderAdmission.cancel();
				request.signal.addEventListener("abort", cancel, { once: true });
				try {
					if (request.signal.aborted) { cancel(); throw requestCancellationError(request.signal); }
					const outcome = await reminderAdmission.finish(request.payload.reservationId, request.payload.commit);
					return { outcome };
				} finally { request.signal.removeEventListener("abort", cancel); }
			}
			case "message.deliver": {
				const { deliveryId, delivery } = request.payload;
				const execution: DeliveryExecution = { admitted: false, finished: false, started: false };
				const admissionCancellation = new AbortController();
				const admissionSignal = AbortSignal.any([
					request.signal, turnCompaction.signal, admissionCancellation.signal,
				]);
				let completionTracked = false;
				const finish = () => {
					execution.finished = true;
					pendingDeliveries.delete(deliveryId);
					turnCompaction.completeDelivery(deliveryId);
				};
				const cancel = async () => {
					admissionCancellation.abort(new Error(`child_turn_admission_cancelled: ${deliveryId}`));
					turnCompaction.cancelDelivery(deliveryId);
					if (!execution.signal) return;
					await sequenceQueueIntention(state, async () => {
						// Native signal identity covers awaited start hooks as well as
						// running work, without clearing or aborting a successor.
						if (session.agent.signal !== execution.signal) return;
						session.clearQueue();
						await session.abort();
					});
				};
				const onAbort = () => {
					void cancel().catch(error => reportFault(state.channel, "delivery_cancellation_failed", error));
				};
				pendingDeliveries.set(deliveryId, cancel);
				request.signal.addEventListener("abort", onAbort, { once: true });
				try {
					const dispatch = driver.deliver(delivery, {
						proveCommit: true,
						signal: admissionSignal,
						admission: childTurnAdmission(request.payload, execution, admissionSignal),
					});
					const { runActive } = await dispatch.preflight;
					// Native queue acceptance is not execution completion. Capture the
					// session's settlement after dispatch, never preparation's earlier cycle.
					const completion = dispatch.completion.then(() => session.waitForIdle());
					completionTracked = true;
					void completion.then(
						() => state.channel.sendEvent("message.dispatch.completed", { deliveryId }),
						error => state.channel.sendEvent("message.dispatch.completed", { deliveryId, error: errorMessage(error) }),
					).catch(error => reportFault(state.channel, "delivery_completion_failed", error)).finally(finish);
					return {
						accepted: true,
						// Only this request's own cancellation abandons the proof: message.cancel
						// after commit must not turn a committed Delivery into a failed request.
						transcriptCommitted: await unlessRequestCancelled(dispatch.transcriptCommit!, request.signal),
						modelCycleStarted: runActive,
						queuedInputCount: driver.queuedInputCount(),
					};
				} finally {
					request.signal.removeEventListener("abort", onAbort);
					if (!completionTracked) finish();
				}
			}
			case "message.cancel": {
				const cancel = pendingDeliveries.get(request.payload.deliveryId);
				if (!cancel) return { accepted: false };
				await cancel();
				return { accepted: true };
			}
			case "queue.clear": {
				const cleared = await turnCompaction.admit(() =>
					sequenceQueueIntention(state, () => {
						requireReportedRun(state, request.payload.runId);
						return driver.clearQueue();
					})
				);
				return { ...cleared, queuedInputCount: driver.queuedInputCount() };
			}
			case "run.interrupt": {
				reminderAdmission.cancel();
				// Queue intentions execute in Owner arrival order, so the interrupt takes the
				// same turn-admission lane the native clear does. Without it an interrupt can
				// overtake a clear that is still waiting for the admission, and its long
				// session.abort() then runs first: the clear would remove the queued steer only
				// after the interrupted turn had already settled.
				const accepted = await turnCompaction.admit(() =>
					sequenceQueueIntention(state, async () => {
						requireReportedRun(state, request.payload.runId);
						// This revalidation runs immediately before mutation. A successor cycle
						// that started while this request waited in the queue is the Agent's
						// active generation too, and interrupting active generation is exactly
						// what the Owner asked for; only a cycle the child never reported is drift.
						if (state.currentRunId === undefined) return false;
						await session.abort();
						return true;
					})
				);
				return { accepted };
			}
			case "presentation.setVisible":
				hostShell.setPresentationVisible(request.payload.visible);
				return {};
			case "runtime.shutdown":
				state.shutdownStarted = true;
				setImmediate(() => hostShell.shutDown());
				return { accepted: true };
			case "runtime.executionBegin":
			case "runtime.humanInput":
			case "runtime.primaryInputQueued":
			case "runtime.humanInputMode":
			case "runtime.guardToolResult":
			case "runtime.rootToolExecutionStart":
			case "runtime.safeBoundary":
			case "runtime.executionEnd":
			case "coordination.observe":
			case "coordination.message":
			case "coordination.wait":
			case "coordination.control":
			case "coordination.spawn":
			case "coordination.templateSnapshot":
			case "coordination.askHuman":
			case "coordination.reportToUser":
			case "presentation.reports.setRead":
			case "coordination.moderatorControl":
			case "presentation.agents.snapshot":
			case "presentation.agents.select":
				throw new Error(`child_runtime_direction_violation: ${request.method}`);
			default:
				return assertUnreachable(request);
		}
	}

	generation = {
		binding: Object.freeze({
			activity,
			runtimeSnapshot,
			publishRuntimeSnapshot,
			terminalInput: (data: string | Buffer) => inputSubmissionAcknowledgment.handleInput(data),
			beginInteractiveInput() {
				state.nativeInputIdentity.beginInput();
			},
			inputStarted,
			inputCompleted,
			nativeTurnStarted() {
				const sequence = state.nativeInputIdentity.current();
				if (sequence === undefined) return;
				if (!state.currentRunId) {
					state.currentRunId = nativeRunId(++state.nativeRunSequence);
					state.latestRunId = state.currentRunId;
				}
				turnCompaction.completeNativeTurn(sequence);
			},
			handleInput,
			beforeCompaction: (event: SessionBeforeCompactEvent) => turnCompaction.beforeCompaction(event),
			dispose,
		}),
		handleOwnerRequest,
		handleOwnerEvent(event) {
			if (event.event === "presentation.agents.changed") {
				activity.update(event.payload);
			} else if (event.event === "coordination.wait.progress") {
				state.waitProgressHandlers.get(event.payload.toolCallId)?.(event.payload.progress);
			}
		},
		handleControlClose() {
			if (state.shutdownStarted) return;
			state.shutdownStarted = true;
			state.waitProgressHandlers.clear();
			dispose();
			if (state.current === generation) state.current = undefined;
			hostShell.shutDown();
		},
	};
	return generation;
}

// Transport execution-cycle identity is child-reported and is separate from durable
// Agent Run sequences. The child owns the format so the assignment sites and the
// request validation below cannot drift apart.
const NATIVE_RUN_ID_PREFIX = "native-run-";

function nativeRunId(sequence: number): string {
	return `${NATIVE_RUN_ID_PREFIX}${sequence}`;
}

function reportedRunSequence(runId: string): number | undefined {
	if (!runId.startsWith(NATIVE_RUN_ID_PREFIX)) return undefined;
	const digits = runId.slice(NATIVE_RUN_ID_PREFIX.length);
	if (!/^[1-9]\d*$/.test(digits)) return undefined;
	const sequence = Number(digits);
	return Number.isSafeInteger(sequence) ? sequence : undefined;
}

/**
 * A run-scoped Owner request must name a cycle this child actually reported, so an
 * Owner whose identity drifted out of this child's history still fails loudly.
 *
 * It must not additionally require that the cycle is still the current or latest
 * one. A Delivery admission the Owner cancels can still commit its own turn while
 * the request waits in the queue, which legitimately advances the cycle between the
 * Owner's dispatch and this mutation boundary. That is ordinary concurrency, not
 * identity drift, and docs/run-supervision.md forbids faulting a successor cycle
 * for it. The check stays immediately before the mutation.
 */
function requireReportedRun(state: ConnectionState, runId: string): void {
	const sequence = reportedRunSequence(runId);
	if (sequence === undefined || sequence > state.nativeRunSequence) {
		throw new Error(
			`stale_run: ${runId} does not name a child Run this Agent reported`,
		);
	}
}

function sequenceQueueIntention<T>(
	state: ConnectionState,
	operation: () => T | Promise<T>,
): Promise<T> {
	const result = state.queueIntentionTail.then(operation);
	state.queueIntentionTail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function unlessRequestCancelled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(requestCancellationError(signal));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(requestCancellationError(signal));
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function reportFault(channel: ChildControlChannel, code: string, error: unknown): Promise<void> {
	await channel.sendEvent("runtime.fault", { code, message: errorMessage(error) })
		.catch(() => undefined);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requestCancellationError(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The Control request was cancelled", "AbortError");
}

function assertUnreachable(value: never): never {
	throw new Error(`child_runtime_method_unavailable: ${String(value)}`);
}
