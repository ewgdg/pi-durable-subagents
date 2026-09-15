import type {
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";

export type SystemPromptMode = "append" | "replace";

export type AgentTemplateModelCandidate = Readonly<{
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
}>;

/** Agent-owned rules; no discovery metadata or resolved parent configuration. */
export type AgentCreationPreset = Omit<AgentTemplate, "name" | "useWhen" | "sourcePath"> | null;

export function captureAgentCreationPreset(template: AgentTemplate | undefined): AgentCreationPreset {
	if (!template) return null;
	const { name: _, useWhen: __, sourcePath: ___, ...rules } = template;
	return structuredClone(rules);
}

export type AgentTemplate = Readonly<{
	name: string;
	useWhen?: string;
	models?: readonly AgentTemplateModelCandidate[];
	tools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	systemPromptMode: SystemPromptMode;
	loadContextFiles: boolean;
	systemPrompt: string;
	sourcePath: string;
}>;

/** Selection metadata safe to expose to a spawning Agent. */
export type AgentTemplateCatalogueEntry = Readonly<{
	name: string;
	useWhen?: string;
	models?: readonly AgentTemplateModelCandidate[];
	tools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	systemPromptMode: SystemPromptMode;
	loadContextFiles: boolean;
}>;

export type AgentTemplateCatalogueSnapshot = Readonly<{
	templates: readonly AgentTemplateCatalogueEntry[];
}>;

export type AgentTemplateRoot = Readonly<{
	scope: string;
	path: string;
}>;

export type AgentTemplateDiagnostic = Readonly<{
	scope: string;
	path: string;
	message: string;
	templateName?: string;
}>;

export type UnavailableAgentTemplate = Readonly<{
	reason: "invalid" | "ambiguous";
	scope: string;
	paths: readonly string[];
}>;

export type AgentTemplateDiscovery = Readonly<{
	templates: ReadonlyMap<string, AgentTemplate>;
	unavailable: ReadonlyMap<string, UnavailableAgentTemplate>;
	diagnostics: readonly AgentTemplateDiagnostic[];
}>;

export function selectAgentTemplateForCreation(
	discovery: AgentTemplateDiscovery,
	selectedName: string,
): AgentTemplate | undefined {
	const unavailable = discovery.unavailable.get(selectedName);
	if (unavailable) {
		throw new Error(`Selected Agent Template ${selectedName} is ${unavailable.reason}`);
	}
	const template = discovery.templates.get(selectedName);
	if (template) return template;
	if (selectedName === "moderator") return undefined;
	throw new Error(`Selected Agent Template ${selectedName} is missing`);
}

export function createAgentTemplateCatalogue(
	templates: Iterable<AgentTemplate>,
	isModelAvailable: (model: ModelReference) => boolean = () => true,
): AgentTemplateCatalogueEntry[] {
	return [...templates]
		.filter(({ name }) => name !== "moderator")
		.sort((left, right) => left.name.localeCompare(right.name))
		.flatMap((template) => {
			const models = template.models?.filter(({ model }) => isModelAvailable(model));
			if (template.models !== undefined && models?.length === 0) return [];
			return [{
				name: template.name,
				...(template.useWhen === undefined
					? {}
					: { useWhen: template.useWhen }),
				...(models === undefined ? {} : { models }),
				...(template.tools === undefined ? {} : { tools: template.tools }),
				...(template.skills === undefined ? {} : { skills: template.skills }),
				...(template.extensions === undefined ? {} : { extensions: template.extensions }),
				systemPromptMode: template.systemPromptMode,
				loadContextFiles: template.loadContextFiles,
			}];
		});
}
