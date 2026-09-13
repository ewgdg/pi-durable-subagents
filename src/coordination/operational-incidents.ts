import {
	createModelVisibleModeratorObligationReminder,
	inspectModeratorObligationReminder,
	moderatorObligationReminderDeliveryId,
} from "../protocol/moderator-obligation-reminder.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { uuidv7 } from "@earendil-works/pi-ai";
import { setImmediate } from "node:timers/promises";
import {
	materializeNewAgentTranscript,
	transcriptFromSessionFile,
} from "../pi-integration/session-manager-transcript.ts";
import { resolveModeratorAgentMetadata } from "../protocol/agent-metadata.ts";
import {
	createModelVisibleModeratorInput,
	createModelVisibleModeratorRoutineStart,
	isModeratorIdentity,
	MAX_MODERATOR_REQUEST_SOURCES,
	validateCommittedModeratorInput,
	type EntryPointer,
	type ModeratorIdentity,
	type ModeratorInput,
	type ModeratorTrigger,
} from "../protocol/moderator-input.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	createModelVisibleObligationReminder,
	inspectObligationReminder,
	obligationReminderDeliveryId,
} from "../protocol/obligation-reminder.ts";
import {
	createModelVisibleRunFailureRecovery,
	runFailureRecoveryDeliveryId,
	inspectRunFailureRecovery,
	RUN_FAILURE_RECOVERY_DIRECTIVE,
	type RunFailureRecovery,
} from "../protocol/run-failure-recovery.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import {
	sameModeratorControlInput,
	validateModeratorControlInput,
} from "../protocol/moderator-control.ts";
import {
	ProtocolInvariantError,
	resolveCommittedToolCall,
	toolCallPointerKey,
	type ToolCallPointer,
} from "../protocol/identities.ts";
import type { ProcessChildSessionFactory } from "../runtime/process-child-session-factory.ts";
import type { AgentRunHandle } from "../runtime/agent-runtime-host.ts";
import { SerialLane } from "../runtime/serial-lane.ts";
import type { WorkflowPolicyStore } from "../policy/workflow-policy.ts";
import { statusOf, type AgentRecord } from "./agent-record.ts";
import { detectDependencyDeadlocks } from "./dependency-deadlock.ts";
import type { MessageCoordinator } from "./messages.ts";
import {
	OperationReviewWatcher,
	SYSTEM_OPERATION_REVIEW_CLOCK,
	type OperationReviewClock,
	type OperationReviewSnapshot,
} from "./operation-review.ts";

export const MAX_AUTOMATIC_MODERATOR_ATTEMPTS = 2;

type ConditionSnapshotBase = Readonly<{
	key: string;
	affectedAgentIds: readonly string[];
	requestIds: readonly string[];
	inspectedThrough: readonly EntryPointer[];
}>;

type ObligationStallSnapshot = ConditionSnapshotBase & Readonly<{
	kind: "obligation_stall";
	agentId: string;
}>;

type RunFailureSnapshot = ConditionSnapshotBase & Readonly<{
	kind: "run_failure";
	agentId: string;
	run: AgentRunHandle;
}>;

type DependencyDeadlockSnapshot = ConditionSnapshotBase & Readonly<{
	kind: "dependency_deadlock";
}>;

type OperationReviewConditionSnapshot = ConditionSnapshotBase & Readonly<{
	kind: "operation_review";
	review: OperationReviewSnapshot;
}>;

type DeliveryStallSnapshot = ConditionSnapshotBase & Readonly<{
	kind: "delivery_stall";
	delivery: Readonly<{ messageId: string; recipientAgentId: string }>;
	reason: import("./delivery-progress.ts").DeliveryBlockageReason;
}>;

type OperationalConditionSnapshot =
	| DeliveryStallSnapshot
	| ObligationStallSnapshot
	| RunFailureSnapshot
	| DependencyDeadlockSnapshot
	| OperationReviewConditionSnapshot;

type OperationalIncidentHandling = {
	snapshot: OperationalConditionSnapshot;
	moderatorAgentId?: string;
	committedAttemptCount: number;
	diagnostics: EntryPointer[];
	exhausted: boolean;
	creationFailed: boolean;
	trigger?: ModeratorTrigger;
	previousAttempt?: EntryPointer;
};

export type OperationalIncidentAttention = Readonly<{
	trigger: ModeratorTrigger | Readonly<{ kind: "moderation_unavailable" }>;
	summary?: string;
	affectedAgents: readonly Readonly<{
		agentId: string;
		label: string;
	}>[];
	diagnostics: readonly EntryPointer[];
}>;

export type OperationalIncidentPresentation = Readonly<{
	present(conditionKey: string, attention: OperationalIncidentAttention): void;
	dismiss(conditionKey: string): void;
}>;

const unavailablePresentation: OperationalIncidentPresentation = {
	present() {},
	dismiss() {},
};

export type OperationalIncidentBoundaryHooks = Readonly<{
	beforeEvidenceInspection?(): void | Promise<void>;
	beforeModeratorBootstrapCommit?(): void | "confirmed_failure";
	beforeModeratorRunStart?(): void | "confirmed_failure";
}>;

