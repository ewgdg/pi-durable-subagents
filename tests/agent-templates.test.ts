import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverAgentTemplates } from "../src/templates/agent-template-discovery.ts";
import { parseAgentTemplate } from "../src/templates/agent-template-parser.ts";
import { validateAgentCreationPreset } from "../src/protocol/agent-creation-preset.ts";
import {
	createAgentTemplateCatalogue,
	selectAgentTemplateForCreation,
} from "../src/templates/agent-templates.ts";
import { type AgentSpawnConfigurationInput, resolveAgentRunConfiguration } from "../src/templates/agent-configuration.ts";
import {
	resolveModeratorAgentMetadata,
	resolveOrdinaryAgentMetadata,
	resolveOwnerAgentMetadata,
} from "../src/protocol/agent-metadata.ts";

test("parses the complete strict Agent Template surface", () => {
	const template = parseAgentTemplate(
		[
			"---",
			"name: research-agent",
			"useWhen: Use for primary-source research.",
			"models:",
			"  - id: coordination-test/deterministic-child",
			"    thinking: high",
			"excludeTools: read, grep",
			"excludeSkills:",
			"  - research",
			"extensions: none",
			"systemPromptMode: replace",
			"loadContextFiles: false",
			"---",
			"Use primary sources.",
		].join("\n"),
		"/templates/research-agent.md",
	);

	assert.deepEqual(template, {
		name: "research-agent",
		useWhen: "Use for primary-source research.",
		models: [{
			model: { provider: "coordination-test", modelId: "deterministic-child" },
			thinking: "high",
		}],
		excludeTools: ["read", "grep"],
		excludeSkills: ["research"],
		extensions: "none",
		systemPromptMode: "replace",
		loadContextFiles: false,
		systemPrompt: "Use primary sources.",
		sourcePath: "/templates/research-agent.md",
	});
});

test("rejects removed Template capability fields, including the replaced selection", () => {
	for (const field of [
		"use-when: Use for research.",
		"allowed-tools: read",
		"allowedTools: read",
		"tools: []\nallowedTools: read",
		"tools: read, grep",
		"skills:\n  - research",
	]) {
		assert.throws(
			() => parseAgentTemplate(
				`---\nname: research-agent\n${field}\n---\n`,
				"/templates/research-agent.md",
			),
			/unknown frontmatter field/,
		);
	}
});

test("captured creation presets carry exclusion rules and reject the replaced selection", () => {
	const preset = {
		excludeTools: ["bash"],
		excludeSkills: ["research"],
		systemPromptMode: "append",
		loadContextFiles: true,
		systemPrompt: "",
	};
	assert.deepEqual(validateAgentCreationPreset(preset), preset);
	assert.throws(() => validateAgentCreationPreset({ ...preset, allowedTools: ["read"] }), /invalid shape/);
	assert.throws(() => validateAgentCreationPreset({ ...preset, tools: ["read"] }), /invalid shape/);
});

test("rejects the removed aggregate Project Context field and invalid context-file values", () => {
	assert.throws(
		() => parseAgentTemplate(
			"---\nname: research-agent\nproject-context: replace\n---\n",
			"/templates/research-agent.md",
		),
		/unknown frontmatter field/,
	);
	assert.throws(
		() => parseAgentTemplate(
			"---\nname: research-agent\nloadContextFiles: yes\n---\n",
			"/templates/research-agent.md",
		),
		/loadContextFiles must be a boolean/,
	);
});

test("rejects extension path arrays outside the Agent Template contract", () => {
	assert.throws(
		() => parseAgentTemplate(
			"---\nname: research-agent\nuseWhen: Use for research.\nextensions:\n  - /extensions/arbitrary.ts\n---\n",
			"/templates/research-agent.md",
		),
		/extensions must be "inherit" or "none"/,
	);
});

