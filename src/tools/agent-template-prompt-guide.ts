import type {
	AgentTemplateCatalogueSnapshot,
} from "../templates/agent-templates.ts";

export function renderAgentTemplatePromptGuide(
	snapshot: AgentTemplateCatalogueSnapshot,
): string {
	const templates = [...snapshot.templates]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((template) => [
			`- name: ${template.name}`,
			...(template.useWhen === undefined
				? []
				: [`  useWhen: ${JSON.stringify(template.useWhen)}`]),
			...(template.models?.[0] === undefined
				? []
				: [
					`  model: ${template.models[0].model.provider}/${template.models[0].model.modelId}`,
					`  thinking: ${template.models[0].thinking}`,
				]),
			...(template.tools === undefined
				? []
				: [`  tools: ${JSON.stringify(template.tools)}`]),
			...(template.skills === undefined ? [] : [`  skills: ${JSON.stringify(template.skills)}`]),
			...(template.extensions === undefined
				? []
				: [`  extensions: ${template.extensions}`]),
			`  systemPromptMode: ${template.systemPromptMode}`,
			`  loadContextFiles: ${template.loadContextFiles}`,
		].join("\n"))
		.join("\n");
	return [
		"## Available Agent Templates Snapshot",
		"Use `agent_spawn.template` when a Template fits the task. `agent_spawn.config` overrides the listed Template configuration.",
		"`loadContextFiles` controls native loading of trusted project instruction files such as `AGENTS.md` and `CLAUDE.md`; it does not inherit the parent conversation.",
		...(templates.length === 0 ? ["None."] : [templates]),
	].join("\n\n");
}
