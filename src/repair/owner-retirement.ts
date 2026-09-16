import { setTimeout as delay } from "node:timers/promises";

type NativeWriter = {
	abortBash(): void;
	readonly isBashRunning: boolean;
	readonly hasPendingBashMessages: boolean;
	readonly isIdle: boolean;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
};

/** Actual cleanup evidence, retained independently of Pi's caught shutdown events. */
export class OwnerRetirement {
	readonly #native: NativeWriter;
	#cleanup: (() => Promise<void>) | undefined;
	#cleanupResult: Promise<void> | undefined;
	#preparation: Promise<void> | undefined;
	#clean = false;
	#replaced = false;

	constructor(native: NativeWriter) { this.#native = native; }

	establishNoCoordinator(): void {
		this.#cleanup = async () => undefined;
	}

	setCoordinatorCleanup(cleanup: () => Promise<void>): void {
		if (this.#preparation || this.#cleanupResult) throw new Error("Owner retirement already started");
		this.#cleanup = cleanup;
	}

	cleanupCoordinator(): Promise<void> {
		return this.#cleanupResult ??= this.#cleanup
			? this.#cleanup()
			: Promise.reject(new Error("Owner coordinator cleanup is unknown"));
	}

	prepare(): Promise<void> {
		return this.#preparation ??= this.#prepare();
	}

	async #prepare(): Promise<void> {
		if (!this.#cleanup) throw new Error("Owner coordinator cleanup is unknown");
		// Invoke before awaiting: coordinator shutdown fences admission synchronously.
		const results = await Promise.allSettled([this.cleanupCoordinator(), this.#drainNative()]);
		const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "Owner retirement failed");
		this.#clean = true;
	}

	async #drainNative(): Promise<void> {
		this.#native.abortBash();
		// Pi exposes cancellation and running state, but no bash join Promise.
		// isBashRunning clears only after executeBash persists its final entry.
		while (this.#native.isBashRunning) await delay(10);
		await this.#native.abort();
		await this.#native.waitForIdle();
		this.#assertNativeDrained();
	}

	replacementCompleted(): void { this.#replaced = true; }

	assertRetired(): void {
		if (!this.#clean) throw new Error("Owner cleanup did not succeed");
		if (!this.#replaced) throw new Error("Native Owner replacement has not completed");
		this.#assertNativeDrained();
	}

	#assertNativeDrained(): void {
		if (!this.#native.isIdle) throw new Error("Native Owner is not idle");
		if (this.#native.isBashRunning || this.#native.hasPendingBashMessages) {
			throw new Error("Native Owner bash writes have not drained");
		}
	}
}
