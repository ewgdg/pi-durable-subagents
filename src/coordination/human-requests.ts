import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "./agent-record.ts";
import {
	resolveCommittedHumanRequest,
	inspectCommittedHumanRequestResult,
	validateHumanAnswer,
	type HumanAnswer,
	type HumanAnswerCandidate,
	type HumanRequest,
	type HumanRequestInput,
} from "../protocol/human-request.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import type { AgentRunHandle } from "../runtime/agent-runtime-host.ts";
import type { ToolCallPointer } from "../protocol/identities.ts";
const INTERRUPTED_MESSAGE = "Human request interrupted before an answer was provided.";
const FENCED_MESSAGE = "Human request ended because its Agent Run is no longer available.";
const INTERACTIVE_EDITOR_REQUIRED_MESSAGE =
	"Human Request requires an interactive Agent editor.";
const IMAGE_ANSWER_UNSUPPORTED_MESSAGE =
	"Human Answers do not support images. Remove the image and submit text only.";

type PendingPhase = "open" | "submitted" | "fenced";

type PendingHumanRequest = {
	request: HumanRequest;
	record: AgentRecord;
	handle: AgentRunHandle;
	signal: AbortSignal;
	phase: PendingPhase;
	answerCandidate?: HumanAnswerCandidate;
	resolve(candidate: HumanAnswerCandidate): void;
	reject(error: Error): void;
	removeAbortListener(): void;
};

export type HumanAttentionItem = Readonly<{
	requestId: string;
	agentId: string;
	agentLabel: string;
	question: string;
}>;

export type GuardedHumanToolResult = Readonly<{
	message?: MessageEndEvent["message"];
	rejectedAnswer?: string;
	reason?: string;
}>;

// Tests may force only the concrete admission and pre-append races below. The
// hook cannot access a session, host, or Run handle, and its fence is pinned to
// the exact admitted Run.
export type HumanRequestBoundaryHooks = Readonly<{
	afterAdmission?(context: Readonly<{
		agentId: string;
		requestId: string;
		fenceExactRun(): Promise<void>;
	}>): void;
	beforeResultCommit?(context: Readonly<{
		agentId: string;
		requestId: string;
		failExactRun(): void;
	}>): void;
}>;

export class HumanRequestCoordinator {
	readonly #agents: Map<string, AgentRecord>;
	readonly #ownerIdentity: OwnerIdentity;
	readonly #boundaryHooks: HumanRequestBoundaryHooks;
	readonly #interruptRun: (record: AgentRecord) => void;
	readonly #suspendExecution: (record: AgentRecord) => void;
	readonly #beginHumanWaiting: (source: ToolCallPointer) => void;
	readonly #beginHumanResultCommit: (source: ToolCallPointer) => void;
	readonly #onAttentionChanged: () => void;
	readonly #pendingByRequestId = new Map<string, PendingHumanRequest>();

	constructor(options: {
		agents: Map<string, AgentRecord>;
		ownerIdentity: OwnerIdentity;
		boundaryHooks?: HumanRequestBoundaryHooks;
		interruptRun(record: AgentRecord): void;
		suspendExecution(record: AgentRecord): void;
		beginHumanWaiting(source: ToolCallPointer): void;
		beginHumanResultCommit(source: ToolCallPointer): void;
		onAttentionChanged?(): void;
	}) {
		this.#agents = options.agents;
		this.#ownerIdentity = options.ownerIdentity;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#interruptRun = options.interruptRun;
		this.#suspendExecution = options.suspendExecution;
		this.#beginHumanWaiting = options.beginHumanWaiting;
		this.#beginHumanResultCommit = options.beginHumanResultCommit;
		this.#onAttentionChanged = options.onAttentionChanged ?? (() => undefined);
	}

