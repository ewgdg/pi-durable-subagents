import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";

import type {
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";
import { isRuntimeThinkingLevel } from "../protocol/runtime-configuration.ts";
import { isAgentTemplateName } from "./agent-template-name.ts";
import type {
	AgentTemplate,
	SystemPromptMode,
} from "./agent-templates.ts";

const TEMPLATE_FIELDS = new Set([
	"name",
	"useWhen",
	"models",
	"tools",
	"skills",
	"extensions",
	"systemPromptMode",
	"loadContextFiles",
]);

export class AgentTemplateParseError extends Error {
	readonly templateName: string | undefined;

	constructor(sourcePath: string, message: string, templateName?: string) {
		super(`Invalid Agent Template ${sourcePath}: ${message}`);
		this.name = "AgentTemplateParseError";
		this.templateName = templateName;
	}
}

export function parseAgentTemplate(source: string, sourcePath: string): AgentTemplate {
	const split = splitFrontmatter(source, sourcePath);
	const document = parseDocument(split.frontmatter, {
		merge: false,
		schema: "core",
		strict: true,
		uniqueKeys: true,
	});
	const templateName = extractTemplateName(document.contents);
	if (document.errors.length > 0) {
		throw new AgentTemplateParseError(
			sourcePath,
			document.errors[0]?.message ?? "invalid YAML frontmatter",
			templateName,
		);
	}
	if (!isMap(document.contents)) {
		throw new AgentTemplateParseError(
			sourcePath,
			"frontmatter must be one YAML mapping",
			templateName,
		);
	}
	let forbiddenSyntax: string | undefined;
	visit(document, (_key, node) => {
		if (isAlias(node)) {
			forbiddenSyntax = "aliases are not allowed";
			return visit.BREAK;
		}
		if (typeof node === "object" && node !== null && "anchor" in node && node.anchor) {
			forbiddenSyntax = "anchors are not allowed";
			return visit.BREAK;
		}
		if (typeof node === "object" && node !== null && "tag" in node && node.tag) {
			forbiddenSyntax = "explicit and custom YAML tags are not allowed";
			return visit.BREAK;
		}
		return undefined;
	});
	if (forbiddenSyntax) {
		throw new AgentTemplateParseError(sourcePath, forbiddenSyntax, templateName);
	}

	const mapping = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
	for (const key of Object.keys(mapping)) {
		if (!TEMPLATE_FIELDS.has(key)) {
			throw new AgentTemplateParseError(
				sourcePath,
				`unknown frontmatter field ${JSON.stringify(key)}`,
				templateName,
			);
		}
	}
	const name = requireTemplateName(mapping.name, sourcePath);
	const useWhen = mapping.useWhen === undefined
		? undefined
		: parseUseWhen(mapping.useWhen, sourcePath, name);
	const models = mapping.models === undefined
		? undefined
		: parseModelCandidates(mapping.models, sourcePath, name);
	const tools = mapping.tools === undefined
		? undefined
		: parseStringSelection(mapping.tools, "tools", sourcePath, name);
	const skills = mapping.skills === undefined
		? undefined
		: parseStringSelection(mapping.skills, "skills", sourcePath, name);
	const extensions = mapping.extensions === undefined
		? undefined
		: parseExtensions(mapping.extensions, sourcePath, name);
	const systemPromptMode = mapping.systemPromptMode === undefined
		? "append"
		: parseSystemPromptMode(mapping.systemPromptMode, sourcePath, name);
	const loadContextFiles = mapping.loadContextFiles === undefined
		? true
		: parseLoadContextFiles(mapping.loadContextFiles, sourcePath, name);

	return {
		name,
		...(useWhen === undefined ? {} : { useWhen }),
		...(models === undefined ? {} : { models }),
		...(tools === undefined ? {} : { tools }),
		...(skills === undefined ? {} : { skills }),
		...(extensions === undefined ? {} : { extensions }),
		systemPromptMode,
		loadContextFiles,
		systemPrompt: split.body,
		sourcePath,
	};
}

function splitFrontmatter(
	source: string,
	sourcePath: string,
): Readonly<{ frontmatter: string; body: string }> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
	if (!match) {
		throw new AgentTemplateParseError(
			sourcePath,
			"required leading YAML frontmatter is missing or unterminated",
		);
	}
	return {
		frontmatter: match[1] ?? "",
		body: source.slice(match[0].length),
	};
}

