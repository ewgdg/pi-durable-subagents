export type ProposalAuthorization = Readonly<{ generation: number }>;
export type ProposalSettlement = Readonly<{
	/** Capture at the settled boundary, before any asynchronous inspection. */
	generation: number;
	outcome: "completed" | "aborted" | "error";
	hasPendingMessages: boolean;
}>;

/**
 * Conversation edits remain possible until validation freezes one exact proposal.
 * Native continuation alone does not invalidate completion: new input, writes,
 * and failed/aborted work do. Call these synchronous methods before side effects.
 */
export class ProposalSettlementGate {
	#generation = 0;
	#completeGeneration: number | undefined;
	#authorization: ProposalAuthorization | undefined;
	#state: "editing" | "validating" | "applying" = "editing";

	get generation(): number { return this.#generation; }
	get state(): "editing" | "validating" | "applying" { return this.#state; }

	/** Call before input admission (including queued input), candidate writes, or abort. */
	invalidate(): void {
		this.#assertEditing();
		this.revokeCompletion();
	}

	/** Input and abort revoke even a frozen validation, but never an application. */
	revokeCompletion(): boolean {
		if (this.#state === "applying") return false;
		this.#generation++;
		this.#completeGeneration = undefined;
		return true;
	}

	reportComplete(): void {
		this.#assertEditing();
		this.#completeGeneration = this.#generation;
	}

	freezeOnSettlement(settlement: ProposalSettlement): ProposalAuthorization | undefined {
		if (this.#state !== "editing" || settlement.generation !== this.#generation) return;
		if (settlement.outcome !== "completed" || settlement.hasPendingMessages) {
			this.invalidate();
			return;
		}
		if (this.#completeGeneration !== this.#generation) return;
		this.#state = "validating";
		return this.#authorization = Object.freeze({ generation: this.#generation });
	}

	/** Validation alone may reopen editing. Require a new complete report afterwards. */
	validationRejected(authorization: ProposalAuthorization): void {
		this.#assertAuthorization(authorization);
		this.#state = "editing";
		this.#authorization = undefined;
		this.invalidate();
	}

	/** Call immediately before application starts, never after the first file write. */
	beginApplication(authorization: ProposalAuthorization): boolean {
		this.#assertAuthorization(authorization);
		// Validation may await disk I/O while new input revokes this generation.
		// The final check and irreversible transition must have no await between.
		if (authorization.generation !== this.#generation) {
			this.validationRejected(authorization);
			return false;
		}
		// Irreversible even if application fails: storage recovery owns that outcome.
		this.#state = "applying";
		this.#authorization = undefined;
		return true;
	}

	#assertAuthorization(authorization: ProposalAuthorization): void {
		if (this.#state !== "validating") throw new Error("Repair proposal is not validating");
		if (this.#authorization !== authorization) throw new Error("Stale repair proposal authorization");
	}

	#assertEditing(): void {
		if (this.#state !== "editing") throw new Error("Repair proposal is frozen");
	}
}
