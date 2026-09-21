import { randomUUID } from "node:crypto";
import type {
	CommitModeratorReminderIfCurrent,
	ModeratorReminderOutcome,
	AgentRuntimeDelivery,
	AgentRuntimeDeliveryDispatch,
	AgentRuntimeWorkState,
	EffectiveRuntimeSnapshot,
	TranscriptCommitConfirmation,
} from "../runtime/agent-runtime-host.ts";
import type {
	HostedAgentRuntime,
	HostedRuntimeEvent,
} from "../runtime/hosted-agent-runtime.ts";
import type { HostedAgentProjection } from "../runtime/hosted-agent-projection.ts";
import { createPiChildProcessProjection } from "./pi-child-process-projection.ts";
import {
	type PiChildProcessLaunch,
	type PiChildProcessRuntime,
	type PiChildRuntimeEvent,
} from "./pi-child-process-runtime.ts";

type SettlementWaiter = {
	started: boolean;
	settled: boolean;
	readonly result: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
};

/** Adapt one pending/admitted real Pi child to the common Runtime supervisor. */
export class PiChildHostedRuntime implements HostedAgentRuntime {
	readonly projection: HostedAgentProjection;
	readonly ready: Promise<void>;
	readonly #launch: PiChildProcessLaunch;
	readonly #onQuit: ((projection: HostedAgentProjection) => boolean) | undefined;
	readonly #admitted: Promise<PiChildProcessRuntime>;
	readonly #handlers = new Set<(event: HostedRuntimeEvent) => void>();
	readonly #settlementWaiters = new Set<SettlementWaiter>();
	readonly #dispatchCompletions = new Map<string, {
		resolve(): void;
		reject(error: unknown): void;
	}>();
	#deliverySequence = 0;
	readonly #removeEventHandler: () => void;
	#removeChannelCloseHandler: () => void = () => undefined;
	#snapshot: EffectiveRuntimeSnapshot | undefined;
	#snapshotRevision = 0;
	#workState: AgentRuntimeWorkState = "settled";
	#compacting = false;
	#queuedInputCount = 0;
	#currentRunId: string | undefined;
	#latestRunId: string | undefined;
	#runObserved = false;
	#cancellation = new AbortController();
	#unavailable: unknown;
	#shutdownExpected = false;
	#reminderAdmissionAbort: AbortController | undefined;
	#disposePromise: Promise<void> | undefined;

	constructor(
		launch: PiChildProcessLaunch,
		onQuit?: (projection: HostedAgentProjection) => boolean,
	) {
		this.#launch = launch;
		this.#onQuit = onQuit;
		// Fence volatile Run state before presentation reports the same process exit.
		// Otherwise Owner restoration can race cleanup intentions over dead Control.
		void launch.exited.then(
			(exit) => {
				if (this.#shutdownExpected) return;
				this.#endTransport(new Error(
					`child_runtime_unexpected_exit: code ${exit.exitCode} signal ${exit.signal}`,
				));
			},
			(error: unknown) => this.#endTransport(error),
		);
		const projection = createPiChildProcessProjection(launch);
		this.projection = Object.freeze({
			...projection,
			dispose: () => {
				this.#shutdownExpected = true;
				return projection.dispose();
			},
		});
		this.#removeEventHandler = launch.onEvent((event) => this.#handleEvent(event));
		this.#admitted = launch.ready();
		this.ready = this.#admitted.then((runtime) => {
			this.#adoptSnapshot(runtime.snapshot);
			this.#removeChannelCloseHandler = runtime.channel.onClose((cause) => {
				if (this.#shutdownExpected) return;
				this.#endTransport(cause ?? new Error("child_runtime_channel_closed"));
			});
		});
		void this.ready.catch((error: unknown) => this.#endTransport(error));
	}

	snapshot(): EffectiveRuntimeSnapshot {
		if (!this.#snapshot) {
			throw new Error("child_runtime_not_admitted: effective snapshot is unavailable");
		}
		return this.#snapshot;
	}

	async synchronizeState(): Promise<void> {
		if (this.#unavailable) throw this.#unavailable;
		const runtime = await this.#admitted;
		const revision = this.#snapshotRevision;
		const snapshot = await runtime.channel.request("runtime.snapshot", {});
		// An ordered change event that arrived while this request was in flight is
		// newer than the response's inspection point; never overwrite it.
		if (revision === this.#snapshotRevision) this.#adoptSnapshot(snapshot);
	}

	workState(): AgentRuntimeWorkState {
		return this.#workState;
	}

	hasPendingActivity(): boolean {
		return this.#compacting || this.#queuedInputCount > 0;
	}

	isCompacting(): boolean {
		return this.#compacting;
	}

	queuedInputCount(): number {
		return this.#queuedInputCount;
	}

	cancellationSignal(): AbortSignal {
		return this.#cancellation.signal;
	}

	deliver(
		delivery: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	): AgentRuntimeDeliveryDispatch {
		if (this.#unavailable) throw this.#unavailable;
		this.#runObserved = true;
		const deliveryId = `delivery-${++this.#deliverySequence}`;
		// Only the child-correlated completion covers this Delivery, including native
		// queue settlement. Preparation and unrelated lifecycle edges do not.
		const dispatchCompletion = new Promise<void>((resolve, reject) => {
			this.#dispatchCompletions.set(deliveryId, { resolve, reject });
		});
		const response = this.#admitted.then((runtime) =>
			runtime.channel.request("message.deliver", {
				deliveryId,
				delivery: serializeDelivery(delivery),
			})
		).then((result) => {
			this.#updateQueuedInputCount(result.queuedInputCount);
			return result;
		});
		const completion = Promise.all([
			response.then(({ accepted }) => {
				if (!accepted) throw new Error("child_runtime_delivery_rejected");
			}),
			dispatchCompletion,
		]).then(() => undefined);
		void completion.catch((error: unknown) => {
			this.#dispatchCompletions.get(deliveryId)?.reject(error);
		}).finally(() => this.#dispatchCompletions.delete(deliveryId));
		if (!confirmation) return { completion };
		const transcriptCommit = response.then((result) =>
			result.transcriptCommitted && confirmation.inspectCommit()
		);
		return { completion, transcriptCommit };
	}

	async deliverModeratorReminder(
		commitIfCurrent: CommitModeratorReminderIfCurrent,
	): Promise<ModeratorReminderOutcome> {
		if (this.#reminderAdmissionAbort) throw new Error("moderator_reminder_already_reserved");
		const cancellation = new AbortController();
		this.#reminderAdmissionAbort = cancellation;
		const reservationId = randomUUID();
		let finished = false;
		let rejectCancellation!: (error: unknown) => void;
		const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
		const onAbort = () => rejectCancellation(cancellation.signal.reason);
		cancellation.signal.addEventListener("abort", onAbort, { once: true });
		void cancelled.catch(() => undefined);
		try {
			const runtime = await this.#admitted;
			try {
				const { prepared } = await runtime.channel.request(
					"moderatorReminder.prepare", { reservationId }, cancellation.signal,
				);
				if (!prepared) return "busy";
				return await Promise.race([commitIfCurrent(async () => {
					cancellation.signal.throwIfAborted();
					const { outcome } = await runtime.channel.request(
						"moderatorReminder.finish", { reservationId, commit: true }, cancellation.signal,
					);
					finished = true;
					if (outcome === "suppressed") throw new Error("moderator_reminder_commit_suppressed");
					return outcome;
				}), cancelled]);
			} finally {
				if (!finished) {
					// Release even if the prepare response was cancelled in transit.
					// This never clears unrelated native queues.
					await runtime.channel.request("moderatorReminder.finish", { reservationId, commit: false });
				}
			}
		} finally {
			cancellation.signal.removeEventListener("abort", onAbort);
			if (this.#reminderAdmissionAbort === cancellation) this.#reminderAdmissionAbort = undefined;
		}
	}

	subscribe(handler: (event: HostedRuntimeEvent) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	async clearQueue(): Promise<Readonly<{ steering: string[]; followUp: string[] }>> {
		const runtime = await this.#admitted;
		// The child accepts only its current or newest settled Run. Resolve that
		// identity after awaiting admission: a lifecycle edge can be accepted while
		// this call is still pending, and an identity read earlier is then stale.
		const runId = this.#currentRunId ?? this.#latestRunId;
		if (!runId) return { steering: [], followUp: [] };
		const result = await runtime.channel.request("queue.clear", { runId });
		this.#updateQueuedInputCount(result.queuedInputCount);
		return { steering: result.steering, followUp: result.followUp };
	}

	async abort(): Promise<void> {
		this.#reminderAdmissionAbort?.abort();
		const deliveryIds = [...this.#dispatchCompletions.keys()];
		const runtime = await this.#admitted;
		// Read the Run identity at dispatch time for the same reason as clearQueue.
		const runId = this.#currentRunId ?? this.#latestRunId;
		await Promise.all([
			...deliveryIds.map(deliveryId => runtime.channel.request("message.cancel", { deliveryId })),
			...(runId ? [runtime.channel.request("run.interrupt", { runId })] : []),
		]);
	}

	waitForIdle(): Promise<void> {
		if (this.#workState === "settled") return Promise.resolve();
		return this.#waitForSettlement().result;
	}

	dispose(): Promise<void> {
		this.#disposePromise ??= (async () => {
			this.#shutdownExpected = true;
			// Expected shutdown suppresses transport fencing; tracking must still
			// terminate before disposal removes the completion-event listener.
			this.#rejectPendingCompletions(new Error("child_runtime_disposed"));
			this.#reminderAdmissionAbort?.abort();
			this.#clearCompaction();
			try {
				await this.#launch.dispose();
			} finally {
				this.#removeChannelCloseHandler();
				this.#removeEventHandler();
				this.#handlers.clear();
			}
		})();
		return this.#disposePromise;
	}

	#adoptSnapshot(
		snapshot: PiChildProcessRuntime["snapshot"],
	): void {
		// Descendant inheritance must observe one coherent child state, never fields
		// copied from different Runtime generations.
		this.#snapshot = {
			cwd: snapshot.cwd,
			model: snapshot.model,
			thinking: snapshot.thinking,
			tools: [...snapshot.tools],
			skills: [...snapshot.skills],
			skillSources: snapshot.skillSources.map(({ name, filePath }) => ({ name, filePath })),
			fileExtensionPaths: [...snapshot.extensions],
			projectTrusted: snapshot.projectTrusted,
			sessionId: snapshot.sessionId,
		};
	}

	#handleEvent(event: PiChildRuntimeEvent): void {
		if (this.#unavailable) return;
		if (event.event === "session.shutdown" && event.payload.reason === "quit") {
			if (this.#shutdownExpected) return;
			// Only the Workflow can accept quit as orderly shutdown. An unselected
			// child's exit must still expose stranded obligations as Run Failure.
			if (this.#onQuit?.(this.projection)) {
				this.#shutdownExpected = true;
				this.#endTransport(new Error("child_runtime_shutdown"), "shutdown");
			}
			return;
		}
		if (event.event === "message.dispatch.completed") {
			const dispatch = this.#dispatchCompletions.get(event.payload.deliveryId);
			if (event.payload.error !== undefined) dispatch?.reject(new Error(event.payload.error));
			else dispatch?.resolve();
			return;
		}
		if (event.event === "runtime.snapshot.changed") {
			this.#snapshotRevision += 1;
			this.#adoptSnapshot(event.payload);
			this.#emit({ type: "state_changed" });
			return;
		}
		if (event.event === "runtime.fault") {
			this.#endTransport(new Error(
				`child_runtime_fault: ${event.payload.code}: ${event.payload.message}`,
			));
			return;
		}
		if (event.event === "runtime.compaction.started") {
			if (this.#unavailable || this.#shutdownExpected) return;
			this.#compacting = true;
			this.#emit({ type: "state_changed" });
			return;
		}
		if (event.event === "runtime.compaction.completed") {
			this.#compacting = false;
			this.#emit({ type: "state_changed" });
			return;
		}
		if (
			event.event !== "agent.start" &&
			event.event !== "agent.end" &&
			event.event !== "agent.settled"
		) return;
		if (!this.#acceptsLifecycleEvent(event)) return;
		this.#updateQueuedInputCount(event.payload.queuedInputCount);
		if (event.event === "agent.start") {
			if (this.#cancellation.signal.aborted) this.#cancellation = new AbortController();
			this.#workState = "active";
			for (const waiter of this.#settlementWaiters) waiter.started = true;
			this.#emit({ type: "state_changed" });
			return;
		}
		if (event.event === "agent.end") {
			if (event.payload.outcome === "interrupted") this.#cancellation.abort();
			this.#emit({
				type: "agent_end",
				outcome: event.payload.outcome === "completed"
					? "completed"
					: event.payload.outcome === "interrupted"
						? "aborted"
						: "error",
				willRetry: event.payload.willRetry,
				...(event.payload.outcome === "failed" && event.payload.error !== undefined
					? { failure: { stage: "model", error: event.payload.error, provenance: "pi-child-hosted-runtime" } }
					: {}),
				...(event.payload.outcome === "failed" && event.payload.quota ? { quota: event.payload.quota } : {}),
			});
			return;
		}
		this.#workState = "settled";
		this.#currentRunId = undefined;
		for (const waiter of [...this.#settlementWaiters]) {
			if (waiter.started) waiter.resolve();
		}
		this.#emit({ type: "state_changed" });
		this.#emit({ type: "agent_settled" });
	}

	#acceptsLifecycleEvent(
		event: Extract<PiChildRuntimeEvent, { event: "agent.start" | "agent.end" | "agent.settled" }>,
	): boolean {
		const runId = event.payload.runId;
		if (this.#currentRunId === runId) return true;
		if (event.event === "agent.start" && this.#currentRunId === undefined) {
			// An authenticated child may begin a native interactive or extension-local
			// model cycle only after its awaited executionBegin request admitted the
			// Owner-side Run. Adopt that child-generated transport identity here.
			this.#currentRunId = runId;
			this.#latestRunId = runId;
			this.#runObserved = true;
			return true;
		}
		this.#endTransport(new Error(
			`stale_run: child lifecycle ${runId} does not match ${String(this.#currentRunId)}`,
		));
		return false;
	}

	#waitForSettlement(): SettlementWaiter {
		let settle!: () => void;
		let fail!: (error: unknown) => void;
		const waiter: SettlementWaiter = {
			started: this.#workState === "active",
			settled: false,
			result: new Promise<void>((resolve, reject) => {
				settle = resolve;
				fail = reject;
			}),
			resolve: () => {
				if (waiter.settled) return;
				waiter.settled = true;
				this.#settlementWaiters.delete(waiter);
				settle();
			},
			reject: (error) => {
				if (waiter.settled) return;
				waiter.settled = true;
				this.#settlementWaiters.delete(waiter);
				fail(error);
			},
		};
		this.#settlementWaiters.add(waiter);
		if (this.#unavailable) waiter.reject(this.#unavailable);
		return waiter;
	}

	#updateQueuedInputCount(count: number): void {
		if (this.#queuedInputCount === count) return;
		this.#queuedInputCount = count;
		this.#emit({ type: "state_changed" });
	}

	#clearCompaction(): void {
		if (!this.#compacting) return;
		this.#compacting = false;
		this.#emit({ type: "state_changed" });
	}

	#rejectPendingCompletions(error: unknown): void {
		for (const waiter of [...this.#settlementWaiters, ...this.#dispatchCompletions.values()]) {
			waiter.reject(error);
		}
		this.#dispatchCompletions.clear();
	}

	#endTransport(error: unknown, cause: "failure" | "shutdown" = "failure"): void {
		if (this.#unavailable) return;
		// Owner-side Run admission can precede the first model cycle. A ready child
		// dying in that gap is still a terminal failure, not an idle clean runtime.
		const terminalRun = (this.#runObserved || this.#snapshot !== undefined) && cause === "failure";
		this.#unavailable = error;
		this.#reminderAdmissionAbort?.abort(error);
		this.#cancellation.abort();
		this.#compacting = false;
		this.#workState = "unavailable";
		this.#currentRunId = undefined;
		this.#rejectPendingCompletions(error);
		if (terminalRun) {
			this.#emit({
				type: "agent_end", outcome: "error", willRetry: false,
				failure: {
					stage: "runtime", error: error instanceof Error ? error.message : String(error),
					provenance: "pi-child-hosted-runtime",
				},
			});
		}
		this.#emit({ type: "state_changed" });
		if (terminalRun) this.#emit({ type: "agent_settled" });
	}

	#emit(event: HostedRuntimeEvent): void {
		for (const handler of this.#handlers) handler(event);
	}
}

function serializeDelivery(delivery: AgentRuntimeDelivery) {
	if (delivery.kind === "user") {
		return {
			kind: delivery.kind,
			content: typeof delivery.content === "string"
				? delivery.content
				: delivery.content.map((part) => ({ ...part })),
			...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
			...(delivery.forwardedInput === undefined ? {} : { forwardedInput: { ...delivery.forwardedInput } }),
		};
	}
	return {
		kind: delivery.kind,
		message: "details" in delivery.message
			? {
				...delivery.message,
				details: {
					messages: delivery.message.details.messages.map((pointer) => ({ ...pointer })),
				},
			}
			: { ...delivery.message },
		triggerTurn: delivery.triggerTurn,
		...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
		...(delivery.workingZonePreparation === undefined
			? {}
			: {
				workingZonePreparation: {
					intent: { ...delivery.workingZonePreparation.intent },
					prospectiveRequest: {
						...delivery.workingZonePreparation.prospectiveRequest,
					},
				},
			}),
	};
}
