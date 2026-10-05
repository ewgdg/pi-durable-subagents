import { isDeepStrictEqual } from "node:util";
import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { AgentRunFailure, AgentRuntimeDelivery, UserCommitTextRule } from "../runtime/agent-runtime-host.ts";
import { classifyQuotaEvidence, type QuotaEvidence } from "../runtime/quota-evidence.ts";
import { RetainedRuntimeQueue, type RuntimeQueue } from "../runtime/retained-runtime-queue.ts";
import {
	bindSessionStartup,
	disposeSessionStartup,
	isStartupPreparationBusy,
	type StartupPreparationBusyError,
	waitForStartupRelease,
} from "./session-startup.ts";

/** The single Run-outcome vocabulary of the Owner Runtime, the child bridge, and the Control wire. */
export const NATIVE_RUN_OUTCOMES = ["completed", "aborted", "error"] as const;
export type NativeRunOutcome = (typeof NATIVE_RUN_OUTCOMES)[number];

const MODEL_FAILURE_PROVENANCE = "native-session-driver";

export type NativeRunEnd = Readonly<{
	outcome: NativeRunOutcome;
	willRetry: boolean;
	failure?: AgentRunFailure;
	quota?: QuotaEvidence;
}>;

export type NativeSessionEvent =
	| Readonly<{ type: "run_started" }>
	| Readonly<{ type: "run_ended" } & NativeRunEnd>
	| Readonly<{ type: "run_settled" }>
	| Readonly<{ type: "compaction_changed"; compacting: boolean }>
	| Readonly<{ type: "state_changed" }>;

/**
 * Wraps one dispatch attempt. A busy startup preparation leaves `admit` before
 * the driver waits for its release, so a gate held here never waits on it.
 */
export type TurnAdmission = Readonly<{
	admit<T>(attempt: (checkpoint: () => void) => Promise<T>): Promise<T>;
	/** Runs the synchronous native submission; `fence` fails it before Pi sees it. */
	submit?<T>(submission: () => T, fence: () => void): T | Promise<T>;
	/** The submission passed a fence inside Pi and may now start a native Run. */
	accepted?(): void;
}>;

export type NativeDeliveryOptions = Readonly<{
	proveCommit?: boolean;
	/** The text rule of a proven user Delivery; "exact" unless the caller tolerates appends. */
	userCommitText?: UserCommitTextRule;
	admission?: TurnAdmission;
	/** Cancels the Delivery until Pi accepts its submission. */
	signal?: AbortSignal;
}>;

export type NativeDeliveryDispatch = Readonly<{
	/** Settles with Pi's dispatch: Run completion, or native queue acceptance. */
	completion: Promise<void>;
	/** Pi accepted the submission; `runActive` samples the session right after. */
	preflight: Promise<Readonly<{ runActive: boolean }>>;
	transcriptCommit?: Promise<boolean>;
}>;

type CustomDelivery = Extract<AgentRuntimeDelivery, { kind: "custom" }>;
type SessionMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];
type NativeSubmission = Readonly<{ completion: Promise<void>; preflight: Promise<void> }>;
type AcceptedAttempt = Readonly<{ completion: Promise<void>; runActive: boolean }>;
type BusyAttempt = Readonly<{ busy: StartupPreparationBusyError; startupCancellation: AbortSignal }>;

const IMMEDIATE_ADMISSION: TurnAdmission = { admit: attempt => attempt(() => undefined) };

/**
 * Drives one Pi AgentSession binding generation for both Agent Runtimes: the
 * Owner's in-process Runtime and each child bridge generation.
 */
