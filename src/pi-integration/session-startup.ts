import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, ExtensionAPI, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";

type CustomMessage = Parameters<AgentSession["sendCustomMessage"]>[0];
type CustomOptions = Parameters<AgentSession["sendCustomMessage"]>[1];
type Dispatch = { completion: Promise<void>; preflight: Promise<void> };
type CustomStartup = {
	message: CustomMessage;
	checkpoint: () => void;
	invocation?: Invocation;
	injected: boolean;
	nativeAccepted: boolean;
	resolvePreflight: () => void;
};
type Invocation = {
	custom?: CustomStartup;
	cancelled: boolean;
	finished: boolean;
	started: boolean;
	released: Promise<void>;
	release: () => void;
};

export class StartupPreparationBusyError extends Error {
	readonly code = "startup_preparation_busy";
	readonly whenReleased: Promise<void>;
	constructor(whenReleased: Promise<void>) {
		super("startup_preparation_busy: another input is preparing; retry after preparation finishes");
		this.whenReleased = whenReleased;
	}
}

export function isStartupPreparationBusy(error: unknown): error is StartupPreparationBusyError {
	// Pi reload can retain wrappers from another module evaluation.
	return error instanceof Error && "code" in error && error.code === "startup_preparation_busy" &&
		"whenReleased" in error && error.whenReleased instanceof Promise;
}

const REGISTRY_KEY = "__piAgentCoordinationSessionStartups";
const registryHost = globalThis as typeof globalThis & {
	[REGISTRY_KEY]?: WeakMap<object, SessionStartupAdmission>;
};
// Extension loading and native-host capture can use distinct module worlds.
const admissions = registryHost[REGISTRY_KEY] ??= new WeakMap();

/** Register once per extension generation; the hook never persists messages itself. */
export function registerSessionStartup(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, context) =>
		admissions.get(context.sessionManager)?.beforeStart());
}

export function bindSessionStartup(session: AgentSession): SessionStartupAdmission {
	let admission = admissions.get(session.sessionManager);
	if (!admission || admission.isDisposed) {
		admission = new SessionStartupAdmission(session, admission?.whenAvailable);
		admissions.set(session.sessionManager, admission);
	}
	return admission;
}

export function disposeSessionStartup(session: AgentSession): void {
	admissions.get(session.sessionManager)?.dispose();
}

/** Owns only preparation, leaving native streaming/settlement to Pi and its host. */
export class SessionStartupAdmission {
	readonly #session: AgentSession;
	readonly #invocations = new AsyncLocalStorage<Invocation>();
	readonly #kickoffs = new AsyncLocalStorage<CustomStartup>();
	readonly #restore: () => void;
	#owner: Invocation | undefined;
	#disposed = false;
	#cancellation = new AbortController();
	#previousPreparation: Promise<void> | undefined;