test("allows absent useWhen guidance but rejects a blank value", () => {
	assert.deepEqual(
		parseAgentTemplate(
			"---\nname: research-agent\n---\n",
			"/templates/research-agent.md",
		),
		{
			name: "research-agent",
			systemPromptMode: "append",
			loadContextFiles: true,
			systemPrompt: "",
			sourcePath: "/templates/research-agent.md",
		},
	);
	assert.throws(
		() => parseAgentTemplate(
			"---\nname: research-agent\nuseWhen: '   '\n---\n",
			"/templates/research-agent.md",
		),
		/useWhen must be a nonblank string/,
	);
});

test("parses ordered model and thinking fallback candidates", () => {
	const template = parseAgentTemplate(
		[
			"---",
			"name: cheap-delegate",
			"models:",
			"  - id: codex-lb/gpt-5.6-luna",
			"    thinking: max",
			"  - id: deepseek/deepseek-v4-flash",
			"    thinking: high",
			"---",
		].join("\n"),
		"/templates/cheap-delegate.md",
	);

	assert.deepEqual(template.models, [
		{ model: { provider: "codex-lb", modelId: "gpt-5.6-luna" }, thinking: "max" },
		{ model: { provider: "deepseek", modelId: "deepseek-v4-flash" }, thinking: "high" },
	]);
});

test("rejects top-level Template model and thinking fields", () => {
	for (const field of ["model: provider/model", "thinking: high"]) {
		assert.throws(
			() => parseAgentTemplate(
				`---\nname: invalid-agent\n${field}\n---\n`,
				"/templates/invalid-agent.md",
			),
			/unknown frontmatter field/,
		);
	}
});

test("rejects YAML capabilities, coercion, and fields outside the Agent Template contract", () => {
	const invalidTemplates = [
		"---\nname: research-agent\ndescription: forbidden\n---\n",
		"---\nname: research-agent\nexcludeTools: read\nexcludeTools: grep\n---\n",
		"---\nname: research-agent\nexcludeTools: &tools [read]\nexcludeSkills: *tools\n---\n",
		"---\nname: research-agent\nexcludeTools: !selected read\n---\n",
		"---\nname: research-agent\nexcludeTools: true\n---\n",
		"name: research-agent\n",
	];
	for (const [index, source] of invalidTemplates.entries()) {
		assert.throws(
			() => parseAgentTemplate(source, `/templates/invalid-${index}.md`),
			/Invalid Agent Template/,
		);
	}
});

