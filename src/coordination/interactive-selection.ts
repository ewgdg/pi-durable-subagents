import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { requireAgentRecord, type AgentRecord } from "./agent-record.ts";
import { collectCleanupFailure } from "./cleanup-failures.ts";
import { DurableAgentViewAttachment } from "./durable-agent-view.ts";
import type { HumanRequestCoordinator } from "./human-requests.ts";
import type { MessageCoordinator } from "./messages.ts";
import type { RunSupervisor } from "./run-supervision.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import type { DurableAgentView } from "../presentation/agent-view-surface.ts";
import type { PostMortemAgentView } from "../presentation/post-mortem-agent-view-surface.ts";
import type { TerminalProjection } from "../presentation/terminal-projection.ts";
import type { ProjectionInputSubmission } from "../runtime/agent-runtime-host.ts";
import type { ProcessChildSessionFactory } from "../runtime/process-child-session-factory.ts";
import { SerialLane } from "../runtime/serial-lane.ts";

export type HumanInputDisposition = "continue" | "submitted" | "discarded";

export type AgentPresentationSelection =
	| Readonly<{ kind: "selected"; view?: DurableAgentView }>
	| PostMortemAgentView;

type ActiveDurableAgentView = {
	record: AgentRecord;
	attachment: DurableAgentViewAttachment;
	failed: boolean;
};

type AgentViewTarget = Readonly<{
	projection: TerminalProjection;
	retryIfChanged: boolean;
}>;

/**
 * Attaches the human's terminal to one Agent. The view lane, the single active
 * view, and every `interactive_selection` retention change live here.
 */
