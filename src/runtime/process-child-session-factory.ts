import {
	type AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";

import type { WorkflowInteraction } from "../pi-integration/workflow-interaction.ts";
import { ChildLaunchContractGuard } from "../process-runtime/child-launch-contract.ts";

import type { AgentRecord } from "../coordination/agent-record.ts";
import { admitControlTransportPlatform } from "../control/control-platform.ts";
import { transcriptFromSessionFile } from "../pi-integration/session-manager-transcript.ts";
import {
	readRecordedModelSelection,
	recordModelSelection,
	sameModelSelection,
	type RecordedModelSelection,
} from "../pi-integration/recorded-model-selection.ts";
import { clampThinkingToModelCapability } from "../pi-integration/model-thinking-capability.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import {
	isModeratorIdentity,
	type ModeratorIdentity,
} from "../protocol/moderator-input.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import type { RuntimeThinkingLevel } from "../protocol/runtime-configuration.ts";
import { PiChildHostedRuntime } from "../process-runtime/pi-child-hosted-runtime.ts";
import { createPiChildProcessProjection } from "../process-runtime/pi-child-process-projection.ts";
import {
	DEFAULT_CHILD_STARTUP_TIMEOUT_MILLISECONDS,
	PiChildProcessRuntime,
	type StartPiChildProcessRuntimeOptions,
} from "../process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../process-runtime/remote-participant-control.ts";
import {
	defaultAgentTemplateRoots,
	discoverAgentTemplates,
} from "../templates/agent-template-discovery.ts";
import {
	createAgentTemplateCatalogue,
	captureAgentCreationPreset,
	selectAgentTemplateForCreation,
	type AgentCreationPreset,
	type AgentTemplate,
	type AgentTemplateCatalogueSnapshot,
	type AgentTemplateDiscovery,
	type AgentTemplateRoot,
} from "../templates/agent-templates.ts";
import type { HostedAgentProjection } from "./hosted-agent-projection.ts";
import { AgentRuntimeSupervisor } from "./agent-runtime-supervisor.ts";
import {
	prepareChildRuntime,
	type AgentRuntimeRole,
	type PreparedChildRuntime,
	type PreparedModeratorRuntime,
	type PreparedOrdinaryChildRuntime,
	type ResolvedParentRuntime,
} from "./child-runtime-preparation.ts";
import { workflowSessionDirectory } from "./workflow-session-directory.ts";
import { isModelExcluded, modelIdentity } from "../policy/model-exclusion.ts";
import {
	isVirtualModel,
	requireVirtualModelDefinition,
	type VirtualModelDefinitions,
	type VirtualModelEntry,
} from "../policy/virtual-models.ts";
import { readWorkflowPolicy } from "../policy/workflow-policy.ts";

const COORDINATION_EXTENSION_PREFIXES = [
	"<inline:pi-durable-subagents-agent:",
	"<inline:pi-durable-subagents-moderator:",
	"<inline:pi-durable-subagents-activity:",
] as const;
const INLINE_PUBLIC_EXTENSION_PATH = "<inline:pi-durable-subagents>";

/**
 * Host-level override for the per-stage child startup bound. Child boot takes ~0.4 s on
 * an idle host, but a host running several workflows at once can stretch it to tens of
 * seconds: a measured boot under four concurrent process suites took 31.2 s and still
 * completed. The bound is detection latency for a wedged child, not a correctness
 * property, so an operator or a test host may raise it without touching launch policy.
 */
const CHILD_STARTUP_TIMEOUT_ENVIRONMENT_VARIABLE = "PI_DURABLE_CHILD_STARTUP_TIMEOUT_MS";

function resolveChildStartupTimeoutMilliseconds(
	environment: NodeJS.ProcessEnv = process.env,
): number {
	const configured = environment[CHILD_STARTUP_TIMEOUT_ENVIRONMENT_VARIABLE];
	if (configured === undefined || configured.length === 0) {
		return DEFAULT_CHILD_STARTUP_TIMEOUT_MILLISECONDS;
	}
	if (!/^\d+$/.test(configured)) {
		throw new Error(
			`invalid_child_startup_timeout: ${CHILD_STARTUP_TIMEOUT_ENVIRONMENT_VARIABLE} must be a positive whole number of milliseconds`,
		);
	}
	const value = Number(configured);
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(
			`invalid_child_startup_timeout: ${CHILD_STARTUP_TIMEOUT_ENVIRONMENT_VARIABLE} must be a positive whole number of milliseconds`,
		);
	}
	return value;
}

