import {
	DefaultResourceLoader,
	ProjectTrustStore,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
	InheritableRuntimeConfiguration,
	ModelReference,
} from "../protocol/runtime-configuration.ts";
import {
	resolveAgentRunConfiguration,
	type AgentRunLaunchConfiguration,
	type AgentSpawnConfigurationInput,
	type EffectiveAgentRunConfiguration,
} from "../templates/agent-configuration.ts";
import type {
	AgentTemplate,
	AgentCreationPreset,
	AgentTemplateCatalogueSnapshot,
} from "../templates/agent-templates.ts";

const COORDINATION_TOOLS_BY_ROLE = {
	ordinary: [
		"agent_message",
		"agent_wait",
		"agent_control",
		"agent_observe",
		"agent_spawn",
		"ask_user",
	],
	moderator: [
		"agent_message",
		"agent_wait",
		"agent_control",
		"agent_observe",
		"ask_user",
		"moderator_control",
		"report_to_user",
	],
} as const;
const COORDINATION_TOOL_NAMES = new Set<string>(
	// Owner-only recovery is never part of a child role's startup selection.
	["workflow_resume", ...Object.values(COORDINATION_TOOLS_BY_ROLE).flat()],
);

export type AgentRuntimeRole = "ordinary" | "moderator";

export type ResolvedParentRuntime = Readonly<{
	configuration: InheritableRuntimeConfiguration;
	projectTrusted: boolean;
	skillSources: readonly Readonly<Pick<Skill, "name" | "filePath">>[];
}>;

type PreparedRuntimeFields = Readonly<{
	agentId: string;
	creationPreset: AgentCreationPreset;
	agentTemplateSnapshot?: AgentTemplateCatalogueSnapshot;
	projectTrusted: boolean;
	skillSources: readonly Readonly<{ name: string; path: string }>[];
}>;

export type PreparedOrdinaryChildRuntime = PreparedRuntimeFields & Readonly<{
	role: "ordinary";
	configuration: EffectiveAgentRunConfiguration;
}>;

export type PreparedModeratorRuntime = PreparedRuntimeFields & Readonly<{
	role: "moderator";
	configuration: AgentRunLaunchConfiguration;
}>;

export type PreparedChildRuntime = PreparedOrdinaryChildRuntime | PreparedModeratorRuntime;

type PrepareChildRuntimeOptions = {
	agentId: string;
	role: AgentRuntimeRole;
	agentDir: string;
	parentRuntime: ResolvedParentRuntime;
	template?: Exclude<AgentCreationPreset, null>;
	overrides?: AgentSpawnConfigurationInput;
	isModelAvailable?(model: ModelReference): boolean;
};

