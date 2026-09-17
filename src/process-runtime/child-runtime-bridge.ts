import { AsyncLocalStorage } from "node:async_hooks";
import { classifyQuotaEvidence } from "../runtime/quota-evidence.ts";
import { RetainedRuntimeQueue } from "../runtime/retained-runtime-queue.ts";
import { ModeratorReminderAdmission } from "./moderator-reminder-admission.ts";
import { createModelVisibleModeratorObligationReminder } from "../protocol/moderator-obligation-reminder.ts";
import { bindChildInteractiveInputLifecycle } from "./child-runtime-interactive-mode.ts";

import * as hostPi from "@earendil-works/pi-coding-agent";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { FramedAgentControlChannel } from "../control/agent-control-channel.ts";
import {
	agentControlProtocol,
	type RemoteAgentSelectorSnapshot,
} from "../control/agent-control-protocol.ts";
import { connectControlTransport } from "../control/control-platform.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	childLaunchBlockGuidance,
	type ChildProcessBootstrap,
	validateChildProcessBootstrap,
} from "../control/control-protocol-schemas.ts";
import { installInteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import { transcriptFromSessionManager } from "../pi-integration/session-manager-transcript.ts";
import {
	bindSessionStartup,
	isStartupPreparationBusy,
	registerSessionStartup,
	waitForStartupRelease,
	type SessionStartupAdmission,
} from "../pi-integration/session-startup.ts";
import {
	installAgentActivityDock,
	type AgentActivitySnapshot,
	type AgentActivitySource,
} from "../presentation/agent-activity-surface.ts";
import {
	createParticipantInputHandler,
	deferPrimaryInputQueued,
	type ParticipantLifecycleHandlers,
	registerParticipantLifecycle,
} from "../pi-integration/participant-lifecycle.ts";
import { registerParticipantNativeSessionPolicy } from "../pi-integration/participant-native-session-policy.ts";
import {
	participantCoordinationToolNames,
	registerParticipantCoordinationTools,
} from "../tools/participant-coordination-tools.ts";
import { registerMessageDeliveryRenderer } from "../tools/message-delivery-renderer.ts";
import type { AgentRuntimeDelivery } from "../runtime/agent-runtime-host.ts";
import type { AgentWaitProgress } from "../protocol/agent-wait.ts";
import { answerCallTargetAgentId } from "../protocol/request-resolution.ts";
import {
	CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_LOAD_CONTEXT_FILES_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_SYSTEM_PROMPT_MODE_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_SYSTEM_PROMPT_PATH_ENVIRONMENT_VARIABLE,
} from "./child-process-environment.ts";
import { childRuntimeInputs, type ChildRuntimeInputHandler } from "./child-runtime-input-registry.ts";
import { ChildTurnCompactionGateway } from "./child-turn-compaction-gateway.ts";
import { NativeInputSubmissionIdentity } from "./native-input-submission-identity.ts";
import {
	TerminalInputSubmissionAcknowledger,
	type TerminalInputSubmissionAcknowledgmentBinding,
} from "./terminal-input-submission-acknowledger.ts";
import {
	createControlBackedChildParticipantHandlers,
	createControlBackedChildPresentationHandlers,
	type ChildParticipantControlRequester,
} from "./remote-participant-control.ts";
import { registerRemoteAgentsCommand } from "./remote-agent-selector.ts";

const ENTRY_MODULE_PATH = import.meta.filename;
const INPUT_MODULE_PATH = fileURLToPath(new URL("./child-runtime-input.ts", import.meta.url));

type ChildChannel = FramedAgentControlChannel<typeof agentControlProtocol>;

type DeliveryExecution = {
	admitted: boolean;
	finished: boolean;
	started: boolean;
	signal?: AbortSignal;
	checkpoint?: () => void;
};

type ChildRuntimeBinding = {
	context: ExtensionContext;
	runtime: AgentSessionRuntime;
	quotaQueue: RetainedRuntimeQueue;
	turnCompaction: ChildTurnCompactionGateway;
	startupAdmission: SessionStartupAdmission;
	nativeInputHandoff?: { submissionSequence: number; transfer: () => void; transferred: boolean };
	reminderAdmission: ModeratorReminderAdmission;
	pendingDeliveries: Map<string, () => Promise<void>>;
	deliveryExecution: AsyncLocalStorage<DeliveryExecution>;
	activity: RemoteAgentActivitySource;
	publishRuntimeSnapshot(): Promise<void>;
	setPresentationVisible(visible: boolean): void;
	handleOwnerRequest(
		request: Parameters<Parameters<ChildChannel["onRequest"]>[0]>[0],
	): Promise<unknown>;
	handleOwnerEvent(event: Parameters<Parameters<ChildChannel["onEvent"]>[0]>[0]): void;
	handleControlClose(): void;
	dispose(): void;
};

type ChildControlState = {
	channel: ChildChannel;
	waitProgressHandlers: Map<string, (progress: AgentWaitProgress) => void>;
	currentBinding?: ChildRuntimeBinding;
	currentRunId?: string;
	latestRunId?: string;
	currentRunOutcome: "completed" | "interrupted" | "failed";
	nativeRunSequence: number;
	queueIntentionTail: Promise<void>;
	shutdownStarted: boolean;
	inputSubmissionAcknowledger: TerminalInputSubmissionAcknowledger;
	nativeInputIdentity: NativeInputSubmissionIdentity;
};

const CHILD_CONTROL_REGISTRY_KEY = "__piAgentCoordinationChildControls";
const globalChildControlRegistry = globalThis as typeof globalThis & {
	[CHILD_CONTROL_REGISTRY_KEY]?: WeakMap<AgentSession, ChildControlState>;
};
// Pi retains the exact AgentSession across /reload. Preserve its authenticated
// Control and sequence continuity; every extension generation replaces currentBinding.
const childControls = (
	globalChildControlRegistry[CHILD_CONTROL_REGISTRY_KEY] ??= new WeakMap()
);

const childRuntimeBridge: ExtensionFactory = async (pi) => {
	let state: ChildControlState | undefined;
	registerSessionStartup(pi);
	const resolveAgentLabel = (agentId: string) =>
		state?.currentBinding?.activity.agentLabel(agentId);
	registerMessageDeliveryRenderer(pi, resolveAgentLabel);
	const bootstrap = await readBootstrapDescriptor();
	const resolveAnswerTargetAgent = (toolCallId: string) => {
		const runtime = state?.currentBinding?.runtime;
		return runtime === undefined
			? undefined
			: answerCallTargetAgentId({
				responderAgentId: bootstrap.agentId,
				transcript: transcriptFromSessionManager(
					runtime.session.sessionManager,
				).inspect(),
				toolCallId,
			});
	};
	const interactiveBridge = installInteractiveHostBridge(hostPi);
	const participantRequest: ChildParticipantControlRequester = (method, payload, signal) => {
		if (!state) throw new Error("child_runtime_control_unavailable: Runtime is not connected");
		return state.channel.request(method, payload, signal);
	};
	const waitProgress = {
		subscribe(toolCallId: string, handler: (progress: AgentWaitProgress) => void) {
			if (!state) throw new Error("child_runtime_control_unavailable: Runtime is not connected");
			if (state.waitProgressHandlers.has(toolCallId)) {
				throw new Error(`child_runtime_wait_progress_exists: ${toolCallId}`);
			}
			state.waitProgressHandlers.set(toolCallId, handler);
			return () => state?.waitProgressHandlers.delete(toolCallId);
		},
	};
	const nativeInputIdentity = {
		current: () => state?.nativeInputIdentity.current(),
		take: () => state?.nativeInputIdentity.take(),
	};
	// The bridge extension loads before inherited extensions. Capture the exact
	// terminal submission before any inherited input preflight can yield while
	// later PTY submissions continue advancing the terminal high-water mark.
	pi.on("input", (event) => {
		if (event.source !== "interactive" || event.streamingBehavior === "followUp") {
			return { action: "continue" };
		}
		const current = state;
		if (!current) throw new Error("child_runtime_control_unavailable: Runtime is not connected");
		current.nativeInputIdentity.beginInput();
		return { action: "continue" };
	});
	// Release child-local turn admission before the later participant lifecycle
	// handler asks the Owner to admit this exact execution.
	pi.on("agent_start", () => {
		const current = state;
		const sequence = current?.nativeInputIdentity.current();
		if (!current || sequence === undefined) return;
		if (!current.currentRunId) {
			current.currentRunId = `native-run-${++current.nativeRunSequence}`;
			current.latestRunId = current.currentRunId;
			current.currentRunOutcome = "completed";
		}
		current.currentBinding?.turnCompaction.completeNativeTurn(sequence);
	});
	registerRemoteAgentsCommand(
		pi,
		{
			...createControlBackedChildPresentationHandlers(participantRequest),
			addChangeHandler(handler) {
				if (!state) throw new Error("child_runtime_not_initialized");
				const activity = requireCurrentBinding(state).activity;
				return activity.addChangeHandler(() => handler(activity.selectorSnapshot()));
			},
		},
	);
	let participantLifecycle: ParticipantLifecycleHandlers;
	let refreshOrdinaryAgentTools: ((refresh?: boolean) => Promise<void>) | undefined;
	if (bootstrap.role === "ordinary") {
		const participant = createControlBackedChildParticipantHandlers(
			"ordinary",
			participantRequest,
			nativeInputIdentity,
			waitProgress,
		);
		participantLifecycle = participant.lifecycle;
		registerParticipantLifecycle(pi, participant.lifecycle, { registerInput: false });
		registerParticipantCoordinationTools(
			pi,
			"ordinary",
			participant.coordination,
			resolveAgentLabel,
			undefined,
			resolveAnswerTargetAgent,
		);
		refreshOrdinaryAgentTools = async (refresh = false) => registerParticipantCoordinationTools(
			pi,
			"ordinary",
			participant.coordination,
			resolveAgentLabel,
			await participant.coordination.agentTemplateSnapshot(refresh),
			resolveAnswerTargetAgent,
		);
	} else {
		const participant = createControlBackedChildParticipantHandlers(
			"moderator",
			participantRequest,
			nativeInputIdentity,
			waitProgress,
		);
		participantLifecycle = participant.lifecycle;
		registerParticipantLifecycle(pi, participant.lifecycle, { registerInput: false });
		registerParticipantCoordinationTools(
			pi,
			"moderator",
			participant.coordination,
			resolveAgentLabel,
			undefined,
			resolveAnswerTargetAgent,
		);
	}
	registerParticipantNativeSessionPolicy(pi);
	const publishCurrentRuntimeSnapshot = async () => {
		const binding = state?.currentBinding;
		if (binding) await binding.publishRuntimeSnapshot();
	};
	const deferRuntimeSnapshot = () => {
		queueMicrotask(() => void publishCurrentRuntimeSnapshot().catch((error: unknown) => {
			if (state) return reportFault(state.channel, "runtime_snapshot_failed", error);
		}));
	};
	pi.on("model_select", deferRuntimeSnapshot);
	pi.on("thinking_level_select", deferRuntimeSnapshot);
	pi.on("session_before_compact", (event) =>
		state?.currentBinding?.turnCompaction.beforeCompaction(event)
	);
	// Active tools have no Pi change event. This authoritative pre-generation
	// boundary publishes extension-driven tool mutations before they can execute.
	pi.on("before_agent_start", publishCurrentRuntimeSnapshot);

	pi.on("session_start", async (event, ctx) => {
		if (state) throw new Error("child_runtime_bridge_rebound: session replacement is not supported");
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			throw new Error("child_runtime_bridge_requires_tui: expected mode=tui and hasUI=true");
		}
		const capture = await interactiveBridge.capture(
			ctx.sessionManager as hostPi.SessionManager,
			ctx.ui,
		);
		const { runtime } = capture;
		assertExpectedSession(runtime, bootstrap);
		const retained = childControls.get(runtime.session);
		if (retained && event.reason !== "reload") {
			throw new Error("child_runtime_bridge_rebound: session replacement is not supported");
		}
		if (retained) {
			state = retained;
		} else {
			const transport = await connectControlTransport(bootstrap.endpoint);
			const channel = new FramedAgentControlChannel({
				identity: {
					protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION,
					workflowId: bootstrap.workflowId,
					agentId: bootstrap.agentId,
				},
				protocol: agentControlProtocol,
				transport,
			});
			const exactNativeInputIdentity = new NativeInputSubmissionIdentity();
			const inputSubmissionAcknowledger = new TerminalInputSubmissionAcknowledger(
				(sequence) => {
					exactNativeInputIdentity.observeTerminalSubmission(sequence);
					// Pi resolves getUserInput() in this same input turn. Delay only to
					// the check phase so runtime.input.started enters ordered Control first.
					setImmediate(() => void channel.sendEvent(
						"runtime.input.submissionAcknowledged",
						{ sequence },
					).catch(() => undefined));
				},
			);
			state = {
				channel,
				waitProgressHandlers: new Map(),
				currentRunOutcome: "completed",
				nativeRunSequence: 0,
				queueIntentionTail: Promise.resolve(),
				shutdownStarted: false,
				inputSubmissionAcknowledger,
				nativeInputIdentity: exactNativeInputIdentity,
			};
			childControls.set(runtime.session, state);
			channel.onRequest((request) => requireCurrentBinding(state as ChildControlState)
				.handleOwnerRequest(request));
			channel.onEvent((event) => requireCurrentBinding(state as ChildControlState)
				.handleOwnerEvent(event));
			channel.onClose(() => state?.currentBinding?.handleControlClose());
		}
		const currentState = state;
		if (retained) currentState.currentBinding?.dispose();
		const inputSubmissionAcknowledgment = currentState.inputSubmissionAcknowledger.bind();
		const removeInputSubmissionListener = ctx.ui.onTerminalInput((data) => {
			inputSubmissionAcknowledgment.handleInput(data);
			return undefined;
		});
		let binding!: ChildRuntimeBinding;
		const inputLifecycle = {
			async started() {
				const sequence = currentState.nativeInputIdentity.beginInput();
				await currentState.channel.sendEvent("runtime.input.started", { sequence });
				return sequence;
			},
			async completed(sequence: number) {
				binding.turnCompaction.completeNativeTurn(sequence);
				if (!currentState.nativeInputIdentity.complete(sequence)) return;
				await currentState.channel.sendEvent("runtime.input.completed", { sequence });
			},
		};
		const completeDiscardedInput = async () => {
			const sequence = currentState.nativeInputIdentity.current();
			if (sequence === undefined) {
				throw new Error("child_runtime_active_input_identity_unavailable");
			}
			await inputLifecycle.completed(sequence);
		};
		binding = createChildRuntimeBinding(
			currentState,
			runtime,
			ctx,
			capture.setPresentationVisible,
			bootstrap.agentId,
			inputSubmissionAcknowledgment,
			removeInputSubmissionListener,
			bindChildInteractiveInputLifecycle(runtime.session, inputLifecycle),
		);
		currentState.currentBinding = binding;
		currentState.shutdownStarted = false;
		// The tail extension is last in Pi load order. Replace its delegates on
		// every bridge generation while keeping lifecycle and Control available first.
		const participantInput = createParticipantInputHandler(
			participantLifecycle,
			completeDiscardedInput,
			{ deferPrimaryInputQueued: false },
		);
		const handleInput: ChildRuntimeInputHandler = async (input, context) => {
			const submissionSequence = currentState.nativeInputIdentity.current();
			const transfer = input.source === "interactive" && input.streamingBehavior !== "followUp"
				? binding.startupAdmission.captureInputHandoff()
				: undefined;
			const handoff = transfer && submissionSequence !== undefined
				? { submissionSequence, transfer, transferred: false }
				: undefined;
			if (handoff) binding.nativeInputHandoff = handoff;
			let result: Awaited<ReturnType<typeof participantInput>>;
			try {
				result = await participantInput(input, context);
			} catch (error) {
				if (!handoff?.transferred) throw error;
				context.ui.notify(`Agent input failed: ${errorMessage(error)}`, "error");
				result = { action: "handled" };
			} finally {
				if (binding.nativeInputHandoff === handoff) binding.nativeInputHandoff = undefined;
			}
			// The forwarded prompt owns this exact input now. Even a failed remote
			// acknowledgment must not let the original input enter preparation again.
			if (handoff?.transferred) return { action: "handled" };
			if (
				input.source === "extension" &&
				result.action === "continue" &&
				binding.turnCompaction.shouldDiscardActiveDeliveryInput()
			) return { action: "handled" };
			const sequence = currentState.nativeInputIdentity.current();
			if (
				input.source === "interactive" &&
				result.action === "continue" &&
				input.streamingBehavior === undefined
			) {
				if (sequence === undefined) {
					throw new Error("child_runtime_active_input_identity_unavailable");
				}
				await binding.turnCompaction.reserveNativeTurn(sequence);
			}
			// Pi queues a direct streaming steer inside the current model cycle. It
			// produces no successor agent_start to consume this submission identity.
			if (
				input.source === "interactive" &&
				input.streamingBehavior === "steer" &&
				sequence !== undefined
			) {
				await inputLifecycle.completed(sequence);
			}
			if (
				input.source === "interactive" &&
				input.streamingBehavior === "steer" &&
				result.action === "continue"
			) deferPrimaryInputQueued(participantLifecycle, context);
			return result;
		};
		const channel = currentState.channel;
		childRuntimeInputs.set(ctx.sessionManager, {
			input: handleInput,
			async completeStartup() {
				try {
					applyStartupToolFilter(pi, bootstrap.role, bootstrap.excludedTools, retained !== undefined);
					await binding.publishRuntimeSnapshot();
					// Reload reports current state but does not re-enforce the initial selection.
					if (!retained) {
						await channel.sendEvent("runtime.startupComplete", await runtimeSnapshot(binding.runtime, ctx));
					}
				} catch (error) {
					await reportFault(channel, "runtime_startup_failed", error);
					await channel.close().catch(() => undefined);
					throw error;
				}
			},
		});
		try {
			assertExpectedSession(binding.runtime, bootstrap);
			if (!retained) {
				await channel.sendHello({
					connectionToken: bootstrap.connectionToken,
					expectedSessionId: bootstrap.expectedSessionId,
				});
			}
			if (bootstrap.ownerPresentation) {
				await refreshOrdinaryAgentTools?.(event.reason === "reload");
			}
			if (bootstrap.ownerPresentation) {
				binding.activity.update(
					await participantRequest("presentation.agents.snapshot", {}),
				);
				installAgentActivityDock(ctx.ui, binding.activity);
			}
			await binding.publishRuntimeSnapshot();
			if (retained) return;
			await channel.sendEvent("runtime.ready", {
				sessionId: ctx.sessionManager.getSessionId(),
				mode: "tui",
				hasUI: true,
			});
		} catch (error) {
			await reportFault(channel, "runtime_startup_failed", error);
			await channel.close().catch(() => undefined);
			throw error;
		}
	});

	pi.on("session_shutdown", async (event) => {
		const current = state;
		if (!current) return;
		// Reload invalidates this extension runner but retains the exact AgentSession
		// and process. The fresh session_start evaluation rebinds the same channel.
		if (event.reason !== "reload") current.shutdownStarted = true;
		const binding = current.currentBinding;
		binding?.dispose();
		if (event.reason !== "reload" && current.currentBinding === binding) {
			current.currentBinding = undefined;
		}
		await current.channel.sendEvent("session.shutdown", { reason: event.reason })
			.catch(() => undefined);
	});
};

