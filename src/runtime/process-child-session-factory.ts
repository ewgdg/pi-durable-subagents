import {
	type AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";

import { ChildLaunchContractGuard } from "../process-runtime/child-launch-contract.ts";

import type { AgentRecord } from "../coordination/agent-record.ts";
import { admitControlTransportPlatform } from "../control/control-platform.ts";
import { transcriptFromSessionFile } from "../pi-integration/session-manager-transcript.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import {
	isModeratorIdentity,
	type ModeratorIdentity,
} from "../protocol/moderator-input.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	PiChildHostedRuntime,
} from "../process-runtime/pi-child-hosted-runtime.ts";
import {
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

const COORDINATION_EXTENSION_PREFIXES = [
	"<inline:pi-agent-coordination-agent:",
	"<inline:pi-agent-coordination-moderator:",
	"<inline:pi-agent-coordination-activity:",
] as const;
const INLINE_PUBLIC_EXTENSION_PATH = "<inline:pi-agent-coordination>";

type ParticipantHandlers =
	| OwnerParticipantRequestHandlers<"ordinary">
	| OwnerParticipantRequestHandlers<"moderator">;

/** Launches every non-Owner Runtime in a fresh Pi process. */
export class ProcessChildSessionFactory {
	readonly #ownerRuntime: AgentSessionRuntime;
	readonly #launchContract: ChildLaunchContractGuard;
	readonly #onRuntimeQuit: ((agentId: string, projection: HostedAgentProjection) => boolean) | undefined;
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
	readonly #ownerRequestHandlers: (
		role: AgentRuntimeRole,
		agentId: string,
	) => ParticipantHandlers;

	constructor(options: {
		ownerRuntime: AgentSessionRuntime;
		onLaunchBlocked?(error: Error): void;
		onRuntimeQuit?(agentId: string, projection: HostedAgentProjection): boolean;
		ownerIdentity: OwnerIdentity;
		entryModulePath: string;
		packageRoot?: string;
		templateRoots?(
			parentCwd: string,
			projectTrusted: boolean,
		): readonly AgentTemplateRoot[];
		resolveAgent(agentId: string): AgentRecord | undefined;
		ownerRequestHandlers(
			role: AgentRuntimeRole,
			agentId: string,
		): ParticipantHandlers;
	}) {
		this.#ownerRuntime = options.ownerRuntime;
		this.#launchContract = new ChildLaunchContractGuard(undefined, options.onLaunchBlocked);
		this.#onRuntimeQuit = options.onRuntimeQuit;
		this.#ownerIdentity = options.ownerIdentity;
		this.#entryModulePath = options.entryModulePath;
		this.#packageRoot = options.packageRoot ?? resolve(dirname(options.entryModulePath), "..");
		this.#templateRoots = options.templateRoots;
		this.#resolveAgent = options.resolveAgent;
		this.#ownerRequestHandlers = options.ownerRequestHandlers;
	}

	admitProcessRuntimePlatform(): void {
		admitControlTransportPlatform();
	}

	/**
	 * Fresh Runtimes resolve current parent inheritance and Pi resources against
	 * Agent-owned creation rules. A resolved launch configuration is never recovery input.
	 */
	async prepareOrdinaryRun(options: {
		agentId: string;
		parent: AgentRecord;
		spawnInput: AgentSpawnInput | undefined;
		creationPreset?: AgentCreationPreset;
	}): Promise<PreparedOrdinaryChildRuntime> {
		await this.#launchContract.assertCompatible();
		return this.#prepareOrdinaryRun(options, new Set());
	}

	async prepareModeratorRun(options: {
		agentId: string;
		creationPreset?: AgentCreationPreset;
	}): Promise<PreparedModeratorRuntime> {
		await this.#launchContract.assertCompatible();
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
			...(template === undefined ? {} : { template }),
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
				const prepared = firstPreparation ?? await this.prepareOrdinaryRun({
					agentId: identity.agentId,
					parent,
					spawnInput,
					creationPreset: identity.creationPreset,
				});
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
				const prepared = firstPreparation ?? await this.prepareModeratorRun({
					agentId: identity.agentId,
					creationPreset: identity.creationPreset,
				});
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
		const loading = discoverAgentTemplates(this.#resolveTemplateRoots(runtime.cwd, runtime.projectTrusted))
			.then((discovery) => ({
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
			...(template === undefined ? {} : { template }),
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
					// Native activation changes also apply to descendant inheritance.
					tools: [...snapshot.tools],
					skills: [...snapshot.skills],
					extensions: snapshot.fileExtensionPaths.filter(
						(path) => !this.#isCoordinationExtension(path),
					),
				},
				projectTrusted: snapshot.projectTrusted,
				skillSources: snapshot.skillSources.map(({ name, filePath }) => ({
					name,
					filePath,
				})),
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
			const prepared = await this.#prepareOrdinaryRun({
				agentId: record.identity.agentId,
				parent,
				spawnInput: record.creationInput,
				creationPreset: record.identity.creationPreset,
			}, resolving, false);
			return {
				configuration: prepared.configuration,
				projectTrusted: prepared.projectTrusted,
				skillSources: prepared.skillSources.map(({ name, path }) => ({
					name,
					filePath: path,
				})),
			};
		} finally {
			resolving.delete(record.identity.agentId);
		}
	}

	#resolveCurrentOwnerRuntime(): ResolvedParentRuntime {
		const session = this.#ownerRuntime.session;
		const model = session.model;
		if (!model) throw new Error("Parent Owner Runtime model is unavailable");
		const skills = this.#ownerRuntime.services.resourceLoader.getSkills().skills;
		return {
			configuration: {
				cwd: this.#ownerRuntime.services.cwd,
				model: { provider: model.provider, modelId: model.id },
				thinking: session.thinkingLevel,
				tools: [...session.getActiveToolNames()],
				skills: skills.map(({ name }) => name),
				extensions: this.#ownerRuntime.services.resourceLoader
					.getExtensions()
					.extensions.map(({ resolvedPath }) => resolvedPath)
					.filter((path) => !this.#isCoordinationExtension(path)),
			},
			projectTrusted: this.#ownerRuntime.services.settingsManager.isProjectTrusted(),
			skillSources: skills.map(({ name, filePath }) => ({ name, filePath })),
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
		});
		const runtime = new PiChildHostedRuntime(
			launch,
			(projection) => this.#onRuntimeQuit?.(identity.agentId, projection) === true,
		);
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

	#isModelAvailable(model: Readonly<{ provider: string; modelId: string }>): boolean {
		return this.#ownerRuntime.services.modelRuntime.getAvailableSnapshot().some(
			(candidate) => candidate.provider === model.provider && candidate.id === model.modelId,
		);
	}

	#isCoordinationExtension(path: string): boolean {
		return path === this.#entryModulePath ||
			path === INLINE_PUBLIC_EXTENSION_PATH ||
			COORDINATION_EXTENSION_PREFIXES.some((prefix) => path.startsWith(prefix));
	}
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