type ParticipantHandlers =
	| OwnerParticipantRequestHandlers<"ordinary">
	| OwnerParticipantRequestHandlers<"moderator">;

/** Reports whether a native quit of this projection was handled. */
export type RuntimeQuitSubscriber = (agentId: string, projection: HostedAgentProjection | undefined) => boolean;

/** Launches every non-Owner Runtime in a fresh Pi process. */
export class ProcessChildSessionFactory {
	readonly #ownerRuntime: AgentSessionRuntime;
	readonly #launchContract: ChildLaunchContractGuard;
	#runtimeQuitSubscriber: RuntimeQuitSubscriber | undefined;
	readonly #templateLoads = new Map<string, Promise<Readonly<{
		discovery: AgentTemplateDiscovery;
		snapshot: AgentTemplateCatalogueSnapshot;
	}>>>();
	readonly #ownerIdentity: OwnerIdentity;
	readonly #entryModulePath: string;
	readonly #packageRoot: string;
	readonly #templateRoots:
		| ((parentCwd: string, projectTrusted: boolean) => readonly AgentTemplateRoot[])
		| undefined;
	readonly #resolveAgent: (agentId: string) => AgentRecord | undefined;
	readonly #modelExclusions: (() => readonly string[]) | undefined;
	/**
	 * Read from the policy file at each preparation, like the child that will route
	 * them, so a spawn check never disagrees with routing. Undefined while the file
	 * is invalid: a child would register no Virtual Models then.
	 */
	#virtualModels: VirtualModelDefinitions | undefined = {};
	readonly #ownerRequestHandlers: (
		role: AgentRuntimeRole,
		agentId: string,
	) => ParticipantHandlers;
	readonly #interaction: WorkflowInteraction | undefined;

	constructor(options: {
		ownerRuntime: AgentSessionRuntime;
		onLaunchBlocked?(error: Error): void;
		ownerIdentity: OwnerIdentity;
		entryModulePath: string;
		packageRoot?: string;
		templateRoots?(
			parentCwd: string,
			projectTrusted: boolean,
		): readonly AgentTemplateRoot[];
		resolveAgent(agentId: string): AgentRecord | undefined;
		/** Current user policy exclusions; read per preparation so a reload applies prospectively. */
		modelExclusions?(): readonly string[];
		ownerRequestHandlers(
			role: AgentRuntimeRole,
			agentId: string,
		): ParticipantHandlers;
		interaction?: WorkflowInteraction;
	}) {
		this.#ownerRuntime = options.ownerRuntime;
		this.#launchContract = new ChildLaunchContractGuard(undefined, options.onLaunchBlocked);
		this.#ownerIdentity = options.ownerIdentity;
		this.#entryModulePath = options.entryModulePath;
		this.#packageRoot = options.packageRoot ?? resolve(dirname(options.entryModulePath), "..");
		this.#templateRoots = options.templateRoots;
		this.#resolveAgent = options.resolveAgent;
		this.#modelExclusions = options.modelExclusions;
		this.#ownerRequestHandlers = options.ownerRequestHandlers;
		this.#interaction = options.interaction;
	}

	/**
	 * Interactive Selection subscribes because only it knows which projection the
	 * human is viewing. Without a subscriber no native quit is handled.
	 */
	subscribeRuntimeQuit(subscriber: RuntimeQuitSubscriber): void {
		if (this.#runtimeQuitSubscriber) {
			throw new Error("invariant_violation: Runtime quit already has a subscriber");
		}
		this.#runtimeQuitSubscriber = subscriber;
	}

	admitProcessRuntimePlatform(): void {
		admitControlTransportPlatform();
	}

	/**
	 * Fresh Runtimes resolve current parent inheritance and Pi resources against
	 * Agent-owned creation rules. A resolved launch configuration is never recovery input;
	 * the model selection recorded in the Agent's session is.
	 */
	async prepareOrdinaryRun(options: {
		agentId: string;
		parent: AgentRecord;
		spawnInput: AgentSpawnInput | undefined;
		creationPreset?: AgentCreationPreset;
		/** The existing Agent session whose recorded selection a fresh Runtime resumes. */
		sessionPath?: string;
	}): Promise<PreparedOrdinaryChildRuntime> {
		await this.#launchContract.assertCompatible();
		await this.#refreshVirtualModels();
		const { sessionPath, ...prepareOptions } = options;
		const recorded = sessionPath === undefined ? undefined : recordedSelectionAt(sessionPath);
		return this.#prepareOrdinaryRun({
			...prepareOptions,
			...(recorded === undefined ? {} : { recorded }),
		}, new Set());
	}

	async prepareModeratorRun(options: {
		agentId: string;
		creationPreset?: AgentCreationPreset;
		/** The existing Moderator session whose recorded selection a fresh Runtime resumes. */
		sessionPath?: string;
	}): Promise<PreparedModeratorRuntime> {
		await this.#launchContract.assertCompatible();
		await this.#refreshVirtualModels();
		const recorded = options.sessionPath === undefined ? undefined : recordedSelectionAt(options.sessionPath);
		const owner = this.#resolveAgent(this.#ownerIdentity.agentId);
		if (!owner) throw new Error("invariant_violation: Workflow Owner is unavailable");
		const parentRuntime = await this.#resolveCurrentRuntime(owner, new Set());
		const creationPreset = options.creationPreset === undefined
			? captureAgentCreationPreset(await this.#resolveSelectedTemplate(owner.identity.agentId, parentRuntime, "moderator"))
			: options.creationPreset;
		const template = creationPreset ?? undefined;
		return prepareChildRuntime({
			agentId: options.agentId,
			role: "moderator",
			agentDir: this.#ownerRuntime.services.agentDir,
			parentRuntime,
			isModelAvailable: (model) => this.#isModelAvailable(model),
			isModelExcluded: (model) => this.#modelExcluded(model),
			clampThinking: (model, level) => this.#clampThinking(model, level),
			presetThinking: (model) => this.#presetThinking(model),
			...(template === undefined ? {} : { template }),
			...(recorded === undefined ? {} : { recorded }),
		});
	}

	createStagingSession(prepared: PreparedChildRuntime): SessionManager {
		return SessionManager.create(
			prepared.configuration.cwd,
			this.workflowSessionDirectory(),
			{ id: prepared.agentId },
		);
	}

	createAgentRecord(options: {
		identity: ChildAgentIdentity;
		spawnInput: AgentSpawnInput | undefined;
		parent: AgentRecord;
		initialPreparation?: PreparedOrdinaryChildRuntime;
		sessionPath: string;
	}): AgentRecord {
		const { identity, spawnInput, parent, sessionPath } = options;
		let firstPreparation = options.initialPreparation;
		let record!: AgentRecord;
		const host = AgentRuntimeSupervisor.createChild({
			agentId: identity.agentId,
			startSession: async () => {
				const prepared = firstPreparation ?? await this.#keepSelectionRecorded(
					identity,
					sessionPath,
					await this.prepareOrdinaryRun({
						agentId: identity.agentId,
						parent,
						spawnInput,
						creationPreset: identity.creationPreset,
						sessionPath,
					}),
				);
				firstPreparation = undefined;
				record.effectiveConfiguration = prepared.configuration;
				record.agentTemplateSnapshot = requireAgentTemplateSnapshot(prepared);
				return this.#launchPreparedRuntime(identity, prepared, sessionPath);
			},
		});
		record = {
			identity,
			creationInput: spawnInput,
			...(options.initialPreparation === undefined
				? {}
				: {
					effectiveConfiguration: options.initialPreparation.configuration,
					agentTemplateSnapshot: requireAgentTemplateSnapshot(options.initialPreparation),
				}),
			host,
			transcript: transcriptFromSessionFile(sessionPath),
			children: [],
		};
		return record;
	}

	createModeratorRecord(options: {
		identity: ModeratorIdentity;
		initialPreparation?: PreparedModeratorRuntime;
		sessionPath: string;
	}): AgentRecord {
		const { identity, sessionPath } = options;
		let firstPreparation = options.initialPreparation;
		let record!: AgentRecord;
		const host = AgentRuntimeSupervisor.createChild({
			agentId: identity.agentId,
			startSession: async () => {
				const prepared = firstPreparation ?? await this.#keepSelectionRecorded(
					identity,
					sessionPath,
					await this.prepareModeratorRun({
						agentId: identity.agentId,
						creationPreset: identity.creationPreset,
						sessionPath,
					}),
				);
				firstPreparation = undefined;
				record.launchConfiguration = prepared.configuration;
				const launched = await this.#launchPreparedRuntime(identity, prepared, sessionPath);
				return {
					runtime: launched.runtime,
					ready: launched.ready.then(() => {
						const snapshot = launched.runtime.snapshot();
						record.effectiveConfiguration = {
							...prepared.configuration,
							model: snapshot.model,
							thinking: snapshot.thinking,
						};
					}),
				};
			},
		});
		record = {
			identity,
			...(options.initialPreparation === undefined
				? {}
				: { launchConfiguration: options.initialPreparation.configuration }),
			host,
			transcript: transcriptFromSessionFile(sessionPath),
			children: [],
		};
		return record;
	}

	workflowSessionDirectory(): string {
		return workflowSessionDirectory(
			this.#ownerRuntime.session.sessionManager.getSessionDir(),
			this.#ownerIdentity.workflowId,
		);
	}

	/** Drops cached discovery so the next capture reflects a changed model policy. */
	invalidateTemplateLoads(): void {
		this.#templateLoads.clear();
	}

	agentTemplateSnapshotFor(record: AgentRecord): AgentTemplateCatalogueSnapshot {
		if (!record.agentTemplateSnapshot) {
			throw new Error(
				`invariant_violation: Agent ${record.identity.agentId} has no prepared Agent Template snapshot`,
			);
		}
		return record.agentTemplateSnapshot;
	}

	async captureTemplateSnapshotFor(record: AgentRecord): Promise<AgentTemplateCatalogueSnapshot> {
		const admittedRuntime = record.host.effectiveRuntimeSnapshot();
		const snapshot = admittedRuntime
			? await this.#captureTemplateSnapshotForRuntime(record.identity.agentId, admittedRuntime)
			: await this.#captureTemplateSnapshotForResolvedRuntime(
				record.identity.agentId,
				await this.#resolveCurrentRuntime(record, new Set()),
			);
		record.agentTemplateSnapshot = snapshot;
		return snapshot;
	}

	#captureTemplateSnapshotForResolvedRuntime(
		agentId: string,
		runtime: ResolvedParentRuntime,
	): Promise<AgentTemplateCatalogueSnapshot> {
		return this.#captureTemplateSnapshotForRuntime(agentId, {
			cwd: runtime.configuration.cwd,
			projectTrusted: runtime.projectTrusted,
		});
	}

	async #captureTemplateSnapshotForRuntime(
		agentId: string,
		runtime: Readonly<{
			cwd: string;
			projectTrusted: boolean;
		}>,
	): Promise<AgentTemplateCatalogueSnapshot> {
		return (await this.#loadTemplates(agentId, runtime, true)).snapshot;
	}

	#loadTemplates(
		agentId: string,
		runtime: Readonly<{ cwd: string; projectTrusted: boolean }>,
		refresh = false,
	) {
		const current = this.#templateLoads.get(agentId);
		if (current && !refresh) return current;
		// One load owns both selection and guidance, including missing/invalid names.
		// Cache the in-flight promise as well so concurrent spawns share that load.
		const loading = Promise.all([
			discoverAgentTemplates(this.#resolveTemplateRoots(runtime.cwd, runtime.projectTrusted)),
			this.#refreshVirtualModels(),
		])
			.then(([discovery]) => ({
				discovery,
				snapshot: {
					templates: createAgentTemplateCatalogue(
						discovery.templates.values(),
						(model) => this.#isModelAvailable(model),
					),
				},
			}));
		this.#templateLoads.set(agentId, loading);
		return loading;
	}

	async #prepareOrdinaryRun(
		options: {
			agentId: string;
			parent: AgentRecord;
			spawnInput: AgentSpawnInput | undefined;
			creationPreset?: AgentCreationPreset;
			recorded?: RecordedModelSelection;
		},
		resolving: Set<string>,
		captureTemplates = true,
	): Promise<PreparedOrdinaryChildRuntime> {
		const parentRuntime = await this.#resolveCurrentRuntime(options.parent, resolving);
		if (!options.spawnInput && options.creationPreset === undefined) {
			throw new Error("invariant_violation: Recovered Agent creation preset is unavailable");
		}
		const creationPreset = options.creationPreset === undefined
			? captureAgentCreationPreset(await this.#resolveSelectedTemplate(options.parent.identity.agentId, parentRuntime, options.spawnInput?.template))
			: options.creationPreset;
		const template = creationPreset ?? undefined;
		const preparedRuntime = await prepareChildRuntime({
			agentId: options.agentId,
			role: "ordinary",
			agentDir: this.#ownerRuntime.services.agentDir,
			parentRuntime,
			isModelAvailable: (model) => this.#isModelAvailable(model),
			isModelExcluded: (model) => this.#modelExcluded(model),
			clampThinking: (model, level) => this.#clampThinking(model, level),
			presetThinking: (model) => this.#presetThinking(model),
			...(template === undefined ? {} : { template }),
			...(options.recorded === undefined ? {} : { recorded: options.recorded }),
			// Rejected spawn arguments provide no runtime overrides; the Identity retains its preset.
			...(options.spawnInput?.config === undefined
				? {}
				: { overrides: options.spawnInput.config }),
		});
		// Resolving dormant ancestry does not load a spawning Runtime or refresh its catalogue.
		if (!captureTemplates) return preparedRuntime;
		const prepared: PreparedOrdinaryChildRuntime = {
			...preparedRuntime,
			agentTemplateSnapshot: await this.#captureTemplateSnapshotForRuntime(options.agentId, {
				cwd: preparedRuntime.configuration.cwd,
				projectTrusted: preparedRuntime.projectTrusted,
			}),
		};
		return prepared;
	}

	async #resolveCurrentRuntime(
		record: AgentRecord,
		resolving: Set<string>,
	): Promise<ResolvedParentRuntime> {
		const admittedSnapshot = record.host.effectiveRuntimeSnapshot();
		if (admittedSnapshot) {
			const snapshot = await record.host.synchronizeRuntimeState();
			if (snapshot.sessionId !== record.identity.agentId) {
				throw new Error(
					"invariant_violation: Parent Runtime snapshot does not match Agent Identity",
				);
			}
			return {
				configuration: {
					cwd: snapshot.cwd,
					model: snapshot.model,
					thinking: snapshot.thinking,
					// A descendant keeps its own default tool surface and skill
					// discovery; only the runtime identity is inherited.
					extensions: snapshot.fileExtensionPaths.filter(
						(path) => !this.#isCoordinationExtension(path),
					),
				},
				projectTrusted: snapshot.projectTrusted,
			};
		}
		if (record.identity.agentId === this.#ownerIdentity.agentId) {
			return this.#resolveCurrentOwnerRuntime();
		}
		if (isModeratorIdentity(record.identity)) {
			throw new Error("Moderator cannot be an Agent Spawn parent");
		}
		if (resolving.has(record.identity.agentId)) {
			throw new Error("invariant_violation: Agent Runtime preparation ancestry contains a cycle");
		}
		if (record.identity.directSpawnerAgentId === null) {
			throw new Error("invariant_violation: Child Agent Direct Spawner is unavailable");
		}
		const parent = this.#resolveAgent(record.identity.directSpawnerAgentId);
		if (!parent) {
			throw new Error("invariant_violation: Child Agent Direct Spawner is unavailable");
		}
		resolving.add(record.identity.agentId);
		try {
			// A dormant parent contributes the selection it would resume with. Its
			// session is only read here; its own next Runtime records any fallback.
			const recorded = recordedSelectionAt(record.transcript);
			const prepared = await this.#prepareOrdinaryRun({
				agentId: record.identity.agentId,
				parent,
				spawnInput: record.creationInput,
				creationPreset: record.identity.creationPreset,
				...(recorded === undefined ? {} : { recorded }),
			}, resolving, false);
			return {
				configuration: prepared.configuration,
				projectTrusted: prepared.projectTrusted,
			};
		} finally {
			resolving.delete(record.identity.agentId);
		}
	}

	/**
	 * A fresh Runtime resumes the selection its session records. When that is missing
	 * or no longer usable, preparation fell back to the initial values, which become
	 * the recorded selection before launch.
	 */
	#keepSelectionRecorded<Prepared extends PreparedChildRuntime>(
		identity: ChildAgentIdentity | ModeratorIdentity,
		sessionPath: string,
		prepared: Prepared,
	): Prepared {
		const recorded = recordedSelectionAt(sessionPath);
		const { model, thinking, presetThinking } = prepared.configuration;
		const selection: RecordedModelSelection = {
			model,
			...(thinking === undefined ? {} : { thinking }),
			...(presetThinking ? { presetThinking } : {}),
		};
		if (sameModelSelection(recorded, selection)) return prepared;
		recordModelSelection(SessionManager.open(sessionPath), selection);
		if (recorded !== undefined && modelIdentity(recorded.model) !== modelIdentity(model)) {
			this.#ownerRuntime.session.extensionRunner.getUIContext().notify(
				`${identity.metadata.label} · ${identity.agentId.slice(-8)} cannot resume ${modelIdentity(recorded.model)} (unavailable or excluded by model policy); it now uses ${modelIdentity(model)}.`,
				"warning",
			);
		}
		return prepared;
	}

	#resolveCurrentOwnerRuntime(): ResolvedParentRuntime {
		const session = this.#ownerRuntime.session;
		const model = session.model;
		if (!model) throw new Error("Parent Owner Runtime model is unavailable");
		return {
			configuration: {
				cwd: this.#ownerRuntime.services.cwd,
				model: { provider: model.provider, modelId: model.id },
				thinking: session.thinkingLevel,
				extensions: this.#ownerRuntime.services.resourceLoader
					.getExtensions()
					.extensions.map(({ resolvedPath }) => resolvedPath)
					.filter((path) => !this.#isCoordinationExtension(path)),
			},
			projectTrusted: this.#ownerRuntime.services.settingsManager.isProjectTrusted(),
		};
	}

	async #launchPreparedRuntime(
		identity: ChildAgentIdentity | ModeratorIdentity,
		prepared: PreparedChildRuntime,
		sessionPath: string,
	) {
		if (identity.agentId !== prepared.agentId) {
			throw new Error("invariant_violation: Agent Identity and Runtime preparation differ");
		}
		const identityRole = isModeratorIdentity(identity) ? "moderator" : "ordinary";
		if (identityRole !== prepared.role) {
			throw new Error("invariant_violation: Agent Identity and Runtime preparation roles differ");
		}
		// The low-level launch rechecks even when initial preparation was cached.
		const launch = await PiChildProcessRuntime.launch({
			launchContract: this.#launchContract,
			startupTimeoutMilliseconds: resolveChildStartupTimeoutMilliseconds(),
			workflowId: identity.workflowId,
			agentId: identity.agentId,
			role: prepared.role,
			expectedSessionId: identity.agentId,
			sessionPath,
			configuration: prepared.configuration,
			skillPaths: prepared.skillSources.map(({ path }) => path),
			projectTrusted: prepared.projectTrusted,
			agentDir: this.#ownerRuntime.services.agentDir,
			ownerRequestHandlers: this.#ownerRequestHandlers(
				prepared.role,
				identity.agentId,
			) as StartPiChildProcessRuntimeOptions["ownerRequestHandlers"],
			...(this.#interaction === undefined ? {} : { interaction: this.#interaction }),
		});
		const runtime = new PiChildHostedRuntime({
			link: launch,
			createProjection: () => createPiChildProcessProjection(launch),
			onQuit: (projection) => this.#runtimeQuitSubscriber?.(identity.agentId, projection) === true,
		});
		return { runtime, ready: runtime.ready };
	}

	async #resolveSelectedTemplate(
		agentId: string,
		parentRuntime: ResolvedParentRuntime,
		selectedName: string | undefined,
	): Promise<AgentTemplate | undefined> {
		if (selectedName === undefined) return undefined;
		return selectAgentTemplateForCreation(
			(await this.#loadTemplates(agentId, {
				cwd: parentRuntime.configuration.cwd,
				projectTrusted: parentRuntime.projectTrusted,
			})).discovery,
			selectedName,
		);
	}

	#resolveTemplateRoots(
		parentCwd: string,
		projectTrusted: boolean,
	): readonly AgentTemplateRoot[] {
		return this.#templateRoots
			? this.#templateRoots(parentCwd, projectTrusted)
			: defaultAgentTemplateRoots({
				packageRoot: this.#packageRoot,
				agentDir: this.#ownerRuntime.services.agentDir,
				parentCwd,
				projectTrusted,
			});
	}

	#catalogueModel(model: Readonly<{ provider: string; modelId: string }>) {
		return this.#ownerRuntime.services.modelRuntime.getAvailableSnapshot().find(
			(candidate) => candidate.provider === model.provider && candidate.id === model.modelId,
		);
	}

	async #refreshVirtualModels(): Promise<void> {
		const read = await readWorkflowPolicy(this.#ownerRuntime.services.agentDir);
		this.#virtualModels = read.ok ? read.snapshot.virtualModels : undefined;
	}

	#isModelAvailable(model: Readonly<{ provider: string; modelId: string }>): boolean {
		if (this.#modelExcluded(model)) return false;
		// The child registers Virtual Models from the file itself, so the Owner's
		// catalogue may not list a name added since its last sync. Check the entries
		// now so a spawn fails before Agent Identity instead of at the first request.
		if (isVirtualModel(model)) return this.#firstUsableEntry(model) !== undefined;
		return this.#catalogueModel(model) !== undefined;
	}

	#firstUsableEntry(model: Readonly<{ provider: string; modelId: string }>): VirtualModelEntry | undefined {
		if (this.#virtualModels === undefined || !Object.hasOwn(this.#virtualModels, model.modelId)) return undefined;
		return requireVirtualModelDefinition(this.#virtualModels, model.modelId)
			.find((entry) => this.#isModelAvailable(entry.model));
	}

	/** A preset selection starts on the level of the entry its first request will use. */
	#presetThinking(model: Readonly<{ provider: string; modelId: string }>): RuntimeThinkingLevel {
		const entry = this.#firstUsableEntry(model);
		// Availability already passed for this virtual model, so an entry exists.
		if (entry === undefined) throw new Error(`Virtual model ${model.provider}/${model.modelId} has no usable entry`);
		return entry.thinking;
	}

	#clampThinking(
		model: Readonly<{ provider: string; modelId: string }>,
		level: RuntimeThinkingLevel,
	): RuntimeThinkingLevel {
		const candidate = this.#catalogueModel(model);
		// A model missing from the catalogue leaves the level unresolved: availability
		// already failed for it, and inventing a capability map would hide that.
		return candidate === undefined ? level : clampThinkingToModelCapability(candidate, level);
	}

	#modelExcluded(model: Readonly<{ provider: string; modelId: string }>): boolean {
		return isModelExcluded(this.#modelExclusions?.() ?? [], model);
	}

	#isCoordinationExtension(path: string): boolean {
		return path === this.#entryModulePath ||
			path === INLINE_PUBLIC_EXTENSION_PATH ||
			COORDINATION_EXTENSION_PREFIXES.some((prefix) => path.startsWith(prefix));
	}
}

function recordedSelectionAt(session: string | AgentRecord["transcript"]): RecordedModelSelection | undefined {
	const transcript = typeof session === "string" ? transcriptFromSessionFile(session) : session;
	return readRecordedModelSelection(transcript.inspect().activeBranch);
}

function requireAgentTemplateSnapshot(
	prepared: PreparedOrdinaryChildRuntime,
): AgentTemplateCatalogueSnapshot {
	if (!prepared.agentTemplateSnapshot) {
		throw new Error(
			`invariant_violation: ordinary Agent ${prepared.agentId} has no prepared Agent Template snapshot`,
		);
	}
	return prepared.agentTemplateSnapshot;
}