/** Binds one session generation to its already-connected child Control. */
export function createChildRuntimeBinding(
	state: ChildControlState,
	runtime: AgentSessionRuntime,
	context: ExtensionContext,
	setPresentationVisible: (visible: boolean) => void,
	agentId: string,
	inputSubmissionAcknowledgment: TerminalInputSubmissionAcknowledgmentBinding,
	removeInputSubmissionListener: () => void,
	removeInputLifecycleObserver: () => void,
): ChildRuntimeBinding {
	let binding!: ChildRuntimeBinding;
	let disposed = false;
	const activity = new RemoteAgentActivitySource(agentId);
	const deliveryExecution = new AsyncLocalStorage<DeliveryExecution>();
	const startupAdmission = bindSessionStartup(runtime.session);
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
		runtime.session,
		(message) => context.ui.notify(message, "warning"),
	);
	const reminderAdmission = new ModeratorReminderAdmission({
		admit: operation => turnCompaction.admit(operation),
		prepare: () => turnCompaction.prepareIdleCustomTurn(),
		isIdle: () => runtime.session.isIdle && !startupAdmission.isPreparing,
		async commit(signal) {
			const delivery = {
				kind: "custom" as const,
				message: createModelVisibleModeratorObligationReminder(),
				triggerTurn: true,
			};
			const proof = observeDeliveryCommit(runtime, context.sessionManager, delivery, signal);
			const { completion } = startupAdmission.dispatchCustom(delivery.message, { triggerTurn: true }, () => {
				signal.throwIfAborted();
				turnCompaction.signal.throwIfAborted();
			});
			void completion.then(
				() => queueMicrotask(() => proof.settle(false)),
				error => proof.reject(error),
			);
			// Proof is child-local: no Owner reconciliation or host lane is needed.
			if (!await proof.result) throw new Error("moderator_reminder_commit_missing");
		},
	});
	const removeLifecycleSubscription = runtime.session.subscribe((event) => {
		if (event.type === "compaction_start") {
			void state.channel.sendEvent("runtime.compaction.started", {}).catch(() => undefined);
		}
		// Pi emits this edge for success, failure, and cancellation alike.
		if (event.type === "compaction_end") {
			void state.channel.sendEvent("runtime.compaction.completed", {}).catch(() => undefined);
		}
		void reportRuntimeLifecycle(state, binding, event).catch((error: unknown) =>
			reportFault(state.channel, "runtime_lifecycle_failed", error)
		);
	});
	const publishRuntimeSnapshot = async () => {
		await state.channel.sendEvent(
			"runtime.snapshot.changed",
			await runtimeSnapshot(runtime, context),
		);
	};
	binding = {
		context,
		runtime,
		quotaQueue: new RetainedRuntimeQueue(() => runtime.session.clearQueue()),
		turnCompaction,
		startupAdmission,
		reminderAdmission,
		pendingDeliveries: new Map(),
		deliveryExecution,
		activity,
		publishRuntimeSnapshot,
		setPresentationVisible,
		handleOwnerRequest: (request) => handleOwnerRequest(state, binding, request),
		handleOwnerEvent(event) {
			if (event.event === "presentation.agents.changed") {
				binding.activity.update(event.payload);
			} else if (event.event === "coordination.wait.progress") {
				state.waitProgressHandlers.get(event.payload.toolCallId)?.(event.payload.progress);
			}
		},
		handleControlClose() {
			if (state.shutdownStarted) return;
			state.shutdownStarted = true;
			state.waitProgressHandlers.clear();
			binding.dispose();
			if (state.currentBinding === binding) state.currentBinding = undefined;
			context.shutdown();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			reminderAdmission.cancel();
			turnCompaction.dispose();
			removeNativeStartupObserver();
			startupAdmission.dispose();
			deliveryExecution.disable();
			removeInputLifecycleObserver();
			inputSubmissionAcknowledgment.dispose();
			removeInputSubmissionListener();
			removeLifecycleSubscription();
		},
	};
	return binding;
}

