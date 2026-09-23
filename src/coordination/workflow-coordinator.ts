import { resumeWorkflow } from "./workflow-resume.ts";
import type { WorkflowResumeReceipt } from "../protocol/workflow-resume.ts";
import { isDeepStrictEqual } from "node:util";
import { ModeratorReportStore } from "./moderator-reports.ts";
import { validateReportToUserInput, type ReportToUserInput, type ReportHistoryItem } from "../protocol/moderator-report.ts";
import { resolveCommittedToolCall } from "../protocol/identities.ts";
import type { ReportToUserReceipt } from "../tools/participant-coordination-tools.ts";
import type { ObligationFrame } from "../protocol/obligation-focus.ts";
import { OPERATIONAL_DIAGNOSTIC_CUSTOM_TYPE } from "../protocol/custom-entry-types.ts";
import { refreshAgentTranscripts } from "./agent-record.ts";
import { indexedState } from "../transcript/retained-transcript.ts";
import type {
	AgentSessionRuntime,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { dirname, resolve } from "node:path";

import {
	EvidenceUnavailableError,
	requireAgentRecord,
	statusOf,
	type AgentRecord,
	type AgentStatus,
} from "./agent-record.ts";
import { resolveAgentTarget, resolveIdentityCandidate } from "./agent-target.ts";
import {
	DefaultChildSpawner,
	type AgentSpawnInput,
	type AgentSpawnReceipt,
	type SpawnBoundaryHooks,
} from "./spawning.ts";
import {
	MessageCoordinator,
	type AgentMessageInput,
	type AgentMessageReceipt,
	type MessageBoundaryHooks,
} from "./messages.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	isRuntimeThinkingLevel,
	type ModelReference,
	type RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";
import { AgentRuntimeSupervisor } from "../runtime/agent-runtime-supervisor.ts";
import type {
	AgentRunHandle,
	ProjectionInputSubmission,
} from "../runtime/agent-runtime-host.ts";
import { transcriptFromSessionManager } from "../pi-integration/session-manager-transcript.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import {
	ProcessChildSessionFactory,
} from "../runtime/process-child-session-factory.ts";
import {
	AgentWaitCoordinator,
	type AgentWaitBoundaryHooks,
	type AgentWaitClock,
	type GuardedAgentWaitToolResult,
} from "./agent-waits.ts";
import type { AgentWaitInput, AgentWaitResult } from "../protocol/agent-wait.ts";
import {
	HumanRequestCoordinator,
	type GuardedHumanToolResult,
	type HumanAttentionItem,
	type HumanRequestBoundaryHooks,
} from "./human-requests.ts";
import type {
	HumanAnswerCandidate,
	HumanRequestInput,
} from "../protocol/human-request.ts";
import { RunSupervisor } from "./run-supervision.ts";
import type {
	RunControlInput,
	RunControlReceipt,
} from "../protocol/run-control.ts";
import { SerialLane } from "../runtime/serial-lane.ts";
import type {
	AgentTemplateCatalogueEntry,
	AgentTemplateCatalogueSnapshot,
	AgentTemplateRoot,
} from "../templates/agent-templates.ts";
import { WorkflowPolicyStore, writeExcludedModels } from "../policy/workflow-policy.ts";
import { parseExcludedModels, type ModelPolicySnapshot } from "../policy/model-exclusion.ts";
import {
	WorkflowExecutionScheduler,
	type AgentExecutionRole,
	type WorkflowExecutionPermit,
} from "./workflow-execution-scheduler.ts";
import type { ColdWorkflowRecovery } from "../bootstrap/cold-host-discovery.ts";
import { piSessionRecency } from "../pi-integration/session-recency.ts";
import {
	OperationalIncidentCoordinator,
	type OperationalIncidentBoundaryHooks,
	type OperationalIncidentAttention,
	type OperationalIncidentPresentation,
} from "./operational-incidents.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import { isModeratorIdentity, type EntryPointer } from "../protocol/moderator-input.ts";
import type { OperationReviewClock } from "./operation-review.ts";
import { participantLifecycleHandlers } from "../bootstrap/agent-extension.ts";
import type {
	AgentActivitySnapshot,
	AgentActivityStatus,
} from "../presentation/agent-activity-surface.ts";
import { participantCoordinatorHandlers } from "../tools/owner-surfaces.ts";
import type {
	AgentSearchInput,
	AgentSearchResult,
} from "../tools/participant-coordination-tools.ts";
import { answerCallTargetAgentId } from "../protocol/request-resolution.ts";
import type { OpenIncomingRequestList, RequestInspection } from "../protocol/request-inspection.ts";
import { createOwnerAgentPresentationHandlers } from "../process-runtime/remote-agent-selector.ts";
import type {
	DurableAgentView,
	PhysicalAgentViewSurface,
} from "../presentation/agent-view-surface.ts";
import type {
	PostMortemAgentPresenter,
	PostMortemAgentView,
} from "../presentation/post-mortem-agent-view-surface.ts";
import type { TerminalProjection } from "../presentation/terminal-projection.ts";
import { DurableAgentViewAttachment } from "./durable-agent-view.ts";

export type { AgentStatus } from "./agent-record.ts";
export type AgentRosterStatus = AgentStatus & Readonly<{
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	compacting: boolean;
	queuedInputCount: number;
}>;

const DEFAULT_AGENT_SEARCH_LIMIT = 20;
const MAX_AGENT_SEARCH_LIMIT = 50;
export type {
	AgentSpawnInput,
	AgentSpawnReceipt,
	SpawnBoundaryHooks,
} from "./spawning.ts";
export type {
	AgentMessageInput,
	AgentMessageReceipt,
	MessageBoundaryHooks,
} from "./messages.ts";

export type HumanInputDisposition = "continue" | "submitted" | "discarded";

type GuardedCoordinationToolResult =
	| GuardedHumanToolResult
	| GuardedAgentWaitToolResult;

export type HumanPresentationCoordinatorView = Readonly<{
	status(agentId?: string): AgentStatus;
	agentLabel(agentId: string): string | undefined;
	agentActivity(): AgentActivitySnapshot;
	addAgentActivityChangeHandler(handler: () => void): () => void;
	refreshAgentActivity(): void;
	/** Owner-authored deny list of models child Runtime preparation must refuse. */
	modelPolicy(): ModelPolicySnapshot;
	setModelExclusions(entries: readonly string[]): Promise<ModelPolicySnapshot>;
	refreshTranscriptFacts(): Promise<void>;
	resumeFromHuman(
		text: string,
		images: readonly ImageContent[] | undefined,
		submissionSequence?: number,
	): Promise<HumanInputDisposition>;
	primaryInputQueued(): Promise<void>;
	selectionRoster(): Readonly<{
		live: readonly AgentRosterStatus[];
		dormant: readonly AgentRosterStatus[];
		quarantined: readonly string[];
		quarantinedCandidateCount: number;
	}>;
	openAgentView(agentId: string): Promise<DurableAgentView | undefined>;
	openAgentPresentation(agentId: string): Promise<AgentPresentationSelection>;
	bindPhysicalAgentSurface(surface: PhysicalAgentViewSurface): () => void;
	focusHumanAnswer(agentId: string, requestId: string): Promise<void>;
	humanAttention(): readonly HumanAttentionItem[];
	hasPendingHumanQuestions(): boolean;
	operationalAttention(): readonly OperationalIncidentAttention[];
	reportHistory(): readonly ReportHistoryItem[];
	setReportRead(reportId: string, read: boolean): void;
}>;

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

type AgentCoordinatorView = HumanPresentationCoordinatorView & Readonly<{
	humanInputMode(): "agent" | "answer" | "run_suspended";
	answerTargetAgent(toolCallId: string): string | undefined;
	children(agentId?: string): readonly AgentStatus[];
	search(input: AgentSearchInput): AgentSearchResult;
	openIncomingRequests(): OpenIncomingRequestList;
	inspectRequest(requestId: string): RequestInspection;
	message(toolCallId: string, input: AgentMessageInput): Promise<AgentMessageReceipt>;
	wait(
		toolCallId: string,
		input: AgentWaitInput,
		signal: AbortSignal | undefined,
		onProgress?: Parameters<AgentWaitCoordinator["wait"]>[4],
	): Promise<AgentWaitResult>;
	control(toolCallId: string, input: RunControlInput): Promise<RunControlReceipt>;
	askHuman(
		toolCallId: string,
		input: HumanRequestInput,
		signal: AbortSignal | undefined,
	): Promise<HumanAnswerCandidate>;
	guardToolResult(
		message: MessageEndEvent["message"],
	): GuardedCoordinationToolResult | undefined;
	reconcileHumanToolResults(): void;
	reachSafeBoundary(): Promise<void>;
	beginExecution(submissionSequence?: number): Promise<void>;
	obligationFrames(): readonly ObligationFrame[];
	ensureExecution(): Promise<void>;
	beginToolExecution(toolCallId: string, toolName: string): void;
	reconcileCommittedToolResults(): void;
	endExecution(): void;
}>;