test("discovers whole templates by strict precedence while safely following symlinks", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "agent-template-discovery-"));
	const packageRoot = join(fixture, "package");
	const projectRoot = join(fixture, "project");
	await mkdir(join(packageRoot, "nested"), { recursive: true });
	await mkdir(projectRoot, { recursive: true });
	await writeFile(
		join(packageRoot, "nested", "research.md"),
		"---\nname: research-agent\nuseWhen: Use for research.\nexcludeTools: read, grep\n---\nPackage context",
	);
	await writeFile(
		join(packageRoot, "blocked.md"),
		"---\nname: blocked-agent\nuseWhen: Use when blocked.\n---\n",
	);
	await writeFile(
		join(packageRoot, "duplicate-name.md"),
		"---\nname: duplicate-name-agent\nuseWhen: Use for duplicate checks.\n---\n",
	);
	await writeFile(
		join(projectRoot, "research.md"),
		"---\nname: research-agent\nuseWhen: Use for research.\nmodels:\n  - id: research/model\n    thinking: high\n---\nProject context",
	);
	await writeFile(
		join(projectRoot, "blocked.md"),
		"---\nname: blocked-agent\nuseWhen: Use when blocked.\ncwd: elsewhere\n---\n",
	);
	await writeFile(
		join(projectRoot, "duplicate-a.md"),
		"---\nname: duplicate-agent\nuseWhen: Use for duplicates.\n---\n",
	);
	await writeFile(
		join(projectRoot, "duplicate-b.md"),
		"---\nname: duplicate-agent\nuseWhen: Use for duplicates.\n---\n",
	);
	await writeFile(
		join(projectRoot, "duplicate-name.md"),
		"---\nname: duplicate-name-agent\nname: duplicate-name-agent\n---\n",
	);
	const invalidUtf8Path = join(projectRoot, "invalid-utf8.md");
	await writeFile(invalidUtf8Path, Uint8Array.from([0xff, 0xfe]));
	const brokenSymlinkPath = join(projectRoot, "broken.md");
	await symlink(join(projectRoot, "missing.md"), brokenSymlinkPath, "file");
	await symlink(
		join(projectRoot, "research.md"),
		join(projectRoot, "zz-research-alias.md"),
		"file",
	);
	await symlink(packageRoot, join(packageRoot, "nested", "cycle"), "dir");

	const discovery = await discoverAgentTemplates([
		{ scope: "package", path: packageRoot },
		{ scope: "project", path: projectRoot },
	]);

	assert.deepEqual(discovery.templates.get("research-agent"), {
		name: "research-agent",
		useWhen: "Use for research.",
		models: [{
			model: { provider: "research", modelId: "model" },
			thinking: "high",
		}],
		systemPromptMode: "append",
		loadContextFiles: true,
		systemPrompt: "Project context",
		sourcePath: join(projectRoot, "research.md"),
	});
	assert.equal(discovery.templates.has("blocked-agent"), false);
	assert.equal(discovery.unavailable.get("blocked-agent")?.reason, "invalid");
	assert.equal(discovery.templates.has("duplicate-agent"), false);
	assert.equal(discovery.unavailable.get("duplicate-agent")?.reason, "ambiguous");
	assert.equal(discovery.templates.has("duplicate-name-agent"), false);
	assert.equal(discovery.unavailable.get("duplicate-name-agent")?.reason, "invalid");
	assert.ok(discovery.diagnostics.some(({ path }) => path === invalidUtf8Path));
	assert.ok(discovery.diagnostics.some(({ path }) => path === brokenSymlinkPath));
	assert.deepEqual(
		createAgentTemplateCatalogue(discovery.templates.values()).map(({ name }) => name),
		["research-agent"],
	);
});

test("resolves current inherited Runtime values, preset rules, and accumulated Spawn exclusions in order", () => {
	const configuration = resolveAgentRunConfiguration({
		inherited: {
			cwd: "/baseline/project",
			model: { provider: "base", modelId: "model" },
			thinking: "low",
			extensions: ["/extensions/base.ts"],
		},
		template: {
			models: [
				{ model: { provider: "missing", modelId: "model" }, thinking: "low" },
				{ model: { provider: "template", modelId: "model" }, thinking: "medium" },
			],
			excludeTools: ["bash"],
			excludeSkills: ["research"],
			systemPromptMode: "replace",
			loadContextFiles: false,
			systemPrompt: "Template context",
		},
		overrides: {
			cwd: "subproject",
			excludeTools: ["bash", "read"],
			excludeSkills: ["testing"],
			extensions: "inherit",
			systemPrompt: "Spawn context",
			systemPromptMode: "append",
		},
		isModelAvailable: ({ provider }) => provider === "template",
	});

	assert.deepEqual(configuration, {
		cwd: "/baseline/project/subproject",
		model: { provider: "template", modelId: "model" },
		thinking: "medium",
		// Spawn exclusions add to the Template rule rather than replacing it, and the
		// inherited parent surface contributes nothing to either list.
		excludeTools: ["bash", "read"],
		excludeSkills: ["research", "testing"],
		extensions: ["/extensions/base.ts"],
		systemPrompt: {
			mode: "replace",
			body: "Template context\n\nSpawn context",
		},
		loadContextFiles: false,
	});
});

test("fails when no configured Template model is available", () => {
	assert.throws(
		() => resolveAgentRunConfiguration({
			inherited: {
				cwd: "/project",
				model: { provider: "base", modelId: "model" },
				thinking: "low",
				extensions: [],
			},
			template: {
				models: [
					{ model: { provider: "missing-a", modelId: "model" }, thinking: "low" },
					{ model: { provider: "missing-b", modelId: "model" }, thinking: "high" },
				],
				systemPromptMode: "append",
				loadContextFiles: true,
				systemPrompt: "",
			},
			isModelAvailable: () => false,
		}),
		/No configured Agent Template model is available: missing-a\/model, missing-b\/model/,
	);
});