function requireCurrentBinding(state: ChildControlState): ChildRuntimeBinding {
	if (!state.currentBinding) {
		throw new Error("child_runtime_control_unavailable: Runtime binding is unavailable");
	}
	return state.currentBinding;
}

async function handleOwnerRequest(
	state: ChildControlState,
	binding: ChildRuntimeBinding,
	request: Parameters<Parameters<ChildChannel["onRequest"]>[0]>[0],
): Promise<unknown> {
	switch (request.method) {
		case "runtime.snapshot":
			return runtimeSnapshot(binding.runtime, binding.context);
		case "moderatorReminder.prepare": {
			const cancel = () => binding.reminderAdmission.cancel();
			request.signal.addEventListener("abort", cancel, { once: true });
			try {
				if (request.signal.aborted) throw requestCancellationError(request.signal);
				return { prepared: await binding.reminderAdmission.prepare(request.payload.reservationId) };
			} finally { request.signal.removeEventListener("abort", cancel); }
		}
		case "moderatorReminder.finish": {
			const cancel = () => binding.reminderAdmission.cancel();
			request.signal.addEventListener("abort", cancel, { once: true });
			try {
				if (request.signal.aborted) { cancel(); throw requestCancellationError(request.signal); }
				const outcome = await binding.reminderAdmission.finish(request.payload.reservationId, request.payload.commit);
				return { outcome };
			} finally { request.signal.removeEventListener("abort", cancel); }
		}
		case "message.deliver": {
			const { deliveryId, delivery } = request.payload;
			let commit: ReturnType<typeof observeDeliveryCommit> | undefined;
			const execution: DeliveryExecution = { admitted: false, finished: false, started: false };
			const admissionCancellation = new AbortController();
			const admissionSignal = AbortSignal.any([
				request.signal, binding.turnCompaction.signal, admissionCancellation.signal,
			]);
			let startupCancellation: AbortSignal | undefined;
			let completionTracked = false;
			const finish = () => {
				execution.finished = true;
				binding.pendingDeliveries.delete(deliveryId);
				binding.turnCompaction.completeDelivery(deliveryId);
			};
			const cancel = async () => {
				admissionCancellation.abort(new Error(`child_turn_admission_cancelled: ${deliveryId}`));
				binding.turnCompaction.cancelDelivery(deliveryId);
				if (request.signal.aborted) commit?.reject(requestCancellationError(request.signal));
				if (!execution.signal) return;
				await sequenceQueueIntention(state, async () => {
					// Native signal identity covers awaited start hooks as well as
					// running work, without clearing or aborting a successor.
					if (binding.runtime.session.agent.signal !== execution.signal) return;
					binding.runtime.session.clearQueue();
					await binding.runtime.session.abort();
				});
			};
			const onAbort = () => {
				void cancel().catch(error => reportFault(state.channel, "delivery_cancellation_failed", error));
			};
			binding.pendingDeliveries.set(deliveryId, cancel);
			request.signal.addEventListener("abort", onAbort, { once: true });
			try {
				const admitDelivery = () => binding.turnCompaction.admitDelivery(deliveryId, async checkpoint => {
					admissionSignal.throwIfAborted();
					startupCancellation?.throwIfAborted();
					await binding.turnCompaction.waitForCompaction();
					checkpoint();
					if (binding.runtime.session.isIdle && delivery.kind === "custom" && delivery.triggerTurn) {
						await binding.turnCompaction.prepareIdleCustomTurn(delivery.workingZonePreparation);
					}
					checkpoint();
					admissionSignal.throwIfAborted();
					// Pi's manual compaction calls abort() itself. Capture native input
					// cancellation only after that separate preparation phase finishes.
					startupCancellation = binding.startupAdmission.signal;
					const dispatchSignal = AbortSignal.any([admissionSignal, startupCancellation]);
					const dispatchCommit = observeDeliveryCommit(binding.runtime, binding.context.sessionManager, delivery, binding.turnCompaction.signal);
					commit = dispatchCommit;
					const dispatchCheckpoint = () => {
						checkpoint();
						dispatchSignal.throwIfAborted();
					};
					const dispatch = () => {
						dispatchCheckpoint();
						execution.checkpoint = dispatchCheckpoint;
						// Active queue admission belongs to this actual native execution.
						execution.signal = binding.runtime.session.agent.signal;
						execution.admitted = delivery.kind === "custom" && !binding.runtime.session.isIdle;
						return binding.deliveryExecution.run(execution, () =>
							dispatchDelivery(binding, delivery, () => {
								dispatchCheckpoint();
								execution.admitted = true;
							})
						);
					};
					const dispatched = binding.runtime.session.isIdle
						? dispatch()
						: await sequenceQueueIntention(state, dispatch);
					// Native queue acceptance is not execution completion. Capture the
					// session's settlement after dispatch, never preparation's earlier cycle.
					const completion = dispatched.completion.then(() => binding.runtime.session.waitForIdle());
					void completion.catch(error => dispatchCommit.reject(error));
					await Promise.race([dispatched.preflight, completion]);
					checkpoint();
					return { completion, commit: dispatchCommit, modelCycleStarted: !binding.runtime.session.isIdle };
				});
				let admission: Awaited<ReturnType<typeof admitDelivery>>;
				for (;;) {
					try {
						admission = await admitDelivery();
						break;
					} catch (error) {
						if (delivery.kind !== "custom" || !isStartupPreparationBusy(error)) throw error;
						commit?.settle(false);
						commit = undefined;
						// Native input may own startup while waiting for this compaction
						// gate. Release the gate before waiting, then preserve the original
						// custom queue mode when retrying this uncommitted admission.
						await waitForStartupRelease(error.whenReleased,
							AbortSignal.any([admissionSignal, startupCancellation!]));
					}
				}
				const { completion } = admission;
				completionTracked = true;
				commit = admission.commit;
				void completion.then(
					() => {
						queueMicrotask(() => commit?.settle(false));
						return state.channel.sendEvent("message.dispatch.completed", { deliveryId });
					},
					error => {
						commit?.reject(error);
						return state.channel.sendEvent("message.dispatch.completed", { deliveryId, error: errorMessage(error) });
					},
				).catch(error => reportFault(state.channel, "delivery_completion_failed", error)).finally(finish);
				return {
					accepted: true,
					transcriptCommitted: await commit.result,
					modelCycleStarted: admission.modelCycleStarted,
					queuedInputCount: binding.runtime.session.pendingMessageCount,
				};
			} finally {
				request.signal.removeEventListener("abort", onAbort);
				commit?.settle(false);
				if (!completionTracked) finish();
			}
		}
		case "message.cancel": {
			const cancel = binding.pendingDeliveries.get(request.payload.deliveryId);
			if (!cancel) return { accepted: false };
			await cancel();
			return { accepted: true };
		}
		case "queue.clear": {
			const cleared = await binding.turnCompaction.admit(() =>
				sequenceQueueIntention(state, () => {
					requireCurrentOrLatestRun(state, request.payload.runId);
					return binding.quotaQueue.clear();
				})
			);
			return { ...cleared, queuedInputCount: binding.runtime.session.pendingMessageCount };
		}
		case "run.interrupt": {
			binding.reminderAdmission.cancel();
			const accepted = await sequenceQueueIntention(state, async () => {
				if (!requireCurrentOrLatestRun(state, request.payload.runId)) return false;
				await binding.runtime.session.abort();
				return true;
			});
			return { accepted };
		}
		case "presentation.setVisible":
			binding.setPresentationVisible(request.payload.visible);
			return {};
		case "runtime.shutdown":
			state.shutdownStarted = true;
			setImmediate(() => binding.context.shutdown());
			return { accepted: true };
		case "runtime.executionBegin":
		case "runtime.humanInput":
		case "runtime.primaryInputQueued":
		case "runtime.humanInputMode":
		case "runtime.guardToolResult":
		case "runtime.toolExecutionStart":
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

/**
 * Applies the Spawn and Template exclusion filter to the child surface after
 * inherited startup handlers ran, and keeps the role coordination tools active so
 * a filtered or rewired child can still answer. Reload preserves native changes
 * and only re-asserts participation. Absent names are ignored.
 */
function applyStartupToolFilter(
	pi: ExtensionAPI,
	role: ChildProcessBootstrap["role"],
	excludedTools: readonly string[],
	retained: boolean,
): void {
	const roleTools = participantCoordinationToolNames[role];
	if (retained) {
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...roleTools])]);
		return;
	}
	const excludedNames = new Set(excludedTools);
	pi.setActiveTools([...new Set([
		...pi.getActiveTools().filter((name) => !excludedNames.has(name)),
		...roleTools,
	])]);
}

