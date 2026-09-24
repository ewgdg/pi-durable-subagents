import type { WorkflowRecoveryView } from "../protocol/workflow-resume.ts";
import type { AgentRunHandle } from "../runtime/agent-runtime-host.ts";
import { randomUUID } from "node:crypto";
import { createWorkflowContinuation, inspectWorkflowContinuation } from "../protocol/workflow-continuation.ts";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import {
	requireAgentRecord,
	type AgentRecord,
} from "./agent-record.ts";
import type { MessageCoordinator } from "./messages.ts";
import {
	createSupervisoryResumeMessage,
	resolveCommittedRunControl,
	type RunControlInput,
	type RunControlReceipt,
} from "../protocol/run-control.ts";
import { isModeratorIdentity } from "../protocol/moderator-input.ts";

export class RunSupervisor {
	// Accepted custom input owns continuation even while dispatch is still queued.
	readonly #continuationRuns = new WeakSet<AgentRunHandle>();
	readonly #agents: Map<string, AgentRecord>;
	readonly #ownerAgentId: string;
	readonly #messages: MessageCoordinator;
	readonly #quarantinedAgentIds: ReadonlySet<string>;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		quarantinedAgentIds?: ReadonlySet<string>;
		ownerAgentId: string;
		messages: MessageCoordinator;
	}) {
		this.#agents = options.agents;
		this.#quarantinedAgentIds = options.quarantinedAgentIds ?? new Set();
		this.#ownerAgentId = options.ownerAgentId;
		this.#messages = options.messages;
	}

	execute(
		callerAgentId: string,
		toolCallId: string,
		input: RunControlInput,
	): Promise<RunControlReceipt> {
		const caller = this.#requireAgent(callerAgentId);
		const committed = resolveCommittedRunControl({
			callerAgentId,
			transcript: caller.transcript.inspect(),
			toolCallId,
			providedInput: input,
		});
		const control = committed.input;
		const target = this.#requireControllableTarget(callerAgentId, control.agentId);
		const residualRequestsBeforeCancellation = target.host.residualRequestCounts();
		const startingProjection = control.operation === "terminate" &&
			target.host.observe().phase === "starting"
			? target.host.currentProjection()
			: undefined;
		const initializationTermination = startingProjection
			? target.host.requestRuntimeInitializationTermination(
				startingProjection,
				new Error("Agent Run terminated during Runtime initialization"),
			)
			: undefined;
		return target.host.lane.run(async () => {
			if (control.operation === "terminate") {
				try {
					const initializationCancelled = initializationTermination
						? await initializationTermination.cancellation
						: false;
					const residualRequests = initializationCancelled
						? residualRequestsBeforeCancellation
						: target.host.residualRequestCounts();
					if (initializationCancelled) {
						this.#messages.discardSchedulingInLane(target);
						return {
							agentId: target.identity.agentId,
							disposition: "terminated",
							residualRequests,
						};
					}
					if (!target.host.currentHandle()) {
						return {
							agentId: target.identity.agentId,
							disposition: "not_running",
							residualRequests,
						};
					}
					this.#messages.discardSchedulingInLane(target);
					await target.host.discardAndEndInLane("termination");
					return {
						agentId: target.identity.agentId,
						disposition: "terminated",
						residualRequests,
					};
				} finally {
					if (initializationTermination) {
						target.host.completeRuntimeInitializationTerminationInLane(
							initializationTermination,
						);
					}
				}
			}
			if (control.operation === "resume") {
				const message = createSupervisoryResumeMessage({
					workflowId: caller.identity.workflowId,
					fromAgentId: callerAgentId,
					input: control,
					source: committed.source,
				});
				const identity = {
					agentId: target.identity.agentId,
					messageId: message.messageId,
				};
				const hold = target.host.currentResumptionHold();
				if (!hold) {
					return { ...identity, delivery: "rejected", rejectionReason: "not_held" };
				}
				await target.host.prepareSuspensionResumptionInLane();
				const admission = await this.#messages.admitResumeInLane(target, message, hold);
				if (admission === "pending") return { ...identity, messageStatus: "sent" };
				return {
					...identity,
					delivery: "rejected",
					rejectionReason: admission === "capacity_exhausted"
						? "resume_slot_occupied"
						: "target_unavailable",
				};
			}
			this.#messages.prepareInterruptionInLane(target);
			const disposition = await target.host.interruptCurrentRunInLane();
			return { agentId: target.identity.agentId, disposition };
		});
	}

	/** Admit recovery through ordinary scheduling; admission is not turn completion. */
	continueDormantResponder(
		record: AgentRecord,
		options: {
			requestMessageIds: readonly string[];
			recheckRequestMessageIds(): readonly string[];
			recovery: { isReady(): boolean; view(): WorkflowRecoveryView };
		},
	): Promise<"activated" | "already_running" | "held" | "resolved" | "fenced" | "target_unavailable" | "capacity_exhausted"> {
		const capturedIds = new Set(options.requestMessageIds);
		const outstandingIds = () => options.recheckRequestMessageIds()
			.filter((id) => capturedIds.has(id));
		return record.host.lane.run(async () => {
			if (record.host.blocksOrdinaryDelivery()) return "held";
			const state = record.host.observe();
			const currentHandle = record.host.currentHandle();
			// A queued sibling can start a successor without supplying any input:
			// its Delivery is still blocked by the interrupted foreground Request.
			if (state.phase !== "dormant" && (
				state.phase !== "live" || record.host.currentRunHasInput() ||
				(currentHandle && this.#continuationRuns.has(currentHandle))
			)) return "already_running";
			if (outstandingIds().length === 0) return "resolved";
			// Retain the startup-to-scheduler gap; the scheduler owns retention
			// after admission and the Run initializer restores Request relationships.
			const handle = currentHandle ?? await record.host.startInLane(["pending_delivery"]);
			let admitted = false;
			try {
				if (!record.host.isCurrent(handle)) return "fenced";
				if (record.host.blocksOrdinaryDelivery()) return "held";
				const requestMessageIds = outstandingIds();
				if (requestMessageIds.length === 0) return "resolved";
				// Run sequences restart with a cold host; retained proof must identify
				// this activation independently of that process-local counter.
				const activationId = randomUUID();
				const customMessage = () => createWorkflowContinuation({
					activationId,
					agentId: record.identity.agentId,
					runSequence: handle.sequence,
					...options.recovery.view(),
				});
				const result = await this.#messages.admitCustomDeliveryInLane(record, {
					messageId: JSON.stringify(["workflow_continuation", record.identity.agentId, activationId]),
					deliveryMode: "deferred",
					get customMessage() { return customMessage(); },
					isReady: () => options.recovery.isReady(),
					inspectProof: () => inspectWorkflowContinuation(
						record.identity.agentId, record.transcript.inspect(), customMessage(),
					),
					isSuppressed: () => !record.host.isCurrent(handle) || outstandingIds().length === 0,
				});
				admitted = result === "pending";
				if (admitted) this.#continuationRuns.add(handle);
				return result === "pending" ? "activated" : result;
			} finally {
				if (!admitted && !currentHandle && record.host.isCurrent(handle)) {
					record.host.removeRetentionReason("pending_delivery");
					await record.host.releaseIfEligibleInLane(handle);
				}
			}
		});
	}

	resumeFromHuman(
		agentId: string,
		text: string,
		images: readonly ImageContent[] | undefined,
		submissionSequence?: number,
	): Promise<boolean> {
		const record = this.#requireAgent(agentId);
		return record.host.lane.run(() =>
			this.resumeFromHumanInLane(record, text, images, submissionSequence)
		);
	}

	async resumeFromHumanInLane(
		record: AgentRecord,
		text: string,
		images: readonly ImageContent[] | undefined,
		submissionSequence?: number,
	): Promise<boolean> {
		const hold = record.host.currentResumptionHold();
		if (!hold) return false;
		if (record.host.currentRunSuspension()) await record.host.prepareSuspensionResumptionInLane({ humanInputPending: true });
		if (!record.host.beginIsolatedResumptionInLane(hold)) {
			throw new Error("Run resumption is already in progress");
		}
		try {
			await this.submitFromHumanInLane(record, text, images, submissionSequence);
			if (!record.host.commitIsolatedResumptionInLane(hold)) {
				throw new Error(
					"invariant_violation: committed human resume Message lost its exact Hold",
				);
			}
			return true;
		} catch (error) {
			record.host.cancelIsolatedResumptionInLane(hold);
			throw error;
		}
	}

	async submitFromHumanInLane(
		record: AgentRecord,
		text: string,
		images: readonly ImageContent[] | undefined,
		submissionSequence?: number,
	): Promise<void> {
		const content: Array<TextContent | ImageContent> = [
			{ type: "text", text },
			...(images ?? []),
		];
		const delivery = record.host.deliverInLane(
			{ kind: "user", content, forwardedInput: submissionSequence === undefined ? {} : { submissionSequence } },
			{
				inspectCommit: () => {
					const tail = record.transcript.inspect().entries.at(-1);
					if (tail?.type !== "message" || tail.message.role !== "user") return false;
					// Pi normalizes prompt images (re-encoding or omitting them) and appends its
					// image hints after the text, so only the leading submitted text is stable.
					const committed = tail.message.content;
					const committedText = typeof committed === "string"
						? committed
						: committed[0]?.type === "text" ? committed[0].text : undefined;
					return committedText?.startsWith(text) === true;
				},
			},
		);
		const committed = await delivery.transcriptCommit;
		if (!committed) throw new Error("Human input did not commit");
	}

	#requireControllableTarget(callerAgentId: string, targetAgentId: string): AgentRecord {
		const caller = this.#requireAgent(callerAgentId);
		const target = this.#requireAgent(targetAgentId);
		const callerIsModerator = isModeratorIdentity(caller.identity);
		if (
			targetAgentId === this.#ownerAgentId ||
			targetAgentId === callerAgentId ||
			(callerAgentId !== this.#ownerAgentId &&
				!callerIsModerator &&
				target.identity.directSpawnerAgentId !== caller.identity.agentId)
		) {
			throw new Error(
				`unauthorized: Agent ${callerAgentId} cannot control Agent Run ${targetAgentId}`,
			);
		}
		return target;
	}

	#requireAgent(agentId: string): AgentRecord {
		return requireAgentRecord(
			this.#agents,
			this.#quarantinedAgentIds,
			agentId,
		);
	}
}
