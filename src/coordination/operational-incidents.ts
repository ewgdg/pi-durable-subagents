import type { ReportToUserInput, ReportFindingInput } from "../protocol/moderator-report.ts";
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
	validateColdModeratorInput,
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
	deriveMessageIdentity,
	resolveCommittedToolCall,
	toolCallPointerKey,
	type ToolCallPointer,
} from "../protocol/identities.ts";
import type { ProcessChildSessionFactory } from "../runtime/process-child-session-factory.ts";
import type { AgentRunHandle, AgentRunFailure } from "../runtime/agent-runtime-host.ts";
import { SerialLane } from "../runtime/serial-lane.ts";
import type { WorkflowPolicyStore } from "../policy/workflow-policy.ts";
import { statusOf, withAgentTranscriptObservations, type AgentRecord } from "./agent-record.ts";
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
	// Agents whose own stall *is* this blocked Message: its recipient and its
	// author. An agent further upstream reached them through a delivered Request,
	// so it keeps its own independent Obligation Stall condition.
	stalledAgentIds: readonly string[];
	reason: import("./delivery-progress.ts").DeliveryBlockageReason;
}>;

type OperationalConditionSnapshot =
	| DeliveryStallSnapshot
	| ObligationStallSnapshot
	| RunFailureSnapshot
	| DependencyDeadlockSnapshot
	| OperationReviewConditionSnapshot;

type IncidentReportContext = ConditionSnapshotBase & Readonly<{
	kind: OperationalConditionSnapshot["kind"];
	incidentKey: string;
	coldRecovery?: boolean;
	snapshot?: OperationalConditionSnapshot;
}>;

const MODERATION_TRIGGER_EXPLANATIONS: Readonly<Record<OperationalConditionSnapshot["kind"], string>> = {
	delivery_stall: "Delivery stopped making progress on a Request path supporting an unresolved Answer Obligation.",
	obligation_stall: "An Agent settled after its reminder but still owes an Answer, with no observed source of progress.",
	run_failure: "An Agent Run failed while its Agent still owed an Answer.",
	dependency_deadlock: "Settled Agents depend on unanswered Requests within a closed group, with no observed external source of progress.",
	operation_review: "An unresolved tool call exceeded its operation-review interval while its Agent owed an Answer; this does not establish that the tool failed.",
};

type OperationalIncidentHandling = {
	snapshot: OperationalConditionSnapshot;
	moderatorAgentId?: string;
	committedAttemptCount: number;
	diagnostics: EntryPointer[];
	exhausted: boolean;
	creationFailed: boolean;
	creationStage?: string;
	trigger?: ModeratorTrigger;
	previousAttempt?: EntryPointer;
	pendingFailureFindings?: PendingModeratorFailure[];
};

type PendingModeratorFailure = Readonly<{
	incidentKey: string;
	reportInput: ReportToUserInput;
	diagnostic: EntryPointer;
	finding: ReportFindingInput;
}>;