async function runtimeSnapshot(
	runtime: AgentSessionRuntime,
	context: ExtensionContext,
) {
	const session = runtime.session;
	const bridgePath = await canonicalFilePath(ENTRY_MODULE_PATH, runtime.cwd);
	const inputPath = await canonicalFilePath(INPUT_MODULE_PATH, runtime.cwd);
	const extensions = await Promise.all(
		runtime.services.resourceLoader.getExtensions().extensions
			.map((extension) => extension.resolvedPath)
			.filter((path) => !path.startsWith("<inline:"))
			.map((path) => canonicalFilePath(path, runtime.cwd)),
	);
	const explicitSystemPromptModeValue = process.env[
		CHILD_PROCESS_SYSTEM_PROMPT_MODE_ENVIRONMENT_VARIABLE
	];
	if (
		explicitSystemPromptModeValue !== undefined &&
		explicitSystemPromptModeValue !== "append" &&
		explicitSystemPromptModeValue !== "replace"
	) {
		throw new Error("child_runtime_system_prompt_mismatch: mode is invalid");
	}
	const explicitSystemPromptMode = explicitSystemPromptModeValue as
		| "append"
		| "replace"
		| undefined;
	const explicitSystemPromptPath = process.env[
		CHILD_PROCESS_SYSTEM_PROMPT_PATH_ENVIRONMENT_VARIABLE
	];
	if ((explicitSystemPromptMode === undefined) !== (explicitSystemPromptPath === undefined)) {
		throw new Error("child_runtime_system_prompt_mismatch: mode and path must be provided together");
	}
	const appendPrompt = runtime.services.resourceLoader.getAppendSystemPrompt();
	const appendSources = runtime.services.resourceLoader.getAppendSystemPromptSources();
	if (explicitSystemPromptMode === "append"
		&& (appendPrompt.length !== 1 || appendSources.length !== 1)) {
		throw new Error("child_runtime_system_prompt_mismatch: expected one file-backed append prompt");
	}
	const systemPromptSource = runtime.services.resourceLoader.getSystemPromptSource();
	if (explicitSystemPromptMode === "replace" && systemPromptSource === undefined) {
		throw new Error("child_runtime_system_prompt_mismatch: expected one file-backed system prompt");
	}
	const explicitSystemPromptBody = explicitSystemPromptMode === undefined
		? undefined
		: explicitSystemPromptMode === "append"
			? appendPrompt[0]
			: runtime.services.resourceLoader.getSystemPrompt();
	if (explicitSystemPromptMode !== undefined && explicitSystemPromptBody === undefined) {
		throw new Error("child_runtime_system_prompt_mismatch: prompt body is unavailable");
	}
	const loadContextFilesValue = process.env[
		CHILD_PROCESS_LOAD_CONTEXT_FILES_ENVIRONMENT_VARIABLE
	];
	if (loadContextFilesValue !== "0" && loadContextFilesValue !== "1") {
		throw new Error("child_runtime_load_context_files_mismatch: load-context-files marker is invalid");
	}
	const sessionPath = context.sessionManager.getSessionFile();
	if (!sessionPath) throw new Error("child_runtime_session_path_unavailable");
	const tools = session.getActiveToolNames();
	const toolExecutionModes = tools.map((name) => {
		const definition = session.getToolDefinition(name);
		if (!definition) {
			throw new Error(`child_runtime_tool_definition_unavailable: ${name}`);
		}
		return { name, executionMode: definition.executionMode ?? "parallel" };
	});
	const skillSources = await Promise.all(
		runtime.services.resourceLoader.getSkills().skills.map(async ({ name, filePath }) => ({
			name,
			filePath: await canonicalFilePath(filePath, runtime.cwd),
		})),
	);
	return {
		cwd: runtime.cwd,
		model: requireModel(session.model),
		thinking: session.thinkingLevel,
		tools,
		skills: skillSources.map(({ name }) => name),
		skillSources,
		extensions: extensions.filter((path) => path !== bridgePath && path !== inputPath),
		toolExecutionModes,
		projectTrusted: runtime.services.settingsManager.isProjectTrusted(),
		sessionId: session.sessionId,
		sessionPath,
		systemPrompt: explicitSystemPromptMode === undefined
			? null
			: {
				mode: explicitSystemPromptMode,
				filePath: await canonicalFilePath(
					explicitSystemPromptMode === "append"
						? appendSources[0]!.path
						: systemPromptSource!.path,
					runtime.cwd,
				),
				body: explicitSystemPromptBody!,
			},
		loadContextFiles: loadContextFilesValue === "1",
	};
}