export class NativeSessionDriver {
	readonly #session: AgentSession;
	readonly #listeners = new Set<(event: NativeSessionEvent) => void>();
	readonly #retainedQueue: RetainedRuntimeQueue;
	readonly #proofs = new Set<TranscriptCommitProof>();
	#unsubscribeSession: (() => void) | undefined;
	#compacting: boolean;
	#disposed = false;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#compacting = session.isCompacting;
		this.#retainedQueue = new RetainedRuntimeQueue(() => session.clearQueue());
		bindSessionStartup(session);
	}

	deliver(delivery: AgentRuntimeDelivery, options: NativeDeliveryOptions = {}): NativeDeliveryDispatch {
		const proof = options.proveCommit ? this.#createProof(delivery, options.userCommitText ?? "exact") : undefined;
		const accepted = this.#dispatch(delivery, options.admission ?? IMMEDIATE_ADMISSION, options, proof);
		const completion = accepted.then(attempt => attempt.completion);
		void completion.then(() => proof?.dispatchCompleted(), error => proof?.reject(error));
		const preflight = accepted.then(({ runActive }) => ({ runActive }));
		void preflight.catch(() => undefined);
		return { completion, preflight, ...(proof ? { transcriptCommit: proof.result } : {}) };
	}

	subscribe(listener: (event: NativeSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		// One session subscription serves every listener, so classification and
		// queue capture run once before any listener observes the Run end.
		this.#unsubscribeSession ??= this.#session.subscribe(event => this.#handleSessionEvent(event));
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size > 0) return;
			this.#unsubscribeSession?.();
			this.#unsubscribeSession = undefined;
		};
	}

	/** Returns native queued input together with input retained at a terminal error. */
	clearQueue(): RuntimeQueue {
		return this.#retainedQueue.clear();
	}

	queuedInputCount(): number {
		return this.#session.pendingMessageCount;
	}

	/**
	 * Starts and proves one custom Run only when nothing else could own the turn: a
	 * busy session never receives it, so it can never enter a native queue.
	 */
	async commitIdleCustom(
		message: CustomDelivery["message"],
		options: Omit<NativeDeliveryOptions, "proveCommit"> = {},
	): Promise<"busy" | "committed"> {
		if (!this.canStartIdleTurn()) return "busy";
		const dispatch = this.deliver({ kind: "custom", message, triggerTurn: true }, { ...options, proveCommit: true });
		if (!await dispatch.transcriptCommit) throw new Error("idle_custom_commit_missing: the started Run did not commit the exact Delivery");
		return "committed";
	}

	/** No native Run is active and no input is preparing to start one. */
	canStartIdleTurn(): boolean {
		return this.#session.isIdle && !this.#startup().isPreparing;
	}

	isIdle(): boolean {
		return this.#session.isIdle;
	}

	/** Follows Pi's compaction edges; its flag stays set briefly after auto-compaction ends. */
	isCompacting(): boolean {
		return this.#compacting;
	}

	hasPendingActivity(): boolean {
		return this.#session.isCompacting || this.#session.pendingMessageCount > 0;
	}

	/** The active Run's own cancellation signal. */
	cancellationSignal(): AbortSignal {
		const signal = this.#session.agent.signal;
		if (!signal) throw new Error("invariant_violation: current Agent Run has no cancellation signal");
		return signal;
	}

	abort(): Promise<void> {
		return this.#session.abort();
	}

	waitForIdle(): Promise<void> {
		return this.#session.waitForIdle();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		this.#listeners.clear();
		for (const proof of this.#proofs) proof.reject(new Error("native_session_driver_disposed"));
		disposeSessionStartup(this.#session);
	}

	async #dispatch(
		delivery: AgentRuntimeDelivery,
		admission: TurnAdmission,
		options: NativeDeliveryOptions,
		proof: TranscriptCommitProof | undefined,
	): Promise<AcceptedAttempt> {
		for (;;) {
			const attempt = await admission.admit(checkpoint => this.#attempt(delivery, admission, options, proof, checkpoint));
			if (!("busy" in attempt)) return attempt;
			// Wait outside admit: the preparing input may itself need the gate the
			// admission held, so waiting inside it would deadlock both.
			await waitForStartupRelease(attempt.busy.whenReleased, anySignal(options.signal, attempt.startupCancellation));
		}
	}

	async #attempt(
		delivery: AgentRuntimeDelivery,
		admission: TurnAdmission,
		options: NativeDeliveryOptions,
		proof: TranscriptCommitProof | undefined,
		checkpoint: () => void,
	): Promise<AcceptedAttempt | BusyAttempt> {
		const signal = options.signal;
		// Pi's manual compaction calls abort() itself, so capture native input
		// cancellation only after the admission's own preparation finished.
		const startupCancellation = this.#startup().signal;
		const fence = () => {
			checkpoint();
			signal?.throwIfAborted();
			startupCancellation.throwIfAborted();
		};
		// Once Pi owns the submission only the Delivery's own cancellation may
		// reject it: an unrelated abort() poisons the session-wide startup signal.
		const preflightFence = () => {
			checkpoint();
			signal?.throwIfAborted();
			admission.accepted?.();
		};
		const submission = (): NativeSubmission => {
			fence();
			proof?.begin();
			return this.#submit(delivery, preflightFence);
		};
		const submitted = await (admission.submit ? admission.submit(submission, fence) : submission());
		try {
			await Promise.race([submitted.preflight, submitted.completion]);
		} catch (error) {
			// Only a custom startup keeps its turn across another input's preparation;
			// native user input already queues behind it inside the startup admission.
			if (delivery.kind === "custom" && isStartupPreparationBusy(error)) {
				// The busy attempt reached no transcript; another input's Run settling
				// while this Delivery waits must not settle its proof.
				proof?.pause();
				return { busy: error, startupCancellation };
			}
			throw error;
		}
		checkpoint();
		return { completion: submitted.completion, runActive: !this.#session.isIdle };
	}

	#submit(delivery: AgentRuntimeDelivery, preflightFence: () => void): NativeSubmission {
		if (delivery.kind === "custom") {
			return this.#startup().dispatchCustom(delivery.message, {
				triggerTurn: delivery.triggerTurn,
				...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
			}, preflightFence);
		}
		const content = typeof delivery.content === "string"
			? [{ type: "text" as const, text: delivery.content }]
			: delivery.content;
		const images = content.flatMap(part => part.type === "image" ? [part] : []);
		let resolvePreflight!: () => void;
		const preflight = new Promise<void>(resolve => { resolvePreflight = resolve; });
		// The same submission Pi's sendUserMessage makes, plus preflight acceptance.
		const completion = this.#session.prompt(submittedUserText(delivery.content), {
			expandPromptTemplates: false,
			source: "extension",
			...(images.length === 0 ? {} : { images }),
			...(delivery.deliverAs === undefined ? {} : { streamingBehavior: delivery.deliverAs }),
			preflightResult() {
				preflightFence();
				resolvePreflight();
			},
		});
		return { completion, preflight };
	}

	#createProof(delivery: AgentRuntimeDelivery, userCommitText: UserCommitTextRule): TranscriptCommitProof {
		const proof = new TranscriptCommitProof(this.#session, delivery, userCommitText, () => this.#proofs.delete(proof));
		this.#proofs.add(proof);
		return proof;
	}

	#startup() {
		if (this.#disposed) throw new Error("native_session_driver_disposed");
		// Owner reload disposes the startup admission of the retired extension
		// generation; rebinding here keeps one driver across the Owner Runtime.
		return bindSessionStartup(this.#session);
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") this.#emit({ type: "run_started" });
		else if (event.type === "compaction_start" || event.type === "compaction_end") {
			// Pi emits the end edge for success, failure, and cancellation alike.
			this.#compacting = event.type === "compaction_start";
			this.#emit({ type: "compaction_changed", compacting: this.#compacting });
		} else if (event.type === "queue_update" || event.type === "thinking_level_changed") {
			this.#emit({ type: "state_changed" });
		} else if (event.type === "agent_end") {
			const runEnd = this.#classifyRunEnd(event);
			// Pi checks queued continuation right after this synchronous callback, and
			// listeners may await before suspending the Run. Capture terminal errors
			// first; deliberate stops and configured retries keep their native queue.
			if (runEnd.outcome === "error" && !runEnd.willRetry) this.#retainedQueue.capture();
			this.#emit({ type: "run_ended", ...runEnd });
		} else if (event.type === "agent_settled") this.#emit({ type: "run_settled" });
	}

	#classifyRunEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): NativeRunEnd {
		const assistant = event.messages.findLast(message => message.role === "assistant");
		if (assistant?.role !== "assistant" || assistant.stopReason !== "error") {
			const outcome = assistant?.role === "assistant" && assistant.stopReason === "aborted" ? "aborted" : "completed";
			return { outcome, willRetry: event.willRetry };
		}
		// Pi reports a request setup that its own abort signal abandoned as a model
		// error carrying the abort reason. Agent-core keeps the exact Run's controller
		// until its listeners settle, so this reads that Run's own cancellation.
		if (this.#session.agent.signal?.aborted === true) return { outcome: "aborted", willRetry: event.willRetry };
		const quota = classifyQuotaEvidence(assistant);
		return {
			outcome: "error",
			willRetry: event.willRetry,
			...(assistant.errorMessage === undefined
				? {}
				: { failure: { stage: "model", error: assistant.errorMessage, provenance: MODEL_FAILURE_PROVENANCE } }),
			...(quota ? { quota } : {}),
		};
	}

	#emit(event: NativeSessionEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}
}

