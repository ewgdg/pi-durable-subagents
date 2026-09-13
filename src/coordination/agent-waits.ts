import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import type { AgentRecord } from "./agent-record.ts";
import type { MessageCoordinator } from "./messages.ts";
import {
	inspectCommittedAgentWaitResult,
	resolveCommittedAgentWaitCall,
	type AgentWaitInput,
	type AgentWaitProgress,
	type AgentWaitResult,
} from "../protocol/agent-wait.ts";
import type { AgentRunHandle } from "../runtime/agent-runtime-host.ts";

const ANSWER_WAIT_RECONCILIATION_INTERVAL_MS = 5_000;
const INTERRUPTED_MESSAGE = "Agent Wait interrupted before all Answers arrived.";
const FENCED_MESSAGE = "Agent Wait ended because its Agent Run is no longer available.";
const PREEMPTED_RESULT = Object.freeze({ disposition: "preempted" as const });

export type AgentWaitClock = Readonly<{
	schedule(delayMs: number, callback: () => void): () => void;
}>;

export const SYSTEM_AGENT_WAIT_CLOCK: AgentWaitClock = {
	schedule(delayMs, callback) {
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

export type AgentWaitBoundaryHooks = Readonly<{
	beforePreemptionDecision?(context: Readonly<{
		agentId: string;
		toolCallId: string;
	}>): void;
	beforeResultCommit?(context: Readonly<{
		agentId: string;
		toolCallId: string;
		failExactRun(): void;
	}>): void;
}>;

export type GuardedAgentWaitToolResult = Readonly<{
	message: MessageEndEvent["message"];
}>;

type PendingAgentWait = {
	callerAgentId: string;
	toolCallId: string;
	requestMessageIds: readonly string[];
	record: AgentRecord;
	handle: AgentRunHandle;
	signal: AbortSignal;
	phase: "waiting" | "resuming" | "result_pending" | "fenced";
	candidate?: AgentWaitResult;
	cancelTimer: (() => void) | undefined;
	resolve(result: AgentWaitResult): void;
	reject(error: Error): void;
	removeAbortListener(): void;
	removeEndedHandler(): void;
	reconcileRequestDeliveries(): Promise<void>;
};

export class AgentWaitCoordinator {
	readonly #agents: Map<string, AgentRecord>;
	readonly #messages: MessageCoordinator;
	readonly #boundaryHooks: AgentWaitBoundaryHooks;
	readonly #clock: AgentWaitClock;
	readonly #suspendExecution: (record: AgentRecord) => void;
	readonly #resumeExecution: (record: AgentRecord) => Promise<void>;
	readonly #pendingByKey = new Map<string, PendingAgentWait>();
	#shuttingDown = false;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		messages: MessageCoordinator;
		boundaryHooks?: AgentWaitBoundaryHooks;
		clock?: AgentWaitClock;
		suspendExecution(record: AgentRecord): void;
		resumeExecution(record: AgentRecord): Promise<void>;
	}) {
		this.#agents = options.agents;
		this.#messages = options.messages;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#clock = options.clock ?? SYSTEM_AGENT_WAIT_CLOCK;
		this.#suspendExecution = options.suspendExecution;
		this.#resumeExecution = options.resumeExecution;
	}

	async wait(
		callerAgentId: string,
		toolCallId: string,
		providedInput: AgentWaitInput,
		signal: AbortSignal | undefined,
		onProgress?: (progress: AgentWaitProgress) => void,
	): Promise<AgentWaitResult> {
		await this.#messages.refreshTranscriptFacts();
		if (!signal) {
			throw new Error("invariant_violation: Agent Wait has no active Run signal");
		}
		if (signal.aborted) throw new Error(INTERRUPTED_MESSAGE);
		if (this.#shuttingDown) {
			throw new Error("host_shutting_down: Workflow is shutting down");
		}
		const caller = this.#requireAgent(callerAgentId);
		const call = resolveCommittedAgentWaitCall({
			agentId: callerAgentId,
			transcript: caller.transcript.inspect(),
			toolCallId,
			providedInput,
		});
		const requestMessageIds = this.#messages.outstandingRequestIds(
			callerAgentId,
			call.source,
			call.input.requestMessageIds,
		);
		const requestRelationships = this.#messages.requestRelationships(requestMessageIds);
		onProgress?.({
			waitingFor: requestRelationships.map(({ requestId, requestTitle, targetAgentId }) => ({
				requestMessageId: requestId,
				requestTitle,
				responderAgentId: targetAgentId,
			})),
		});
		const completed = this.#messages.waitAnswers(
			callerAgentId,
			requestMessageIds,
		);
		const handle = caller.host.currentHandle();
		if (!handle) throw new Error("Agent Run is unavailable");
		const key = waitKey(callerAgentId, toolCallId);
		if (this.#pendingByKey.has(key)) {
			throw new Error(`invariant_violation: Agent Wait ${toolCallId} is already pending`);
		}

		let resolveWait!: (result: AgentWaitResult) => void;
		let rejectWait!: (error: Error) => void;
		const result = new Promise<AgentWaitResult>((resolve, reject) => {
			resolveWait = resolve;
			rejectWait = reject;
		});
		const onAbort = () => this.#fence(callerAgentId, toolCallId, INTERRUPTED_MESSAGE);
		signal.addEventListener("abort", onAbort, { once: true });
		const pending: PendingAgentWait = {
			callerAgentId,
			toolCallId,
			requestMessageIds,
			record: caller,
			handle,
			signal,
			phase: "waiting",
			cancelTimer: undefined,
			resolve: resolveWait,
			reject: rejectWait,
			removeAbortListener: () => signal.removeEventListener("abort", onAbort),
			removeEndedHandler: () => undefined,
			reconcileRequestDeliveries: this.#messages.createRequestDeliveryReconciler(
				callerAgentId, requestMessageIds,
				() => pending.phase === "waiting" && !signal.aborted && caller.host.isCurrent(handle),
			),
		};
		pending.removeEndedHandler = caller.host.addEndedHandler((endedHandle) => {
			if (endedHandle !== handle) return;
			this.#fence(callerAgentId, toolCallId, FENCED_MESSAGE);
			this.#complete(pending);
		});
		this.#pendingByKey.set(key, pending);
		if (completed) {
			pending.phase = "result_pending";
			pending.candidate = completed;
			pending.resolve(completed);
		} else {
			try {
				caller.host.beginAgentWait(handle, toolCallId);
				this.#suspendExecution(caller);
				void this.#messages.deliveryEligibilityChanged(caller).catch((error: unknown) => {
					this.#fence(
						callerAgentId,
						toolCallId,
						error instanceof Error ? error.message : String(error),
					);
				});
			} catch (error) {
				this.#complete(pending);
				throw error;
			}
			this.#scheduleReconciliation(pending);
			void this.#reconcile(pending);
		}
		return result;
	}

	preemptForInboundRequest(
		record: AgentRecord,
		reserveDelivery: () => boolean,
	): Promise<void> {
		return this.#preempt(record, reserveDelivery);
	}

	preemptForHumanInput(record: AgentRecord): Promise<void> {
		return this.#preempt(record);
	}

	async #preempt(
		record: AgentRecord,
		reservePreemptingDelivery?: () => boolean,
	): Promise<void> {
		const pending = [...this.#pendingByKey.values()].find(
			(candidate) =>
				candidate.record === record &&
				candidate.phase === "waiting",
		);
		if (!pending) return;
		let completed: AgentWaitResult | undefined;
		try {
			this.#boundaryHooks.beforePreemptionDecision?.({
				agentId: pending.callerAgentId,
				toolCallId: pending.toolCallId,
			});
			// This is the race boundary: the complete outstanding snapshot wins
			// before new direction acquires the parked Run.
			completed = this.#messages.waitAnswers(
				pending.callerAgentId,
				pending.requestMessageIds,
			);
		} catch (error) {
			this.#fence(
				pending.callerAgentId,
				pending.toolCallId,
				error instanceof Error ? error.message : String(error),
			);
			return;
		}
		if (completed) {
			await this.#resumeWithResult(pending, completed);
			return;
		}
		if (!record.host.isCurrent(pending.handle)) return;
		if (reservePreemptingDelivery) {
			let reserved: boolean;
			try {
				reserved = reservePreemptingDelivery();
			} catch (error) {
				this.#fence(
					pending.callerAgentId,
					pending.toolCallId,
					error instanceof Error ? error.message : String(error),
				);
				return;
			}
			if (!reserved) return;
		}
		await this.#resumeWithResult(pending, PREEMPTED_RESULT);
	}

	guardResultCommit(
		callerAgentId: string,
		message: MessageEndEvent["message"],
	): GuardedAgentWaitToolResult | undefined {
		if (
			message.role !== "toolResult" ||
			message.toolName !== "agent_wait"
		) return undefined;
		const pending = this.#pendingByKey.get(waitKey(callerAgentId, message.toolCallId));
		if (!pending) return undefined;
		if (message.isError) return undefined;
		if (pending.phase === "result_pending") {
			this.#boundaryHooks.beforeResultCommit?.({
				agentId: callerAgentId,
				toolCallId: pending.toolCallId,
				failExactRun: () => pending.record.host.failExactRun(pending.handle),
			});
		}
		if (
			pending.phase === "result_pending" &&
			pending.record.host.isCurrent(pending.handle) &&
			!pending.record.host.currentRunFailed() &&
			isDeepStrictEqual(message.details, pending.candidate)
		) {
			if (pending.candidate && "disposition" in pending.candidate) return undefined;
			// A completed aggregate candidate may have lost to direct Delivery before
			// Pi commits it. Preemption has no Answer retrieval to re-arbitrate.
			const current = this.#messages.waitAnswers(
				callerAgentId,
				pending.requestMessageIds,
			);
			if (current) {
				if (isDeepStrictEqual(current, pending.candidate)) return undefined;
				pending.candidate = current;
				return { message: completedToolResult(message, current) };
			}
		}
		this.#fence(callerAgentId, pending.toolCallId, FENCED_MESSAGE);
		return { message: interruptedToolResult(message, FENCED_MESSAGE) };
	}

	reconcileCommittedResults(callerAgentId: string): void {
		const caller = this.#requireAgent(callerAgentId);
		for (const pending of [...this.#pendingByKey.values()]) {
			if (pending.callerAgentId !== callerAgentId) continue;
			const inspection = inspectCommittedAgentWaitResult({
				agentId: callerAgentId,
				transcript: caller.transcript.inspect(),
				toolCallId: pending.toolCallId,
			});
			if (inspection.state === "pending") continue;
			const committedResult = inspection.state === "completed"
				? inspection.result
				: inspection.state === "preempted"
					? PREEMPTED_RESULT
					: undefined;
			if (
				committedResult &&
				!isDeepStrictEqual(committedResult, pending.candidate)
			) {
				throw new Error(
					`invariant_violation: Agent Wait ${pending.toolCallId} committed a different result`,
				);
			}
			this.#complete(pending);
		}
	}

	reconcileCommittedAnswers(): void {
		for (const pending of this.#pendingByKey.values()) {
			void this.#reconcile(pending);
		}
	}

	shutdown(): void {
		this.#shuttingDown = true;
		for (const pending of [...this.#pendingByKey.values()]) {
			this.#fence(
				pending.callerAgentId,
				pending.toolCallId,
				"Agent Wait ended because the Workflow is shutting down.",
			);
			this.#complete(pending);
		}
	}

	async #reconcile(pending: PendingAgentWait): Promise<void> {
		if (pending.phase !== "waiting") return;
		let completed: AgentWaitResult | undefined;
		try {
			completed = this.#messages.waitAnswers(
				pending.callerAgentId,
				pending.requestMessageIds,
			);
			if (!completed) {
				// Proof gets checked before maintenance, whose in-flight passes
				// coalesce separately for each recipient.
				await pending.reconcileRequestDeliveries();
				if (pending.phase !== "waiting") return;
				completed = this.#messages.waitAnswers(
					pending.callerAgentId,
					pending.requestMessageIds,
				);
			}
		} catch (error) {
			// Delivery maintenance may finish after Answer completion or preemption.
			if (pending.phase !== "waiting") return;
			this.#fence(
				pending.callerAgentId,
				pending.toolCallId,
				error instanceof Error ? error.message : String(error),
			);
			return;
		}
		if (!completed) return;
		await this.#resumeWithResult(pending, completed);
	}

	async #resumeWithResult(
		pending: PendingAgentWait,
		result: AgentWaitResult,
	): Promise<void> {
		if (pending.phase !== "waiting") return;
		pending.phase = "resuming";
		this.#clearTimer(pending);
		try {
			pending.record.host.endAgentWait(pending.handle, pending.toolCallId);
			await this.#resumeExecution(pending.record);
			if (
				pending.signal.aborted ||
				!pending.record.host.isCurrent(pending.handle)
			) {
				this.#fence(pending.callerAgentId, pending.toolCallId, FENCED_MESSAGE);
				return;
			}
			pending.phase = "result_pending";
			pending.candidate = result;
			pending.resolve(result);
		} catch (error) {
			this.#fence(
				pending.callerAgentId,
				pending.toolCallId,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	#scheduleReconciliation(pending: PendingAgentWait): void {
		pending.cancelTimer = this.#clock.schedule(
			ANSWER_WAIT_RECONCILIATION_INTERVAL_MS,
			() => {
				pending.cancelTimer = undefined;
				if (pending.phase !== "waiting") return;
				// A slow recipient lane must not delay the next evidence/maintenance
				// pass for other recipients. Each recipient coalesces its own work.
				this.#scheduleReconciliation(pending);
				void this.#reconcile(pending);
			},
		);
	}

	#fence(callerAgentId: string, toolCallId: string, message: string): void {
		const pending = this.#pendingByKey.get(waitKey(callerAgentId, toolCallId));
		if (!pending || pending.phase === "fenced") return;
		pending.phase = "fenced";
		this.#clearTimer(pending);
		pending.reject(new Error(message));
	}

	#complete(pending: PendingAgentWait): void {
		pending.record.host.endAgentWait(pending.handle, pending.toolCallId);
		this.#clearTimer(pending);
		pending.removeAbortListener();
		pending.removeEndedHandler();
		this.#pendingByKey.delete(waitKey(pending.callerAgentId, pending.toolCallId));
	}

	#clearTimer(pending: PendingAgentWait): void {
		pending.cancelTimer?.();
		pending.cancelTimer = undefined;
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}
}

function waitKey(agentId: string, toolCallId: string): string {
	return JSON.stringify([agentId, toolCallId]);
}

function completedToolResult(
	message: Extract<MessageEndEvent["message"], { role: "toolResult" }>,
	result: AgentWaitResult,
): Extract<MessageEndEvent["message"], { role: "toolResult" }> {
	return {
		...message,
		content: [{ type: "text", text: JSON.stringify(result) }],
		details: result,
	};
}

function interruptedToolResult(
	message: Extract<MessageEndEvent["message"], { role: "toolResult" }>,
	reason: string,
): Extract<MessageEndEvent["message"], { role: "toolResult" }> {
	return {
		...message,
		content: [{ type: "text", text: reason }],
		details: undefined,
		isError: true,
	};
}
