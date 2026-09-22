import { resolve } from "node:path";

import type {
	InheritableRuntimeConfiguration,
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";
import type {
	AgentTemplate,
	AgentCreationPreset,
	SystemPromptMode,
} from "./agent-templates.ts";

export type AgentSpawnConfigurationInput = Readonly<{
	model?: Readonly<{
		id?: string | "inherit";
		thinking?: RuntimeThinkingLevel | "inherit";
	}>;
	cwd?: string;
	excludeTools?: readonly string[];
	excludeSkills?: readonly string[];
	extensions?: "inherit" | "none";
	systemPrompt?: string;
	systemPromptMode?: SystemPromptMode;
	loadContextFiles?: boolean;
}>;

export type EffectiveAgentRunConfiguration = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	excludeTools: readonly string[];
	excludeSkills: readonly string[];
	skills: readonly string[];
	extensions: readonly string[];
	systemPrompt?: Readonly<{
		mode: SystemPromptMode;
		body: string;
	}>;
	loadContextFiles: boolean;
}>;

/** Launch input may delegate thinking selection to Pi while all other values stay explicit. */
export type AgentRunLaunchConfiguration = Readonly<
	Omit<EffectiveAgentRunConfiguration, "thinking"> & {
		thinking?: RuntimeThinkingLevel;
	}
>;

/** Prepared rules before the child-owned skill discovery contributes the loaded set. */
export type ResolvedAgentRunConfiguration = Omit<EffectiveAgentRunConfiguration, "skills">;

export function resolveAgentRunConfiguration(options: {
	inherited: InheritableRuntimeConfiguration;
	template?: Exclude<AgentCreationPreset, null>;
	overrides?: AgentSpawnConfigurationInput;
	isModelAvailable(model: ModelReference): boolean;
	/** Reported separately so a policy exclusion is never blamed on availability. */
	isModelExcluded?(model: ModelReference): boolean;
	/** Pi clamps a level its selected model cannot run; the host resolves that same level. */
	clampThinking?(model: ModelReference, level: RuntimeThinkingLevel): RuntimeThinkingLevel;
}): ResolvedAgentRunConfiguration {
	const { inherited, template, overrides } = options;
	// Exclusions accumulate: a Spawn config restricts further, it does not lift a
	// Template rule. Nothing about the parent's surface is inherited.
	const excludeTools = unique([
		...(template?.excludeTools ?? []),
		...(overrides?.excludeTools ?? []),
	]);
	const excludeSkills = unique([
		...(template?.excludeSkills ?? []),
		...(overrides?.excludeSkills ?? []),
	]);
	const templateExtensions = resolveExtensions(template?.extensions, inherited.extensions);
	const configuredExtensions = resolveExtensions(
		overrides?.extensions,
		templateExtensions,
		inherited.extensions,
	);
	const systemPrompt = resolveSystemPrompt(template, overrides);
	const loadContextFiles = overrides?.loadContextFiles
		?? template?.loadContextFiles
		?? true;
	const explicitlySelectedModel = overrides?.model?.id !== undefined && overrides.model.id !== "inherit"
		? parseModelId(overrides.model.id)
		: undefined;
	if (explicitlySelectedModel && !options.isModelAvailable(explicitlySelectedModel)) {
		const selectedIdentity = `${explicitlySelectedModel.provider}/${explicitlySelectedModel.modelId}`;
		throw new Error(options.isModelExcluded?.(explicitlySelectedModel)
			? `Configured Agent model is excluded by model policy: ${selectedIdentity}`
			: `Configured Agent model is unavailable: ${selectedIdentity}`);
	}
	// A Template candidate is one (model, thinking) pair: its thinking level describes
	// that candidate model, so an explicit model id discards it rather than pairing it
	// with a model the caller chose. The current parent Runtime is then the only
	// remaining default, and such a selection needs no available Template candidate.
	const defaults = overrides?.model?.id === undefined
		? resolveTemplateModelConfiguration(
			inherited,
			template?.models,
			options.isModelAvailable,
			options.isModelExcluded,
		)
		: inherited;
	const modelConfiguration = {
		model: overrides?.model?.id === "inherit"
			? inherited.model
			: explicitlySelectedModel ?? defaults.model,
		thinking: overrides?.model?.thinking === "inherit"
			? inherited.thinking
			: overrides?.model?.thinking ?? defaults.thinking,
	};
	// Template-default and inherited models bypass the explicit-id availability
	// check above. A repair Moderator inherits the Owner model by default, so an
	// Owner exclusion must refuse here rather than silently selecting a banned
	// model for the fresh run.
	if (options.isModelExcluded?.(modelConfiguration.model)) {
		const selectedIdentity = modelConfiguration.model.provider + "/" + modelConfiguration.model.modelId;
		throw new Error("Configured Agent model is excluded by model policy: " + selectedIdentity);
	}
	// The child clamps an unsupported level when it starts, so the launch specification
	// and the recorded configuration must both name the level it will really run.
	const thinking = options.clampThinking?.(modelConfiguration.model, modelConfiguration.thinking)
		?? modelConfiguration.thinking;

	return {
		cwd: resolve(inherited.cwd, overrides?.cwd ?? inherited.cwd),
		model: { ...modelConfiguration.model },
		thinking,
		excludeTools,
		excludeSkills,
		extensions: [...configuredExtensions],
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		loadContextFiles,
	};
}