	constructor(session: AgentSession, previousPreparation?: Promise<void>) {
		this.#session = session;
		this.#previousPreparation = previousPreparation;
		void previousPreparation?.then(() => {
			if (this.#previousPreparation === previousPreparation) this.#previousPreparation = undefined;
		});
		const originalPrompt = session.prompt;
		const prompt: AgentSession["prompt"] = (text, options) => {
			if (this.#disposed) {
				if (this.whenAvailable) return Promise.reject(new StartupPreparationBusyError(this.whenAvailable));
				return originalPrompt.call(session, text, options);
			}
			return this.#prompt(() => originalPrompt.call(session, text, {
				...options,
				preflightResult: success => {
					const invocation = this.#invocations.getStore()!;
					try {
						if (success) this.#checkpoint(invocation);
						options?.preflightResult?.(success);
						if (success) this.#checkpoint(invocation);
					} finally { this.#release(invocation); }
				},
			}));
		};
		const originalCustom = session.sendCustomMessage;
		const custom: AgentSession["sendCustomMessage"] = (message, options) => {
			const pending = this.#kickoffs.getStore();
			const ownDispatch = pending && !pending.invocation && !pending.nativeAccepted && pending.message === message;
			if (this.#disposed || !options?.triggerTurn || options.deliverAs === "nextTurn" || session.isStreaming) {
				if (this.#disposed && options?.triggerTurn && !session.isStreaming && this.whenAvailable) {
					return Promise.reject(new StartupPreparationBusyError(this.whenAvailable));
				}
				if (ownDispatch) pending.checkpoint();
				const completion = originalCustom.call(session, message, options);
				if (ownDispatch) { pending.nativeAccepted = true; pending.resolvePreflight(); }
				return completion;
			}
			if (ownDispatch) return this.#promptCustom();
			return this.#startCustom(message, () => {}).completion;
		};
		const agent = session.agent;
		const originalNativePrompt = agent.prompt;
		const nativePrompt: typeof agent.prompt = function (this: typeof agent, ...args) {
			const invocation = admission.#invocations.getStore();
			const previousSignal = this.signal;
			const completion = Reflect.apply(originalNativePrompt, this, args) as Promise<void>;
			if (!admission.#disposed && invocation && !invocation.cancelled && !invocation.finished &&
				this.signal !== undefined && this.signal !== previousSignal) {
				invocation.started = true;
				invocation.custom?.resolvePreflight();
			}
			return completion;
		};
		const admission = this;
		const originalAbort = session.abort;
		const abort: AgentSession["abort"] = () => {
			this.cancelPreparation();
			return originalAbort.call(session);
		};
		session.prompt = prompt;
		session.sendCustomMessage = custom;
		agent.prompt = nativePrompt;
		session.abort = abort;
		this.#restore = () => {
			if (session.abort === abort) session.abort = originalAbort;
			if (agent.prompt === nativePrompt) agent.prompt = originalNativePrompt;
			if (session.sendCustomMessage === custom) session.sendCustomMessage = originalCustom;
			if (session.prompt === prompt) session.prompt = originalPrompt;
		};
	}

	get isPreparing(): boolean { return this.whenAvailable !== undefined; }
	get isDisposed(): boolean { return this.#disposed; }
	get whenAvailable(): Promise<void> | undefined { return this.#owner?.released ?? this.#previousPreparation; }
	/** Capture once across a dispatch's busy retries; abort also cancels waiting admissions. */
	get signal(): AbortSignal { return this.#cancellation.signal; }

	beforeStart(): BeforeAgentStartEventResult | undefined {
		const invocation = this.#invocations.getStore();
		const custom = invocation?.custom;
		if (this.#disposed || !invocation || invocation.cancelled || invocation.finished ||
			this.#owner !== invocation || !custom || custom.invocation !== invocation || custom.injected) return;
		custom.injected = true;
		return { message: custom.message };
	}

	dispatchCustom(message: CustomMessage, options: CustomOptions, checkpoint: () => void = () => {}): Dispatch {
		return this.#startCustom(message, checkpoint, () => this.#session.sendCustomMessage(message, options));
	}

	cancelPreparation(): void {
		if (this.#owner) this.#owner.cancelled = true;
		this.#cancellation.abort(new Error("startup_admission_cancelled"));
		if (!this.#disposed) this.#cancellation = new AbortController();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.cancelPreparation();
		// A paused Pi hook can still assign its prompt override before final preflight.
		// Retain that exclusion across reload until the old invocation actually exits.
		this.#restore();
	}

	#promptCustom(): Promise<void> {
		// No streamingBehavior: a busy transition must never queue an empty kickoff.
		return this.#session.prompt("", { source: "extension", expandPromptTemplates: false });
	}

	#startCustom(message: CustomMessage, checkpoint: () => void, operation = () => this.#promptCustom()): Dispatch {
		let resolvePreflight!: () => void;
		const entered = new Promise<void>(resolve => { resolvePreflight = resolve; });
		const custom: CustomStartup = { message, checkpoint, injected: false, nativeAccepted: false, resolvePreflight };
		const completion = this.#kickoffs.run(custom, async () => {
			if (this.#disposed) throw new Error("startup_admission_disposed");
			checkpoint();
			await operation();
			if (!custom.nativeAccepted && !custom.invocation?.started) throw new Error("custom_startup_not_started: no native Run accepted the delivery");
		});
		// A handled input or rejected preflight has no native start edge.
		const preflight = Promise.race([entered, completion]);
		void preflight.catch(() => {});
		return { completion, preflight };
	}

	async #prompt(operation: () => Promise<void>): Promise<void> {
		if (this.whenAvailable) throw new StartupPreparationBusyError(this.whenAvailable);
		let release!: () => void;
		const released = new Promise<void>(resolve => { release = resolve; });
		const pending = this.#kickoffs.getStore();
		const invocation: Invocation = { cancelled: false, finished: false, started: false, released, release };
		// Nested calls inherit async context; only the first exact prompt may claim it.
		if (pending && !pending.invocation) {
			invocation.custom = pending;
			pending.invocation = invocation;
		}
		this.#owner = invocation;
		try {
			await this.#invocations.run(invocation, operation);
		} finally {
			invocation.finished = true;
			this.#release(invocation);
			invocation.custom = undefined;
		}
	}

	#checkpoint(invocation: Invocation): void {
		if (this.#disposed || invocation.cancelled) throw new Error("startup_admission_cancelled");
		invocation.custom?.checkpoint();
		if (invocation.custom && !invocation.custom.injected) {
			throw new Error("custom_startup_not_started: kickoff input was handled before delivery preparation");
		}
	}

	#release(invocation: Invocation): void {
		if (this.#owner !== invocation) return;
		this.#owner = undefined;
		invocation.release();
	}
}

export async function waitForStartupRelease(released: Promise<void>, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	let abort!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		await Promise.race([released, cancelled]);
		signal.throwIfAborted();
	} finally { signal.removeEventListener("abort", abort); }
}