/**
 * Proves that one Delivery reached the transcript. Turn-level entry IDs are not
 * visible on the session event surface, so `message_end` is only a wake-up: Pi
 * notifies listeners immediately before its synchronous append, and the entry is
 * read in the microtask after persistence. Only entries new since dispatch count.
 * The Delivery's own message ending without a new entry settles false at once.
 */
class TranscriptCommitProof {
	readonly result: Promise<boolean>;
	readonly #session: AgentSession;
	readonly #delivery: AgentRuntimeDelivery;
	readonly #userCommitText: UserCommitTextRule;
	#existingEntryIds: ReadonlySet<string> = new Set();
	#unsubscribe: (() => void) | undefined;
	readonly #onFinished: () => void;
	#resolve!: (committed: boolean) => void;
	#reject!: (error: unknown) => void;
	#finished = false;

	constructor(
		session: AgentSession,
		delivery: AgentRuntimeDelivery,
		userCommitText: UserCommitTextRule,
		onFinished: () => void,
	) {
		this.#session = session;
		this.#delivery = delivery;
		this.#userCommitText = userCommitText;
		this.#onFinished = onFinished;
		this.result = new Promise<boolean>((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		void this.result.catch(() => undefined);
	}

	/** Starts watching at one submission; only entries new since then can confirm. */
	begin(): void {
		this.#existingEntryIds = new Set(this.#session.sessionManager.getEntries().map(entry => entry.id));
		if (this.#unsubscribe) return;
		const role = this.#delivery.kind === "custom" ? "custom" : "user";
		this.#unsubscribe = this.#session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === role) {
				const ownMessage = matchesDeliveryMessage(this.#delivery, this.#userCommitText, event.message);
				queueMicrotask(() => {
					if (this.#committed()) this.#finish(() => this.#resolve(true));
					// Pi's append already ran, so this exact message will never commit. Do
					// not wait for settlement: a forwarded human resume awaits this proof
					// while holding its Agent lane, and the Run's own agent_end hook waits
					// on that lane, so settlement would never arrive.
					else if (ownMessage) this.#finish(() => this.#resolve(false));
				});
			}
			if (event.type === "agent_settled") this.#settle();
		});
	}

	pause(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	dispatchCompleted(): void {
		queueMicrotask(() => {
			if (this.#committed()) this.#finish(() => this.#resolve(true));
			// A submission Pi queued into the active Run commits when that Run takes it.
			else if (!this.#session.isStreaming) this.#finish(() => this.#resolve(false));
		});
	}

	reject(error: unknown): void {
		this.#finish(() => this.#reject(error));
	}

	#settle(): void {
		const committed = this.#committed();
		this.#finish(() => this.#resolve(committed));
	}

	#committed(): boolean {
		if (this.#finished) return false;
		return this.#session.sessionManager.getEntries().some(entry =>
			!this.#existingEntryIds.has(entry.id) && matchesDeliveryEntry(this.#delivery, this.#userCommitText, entry));
	}

	#finish(settlement: () => void): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#unsubscribe?.();
		this.#onFinished();
		settlement();
	}
}

function matchesDeliveryEntry(
	delivery: AgentRuntimeDelivery,
	userCommitText: UserCommitTextRule,
	entry: SessionEntry,
): boolean {
	if (delivery.kind === "custom") return entry.type === "custom_message" && matchesCustomFields(delivery, entry);
	return entry.type === "message" && matchesDeliveryMessage(delivery, userCommitText, entry.message);
}

/** Whether a session message is this Delivery in the form Pi persists it. */
function matchesDeliveryMessage(
	delivery: AgentRuntimeDelivery,
	userCommitText: UserCommitTextRule,
	message: SessionMessage,
): boolean {
	if (delivery.kind === "custom") return message.role === "custom" && matchesCustomFields(delivery, message);
	if (message.role !== "user") return false;
	// Pi normalizes prompt images (resizing, re-encoding, or omitting them) and
	// appends their hints as "\n\n<hints>" after the text, so only the text is
	// compared. Under "exact", a bare prefix would let "ok" or an image-only
	// Delivery's empty text match an unrelated later user message.
	const committed = message.content;
	const committedText = typeof committed === "string"
		? committed
		: committed[0]?.type === "text" ? committed[0].text : undefined;
	if (committedText === undefined) return false;
	const submittedText = submittedUserText(delivery.content);
	if (userCommitText === "leading") return committedText.startsWith(submittedText);
	return committedText === submittedText ||
		(hasImages(delivery.content) && committedText.startsWith(`${submittedText}${PI_IMAGE_HINT_SEPARATOR}`));
}

/** Pi's prompt joins its image hints to the submitted text with this separator. */
const PI_IMAGE_HINT_SEPARATOR = "\n\n";

function hasImages(content: Extract<AgentRuntimeDelivery, { kind: "user" }>["content"]): boolean {
	return typeof content !== "string" && content.some(part => part.type === "image");
}

function matchesCustomFields(
	delivery: CustomDelivery,
	candidate: Readonly<{ customType: string; content: unknown; display: boolean; details?: unknown }>,
): boolean {
	return candidate.customType === delivery.message.customType &&
		isDeepStrictEqual(candidate.content, delivery.message.content) &&
		candidate.display === delivery.message.display &&
		isDeepStrictEqual(candidate.details, "details" in delivery.message ? delivery.message.details : undefined);
}

function submittedUserText(content: Extract<AgentRuntimeDelivery, { kind: "user" }>["content"]): string {
	return typeof content === "string"
		? content
		: content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

function anySignal(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
	return AbortSignal.any(signals.filter(signal => signal !== undefined));
}
