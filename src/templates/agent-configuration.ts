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
	tools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	systemPrompt?: string;
	systemPromptMode?: SystemPromptMode;
	loadContextFiles?: boolean;
}>;

export type EffectiveAgentRunConfiguration = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	tools: readonly string[];
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

export function resolveAgentRunConfiguration(options: {
	inherited: InheritableRuntimeConfiguration;
	template?: Exclude<AgentCreationPreset, null>;
	overrides?: AgentSpawnConfigurationInput;
	requiredTools: readonly string[];
	isModelAvailable(model: ModelReference): boolean;
}): EffectiveAgentRunConfiguration {
	const { inherited, template, overrides } = options;
	const selectedTools = overrides?.tools
		?? template?.tools
		?? inherited.tools;
	const configuredSkills = overrides?.skills ?? template?.skills ?? inherited.skills;
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
		throw new Error(
			`Configured Agent model is unavailable: ${explicitlySelectedModel.provider}/${explicitlySelectedModel.modelId}`,
		);
	}
	// Do not require available Template candidates when both fields are explicitly selected.
	const defaults = overrides?.model?.id === undefined || overrides.model.thinking === undefined
		? resolveTemplateModelConfiguration(inherited, template?.models, options.isModelAvailable)
		: inherited;
	const modelConfiguration = {
		model: overrides?.model?.id === "inherit"
			? inherited.model
			: explicitlySelectedModel ?? defaults.model,
		thinking: overrides?.model?.thinking === "inherit"
			? inherited.thinking
			: overrides?.model?.thinking ?? defaults.thinking,
	};

	return {
		cwd: resolve(inherited.cwd, overrides?.cwd ?? inherited.cwd),
		model: { ...modelConfiguration.model },
		thinking: modelConfiguration.thinking,
		tools: unique([...selectedTools, ...options.requiredTools]),
		skills: [...configuredSkills],
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
): Readonly<{ model: ModelReference; thinking: RuntimeThinkingLevel }> {
	if (!templateModels) return { model: inherited.model, thinking: inherited.thinking };
	const selected = templateModels.find(({ model }) => isModelAvailable(model));
	if (selected) return selected;
	throw new Error(
		`No configured Agent Template model is available: ${templateModels.map(({ model }) => `${model.provider}/${model.modelId}`).join(", ")}`,
	);
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