async function reportRuntimeLifecycle(
	state: ChildControlState,
	binding: ChildRuntimeBinding,
	event: AgentSessionEvent,
): Promise<void> {
	if (state.currentBinding !== binding) return;
	const { runtime, activity } = binding;
	if (event.type === "agent_start") {
		activity.setScopeFailed(false);
		// Only actual Pi execution owns transport cycle identity; Delivery admission does not.
		state.currentRunId ??= `native-run-${++state.nativeRunSequence}`;
		state.latestRunId = state.currentRunId;
		await state.channel.sendEvent("agent.start", {
			runId: state.currentRunId,
			queuedInputCount: runtime.session.pendingMessageCount,
		});
		return;
	}
	if (event.type === "agent_end") {
		if (!state.currentRunId) return;
		const assistant = [...event.messages]
			.reverse()
			.find((message) => message.role === "assistant");
		state.currentRunOutcome = assistant?.role === "assistant" && assistant.stopReason === "aborted"
			? "interrupted"
			: assistant?.role === "assistant" && assistant.stopReason === "error"
				? "failed"
				: "completed";
		activity.setScopeFailed(state.currentRunOutcome === "failed");
		const quota = state.currentRunOutcome === "failed" && assistant?.role === "assistant"
			? classifyQuotaEvidence(assistant) : undefined;
		// Session subscribers are synchronous: drain before the first transport await
		// so Pi cannot consume follow-ups while the Owner learns of terminal quota.
		if (quota && !event.willRetry) binding.quotaQueue.capture();
		await state.channel.sendEvent("agent.end", {
			runId: state.currentRunId,
			outcome: state.currentRunOutcome,
			willRetry: event.willRetry,
			...(quota ? { quota } : {}),
			queuedInputCount: runtime.session.pendingMessageCount,
			...(assistant?.role === "assistant" && assistant.errorMessage
				? { error: assistant.errorMessage }
				: {}),
		});
		return;
	}
	if (event.type !== "agent_settled" || !state.currentRunId) return;
	// Pi awaits extension settlement hooks before notifying session listeners.
	// A hook can already have started a successor; the old edge cannot settle it.
	if (runtime.session.isStreaming) return;
	const runId = state.currentRunId;
	await state.channel.sendEvent("agent.settled", {
		runId,
		outcome: state.currentRunOutcome,
		queuedInputCount: runtime.session.pendingMessageCount,
	});
	if (state.currentBinding !== binding) return;
	if (state.currentRunId === runId) state.currentRunId = undefined;
}