test("fully specified spawn model override bypasses unavailable Template candidates", () => {
	const inherited = {
		cwd: "/project",
		model: { provider: "parent", modelId: "model" },
		thinking: "low" as const,
		extensions: [],
	};
	const template = {
		name: "fallback-agent",
		models: [{
			model: { provider: "missing", modelId: "model" },
			thinking: "high" as const,
		}],
		systemPromptMode: "append" as const,
		loadContextFiles: true,
		systemPrompt: "",
	};
	const base = {
		inherited,
		template,
		isModelAvailable: ({ provider }: { provider: string }) => provider === "explicit",
	};

	assert.deepEqual(resolveAgentRunConfiguration({
		...base,
		overrides: {
			model: {
				id: "explicit/model",
				thinking: "inherit",
			},
		},
	}), {
		...inherited,
		excludeTools: [],
		excludeSkills: [],
		model: { provider: "explicit", modelId: "model" },
		systemPrompt: { mode: "append", body: "" },
		loadContextFiles: true,
	});
	assert.deepEqual(resolveAgentRunConfiguration({
		...base,
		overrides: { model: { id: "inherit", thinking: "max" } },
	}), {
		...inherited,
		excludeTools: [],
		excludeSkills: [],
		thinking: "max",
		systemPrompt: { mode: "append", body: "" },
		loadContextFiles: true,
	});
});

test("creates a public Template catalogue without system-prompt bodies or source paths", () => {
	assert.deepEqual(createAgentTemplateCatalogue([
		{
			name: "research-agent",
			useWhen: "Use for research.",
			models: [{
				model: { provider: "research", modelId: "model" },
				thinking: "high",
			}],
			systemPromptMode: "replace",
			loadContextFiles: false,
			systemPrompt: "Private child instructions.",
			sourcePath: "/private/research-agent.md",
		},
		{
			name: "moderator",
			useWhen: "Reserved for moderation.",
			systemPromptMode: "append",
			loadContextFiles: true,
			systemPrompt: "Private moderator instructions.",
			sourcePath: "/private/moderator.md",
		},
		{
			name: "plain-agent",
			systemPromptMode: "append",
			loadContextFiles: true,
			systemPrompt: "Private plain instructions.",
			sourcePath: "/private/plain-agent.md",
		},
	]), [{
		name: "plain-agent",
		systemPromptMode: "append",
		loadContextFiles: true,
	}, {
		name: "research-agent",
		useWhen: "Use for research.",
		models: [{
			model: { provider: "research", modelId: "model" },
			thinking: "high",
		}],
		systemPromptMode: "replace",
		loadContextFiles: false,
	}]);
});

test("catalogue hides unavailable candidates and Templates without one available candidate", () => {
	const catalogue = createAgentTemplateCatalogue([
		{
			name: "partly-available",
			models: [
				{ model: { provider: "missing", modelId: "model" }, thinking: "low" },
				{ model: { provider: "available", modelId: "model" }, thinking: "high" },
			],
			systemPromptMode: "append",
			loadContextFiles: true,
			systemPrompt: "",
			sourcePath: "/templates/partly-available.md",
		},
		{
			name: "unavailable",
			models: [
				{ model: { provider: "missing", modelId: "other" }, thinking: "max" },
			],
			systemPromptMode: "append",
			loadContextFiles: true,
			systemPrompt: "",
			sourcePath: "/templates/unavailable.md",
		},
	], ({ provider }) => provider === "available");

	assert.deepEqual(catalogue, [{
		name: "partly-available",
		models: [{
			model: { provider: "available", modelId: "model" },
			thinking: "high",
		}],
		systemPromptMode: "append",
		loadContextFiles: true,
	}]);
});

