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
		].join("\n"))
		.join("\n");
	return [
		"## Available Agent Templates Snapshot",
		"Use `agent_spawn.template` when a Template fits the task. `agent_spawn.config` overrides the selected Template's configuration.",
		...(templates.length === 0 ? ["None."] : [templates]),
	].join("\n\n");
}
