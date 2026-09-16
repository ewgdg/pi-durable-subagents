/** Own launches before their first await, including processes that never admit. */
export class ManagedWriterInventory {
	#closed = false;
	readonly #launches = new Set<Promise<unknown>>();
	readonly #exits = new Set<Promise<unknown>>();
	#retirement: Promise<void> | undefined;

	launch<T>(start: (observeExit: (exit: Promise<unknown>) => void) => Promise<T>): Promise<T> {
		if (this.#closed) throw new Error("managed_writers_retiring: new launches are closed");
		const launch = start((exit) => {
			this.#exits.add(exit);
			void exit.then(() => this.#exits.delete(exit), () => undefined);
		});
		this.#launches.add(launch);
		void launch.finally(() => this.#launches.delete(launch)).catch(() => undefined);
		return launch;
	}

	/** Call before any shutdown await; callers must also dispose owned processes. */
	retire(): Promise<void> {
		this.#closed = true;
		return this.#retirement ??= this.#join();
	}

	async #join(): Promise<void> {
		// Failed admission is not failed retirement. A process created by such an
		// attempt still owes its actual exit, observed at the synchronous spawn seam.
		await Promise.allSettled(this.#launches);
		await Promise.all(this.#exits);
	}
}