export type OrdinaryAgentCoordinatorView = AgentCoordinatorView & Readonly<{
	resumeWorkflow(toolCallId: string): Promise<WorkflowResumeReceipt>;
	spawn(toolCallId: string, input: AgentSpawnInput): Promise<AgentSpawnReceipt>;
	agentTemplateSnapshot(): AgentTemplateCatalogueSnapshot;
	refreshAgentTemplateSnapshot(): Promise<AgentTemplateCatalogueSnapshot>;
}>;

export type ModeratorAgentCoordinatorView = AgentCoordinatorView & Readonly<{
	reportToUser(toolCallId: string, input: ReportToUserInput): Promise<ReportToUserReceipt>;
	moderatorControl(
		toolCallId: string,
		input: ModeratorControlInput,
	): Promise<ModeratorControlReceipt>;
}>;

export class WorkflowCoordinator {
	readonly #ownerIdentity: OwnerIdentity;
	readonly #ownerRuntime: AgentSessionRuntime;
	readonly #ownerDiagnostics: AgentSessionRuntime["services"]["diagnostics"];
	readonly #agents = new Map<string, AgentRecord>();
	readonly #spawner: DefaultChildSpawner;
	readonly #sessionFactory: ProcessChildSessionFactory;
	readonly #messages: MessageCoordinator;
	readonly #agentWaits: AgentWaitCoordinator;
	readonly #humanRequests: HumanRequestCoordinator;
	readonly #reports: ModeratorReportStore;
	readonly #runSupervisor: RunSupervisor;
	readonly #operationalIncidents: OperationalIncidentCoordinator;
	readonly #agentActivityChangeHandlers = new Set<() => void>();
	readonly #presentationWork = {
		activityRefreshPasses: 0,
		activitySourcesScheduled: 0,
		authorityOrderBuilds: 0,
	};
	#cachedAuthorityOrder: readonly AgentRecord[] | undefined;
	readonly #agentViewLane = new SerialLane();
	readonly #postMortemAgentPresenter: PostMortemAgentPresenter | undefined;
	#activeAgentView: ActiveDurableAgentView | undefined;
	readonly #workflowPolicy: WorkflowPolicyStore;
	readonly #executionScheduler: WorkflowExecutionScheduler;
	readonly #waitingForExecution = new Set<string>();
	readonly #executionPermits = new Map<
		string,
		Readonly<{ handle: AgentRunHandle; permit: WorkflowExecutionPermit }>
	>();
	readonly #quarantinedAgentIds: ReadonlySet<string>;
	readonly #quarantinedWorkflowAgentIds: ReadonlySet<string>;
	readonly #quarantinedCandidateCount: number;
	readonly #agentIdBySpawnSource: Map<string, string>;
	#shutdownPromise: Promise<void> | undefined;
	readonly #shutdownController = new AbortController();
	#shuttingDown = false;
	readonly #pendingSpawns = new Set<Promise<unknown>>();

	constructor(
		runtime: AgentSessionRuntime,
		identity: OwnerIdentity,
		options: {
			entryModulePath: string;
			packageRoot?: string;
			templateRoots?(
				parentCwd: string,
				projectTrusted: boolean,
			): readonly AgentTemplateRoot[];
			spawnBoundaryHooks?: SpawnBoundaryHooks;
			messageBoundaryHooks?: MessageBoundaryHooks;
			incidentBoundaryHooks?: OperationalIncidentBoundaryHooks;
			operationalIncidentPresentation?: OperationalIncidentPresentation;
			postMortemAgentPresenter?: PostMortemAgentPresenter;
			operationReviewClock?: OperationReviewClock;
			deliveryProgressClock?: OperationReviewClock;
			workflowPolicy?: WorkflowPolicyStore;
			recoveredWorkflow?: ColdWorkflowRecovery;
			humanRequestBoundaryHooks?: HumanRequestBoundaryHooks;
			agentWaitBoundaryHooks?: AgentWaitBoundaryHooks;
			agentWaitClock?: AgentWaitClock;
		},
	) {
		this.#ownerDiagnostics = runtime.services.diagnostics;
		this.#ownerRuntime = runtime;
		this.#postMortemAgentPresenter = options.postMortemAgentPresenter;
		this.#quarantinedAgentIds = options.recoveredWorkflow?.quarantinedAgentIds ?? new Set();
		this.#quarantinedWorkflowAgentIds =
			options.recoveredWorkflow?.quarantinedWorkflowAgentIds ?? new Set();
		this.#quarantinedCandidateCount = options.recoveredWorkflow?.quarantinedCandidateCount ?? 0;
		this.#agentIdBySpawnSource = new Map(
			options.recoveredWorkflow?.agentIdBySpawnSource ?? [],
		);
		this.#workflowPolicy = options.workflowPolicy ?? new WorkflowPolicyStore();
		this.#executionScheduler = new WorkflowExecutionScheduler(this.#workflowPolicy);
		this.#ownerIdentity = identity;
		this.#agents.set(identity.agentId, {
			identity,
			host: AgentRuntimeSupervisor.bindOwner(runtime),
			transcript: transcriptFromSessionManager(runtime.session.sessionManager),
			children: [],
		});
		this.#reports = new ModeratorReportStore({
			transcript: this.#requireAgent(identity.agentId).transcript,
			appendCustomEntry: (customType, data) => runtime.session.sessionManager.appendCustomEntry(customType, data),
		});
		const retainDiagnostic = (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			const entryId = runtime.session.sessionManager.appendCustomEntry(
				OPERATIONAL_DIAGNOSTIC_CUSTOM_TYPE,
				{ message, stack: error instanceof Error ? error.stack : undefined },
			);
			this.#ownerDiagnostics.push({ type: "error", message });
			return { agentId: identity.agentId, entryId };
		};
		const publishRuntimeReport = (input: ReportToUserInput, diagnostic: EntryPointer, incidentKey?: string) => {
			const transcriptPath = runtime.session.sessionManager.getSessionFile();
			if (!transcriptPath) throw new Error("Runtime report requires a durable diagnostic transcript");
			this.#reports.publishRuntime(input, { kind: "runtime_diagnostic", ...diagnostic, transcriptPath, ...(incidentKey === undefined ? {} : { incidentKey }) });
		};
		const sessionFactory = new ProcessChildSessionFactory({
			ownerRuntime: runtime,
			modelExclusions: () => this.#workflowPolicy.current().excludedModels,
			onLaunchBlocked: (error) => {
				const diagnostic = retainDiagnostic(error);
				if (!runtime.session.sessionManager.getSessionFile()) {
					// --no-session has no durable report provenance. Keep its original
					// failure visible without inventing a transcript path or enabling persistence.
					runtime.session.extensionRunner.getUIContext().notify(
						`${error.message}\nThis host has no session file, so a durable report cannot be saved.`, "error",
					);
					return;
				}
				// The Owner may continue after a failed tool call. Publish directly to
				// human attention instead of depending on it to relay launch guidance.
				publishRuntimeReport({
					symptom: "Child and Moderator launches are permanently blocked in this Pi host: the child launch contract check failed.",
					suspectedDefect: error.message,
					uncertainty: "This diagnostic establishes a blocked launch path, not the state or outcome of existing Agent work. A failed probe does not by itself prove a package version mismatch.",
					recoveryActions: "Stop active work and follow the remedy in the reported diagnostic. Retrying launches in this host cannot clear the block.",
					recoveryOutcome: "No recovery was attempted. Existing Runs were not terminated. Reading this report does not unblock launches or restart the host.",
					evidence: [`Runtime diagnostic: ${JSON.stringify(diagnostic)}`],
				}, diagnostic);
				this.#notifyAgentActivityChanged();
			},
			onRuntimeQuit: (agentId, projection) => {
				const selected = this.#activeAgentView;
				if (
					selected?.record.identity.agentId !== agentId ||
					selected.attachment.projection() !== projection
				) return false;
				// Native Owner shutdown follows terminal restoration after child exit.
				// Fence admissions and release Wait now, before dead Control can start
				// moderation or leave the Owner waiting for an Answer that cannot arrive.
				this.#beginShutdown();
				return true;
			},
			ownerIdentity: identity,
			entryModulePath: options.entryModulePath,
			packageRoot: options.packageRoot ?? resolve(dirname(options.entryModulePath), ".."),
			templateRoots: options.templateRoots,
			resolveAgent: (agentId) => this.#agents.get(agentId),
			ownerRequestHandlers: (role, agentId) => {
				if (role === "ordinary") {
					const resolveView = () => this.forAgent(agentId);
					return {
						coordination: participantCoordinatorHandlers("ordinary", resolveView),
						lifecycle: participantLifecycleHandlers(resolveView),
						presentation: createOwnerAgentPresentationHandlers(
							resolveView,
							agentId,
							options.postMortemAgentPresenter,
						),
					};
				}
				const resolveView = () => this.forModerator(agentId);
				return {
					coordination: participantCoordinatorHandlers("moderator", resolveView),
					lifecycle: participantLifecycleHandlers(resolveView),
					presentation: createOwnerAgentPresentationHandlers(
						resolveView,
						agentId,
						options.postMortemAgentPresenter,
					),
				};
			},
		});
		this.#sessionFactory = sessionFactory;
		for (const recovered of options.recoveredWorkflow?.agents ?? []) {
			if (
				options.recoveredWorkflow?.transcriptPathByAgentId.get(
					recovered.identity.agentId,
				) !== recovered.sessionPath
			) {
				throw new Error(
					`invariant_violation: recovered Agent ${recovered.identity.agentId} has inconsistent transcript location`,
				);
			}
			if (recovered.role === "moderator") {
				this.#agents.set(recovered.identity.agentId, sessionFactory.createModeratorRecord({
					identity: recovered.identity,
					sessionPath: recovered.sessionPath,
				}));
				continue;
			}
			const parent = this.#agents.get(recovered.identity.directSpawnerAgentId);
			if (!parent) {
				throw new Error(
					`invariant_violation: recovered Agent ${recovered.identity.agentId} has no verified Direct Spawner`,
				);
			}
			const record = sessionFactory.createAgentRecord({
				identity: recovered.identity,
				spawnInput: recovered.creationInput,
				parent,
				sessionPath: recovered.sessionPath,
			});
			this.#agents.set(recovered.identity.agentId, record);
			parent.children.push(recovered.identity.agentId);
		}
		this.#messages = new MessageCoordinator({
			agents: this.#agents,
			quarantinedAgentIds: this.#quarantinedAgentIds,
			quarantinedWorkflowAgentIds: this.#quarantinedWorkflowAgentIds,
			isShuttingDown: () => this.#shuttingDown,
			boundaryHooks: options.messageBoundaryHooks,
			deliveryProgressClock: options.deliveryProgressClock,
			onDeliveryProgressChanged: () => {
				this.#operationalIncidents?.deliveryProgressChanged();
				this.#notifyAgentActivityChanged();
			},
			isWaitingForCapacity: (agentId) => this.#waitingForExecution.has(agentId),
			preemptAgentWait: (record, reserveDelivery) =>
				this.#agentWaits.preemptForInboundRequest(record, reserveDelivery),
			workflowPolicy: this.#workflowPolicy,
		});
		this.#agentWaits = new AgentWaitCoordinator({
			agents: this.#agents,
			messages: this.#messages,
			boundaryHooks: options.agentWaitBoundaryHooks,
			clock: options.agentWaitClock,
			suspendExecution: (record) => {
				this.#releaseExecution(record.identity.agentId);
			},
			resumeExecution: (record) =>
				this.#ensureExecution(record.identity.agentId),
		});
		this.#humanRequests = new HumanRequestCoordinator({
			agents: this.#agents,
			ownerIdentity: identity,
			boundaryHooks: options.humanRequestBoundaryHooks,
			interruptRun: (record) => {
				record.host.prepareInterruption();
				void record.host.lane.run(async () => {
					this.#messages.prepareInterruptionInLane(record);
					await record.host.interruptCurrentRunInLane();
				});
			},
			suspendExecution: (record) => {
				this.#releaseExecution(record.identity.agentId);
			},
			beginHumanWaiting: (source) => {
				this.#operationalIncidents.beginHumanWaiting(source);
			},
			beginHumanResultCommit: (source) => {
				this.#operationalIncidents.beginHumanResultCommit(source);
			},
			onAttentionChanged: () => this.#notifyAgentActivityChanged(),
		});
		this.#runSupervisor = new RunSupervisor({
			agents: this.#agents,
			quarantinedAgentIds: this.#quarantinedAgentIds,
			ownerAgentId: identity.agentId,
			messages: this.#messages,
		});
		this.#operationalIncidents = new OperationalIncidentCoordinator({
			agents: this.#agents,
			ownerIdentity: identity,
			sessionFactory,
			messages: this.#messages,
			workflowPolicy: this.#workflowPolicy,
			integrateAgent: (record) => this.#integrateAgent(record),
			isShuttingDown: () => this.#shuttingDown,
			reportError: (error) => {
				this.#ownerDiagnostics.push({
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			},
			publishRuntimeReport,
			runtimeReportSourceForIncident: (incidentKey) => this.#reports.runtimeSourceForIncident(incidentKey),
			appendRuntimeReportFinding: (diagnostic, finding) => this.#reports.appendRuntimeFinding(diagnostic, finding),
			retainDiagnostic,
			boundaryHooks: options.incidentBoundaryHooks,
			presentation: options.operationalIncidentPresentation,
			operationReviewClock: options.operationReviewClock,
			deliveryProgressClock: options.deliveryProgressClock,
			onAttentionChanged: () => this.#notifyAgentActivityChanged(),
		});
		for (const record of this.#agents.values()) this.#integrateAgent(record);
		this.#spawner = new DefaultChildSpawner({
			agents: this.#agents,
			agentIdBySpawnSource: this.#agentIdBySpawnSource,
			sessionFactory,
			messages: this.#messages,
			integrateAgent: (record) => this.#integrateAgent(record),
			boundaryHooks: options.spawnBoundaryHooks,
			isShuttingDown: () => this.#shuttingDown,
		});
	}

	async initialize(): Promise<void> {
		await this.refreshAgentTemplateSnapshot(this.#ownerIdentity.agentId);
		await this.#messages.refreshTranscriptFacts();
		await this.#requireAgent(this.#ownerIdentity.agentId).host.initializeCurrentRunRelationships();
	}

	/** Work counters for profiling; source counts describe scheduled observations, not successful reads. */
	presentationDiagnostics(): Readonly<{
		activityRefreshPasses: number;
		activitySourcesScheduled: number;
		authorityOrderBuilds: number;
	}> {
		return { ...this.#presentationWork };
	}

	modelPolicy(): ModelPolicySnapshot {
		return {
			availableModels: this.#ownerRuntime.services.modelRuntime.getAvailableSnapshot().map(
				(model) => ({ provider: model.provider, modelId: model.id, name: model.name }),
			),
			excludedModels: [...this.#workflowPolicy.current().excludedModels],
		};
	}

	/**
	 * Persists user policy before publishing it, then refreshes every cached
	 * Template snapshot so later guidance matches the new list. A snapshot that
	 * cannot be refreshed keeps its previous value and reports a diagnostic.
	 */
	async setModelExclusions(entries: readonly string[]): Promise<ModelPolicySnapshot> {
		const validated = parseExcludedModels(entries);
		await writeExcludedModels(this.#ownerRuntime.services.agentDir, validated);
		this.#workflowPolicy.publish(Object.freeze({
			...this.#workflowPolicy.current(),
			excludedModels: validated,
		}));
		this.#sessionFactory.invalidateTemplateLoads();
		for (const record of this.#agents.values()) {
			try {
				await this.#sessionFactory.captureTemplateSnapshotFor(record);
			} catch (error) {
				this.#ownerDiagnostics.push({
					type: "error",
					message: `Agent ${record.identity.agentId} kept its previous Agent Template snapshot after a model policy change: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		return this.modelPolicy();
	}

	async refreshAgentTemplateSnapshot(agentId: string): Promise<AgentTemplateCatalogueSnapshot> {
		return this.#sessionFactory.captureTemplateSnapshotFor(this.#requireAgent(agentId));
	}

	forAgent(agentId: string): OrdinaryAgentCoordinatorView {
		this.#requireAgent(agentId);
		return Object.freeze({
			...this.#agentView(agentId),
			resumeWorkflow: (toolCallId) => this.#resumeWorkflow(agentId, toolCallId),
			spawn: (toolCallId, input) => {
				this.#assertAdmissionOpen();
				const spawning = this.#spawner.spawn(agentId, toolCallId, input);
				this.#pendingSpawns.add(spawning);
				void spawning.finally(() => this.#pendingSpawns.delete(spawning)).catch(() => undefined);
				return spawning;
			},
			agentTemplateSnapshot: () => this.#sessionFactory.agentTemplateSnapshotFor(
				this.#requireAgent(agentId),
			),
			refreshAgentTemplateSnapshot: () => this.refreshAgentTemplateSnapshot(agentId),
		});
	}

	async #resumeWorkflow(agentId: string, toolCallId: string): Promise<WorkflowResumeReceipt> {
		if (agentId !== this.#ownerIdentity.agentId) throw new Error("wrong_participant: workflow_resume is Owner only");
		this.#assertAdmissionOpen();
		const committed = resolveCommittedToolCall({
			agentId, transcript: this.#requireAgent(agentId).transcript.inspect(), toolCallId, toolName: "workflow_resume",
		});
		if (!isDeepStrictEqual(committed.input, {})) throw new Error("invalid_input: workflow_resume accepts only {}");
		return resumeWorkflow({
			workflowId: this.#ownerIdentity.workflowId,
			ownerAgentId: agentId,
			agents: this.#agents,
			quarantinedAgentIds: this.#quarantinedWorkflowAgentIds,
			messages: this.#messages,
			activate: async (record, requestIds, recovery) => {
				this.#assertAdmissionOpen();
				const outcome = await this.#runSupervisor.continueDormantResponder(record, {
					requestMessageIds: requestIds,
					recovery,
					recheckRequestMessageIds: () => {
						this.#assertAdmissionOpen();
						return this.#messages.recoveryRequestIds(record);
					},
				});
				return {
					agentId: record.identity.agentId,
					requestIds,
					disposition: outcome === "activated" ? "admitted"
						: outcome === "already_running" || outcome === "resolved" ? "skipped" : "blocked",
					...(outcome === "activated" ? {} : { reason: outcome }),
				};
			},
		});
	}

	forModerator(agentId: string): ModeratorAgentCoordinatorView {
		this.#requireModerator(agentId);
		return Object.freeze({
			...this.#agentView(agentId),
			reportToUser: async (toolCallId, input) => {
				this.#assertAdmissionOpen();
				const record = this.#requireModerator(agentId);
				const transcript = record.transcript.inspect();
				const committed = resolveCommittedToolCall({ agentId, transcript, toolCallId, toolName: "report_to_user" });
				const validated = validateReportToUserInput(input);
				if (!isDeepStrictEqual(validated, validateReportToUserInput(committed.input))) {
					throw new Error("invariant_violation: Report does not match committed tool call");
				}
				if (!transcript.transcriptPath) throw new Error("Report requires a durable source transcript");
				const report = this.#reports.publish(validated,
					{ agentId, label: record.identity.metadata.label },
					{ ...committed.source, transcriptPath: transcript.transcriptPath });
				this.#notifyAgentActivityChanged();
				return { reportId: report.reportId, createdAt: report.createdAt };
			},
			moderatorControl: (toolCallId, input) => {
				this.#assertAdmissionOpen();
				return this.#operationalIncidents.executeModeratorControl(
					agentId,
					toolCallId,
					input,
				);
			},
		});
	}

	#agentView(agentId: string): AgentCoordinatorView {
		return {
			status: (targetAgentId?: string) => this.#statusFor(agentId, targetAgentId),
			modelPolicy: () => this.modelPolicy(),
			setModelExclusions: (entries) => this.setModelExclusions(entries),
			agentLabel: (targetAgentId) =>
				this.#agents.get(targetAgentId)?.identity.metadata.label,
			answerTargetAgent: (toolCallId) => answerCallTargetAgentId({
				responderAgentId: agentId,
				transcript: this.#requireAgent(agentId).transcript.inspect(),
				toolCallId,
			}),
			agentActivity: () => this.#agentActivity(agentId),
			humanInputMode: () => this.#requireAgent(agentId).host.runSuspensionBlocksExecution()
				? "run_suspended"
				: this.#agentActivity(agentId).answerMode ? "answer" : "agent",
			addAgentActivityChangeHandler: (handler) => {
				this.#agentActivityChangeHandlers.add(handler);
				return () => this.#agentActivityChangeHandlers.delete(handler);
			},
			refreshAgentActivity: () => this.#notifyAgentActivityChanged(agentId),
			refreshTranscriptFacts: () => {
				this.#assertAdmissionOpen();
				return refreshAgentTranscripts(this.#agents.values());
			},
			children: (targetAgentId?: string) => this.#childrenFor(agentId, targetAgentId),
			search: (input) => this.#searchFor(agentId, input),
			openIncomingRequests: () => this.#messages.openIncomingRequests(agentId),
			inspectRequest: (requestId) => this.#messages.inspectRequest(agentId, requestId),
			message: (toolCallId, input) => {
				this.#assertAdmissionOpen();
				return this.#messages.execute(agentId, toolCallId, input);
			},
			wait: (toolCallId, input, signal, onProgress) => {
				this.#assertAdmissionOpen();
				return this.#agentWaits.wait(agentId, toolCallId, input, signal, onProgress);
			},
			control: (toolCallId, input) => {
				this.#assertAdmissionOpen();
				return this.#runSupervisor.execute(agentId, toolCallId, input);
			},
			resumeFromHuman: (text, images, submissionSequence) => {
				this.#assertAdmissionOpen();
				return this.#handleHumanInput(agentId, text, images, submissionSequence);
			},
			primaryInputQueued: () => {
				this.#assertAdmissionOpen();
				if (this.#requireAgent(agentId).host.currentRunSuspension()) return Promise.resolve();
				return this.#agentWaits.preemptForHumanInput(this.#requireAgent(agentId));
			},
			selectionRoster: () => this.#selectionRoster(),
			openAgentPresentation: (targetAgentId) => {
				this.#assertAdmissionOpen();
				return this.#openAgentPresentation(targetAgentId);
			},
			openAgentView: (targetAgentId) => {
				this.#assertAdmissionOpen();
				return this.#openAgentView(targetAgentId);
			},
			bindPhysicalAgentSurface: (surface) =>
				this.#postMortemAgentPresenter?.bindPhysicalSurface(surface) ?? (() => undefined),
			focusHumanAnswer: (targetAgentId, requestId) => {
				this.#assertAdmissionOpen();
				return this.#focusHumanAnswer(targetAgentId, requestId);
			},
			askHuman: (toolCallId, input, signal) => {
				this.#assertAdmissionOpen();
				return this.#humanRequests.ask(agentId, toolCallId, input, signal);
			},
			guardToolResult: (message) =>
				this.#humanRequests.guardResultCommit(agentId, message) ??
				this.#messages.guardResultCommit(agentId, message) ??
				this.#agentWaits.guardResultCommit(agentId, message),
			reconcileHumanToolResults: () =>
				this.#humanRequests.reconcileCommittedResults(agentId),
			// These surfaces belong to the human Workflow Owner even while a child
			// Runtime supplies the selected interactive mode.
			hasPendingHumanQuestions: () => this.#humanRequests.hasPendingQuestions(),
			humanAttention: () =>
				this.#humanRequests.attentionItems(this.#ownerIdentity.agentId),
			reportHistory: () => this.#reports.history(),
			setReportRead: (reportId, read) => {
				this.#assertAdmissionOpen();
				this.#reports.setRead(reportId, read);
				this.#notifyAgentActivityChanged();
			},
			operationalAttention: () =>
				this.#operationalIncidents.attentionItems(this.#ownerIdentity.agentId),
			reachSafeBoundary: async () => {
				this.#operationalIncidents.reconcileCommittedToolResults(agentId);
				this.#agentWaits.reconcileCommittedAnswers();
				await this.#messages.reachSafeBoundary(agentId);
				await this.#operationalIncidents.reachSafeBoundary();
			},
			beginExecution: (submissionSequence) =>
				this.#beginExecution(agentId, submissionSequence),
			ensureExecution: () => this.#ensureExecution(agentId),
			beginToolExecution: (toolCallId, toolName) => {
				this.#assertAdmissionOpen();
				this.#operationalIncidents.admitToolExecution(
					agentId,
					toolCallId,
					toolName,
				);
			},
			reconcileCommittedToolResults: () => {
				this.#operationalIncidents.reconcileCommittedToolResults(agentId);
				this.#agentWaits.reconcileCommittedResults(agentId);
				this.#agentWaits.reconcileCommittedAnswers();
			},
			obligationFrames: () => this.#messages.obligationFrames(agentId),
			endExecution: () => this.#releaseExecution(agentId),
		};
	}

	hasAutonomousWorkflowProgress(): boolean {
		if (this.#shuttingDown) return false;
		// The entire Workflow matters: a waiting parent contributes no execution,
		// but its progressing descendant (or a recovering Moderator) still does.
		for (const record of this.#agents.values()) {
			// Isolated resumption blocks ordinary Delivery, not the resumed execution.
			if (record.identity.agentId === this.#ownerIdentity.agentId ||
				this.#waitingForExecution.has(record.identity.agentId) ||
				record.host.currentInterruptionHold() || record.host.currentRunSuspension()) continue;
			const run = record.host.observe();
			// Moderator startup belongs to the bounded recovery inspection below.
			// A hung startup must stop counting when that inspection times out.
			if ((run.phase === "starting" && !this.#isModerator(record.identity.agentId)) || run.phase === "ending" ||
				(run.phase === "live" && run.work === "active" && run.attention === "none")) return true;
		}
		return this.#messages.hasAutonomousDeliveryProgress() ||
			this.#operationalIncidents.hasAutonomousRecoveryProgress();
	}

	ownerShutdownSignal(): AbortSignal {
		return this.#shutdownController.signal;
	}

	async beginOwnerSettlementParking(
		runSignal: AbortSignal,
	): Promise<(() => Promise<void>) | undefined> {
		const owner = this.#requireAgent(this.#ownerIdentity.agentId);
		const handle = owner.host.currentHandle();
		if (!handle || runSignal.aborted || this.#shuttingDown) return undefined;
		let entered = false;
		await owner.host.lane.run(async () => {
			if (
				runSignal.aborted ||
				this.#shuttingDown ||
				!owner.host.isCurrent(handle) ||
				owner.host.exactRunCancellationSignal(handle) !== runSignal
			) return;
			entered = await this.#messages.beginParkingInLane(owner, handle);
		});
		if (!entered) return undefined;
		let left = false;
		return async () => {
			if (left) return;
			left = true;
			await owner.host.lane.run(() => {
				this.#messages.endParkingInLane(owner, handle);
			});
		};
	}

	shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		this.#beginShutdown();
		this.#shutdownPromise ??= this.#shutdown(disposeNativeRuntime);
		return this.#shutdownPromise;
	}

	#beginShutdown(): void {
		this.#shuttingDown = true;
		this.#shutdownController.abort();
		this.#agentWaits.shutdown();
	}

	#assertAdmissionOpen(): void {
		if (this.#shuttingDown) {
			throw new Error("host_shutting_down: Workflow is shutting down");
		}
	}

	#statusFor(callerAgentId: string, targetAgentId = callerAgentId): AgentStatus {
		const selector = targetAgentId.trim();
		if (!selector) throw new Error("invalid_input: Agent selector must not be blank");
		if (this.#agents.has(selector) || this.#quarantinedAgentIds.has(selector)) {
			return statusOf(this.#requireObservable(callerAgentId, selector));
		}
		const candidates = [...this.#agents.values()].map(({ identity }) => ({
			agentId: identity.agentId,
			label: identity.metadata.label,
		}));
		// Only this Workflow's quarantined IDs affect selector ambiguity;
		// known foreign candidates must not block otherwise valid lookups.
		const identity = resolveIdentityCandidate([
			...candidates,
			...[...this.#quarantinedWorkflowAgentIds]
				.filter((agentId) => !this.#agents.has(agentId))
				.map((agentId) => ({ agentId, label: "" })),
		], selector);
		if (identity) return statusOf(this.#requireObservable(callerAgentId, identity.agentId));
		if (this.#quarantinedWorkflowAgentIds.size > 0) {
			throw new EvidenceUnavailableError(
				`Agent status target ${selector} depends on quarantined Agent proof`,
			);
		}
		const labels = this.#searchCandidates(callerAgentId, "authorized").map(({ identity }) => ({
			agentId: identity.agentId,
			label: identity.metadata.label,
		}));
		const target = resolveAgentTarget([], labels, selector);
		return statusOf(this.#requireObservable(callerAgentId, target.agentId));
	}

	#searchFor(callerAgentId: string, input: AgentSearchInput): AgentSearchResult {
		const query = input.query?.trim().toLowerCase();
		if (input.query !== undefined && !query) {
			throw new Error("invalid_input: Agent search query must not be empty");
		}
		const agentIdSuffix = input.agentIdSuffix?.trim();
		if (input.agentIdSuffix !== undefined && !agentIdSuffix) {
			throw new Error("invalid_input: Agent ID suffix must not be empty");
		}
		const hasFilter = query !== undefined ||
			agentIdSuffix !== undefined ||
			input.phase !== undefined;
		if (input.scope === "authorized" && !hasFilter) {
			throw new Error(
				"invalid_input: Authorized Agent search requires a query, ID suffix, or phase",
			);
		}
		const limit = input.limit ?? DEFAULT_AGENT_SEARCH_LIMIT;
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AGENT_SEARCH_LIMIT) {
			throw new Error(
				`invalid_input: Agent search limit must be between 1 and ${MAX_AGENT_SEARCH_LIMIT}`,
			);
		}

		const authorityOrder = this.#agentAuthorityOrder();
		const authorityIndex = new Map(
			authorityOrder.map((record, index) => [record.identity.agentId, index]),
		);
		const candidates = this.#searchCandidates(callerAgentId, input.scope);
		const matching = candidates
			.filter((record) => {
				const metadata = record.identity.metadata;
				const normalizedLabel = metadata.label.toLowerCase();
				const normalizedDescription = metadata.description?.toLowerCase();
				if (
					query !== undefined &&
					!normalizedLabel.includes(query) &&
					!normalizedDescription?.includes(query)
				) return false;
				if (
					agentIdSuffix !== undefined &&
					!record.identity.agentId.endsWith(agentIdSuffix)
				) return false;
				if (
					input.phase !== undefined &&
					record.host.observe().phase !== input.phase
				) return false;
				return true;
			})
			.map((record) => ({
				record,
				relevance: searchRelevance(record, query),
				order: authorityIndex.get(record.identity.agentId) ?? Number.MAX_SAFE_INTEGER,
			}))
			.sort((left, right) =>
				left.relevance - right.relevance || left.order - right.order
			);
		return {
			matches: matching.slice(0, limit).map(({ record }) => statusOf(record)),
			hasMore: matching.length > limit,
		};
	}

	#searchCandidates(
		callerAgentId: string,
		scope: AgentSearchInput["scope"],
	): readonly AgentRecord[] {
		const caller = this.#requireAgent(callerAgentId);
		if (scope === "authorized") {
			if (
				callerAgentId === this.#ownerIdentity.agentId ||
				this.#isModerator(callerAgentId)
			) return this.#agentAuthorityOrder();
			return [caller, ...caller.children.map((agentId) => this.#requireAgent(agentId))];
		}
		if (scope === "direct_children") {
			return caller.children.map((agentId) => this.#requireAgent(agentId));
		}
		if (
			scope.directSpawnerAgentId !== callerAgentId &&
			callerAgentId !== this.#ownerIdentity.agentId &&
			!this.#isModerator(callerAgentId)
		) return [];
		const parent = this.#agents.get(scope.directSpawnerAgentId);
		return parent
			? parent.children.map((agentId) => this.#requireAgent(agentId))
			: [];
	}

	#childrenFor(callerAgentId: string, targetAgentId = callerAgentId): readonly AgentStatus[] {
		if (
			targetAgentId !== callerAgentId &&
			callerAgentId !== this.#ownerIdentity.agentId &&
			!this.#isModerator(callerAgentId)
		) {
			throw new Error(
				`unauthorized: Agent ${callerAgentId} cannot enumerate children of ${targetAgentId}`,
			);
		}
		const target = this.#requireObservable(callerAgentId, targetAgentId);
		return target.children.map((agentId) => statusOf(this.#requireAgent(agentId)));
	}

	#requireObservable(callerAgentId: string, targetAgentId: string): AgentRecord {
		const caller = this.#requireAgent(callerAgentId);
		const target = this.#requireAgent(targetAgentId);
		if (
			targetAgentId !== callerAgentId &&
			callerAgentId !== this.#ownerIdentity.agentId &&
			!this.#isModerator(callerAgentId) &&
			target.identity.directSpawnerAgentId !== caller.identity.agentId
		) {
			throw new Error(`unauthorized: Agent ${callerAgentId} cannot observe ${targetAgentId}`);
		}
		return target;
	}

	#agentAuthorityOrder(): readonly AgentRecord[] {
		if (this.#cachedAuthorityOrder) return this.#cachedAuthorityOrder;
		this.#presentationWork.authorityOrderBuilds++;
		const authorityOrder: AgentRecord[] = [];
		const included = new Set<AgentRecord>();
		const pending = [this.#ownerIdentity.agentId];
		while (pending.length) {
			const record = this.#requireAgent(pending.pop()!);
			if (included.has(record)) throw new Error("invariant_violation: repeated Agent in authority tree");
			included.add(record);
			authorityOrder.push(record);
			for (let index = record.children.length - 1; index >= 0; index--) pending.push(record.children[index]!);
		}
		for (const record of this.#agents.values()) {
			if (!included.has(record)) authorityOrder.push(record);
		}
		this.#cachedAuthorityOrder = authorityOrder;
		return authorityOrder;
	}

	#selectionRoster(): Readonly<{
		live: readonly AgentRosterStatus[];
		dormant: readonly AgentRosterStatus[];
		quarantined: readonly string[];
		quarantinedCandidateCount: number;
	}> {
		const authorityOrder = this.#agentAuthorityOrder();
		const live: AgentRosterStatus[] = [];
		const dormant: Array<{ status: AgentRosterStatus; recency: number; order: number }> = [];
		for (const [order, record] of authorityOrder.entries()) {
			const transcript = record.transcript.snapshot() ?? record.transcript.inspect();
			const status = this.#rosterStatus(record, transcript);
			if (status.run.phase !== "dormant") {
				live.push(status);
				continue;
			}
			const header = transcript.header;
			if (!header) {
				throw new Error(
					`invariant_violation: Agent ${record.identity.agentId} has no Pi session header`,
				);
			}
			dormant.push({
				status,
				recency: (indexedState(transcript).recency ?? piSessionRecency(header, [])),
				order,
			});
		}
		dormant.sort(
			(left, right) => right.recency - left.recency || left.order - right.order,
		);
		return {
			live,
			dormant: dormant.map(({ status }) => status),
			// One combined notification list; never split by workflow proof.
			quarantined: [...this.#quarantinedAgentIds].sort(),
			quarantinedCandidateCount: this.#quarantinedCandidateCount,
		};
	}

	#rosterStatus(
		record: AgentRecord,
		transcript: TranscriptInspection = record.transcript.snapshot() ?? record.transcript.inspect(),
	): AgentRosterStatus {
		// Share one observation for the evidence pointer, configuration, and recency.
		// File-backed transcripts otherwise reparse the whole history for each field.
		const status = statusOf(record, transcript);
		const runtimeSnapshot = status.run.phase === "starting"
			? undefined
			: record.host.effectiveRuntimeSnapshot();
		const transcriptContext = indexedState(transcript).settings();
		const configured = record.effectiveConfiguration;
		const prepared = record.launchConfiguration;
		const owner = this.#agents.get(this.#ownerIdentity.agentId);
		const ownerSnapshot = owner?.host.effectiveRuntimeSnapshot();
		const model = runtimeSnapshot?.model ?? transcriptContext.model ?? configured?.model ??
			prepared?.model ?? ownerSnapshot?.model ?? owner?.effectiveConfiguration?.model ??
			owner?.launchConfiguration?.model;
		if (!model) {
			throw new Error(`invariant_violation: Agent ${status.agentId} has no resolvable model`);
		}
		const hasRecordedThinking = transcriptContext.hasRecordedThinking;
		const thinking = runtimeSnapshot?.thinking ??
			(hasRecordedThinking ? transcriptContext.thinkingLevel : undefined) ??
			configured?.thinking ?? prepared?.thinking ?? ownerSnapshot?.thinking ??
			owner?.effectiveConfiguration?.thinking ?? owner?.launchConfiguration?.thinking ??
			// A participant that has not started yet records no selection of its own, so
			// report the inherited one instead of failing a presentation-only projection:
			// this also runs from delivery-progress bookkeeping, where a throw would
			// escalate a notification into an operational failure.
			"off";
		if (!isRuntimeThinkingLevel(thinking)) {
			throw new Error(`invariant_violation: Agent ${status.agentId} has invalid thinking level`);
		}
		return {
			...status,
			model,
			thinking,
			compacting: record.host.isCompacting(),
			queuedInputCount: record.host.queuedInputCount(),
		};
	}

	#agentActivity(agentId: string): AgentActivitySnapshot {
		const record = this.#requireAgent(agentId);
		const ownerScope = agentId === this.#ownerIdentity.agentId;
		return {
			scope: this.#agentActivityStatus(record),
			children: record.children.map((childId) =>
				this.#agentActivityStatus(this.#requireAgent(childId))
			),
			answerMode: this.#humanRequests.hasPendingRequest(agentId),
			reports: ownerScope ? this.#reports.history() : [],
			humanAttention: ownerScope
				? this.#humanRequests.attentionItems(this.#ownerIdentity.agentId)
				: [],
			operationalAttention: ownerScope
				? this.#operationalIncidents.attentionItems(this.#ownerIdentity.agentId)
				: [],
		};
	}

	#agentActivityStatus(record: AgentRecord): AgentActivityStatus {
		const activeView = this.#activeAgentView;
		return {
			...this.#rosterStatus(record),
			failed: record.host.currentRunFailed() || (
				activeView?.record === record && activeView.failed
			),
		};
	}

	#activityRefresh: Promise<void> | undefined;
	readonly #activityDirtyAgentIds = new Set<string>();
	#activityRefreshAll = false;
	#notifyAgentActivityChanged(agentId?: string): void {
		if (this.#shuttingDown) return;
		// Unknown sources retain a conservative full refresh. A host or model event
		// already identifies its source and must not read unrelated dormant history.
		if (agentId === undefined) this.#activityRefreshAll = true;
		else this.#activityDirtyAgentIds.add(agentId);
		this.#scheduleAgentActivityRefresh();
		// The selector shares this subscription with activity docks. Preserve global,
		// immediate host-state publication even when transcript refresh is scoped.
		for (const handler of this.#agentActivityChangeHandlers) handler();
	}

	#scheduleAgentActivityRefresh(): void {
		if (this.#activityRefresh || this.#shuttingDown) return;
		// Defer collection so a synchronous burst shares one refresh and the pending
		// promise is installed before observers can reenter this method.
		this.#activityRefresh = Promise.resolve().then(async () => {
			while (!this.#shuttingDown && (this.#activityRefreshAll || this.#activityDirtyAgentIds.size)) {
				const records = this.#activityRefreshAll
					? [...this.#agents.values()]
					: [...this.#activityDirtyAgentIds].map(agentId => this.#requireAgent(agentId));
				// Detach this batch before awaiting. Later events, including another
				// change to the same Agent, belong to a fresh successor batch.
				this.#activityRefreshAll = false;
				this.#activityDirtyAgentIds.clear();
				this.#presentationWork.activityRefreshPasses++;
				this.#presentationWork.activitySourcesScheduled += records.length;
				await refreshAgentTranscripts(records);
				if (this.#shuttingDown) return;
				for (const handler of this.#agentActivityChangeHandlers) handler();
			}
		})
			.catch((error) => this.#reportAgentRuntimeReleaseError(error))
			.finally(() => {
				this.#activityRefresh = undefined;
				if (this.#activityRefreshAll || this.#activityDirtyAgentIds.size) this.#scheduleAgentActivityRefresh();
			});
	}

	#requireAgent(agentId: string): AgentRecord {
		return requireAgentRecord(
			this.#agents,
			this.#quarantinedAgentIds,
			agentId,
		);
	}

	#requireModerator(agentId: string): AgentRecord {
		const record = this.#requireAgent(agentId);
		if (!this.#isModerator(agentId)) {
			throw new Error(`unauthorized: Agent ${agentId} is not a Moderator`);
		}
		return record;
	}

	#isModerator(agentId: string): boolean {
		const identity = this.#agents.get(agentId)?.identity;
		return identity !== undefined && isModeratorIdentity(identity);
	}

	#executionRole(agentId: string): AgentExecutionRole {
		if (agentId === this.#ownerIdentity.agentId) return "owner";
		return this.#isModerator(agentId) ? "moderator" : "child";
	}

	#integrateAgent(record: AgentRecord): void {
		// Recovery, ordinary spawning, and Moderator admission all integrate after
		// adding the record and its parent relationship. Run changes do not alter ancestry.
		this.#cachedAuthorityOrder = undefined;
		record.host.setRunSuspensionHandler((suspension, handle) => {
			// Quota suspension is process-local: it stops this exact Run and releases its
			// execution permit. Nothing durable has to be recorded or restored.
			if (suspension) this.#releaseExecution(record.identity.agentId, handle);
		});
		record.host.addStateChangeHandler(() => this.#notifyAgentActivityChanged(record.identity.agentId));
		record.host.addSettledHandler(() => this.#notifyAgentActivityChanged(record.identity.agentId));
		record.host.addEndedHandler((handle) => {
			// A terminal Runtime fault can bypass participant executionEnd. Tie the
			// fallback release to the exact ended Run so it cannot affect a successor.
			this.#releaseExecution(record.identity.agentId, handle);
		});
		record.host.setProjectionInputSettledHandler(() => {
			void this.#messages.requestRelease(record).catch((error) =>
				this.#reportAgentRuntimeReleaseError(error)
			);
		});
		record.host.setRunStartedHandler(async (handle) => {
			await this.#bindViewedRunInLane(record, handle);
		});
		record.host.setRunEndingHandler(async (handle, cause) => {
			await this.#handleViewedRunEndingInLane(record, handle, cause);
		});
		this.#messages.integrate(record);
		this.#operationalIncidents.integrate(record);
		this.#notifyAgentActivityChanged(record.identity.agentId);
	}

	#openAgentPresentation(agentId: string): Promise<AgentPresentationSelection> {
		return this.#agentViewLane.run(async () => {
			if (agentId === this.#ownerIdentity.agentId) {
				const active = this.#activeAgentView;
				if (active) await this.#closeActiveAgentViewInLane(active);
				return { kind: "selected" };
			}
			const active = this.#activeAgentView;
			if (active?.record.identity.agentId === agentId) return { kind: "selected" };
			const record = this.#requireAgent(agentId);
			let target: AgentViewTarget;
			try {
				target = await this.#acquireAgentViewTarget(record);
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
				await this.#switchActiveAgentViewToTargetInLane(active, record, target);
				return { kind: "selected" };
			}
			let attachment!: DurableAgentViewAttachment;
			attachment = new DurableAgentViewAttachment({
				agentId,
				label: record.identity.metadata.label,
				projection: target.projection,
				requestClose: () => this.#closeAgentView(attachment),
				reportFailure: (error) => this.#reportAgentViewError(error),
			});
			this.#activeAgentView = {
				record,
				attachment,
				failed: false,
			};
			this.#notifyAgentActivityChanged();
			return { kind: "selected", view: attachment };
		});
	}

	async #openAgentView(agentId: string): Promise<DurableAgentView | undefined> {
		const selection = await this.#openAgentPresentation(agentId);
		if (selection.kind === "post_mortem") {
			throw new Error(selection.preparationError);
		}
		return selection.view;
	}

	async #acquireAgentViewTarget(record: AgentRecord): Promise<AgentViewTarget> {
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
			return this.#prepareAgentViewTarget(record);
		}
		const liveTarget = await record.host.lane.run(() => {
			// Release may have won the lane after selection observed an ending Runtime.
			// Re-check at the serialized boundary instead of applying a stale live path
			// to the now-dormant Agent.
			if (
				record.host.observe().phase === "dormant" &&
				!record.host.currentProjection()
			) return undefined;
			return this.#acquireAgentViewTargetInLane(record);
		});
		return liveTarget ?? this.#prepareAgentViewTarget(record);
	}

	async #prepareAgentViewTarget(record: AgentRecord): Promise<AgentViewTarget> {
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
			void this.#agentViewLane.run(async () => {
				const active = this.#activeAgentView;
				if (
					!active ||
					active.record !== record ||
					active.attachment.projection() !== projection
				) return;
				this.#reportAgentViewError(error);
				await this.#closeActiveAgentViewInLane(active);
			}).catch((cleanupError) => this.#reportAgentViewError(cleanupError));
		});
		record.host.addRetentionReason("interactive_selection");
		return { projection, retryIfChanged: false };
	}

	async #acquireAgentViewTargetInLane(record: AgentRecord): Promise<AgentViewTarget> {
		record.host.addRetentionReason("interactive_selection");
		const projection = record.host.currentProjection();
		if (projection) return { projection, retryIfChanged: true };
		record.host.removeRetentionReason("interactive_selection");
		throw new Error(
			`invariant_violation: live Agent ${record.identity.agentId} has no presentation projection`,
		);
	}

	async #switchActiveAgentViewToTargetInLane(
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
				await this.#releaseUnpublishedAgentViewTarget(record, target);
				if (!target.retryIfChanged) {
					throw new Error(
						`stale_run: selected Agent ${record.identity.agentId} changed during view preparation`,
					);
				}
				target = await this.#acquireAgentViewTarget(record);
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
						this.#reportAgentViewError(error);
					}
				}
				this.#notifyAgentActivityChanged();
			}
			return;
		}
	}

	async #releaseUnpublishedAgentViewTarget(
		record: AgentRecord,
		_target: AgentViewTarget,
	): Promise<void> {
		await record.host.lane.run(() => {
			record.host.removeRetentionReason("interactive_selection");
		});
		await this.#messages.requestRelease(record);
	}

	#closeAgentView(attachment: DurableAgentViewAttachment): Promise<void> {
		return this.#agentViewLane.run(async () => {
			const active = this.#activeAgentView;
			if (!active || active.attachment !== attachment) {
				attachment.settleClosed();
				return;
			}
			await this.#closeActiveAgentViewInLane(active);
		});
	}

	async #closeActiveAgentViewInLane(active: ActiveDurableAgentView): Promise<void> {
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
			if (this.#activeAgentView !== active) return;
			this.#activeAgentView = undefined;
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
		const active = this.#activeAgentView;
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
		this.#notifyAgentActivityChanged();
	}

	async #handleViewedRunEndingInLane(
		record: AgentRecord,
		handle: Readonly<{ sequence: number }>,
		cause: "failure" | "termination" | "shutdown",
	): Promise<void> {
		const active = this.#activeAgentView;
		if (
			!active ||
			active.record !== record ||
			!record.host.isCurrent(handle) ||
			record.host.currentProjection() !== active.attachment.projection()
		) return;
		if (record.host.observe().phase === "starting") {
			// Initialization cancellation disposes this not-yet-usable projection;
			// unlike an admitted Run, it cannot remain as a Dormant attached view.
			this.#activeAgentView = undefined;
			active.attachment.settleClosed();
			this.#notifyAgentActivityChanged();
			return;
		}
		if (cause !== "failure") return;
		active.failed = true;
		this.#notifyAgentActivityChanged();
	}

	#reportAgentViewError(error: unknown): void {
		this.#ownerDiagnostics.push({
			type: "error",
			message: `Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	#reportAgentRuntimeReleaseError(error: unknown): void {
		this.#ownerDiagnostics.push({
			type: "error",
			message: `Agent runtime release failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	#focusHumanAnswer(agentId: string, requestId: string): Promise<void> {
		return this.#agentViewLane.run(() => {
			if (!this.#humanRequests.hasPendingRequest(agentId, requestId)) {
				throw new Error("stale_request: Human Request is no longer pending");
			}
			const active = this.#activeAgentView;
			if (!active || active.record.identity.agentId !== agentId) {
				throw new Error(
					`invariant_violation: Human Request Agent ${agentId} is not selected`,
				);
			}
			active.attachment.projection().focusEditor();
		});
	}

	async #beginExecution(
		agentId: string,
		submissionSequence?: number,
	): Promise<void> {
		this.#assertAdmissionOpen();
		const record = this.#requireAgent(agentId);
		const inputSubmission = this.#captureInputSubmission(record, submissionSequence);
		this.#assertInputSubmissionAdmissible(record, inputSubmission);
		const currentHandle = record.host.currentHandle();
		const handle = currentHandle ?? await record.host.lane.run(async () => {
			this.#assertInputSubmissionAdmissible(record, inputSubmission);
			return record.host.currentHandle() ?? await record.host.startInLane();
		});
		if (this.#executionPermits.has(agentId)) {
			throw new Error(
				`invariant_violation: Agent ${agentId} execution already holds Workflow capacity`,
			);
		}
		await this.#ensureExecution(agentId);
		// No await may separate these final checks from the successful lifecycle
		// response: termination can fence the submission and replace the exact Run.
		this.#assertInputSubmissionAdmissible(record, inputSubmission);
		if (!record.host.isCurrent(handle)) {
			throw new Error("stale_run: execution admission lost its exact Agent Run");
		}
		this.#assertAdmissionOpen();
	}

	#captureInputSubmission(
		record: AgentRecord,
		submissionSequence: number | undefined,
	): ProjectionInputSubmission | undefined {
		if (submissionSequence === undefined) return undefined;
		const submission = record.host.captureProjectionInputSubmission(submissionSequence);
		if (!submission) {
			throw new Error("stale_native_input: submission has no exact Runtime projection");
		}
		return submission;
	}

	#assertInputSubmissionAdmissible(
		record: AgentRecord,
		submission: ProjectionInputSubmission | undefined,
	): void {
		if (
			submission !== undefined &&
			record.host.projectionInputSubmissionIsFenced(submission)
		) {
			throw new Error("stale_native_input: submission preceded exact-Run termination");
		}
	}

	async #ensureExecution(agentId: string): Promise<void> {
		this.#assertAdmissionOpen();
		const record = this.#requireAgent(agentId);
		if (record.host.runSuspensionBlocksExecution()) throw new Error("run_suspended: explicit resume is required");
		if (this.#executionPermits.has(agentId)) return;
		const run = record.host.observe();
		if (run.phase !== "live" || run.attention === "input_required") return;
		const handle = record.host.currentHandle();
		if (!handle) return;
		const role = this.#executionRole(agentId);
		this.#waitingForExecution.add(agentId);
		this.#operationalIncidents.deliveryProgressChanged();
		const permit = await this.#executionScheduler.admit(
			role,
			role === "child"
				? record.host.exactRunCancellationSignal(handle)
				: undefined,
		).finally(() => {
			this.#waitingForExecution.delete(agentId);
			this.#operationalIncidents.deliveryProgressChanged();
		});
		if (!permit) return;
		if (record.host.runSuspensionBlocksExecution()) {
			permit.release();
			throw new Error("run_suspended: execution admission was suspended");
		}
		if (this.#shuttingDown) {
			permit.release();
			this.#assertAdmissionOpen();
		}
		this.#executionPermits.set(agentId, { handle, permit });
	}

	#releaseExecution(agentId: string, handle?: AgentRunHandle): void {
		const execution = this.#executionPermits.get(agentId);
		if (!execution || (handle !== undefined && execution.handle !== handle)) return;
		this.#executionPermits.delete(agentId);
		execution.permit.release();
	}

	#handleHumanInput(
		agentId: string,
		text: string,
		images: readonly ImageContent[] | undefined,
		submissionSequence?: number,
	): Promise<HumanInputDisposition> {
		const record = this.#requireAgent(agentId);
		let inputSubmission: ProjectionInputSubmission | undefined;
		try {
			inputSubmission = this.#captureInputSubmission(record, submissionSequence);
			this.#assertInputSubmissionAdmissible(record, inputSubmission);
		} catch {
			return Promise.resolve("discarded");
		}
		if (this.#humanRequests.submitAnswer(agentId, text, (images?.length ?? 0) > 0)) {
			return Promise.resolve("submitted");
		}
		return this.#agentViewLane.run(async () => {
			const active = this.#activeAgentView;
			if (!active || active.record.identity.agentId !== agentId) {
				return await this.#runSupervisor.resumeFromHuman(agentId, text, images, submissionSequence)
					? "submitted"
					: "continue";
			}
			return active.record.host.lane.run(async () => {
				if (this.#activeAgentView !== active) return "discarded";
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

	async #shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		const cleanupErrors: unknown[] = [];
		const children = () => [...this.#agents.values()].filter(
			(record) => record.identity.agentId !== this.#ownerIdentity.agentId,
		);
		// Fence queued starts before awaiting any lane. A start already preparing its
		// projection observes the same fence immediately after binding and cancels there.
		collectSettledCleanupFailures(cleanupErrors, await Promise.allSettled(
			children().map((record) => record.host.beginShutdown()),
		));
		// Host-side spawn handlers outlive their child's Control connection. Join
		// their evidence writes outside Agent lanes, and include any newly committed
		// records in cleanup. Moderator bootstrap has its own reconciliation lane.
		await Promise.allSettled([...this.#pendingSpawns]);
		await collectCleanupFailure(cleanupErrors, () => this.#operationalIncidents.reachSafeBoundary());
		await collectCleanupFailure(
			cleanupErrors,
			() => this.#activeAgentView?.attachment.close(),
		);
		await collectCleanupFailure(
			cleanupErrors,
			() => this.#operationalIncidents.shutdown(),
		);
		collectSettledCleanupFailures(cleanupErrors, await Promise.allSettled(
			children().map((record) =>
				record.host.lane.run(() => this.#shutdownAgentInLane(record)),
			),
		));
		const owner = this.#requireAgent(this.#ownerIdentity.agentId);
		await collectCleanupFailure(
			cleanupErrors,
			() => owner.host.lane.run(() =>
				this.#shutdownAgentInLane(owner, disposeNativeRuntime)
			),
		);
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Workflow shutdown failed");
		}
	}

	async #shutdownAgentInLane(
		record: AgentRecord,
		disposeRun?: () => Promise<void>,
	): Promise<void> {
		const cleanupErrors: unknown[] = [];
		// Discard volatile delivery work before ending the host so no queued work
		// can outlive the Run whose transcript would receive it.
		await collectCleanupFailure(
			cleanupErrors,
			() => this.#messages.discardSchedulingInLane(record),
		);
		await collectCleanupFailure(
			cleanupErrors,
			() => record.host.discardAndEndInLane("shutdown", disposeRun),
		);
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Agent shutdown failed");
		}
	}

}

function searchRelevance(
	record: AgentRecord,
	query: string | undefined,
): number {
	if (query === undefined) return 0;
	const label = record.identity.metadata.label.toLowerCase();
	if (label === query) return 0;
	if (label.startsWith(query)) return 1;
	if (label.includes(query)) return 2;
	return 3;
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

async function collectCleanupFailure(
	errors: unknown[],
	cleanup: () => unknown | Promise<unknown>,
): Promise<void> {
	try {
		await cleanup();
	} catch (error) {
		appendCleanupFailure(errors, error);
	}
}

function collectSettledCleanupFailures(
	errors: unknown[],
	results: readonly PromiseSettledResult<unknown>[],
): void {
	for (const result of results) {
		if (result.status === "rejected") appendCleanupFailure(errors, result.reason);
	}
}

function appendCleanupFailure(errors: unknown[], error: unknown): void {
	if (error instanceof AggregateError) {
		for (const nested of error.errors) appendCleanupFailure(errors, nested);
		return;
	}
	errors.push(error);
}