	async ask(
		callerAgentId: string,
		toolCallId: string,
		input: HumanRequestInput,
		signal: AbortSignal | undefined,
	): Promise<HumanAnswerCandidate> {
		if (!signal) {
			throw new Error("invariant_violation: Human Request has no active Run signal");
		}
		if (signal.aborted) throw new Error(INTERRUPTED_MESSAGE);
		const record = this.#requireAgent(callerAgentId);
		const request = resolveCommittedHumanRequest({
			agentId: callerAgentId,
			transcript: record.transcript.inspect(),
			toolCallId,
			providedInput: input,
		});
		const handle = record.host.currentHandle();
		if (!handle) throw new Error("Agent Run is unavailable");
		if (!record.host.currentProjection()) {
			throw new Error(INTERACTIVE_EDITOR_REQUIRED_MESSAGE);
		}
		if (this.#pendingForAgent(callerAgentId)) {
			throw new Error(
				`invalid_state: Agent ${callerAgentId} already has an unresolved Human Request`,
			);
		}
		if (this.#pendingByRequestId.has(request.requestId)) {
			throw new Error(`invariant_violation: Human Request ${request.requestId} is already pending`);
		}
		let resolveCandidate!: (candidate: HumanAnswerCandidate) => void;
		let rejectAnswer!: (error: Error) => void;
		const candidatePromise = new Promise<HumanAnswerCandidate>((resolve, reject) => {
			resolveCandidate = resolve;
			rejectAnswer = reject;
		});
		const onAbort = () => {
			// The default editor expresses Escape through the Run signal. Translate
			// that native abort into the exact Hold path without capturing Escape.
			this.#interruptRun(record);
			this.#fence(request.requestId, INTERRUPTED_MESSAGE);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const pending: PendingHumanRequest = {
			request,
			record,
			handle,
			signal,
			phase: "open",
			resolve: resolveCandidate,
			reject: rejectAnswer,
			removeAbortListener: () => signal.removeEventListener("abort", onAbort),
		};
		record.host.setRunFenceHandler((fencedHandle) =>
			this.#fenceRun(callerAgentId, fencedHandle),
		);
		try {
			record.host.beginInputRequired(handle, request.requestId);
			this.#suspendExecution(record);
			this.#pendingByRequestId.set(request.requestId, pending);
			this.#beginHumanWaiting(request.source);
			this.#onAttentionChanged();
			this.#boundaryHooks.afterAdmission?.({
				agentId: callerAgentId,
				requestId: request.requestId,
				fenceExactRun: () => record.host.lane.run(() => {
					if (!record.host.isCurrent(handle)) return;
					return record.host.discardAndEndInLane("failure");
				}),
			});
		} catch (error) {
			if (this.#pendingByRequestId.has(request.requestId)) {
				this.#complete(pending);
			} else {
				pending.removeAbortListener();
			}
			throw error;
		}
		return candidatePromise;
	}

	submitAnswer(
		callerAgentId: string,
		answerText: string,
		hasImages: boolean,
	): boolean {
		const pending = this.#pendingForAgent(callerAgentId);
		if (!pending) return false;
		if (hasImages) throw new Error(IMAGE_ANSWER_UNSUPPORTED_MESSAGE);
		if (pending.phase !== "open") {
			throw new Error("stale_request: Human Answer is already pending commitment");
		}
		if (
			pending.signal.aborted ||
			!pending.record.host.acceptsInputRequired(
				pending.handle,
				pending.request.requestId,
			)
		) {
			this.#fence(pending.request.requestId, FENCED_MESSAGE);
			throw new Error(FENCED_MESSAGE);
		}
		const candidate = validateHumanAnswer(pending.request.requestId, {
			requestId: pending.request.requestId,
			answer: answerText,
		});
		pending.phase = "submitted";
		pending.answerCandidate = candidate;
		this.#beginHumanResultCommit(pending.request.source);
		pending.resolve(candidate);
		return true;
	}

	guardResultCommit(
		callerAgentId: string,
		message: MessageEndEvent["message"],
	): GuardedHumanToolResult | undefined {
		if (
			message.role !== "toolResult" ||
			message.toolName !== "ask_user"
		) return undefined;
		const pending = [...this.#pendingByRequestId.values()].find(
			(candidate) =>
				candidate.request.requesterAgentId === callerAgentId &&
				candidate.request.source.toolCallId === message.toolCallId,
		);
		if (!pending) return undefined;
		if (message.isError) {
			return this.#rejectedCandidate(pending, messageText(message));
		}
		if (pending.phase === "submitted") {
			this.#boundaryHooks.beforeResultCommit?.({
				agentId: callerAgentId,
				requestId: pending.request.requestId,
				failExactRun: () => pending.record.host.failExactRun(pending.handle),
			});
		}
		if (
			!pending.record.host.acceptsInputRequired(
				pending.handle,
				pending.request.requestId,
			)
		) {
			this.#fence(pending.request.requestId, FENCED_MESSAGE);
		}
		if (pending.phase !== "fenced") return undefined;
		const replacement = {
			...message,
			content: [{ type: "text" as const, text: FENCED_MESSAGE }],
			details: undefined,
			isError: true,
		};
		return {
			message: replacement,
			...this.#rejectedCandidate(pending, FENCED_MESSAGE),
		};
	}

	reconcileCommittedResults(callerAgentId: string): void {
		for (const pending of [...this.#pendingByRequestId.values()]) {
			if (pending.request.requesterAgentId !== callerAgentId) continue;
			const inspection = inspectCommittedHumanRequestResult({
				request: pending.request,
				transcript: pending.record.transcript.inspect(),
			});
			if (inspection.state === "pending") continue;
			if (
				inspection.state === "answered" &&
				!sameCommittedAnswerToCandidate(
					inspection.answer,
					pending.answerCandidate,
				)
			) {
				throw new Error(
					`invariant_violation: Human Answer ${pending.request.requestId} differs from its submission`,
				);
			}
			this.#complete(pending);
		}
	}

	attentionItems(callerAgentId: string): readonly HumanAttentionItem[] {
		const caller = this.#requireAgent(callerAgentId);
		return [...this.#pendingByRequestId.values()]
			.map((pending) => ({
				requestId: pending.request.requestId,
				agentId: pending.request.requesterAgentId,
				agentLabel: pending.record.identity.metadata.label,
				question: pending.request.question,
			}))
			.filter((item) => {
				const itemAgentId = item.agentId;
				if (callerAgentId === this.#ownerIdentity.agentId) return true;
				if (itemAgentId === callerAgentId) return true;
				return this.#agents.get(itemAgentId)?.identity.directSpawnerAgentId ===
					caller.identity.agentId;
			});
	}

	// Fenced calls may remain until their native error result commits, but they
	// no longer accept an Answer and must not keep human-input presentation active.
	hasPendingQuestions(): boolean {
		return [...this.#pendingByRequestId.values()].some(({ phase }) => phase !== "fenced");
	}

	hasPendingRequest(agentId: string, requestId?: string): boolean {
		const pending = this.#pendingForAgent(agentId);
		return pending !== undefined && (
			requestId === undefined || pending.request.requestId === requestId
		);
	}

	#rejectedCandidate(
		pending: PendingHumanRequest,
		reason: string,
	): GuardedHumanToolResult | undefined {
		return pending.answerCandidate
			? { rejectedAnswer: pending.answerCandidate.answer, reason }
			: undefined;
	}

	#pendingForAgent(agentId: string): PendingHumanRequest | undefined {
		return [...this.#pendingByRequestId.values()].find(
			(pending) => pending.request.requesterAgentId === agentId,
		);
	}

	#fenceRun(agentId: string, handle: AgentRunHandle): void {
		let matched = false;
		for (const pending of this.#pendingByRequestId.values()) {
			if (pending.request.requesterAgentId !== agentId || pending.handle !== handle) continue;
			matched = true;
			this.#fence(pending.request.requestId, FENCED_MESSAGE);
		}
		if (!matched) return;
		const record = this.#requireAgent(agentId);
		// Failure notification can originate inside an existing lane disposal. Queue
		// exact-handle cleanup so it cannot re-enter that disposal or touch a successor.
		void record.host.lane.run(() => {
			if (!record.host.isCurrent(handle)) return;
			return record.host.discardAndEndInLane("failure");
		});
	}

	#fence(requestId: string, message: string): void {
		const pending = this.#pendingByRequestId.get(requestId);
		if (!pending || pending.phase === "fenced") return;
		pending.phase = "fenced";
		this.#beginHumanResultCommit(pending.request.source);
		// Submission and fencing are synchronous phase transitions. The last
		// pre-append guard above rechecks this phase, so an asynchronous Run fence
		// can still defeat a submitted candidate until native result commitment.
		this.#onAttentionChanged();
		pending.reject(new Error(message));
	}

	#complete(pending: PendingHumanRequest): void {
		pending.removeAbortListener();
		pending.record.host.endInputRequired(pending.handle, pending.request.requestId);
		this.#pendingByRequestId.delete(pending.request.requestId);
		this.#onAttentionChanged();
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}
}

function sameCommittedAnswerToCandidate(
	value: HumanAnswer,
	expected: HumanAnswerCandidate | undefined,
): boolean {
	return expected !== undefined && JSON.stringify(value) === JSON.stringify(expected);
}

function messageText(message: Extract<MessageEndEvent["message"], { role: "toolResult" }>): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(({ text }) => text)
		.join("\n");
}
