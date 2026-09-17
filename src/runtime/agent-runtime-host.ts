import type { ModelVisibleDeliveryFailure } from "../protocol/delivery-failure.ts";
import type { ModelVisibleWorkflowContinuation } from "../protocol/workflow-continuation.ts";
import type { ModelVisibleModeratorObligationReminder } from "../protocol/moderator-obligation-reminder.ts";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import type { TerminalProjection } from "../presentation/terminal-projection.ts";
import type { ModelVisibleRunFailureRecovery } from "../protocol/run-failure-recovery.ts";
import type {
	ModelVisibleMessage,
	ModelVisibleMessageDelivery,
} from "../protocol/message-delivery.ts";
import type { ContextPreparation } from "../policy/working-zone-preparation.ts";
import type { ModelVisibleModeratorRoutineStart } from "../protocol/moderator-input.ts";
import type { ModelVisibleObligationReminder } from "../protocol/obligation-reminder.ts";
import type {
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";
import type { SerialLane } from "./serial-lane.ts";
import type { QuotaEvidence } from "./quota-evidence.ts";

export type AgentQuotaSuspension = Readonly<{
	reason: "provider_quota";
	evidence: QuotaEvidence;
}>;
export type QuotaSuspendedNativeInput = Readonly<{ steering: readonly string[]; followUp: readonly string[] }>;

export type RunRetentionReason =
	| "owner_host_binding"
	| "pending_delivery"
	| "awaiting_answer"
	| "answer_owed"
	| "interruption_hold"
	| "moderator_handling";

export type AgentRuntimeRetentionReason = "interactive_selection";
export type AgentRetentionReason = RunRetentionReason | AgentRuntimeRetentionReason;
export type AgentRetention = Readonly<{
	reason: AgentRetentionReason;
	count: number;
}>;

export type LiveRunState = Readonly<{
	phase: "starting" | "live" | "ending";
	work?: "active" | "settled";
	attention: "none" | "input_required" | "agent_wait";
	suspension?: AgentQuotaSuspension;
	retentionReasons: readonly AgentRetention[];
}>;
export type DormantRunState = Readonly<{
	phase: "dormant";
	suspension?: never;
	retentionReasons: readonly [];
}>;
export type AgentRunState = LiveRunState | DormantRunState;
export type AgentRunHandle = Readonly<{ sequence: number }>;
export type ProjectionInputSubmission = Readonly<{ sequence: number }>;
export type RuntimeInitializationTermination = Readonly<{
	cancellation: Promise<boolean>;
}>;
export type RunResumptionHandle = Readonly<{
	run: AgentRunHandle;
	sequence: number;
}>;
export type AgentRunSettlement = "settled" | "failed";
export type AgentRunEndCause = "clean" | "failure" | "termination" | "shutdown";
export type AgentRunFailure = Readonly<{ stage: string; error: string; provenance: string }>;
export type ResidualRequestRelationships = Readonly<{
	awaitingAnswerRequestIds: readonly string[];
	answerOwedRequestIds: readonly string[];
}>;

export type EffectiveRuntimeSnapshot = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	tools: readonly string[];
	skills: readonly string[];
	skillSources: readonly Readonly<{ name: string; filePath: string }>[];
	fileExtensionPaths: readonly string[];
	projectTrusted: boolean;
	sessionId: string;
}>;

export type AgentRuntimeWorkState = "active" | "settled" | "unavailable";
export type ToolBatchClassification = "blocking" | "asynchronous";

export type WorkingZonePreparation = Readonly<{
	intent: ContextPreparation;
	prospectiveRequest: Extract<ModelVisibleMessage, { kind: "request" }>;
}>;

export type AgentRuntimeDelivery =
	| Readonly<{
		kind: "custom";
		message:
			| ModelVisibleMessageDelivery
			| ModelVisibleModeratorRoutineStart
			| ModelVisibleModeratorObligationReminder
			| ModelVisibleObligationReminder
			| ModelVisibleRunFailureRecovery
			| ModelVisibleWorkflowContinuation
			| ModelVisibleDeliveryFailure;
		triggerTurn: boolean;
		deliverAs?: "steer" | "followUp";
		workingZonePreparation?: WorkingZonePreparation;
	}>
	| Readonly<{
		kind: "user";
		content: string | readonly (TextContent | ImageContent)[];
		deliverAs?: "steer" | "followUp";
		/** Marks forwarding from a native input hook; child input uses its exact sequence. */
		forwardedInput?: Readonly<{ submissionSequence?: number }>;
	}>;
/** The episode owner orders this callback against clearance through native transcript proof. */
export type ModeratorReminderCommit = () => Promise<"committed" | "busy">;
export type ModeratorReminderOutcome = "committed" | "busy" | "suppressed";
export type CommitModeratorReminderIfCurrent = (
	commit: ModeratorReminderCommit,
) => Promise<ModeratorReminderOutcome>;

export type TranscriptCommitConfirmation = Readonly<{
	inspectCommit(): boolean;
}>;
export type AgentRuntimeDeliveryDispatch = Readonly<{
	completion: Promise<void>;
	transcriptCommit?: Promise<boolean>;
}>;