function extractTemplateName(contents: unknown): string | undefined {
	if (!isMap(contents)) return undefined;
	const candidates = contents.items.flatMap((pair) => {
		if (!isScalar(pair.key) || pair.key.value !== "name" || !isScalar(pair.value)) {
			return [];
		}
		return isAgentTemplateName(pair.value.value)
			? [pair.value.value]
			: [];
	});
	const distinctCandidates = [...new Set(candidates)];
	return distinctCandidates.length === 1 ? distinctCandidates[0] : undefined;
}

function requireTemplateName(value: unknown, sourcePath: string): string {
	if (!isAgentTemplateName(value)) {
		throw new AgentTemplateParseError(
			sourcePath,
			"name must be lowercase kebab-case",
		);
	}
	return value;
}

function parseUseWhen(
	value: unknown,
	sourcePath: string,
	templateName: string,
): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new AgentTemplateParseError(
			sourcePath,
			"useWhen must be a nonblank string",
			templateName,
		);
	}
	return value.trim();
}

function parseModelCandidates(
	value: unknown,
	sourcePath: string,
	templateName: string,
): AgentTemplate["models"] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new AgentTemplateParseError(
			sourcePath,
			"models must be a nonempty sequence of id/thinking mappings",
			templateName,
		);
	}
	const models = value.map((candidate) => {
		if (
			typeof candidate !== "object" || candidate === null || Array.isArray(candidate) ||
			Object.keys(candidate).some((key) => key !== "id" && key !== "thinking") ||
			!("id" in candidate) || !("thinking" in candidate)
		) {
			throw new AgentTemplateParseError(
				sourcePath,
				"each models entry must contain only id and thinking",
				templateName,
			);
		}
		if (typeof candidate.id !== "string") {
			throw new AgentTemplateParseError(sourcePath, "model id must be provider/model", templateName);
		}
		return {
			model: parseModelReference(candidate.id, sourcePath, templateName),
			thinking: parseThinking(candidate.thinking, sourcePath, templateName),
		};
	});
	const identities = models.map(({ model }) => `${model.provider}\0${model.modelId}`);
	if (new Set(identities).size !== identities.length) {
		throw new AgentTemplateParseError(sourcePath, "models contains a duplicate id", templateName);
	}
	return models;
}

function parseModelReference(
	value: string,
	sourcePath: string,
	templateName: string,
): ModelReference {
	if (typeof value !== "string") {
		throw new AgentTemplateParseError(sourcePath, "model must be provider/model", templateName);
	}
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1 || value.includes("\0")) {
		throw new AgentTemplateParseError(sourcePath, "model must be provider/model", templateName);
	}
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function parseThinking(
	value: unknown,
	sourcePath: string,
	templateName: string,
): RuntimeThinkingLevel {
	if (!isRuntimeThinkingLevel(value)) {
		throw new AgentTemplateParseError(sourcePath, "thinking level is invalid", templateName);
	}
	return value;
}

function parseStringSelection(
	value: unknown,
	field: "tools" | "skills" | "extensions",
	sourcePath: string,
	templateName: string,
): readonly string[] {
	const values = typeof value === "string"
		? value.split(",")
		: isStringSequence(value)
			? value
			: undefined;
	if (!values) {
		throw new AgentTemplateParseError(
			sourcePath,
			`${field} must be a comma-separated string or string sequence`,
			templateName,
		);
	}
	const normalized = values.map((item) => item.trim());
	if (
		normalized.some((item) => item.length === 0 || item.includes("\0")) ||
		new Set(normalized).size !== normalized.length
	) {
		throw new AgentTemplateParseError(
			sourcePath,
			`${field} contains an empty, duplicate, or invalid value`,
			templateName,
		);
	}
	return normalized;
}

function parseExtensions(
	value: unknown,
	sourcePath: string,
	templateName: string,
): "inherit" | "none" {
	if (value === "inherit" || value === "none") return value;
	throw new AgentTemplateParseError(
		sourcePath,
		'extensions must be "inherit" or "none"',
		templateName,
	);
}

function parseSystemPromptMode(
	value: unknown,
	sourcePath: string,
	templateName: string,
): SystemPromptMode {
	if (value !== "append" && value !== "replace") {
		throw new AgentTemplateParseError(
			sourcePath,
			'systemPromptMode must be "append" or "replace"',
			templateName,
		);
	}
	return value;
}

function parseLoadContextFiles(
	value: unknown,
	sourcePath: string,
	templateName: string,
): boolean {
	if (typeof value !== "boolean") {
		throw new AgentTemplateParseError(
			sourcePath,
			"loadContextFiles must be a boolean",
			templateName,
		);
	}
	return value;
}

function isStringSequence(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
