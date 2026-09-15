import type {
	CommitModeratorReminderIfCurrent,
	ModeratorReminderOutcome,
	AgentRuntimeDelivery,
	AgentRunFailure,
	AgentRuntimeDeliveryDispatch,
	AgentRuntimeWorkState,
	EffectiveRuntimeSnapshot,
	ToolBatchClassification,
	TranscriptCommitConfirmation,
} from "./agent-runtime-host.ts";
import type { HostedAgentProjection } from "./hosted-agent-projection.ts";

export type HostedRuntimeEvent =
	| Readonly<{ type: "state_changed" }>
	| Readonly<{
		type: "agent_end";
		outcome: "completed" | "aborted" | "error";
		willRetry: boolean;
		failure?: AgentRunFailure;
	}>
	| Readonly<{ type: "agent_settled" }>;

/** Internal process-neutral adapter owned by one prepared/live host Runtime. */
export interface HostedAgentRuntime {
	readonly projection: HostedAgentProjection | undefined;
	snapshot(): EffectiveRuntimeSnapshot;
	synchronizeState(): Promise<void>;
	workState(): AgentRuntimeWorkState;
	hasPendingActivity(): boolean;
	/** Human-facing activity only; not a scheduling or lifecycle state. */
	isCompacting(): boolean;
	queuedInputCount(): number;
	classifyToolBatch(toolNames: readonly string[]): ToolBatchClassification;
	cancellationSignal(): AbortSignal;
	deliver(
		delivery: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	): AgentRuntimeDeliveryDispatch;
	deliverModeratorReminder(commitIfCurrent: CommitModeratorReminderIfCurrent): Promise<ModeratorReminderOutcome>;
	subscribe(handler: (event: HostedRuntimeEvent) => void): () => void;
	clearQueue(): Promise<Readonly<{ steering: string[]; followUp: string[] }>>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	dispose(): Promise<void>;
}
