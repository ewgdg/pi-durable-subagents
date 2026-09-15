type RuntimeQueue = { steering: string[]; followUp: string[] };

/** Removes native queued text immediately, retaining the existing clearQueue contract. */
export class RetainedRuntimeQueue {
	readonly #clearNativeQueue: () => RuntimeQueue;
	#retained: RuntimeQueue = { steering: [], followUp: [] };

	constructor(clearNativeQueue: () => RuntimeQueue) {
		this.#clearNativeQueue = clearNativeQueue;
	}

	capture(): void {
		const queued = this.#clearNativeQueue();
		this.#retained.steering.push(...queued.steering);
		this.#retained.followUp.push(...queued.followUp);
	}

	clear(): RuntimeQueue {
		this.capture();
		const retained = this.#retained;
		this.#retained = { steering: [], followUp: [] };
		return retained;
	}
}