function requireCurrentOrLatestRun(state: ChildControlState, runId: string): boolean {
	const expectedRunId = state.currentRunId ?? state.latestRunId;
	if (runId !== expectedRunId) {
		throw new Error(
			`stale_run: ${runId} does not target the current or latest child Run`,
		);
	}
	return state.currentRunId === runId;
}

function sequenceQueueIntention<T>(
	state: ChildControlState,
	operation: () => T | Promise<T>,
): Promise<T> {
	const result = state.queueIntentionTail.then(operation);
	state.queueIntentionTail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function dispatchDelivery(
	binding: ChildRuntimeBinding,
	delivery: AgentRuntimeDelivery,
	checkpoint: () => void,
): Readonly<{ completion: Promise<void>; preflight: Promise<void> }> {
	if (delivery.kind === "custom") {
		return binding.startupAdmission.dispatchCustom(delivery.message, {
			triggerTurn: delivery.triggerTurn,
			...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
		}, checkpoint);
	}
	const content = typeof delivery.content === "string"
		? [{ type: "text" as const, text: delivery.content }]
		: [...delivery.content];
	const text = content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
	const images = content.flatMap((part) => part.type === "image" ? [part] : []);
	let resolvePreflight!: () => void;
	const preflight = new Promise<void>((resolve) => {
		resolvePreflight = resolve;
	});
	const handoff = binding.nativeInputHandoff;
	if (handoff && !handoff.transferred && delivery.forwardedInput?.submissionSequence === handoff.submissionSequence) {
		checkpoint();
		handoff.transfer();
		handoff.transferred = true;
	}
	return {
		completion: binding.runtime.session.prompt(text, {
			expandPromptTemplates: false,
			source: "extension",
			...(images.length === 0 ? {} : { images }),
			...(delivery.deliverAs === undefined
				? {}
				: { streamingBehavior: delivery.deliverAs }),
			preflightResult() {
				try {
					checkpoint();
				} catch (error) {
					resolvePreflight();
					throw error;
				}
				resolvePreflight();
			},
		}),
		preflight,
	};
}

function observeDeliveryCommit(
	runtime: AgentSessionRuntime,
	sessionManager: ExtensionContext["sessionManager"],
	delivery: AgentRuntimeDelivery,
	generationSignal: AbortSignal,
): Readonly<{
	result: Promise<boolean>;
	settle(committed: boolean): void;
	reject(error: unknown): void;
}> {
	let settleResult!: (committed: boolean) => void;
	let rejectResult!: (error: unknown) => void;
	let settled = false;
	let unsubscribe: () => void = () => undefined;
	const existingEntryIds = new Set(
		sessionManager.getEntries().map((entry) => entry.id),
	);
	const finish = (settlement: () => void) => {
		if (settled) return;
		settled = true;
		unsubscribe();
		generationSignal.removeEventListener("abort", invalidate);
		settlement();
	};
	const invalidate = () => finish(() => rejectResult(
		new Error("child_turn_compaction_gateway_disposed"),
	));
	const result = new Promise<boolean>((resolve, reject) => {
		settleResult = resolve;
		rejectResult = reject;
	});
	// Dispatch/preflight can reject before admission reaches its commit await.
	void result.catch(() => undefined);
	generationSignal.addEventListener("abort", invalidate, { once: true });
	unsubscribe = runtime.session.subscribe((event) => {
		if (
			event.type === "message_end" &&
			matchesDeliveryMessage(delivery, event.message)
		) {
			// AgentSession notifies listeners immediately before its synchronous
			// SessionManager append. Verify the writer's new exact entry after that edge;
			// the lifecycle event alone is not durable transcript evidence.
			queueMicrotask(() => finish(() => settleResult(
				sessionManager.getEntries().some((entry) =>
					!existingEntryIds.has(entry.id) && matchesDeliveryEntry(delivery, entry)
				),
			)));
		}
		if (event.type === "agent_settled") finish(() => settleResult(false));
	});
	if (generationSignal.aborted) invalidate();
	return {
		result,
		settle: (committed) => finish(() => settleResult(committed)),
		reject: (error) => finish(() => rejectResult(error)),
	};
}

function matchesDeliveryEntry(
	delivery: AgentRuntimeDelivery,
	entry: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number],
): boolean {
	if (delivery.kind === "custom") {
		return entry.type === "custom_message" &&
			entry.customType === delivery.message.customType &&
			isDeepStrictEqual(entry.content, delivery.message.content) &&
			entry.display === delivery.message.display &&
			isDeepStrictEqual(
				entry.details,
				"details" in delivery.message ? delivery.message.details : undefined,
			);
	}
	return entry.type === "message" && matchesDeliveryMessage(delivery, entry.message);
}