test("resolves normalized ordinary Agent metadata without inheriting or weakening explicit values", () => {
	assert.deepEqual(
		resolveOrdinaryAgentMetadata({
			explicitLabel: "  研究 agent  ",
			explicitDescription: "  Primary-source research  ",
			templateName: "template-label",
		}),
		{
			label: "研究 agent",
			description: "Primary-source research",
		},
	);
	assert.deepEqual(resolveOrdinaryAgentMetadata({ templateName: "template-label" }), {
		label: "template-label",
	});
	assert.deepEqual(resolveOrdinaryAgentMetadata({}), { label: "agent" });
	assert.throws(
		() => resolveOrdinaryAgentMetadata({ explicitLabel: "  ", templateName: "fallback" }),
		/Agent label must not be empty/,
	);
	assert.throws(
		() => resolveOrdinaryAgentMetadata({ explicitLabel: "🙂".repeat(65) }),
		/exceeds 64 Unicode code points/,
	);
	assert.throws(
		() => resolveOrdinaryAgentMetadata({ explicitLabel: "research\u2028agent" }),
		/line breaks or control characters/,
	);
});

test("resolves fixed Owner and Moderator role metadata", () => {
	assert.deepEqual(resolveOwnerAgentMetadata(), {
		label: "Owner",
		description: "Workflow Owner",
	});
	assert.deepEqual(resolveModeratorAgentMetadata("run_failure"), {
		label: "Moderator",
		description: "Incident: run failure",
	});
	assert.deepEqual(resolveModeratorAgentMetadata("obligation_stall"), {
		label: "Moderator",
		description: "Incident: obligation stall",
	});
	assert.deepEqual(resolveModeratorAgentMetadata("dependency_deadlock"), {
		label: "Moderator",
		description: "Incident: dependency deadlock",
	});
	assert.deepEqual(resolveModeratorAgentMetadata("operation_review"), {
		label: "Moderator",
		description: "Incident: operation review",
	});
});

test("permits only the missing reserved Moderator Template", () => {

	const discovery = {
		templates: new Map(),
		unavailable: new Map(),
		diagnostics: [],
	};
	assert.equal(selectAgentTemplateForCreation(discovery, "moderator"), undefined);
	assert.throws(
		() => selectAgentTemplateForCreation(discovery, "missing-agent"),
		/Selected Agent Template missing-agent is missing/,
	);
});

test("model fields independently use Template defaults or explicit parent inheritance", () => {
	const inherited = {
		cwd: "/project",
		model: { provider: "parent", modelId: "model" },
		thinking: "low" as const,
		extensions: [],
	};
	const template = {
		models: [
			{ model: { provider: "missing", modelId: "model" }, thinking: "off" as const },
			{ model: { provider: "template", modelId: "model" }, thinking: "high" as const },
		],
		systemPromptMode: "append" as const, loadContextFiles: true, systemPrompt: "",
	};
	const cases: Array<[AgentSpawnConfigurationInput["model"], string, string, string]> = [
		[undefined, "template", "high", "low"],
		[{}, "template", "high", "low"],
		[{ thinking: "max" }, "template", "max", "max"],
		[{ id: "explicit/model" }, "explicit", "high", "low"],
		[{ id: "inherit" }, "parent", "high", "low"],
		[{ thinking: "inherit" }, "template", "low", "low"],
		[{ id: "inherit", thinking: "inherit" }, "parent", "low", "low"],
	];
	for (const [model, provider, thinking, parentThinking] of cases) {
		for (const selectedTemplate of [template, undefined]) {
			const actual = resolveAgentRunConfiguration({
				inherited, template: selectedTemplate, overrides: { model },
				isModelAvailable: ({ provider }) => provider !== "missing",
			});
			assert.deepEqual(actual.model, {
				provider: selectedTemplate || provider === "explicit" ? provider : "parent",
				modelId: "model",
			});
			assert.equal(actual.thinking, selectedTemplate ? thinking : parentThinking);
		}
	}
});

