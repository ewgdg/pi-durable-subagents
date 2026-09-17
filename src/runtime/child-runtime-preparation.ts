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
	type ResolvedAgentRunConfiguration,
} from "../templates/agent-configuration.ts";
import type {
	AgentTemplate,
	AgentCreationPreset,
	AgentTemplateCatalogueSnapshot,
} from "../templates/agent-templates.ts";

export type AgentRuntimeRole = "ordinary" | "moderator";

export type ResolvedParentRuntime = Readonly<{
	configuration: InheritableRuntimeConfiguration;
	projectTrusted: boolean;
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
	isModelExcluded?(model: ModelReference): boolean;
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
		isModelAvailable: options.isModelAvailable ?? (() => true),
		...(options.isModelExcluded === undefined ? {} : { isModelExcluded: options.isModelExcluded }),
	});
	// Pi owns its shared default and model-capability clamp. Keep an absent
	// Moderator selection unresolved until Pi starts instead of copying the Owner.
	const launchConfiguration = usesPiDefaultThinking(options)
		? withoutThinking(resolvedConfiguration)
		: resolvedConfiguration;
	const effectiveCwd = launchConfiguration.cwd;
	await requireDirectory(effectiveCwd);

	const projectTrusted = await resolveProjectTrust({
		parentCwd: options.parentRuntime.configuration.cwd,
		effectiveCwd,
		parentProjectTrusted: options.parentRuntime.projectTrusted,
		agentDir: options.agentDir,
	});
	const settingsManager = SettingsManager.create(
		effectiveCwd,
		options.agentDir,
		{ projectTrusted },
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd: effectiveCwd,
		agentDir: options.agentDir,
		settingsManager,
		noContextFiles: true,
		// Extension modules belong to the fresh child process. Runtime preparation
		// resolves paths but never imports or invokes child extension factories.
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	// A child loads the skills discovered for its own working directory and agent
	// directory; the filter only removes names from that discovery, so a name that
	// is absent changes nothing.
	const selectedSkills = resolveLoadedSkills(
		resourceLoader.getSkills().skills,
		new Set(launchConfiguration.excludeSkills),
	);
	const configuration: AgentRunLaunchConfiguration = {
		...launchConfiguration,
		skills: selectedSkills.map(({ name }) => name),
	};
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
	configuration: ResolvedAgentRunConfiguration,
): Omit<ResolvedAgentRunConfiguration, "thinking"> {
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

function resolveLoadedSkills(
	loaded: readonly Skill[],
	excludedNames: ReadonlySet<string>,
): readonly Skill[] {
	const selected = loaded.filter(({ name }) => !excludedNames.has(name));
	for (const skill of selected) {
		// The launch pins exact paths, so Pi would silently drop a relative one.
		if (!isAbsolute(skill.filePath)) {
			throw new Error(`Agent skill source is not absolute: ${skill.name}`);
		}
	}
	return selected;
}
