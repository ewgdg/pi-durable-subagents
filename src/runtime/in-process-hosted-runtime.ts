import { createModelVisibleModeratorObligationReminder } from "../protocol/moderator-obligation-reminder.ts";
import { classifyQuotaEvidence } from "./quota-evidence.ts";
import { RetainedRuntimeQueue } from "./retained-runtime-queue.ts";
import { bindSessionStartup, disposeSessionStartup, isStartupPreparationBusy, waitForStartupRelease } from "../pi-integration/session-startup.ts";
import type { CommitModeratorReminderIfCurrent, ModeratorReminderOutcome } from "./agent-runtime-host.ts";
import type {
	AgentSession,
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import type {
	AgentRuntimeDelivery,
	AgentRuntimeDeliveryDispatch,
	AgentRuntimeWorkState,
	EffectiveRuntimeSnapshot,
	ToolBatchClassification,
	TranscriptCommitConfirmation,
} from "./agent-runtime-host.ts";
import type {
	HostedAgentRuntime,
	HostedRuntimeEvent,
} from "./hosted-agent-runtime.ts";
import type { HostedAgentProjection } from "./hosted-agent-projection.ts";

export class InProcessHostedRuntime implements HostedAgentRuntime {
	readonly #session: AgentSession;
	readonly #quotaQueue: RetainedRuntimeQueue;
	#compacting: boolean;
	readonly projection: HostedAgentProjection | undefined;
	readonly #inspectSnapshot: () => EffectiveRuntimeSnapshot;

	constructor(options: {
		session: AgentSession;
		projection: HostedAgentProjection | undefined;
		inspectSnapshot(): EffectiveRuntimeSnapshot;
	}) {
		this.#session = options.session;
		this.#quotaQueue = new RetainedRuntimeQueue(() => this.#session.clearQueue());
		this.#compacting = options.session.isCompacting;
		this.projection = options.projection;
		this.#inspectSnapshot = options.inspectSnapshot;
	}

	static fromSession(options: {
		session: AgentSession;
		services: AgentSessionServices;
		projection: HostedAgentProjection | undefined;
	}): InProcessHostedRuntime {
		bindSessionStartup(options.session);
		return new InProcessHostedRuntime({
			session: options.session,
			projection: options.projection,
			inspectSnapshot: () => inspectInProcessRuntime(
				options.session,
				options.services,
			),
		});
	}

	snapshot(): EffectiveRuntimeSnapshot {
		return this.#inspectSnapshot();
	}

	synchronizeState(): Promise<void> {
		return Promise.resolve();
	}

	workState(): AgentRuntimeWorkState {
		return this.#session.isIdle ? "settled" : "active";
	}

	hasPendingActivity(): boolean {
		return this.#session.isCompacting || this.#session.pendingMessageCount > 0;
	}

	isCompacting(): boolean {
		return this.#compacting;
	}

	queuedInputCount(): number {
		return this.#session.pendingMessageCount;
	}

	classifyToolBatch(toolNames: readonly string[]): ToolBatchClassification {
		for (const toolName of toolNames) {
			// Batch names come from a committed model message, so one of them may name a
			// tool this session never registered. Pi decides sequential execution with
			// the same per-name definition lookup and tolerates an absent definition, so
			// classification must ignore that name rather than refuse the whole batch.
			if (this.#session.getToolDefinition(toolName)?.executionMode === "sequential") {
				return "blocking";
			}
		}
		return "asynchronous";
	}

	cancellationSignal(): AbortSignal {
		const signal = this.#session.agent.signal;
		if (!signal) {
			throw new Error("invariant_violation: current Agent Run has no cancellation signal");
		}
		return signal;
	}

	#cancellationRequested(): boolean {
		// Agent-core keeps the exact Run's controller until its listeners settle, so
		// this reads the terminal Run's own cancellation state at agent_end.
		return this.#session.agent?.signal?.aborted === true;
	}

	deliver(
		delivery: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	): AgentRuntimeDeliveryDispatch {
		if (!confirmation) return { completion: this.#dispatch(delivery) };
		let completion!: Promise<void>;
		const transcriptCommit = this.#sendAndConfirmTranscriptCommit(
			delivery,
			confirmation.inspectCommit,
			(dispatched) => {
				completion = dispatched;
			},
		);
		return { completion, transcriptCommit };
	}

	async deliverModeratorReminder(commitIfCurrent: CommitModeratorReminderIfCurrent): Promise<ModeratorReminderOutcome> {
		const admission = bindSessionStartup(this.#session);
		if (!this.#session.isIdle || admission.isPreparing) return "busy";
		return commitIfCurrent(async () => {
			// Recheck after the reconciliation-lane admission; never enter a native queue.
			if (!this.#session.isIdle || admission.isPreparing) return "busy";
			const message = createModelVisibleModeratorObligationReminder();
			const existing = new Set(this.#session.sessionManager.getEntries().map(entry => entry.id));
			const dispatched = this.deliver({ kind: "custom", message, triggerTurn: true }, {
				inspectCommit: () => this.#session.sessionManager.getEntries().some(entry =>
					!existing.has(entry.id) && entry.type === "custom_message" && entry.customType === message.customType),
			});
			if (!await dispatched.transcriptCommit) throw new Error("moderator_reminder_commit_missing");
			return "committed";
		});
	}

	subscribe(handler: (event: HostedRuntimeEvent) => void): () => void {
		return this.#session.subscribe((event) => {
			// Native auto-compaction clears its controller after emitting the end event.
			// Presentation follows the event edge rather than sampling that stale flag.
			if (event.type === "compaction_start") this.#compacting = true;
			if (event.type === "compaction_end") this.#compacting = false;
			if (
				event.type === "agent_start" ||
				event.type === "queue_update" ||
				event.type === "compaction_start" ||
				event.type === "compaction_end" ||
				event.type === "thinking_level_changed"
			) handler({ type: "state_changed" });
			if (event.type === "agent_end") {
				const assistant = [...event.messages]
					.reverse()
					.find((message) => message.role === "assistant");
				// Pi reports a request setup that its own abort signal abandoned as a
				// model error message carrying the abort reason, so the cancelled Run
				// would otherwise enter terminal failure handling. Cancellation is the
				// deliberate stop of this exact Run: it is never an unexpected failure,
				// and a successor Run is admitted by ordinary input instead.
				const outcome: "completed" | "aborted" | "error" =
					assistant?.role === "assistant" && assistant.stopReason === "error"
						? this.#cancellationRequested() ? "aborted" : "error"
						: assistant?.role === "assistant" && assistant.stopReason === "aborted"
							? "aborted"
							: "completed";
				const quota = outcome === "error" && assistant?.role === "assistant"
					? classifyQuotaEvidence(assistant) : undefined;
				// Pi checks queued continuation after this synchronous callback. Leave
				// configured retries untouched, but fence terminal quota before publishing.
				if (quota && !event.willRetry) this.#quotaQueue.capture();
				handler({
					type: "agent_end", outcome, willRetry: event.willRetry,
					...(quota ? { quota } : {}),
					...(outcome === "error" && assistant?.role === "assistant" && assistant.errorMessage !== undefined
						? { failure: { stage: "model", error: assistant.errorMessage, provenance: "in-process-hosted-runtime" } }
						: {}),
				});
			}
			if (event.type === "agent_settled") handler({ type: "agent_settled" });
		});
	}

	async clearQueue(): Promise<Readonly<{ steering: string[]; followUp: string[] }>> {
		return this.#quotaQueue.clear();
	}

	abort(): Promise<void> {
		return this.#session.abort();
	}

	waitForIdle(): Promise<void> {
		return this.#session.waitForIdle();
	}

	async dispose(): Promise<void> {
		disposeSessionStartup(this.#session);
		await this.#session.dispose();
	}

	async #dispatch(delivery: AgentRuntimeDelivery): Promise<void> {
		if (delivery.kind === "custom") return this.#dispatchCustom(delivery);
		if (delivery.forwardedInput) {
			bindSessionStartup(this.#session).captureInputHandoff()?.();
		}
		return this.#session.sendUserMessage(
				typeof delivery.content === "string" ? delivery.content : [...delivery.content],
				{
					...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
				},
		);
	}

	async #dispatchCustom(delivery: Extract<AgentRuntimeDelivery, { kind: "custom" }>): Promise<void> {
		const admission = bindSessionStartup(this.#session);
		const cancellation = admission.signal;
		for (;;) {
			try {
				await admission.dispatchCustom(delivery.message, {
					triggerTurn: delivery.triggerTurn,
					...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
				}, () => cancellation.throwIfAborted()).completion;
				return;
			} catch (error) {
				if (!isStartupPreparationBusy(error)) throw error;
				// Only retry uncommitted busy admission; never override handled input.
				await waitForStartupRelease(error.whenReleased, cancellation);
			}
		}
	}

	#sendAndConfirmTranscriptCommit(
		delivery: AgentRuntimeDelivery,
		inspectCommit: () => boolean,
		onDispatched: (completion: Promise<void>) => void,
	): Promise<boolean> {
		let settleCommit!: (committed: boolean) => void;
		let rejectCommit!: (error: unknown) => void;
		const commit = new Promise<boolean>((resolve, reject) => {
			settleCommit = resolve;
			rejectCommit = reject;
		});
		let settled = false;
		const inspectAfterPersistence = () => queueMicrotask(() => {
			if (settled) return;
			try {
				if (!inspectCommit()) return;
				settled = true;
				settleCommit(true);
			} catch (error) {
				settled = true;
				rejectCommit(error);
			}
		});
		const unsubscribe = this.#session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				(
					(delivery.kind === "custom" && event.message.role === "custom") ||
					(delivery.kind === "user" && event.message.role === "user")
				)
			) inspectAfterPersistence();
		});
		const completion = this.#dispatch(delivery);
		onDispatched(completion);
		void completion.then(
			() => {
				if (settled) return;
				inspectAfterPersistence();
				queueMicrotask(() => {
					if (settled) return;
					settled = true;
					settleCommit(false);
				});
			},
			(error) => {
				if (settled) return;
				settled = true;
				rejectCommit(error);
			},
		);
		return commit.finally(unsubscribe);
	}
}

function inspectInProcessRuntime(
	session: AgentSession,
	services: AgentSessionServices,
): EffectiveRuntimeSnapshot {
	const model = session.model;
	if (!model) throw new Error("Agent Runtime model is unavailable");
	return {
		cwd: services.cwd,
		model: { provider: model.provider, modelId: model.id },
		thinking: session.thinkingLevel,
		tools: [...session.getActiveToolNames()],
		skills: services.resourceLoader.getSkills().skills.map(({ name }) => name),
		skillSources: services.resourceLoader.getSkills().skills.map(({ name, filePath }) => ({
			name,
			filePath,
		})),
		fileExtensionPaths: services.resourceLoader
			.getExtensions()
			.extensions.map(({ resolvedPath }) => resolvedPath),
		projectTrusted: services.settingsManager.isProjectTrusted(),
		sessionId: session.sessionManager.getSessionId(),
	};
}