test("Template candidates are resolved only when a model field needs defaults", () => {
	const base = {
		inherited: {
			cwd: "/project", model: { provider: "parent", modelId: "model" },
			thinking: "low" as const, extensions: [],
		},
		template: {
			models: [{ model: { provider: "missing", modelId: "model" }, thinking: "high" as const }],
			systemPromptMode: "append" as const, loadContextFiles: true, systemPrompt: "",
		},
	};
	for (const model of [
		{ id: "explicit/model", thinking: "max" },
		{ id: "inherit", thinking: "inherit" },
	] as const) {
		const checked: string[] = [];
		const actual = resolveAgentRunConfiguration({
			...base, overrides: { model },
			isModelAvailable: ({ provider }) => { checked.push(provider); return provider === "explicit"; },
		});
		assert.equal(actual.thinking, model.thinking === "inherit" ? "low" : "max");
		assert.deepEqual(checked, model.id === "inherit" ? [] : ["explicit"]);
	}
	for (const model of [{}, { id: "explicit/model" }, { thinking: "max" }] as const) {
		assert.throws(() => resolveAgentRunConfiguration({
			...base, overrides: { model }, isModelAvailable: ({ provider }) => provider === "explicit",
		}), /No configured Agent Template model is available/);
	}
});

test("an excluded model is refused with the policy as its cause", () => {
	const inherited = {
		cwd: "/project",
		model: { provider: "parent", modelId: "model" },
		thinking: "low" as const,
		extensions: [],
	};
	assert.throws(() => resolveAgentRunConfiguration({
		inherited,
		overrides: { model: { id: "openai-codex/gpt-6-astra" } },
		isModelAvailable: () => false,
		isModelExcluded: () => true,
	}), /excluded by model policy/);

	const fallback = resolveAgentRunConfiguration({
		inherited,
		template: {
			models: [
				{ model: { provider: "openai-codex", modelId: "gpt-6-astra" }, thinking: "high" as const },
				{ model: { provider: "deepseek", modelId: "deepseek-v4-flash" }, thinking: "low" as const },
			],
			systemPromptMode: "append" as const,
			loadContextFiles: true,
			systemPrompt: "",
		},
		isModelAvailable: ({ provider }) => provider !== "openai-codex",
		isModelExcluded: ({ provider }) => provider === "openai-codex",
	});
	assert.deepEqual(fallback.model, { provider: "deepseek", modelId: "deepseek-v4-flash" });
	assert.equal(fallback.thinking, "low");
});

test("model exclusion never applies to an inherited parent model", () => {
	const inherited = {
		cwd: "/project",
		model: { provider: "openai-codex", modelId: "gpt-6-astra" },
		thinking: "low" as const,
		extensions: [],
	};
	const excluded = {
		isModelAvailable: () => true,
		isModelExcluded: () => true,
	};
	assert.deepEqual(
		resolveAgentRunConfiguration({ inherited, ...excluded }).model,
		inherited.model,
	);
	assert.deepEqual(resolveAgentRunConfiguration({
		inherited,
		overrides: { model: { id: "inherit", thinking: "inherit" } },
		...excluded,
	}).model, inherited.model);
	assert.deepEqual(resolveAgentRunConfiguration({
		inherited,
		template: {
			systemPromptMode: "append" as const,
			loadContextFiles: true,
			systemPrompt: "",
		},
		...excluded,
	}).model, inherited.model);
});

test("a Template whose candidates are all excluded names the model policy", () => {
	const inherited = {
		cwd: "/project",
		model: { provider: "parent", modelId: "model" },
		thinking: "low" as const,
		extensions: [],
	};
	assert.throws(() => resolveAgentRunConfiguration({
		inherited,
		template: {
			models: [
				{ model: { provider: "openai-codex", modelId: "gpt-6-astra" }, thinking: "high" as const },
				{ model: { provider: "deepseek", modelId: "deepseek-v4-flash" }, thinking: "low" as const },
			],
			systemPromptMode: "append" as const,
			loadContextFiles: true,
			systemPrompt: "",
		},
		isModelAvailable: () => false,
		isModelExcluded: () => true,
	}), /excluded by model policy/);
});
