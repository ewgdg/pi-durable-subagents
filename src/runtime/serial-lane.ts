/**
 * Serializes operations for one Agent so each observes the state the previous one
 * left behind.
 *
 * An operation may release its occupancy early with `releaseCurrent()` while it is
 * still settling. Queued operations then run against the state that operation has
 * already published instead of queueing behind a wait only they can settle, such as
 * a passive Runtime preparation waiting on the startup UI that the Run admission it
 * unblocks is itself waiting for. The releasing operation keeps its own settlement,
 * so its caller still observes its exact result or failure.
 */
export class SerialLane {
	#occupied = false;
	readonly #waiters: Array<() => void> = [];
	#outstanding = 0;
	readonly #idleResolvers: Array<() => void> = [];
	#releaseOccupancy: (() => boolean) | undefined;

	run<T>(operation: () => Promise<T> | T): Promise<T> {
		const settlement = this.#runOccupied(operation);
		// The lane observes its own task settlement so a fire-and-forget lane task
		// does not surface as an unhandled rejection; an awaiting caller still sees
		// the exact rejection.
		settlement.catch(() => undefined);
		return settlement;
	}

	async #runOccupied<T>(operation: () => Promise<T> | T): Promise<T> {
		this.#outstanding += 1;
		try {
			await this.#acquire();
			let released = false;
			const releaseOccupancy = (): boolean => {
				if (released) return false;
				released = true;
				this.#freeOccupancy();
				return true;
			};
			const previousRelease = this.#releaseOccupancy;
			this.#releaseOccupancy = releaseOccupancy;
			try {
				return await operation();
			} finally {
				releaseOccupancy();
				this.#releaseOccupancy = previousRelease;
			}
		} finally {
			this.#outstanding -= 1;
			if (this.#outstanding === 0) {
				for (const resolve of this.#idleResolvers.splice(0)) resolve();
			}
		}
	}

	/**
	 * Release the lane so queued operations can run while this one is still settling.
	 * Call only from inside the operation that currently holds the lane. Returns false
	 * when this lane has no holder left to release.
	 */
	releaseCurrent(): boolean {
		return this.#releaseOccupancy?.() ?? false;
	}

	idle(): Promise<void> {
		if (this.#outstanding === 0) return Promise.resolve();
		return new Promise((resolve) => this.#idleResolvers.push(resolve));
	}

	#acquire(): Promise<void> {
		if (!this.#occupied) {
			this.#occupied = true;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.#waiters.push(resolve));
	}

	#freeOccupancy(): void {
		this.#occupied = false;
		const next = this.#waiters.shift();
		if (next === undefined) return;
		this.#occupied = true;
		next();
	}
}
