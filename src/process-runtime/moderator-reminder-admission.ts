import type { ModeratorReminderOutcome } from "../runtime/agent-runtime-host.ts";

type Reservation = {
	id: string;
	decision: ReturnType<typeof deferred<boolean>>;
	result: Promise<ModeratorReminderOutcome>;
	abort: AbortController;
};

/** One child-local idle admission, held only through the explicit commit decision. */
export class ModeratorReminderAdmission {
	#reservation: Reservation | undefined;
	readonly #admit: (operation: () => Promise<void>) => Promise<void>;
	readonly #prepare: () => Promise<void>;
	readonly #isIdle: () => boolean;
	readonly #commit: (signal: AbortSignal) => Promise<"busy" | "committed">;

	constructor(options: {
		admit(operation: () => Promise<void>): Promise<void>;
		prepare(): Promise<void>;
		isIdle(): boolean;
		/** Rechecks idleness itself: a busy session never receives the reminder. */
		commit(signal: AbortSignal): Promise<"busy" | "committed">;
	}) {
		this.#admit = options.admit;
		this.#prepare = options.prepare;
		this.#isIdle = options.isIdle;
		this.#commit = options.commit;
	}

	async prepare(id: string): Promise<boolean> {
		if (this.#reservation) throw new Error("moderator_reminder_already_reserved");
		const ready = deferred<boolean>();
		const decision = deferred<boolean>();
		const result = deferred<ModeratorReminderOutcome>();
		const abort = new AbortController();
		const reservation = { id, decision, result: result.promise, abort };
		this.#reservation = reservation;
		// The prepare response releases the transport request, not the native gate.
		// finish() bypasses that gate and resolves this exact decision.
		let outcome: ModeratorReminderOutcome = "busy";
		let started = false;
		const cancelled = deferred<never>();
		const cancelledBeforeStart = deferred<never>();
		const onAbort = () => {
			cancelled.reject(abort.signal.reason);
			if (!started) cancelledBeforeStart.reject(abort.signal.reason);
		};
		abort.signal.addEventListener("abort", onAbort, { once: true });
		// Cancellation can precede native admission, so observe it before entering the gate.
		void cancelled.promise.catch(() => undefined);
		const prepareAndCommit = async () => {
			abort.signal.throwIfAborted();
			if (!this.#isIdle()) { ready.resolve(false); return; }
			await this.#prepare();
			abort.signal.throwIfAborted();
			if (!this.#isIdle()) { ready.resolve(false); return; }
			ready.resolve(true);
			const commit = await decision.promise;
			abort.signal.throwIfAborted();
			if (!commit) { outcome = "suppressed"; return; }
			outcome = await this.#commit(abort.signal);
		};
		const admitted = Promise.resolve().then(() => this.#admit(() => {
			started = true;
			return Promise.race([prepareAndCommit(), cancelled.promise]);
		}));
		// Before entry there is no gate to release. After entry, wait for admission cleanup.
		void Promise.race([admitted, cancelledBeforeStart.promise]).then(() => {
			abort.signal.removeEventListener("abort", onAbort);
			if (this.#reservation === reservation) this.#reservation = undefined;
			result.resolve(outcome);
		}, error => {
			abort.signal.removeEventListener("abort", onAbort);
			if (this.#reservation === reservation) this.#reservation = undefined;
			ready.reject(error);
			result.reject(error);
		});
		// Failure before finish() still belongs to prepare(), not an unhandled Promise.
		void result.promise.catch(() => undefined);
		const prepared = await ready.promise;
		if (!prepared) await result.promise;
		return prepared;
	}

	finish(id: string, commit: boolean): Promise<ModeratorReminderOutcome> {
		const reservation = this.#reservation;
		// Interruption may already have cancelled and released this admission.
		if (!reservation && !commit) return Promise.resolve("suppressed");
		if (!reservation || reservation.id !== id) throw new Error("moderator_reminder_reservation_missing");
		reservation.decision.resolve(commit);
		return reservation.result;
	}

	cancel(): void {
		const reservation = this.#reservation;
		if (!reservation) return;
		reservation.abort.abort(new Error("moderator_reminder_admission_cancelled"));
		reservation.decision.resolve(false);
	}
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
