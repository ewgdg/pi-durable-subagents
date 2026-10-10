import { resumeWorkflow } from "./workflow-resume.ts";
import type { WorkflowInteraction } from "../pi-integration/workflow-interaction.ts";
import type { WorkflowResumeReceipt } from "../protocol/workflow-resume.ts";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { ModeratorReportStore } from "./moderator-reports.ts";
import { validateReportToUserInput, type ReportToUserInput, type ReportToUserReceipt, type ReportHistoryItem } from "../protocol/moderator-report.ts";
import { resolveCommittedToolCall } from "../protocol/identities.ts";
import type { ObligationFrame } from "../protocol/obligation-focus.ts";
import { OPERATIONAL_DIAGNOSTIC_CUSTOM_TYPE } from "../protocol/custom-entry-types.ts";
import { createRunSuspensionNotice, inspectRunSuspensionNotice } from "../protocol/run-suspension-notice.ts";
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
	AgentRunSuspension,
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
import { RequestEvidence } from "./request-evidence.ts";
import { RequestRelationships } from "./request-relationships.ts";
import type {
	RunControlInput,
	RunControlReceipt,
} from "../protocol/run-control.ts";
import type {
	AgentTemplateCatalogueEntry,
	AgentTemplateCatalogueSnapshot,
	AgentTemplateRoot,
} from "../templates/agent-templates.ts";
import {
	readWorkflowPolicy,
	WorkflowPolicyStore,
	writeExcludedModels,
	writeVirtualModels,
} from "../policy/workflow-policy.ts";
import {
	parseVirtualModels,
	serializeVirtualModels,
	VIRTUAL_MODEL_PROVIDER,
	type VirtualModelConfigSnapshot,
	type VirtualModelDefinitions,
} from "../policy/virtual-models.ts";
import { parseExcludedModels, type ModelPolicySnapshot } from "../policy/model-exclusion.ts";
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
import type {
	AgentActivitySnapshot,
	AgentActivityStatus,
} from "../presentation/agent-activity-surface.ts";
import { createViewBackedParticipantHandlers } from "./view-backed-participant-handlers.ts";
import type {
	AgentSearchInput,
	AgentSearchResult,
} from "../tools/coordination-tool-catalogue.ts";
import { answerCallTargetAgentId } from "../protocol/request-resolution.ts";
import type { OpenIncomingRequestList, RequestInspection } from "../protocol/request-inspection.ts";
import { createOwnerAgentPresentationHandlers } from "../process-runtime/remote-agent-selector.ts";
import type {
	DurableAgentView,
	PhysicalAgentViewSurface,
} from "../presentation/agent-view-surface.ts";
import type { PostMortemAgentPresenter } from "../presentation/post-mortem-agent-view-surface.ts";
import {
	InteractiveSelection,
	type AgentPresentationSelection,
	type HumanInputDisposition,
} from "./interactive-selection.ts";
import { collectCleanupFailure, collectSettledCleanupFailures } from "./cleanup-failures.ts";

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
	/** Virtual Model definitions as the Config tab shows them. */
	virtualModelConfig(): Promise<VirtualModelConfigSnapshot>;
	setVirtualModels(definitions: VirtualModelDefinitions): Promise<VirtualModelConfigSnapshot>;
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
	/** Starts with reconcileCommittedToolResults; callers refresh transcript facts first. */
	reachSafeBoundary(): Promise<void>;
	beginExecution(submissionSequence?: number): Promise<void>;
	obligationFrames(): readonly ObligationFrame[];
	/** Checks the Workflow shutdown fence and Run Suspension; never waits. */
	assertNotShutDownOrSuspended(): void;
	beginToolExecution(toolCallId: string, toolName: string): void;
	reconcileCommittedToolResults(): void;
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
	readonly #requestEvidence: RequestEvidence;
	readonly #requestRelationships: RequestRelationships;
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
	readonly #postMortemAgentPresenter: PostMortemAgentPresenter | undefined;
	readonly #selection: InteractiveSelection;
	readonly #workflowPolicy: WorkflowPolicyStore;
	readonly #quarantinedAgentIds: ReadonlySet<string>;
	readonly #quarantinedWorkflowAgentIds: ReadonlySet<string>;
	readonly #quarantinedCandidateCount: number;
	readonly #agentIdBySpawnSource: Map<string, string>;
	#shutdownPromise: Promise<void> | undefined;
	readonly #shutdownController = new AbortController();
	#shuttingDown = false;
	readonly #pendingSpawns = new Set<Promise<unknown>>();
	readonly #interaction: WorkflowInteraction;
	// Pi reports one exact stop more than once while it drains the native queue.
	readonly #noticedSuspensions = new WeakSet<AgentRunSuspension>();

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
			/** Defaults to a terminal Workflow. */
			interaction?: WorkflowInteraction;
		},
	) {
		this.#ownerDiagnostics = runtime.services.diagnostics;
		this.#ownerRuntime = runtime;
		this.#interaction = options.interaction ?? "terminal";
		this.#postMortemAgentPresenter = options.postMortemAgentPresenter;
		this.#quarantinedAgentIds = options.recoveredWorkflow?.quarantinedAgentIds ?? new Set();
		this.#quarantinedWorkflowAgentIds =
			options.recoveredWorkflow?.quarantinedWorkflowAgentIds ?? new Set();
		this.#quarantinedCandidateCount = options.recoveredWorkflow?.quarantinedCandidateCount ?? 0;
		this.#agentIdBySpawnSource = new Map(
			options.recoveredWorkflow?.agentIdBySpawnSource ?? [],
		);
		this.#workflowPolicy = options.workflowPolicy ?? new WorkflowPolicyStore();
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
			ownerIdentity: identity,
			entryModulePath: options.entryModulePath,
			packageRoot: options.packageRoot ?? resolve(dirname(options.entryModulePath), ".."),
			templateRoots: options.templateRoots,
			resolveAgent: (agentId) => this.#agents.get(agentId),
			interaction: this.#interaction,
			ownerRequestHandlers: (role, agentId) => {
				if (role === "ordinary") {
					const resolveView = () => this.forAgent(agentId);
					return {
						...createViewBackedParticipantHandlers("ordinary", resolveView),
						presentation: createOwnerAgentPresentationHandlers(
							resolveView,
							agentId,
							options.postMortemAgentPresenter,
						),
					};
				}
				const resolveView = () => this.forModerator(agentId);
				return {
					...createViewBackedParticipantHandlers("moderator", resolveView),
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
		this.#requestEvidence = new RequestEvidence(
			this.#agents,
			this.#quarantinedAgentIds,
			this.#quarantinedWorkflowAgentIds,
		);
		this.#requestRelationships = new RequestRelationships({
			agents: this.#agents,
			requestEvidence: this.#requestEvidence,
		});
		this.#messages = new MessageCoordinator({
			agents: this.#agents,
			requestEvidence: this.#requestEvidence,
			requestRelationships: this.#requestRelationships,
			quarantinedAgentIds: this.#quarantinedAgentIds,
			quarantinedWorkflowAgentIds: this.#quarantinedWorkflowAgentIds,
			isShuttingDown: () => this.#shuttingDown,
			boundaryHooks: options.messageBoundaryHooks,
			deliveryProgressClock: options.deliveryProgressClock,
			workflowPolicy: this.#workflowPolicy,
		});
		this.#agentWaits = new AgentWaitCoordinator({
			agents: this.#agents,
			messages: this.#messages,
			requestEvidence: this.#requestEvidence,
			requestRelationships: this.#requestRelationships,
			answerArbitration: this.#messages.answerArbitration,
			boundaryHooks: options.agentWaitBoundaryHooks,
			clock: options.agentWaitClock,
			assertNotShutDownOrSuspended: (record) =>
				this.#assertNotShutDownOrSuspended(record.identity.agentId),
			rejectsSuspendedResponders: this.#interaction === "headless",
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
			requestEvidence: this.#requestEvidence,
			requestRelationships: this.#requestRelationships,
			humanRequests: this.#humanRequests,
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
		this.#selection = new InteractiveSelection({
			agents: this.#agents,
			quarantinedAgentIds: this.#quarantinedAgentIds,
			ownerIdentity: identity,
			messages: this.#messages,
			runSupervisor: this.#runSupervisor,
			humanRequests: this.#humanRequests,
			sessionFactory,
			beginShutdown: () => this.#beginShutdown(),
			diagnostics: this.#ownerDiagnostics,
			onActivityChanged: () => this.#notifyAgentActivityChanged(),
		});
		this.#messages.subscribeDeliveryProgress(() => this.#notifyAgentActivityChanged());
		for (const record of this.#agents.values()) this.#integrateAgent(record);
		this.#spawner = new DefaultChildSpawner({
			agents: this.#agents,
			agentIdBySpawnSource: this.#agentIdBySpawnSource,
			sessionFactory,
			messages: this.#messages,
			requestRelationships: this.#requestRelationships,
			integrateAgent: (record) => this.#integrateAgent(record),
			boundaryHooks: options.spawnBoundaryHooks,
			isShuttingDown: () => this.#shuttingDown,
		});
	}

	async initialize(): Promise<void> {
		await this.refreshAgentTemplateSnapshot(this.#ownerIdentity.agentId);
		await this.#requestRelationships.refresh();
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
		await this.#refreshTemplateSnapshots();
		return this.modelPolicy();
	}

	/**
	 * Template catalogues drop candidates whose model is unavailable, so every cached
	 * snapshot is captured again after a model policy change. A snapshot that cannot
	 * be refreshed keeps its previous value and reports a diagnostic.
	 */
	async #refreshTemplateSnapshots(): Promise<void> {
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
	}

	/**
	 * Reads the policy file itself: routing and Runtime Preparation reread it too, so
	 * a hand edit since the last Owner reload is what Agents already run with.
	 */
	async virtualModelConfig(): Promise<VirtualModelConfigSnapshot> {
		const read = await readWorkflowPolicy(this.#ownerRuntime.services.agentDir);
		const policy = read.ok ? read.snapshot : this.#workflowPolicy.current();
		return {
			// Entries are real models only, so registered Virtual Models are not candidates.
			availableModels: this.modelPolicy().availableModels
				.filter(({ provider }) => provider !== VIRTUAL_MODEL_PROVIDER),
			excludedModels: [...policy.excludedModels],
			virtualModels: policy.virtualModels,
			...(read.ok ? {} : { invalidReason: read.diagnostic.message }),
		};
	}

	/**
	 * Persists the complete definitions, then publishes them and refreshes Template
	 * snapshots, whose candidates may name a Virtual Model that just became defined,
	 * usable, or undefined.
	 */
	async setVirtualModels(definitions: VirtualModelDefinitions): Promise<VirtualModelConfigSnapshot> {
		// Round-trip through the file shape: validates before writing and freezes what is published.
		const validated = parseVirtualModels(serializeVirtualModels(definitions));
		await writeVirtualModels(this.#ownerRuntime.services.agentDir, validated);
		this.#workflowPolicy.publish(Object.freeze({
			...this.#workflowPolicy.current(),
			virtualModels: validated,
		}));
		await this.#refreshTemplateSnapshots();
		return this.virtualModelConfig();
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
		// Human Requests, Agent Wait and Operation Review reconcile independently, in
		// this fixed order; then parked Waits across the Workflow re-check Answers.
		// Operation Review also schedules the incident evaluation the safe boundary awaits.
		const reconcileCommittedToolResults = () => {
			this.#humanRequests.reconcileCommittedResults(agentId);
			this.#agentWaits.reconcileCommittedResults(agentId);
			this.#operationalIncidents.reconcileCommittedToolResults(agentId);
			this.#agentWaits.reconcileCommittedAnswers();
		};
		return {
			status: (targetAgentId?: string) => this.#statusFor(agentId, targetAgentId),
			modelPolicy: () => this.modelPolicy(),
			setModelExclusions: (entries) => this.setModelExclusions(entries),
			virtualModelConfig: () => this.virtualModelConfig(),
			setVirtualModels: (definitions) => this.setVirtualModels(definitions),
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
			openIncomingRequests: () => this.#requestRelationships.openIncomingRequests(this.#requireAgent(agentId)),
			inspectRequest: (requestId) => this.#requestEvidence.inspectRequest(this.#requireAgent(agentId), requestId),
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
				return this.#selection.openPresentation(targetAgentId);
			},
			openAgentView: (targetAgentId) => {
				this.#assertAdmissionOpen();
				return this.#selection.openView(targetAgentId);
			},
			bindPhysicalAgentSurface: (surface) =>
				this.#postMortemAgentPresenter?.bindPhysicalSurface(surface) ?? (() => undefined),
			focusHumanAnswer: (targetAgentId, requestId) => {
				this.#assertAdmissionOpen();
				return this.#selection.focusHumanAnswer(targetAgentId, requestId);
			},
			askHuman: (toolCallId, input, signal) => {
				this.#assertAdmissionOpen();
				return this.#humanRequests.ask(agentId, toolCallId, input, signal);
			},
			guardToolResult: (message) =>
				this.#humanRequests.guardResultCommit(agentId, message) ??
				this.#messages.guardResultCommit(agentId, message) ??
				this.#agentWaits.guardResultCommit(agentId, message),
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
			// Committed tool results, then Answer relationship sync and the scheduler's
			// safe boundary, then Operational Incident evaluation last.
			reachSafeBoundary: async () => {
				reconcileCommittedToolResults();
				await this.#messages.reachSafeBoundary(agentId);
				await this.#operationalIncidents.reachSafeBoundary();
			},
			beginExecution: (submissionSequence) =>
				this.#beginExecution(agentId, submissionSequence),
			assertNotShutDownOrSuspended: () => this.#assertNotShutDownOrSuspended(agentId),
			beginToolExecution: (toolCallId, toolName) => {
				this.#assertAdmissionOpen();
				this.#operationalIncidents.admitToolExecution(
					agentId,
					toolCallId,
					toolName,
				);
			},
			reconcileCommittedToolResults,
			obligationFrames: () => this.#requestRelationships.obligationFrames(this.#requireAgent(agentId)),
		};
	}

	hasAutonomousWorkflowProgress(): boolean {
		if (this.#shuttingDown) return false;
		// The entire Workflow matters: a waiting parent contributes no execution,
		// but its progressing descendant (or a recovering Moderator) still does.
		return this.#operationalIncidents.hasProgressingAgentForOwnerParking() ||
			this.#messages.hasAutonomousDeliveryProgress() ||
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
			return this.#statusOf(this.#requireObservable(callerAgentId, selector));
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
		if (identity) return this.#statusOf(this.#requireObservable(callerAgentId, identity.agentId));
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
		return this.#statusOf(this.#requireObservable(callerAgentId, target.agentId));
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
			matches: matching.slice(0, limit).map(({ record }) => this.#statusOf(record)),
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
		return target.children.map((agentId) => this.#statusOf(this.#requireAgent(agentId)));
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
			// A queued child is about to work, so it belongs with the live Agents.
			if (status.run.phase !== "dormant" || status.run.queued) {
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

	/** Agent status as observed by models and presentation, with a Deferred Boot shown as `queued`. */
	#statusOf(record: AgentRecord, transcript?: TranscriptInspection): AgentStatus {
		const status = statusOf(record, transcript);
		return status.run.phase === "dormant" && this.#messages.isBootDeferred(record)
			? { ...status, run: { ...status.run, queued: true } }
			: status;
	}

	#rosterStatus(
		record: AgentRecord,
		transcript: TranscriptInspection = record.transcript.snapshot() ?? record.transcript.inspect(),
	): AgentRosterStatus {
		// Share one observation for the evidence pointer, configuration, and recency.
		// File-backed transcripts otherwise reparse the whole history for each field.
		const status = this.#statusOf(record, transcript);
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
		return {
			...this.#rosterStatus(record),
			failed: record.host.currentRunFailed() || this.#selection.selectedViewFailed(record),
		};
	}

	#activityRefresh: Promise<void> | undefined;
	readonly #activityDirtyAgentIds = new Set<string>();
	#activityRefreshAll = false;
	#notifyAgentActivityChanged(agentId?: string): void {
		if (this.#shuttingDown) return;
		this.#queueDeferredBootCheck();
		// Unknown sources retain a conservative full refresh. A host or model event
		// already identifies its source and must not read unrelated dormant history.
		if (agentId === undefined) this.#activityRefreshAll = true;
		else this.#activityDirtyAgentIds.add(agentId);
		this.#scheduleAgentActivityRefresh();
		// The selector shares this subscription with activity docks. Preserve global,
		// immediate host-state publication even when transcript refresh is scoped.
		for (const handler of this.#agentActivityChangeHandlers) handler();
	}

	#deferredBootCheckQueued = false;
	/**
	 * Every change that can free a concurrency slot (Run end, settlement, Agent Wait,
	 * suspension, Holds) passes through activity notification. One
	 * coalesced check per burst re-derives the count from current Run state (ADR 0007).
	 */
	#queueDeferredBootCheck(): void {
		if (this.#deferredBootCheckQueued) return;
		this.#deferredBootCheckQueued = true;
		queueMicrotask(() => {
			this.#deferredBootCheckQueued = false;
			if (this.#shuttingDown) return;
			this.#messages.startDeferredBoots().catch((error: unknown) => {
				this.#ownerDiagnostics.push({
					type: "error",
					message: `Deferred Agent boot failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			});
		});
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

	#integrateAgent(record: AgentRecord): void {
		// Recovery, ordinary spawning, and Moderator admission all integrate after
		// adding the record and its parent relationship. Run changes do not alter ancestry.
		this.#cachedAuthorityOrder = undefined;
		record.host.setRunSuspensionHandler((suspension) => {
			// Run Suspension is process-local: nothing durable has to be recorded or restored.
			if (suspension && this.#interaction === "headless") {
				this.#noticeSupervisorOfSuspension(record, suspension);
			}
		});
		record.host.addStateChangeHandler(() => this.#notifyAgentActivityChanged(record.identity.agentId));
		record.host.addSettledHandler(() => this.#notifyAgentActivityChanged(record.identity.agentId));
		record.host.setProjectionInputSettledHandler(() => {
			void this.#messages.requestRelease(record).catch((error) =>
				this.#reportAgentRuntimeReleaseError(error)
			);
		});
		this.#selection.integrate(record);
		this.#requestRelationships.integrate(record);
		this.#messages.integrate(record);
		this.#operationalIncidents.integrate(record);
		this.#notifyAgentActivityChanged(record.identity.agentId);
	}

	/**
	 * A headless Workflow has no human to resume a suspended Run, so a parked
	 * supervisor would wait forever. Preempt its Wait and leave the choice to it.
	 */
	#noticeSupervisorOfSuspension(record: AgentRecord, suspension: AgentRunSuspension): void {
		if (this.#noticedSuspensions.has(suspension)) return;
		this.#noticedSuspensions.add(suspension);
		const agentId = record.identity.agentId;
		// The Owner has no supervisor; its RPC client sees the stopped Run directly.
		// Runtime-created Moderators have no Direct Spawner, so the Owner supervises them.
		if (agentId === this.#ownerIdentity.agentId) return;
		const supervisorId = this.#isModerator(agentId)
			? this.#ownerIdentity.agentId
			: record.identity.directSpawnerAgentId;
		const supervisor = supervisorId === null ? undefined : this.#agents.get(supervisorId);
		if (!supervisor) return;
		const notificationId = randomUUID();
		const message = createRunSuspensionNotice({
			notificationId,
			agentId: record.identity.agentId,
			suspension,
		});
		const inspectProof = () => inspectRunSuspensionNotice(
			supervisor.identity.agentId, supervisor.transcript.inspect(), message,
		);
		void this.#messages.admitCustomDelivery(supervisor, {
			messageId: notificationId,
			deliveryMode: "deferred",
			customMessage: message,
			preemptsAgentWait: true,
			inspectProof,
			// A resumed or ended Run no longer needs its supervisor's decision.
			isSuppressed: () => this.#shuttingDown || record.host.currentRunSuspension() !== suspension,
		}).then((admission) => {
			if (admission !== "pending") throw new Error(`Run suspension notice rejected: ${admission}`);
		}).catch((error: unknown) => this.#ownerDiagnostics.push({
			type: "error",
			message: `Run suspension notice failed: ${error instanceof Error ? error.message : String(error)}`,
		}));
	}

	#reportAgentRuntimeReleaseError(error: unknown): void {
		this.#ownerDiagnostics.push({
			type: "error",
			message: `Agent runtime release failed: ${error instanceof Error ? error.message : String(error)}`,
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
		// No await may separate these final checks from the successful lifecycle
		// response: an abort can fence the submission and replace the exact Run.
		this.#assertNotShutDownOrSuspended(agentId);
		this.#assertInputSubmissionAdmissible(record, inputSubmission);
		if (!record.host.isCurrent(handle)) {
			throw new Error("stale_run: execution admission lost its exact Agent Run");
		}
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
			throw new Error("stale_native_input: submission preceded exact-Run abort");
		}
	}

	#assertNotShutDownOrSuspended(agentId: string): void {
		this.#assertAdmissionOpen();
		if (this.#requireAgent(agentId).host.runSuspensionBlocksExecution()) {
			throw new Error("run_suspended: explicit resume is required");
		}
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
		// Mark before submission: the settlement this input causes must observe the mark
		// so a Stall after deselection can clear it.
		this.#operationalIncidents.noteHumanInterruption(agentId);
		return this.#selection.routeHumanInput(agentId, text, images, submissionSequence, inputSubmission);
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
			() => this.#selection.closeAtShutdown(),
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