function parseModelId(id: string): ModelReference {
	const separator = id.indexOf("/");
	return { provider: id.slice(0, separator), modelId: id.slice(separator + 1) };
}

function resolveTemplateModelConfiguration(
	inherited: Readonly<{ model: ModelReference; thinking: RuntimeThinkingLevel }>,
	templateModels: AgentTemplate["models"],
	isModelAvailable: (model: ModelReference) => boolean,
	isModelExcluded: ((model: ModelReference) => boolean) | undefined,
): Readonly<{ model: ModelReference; thinking: RuntimeThinkingLevel }> {
	if (!templateModels) return { model: inherited.model, thinking: inherited.thinking };
	const selected = templateModels.find(({ model }) => isModelAvailable(model));
	if (selected) return selected;
	const identities = templateModels
		.map(({ model }) => `${model.provider}/${model.modelId}`)
		.join(", ");
	throw new Error(templateModels.every(({ model }) => isModelExcluded?.(model) ?? false)
		? `Every configured Agent Template model is excluded by model policy: ${identities}`
		: `No configured Agent Template model is available: ${identities}`);
}

function resolveExtensions(
	selection: "inherit" | "none" | undefined,
	inherited: readonly string[],
	parentExtensions: readonly string[] = inherited,
): readonly string[] {
	if (selection === undefined) return inherited;
	if (selection === "inherit") return parentExtensions;
	return [];
}

function resolveSystemPrompt(
	template: Exclude<AgentCreationPreset, null> | undefined,
	overrides: AgentSpawnConfigurationInput | undefined,
): EffectiveAgentRunConfiguration["systemPrompt"] {
	const templatePrompt = template
		? { mode: template.systemPromptMode, body: template.systemPrompt }
		: undefined;
	if (overrides?.systemPrompt === undefined) {
		if (templatePrompt === undefined || overrides?.systemPromptMode === undefined) {
			return templatePrompt;
		}
		return { ...templatePrompt, mode: overrides.systemPromptMode };
	}
	const next = {
		mode: overrides.systemPromptMode ?? "append",
		body: overrides.systemPrompt,
	} as const;
	if (next.mode === "replace" || templatePrompt === undefined) return next;
	return {
		mode: templatePrompt.mode,
		body: joinContext(templatePrompt.body, next.body),
	};
}

function joinContext(left: string, right: string): string {
	if (left.length === 0) return right;
	if (right.length === 0) return left;
	return `${left}\n\n${right}`;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