export type OperationalIncidentAttention = Readonly<{
	summary?: string;
	reportSource?: EntryPointer;
	affectedAgents: readonly Readonly<{
		agentId: string;
		label: string;
	}>[];
	diagnostics: readonly EntryPointer[];
}> & (
	| Readonly<{ trigger: ModeratorTrigger }>
	| Readonly<{ trigger: Readonly<{ kind: "moderation_unavailable" }> }>
);

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
	readonly #publishRuntimeReport: (input: ReportToUserInput, diagnostic: EntryPointer, incidentKey?: string) => void;
	readonly #runtimeReportSourceForIncident: (incidentKey: string) => EntryPointer | undefined;
	readonly #appendRuntimeReportFinding: (diagnostic: EntryPointer, finding: ReportFindingInput) => void;
	readonly #reportSources = new Map<string, EntryPointer>();
	readonly #reportSourcesBySnapshot = new WeakMap<OperationalConditionSnapshot, EntryPointer>();
	readonly #reportedFailures = new Set<string>();
	readonly #reportedRunFailures = new Map<string, RunFailureSnapshot>();
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
		publishRuntimeReport(input: ReportToUserInput, diagnostic: EntryPointer, incidentKey?: string): void;
		runtimeReportSourceForIncident(incidentKey: string): EntryPointer | undefined;
		appendRuntimeReportFinding(diagnostic: EntryPointer, finding: ReportFindingInput): void;
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
		this.#publishRuntimeReport = options.publishRuntimeReport;
		this.#runtimeReportSourceForIncident = options.runtimeReportSourceForIncident;
		this.#appendRuntimeReportFinding = options.appendRuntimeReportFinding;
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
			if (settlement !== "settled") return;
			this.#scheduleReconciliationAfterHostLane(record);
		});
		record.host.addEndedHandler((handle, cause, failure) => this.#containEvidenceInspection(() => {
			this.#operationReviews.endRun(record.identity.agentId);
			if (this.#isModerator(record)) {
				if (cause === "failure" && !this.#isShuttingDown()) {
					const original = this.#attemptByModeratorAgentId.get(record.identity.agentId);
					this.#recordModeratorFailure(original ? this.#reportContext(original) : this.#coldModeratorReportContext(record), record, handle, failure);
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
				const snapshot: RunFailureSnapshot = {
					kind: "run_failure",
					key: JSON.stringify(["run_failure", record.identity.agentId, handle.sequence]),
					agentId: record.identity.agentId,
					affectedAgentIds: [record.identity.agentId],
					run: handle,
					requestIds,
					inspectedThrough: [statusOf(record).primaryEvidence.inspectedThrough],
				};
				this.#recordRunFailure(snapshot, record, failure);
				// Reporting every terminal failure does not widen moderation eligibility.
				if (requestIds.length > 0) this.#runFailureByKey.set(snapshot.key, snapshot);
			}
			this.#scheduleReconciliation();
		}));
		record.host.addStateChangeHandler(() => {
			this.#containEvidenceInspection(() => this.#operationReviews.reconcileAgent(record.identity.agentId));
			this.#scheduleReconciliation();
		});
	}

	#failureText(failure?: AgentRunFailure): string {
		return failure ? `Failed stage: ${failure.stage}\nObserved error: ${failure.error}\nProvenance: ${failure.provenance}`
			: "Failed stage/error unavailable: the Runtime Host observed terminal failure without error details. Cause is unconfirmed.";
	}

	#reportContext(snapshot: OperationalConditionSnapshot): IncidentReportContext {
		return { ...snapshot, snapshot, incidentKey: incidentReportKey({ trigger: this.#triggerFor(snapshot), inspectedThrough: snapshot.inspectedThrough }) };
	}

	#coldModeratorReportContext(record: AgentRecord): IncidentReportContext {
		const transcript = record.transcript.inspect();
		const { input } = validateColdModeratorInput({ sessionId: record.identity.agentId, entries: transcript.entries });
		const trigger = input.trigger;
		const incidentKey = incidentReportKey(input);
		const affectedAgentIds = trigger.kind === "operation_review" ? [trigger.toolCall.agentId]
			: trigger.kind === "dependency_deadlock" || trigger.kind === "delivery_stall" ? trigger.agentIds : [trigger.agentId];
		const sources = trigger.kind === "operation_review" ? []
			: trigger.kind === "run_failure" || trigger.kind === "obligation_stall" ? trigger.obligations.sources : trigger.requests.sources;
		// Recover only immutable incident identity. No live handling, attempt budget,
		// timer or automatic replacement is resurrected from a cold Moderator Input.
		const retained = this.#runtimeReportSourceForIncident(incidentKey);
		if (retained) this.#reportSources.set(incidentKey, retained);
		return { kind: trigger.kind, key: incidentKey, incidentKey, affectedAgentIds, requestIds: sources.map(deriveMessageIdentity), inspectedThrough: input.inspectedThrough, coldRecovery: true };
	}

	#recordRunFailure(snapshot: RunFailureSnapshot, record: AgentRecord, failure?: AgentRunFailure): void {
		if (this.#reportedFailures.has(snapshot.key)) return;
		const facts = `Agent: ${record.identity.metadata.label} (${snapshot.agentId})\nRun ${snapshot.run.sequence}\n${this.#failureText(failure)}`;
		const outgoingRequests = this.#messages.outstandingRequestIdsFor(record);
		const affectedRequests = [...new Set([...snapshot.requestIds, ...outgoingRequests])].sort();
		const diagnostic = this.#retainDiagnostic(new Error(facts));
		this.#publishRuntimeReport({
			symptom: `Unexpected terminal Run failure.\n${facts}`,
			suspectedDefect: this.#failureText(failure),
			uncertainty: "The terminal failure is observed; its underlying cause and eventual recovery are not established.",
			recoveryActions: snapshot.requestIds.length ? "Runtime will inspect existing Answer obligations for bounded moderation. No recovery has yet been confirmed." : "No Answer obligations were observed. Automatic moderation is not eligible; a later Message or human input may start a successor Run.",
			recoveryOutcome: "Run ended unexpectedly. Recovery outcome unknown at publication. Reading this report changes notification state only.",
			evidence: [`Runtime diagnostic: ${JSON.stringify(diagnostic)}`, `Affected Requests: ${JSON.stringify(affectedRequests)}`, `Answer obligations: ${JSON.stringify(snapshot.requestIds)}`, `Awaiting Answers: ${JSON.stringify(outgoingRequests)}`, ...snapshot.inspectedThrough.map(pointer => `Inspected through: ${JSON.stringify(pointer)}`)],
		}, diagnostic, this.#reportContext(snapshot).incidentKey);
		this.#reportSources.set(snapshot.key, diagnostic);
		this.#reportSourcesBySnapshot.set(snapshot, diagnostic);
		this.#reportedFailures.add(snapshot.key);
		this.#reportedRunFailures.set(snapshot.key, snapshot);
		this.#onAttentionChanged();
	}

	#recordModeratorFailure(snapshot: IncidentReportContext, moderator: AgentRecord, handle?: AgentRunHandle, failure?: AgentRunFailure): void {
		const key = `moderator-failure:${moderator.identity.agentId}:${handle?.sequence ?? "startup-not-admitted"}`;
		if (this.#reportedFailures.has(key)) return;
		const handling = this.#handlingByKey.get(snapshot.key);
		const evidence = statusOf(moderator).primaryEvidence;
		const facts = `Moderator ${moderator.identity.metadata.label} (${moderator.identity.agentId}), ${handle ? `Run ${handle.sequence}` : "startup attempt; no Run admitted"}.\n${this.#failureText(failure)}`;
		const diagnostic = this.#retainDiagnostic(new Error(facts));
		const reportInput: ReportToUserInput = {
			symptom: `Moderator handling failed for original incident: ${snapshot.kind}.\nAffected Agents: ${snapshot.affectedAgentIds.join(", ")}`,
			suspectedDefect: facts,
			uncertainty: `The original incident remains distinct from failed Moderator attempts. Root cause and recovery are not established.${snapshot.coldRecovery ? " Incident identity comes from cold committed Moderator Input; its qualifying Requests may be a bounded subset and live handling was not reconstructed." : ""}`,
			recoveryActions: "Runtime retains each failed Moderator attempt under this incident and applies the existing bounded attempt policy.",
			recoveryOutcome: "Recovery unknown at publication; later observations are linked findings, not changes to this report.",
			evidence: [`Runtime diagnostic: ${JSON.stringify(diagnostic)}`, `Affected Requests: ${JSON.stringify(snapshot.requestIds)}`, ...snapshot.inspectedThrough.map(pointer => `Original incident evidence: ${JSON.stringify(pointer)}`)],
		};
		// Run sequences restart with a cold Host; the retained diagnostic distinguishes
		// those observations while the in-memory key deduplicates repeated callbacks.
		const finding: ReportFindingInput = { key: `${key}:${diagnostic.entryId}`, summary: `${facts}${snapshot.coldRecovery ? "\nCold-recovered Moderator: original incident linked from committed Input only. Live recovery state and outcome are unknown; no automatic replacement was scheduled." : ""}`, evidence: [`Runtime diagnostic: ${JSON.stringify(diagnostic)}`, `Moderator transcript: ${evidence.transcriptPath ?? "unavailable"}`, `Inspected through: ${JSON.stringify(evidence.inspectedThrough)}`, `Affected Requests: ${JSON.stringify(snapshot.requestIds)}`] };
		// One continuous incident keeps one acknowledgeable Report. While a replacement
		// attempt is still available and the condition persists, retain the observation:
		// the attempt that actually ends moderation (its successor committing, exhaustion,
		// or the moderation-unavailable Report) supplies the incident's report identity.
		// Publishing here would claim that identity ahead of the ending observation.
		if (
			handling !== undefined &&
			snapshot.snapshot === handling.snapshot &&
			handling.committedAttemptCount < MAX_AUTOMATIC_MODERATOR_ATTEMPTS &&
			this.#conditionRemains(handling.snapshot)
		) {
			(handling.pendingFailureFindings ??= []).push({ incidentKey: snapshot.incidentKey, reportInput, diagnostic, finding });
			this.#onAttentionChanged();
			this.#reportedFailures.add(key);
			return;
		}
		if (handling !== undefined && snapshot.snapshot === handling.snapshot) this.#flushModeratorFailureFindings(handling);
		let source = snapshot.snapshot ? this.#reportSourcesBySnapshot.get(snapshot.snapshot) : this.#reportSources.get(snapshot.key);
		if (!source) {
			this.#publishRuntimeReport(reportInput, diagnostic, snapshot.incidentKey);
			source = diagnostic;
			if (snapshot.snapshot) this.#reportSourcesBySnapshot.set(snapshot.snapshot, diagnostic);
			if (!snapshot.snapshot || this.#handlingByKey.get(snapshot.key)?.snapshot === snapshot.snapshot) this.#reportSources.set(snapshot.key, diagnostic);
		}
		this.#appendRuntimeReportFinding(source, finding);
		this.#onAttentionChanged();
		this.#reportedFailures.add(key);
	}

	/**
	 * Publish retained failed-attempt observations once the incident has a Report.
	 * The first retained observation supplies that Report when nothing else has.
	 */
	#flushModeratorFailureFindings(handling: OperationalIncidentHandling): void {
		const pending = handling.pendingFailureFindings;
		if (!pending?.length) return;
		handling.pendingFailureFindings = [];
		let source = this.#reportSources.get(handling.snapshot.key);
		for (const item of pending) {
			if (!source) {
				this.#publishRuntimeReport(item.reportInput, item.diagnostic, item.incidentKey);
				source = item.diagnostic;
				this.#reportSourcesBySnapshot.set(handling.snapshot, item.diagnostic);
				this.#reportSources.set(handling.snapshot.key, item.diagnostic);
			}
			this.#appendRuntimeReportFinding(source, item.finding);
		}
		this.#onAttentionChanged();
	}

	#appendFinding(conditionKey: string, finding: ReportFindingInput): void {
		const source = this.#reportSources.get(conditionKey);
		if (!source) return;
		this.#appendRuntimeReportFinding(source, finding);
		this.#onAttentionChanged();
	}

	deliveryProgressChanged(): void {
		void this.#scheduleReconciliation();
	}

	hasAutonomousRecoveryProgress(): boolean {
		return !this.#isShuttingDown() && !this.#inspectionStalled &&
			(this.#pendingReconciliation !== undefined || this.#cancelInspectionDeadline !== undefined);
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
		this.#operationReviews.admit({
			toolCall: source,
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
				new Error(`Moderation ${handling ? "creation" : "evidence inspection"} made no completion within ${intervalMs}ms`), handling, true);
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

	#presentFault(key: string, error: unknown, handling?: OperationalIncidentHandling, pending = false): void {
		if (this.#isShuttingDown() || this.#faultAttention.has(key)) return;
		const knownHandlings = handling ? [handling] : [...this.#handlingByKey.values()];
		const agentIds = [...new Set(knownHandlings.flatMap(item => item.snapshot.affectedAgentIds))];
		const diagnostic = this.#retainDiagnostic(error);
		const attention: OperationalIncidentAttention = {
			trigger: { kind: "moderation_unavailable" },
			summary: handling ? "Moderator creation blocked; inspect diagnostic evidence." : "Moderation evidence inspection blocked; inspect diagnostic evidence.",
			affectedAgents: agentIds.map((agentId) => ({ agentId, label: this.#requireAgent(agentId).identity.metadata.label })),
			diagnostics: [diagnostic],
		};
		// Use captured incident facts only: re-inspecting the failed evidence path
		// here could hide the failure or invent a newer trigger for this report.
		const incident = knownHandlings.length
			? knownHandlings.map(item => [
				`Original incident: ${item.snapshot.kind}`,
				`Why moderation was triggered: ${MODERATION_TRIGGER_EXPLANATIONS[item.snapshot.kind]}`,
				`Affected Agents: ${item.snapshot.affectedAgentIds.map(agentId => `${this.#requireAgent(agentId).identity.metadata.label} (${agentId})`).join(", ")}`,
				`Trigger: ${item.trigger ? JSON.stringify(item.trigger, null, 2) : "Trigger source capture failed; qualifying Request source graph was not established."}`,
			].join("\n")).join("\n\n")
			: "No trigger or affected Request graph was established. Owner hosts this report and diagnostic; no affected Agent is inferred.";
		const attempts = knownHandlings.flatMap(item => {
			const moderatorId = item.moderatorAgentId ?? item.previousAttempt?.agentId;
			const moderator = moderatorId ? this.#agents.get(moderatorId)?.identity : undefined;
			return [
				`Incident: ${item.snapshot.kind}`,
				`Committed Moderator attempts: ${item.committedAttemptCount} of ${MAX_AUTOMATIC_MODERATOR_ATTEMPTS}`,
				`Known Moderator: ${moderatorId ? `${moderator?.metadata.label ?? "Moderator (label unavailable)"} (${moderatorId})` : "none committed"}`,
				`Previous attempt evidence: ${item.previousAttempt ? JSON.stringify(item.previousAttempt) : "none recorded"}`,
			];
		});
		const reportInput = {
			symptom: `${attention.summary}\n${incident}`,
			suspectedDefect: `Failed stage: ${handling?.creationStage ?? "evidence inspection"}\nError: ${error instanceof Error ? error.message : String(error)}`,
			uncertainty: "The underlying cause is unconfirmed. Captured incident facts were not revalidated by this failed observation. It does not establish whether pending work will complete or whether any Agent needs recovery.",
			recoveryActions: [
				"Runtime retained diagnostic evidence and published this report. Reading it only acknowledges the notification; it does not retry moderation or change handling bounds.",
				...(attempts.length ? attempts : ["No Moderator handling was established by this inspection; attempt count and Moderator identity are unknown."]),
			].join("\n"),
			recoveryOutcome: `Moderation unavailable at publication. ${pending ? "The completion deadline elapsed, but the operation is still pending; terminal failure is not established." : handling?.creationFailed ? "Creation failed; automatic staging is not retried for this continuous condition." : "Evidence inspection failed; later inspection may clear the live fault."} No recovery is claimed. Live status is separate and may change after this immutable report.`,
			evidence: [
				`Runtime diagnostic: ${JSON.stringify(diagnostic)}`,
				...knownHandlings.flatMap(item => [
					`Original trigger: ${item.trigger ? JSON.stringify(item.trigger) : "not captured"}`,
					`Qualifying Request identities: ${JSON.stringify(item.snapshot.requestIds)}`,
					...item.snapshot.inspectedThrough.map(pointer => `Inspected through: ${JSON.stringify(pointer)}`),
					...item.diagnostics.map(pointer => `Moderator diagnostic: ${JSON.stringify(pointer)}`),
				]),
			],
		};
		if (handling && this.#reportSources.has(handling.snapshot.key)) {
			this.#appendFinding(handling.snapshot.key, { key: `moderation-unavailable:${diagnostic.entryId}`, summary: `${reportInput.symptom}\n${reportInput.suspectedDefect}\n${reportInput.recoveryOutcome}`, evidence: reportInput.evidence });
		} else {
			this.#publishRuntimeReport(reportInput, diagnostic, handling?.trigger ? incidentReportKey({ trigger: handling.trigger, inspectedThrough: handling.snapshot.inspectedThrough }) : undefined);
			if (handling) {
				this.#reportSources.set(handling.snapshot.key, diagnostic);
				this.#reportSourcesBySnapshot.set(handling.snapshot, diagnostic);
			}
		}
		// A creation fault is the moderation-unavailable Report this incident keeps;
		// retained failed-attempt observations belong under it, not under a second one.
		if (handling) this.#flushModeratorFailureFindings(handling);
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
		const inspections = await this.#messages.refreshTranscriptFacts();
		if (this.#isShuttingDown()) return;
		const toRecover: RunFailureSnapshot[] = [];
		const recoveringKeys = new Set<string>();
		const toAttemptCreation: OperationalIncidentHandling[] = [];
		withAgentTranscriptObservations(this.#agents.values(), () => {
			const snapshots: OperationalConditionSnapshot[] = [];
			for (const [key, snapshot] of this.#reportedRunFailures) {
				const affected = this.#agents.get(snapshot.agentId);
				if (!affected) continue;
				const successor = affected.host.latestStartedRunSequence();
				if (successor <= snapshot.run.sequence) continue;
				const source = this.#reportSourcesBySnapshot.get(snapshot);
				if (!source) throw new Error("Reported Run failure has no retained report source");
				this.#appendRuntimeReportFinding(source, { key: `successor:${successor}`, summary: `Successor Run ${successor} started for Agent ${snapshot.agentId}. This establishes resumption, not successful completion. Original Answer obligations remain: ${this.#messages.hasUnsettledAnswerObligation(affected, snapshot.requestIds)}.`, evidence: [`Inspected through: ${JSON.stringify(statusOf(affected).primaryEvidence.inspectedThrough)}`] });
				this.#onAttentionChanged();
				this.#reportedRunFailures.delete(key);
			}
			for (const [key, snapshot] of this.#runFailureByKey) {
				if (!this.#conditionRemains(snapshot)) {
					toRecover.push(snapshot);
					recoveringKeys.add(key);
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
			// A closed Dependency Deadlock is one normalized condition, so its members are
			// neither reminded nor independently moderated. A Delivery Stall only keeps the
			// simple Obligation Stall reminder away from its affected paths: an upstream
			// obligor still gets its own Stall moderation, while the stalled recipient's
			// Stall *is* that delivery stall. (docs/operational-incident-moderation.md)
			const deadlockNormalizedAgentIds = new Set(
				dependencyDeadlocks.flatMap(({ affectedAgentIds }) => affectedAgentIds),
			);
			const deliveryStallAffectedAgentIds = new Set(
				deliveryStalls.flatMap(({ affectedAgentIds }) => affectedAgentIds),
			);
			const deliveryStallStalledAgentIds = new Set(
				deliveryStalls.flatMap(({ stalledAgentIds }) => stalledAgentIds),
			);
			for (const record of [...this.#agents.values()]) {
				if (
					this.#isModerator(record) ||
					deadlockNormalizedAgentIds.has(record.identity.agentId) ||
					deliveryStallStalledAgentIds.has(record.identity.agentId)
				) continue;
				const snapshot = this.#observeObligationStall(record);
				if (snapshot) snapshots.push(snapshot);
			}
			const currentKeys = new Set(snapshots.map(({ key }) => key));
			for (const key of this.#faultAttention.keys()) {
				if (key.startsWith("moderation:creation:") && !currentKeys.has(key.slice("moderation:creation:".length))) this.#dismissFault(key);
			}
			for (const key of this.#handlingByKey.keys()) {
				if (currentKeys.has(key) || recoveringKeys.has(key)) continue;
				this.#releaseHandling(key);
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
					!deliveryStallAffectedAgentIds.has(snapshot.agentId) &&
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
				toAttemptCreation.push(handling);
			}
		}, inspections);
		for (const snapshot of toRecover) {
			// The cleared condition still owes its Moderator the successor-start notice.
			// Admit that delivery while handling retention is live, then release as usual.
			await this.#notifyRunFailureRecovery(snapshot);
			this.#releaseHandling(snapshot.key);
		}
		for (const handling of toAttemptCreation) {
			await this.#attemptModeratorCreation(handling);
		}
	}

	#attemptModeratorCreation(handling: OperationalIncidentHandling): Promise<void> {
		return this.#withModerationDeadline(async () => {
			const previousCreation = this.#activeCreation;
			this.#activeCreation = handling;
			try {
				handling.creationStage = "incident trigger capture";
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
			isSuppressed: () => this.#isSuspensionBlocked(recipient) || !this.#messages.hasUnsettledAnswerObligation(
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
		handling.creationStage = "Moderator runtime preparation";
		this.#sessionFactory.admitProcessRuntimePlatform();
		const agentId = uuidv7();
		const prepared = await this.#sessionFactory.prepareModeratorRun({ agentId });
		handling.creationStage = "Moderator staging session creation";
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
		handling.creationStage = "Moderator bootstrap commit";
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
		handling.creationStage = "Moderator bootstrap verification";
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
		// A committed successor seals the previous attempt's failure observations:
		// the incident's Report exists now, so retained findings can be linked to it.
		this.#flushModeratorFailureFindings(handling);

		handling.creationStage = "Moderator record integration";
		const moderator = this.#sessionFactory.createModeratorRecord({
			identity,
			initialPreparation: prepared,
			sessionPath,
		});
		this.#agents.set(agentId, moderator);
		this.#integrateAgent(moderator);
		handling.creationStage = "Moderator Run startup";
		if (
			this.#boundaryHooks.beforeModeratorRunStart?.() ===
			"confirmed_failure"
		) {
			await this.#handleModeratorFailure(handling, moderator, { stage: handling.creationStage, error: "Confirmed Moderator Run startup failure", provenance: "Moderator startup boundary" });
			return;
		}
		try {
			// Keep startup and scheduler admission atomic against queued Run termination.
			await moderator.host.lane.run(async () => {
				if (this.#isShuttingDown()) return;
				await moderator.host.startInLane(["moderator_handling"]);
				this.#appendFinding(handling.snapshot.key, { key: `moderator-started:${agentId}`, summary: `Moderator ${agentId} Run ${moderator.host.currentHandle()?.sequence} started as bounded recovery attempt ${handling.committedAttemptCount} of ${MAX_AUTOMATIC_MODERATOR_ATTEMPTS}. Outcome unknown.`, evidence: [`Moderator transcript: ${sessionPath}`] });
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
			await this.#handleModeratorFailure(handling, moderator, { stage: handling.creationStage, error: error instanceof Error ? error.message : String(error), provenance: "Moderator startup rejection" });
		}
	}

	async #handleModeratorFailure(
		handling: OperationalIncidentHandling,
		moderator: AgentRecord,
		failure?: AgentRunFailure,
	): Promise<void> {
		if (this.#isShuttingDown()) return;
		if (handling.moderatorAgentId !== moderator.identity.agentId) return;
		if (moderator.host.observe().suspension) return;
		const sequence = moderator.host.latestStartedRunSequence();
		this.#recordModeratorFailure(this.#reportContext(handling.snapshot), moderator, sequence > 0 ? { sequence } : undefined, failure);
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
			this.#appendFinding(handling.snapshot.key, { key: "moderator-attempts-exhausted", summary: `All ${MAX_AUTOMATIC_MODERATOR_ATTEMPTS} automatic Moderator attempts failed. No further automatic attempt is scheduled for this incident; recovery remains unresolved.`, evidence: handling.diagnostics.map(pointer => JSON.stringify(pointer)) });
			this.#presentation.present(
				handling.snapshot.key,
				this.#attentionFor(handling),
			);
			this.#onAttentionChanged();
		}
	}

	#attentionFor(handling: OperationalIncidentHandling): OperationalIncidentAttention {
		return {
			...(this.#reportSources.has(handling.snapshot.key) ? { reportSource: this.#reportSources.get(handling.snapshot.key)! } : {}),
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
		if (this.#isSuspensionBlocked(record)) return false;
		// Moderator Requests may depend on another Moderator; ordinary incident
		// detection keeps its existing non-Moderator dependency graph.
		return !this.#operationReviews.hasUnresolvedCall(record.identity.agentId) &&
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
					this.#isSuspensionBlocked(recipient) ||
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
				this.#isSuspensionBlocked(recipient) ||
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
			return this.#observeOperationReviews().some(
				(review) => review.key === snapshot.key,
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
			const stalledAgentIds = new Set<string>([delivery.recipientAgentId]);
			for (const candidate of this.#agents.values()) {
				if (
					this.#messages.outstandingRequestIdsFor(candidate).includes(delivery.messageId)
				) stalledAgentIds.add(candidate.identity.agentId);
			}
			snapshots.push({
				kind: "delivery_stall",
				key: JSON.stringify(["delivery_stall", delivery.messageId]),
				affectedAgentIds,
				stalledAgentIds: [...stalledAgentIds].sort(),
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
		return run.suspension !== undefined ||
			(run.phase !== "dormant" && run.attention === "input_required") ||
			record.host.hasRetentionReason("interactive_selection") ||
			record.host.hasRetentionReason("interruption_hold");
	}

	#observeOperationReviews(): readonly OperationReviewConditionSnapshot[] {
		return this.#operationReviews.expiredReviews().flatMap((review) => {
			const record = this.#agents.get(review.toolCall.agentId);
			if (!record || record.host.observe().suspension) return [];
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
		return !run.suspension && run.phase === "live" &&
			run.work === "settled" &&
			(run.attention === "none" || run.attention === "agent_wait") &&
			!record.host.currentRunFailed() &&
			!this.#operationReviews.hasUnresolvedCall(
				record.identity.agentId,
			) &&
			run.retentionReasons.length > 0 &&
			run.retentionReasons.every(
				({ reason }) => reason === "awaiting_answer" || reason === "answer_owed" ||
					(reason === "pending_delivery" && !this.#messages.hasDeliveryProgress(record)),
			);
	}

	#isSuspensionBlocked(record: AgentRecord): boolean {
		const pending = [record];
		const visited = new Set<string>();
		let suspendedPath = false;
		while (pending.length) {
			const current = pending.pop()!;
			const agentId = current.identity.agentId;
			if (visited.has(agentId)) continue;
			visited.add(agentId);
			if (current.host.observe().suspension) {
				suspendedPath = true;
				continue;
			}
			const requests = this.#messages.unansweredRequestRelationships(
				agentId, this.#messages.outstandingRequestIdsFor(current),
			);
			// A different runnable or stalled leaf must not be hidden by one suspended
			// descendant. Cycles may have a suspended exit, but a suspension-free cycle is
			// still a deadlock; delivery/deadlock inspection remains edge-local.
			if (requests.length === 0) return false;
			for (const { targetAgentId } of requests) {
				const target = this.#agents.get(targetAgentId);
				if (!target) return false;
				pending.push(target);
			}
		}
		return suspendedPath;
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
		// Clearance ends the episode: retained failed-attempt observations must reach
		// their Report before the source mapping is dropped.
		this.#flushModeratorFailureFindings(handling);
		this.#appendFinding(key, { key: "condition-cleared", summary: "Original operational condition is no longer eligible for this handling, or Moderator handling was explicitly resolved. This does not establish that all Requests were answered or that underlying failure was repaired.", evidence: [`Original incident: ${handling.snapshot.kind}`, `Affected Requests: ${JSON.stringify(handling.snapshot.requestIds)}`] });
		this.#handlingByKey.delete(key);
		// Request-set keys can recur after activity clears a Stall. Keep the old
		// snapshot's report for its Moderators, not as the next episode's inbox row.
		this.#reportSources.delete(key);
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

function incidentReportKey(input: Pick<ModeratorInput, "trigger" | "inspectedThrough">): string {
	// Validation rebuilds trigger objects; key identity must not depend on their property order.
	const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
		: value !== null && typeof value === "object"
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
	return JSON.stringify(canonical({ trigger: input.trigger, inspectedThrough: input.inspectedThrough }));
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
