import type { OrdinaryAgentCoordinatorView } from "../coordination/workflow-coordinator.ts";
import { ProtocolInvariantError } from "../protocol/identities.ts";
import { OwnerRecoveryError } from "./owner-recovery-error.ts";

export type OwnerViewResolver = () => OrdinaryAgentCoordinatorView;

/** Admitted, Blocked, and Inactive are final; Pending moves to exactly one of them. */
export type OwnerAdmissionOutcome =
	| Readonly<{ state: "pending" }>
	| Readonly<{ state: "admitted"; ownerView: OwnerViewResolver }>
	| Readonly<{
		state: "blocked";
		failure: OwnerRecoveryError;
		/** Owner role identification completed before the failure. */
		ownerIdentified: boolean;
	}>
	// The host bound no Runtime, so no Owner exists.
	| Readonly<{ state: "inactive" }>;

export type NativeReplacement = "fork" | "new_session" | "resume";
export type NativeReplacementVerdict = "allow" | "refuse" | "refuse_with_identification_notice";

/** The session one Owner extension attachment starts with. */
export type OwnerSessionStart = Readonly<{
	/** Identifies the session; an RPC re-bind repeats the same one. */
	sessionManager: Readonly<{ getSessionId(): string; getSessionFile(): string | undefined }>;
}>;

export type OwnerAdmissionDependencies<Start extends OwnerSessionStart> = Readonly<{
	/** The Owner bootstrap procedure; resolves nothing when the host bound no Runtime. */
	bootstrapOwner(start: Start, onOwnerIdentified: () => void): Promise<OwnerViewResolver | undefined>;
	presentOutcome(outcome: OwnerAdmissionOutcome, start: Start): void;
}>;

/**
 * One Owner extension attachment's attempt to admit its session as Workflow
 * Owner, and the native-operation answers that follow from it.
 */
export class OwnerAdmission<Start extends OwnerSessionStart> {
	readonly #dependencies: OwnerAdmissionDependencies<Start>;
	#outcome: OwnerAdmissionOutcome = { state: "pending" };
	#startedSession: Start["sessionManager"] | undefined;
	#settle: () => void = () => {};
	readonly #settled = new Promise<void>((resolve) => {
		this.#settle = resolve;
	});

	constructor(dependencies: OwnerAdmissionDependencies<Start>) {
		this.#dependencies = dependencies;
	}

	async start(start: Start): Promise<void> {
		// Pi's RPC mode binds a replaced session's extensions twice (e.g. on
		// switch_session), repeating session_start with no session_shutdown between.
		// Re-admitting would shut down the live Workflow, so ignore the repeat.
		if (start.sessionManager === this.#startedSession) return;
		// Pi builds a new extension attachment for every replacement and reload.
		if (this.#startedSession) {
			throw new Error("An Owner extension attachment cannot admit a second session");
		}
		this.#startedSession = start.sessionManager;
		let ownerIdentified = false;
		try {
			this.#dependencies.presentOutcome(this.#outcome, start);
			const ownerView = await this.#dependencies.bootstrapOwner(start, () => {
				ownerIdentified = true;
			});
			this.#outcome = ownerView ? { state: "admitted", ownerView } : { state: "inactive" };
			this.#dependencies.presentOutcome(this.#outcome, start);
		} catch (error) {
			this.#outcome = {
				state: "blocked",
				failure: ownerRecoveryEvidence(error, start),
				ownerIdentified,
			};
			this.#dependencies.presentOutcome(this.#outcome, start);
		} finally {
			this.#settle();
		}
	}

	/** Resolves once the outcome has been presented, on every path. */
	settled(): Promise<void> {
		return this.#settled;
	}

	nativeReplacementVerdict(replacement: NativeReplacement): NativeReplacementVerdict {
		switch (this.#outcome.state) {
			case "pending":
				return "refuse";
			case "admitted":
			case "inactive":
				return "allow";
			case "blocked":
				// A blocked session can always start a clean Owner session, but its
				// unresolved failure keeps /resume fenced. Fork carries an identified
				// Owner into a fresh Workflow; an unidentified transcript may be a child.
				if (replacement === "new_session") return "allow";
				if (replacement === "resume") return "refuse";
				return this.#outcome.ownerIdentified ? "allow" : "refuse_with_identification_notice";
		}
	}

	ownerView(): OrdinaryAgentCoordinatorView | undefined {
		return this.#outcome.state === "admitted" ? this.#outcome.ownerView() : undefined;
	}

	admittedOwnerView(): OrdinaryAgentCoordinatorView {
		const view = this.ownerView();
		if (!view) throw new Error("Owner Workflow is not admitted");
		return view;
	}
}

function ownerRecoveryEvidence(error: unknown, start: OwnerSessionStart): OwnerRecoveryError {
	if (error instanceof OwnerRecoveryError) return error;
	return new OwnerRecoveryError(
		error instanceof ProtocolInvariantError ? "Owner transcript recovery" : "Owner admission",
		start.sessionManager.getSessionId(),
		start.sessionManager.getSessionFile(),
		error,
	);
}