/** Coordination-facing Runtime Host seam. Pi runtime objects remain behind it. */
export interface AgentRuntimeHost {
	readonly lane: SerialLane;
	observe(): AgentRunState;
	currentHandle(): AgentRunHandle | undefined;
	currentProjection(): TerminalProjection | undefined;
	captureProjectionInputSubmission(sequence: number): ProjectionInputSubmission | undefined;
	projectionInputSubmissionIsFenced(submission: ProjectionInputSubmission): boolean;
	effectiveRuntimeSnapshot(): EffectiveRuntimeSnapshot | undefined;
	synchronizeRuntimeState(): Promise<EffectiveRuntimeSnapshot>;
	currentWorkState(): AgentRuntimeWorkState;
	/** Whether this exact Run has accepted input or owned model activity. */
	currentRunHasInput(): boolean;
	classifyToolBatch(toolNames: readonly string[]): ToolBatchClassification;
	exactRunCancellationSignal(handle: AgentRunHandle): AbortSignal;
	deliverInLane(
		delivery: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	): AgentRuntimeDeliveryDispatch;
	deliverModeratorReminderInLane(
		commitIfCurrent: CommitModeratorReminderIfCurrent,
	): Promise<ModeratorReminderOutcome>;
	startInLane(reasons?: readonly AgentRetentionReason[]): Promise<AgentRunHandle>;
	prepareInLane(reasons?: readonly AgentRetentionReason[]): Promise<void>;
	beginShutdown(): Promise<boolean>;
	cancelRuntimeInitialization(projection: TerminalProjection, error: unknown): Promise<boolean>;
	requestRuntimeInitializationTermination(
		projection: TerminalProjection,
		error: unknown,
	): RuntimeInitializationTermination | undefined;
	completeRuntimeInitializationTerminationInLane(
		request: RuntimeInitializationTermination,
	): boolean;
	addSettledHandler(
		handler: (handle: AgentRunHandle, settlement: AgentRunSettlement) => void,
	): () => void;
	addEndedHandler(
		handler: (handle: AgentRunHandle, cause: AgentRunEndCause, failure?: AgentRunFailure) => void,
	): () => void;
	addStateChangeHandler(handler: () => void): () => void;
	setProjectionInputSettledHandler(handler: () => void): void;
	setRunFenceHandler(handler: (handle: AgentRunHandle) => void): void;
	setRunStartInitializer(initializer: () => ResidualRequestRelationships | Promise<ResidualRequestRelationships>): void;
	setRunStartedHandler(
		handler: (handle: AgentRunHandle) => void | Promise<void>,
	): void;
	setRunEndingHandler(
		handler: (
			handle: AgentRunHandle,
			cause: Exclude<AgentRunEndCause, "clean">,
		) => void | Promise<void>,
	): void;
	initializeCurrentRunRelationships(): Promise<void>;
	latestStartedRunSequence(): number;
	currentRunFailed(): boolean;
	isCurrent(handle: AgentRunHandle): boolean;
	blocksOrdinaryDelivery(): boolean;
	isInterrupting(): boolean;
	currentInterruptionHold(): RunResumptionHandle | undefined;
	currentResumptionHold(): RunResumptionHandle | undefined;
	currentQuotaSuspension(): AgentQuotaSuspension | undefined;
	quotaSuspensionBlocksExecution(): boolean;
	prepareQuotaResumptionInLane(options?: { humanInputPending: boolean }): Promise<void>;
	setQuotaSuspensionHandler(handler: (suspension: AgentQuotaSuspension | undefined, handle: AgentRunHandle, nativeInput?: QuotaSuspendedNativeInput) => void): void;
	isCurrentResumptionHold(hold: RunResumptionHandle): boolean;
	beginIsolatedResumptionInLane(hold: RunResumptionHandle): boolean;
	commitIsolatedResumptionInLane(hold: RunResumptionHandle): boolean;
	cancelIsolatedResumptionInLane(hold: RunResumptionHandle): void;
	finishIsolatedResumptionInLane(handle: AgentRunHandle): void;
	interruptCurrentRunInLane(): Promise<"held" | "already_held" | "not_running">;
	prepareInterruption(): void;
	beginInputRequired(handle: AgentRunHandle, requestId: string): void;
	acceptsInputRequired(handle: AgentRunHandle, requestId: string): boolean;
	failExactRun(handle: AgentRunHandle): void;
	endInputRequired(handle: AgentRunHandle, requestId: string): void;
	beginAgentWait(handle: AgentRunHandle, toolCallId: string): void;
	endAgentWait(handle: AgentRunHandle, toolCallId: string): void;
	addRetentionReason(reason: AgentRetentionReason, requestId?: string): void;
	removeRetentionReason(reason: AgentRetentionReason, requestId?: string): void;
	hasRetentionReason(reason: AgentRetentionReason, requestId?: string): boolean;
	requestRelationshipIds(reason: "awaiting_answer" | "answer_owed"): readonly string[];
	residualRequestCounts(): Readonly<{ incoming: number; outgoing: number }>;
	/** Human-facing activity only; not a scheduling or lifecycle state. */
	isCompacting(): boolean;
	queuedInputCount(): number;
	releaseIfEligibleInLane(handle: AgentRunHandle): Promise<"released" | "retained" | "stale">;
	releasePreparedRuntimeInLane(): Promise<"released" | "retained" | "stale">;
	discardAndEndInLane(
		cause: Exclude<AgentRunEndCause, "clean">,
		disposeRuntime?: () => Promise<void>,
	): Promise<void>;
}