export function prepareChildRuntime(
	options: PrepareChildRuntimeOptions & { role: "ordinary" },
): Promise<PreparedOrdinaryChildRuntime>;
export function prepareChildRuntime(
	options: PrepareChildRuntimeOptions & { role: "moderator" },
): Promise<PreparedModeratorRuntime>;
export async function prepareChildRuntime(
	options: PrepareChildRuntimeOptions,
): Promise<PreparedChildRuntime> {
	validateParentSkillSources(options.parentRuntime);
	const inheritedExtensions = inheritsParentExtensions(
		options.template?.extensions,
		options.overrides?.extensions,
	)
		? await canonicalFileExtensions(options.parentRuntime.configuration.extensions)
		: [];
	const resolvedConfiguration = resolveAgentRunConfiguration({
		inherited: {
			...options.parentRuntime.configuration,
			extensions: inheritedExtensions,
		},
		template: options.template,
		overrides: options.overrides,
		requiredTools: [],
		isModelAvailable: options.isModelAvailable ?? (() => true),
	});
	// Pi owns its shared default and model-capability clamp. Keep an absent
	// Moderator selection unresolved until Pi starts instead of copying the Owner.
	const launchConfiguration = usesPiDefaultThinking(options)
		? withoutThinking(resolvedConfiguration)
		: resolvedConfiguration;
	const configuration = {
		...launchConfiguration,
		tools: [
			...launchConfiguration.tools.filter(
				(name) => !COORDINATION_TOOL_NAMES.has(name),
			),
			...COORDINATION_TOOLS_BY_ROLE[options.role],
		],
	};
	await requireDirectory(configuration.cwd);

	const projectTrusted = await resolveProjectTrust({
		parentCwd: options.parentRuntime.configuration.cwd,
		effectiveCwd: configuration.cwd,
		parentProjectTrusted: options.parentRuntime.projectTrusted,
		agentDir: options.agentDir,
	});
	const settingsManager = SettingsManager.create(
		configuration.cwd,
		options.agentDir,
		{ projectTrusted },
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd: configuration.cwd,
		agentDir: options.agentDir,
		settingsManager,
		additionalSkillPaths: options.parentRuntime.skillSources.map(
			({ filePath }) => filePath,
		),
		noContextFiles: true,
		// Extension modules belong to the fresh child process. Runtime preparation
		// resolves paths but never imports or invokes child extension factories.
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	const selectedSkills = resolveSelectedSkills(
		configuration.skills,
		resourceLoader.getSkills(),
	);
	const preparedFields: PreparedRuntimeFields = {
		agentId: options.agentId,
		creationPreset: options.template === undefined ? null : structuredClone(options.template),
		projectTrusted,
		skillSources: selectedSkills.map(({ name, filePath }) => ({
			name,
			path: filePath,
		})),
	};
	if (options.role === "ordinary") {
		return {
			...preparedFields,
			role: "ordinary",
			configuration: requireExplicitThinking(configuration),
		};
	}
	return {
		...preparedFields,
		role: "moderator",
		configuration,
	};
}

function usesPiDefaultThinking(options: Readonly<{
	role: AgentRuntimeRole;
	template?: Exclude<AgentCreationPreset, null>;
	overrides?: AgentSpawnConfigurationInput;
}>): boolean {
	return options.role === "moderator" &&
		options.template?.models === undefined &&
		options.overrides?.model === undefined;
}

function withoutThinking(
	configuration: EffectiveAgentRunConfiguration,
): AgentRunLaunchConfiguration {
	const { thinking: _, ...remaining } = configuration;
	return remaining;
}

function requireExplicitThinking(
	configuration: AgentRunLaunchConfiguration,
): EffectiveAgentRunConfiguration {
	if (configuration.thinking === undefined) {
		throw new Error("invariant_violation: ordinary Agent thinking is unresolved");
	}
	return { ...configuration, thinking: configuration.thinking };
}

function inheritsParentExtensions(
	template: AgentTemplate["extensions"],
	overrides: AgentSpawnConfigurationInput["extensions"],
): boolean {
	if (overrides !== undefined) return overrides === "inherit";
	return template !== "none";
}

function validateParentSkillSources(parentRuntime: ResolvedParentRuntime): void {
	if (
		parentRuntime.skillSources.length !== parentRuntime.configuration.skills.length ||
		parentRuntime.skillSources.some(
			(source, index) => source.name !== parentRuntime.configuration.skills[index],
		)
	) {
		throw new Error("Parent Runtime skill sources do not match its selected skills");
	}
	for (const source of parentRuntime.skillSources) {
		if (!isAbsolute(source.filePath)) {
			throw new Error(`Parent Runtime skill source is not absolute: ${source.name}`);
		}
	}
}

async function canonicalFileExtensions(paths: readonly string[]): Promise<string[]> {
	const canonical: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (!isAbsolute(path)) continue;
		const resolvedPath = await realpath(path);
		if (!(await stat(resolvedPath)).isFile()) {
			throw new Error(`Inherited extension is not file-backed: ${path}`);
		}
		if (seen.has(resolvedPath)) continue;
		seen.add(resolvedPath);
		canonical.push(resolvedPath);
	}
	return canonical;
}

async function requireDirectory(path: string): Promise<void> {
	if (!(await stat(path)).isDirectory()) {
		throw new Error("Configured working directory is not a directory");
	}
}

async function resolveProjectTrust(options: {
	parentCwd: string;
	effectiveCwd: string;
	parentProjectTrusted: boolean;
	agentDir: string;
}): Promise<boolean> {
	const [effectiveCwd, parentCwd] = await Promise.all([
		realpath(options.effectiveCwd),
		realpath(options.parentCwd),
	]);
	if (effectiveCwd === parentCwd) return options.parentProjectTrusted;
	const saved = new ProjectTrustStore(options.agentDir).get(options.effectiveCwd);
	if (saved !== null) return saved;
	const globalSettings = SettingsManager.create(
		options.effectiveCwd,
		options.agentDir,
		{ projectTrusted: false },
	);
	return globalSettings.getDefaultProjectTrust() === "always";
}

function resolveSelectedSkills(
	selectedNames: readonly string[],
	loaded: ReturnType<DefaultResourceLoader["getSkills"]>,
): Skill[] {
	for (const diagnostic of loaded.diagnostics) {
		if (
			diagnostic.type === "collision" &&
			diagnostic.collision?.resourceType === "skill" &&
			selectedNames.includes(diagnostic.collision.name)
		) {
			throw new Error(`Agent skill resource is ambiguous: ${diagnostic.collision.name}`);
		}
	}
	return selectedNames.map((name) => {
		const matching = loaded.skills.filter((skill) => skill.name === name);
		if (matching.length !== 1) {
			throw new Error(`Agent skill resource is unavailable: ${name}`);
		}
		const skill = matching[0]!;
		if (!isAbsolute(skill.filePath)) {
			throw new Error(`Agent skill source is not absolute: ${name}`);
		}
		return skill;
	});
}