export class InteractiveSelection {
	readonly #agents: Map<string, AgentRecord>;
	readonly #quarantinedAgentIds: ReadonlySet<string>;
	readonly #ownerIdentity: OwnerIdentity;
	readonly #messages: Pick<MessageCoordinator, "requestRelease">;
	readonly #runSupervisor: Pick<
		RunSupervisor,
		"resumeFromHuman" | "resumeFromHumanInLane" | "submitFromHumanInLane"
	>;
	readonly #humanRequests: Pick<HumanRequestCoordinator, "hasPendingRequest">;
	readonly #diagnostics: AgentSessionRuntime["services"]["diagnostics"];
	readonly #onActivityChanged: () => void;
	readonly #viewLane = new SerialLane();
	#active: ActiveDurableAgentView | undefined;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		quarantinedAgentIds: ReadonlySet<string>;
		ownerIdentity: OwnerIdentity;
		messages: Pick<MessageCoordinator, "requestRelease">;
		runSupervisor: Pick<
			RunSupervisor,
			"resumeFromHuman" | "resumeFromHumanInLane" | "submitFromHumanInLane"
		>;
		humanRequests: Pick<HumanRequestCoordinator, "hasPendingRequest">;
		sessionFactory: Pick<ProcessChildSessionFactory, "subscribeRuntimeQuit">;
		beginShutdown(): void;
		diagnostics: AgentSessionRuntime["services"]["diagnostics"];
		onActivityChanged(): void;
	}) {
		this.#agents = options.agents;
		this.#quarantinedAgentIds = options.quarantinedAgentIds;
		this.#ownerIdentity = options.ownerIdentity;
		this.#messages = options.messages;
		this.#runSupervisor = options.runSupervisor;
		this.#humanRequests = options.humanRequests;
		this.#diagnostics = options.diagnostics;
		this.#onActivityChanged = options.onActivityChanged;
		options.sessionFactory.subscribeRuntimeQuit((agentId, projection) => {
			const selected = this.#active;
			if (
				selected?.record.identity.agentId !== agentId ||
				selected.attachment.projection() !== projection
			) return false;
			// Native Owner shutdown follows terminal restoration after child exit.
			// Fence admissions and release Wait now, before dead Control can start
			// moderation or leave the Owner waiting for an Answer that cannot arrive.
			options.beginShutdown();
			return true;
		});
	}

	integrate(record: AgentRecord): void {
		record.host.setRunStartedHandler(async (handle) => {
			await this.#bindViewedRunInLane(record, handle);
		});
		record.host.setRunEndingHandler(async (handle, cause) => {
			await this.#handleViewedRunEndingInLane(record, handle, cause);
		});
	}

	selectedViewFailed(record: AgentRecord): boolean {
		const active = this.#active;
		return active?.record === record && active.failed;
	}

	openPresentation(agentId: string): Promise<AgentPresentationSelection> {
		return this.#viewLane.run(async () => {
			if (agentId === this.#ownerIdentity.agentId) {
				const active = this.#active;
				if (active) await this.#closeActiveInLane(active);
				return { kind: "selected" };
			}
			const active = this.#active;
			if (active?.record.identity.agentId === agentId) return { kind: "selected" };
			const record = requireAgentRecord(this.#agents, this.#quarantinedAgentIds, agentId);
			let target: AgentViewTarget;
			try {
				target = await this.#acquireTarget(record);
			} catch (error) {
				if (
					record.host.observe().phase !== "dormant" ||
					record.host.currentProjection()
				) throw error;
				const transcript = record.transcript.inspect();
				if (!transcript.transcriptPath) throw error;
				return {
					kind: "post_mortem",
					agentId,
					label: record.identity.metadata.label,
					transcript,
					preparationError: boundedPreparationError(error),
				};
			}
			if (active) {
				await this.#switchActiveToTargetInLane(active, record, target);
				return { kind: "selected" };
			}
			let attachment!: DurableAgentViewAttachment;
			attachment = new DurableAgentViewAttachment({
				agentId,
				label: record.identity.metadata.label,
				projection: target.projection,
				requestClose: () => this.#close(attachment),
				reportFailure: (error) => this.#reportViewError(error),
			});
			this.#active = {
				record,
				attachment,
				failed: false,
			};
			this.#onActivityChanged();
			return { kind: "selected", view: attachment };
		});
	}

	async openView(agentId: string): Promise<DurableAgentView | undefined> {
		const selection = await this.openPresentation(agentId);
		if (selection.kind === "post_mortem") {
			throw new Error(selection.preparationError);
		}
		return selection.view;
	}

	focusHumanAnswer(agentId: string, requestId: string): Promise<void> {
		return this.#viewLane.run(() => {
			if (!this.#humanRequests.hasPendingRequest(agentId, requestId)) {
				throw new Error("stale_request: Human Request is no longer pending");
			}
			const active = this.#active;
			if (!active || active.record.identity.agentId !== agentId) {
				throw new Error(
					`invariant_violation: Human Request Agent ${agentId} is not selected`,
				);
			}
			active.attachment.projection().focusEditor();
		});
	}

	/**
	 * The in-lane half of human input routing. The caller has already captured and
	 * fenced the input submission, offered it as a Human Answer, and marked the
	 * human interruption.
	 */
	routeHumanInput(
		agentId: string,
		text: string,
		images: readonly ImageContent[] | undefined,
		submissionSequence: number | undefined,
		inputSubmission: ProjectionInputSubmission | undefined,
	): Promise<HumanInputDisposition> {
		return this.#viewLane.run(async () => {
			const active = this.#active;
			if (!active || active.record.identity.agentId !== agentId) {
				return await this.#runSupervisor.resumeFromHuman(agentId, text, images, submissionSequence)
					? "submitted"
					: "continue";
			}
			return active.record.host.lane.run(async () => {
				if (this.#active !== active) return "discarded";
				if (
					inputSubmission !== undefined &&
					active.record.host.projectionInputSubmissionIsFenced(inputSubmission)
				) return "discarded";
				const currentHandle = active.record.host.currentHandle();
				if (
					currentHandle &&
					active.attachment.projection() === active.record.host.currentProjection()
				) {
					if (active.record.host.currentResumptionHold()) {
						return await this.#runSupervisor.resumeFromHumanInLane(
							active.record,
							text,
							images,
							submissionSequence,
						)
							? "submitted"
							: "continue";
					}
					return "continue";
				}
				if (!currentHandle) {
					await active.record.host.startInLane(["interactive_selection"]);
				}
				await this.#runSupervisor.submitFromHumanInLane(active.record, text, images, submissionSequence);
				return "submitted";
			});
		});
	}

	async closeAtShutdown(): Promise<void> {
		await this.#active?.attachment.close();
	}

	async #acquireTarget(record: AgentRecord): Promise<AgentViewTarget> {
		const phase = record.host.observe().phase;
		if (phase === "starting") {
			const initializingProjection = await waitForInitializingProjection(record);
			if (initializingProjection) {
				// Run startup deliberately waits for session_start UI. Entering its lane
				// here would deadlock the only human surface that can settle a startup
				// modal. The exact bound Run cannot change during these synchronous steps.
				record.host.addRetentionReason("interactive_selection");
				return { projection: initializingProjection, retryIfChanged: false };
			}
		}
		if ((phase === "dormant" || record.host.currentRunSuspension()) && !record.host.currentProjection()) {
			return this.#prepareTarget(record);
		}
		const liveTarget = await record.host.lane.run(() => {
			// Release may have won the lane after selection observed an ending Runtime.
			// Re-check at the serialized boundary instead of applying a stale live path
			// to the now-dormant Agent.
			if (
				record.host.observe().phase === "dormant" &&
				!record.host.currentProjection()
			) return undefined;
			return this.#acquireLiveTargetInLane(record);
		});
		return liveTarget ?? this.#prepareTarget(record);
	}

	async #prepareTarget(record: AgentRecord): Promise<AgentViewTarget> {
		const preparation = record.host.lane.run(async () => {
			if (record.host.currentProjection()) {
				record.host.addRetentionReason("interactive_selection");
				return;
			}
			return record.host.prepareInLane(["interactive_selection"]);
		});
		// Preparation can pause in session_start UI. Attach the published projection
		// without waiting behind the modal that this view must let the human settle.
		const projection = await waitForStartupProjection(record, preparation);
		// Readiness continues after publication because session_start UI may need the
		// attached view. If it later fails, close only that exact unusable attachment.
		void preparation.catch((error) => {
			void this.#viewLane.run(async () => {
				const active = this.#active;
				if (
					!active ||
					active.record !== record ||
					active.attachment.projection() !== projection
				) return;
				this.#reportViewError(error);
				await this.#closeActiveInLane(active);
			}).catch((cleanupError) => this.#reportViewError(cleanupError));
		});
		record.host.addRetentionReason("interactive_selection");
		return { projection, retryIfChanged: false };
	}

	async #acquireLiveTargetInLane(record: AgentRecord): Promise<AgentViewTarget> {
		record.host.addRetentionReason("interactive_selection");
		const projection = record.host.currentProjection();
		if (projection) return { projection, retryIfChanged: true };
		record.host.removeRetentionReason("interactive_selection");
		throw new Error(
			`invariant_violation: live Agent ${record.identity.agentId} has no presentation projection`,
		);
	}

	async #switchActiveToTargetInLane(
		active: ActiveDurableAgentView,
		record: AgentRecord,
		initialTarget: AgentViewTarget,
	): Promise<void> {
		let target = initialTarget;
		while (true) {
			const previousRecord = active.record;
			const previousProjection = active.attachment.projection();
			let presentationReady: Promise<void> | undefined;
			let requestPreviousRunRelease = false;
			let targetChanged = false;
			await previousRecord.host.lane.run(() => {
				targetChanged = record.host.currentProjection() !== target.projection;
				if (targetChanged) return;
				active.record = record;
				active.failed = false;
				presentationReady = active.attachment.retarget({
					agentId: record.identity.agentId,
					label: record.identity.metadata.label,
					projection: target.projection,
				});
			});
			if (targetChanged) {
				await this.#releaseUnpublishedTarget(record);
				if (!target.retryIfChanged) {
					throw new Error(
						`stale_run: selected Agent ${record.identity.agentId} changed during view preparation`,
					);
				}
				target = await this.#acquireTarget(record);
				continue;
			}
			// The previous Runtime still renders its loading selector until the
			// physical handoff completes. Releasing it earlier can freeze that view.
			try {
				await presentationReady;
			} finally {
				await previousRecord.host.lane.run(() => {
					if (previousRecord.host.currentProjection() !== previousProjection) return;
					previousRecord.host.removeRetentionReason("interactive_selection");
					requestPreviousRunRelease = true;
				});
				if (requestPreviousRunRelease) {
					try {
						await this.#messages.requestRelease(previousRecord);
					} catch (error) {
						this.#reportViewError(error);
					}
				}
				this.#onActivityChanged();
			}
			return;
		}
	}

	async #releaseUnpublishedTarget(record: AgentRecord): Promise<void> {
		await record.host.lane.run(() => {
			record.host.removeRetentionReason("interactive_selection");
		});
		await this.#messages.requestRelease(record);
	}

	#close(attachment: DurableAgentViewAttachment): Promise<void> {
		return this.#viewLane.run(async () => {
			const active = this.#active;
			if (!active || active.attachment !== attachment) {
				attachment.settleClosed();
				return;
			}
			await this.#closeActiveInLane(active);
		});
	}

	async #closeActiveInLane(active: ActiveDurableAgentView): Promise<void> {
		const cleanupErrors: unknown[] = [];
		let requestRunRelease = false;
		await collectCleanupFailure(
			cleanupErrors,
			() => active.record.host.cancelRuntimeInitialization(
				active.attachment.projection(),
				new Error("Agent view closed during Runtime initialization"),
			),
		);
		await active.record.host.lane.run(async () => {
			if (this.#active !== active) return;
			this.#active = undefined;
			// A closed selection cannot hold interactive retention for any projection:
			// there is only one active view, and it is this one. Gating the removal on
			// the attached projection used to leak the retention whenever that
			// projection had already been replaced (Run fence, resumption, disposal),
			// which then made the record permanently ineligible for Deadlock and other
			// incident inspection that treats a live selection as external progress.
			active.record.host.removeRetentionReason("interactive_selection");
			if (
				active.record.host.currentProjection() === active.attachment.projection()
			) requestRunRelease = true;
			active.attachment.settleClosed();
		});
		if (requestRunRelease) {
			try {
				await this.#messages.requestRelease(active.record);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Agent view cleanup failed");
		}
	}

	async #bindViewedRunInLane(
		record: AgentRecord,
		handle: Readonly<{ sequence: number }>,
	): Promise<void> {
		const active = this.#active;
		if (!active || active.record !== record || !record.host.isCurrent(handle)) return;
		const projection = record.host.currentProjection();
		if (!projection) {
			throw new Error(
				`invariant_violation: viewed Agent ${record.identity.agentId} started without a projection`,
			);
		}
		if (active.attachment.projection() !== projection) {
			throw new Error(
				`invariant_violation: viewed Agent ${record.identity.agentId} changed Runtime projection during Run admission`,
			);
		}
		record.host.addRetentionReason("interactive_selection");
		active.failed = false;
		this.#onActivityChanged();
	}

	async #handleViewedRunEndingInLane(
		record: AgentRecord,
		handle: Readonly<{ sequence: number }>,
		cause: "failure" | "termination" | "shutdown",
	): Promise<void> {
		const active = this.#active;
		if (
			!active ||
			active.record !== record ||
			!record.host.isCurrent(handle) ||
			record.host.currentProjection() !== active.attachment.projection()
		) return;
		if (record.host.observe().phase === "starting") {
			// Initialization cancellation disposes this not-yet-usable projection;
			// unlike an admitted Run, it cannot remain as a Dormant attached view.
			this.#active = undefined;
			active.attachment.settleClosed();
			this.#onActivityChanged();
			return;
		}
		if (cause !== "failure") return;
		active.failed = true;
		this.#onActivityChanged();
	}

	#reportViewError(error: unknown): void {
		this.#diagnostics.push({
			type: "error",
			message: `Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

function waitForInitializingProjection(
	record: AgentRecord,
): Promise<TerminalProjection | undefined> {
	const current = record.host.currentProjection();
	if (current || record.host.observe().phase !== "starting") {
		return Promise.resolve(current);
	}
	return new Promise((resolve) => {
		const removeHandler = record.host.addStateChangeHandler(() => {
			const projection = record.host.currentProjection();
			if (!projection && record.host.observe().phase === "starting") return;
			removeHandler();
			resolve(projection);
		});
	});
}

function waitForStartupProjection(
	record: AgentRecord,
	startup: Promise<unknown>,
): Promise<TerminalProjection> {
	const current = record.host.currentProjection();
	if (current) return Promise.resolve(current);
	return new Promise((resolve, reject) => {
		let settled = false;
		let removeHandler: () => void = () => undefined;
		const settle = (
			result: { projection: TerminalProjection } | { error: unknown },
		) => {
			if (settled) return;
			settled = true;
			removeHandler();
			if ("projection" in result) resolve(result.projection);
			else reject(result.error);
		};
		const inspectProjection = () => {
			const projection = record.host.currentProjection();
			if (projection) settle({ projection });
		};
		removeHandler = record.host.addStateChangeHandler(inspectProjection);
		inspectProjection();
		void startup.then(
			() => {
				const projection = record.host.currentProjection();
				if (projection) settle({ projection });
				else {
					settle({
						error: new Error(
							`invariant_violation: selected Agent ${record.identity.agentId} prepared without a presentation projection`,
						),
					});
				}
			},
			(error) => settle({ error }),
		);
	});
}

const MAX_PREPARATION_ERROR_BYTES = 2_000;

function boundedPreparationError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const nonEmpty = message.length > 0 ? message : "Runtime preparation failed";
	if (Buffer.byteLength(nonEmpty, "utf8") <= MAX_PREPARATION_ERROR_BYTES) return nonEmpty;
	const ellipsis = "…";
	const maximumContentBytes = MAX_PREPARATION_ERROR_BYTES - Buffer.byteLength(ellipsis, "utf8");
	let bounded = "";
	for (const character of nonEmpty) {
		if (Buffer.byteLength(bounded + character, "utf8") > maximumContentBytes) break;
		bounded += character;
	}
	return `${bounded}${ellipsis}`;
}