export class OperationalIncidentCoordinator {
	readonly #agents: Map<string, AgentRecord>;
	readonly #ownerIdentity: OwnerIdentity;
	readonly #sessionFactory: ProcessChildSessionFactory;
	readonly #messages: MessageCoordinator;
	readonly #integrateAgent: (record: AgentRecord) => void;
	readonly #isShuttingDown: () => boolean;
	readonly #reportError: (error: unknown) => void;
	readonly #boundaryHooks: OperationalIncidentBoundaryHooks;
	readonly #presentation: OperationalIncidentPresentation;
	readonly #workflowPolicy: WorkflowPolicyStore;
	readonly #deliveryProgressClock: OperationReviewClock;
	#activeCreation: OperationalIncidentHandling | undefined;
	#cancelInspectionDeadline: (() => void) | undefined;
	readonly #operationReviews: OperationReviewWatcher;
	readonly #onAttentionChanged: () => void;
	readonly #faultAttention = new Map<string, OperationalIncidentAttention>();
	readonly #retainDiagnostic: (error: unknown) => EntryPointer;
	readonly #handlingByKey = new Map<string, OperationalIncidentHandling>();
	readonly #attemptByModeratorAgentId = new Map<string, OperationalConditionSnapshot>();
	readonly #runFailureByKey = new Map<string, RunFailureSnapshot>();
	readonly #integratedAgentIds = new Set<string>();
	readonly #reconciliationLane = new SerialLane();
	#pendingReconciliation: Promise<void> | undefined;
	#inspectionStalled = false;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		ownerIdentity: OwnerIdentity;
		sessionFactory: ProcessChildSessionFactory;
		messages: MessageCoordinator;
		workflowPolicy: WorkflowPolicyStore;
		integrateAgent(record: AgentRecord): void;
		isShuttingDown(): boolean;
		reportError(error: unknown): void;
		retainDiagnostic(error: unknown): EntryPointer;
		boundaryHooks?: OperationalIncidentBoundaryHooks;
		presentation?: OperationalIncidentPresentation;
		operationReviewClock?: OperationReviewClock;
		deliveryProgressClock?: OperationReviewClock;
		onAttentionChanged?(): void;
	}) {
		this.#agents = options.agents;
		this.#ownerIdentity = options.ownerIdentity;
		this.#sessionFactory = options.sessionFactory;
		this.#messages = options.messages;
		this.#workflowPolicy = options.workflowPolicy;
		this.#deliveryProgressClock = options.deliveryProgressClock ?? SYSTEM_OPERATION_REVIEW_CLOCK;
		this.#integrateAgent = options.integrateAgent;
		this.#isShuttingDown = options.isShuttingDown;
		this.#reportError = options.reportError;
		this.#retainDiagnostic = options.retainDiagnostic;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#presentation = options.presentation ?? unavailablePresentation;
		this.#onAttentionChanged = options.onAttentionChanged ?? (() => undefined);
		const reviewClock = options.operationReviewClock ?? SYSTEM_OPERATION_REVIEW_CLOCK;
		this.#operationReviews = new OperationReviewWatcher({
			clock: {
				schedule: (delayMs, callback) => reviewClock.schedule(delayMs,
					() => this.#containEvidenceInspection(callback)),
			},
			isUnresolved: (toolCall) => this.#isToolCallUnresolved(toolCall),
			hasAnswerObligation: (agentId) => {
				const record = this.#agents.get(agentId);
				return record !== undefined &&
					this.#messages.answerObligationRequestIds(record).length > 0;
			},
			onReviewStateChanged: () => this.#scheduleReconciliation(),
		});
		if (!options.agents.has(options.ownerIdentity.agentId)) {
			throw new Error("invariant_violation: Workflow Owner is unavailable");
		}
	}

	integrate(record: AgentRecord): void {
		if (this.#integratedAgentIds.has(record.identity.agentId)) return;
		this.#integratedAgentIds.add(record.identity.agentId);
		record.host.addSettledHandler((_handle, settlement) => {
			this.#containEvidenceInspection(() => this.#operationReviews.setAgentAttendance(record.identity.agentId, "idle"));
			if (settlement !== "settled") return;
			this.#scheduleReconciliationAfterHostLane(record);
		});
		record.host.addEndedHandler((handle, cause) => this.#containEvidenceInspection(() => {
			this.#operationReviews.endRun(record.identity.agentId);
			if (this.#isModerator(record)) {
				if (cause === "failure" && !this.#isShuttingDown()) {
					void this.#reconciliationLane
						.run(async () => {
							const handling = [...this.#handlingByKey.values()].find(
								(candidate) =>
									candidate.moderatorAgentId === record.identity.agentId,
							);
							if (handling) await this.#handleModeratorFailure(handling, record);
						})
						.catch((error: unknown) => this.#presentFault("moderation:evidence", error));
				}
				return;
			}
			if (
				cause === "failure" &&
				!this.#isShuttingDown()
			) {
				const requestIds = [...this.#messages.answerObligationRequestIds(record)].sort();
				if (requestIds.length > 0) {
					const snapshot: RunFailureSnapshot = {
						kind: "run_failure",
						key: JSON.stringify([
							"run_failure",
							record.identity.agentId,
							handle.sequence,
						]),
						agentId: record.identity.agentId,
						affectedAgentIds: [record.identity.agentId],
						run: handle,
						requestIds,
						inspectedThrough: [statusOf(record).primaryEvidence.inspectedThrough],
					};
					this.#runFailureByKey.set(snapshot.key, snapshot);
				}
			}
			this.#scheduleReconciliation();
		}));
		record.host.addStateChangeHandler(() => {
			this.#containEvidenceInspection(() => this.#operationReviews.reconcileAgent(record.identity.agentId));
			this.#scheduleReconciliation();
		});
	}

	deliveryProgressChanged(): void {
		void this.#scheduleReconciliation();
	}

	hasAutonomousRecoveryProgress(): boolean {
		return !this.#isShuttingDown() && !this.#inspectionStalled &&
			(this.#pendingReconciliation !== undefined || this.#cancelInspectionDeadline !== undefined);
	}

	beginExecution(agentId: string): void {
		this.#containEvidenceInspection(() => this.#operationReviews.setAgentAttendance(agentId, "attended"));
	}

	admitToolExecution(agentId: string, toolCallId: string, toolName: string): void {
		const record = this.#requireAgent(agentId);
		this.#operationReviews.reconcileAgent(agentId);
		const transcript = record.transcript.inspect();
		const { source } = resolveCommittedToolCall({
			agentId,
			transcript,
			toolCallId,
			toolName,
		});
		// Agent Wait is intentional coordination suspension. Dependency Deadlock
		// observes its Request graph; Operation Review must not time the parked tool.
		if (toolName === "agent_wait") return;
		const entry = transcript.entries.find(({ id }) => id === source.entryId);
		if (entry?.type !== "message" || entry.message.role !== "assistant") {
			throw new Error("invariant_violation: root tool call source is unavailable");
		}
		const toolCalls = entry.message.content.filter((part) => part.type === "toolCall");
		const classification = record.host.classifyToolBatch(
			toolCalls.map(({ name }) => name),
		);
		this.#operationReviews.admit({
			toolCall: source,
			classification,
			policyIntervalMs: this.#workflowPolicy.current().operationReviewIntervalMs,
		});
	}

	beginHumanWaiting(toolCall: ToolCallPointer): void {
		this.#operationReviews.beginHumanWaiting(toolCall);
	}

	beginHumanResultCommit(toolCall: ToolCallPointer): void {
		this.#operationReviews.beginHumanResultCommit(toolCall);
	}

	reconcileCommittedToolResults(agentId: string): void {
		this.#containEvidenceInspection(() => this.#operationReviews.reconcileAgent(agentId));
		this.#scheduleReconciliation();
	}

	#containEvidenceInspection(inspect: () => void): void {
		try {
			inspect();
		} catch (error) {
			this.#presentFault("moderation:evidence", error);
		}
	}

	executeModeratorControl(
		moderatorAgentId: string,
		toolCallId: string,
		providedInput: ModeratorControlInput,
	): Promise<ModeratorControlReceipt> {
		const moderator = this.#agents.get(moderatorAgentId);
		if (!moderator) throw new Error(`unknown_identity: ${moderatorAgentId}`);
		const { input: committedInput } = resolveCommittedToolCall({
			agentId: moderatorAgentId,
			transcript: moderator.transcript.inspect(),
			toolCallId,
			toolName: "moderator_control",
		});
		const input = validateModeratorControlInput(committedInput);
		if (!sameModeratorControlInput(input, providedInput)) {
			throw new Error(
				"invariant_violation: executed Moderator control input differs from its source",
			);
		}
		return this.#reconciliationLane.run(() =>
			input.operation === "renew_review_deadline"
				? this.#renewOperationReview(input)
				: this.#resolveHandling(moderatorAgentId, moderator)
		);
	}

	async #renewOperationReview(
		input: Extract<ModeratorControlInput, { operation: "renew_review_deadline" }>,
	): Promise<ModeratorControlReceipt> {
		this.#assertWorkflowToolCallPointer(input.toolCall);
		const disposition = this.#operationReviews.renew(
			input.toolCall,
			input.nextReviewInMs,
		);
		await this.#reconcileWorkflow();
		return disposition === "renewed"
			? {
				disposition,
				toolCall: input.toolCall,
				nextReviewInMs: input.nextReviewInMs,
			}
			: { disposition, toolCall: input.toolCall };
	}

	#resolveHandling(
		moderatorAgentId: string,
		moderator: AgentRecord,
	): ModeratorControlReceipt {
		const handling = [...this.#handlingByKey.values()].find(
			(candidate) => candidate.moderatorAgentId === moderatorAgentId,
		);
		const attempt = this.#attemptByModeratorAgentId.get(moderatorAgentId);

		const predicates: Array<
			| "incoming_requests"
			| "outgoing_requests"
			| "obligation_stall"
			| "run_failure"
			| "dependency_deadlock"
			| "operation_review"
			| "delivery_stall"
		> = [];
		if (moderator.host.requestRelationshipIds("answer_owed").length > 0) {
			predicates.push("incoming_requests");
		}
		if (moderator.host.requestRelationshipIds("awaiting_answer").length > 0) {
			predicates.push("outgoing_requests");
		}
		const current = handling && this.#conditionRemains(handling.snapshot);
		if (handling && current) {
			predicates.push(handling.snapshot.kind);
		}
		if (predicates.length > 0) {
			return { disposition: "blocked", predicates };
		}
		if (!attempt) return { disposition: "already_cleared" };
		if (handling) this.#releaseHandling(handling.snapshot.key);
		this.#attemptByModeratorAgentId.delete(moderatorAgentId);
		const originalObligationRemains = attempt.affectedAgentIds.some((agentId) => {
			const affected = this.#agents.get(agentId);
			return affected !== undefined && this.#messages.hasUnsettledAnswerObligation(
				affected,
				attempt.requestIds,
			);
		});
		return {
			disposition: originalObligationRemains ? "resolved" : "already_cleared",
		};
	}

	attentionItems(callerAgentId: string): readonly OperationalIncidentAttention[] {
		if (callerAgentId !== this.#ownerIdentity.agentId) return [];
		const exhausted = [...this.#handlingByKey.values()].flatMap((handling) =>
			handling.exhausted ? [this.#attentionFor(handling)] : []
		);
		return [...this.#faultAttention.values(), ...exhausted];
	}

	reachSafeBoundary(): Promise<void> {
		return this.#reconciliationLane.run(() => undefined);
	}

	shutdown(): void {
		this.#cancelInspectionDeadline?.();
		this.#operationReviews.shutdown();
		this.#messages.shutdownDeliveryProgress();
		let attentionDismissed = false;
		for (const [key, handling] of this.#handlingByKey) {
			if (!handling.exhausted) continue;
			this.#presentation.dismiss(key);
			attentionDismissed = true;
		}
		for (const key of this.#faultAttention.keys()) this.#dismissFault(key);
		this.#handlingByKey.clear();
		this.#attemptByModeratorAgentId.clear();
		this.#runFailureByKey.clear();
		if (attentionDismissed) this.#onAttentionChanged();
	}

	#reconcileWorkflow(): Promise<void> {
		return this.#withModerationDeadline(async () => {
			await this.#inspectWorkflow();
			this.#dismissFault("moderation:evidence");
		});
	}

	async #withModerationDeadline(work: () => Promise<void>): Promise<void> {
		// Initial bootstrap and its immediate replacements share the enclosing
		// inspection deadline; a later terminal failure starts its own pass.
		if (this.#cancelInspectionDeadline) return work();
		// This watches the observation pass itself, not the affected Agent's model
		// or parked Wait. A hung inspector/bootstrap must not hide Owner attention.
		const intervalMs = this.#workflowPolicy.current().deliveryProgressIntervalMs;
		this.#inspectionStalled = false;
		this.#cancelInspectionDeadline = this.#deliveryProgressClock.schedule(intervalMs, () => {
			this.#inspectionStalled = true;
			const handling = this.#activeCreation;
			this.#presentFault(handling ? `moderation:creation:${handling.snapshot.key}` : "moderation:evidence",
				new Error(`Moderation ${handling ? "creation" : "evidence inspection"} made no completion within ${intervalMs}ms`), handling);
			// An existing fault may deduplicate its UI entry, but this inspection
			// has just ceased to be autonomous progress for a parked Owner.
			this.#onAttentionChanged();
		});
		try {
			await work();
		} catch (error) {
			this.#presentFault("moderation:evidence", error);
		} finally {
			this.#cancelInspectionDeadline?.();
			this.#cancelInspectionDeadline = undefined;
			this.#activeCreation = undefined;
			this.#onAttentionChanged();
		}
	}

	#presentFault(key: string, error: unknown, handling?: OperationalIncidentHandling): void {
		if (this.#isShuttingDown() || this.#faultAttention.has(key)) return;
		const agentIds = handling?.snapshot.affectedAgentIds ?? [this.#ownerIdentity.agentId];
		const attention: OperationalIncidentAttention = {
			trigger: handling?.trigger ?? { kind: "moderation_unavailable" },
			summary: handling ? "Moderator creation blocked; inspect diagnostic evidence." : "Moderation evidence inspection blocked; inspect diagnostic evidence.",
			affectedAgents: agentIds.map((agentId) => ({ agentId, label: this.#requireAgent(agentId).identity.metadata.label })),
			diagnostics: [this.#retainDiagnostic(error)],
		};
		this.#faultAttention.set(key, attention);
		this.#presentation.present(key, attention);
		this.#onAttentionChanged();
	}

	#dismissFault(key: string): void {
		if (!this.#faultAttention.delete(key)) return;
		this.#presentation.dismiss(key);
		this.#onAttentionChanged();
	}

	async #inspectWorkflow(): Promise<void> {
		if (this.#isShuttingDown()) return;
		await this.#boundaryHooks.beforeEvidenceInspection?.();
		await this.#messages.refreshTranscriptFacts();
		if (this.#isShuttingDown()) return;
		const snapshots: OperationalConditionSnapshot[] = [];
		for (const [key, snapshot] of this.#runFailureByKey) {
			if (!this.#conditionRemains(snapshot)) {
				await this.#notifyRunFailureRecovery(snapshot);
				this.#runFailureByKey.delete(key);
				continue;
			}
			snapshots.push(snapshot);
		}
		const deliveryStalls = this.#observeDeliveryStalls();
		snapshots.push(...deliveryStalls);
		snapshots.push(...this.#observeOperationReviews());
		const dependencyDeadlocks = this.#observeDependencyDeadlocks();
		snapshots.push(...dependencyDeadlocks);
		const dependencyHandledAgentIds = new Set(
			[...dependencyDeadlocks, ...deliveryStalls].flatMap(({ affectedAgentIds }) => affectedAgentIds),
		);
		for (const record of [...this.#agents.values()]) {
			if (
				this.#isModerator(record) ||
				dependencyHandledAgentIds.has(record.identity.agentId)
			) continue;
			const snapshot = this.#observeObligationStall(record);
			if (snapshot) snapshots.push(snapshot);
		}
		const currentKeys = new Set(snapshots.map(({ key }) => key));
		for (const key of this.#faultAttention.keys()) {
			if (key.startsWith("moderation:creation:") && !currentKeys.has(key.slice("moderation:creation:".length))) this.#dismissFault(key);
		}
		for (const key of this.#handlingByKey.keys()) {
			if (!currentKeys.has(key)) this.#releaseHandling(key);
		}
		for (const snapshot of snapshots) {
			const existing = this.#handlingByKey.get(snapshot.key);
			if (existing?.moderatorAgentId !== undefined) {
				this.#scheduleModeratorObligationReminder(existing);
				continue;
			}
			if (existing?.exhausted || existing?.creationFailed) continue;
			if (
				!existing &&
				snapshot.kind === "obligation_stall" &&
				this.#scheduleObligationReminder(snapshot)
			) continue;
			const handling: OperationalIncidentHandling = existing ?? {
				snapshot,
				committedAttemptCount: 0,
				diagnostics: [],
				exhausted: false,
				creationFailed: false,
			};
			this.#handlingByKey.set(snapshot.key, handling);
			await this.#attemptModeratorCreation(handling);
		}
	}

	#attemptModeratorCreation(handling: OperationalIncidentHandling): Promise<void> {
		return this.#withModerationDeadline(async () => {
			const previousCreation = this.#activeCreation;
			this.#activeCreation = handling;
			try {
				handling.trigger = this.#triggerFor(handling.snapshot);
				await this.#createModerator(handling);
				// Initial creation can synchronously lead to replacement creation.
				// Do not clear that replacement's fault when the outer call returns.
				if (!handling.creationFailed) this.#dismissFault(`moderation:creation:${handling.snapshot.key}`);
			} catch (error) {
				// Uncommitted preparation consumes no committed attempt, but must
				// not repeat staging effects on unrelated activity or heartbeats.
				handling.creationFailed = true;
				this.#presentFault(`moderation:creation:${handling.snapshot.key}`, error, handling);
			} finally {
				this.#activeCreation = previousCreation;
			}
		});
	}

	#scheduleObligationReminder(
		snapshot: ObligationStallSnapshot,
	): boolean {
		const requestId = this.#messages.foregroundRequestId(this.#requireAgent(snapshot.agentId));
		if (!requestId) {
			throw new Error(
				`invariant_violation: Agent ${snapshot.agentId} has an invalid Answer obligation set`,
			);
		}
		const recipient = this.#requireAgent(snapshot.agentId);
		const requestTitle = this.#messages.requestTitle(requestId);
		const inspectProof = () => inspectObligationReminder({
			recipientAgentId: snapshot.agentId,
			transcript: recipient.transcript.inspect(),
			requestMessageId: requestId,
			requestTitle,
		});
		if (inspectProof()) return false;
		// Settlement reconciliation can run while the affected Agent lane is held.
		// Schedule admission without awaiting that lane so the reminder cannot
		// deadlock behind the reconciliation that requested it.
		void this.#messages.admitCustomDelivery(recipient, {
			messageId: obligationReminderDeliveryId(requestId),
			deliveryMode: "deferred",
			customMessage: createModelVisibleObligationReminder({
				requestMessageId: requestId,
				requestTitle,
			}),
			inspectProof,
			isSuppressed: () => !this.#messages.hasUnsettledAnswerObligation(
				recipient,
				[requestId],
			),
		}).then((admission) => {
			if (admission !== "pending") {
				throw new Error(`Obligation Reminder delivery rejected: ${admission}`);
			}
		}).catch((error: unknown) => this.#reportError(error));
		return true;
	}

	async #createModerator(
		handling: OperationalIncidentHandling,
	): Promise<void> {
		if (!this.#agents.has(this.#ownerIdentity.agentId)) {
			throw new Error("invariant_violation: Workflow Owner is unavailable");
		}
		this.#sessionFactory.admitProcessRuntimePlatform();
		const agentId = uuidv7();
		const prepared = await this.#sessionFactory.prepareModeratorRun({ agentId });
		const sessionManager = this.#sessionFactory.createStagingSession(prepared);
		if (this.#isShuttingDown()) return;
		if (!this.#conditionRemains(handling.snapshot)) {
			this.#handlingByKey.delete(handling.snapshot.key);
			return;
		}

		const metadata = resolveModeratorAgentMetadata(handling.snapshot.kind);
		const identity: ModeratorIdentity = {
			agentId,
			workflowId: this.#ownerIdentity.workflowId,
			directSpawnerAgentId: null,
			creationPreset: prepared.creationPreset,
			metadata,
		};
		const input: ModeratorInput = {
			trigger: this.#triggerFor(handling.snapshot),
			inspectedThrough: handling.snapshot.inspectedThrough,
			...(handling.previousAttempt === undefined
				? {}
				: { previousAttempt: handling.previousAttempt }),
		};
		const bootstrapBoundary =
			this.#boundaryHooks.beforeModeratorBootstrapCommit?.();
		if (this.#isShuttingDown()) return;
		if (bootstrapBoundary === "confirmed_failure") {
			throw new Error("Confirmed Moderator bootstrap commit failure");
		}
		const modelInput = createModelVisibleModeratorInput(identity, input);
		sessionManager.appendCustomMessageEntry(
			modelInput.customType,
			modelInput.content,
			modelInput.display,
			modelInput.details,
		);
		let sessionPath: string;
		try {
			sessionPath = await materializeNewAgentTranscript(sessionManager);
		} catch (error) {
			if (error instanceof ProtocolInvariantError) throw error;
			const candidatePath = sessionManager.getSessionFile();
			if (!candidatePath || !hasExactDurableModeratorEvidence({
				sessionPath: candidatePath,
				identity,
				input,
			})) throw error;
			sessionPath = candidatePath;
		}
		validateCommittedModeratorInput({
			transcript: transcriptFromSessionFile(sessionPath).inspect(),
			identity,
			input,
		});
		if (handling.snapshot.kind === "operation_review") {
			this.#operationReviews.markModeratorInputCommitted(
				handling.snapshot.review.toolCall,
			);
		}
		handling.moderatorAgentId = agentId;
		handling.committedAttemptCount += 1;
		this.#attemptByModeratorAgentId.set(agentId, handling.snapshot);

		const moderator = this.#sessionFactory.createModeratorRecord({
			identity,
			initialPreparation: prepared,
			sessionPath,
		});
		this.#agents.set(agentId, moderator);
		this.#integrateAgent(moderator);
		if (
			this.#boundaryHooks.beforeModeratorRunStart?.() ===
			"confirmed_failure"
		) {
			await this.#handleModeratorFailure(handling, moderator);
			return;
		}
		try {
			// Keep startup and scheduler admission atomic against queued Run termination.
			await moderator.host.lane.run(async () => {
				if (this.#isShuttingDown()) return;
				await moderator.host.startInLane(["moderator_handling"]);
				if (this.#isShuttingDown()) return;
				const routineStart = createModelVisibleModeratorRoutineStart();
				// Startup is already progress before the child reports agent.start.
				// Scheduler ownership prevents treating this in-flight first turn as a stall.
				const admission = await this.#messages.admitCustomDeliveryInLane(moderator, {
					messageId: JSON.stringify([routineStart.customType, agentId]),
					deliveryMode: "deferred",
					customMessage: routineStart,
					inspectProof: () => {
						const entry = coordinationEntries(moderator.transcript.inspect(), agentId,
							`custom:${routineStart.customType}`).find(entry =>
							entry.type === "custom_message" && entry.content === routineStart.content);
						return entry ? { agentId, entryId: entry.id } : undefined;
					},
				});
				if (admission !== "pending") throw new Error(`Moderator startup delivery rejected: ${admission}`);
			});
		} catch (error) {
			this.#reportError(error);
			await this.#handleModeratorFailure(handling, moderator);
		}
	}

	async #handleModeratorFailure(
		handling: OperationalIncidentHandling,
		moderator: AgentRecord,
	): Promise<void> {
		if (this.#isShuttingDown()) return;
		if (handling.moderatorAgentId !== moderator.identity.agentId) return;
		if (!this.#conditionRemains(handling.snapshot)) {
			this.#releaseHandling(handling.snapshot.key);
			return;
		}
		handling.previousAttempt = statusOf(moderator).primaryEvidence.inspectedThrough;
		handling.diagnostics.push(handling.previousAttempt);
		handling.moderatorAgentId = undefined;
		if (handling.committedAttemptCount < MAX_AUTOMATIC_MODERATOR_ATTEMPTS) {
			await this.#attemptModeratorCreation(handling);
		} else {
			handling.exhausted = true;
			this.#presentation.present(
				handling.snapshot.key,
				this.#attentionFor(handling),
			);
			this.#onAttentionChanged();
		}
	}

	#attentionFor(handling: OperationalIncidentHandling): OperationalIncidentAttention {
		return {
			trigger: handling.trigger ?? this.#triggerFor(handling.snapshot),
			affectedAgents: handling.snapshot.affectedAgentIds.map((agentId) => ({
				agentId,
				label: this.#requireAgent(agentId).identity.metadata.label,
			})),
			diagnostics: [...handling.diagnostics],
		};
	}

	#triggerFor(snapshot: OperationalConditionSnapshot): ModeratorTrigger {
		if (snapshot.kind === "operation_review") {
			return {
				kind: "operation_review",
				toolCall: snapshot.review.toolCall,
				reviewIntervalMs: snapshot.review.reviewIntervalMs,
			};
		}
		const requestSet = {
			total: snapshot.requestIds.length,
			sources: this.#messages.requestSources(
				snapshot.requestIds.slice(0, MAX_MODERATOR_REQUEST_SOURCES),
			),
		};
		if (snapshot.kind === "delivery_stall") {
			return { kind: snapshot.kind, agentIds: snapshot.affectedAgentIds, requests: requestSet,
				delivery: snapshot.delivery, reason: snapshot.reason };
		}
		if (snapshot.kind === "run_failure") {
			return {
				kind: "run_failure",
				agentId: snapshot.agentId,
				runSequence: snapshot.run.sequence,
				obligations: requestSet,
			};
		}
		if (snapshot.kind === "obligation_stall") {
			return {
				kind: "obligation_stall",
				agentId: snapshot.agentId,
				obligations: requestSet,
			};
		}
		return {
			kind: "dependency_deadlock",
			agentIds: snapshot.affectedAgentIds,
			requests: requestSet,
		};
	}

	#isSettledWithoutProgress(record: AgentRecord): boolean {
		const run = record.host.observe();
		if (
			run.phase !== "live" ||
			run.work !== "settled" ||
			record.host.currentRunFailed() ||
			run.attention !== "none" ||
			this.#messages.hasDeliveryProgress(record) ||
			record.host.hasRetentionReason("interactive_selection") ||
			record.host.hasRetentionReason("interruption_hold")
		) {
			return false;
		}
		// Moderator Requests may depend on another Moderator; ordinary incident
		// detection keeps its existing non-Moderator dependency graph.
		return !this.#operationReviews.hasUnresolvedAsynchronousCall(record.identity.agentId) &&
			!this.#hasExternalProgress(record, new Set(), this.#isModerator(record));
	}

	#scheduleModeratorObligationReminder(handling: OperationalIncidentHandling): void {
		const recipient = this.#requireAgent(handling.moderatorAgentId!);
		if (!this.#isSettledWithoutProgress(recipient)) return;
		const inspectProof = () => inspectModeratorObligationReminder({
			moderatorAgentId: recipient.identity.agentId,
			transcript: recipient.transcript.inspect(),
		});
		if (inspectProof()) return;
		// Do not await the recipient lane from reconciliation: settlement can hold
		// that lane while waiting for this inspection, just as for ordinary reminders.
		void this.#messages.admitCustomDelivery(recipient, {
			messageId: moderatorObligationReminderDeliveryId(recipient.identity.agentId),
			commitIfCurrent: commit => this.#reconciliationLane.run(async () => {
				if (this.#handlingByKey.get(handling.snapshot.key) !== handling ||
					handling.moderatorAgentId !== recipient.identity.agentId ||
					!this.#conditionRemains(handling.snapshot)) return "suppressed";
				// Clearance/resolve uses this same lane. Only native transcript ACK may
				// complete this transaction, never enqueueing or model completion.
				return commit();
			}),
			deliveryMode: "deferred",
			customMessage: createModelVisibleModeratorObligationReminder(),
			inspectProof,
			isSuppressed: () => this.#handlingByKey.get(handling.snapshot.key) !== handling ||
				handling.moderatorAgentId !== recipient.identity.agentId ||
				!this.#conditionRemains(handling.snapshot),
		}).then((admission) => {
			if (admission !== "pending") {
				throw new Error(`Moderator Obligation Reminder delivery rejected: ${admission}`);
			}
		}).catch((error: unknown) => this.#reportError(error));
	}

	#observeObligationStall(
		record: AgentRecord,
	): ObligationStallSnapshot | undefined {
		const requestIds = [
			...record.host.requestRelationshipIds("answer_owed"),
		].sort();
		if (requestIds.length === 0 || !this.#isSettledWithoutProgress(record)) return undefined;
		const inspectedThrough = statusOf(record).primaryEvidence.inspectedThrough;
		return {
			kind: "obligation_stall",
			key: JSON.stringify(["obligation_stall", record.identity.agentId, ...requestIds]),
			agentId: record.identity.agentId,
			affectedAgentIds: [record.identity.agentId],
			requestIds,
			inspectedThrough: [inspectedThrough],
		};
	}

	#conditionRemains(snapshot: OperationalConditionSnapshot): boolean {
		if (snapshot.kind === "delivery_stall") return this.#observeDeliveryStalls().some(({ key }) => key === snapshot.key);
		if (snapshot.kind === "operation_review") {
			return this.#operationReviews.expiredReviews().some(
				(review) => toolCallPointerKey(review.toolCall) === snapshot.key,
			);
		}
		if (snapshot.kind === "obligation_stall") {
			const affected = this.#agents.get(snapshot.agentId);
			return affected !== undefined &&
				this.#observeObligationStall(affected)?.key === snapshot.key;
		}
			if (snapshot.kind === "run_failure") {
				const affected = this.#agents.get(snapshot.agentId);
				if (!affected) return false;
				if (affected.host.latestStartedRunSequence() > snapshot.run.sequence) return false;
				return this.#messages.hasUnsettledAnswerObligation(
				affected,
				snapshot.requestIds,
			);
		}
		return this.#observeDependencyDeadlocks().some(({ key }) => key === snapshot.key);
	}


	#observeDeliveryStalls(): readonly DeliveryStallSnapshot[] {
		const blocked = this.#messages.blockedDeliveries();
		const snapshots: DeliveryStallSnapshot[] = [];
		for (const delivery of blocked) {
			const affected = new Set<string>();
			const requests = new Set<string>();
			for (const root of this.#agents.values()) {
				if (this.#isModerator(root) || this.#deliveryPathExcluded(root)) continue;
				const run = root.host.observe();
				// A running model is a progress source, not a timed obligation.
				if (run.phase !== "live" || (run.work === "active" && run.attention !== "agent_wait")) continue;
				const obligations = this.#messages.answerObligationRequestIds(root);
				if (obligations.length === 0) continue;
				const visit = (record: AgentRecord, path: string[], edges: string[]): void => {
					const agentId = record.identity.agentId;
					if (path.includes(agentId) || this.#deliveryPathExcluded(record)) return;
					const currentRun = record.host.observe();
					if (agentId !== delivery.recipientAgentId && (
						currentRun.phase === "starting" ||
						(currentRun.phase === "live" && currentRun.work === "active" && currentRun.attention === "none")
					)) return;
					const nextPath = [...path, agentId];
					if (agentId === delivery.recipientAgentId) {
						for (const id of nextPath) affected.add(id);
						for (const id of [...obligations, ...edges]) requests.add(id);
					}
					for (const edge of this.#messages.requestRelationships(
						this.#messages.outstandingRequestIdsFor(record),
					)) {
						const target = this.#agents.get(edge.targetAgentId);
						if (target && !this.#isModerator(target)) visit(target, nextPath, [...edges, edge.requestId]);
					}
				};
				visit(root, [], []);
			}
			if (requests.size === 0) continue;
			const affectedAgentIds = [...affected].sort((a, b) => a.localeCompare(b));
			snapshots.push({
				kind: "delivery_stall",
				key: JSON.stringify(["delivery_stall", delivery.messageId]),
				affectedAgentIds,
				requestIds: [...requests].sort(),
				inspectedThrough: affectedAgentIds.map((id) => statusOf(this.#requireAgent(id)).primaryEvidence.inspectedThrough),
				delivery: { messageId: delivery.messageId, recipientAgentId: delivery.recipientAgentId },
				reason: delivery.reason,
			});
		}
		return snapshots;
	}

	#deliveryPathExcluded(record: AgentRecord): boolean {
		const run = record.host.observe();
		return (run.phase !== "dormant" && run.attention === "input_required") ||
			record.host.hasRetentionReason("interactive_selection") ||
			record.host.hasRetentionReason("interruption_hold");
	}

	#observeOperationReviews(): readonly OperationReviewConditionSnapshot[] {
		return this.#operationReviews.expiredReviews().flatMap((review) => {
			const record = this.#agents.get(review.toolCall.agentId);
			if (!record) return [];
			const requestIds = [...this.#messages.answerObligationRequestIds(record)].sort();
			if (requestIds.length === 0) return [];
			return [{
				kind: "operation_review" as const,
				key: toolCallPointerKey(review.toolCall),
				affectedAgentIds: [review.toolCall.agentId],
				requestIds,
				inspectedThrough: [statusOf(record).primaryEvidence.inspectedThrough],
				review,
			}];
		});
	}

	#observeDependencyDeadlocks(): readonly DependencyDeadlockSnapshot[] {
		const ordinaryAgents = [...this.#agents.values()].filter(
			(record) => !this.#isModerator(record),
		);
		const eligibleAgentIds = ordinaryAgents.flatMap((record) =>
			this.#isDeadlockEligible(record) ? [record.identity.agentId] : []
		);
		// Answer Delivery may still be outstanding for Wait, but a committed
		// Answer no longer depends on progress from its responder.
		const requests = ordinaryAgents.flatMap(record =>
			this.#messages.unansweredRequestRelationships(
				record.identity.agentId,
				this.#messages.outstandingRequestIdsFor(record),
			)
		);
		return detectDependencyDeadlocks({
			eligibleAgentIds,
			requests,
		}).map((component) => ({
			kind: "dependency_deadlock",
			key: JSON.stringify([
				"dependency_deadlock",
				...component.agentIds,
				"requests",
				...component.requestIds,
			]),
			affectedAgentIds: component.agentIds,
			requestIds: component.requestIds,
			inspectedThrough: component.agentIds.map(
				(agentId) => statusOf(this.#agents.get(agentId)!).primaryEvidence.inspectedThrough,
			),
		}));
	}

	#isDeadlockEligible(record: AgentRecord): boolean {
		const run = record.host.observe();
		return run.phase === "live" &&
			run.work === "settled" &&
			(run.attention === "none" || run.attention === "agent_wait") &&
			!record.host.currentRunFailed() &&
			!this.#operationReviews.hasUnresolvedAsynchronousCall(
				record.identity.agentId,
			) &&
			run.retentionReasons.length > 0 &&
			run.retentionReasons.every(
				({ reason }) => reason === "awaiting_answer" || reason === "answer_owed" ||
					(reason === "pending_delivery" && !this.#messages.hasDeliveryProgress(record)),
			);
	}

	#hasExternalProgress(record: AgentRecord, path: Set<string>, includeModerators = false): boolean {
		const agentId = record.identity.agentId;
		if (path.has(agentId)) return false;
		path.add(agentId);
		try {
			const requestIds = this.#messages.outstandingRequestIdsFor(record);
			for (const targetAgentId of this.#messages.requestTargetAgentIds(requestIds)) {
				const target = this.#agents.get(targetAgentId);
				if (!target || (!includeModerators && this.#isModerator(target))) continue;
				const run = target.host.observe();
				if (run.phase === "starting") return true;
				if (
					run.phase === "live" &&
					(
						run.work === "active" ||
						run.attention === "input_required" ||
						this.#messages.hasDeliveryProgress(target) ||
						target.host.hasRetentionReason("interactive_selection")
					)
				) return true;
				if (
					run.phase === "live" &&
					run.work === "settled" &&
					!target.host.hasRetentionReason("interruption_hold") &&
					this.#hasExternalProgress(target, path, includeModerators)
				) return true;
			}
			return false;
		} finally {
			path.delete(agentId);
		}
	}

	#isModerator(record: AgentRecord): boolean {
		return isModeratorIdentity(record.identity);
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}

	#isToolCallUnresolved(toolCall: ToolCallPointer): boolean {
		const record = this.#agents.get(toolCall.agentId);
		if (!record) return false;
		const transcript = record.transcript.inspect();
		const entries = coordinationEntries(transcript, toolCall.agentId, `call:${toolCall.toolCallId}`);
		const sourceExists = entries.some(
			(entry) =>
				entry.id === toolCall.entryId &&
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) => part.type === "toolCall" && part.id === toolCall.toolCallId,
				),
		);
		if (!sourceExists) return false;
		return !coordinationEntries(transcript, toolCall.agentId, `result:${toolCall.toolCallId}`).some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCall.toolCallId,
		);
	}

	#assertWorkflowToolCallPointer(toolCall: ToolCallPointer): void {
		const record = this.#requireAgent(toolCall.agentId);
		const source = coordinationEntries(record.transcript.inspect(), toolCall.agentId, `call:${toolCall.toolCallId}`).find((entry) => entry.id === toolCall.entryId);
		if (
			source?.type !== "message" ||
			source.message.role !== "assistant" ||
			!source.message.content.some(
				(part) => part.type === "toolCall" && part.id === toolCall.toolCallId,
			)
		) {
			throw new Error("unknown_evidence: Moderator renewal tool-call pointer is invalid");
		}
	}

	async #notifyRunFailureRecovery(snapshot: RunFailureSnapshot): Promise<void> {
		const handling = this.#handlingByKey.get(snapshot.key);
		if (!handling?.moderatorAgentId) return;
		const affected = this.#agents.get(snapshot.agentId);
		if (
			!affected ||
			affected.host.latestStartedRunSequence() <= snapshot.run.sequence
		) return;
		const moderator = this.#agents.get(handling.moderatorAgentId);
		if (!moderator) return;
		const recovery: RunFailureRecovery = {
			trigger: {
				kind: "run_failure",
				agentId: snapshot.agentId,
				failedRunSequence: snapshot.run.sequence,
			},
			recovery: {
				kind: "successor_run_started",
				successorRunSequence: affected.host.latestStartedRunSequence(),
			},
			originalObligationsRemain: this.#messages.hasUnsettledAnswerObligation(
				affected,
				snapshot.requestIds,
			),
			requiredAction: "resolve",
			guidance: RUN_FAILURE_RECOVERY_DIRECTIVE,
		};
		const admission = await this.#messages.admitCustomDelivery(moderator, {
			messageId: runFailureRecoveryDeliveryId(recovery),
			deliveryMode: "deferred",
			customMessage: createModelVisibleRunFailureRecovery(recovery),
			inspectProof: () => inspectRunFailureRecovery({
				moderatorAgentId: moderator.identity.agentId,
				transcript: moderator.transcript.inspect(),
				recovery,
			}),
		});
		if (admission !== "pending") {
			throw new Error(`Run Failure Recovery delivery rejected: ${admission}`);
		}
	}

	#scheduleReconciliation(): Promise<void> {
		// Host events often arrive in bursts. Share the pending observation and let
		// input/timers run between scans instead of draining a long microtask queue.
		return this.#pendingReconciliation ??= this.#reconciliationLane
			.run(async () => {
				await setImmediate();
				// Changes after observation starts must schedule a fresh successor pass.
				this.#pendingReconciliation = undefined;
				await this.#reconcileWorkflow();
			})
			.catch((error: unknown) => this.#reportError(error));
	}

	#scheduleReconciliationAfterHostLane(record: AgentRecord): void {
		void record.host.lane
			.run(() => this.#scheduleReconciliation())
			.catch((error: unknown) => this.#reportError(error));
	}

	#releaseHandling(key: string): void {
		const handling = this.#handlingByKey.get(key);
		if (!handling) return;
		this.#handlingByKey.delete(key);
		if (handling.exhausted) {
			this.#presentation.dismiss(key);
			this.#onAttentionChanged();
		}
		if (!handling.moderatorAgentId) return;
		const moderator = this.#agents.get(handling.moderatorAgentId);
		if (!moderator) return;
		moderator.host.removeRetentionReason("moderator_handling");
		// Handling can clear after the Moderator already settled; no later
		// settlement event is guaranteed to request its now-unretained release.
		void this.#messages.requestRelease(moderator)
			.catch((error: unknown) => this.#reportError(error));
	}
}

function hasExactDurableModeratorEvidence(options: {
	sessionPath: string;
	identity: ModeratorIdentity;
	input: ModeratorInput;
}): boolean {
	try {
		validateCommittedModeratorInput({
			transcript: transcriptFromSessionFile(options.sessionPath).inspect(),
			identity: options.identity,
			input: options.input,
		});
		return true;
	} catch (error) {
		if (error instanceof ProtocolInvariantError) throw error;
		return false;
	}
}