function matchesDeliveryMessage(
	delivery: AgentRuntimeDelivery,
	message: unknown,
): boolean {
	if (!message || typeof message !== "object" || !("role" in message)) return false;
	if (delivery.kind === "custom") {
		return message.role === "custom" &&
			"customType" in message && message.customType === delivery.message.customType &&
			"content" in message && isDeepStrictEqual(message.content, delivery.message.content) &&
			"display" in message && message.display === delivery.message.display &&
			isDeepStrictEqual(
				"details" in message ? message.details : undefined,
				"details" in delivery.message ? delivery.message.details : undefined,
			);
	}
	if (message.role !== "user" || !("content" in message)) return false;
	const content = typeof delivery.content === "string"
		? [{ type: "text", text: delivery.content }]
		: normalizeUserContent(delivery.content);
	return isDeepStrictEqual(message.content, content);
}

function normalizeUserContent(
	content: Extract<AgentRuntimeDelivery, { kind: "user" }>["content"] & readonly unknown[],
): readonly unknown[] {
	const text = content
		.filter((part): part is Extract<(typeof content)[number], { type: "text" }> =>
			typeof part === "object" && part !== null && "type" in part && part.type === "text"
		)
		.map((part) => part.text)
		.join("\n");
	const images = content.filter((part) =>
		typeof part === "object" && part !== null && "type" in part && part.type === "image"
	);
	return [{ type: "text", text }, ...images];
}

function requireModel(model: AgentSessionRuntime["session"]["model"]) {
	if (!model) throw new Error("child_runtime_model_unavailable: no active model");
	return { provider: model.provider, modelId: model.id };
}

async function canonicalFilePath(path: string, cwd: string): Promise<string> {
	return realpath(isAbsolute(path) ? path : resolve(cwd, path));
}



async function reportFault(channel: ChildChannel, code: string, error: unknown): Promise<void> {
	await channel.sendEvent("runtime.fault", { code, message: errorMessage(error) })
		.catch(() => undefined);
}

function assertExpectedSession(runtime: AgentSessionRuntime, bootstrap: ChildProcessBootstrap): void {
	if (runtime.session.sessionId !== bootstrap.expectedSessionId) {
		throw new Error(
			`child_runtime_session_mismatch: expected ${bootstrap.expectedSessionId}, received ${runtime.session.sessionId}`,
		);
	}
}

class RemoteAgentActivitySource implements AgentActivitySource {
	#agentId: string;
	readonly #handlers = new Set<() => void>();
	#selector: RemoteAgentSelectorSnapshot | undefined;
	#scopeFailed = false;

	constructor(agentId: string) {
		this.#agentId = agentId;
	}

	update(selector: RemoteAgentSelectorSnapshot): void {
		this.#agentId = selector.selectedAgentId;
		this.#selector = selector;
		this.#notifyChanged();
	}

	setScopeFailed(failed: boolean): void {
		if (this.#scopeFailed === failed) return;
		this.#scopeFailed = failed;
		this.#notifyChanged();
	}

	agentLabel(agentId: string): string | undefined {
		const selector = this.#selector;
		return selector
			? [...selector.live, ...selector.dormant]
				.find((agent) => agent.agentId === agentId)?.label
			: undefined;
	}

	selectorSnapshot(): RemoteAgentSelectorSnapshot {
		if (!this.#selector) throw new Error("child_runtime_activity_unavailable: selector snapshot is not initialized");
		return this.#selector;
	}

	snapshot(): AgentActivitySnapshot {
		const selector = this.#selector;
		if (!selector) {
			throw new Error("child_runtime_activity_unavailable: selector snapshot is not initialized");
		}
		const roster = [...selector.live, ...selector.dormant];
		const scope = roster.find(({ agentId }) => agentId === this.#agentId);
		if (!scope) {
			throw new Error(`child_runtime_activity_unavailable: Agent ${this.#agentId} is absent`);
		}
		return {
			scope: { ...scope, failed: this.#scopeFailed },
			children: selector.live
				.filter(({ directSpawnerAgentId }) => directSpawnerAgentId === this.#agentId)
				.map((child) => ({ ...child, failed: false })),
			answerMode: selector.humanAttention.some(({ agentId }) => agentId === this.#agentId),
			humanAttention: selector.humanAttention,
			operationalAttention: selector.operationalAttention,
			reports: selector.reports,
		};
	}

	addChangeHandler(handler: () => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	#notifyChanged(): void {
		for (const handler of this.#handlers) handler();
	}
}

async function readBootstrapDescriptor(): Promise<ChildProcessBootstrap> {
	const path = process.env[CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE];
	if (!path || !isAbsolute(path) || path.includes("\0")) {
		throw new Error(`control_bootstrap_invalid: descriptor path must be absolute. ${childLaunchBlockGuidance("retry_agent_launch")}`);
	}
	const descriptorStats = await stat(path);
	if (!descriptorStats.isFile()) {
		throw new Error(`control_bootstrap_invalid: descriptor path is not a regular file. ${childLaunchBlockGuidance("retry_agent_launch")}`);
	}
	// Windows stat modes do not expose ACL ownership and report synthesized
	// group/other bits even for files created with mode 0600. The artifact lives
	// in a unique current-user temporary directory there; POSIX keeps the exact
	// owner-only mode check.
	if (process.platform !== "win32" && (descriptorStats.mode & 0o077) !== 0) {
		throw new Error(`control_bootstrap_invalid: descriptor must be owner-only. ${childLaunchBlockGuidance("retry_agent_launch")}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch {
		// JSON parser errors can quote descriptor text, including the connection token.
		throw new Error(`control_bootstrap_invalid: descriptor could not be read as JSON. ${childLaunchBlockGuidance("retry_agent_launch")}`);
	}
	return validateChildProcessBootstrap(value);
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

export default childRuntimeBridge;
