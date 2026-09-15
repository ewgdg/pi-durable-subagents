import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

import { prepareChildRuntime } from "../src/runtime/child-runtime-preparation.ts";

test("resolves one process-safe ordinary child creation preparation without evaluating inherited extensions", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "child-run-preparation-"));
	const agentDir = join(fixture, "agent");
	const parentCwd = join(fixture, "workspace");
	const effectiveCwd = join(parentCwd, "subproject");
	const inheritedSkillPath = join(fixture, "inherited-review", "SKILL.md");
	const projectSkillPath = join(effectiveCwd, ".pi", "skills", "project-audit", "SKILL.md");
	const extensionPath = join(fixture, "sentinel-extension.ts");
	const extensionAliasPath = join(fixture, "sentinel-extension-alias.ts");
	const moduleSentinelPath = join(fixture, "module-evaluated");
	const factorySentinelPath = join(fixture, "factory-evaluated");

	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(effectiveCwd, { recursive: true }),
		mkdir(join(fixture, "inherited-review"), { recursive: true }),
		mkdir(join(effectiveCwd, ".pi", "skills", "project-audit"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(agentDir, "AGENTS.md"), "Global instructions"),
		writeFile(join(parentCwd, "AGENTS.md"), "Workspace instructions"),
		writeFile(join(effectiveCwd, "CLAUDE.md"), "Subproject instructions"),
		writeFile(
			inheritedSkillPath,
			"---\nname: review\ndescription: Review changes\n---\nReview carefully.\n",
		),
		writeFile(
			projectSkillPath,
			"---\nname: project-audit\ndescription: Audit this project\n---\nAudit locally.\n",
		),
		writeFile(
			extensionPath,
			[
				'import { writeFileSync } from "node:fs";',
				`writeFileSync(${JSON.stringify(moduleSentinelPath)}, "evaluated");`,
				"export default function sentinelExtension() {",
				`\twriteFileSync(${JSON.stringify(factorySentinelPath)}, "evaluated");`,
				"}",
			].join("\n"),
		),
	]);
	await symlink(extensionPath, extensionAliasPath, "file");
	await writeFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify({
			defaultProjectTrust: "never",
			extensions: [extensionPath],
		}, null, 2)}\n`,
	);
	new ProjectTrustStore(agentDir).set(effectiveCwd, true);

	const preparation = await prepareChildRuntime({
		agentId: "ordinary-child",
		role: "ordinary",
		agentDir,
		parentRuntime: {
			configuration: {
				cwd: parentCwd,
				model: { provider: "parent", modelId: "parent-model" },
				thinking: "low",
				tools: ["bash"],
				skills: ["review"],
				extensions: ["<inline:parent-factory>", extensionAliasPath, extensionPath],
			},
			projectTrusted: false,
			skillSources: [{ name: "review", filePath: inheritedSkillPath }],
		},
		template: {
			models: [{
				model: { provider: "template", modelId: "template-model" },
				thinking: "medium",
			}],
			tools: ["grep"],
			skills: ["review", "project-audit"],
			extensions: "inherit",
			systemPromptMode: "append",
			loadContextFiles: true,
			systemPrompt: "Template instructions",
		},
		overrides: {
			cwd: "subproject",
			model: { id: "template/template-model", thinking: "high" },
			tools: ["read", "extension_tool"],
			extensions: "inherit",
			systemPrompt: "Spawn instructions",
			systemPromptMode: "append",
		},
	});

	assert.deepEqual(preparation, {
		creationPreset: {
			models: [{ model: { provider: "template", modelId: "template-model" }, thinking: "medium" }],
			tools: ["grep"], skills: ["review", "project-audit"], extensions: "inherit",
			systemPromptMode: "append", loadContextFiles: true, systemPrompt: "Template instructions",
		},
		agentId: "ordinary-child",
		role: "ordinary",
		configuration: {
			cwd: effectiveCwd,
			model: { provider: "template", modelId: "template-model" },
			thinking: "high",
			tools: [
				"read",
				"extension_tool",
				"agent_message",
				"agent_wait",
				"agent_control",
				"agent_observe",
				"agent_spawn",
				"ask_user",
			],
			skills: ["review", "project-audit"],
			extensions: [extensionPath],
			systemPrompt: {
				mode: "append",
				body: "Template instructions\n\nSpawn instructions",
			},
			loadContextFiles: true,
		},
		projectTrusted: true,
		skillSources: [
			{ name: "review", path: inheritedSkillPath },
			{ name: "project-audit", path: projectSkillPath },
		],
	});
	await assert.rejects(access(moduleSentinelPath), { code: "ENOENT" });
	await assert.rejects(access(factorySentinelPath), { code: "ENOENT" });
});

test("extensions none does not inspect or carry inherited extension paths", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "child-run-no-extensions-"));
	const agentDir = join(fixture, "agent");
	const cwd = join(fixture, "workspace");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(cwd, { recursive: true }),
	]);

	const preparation = await prepareChildRuntime({
		agentId: "extension-free-child",
		role: "ordinary",
		agentDir,
		parentRuntime: {
			configuration: {
				cwd,
				model: { provider: "test", modelId: "model" },
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [join(fixture, "missing-parent-extension.ts")],
			},
			projectTrusted: true,
			skillSources: [],
		},
		overrides: { extensions: "none" },
	});

	assert.deepEqual(preparation.configuration.extensions, []);
});

test("uses current parent trust for the same cwd and saved or global trust for a new cwd", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "child-run-trust-"));
	const agentDir = join(fixture, "agent");
	const parentCwd = join(fixture, "workspace");
	const parentCwdAlias = join(fixture, "workspace-alias");
	const newCwd = join(fixture, "other-workspace");
	const extensionPath = join(fixture, "must-not-load.ts");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(parentCwd, { recursive: true }),
		mkdir(newCwd, { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(parentCwd, "AGENTS.md"), "Ordinary context to replace"),
		writeFile(extensionPath, 'throw new Error("extension was evaluated");\n'),
	]);
	await symlink(parentCwd, parentCwdAlias, "dir");
	await writeFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify({
			defaultProjectTrust: "always",
			extensions: [extensionPath],
		}, null, 2)}\n`,
	);
	new ProjectTrustStore(agentDir).set(parentCwd, true);
	const parentRuntime = {
		configuration: {
			cwd: parentCwd,
			model: { provider: "parent", modelId: "model" },
			thinking: "minimal" as const,
			tools: ["read"],
			skills: [],
			extensions: [],
		},
		projectTrusted: false,
		skillSources: [],
	};

	const sameCwd = await prepareChildRuntime({
		agentId: "moderator-child",
		role: "moderator",
		agentDir,
		parentRuntime,
		template: {
			extensions: "none",
			systemPromptMode: "replace",
			loadContextFiles: false,
			systemPrompt: "Moderator-only context",
		},
	});
	assert.equal(sameCwd.projectTrusted, false);
	assert.deepEqual(sameCwd.configuration, {
		cwd: parentCwd,
		model: { provider: "parent", modelId: "model" },
		tools: [
			"read",
			"agent_message",
			"agent_wait",
			"agent_control",
			"agent_observe",
			"ask_user",
			"moderator_control",
			"report_to_user",
		],
		skills: [],
		extensions: [],
		systemPrompt: { mode: "replace", body: "Moderator-only context" },
		loadContextFiles: false,
	});

	const explicitlyConfiguredModerator = await prepareChildRuntime({
		agentId: "configured-moderator-child",
		role: "moderator",
		agentDir,
		parentRuntime,
		template: {
			models: [{
				model: { provider: "parent", modelId: "model" },
				thinking: "high",
			}],
			systemPromptMode: "append",
			loadContextFiles: true,
			systemPrompt: "",
		},
	});
	assert.equal(explicitlyConfiguredModerator.configuration.thinking, "high");

	const callerConfiguredModerator = await prepareChildRuntime({
		agentId: "caller-configured-moderator-child",
		role: "moderator",
		agentDir,
		parentRuntime,
		overrides: {
			model: { id: "inherit", thinking: "low" },
		},
	});
	assert.equal(callerConfiguredModerator.configuration.thinking, "low");

	const sameCwdAlias = await prepareChildRuntime({
		agentId: "ordinary-same-cwd-alias",
		role: "ordinary",
		agentDir,
		parentRuntime,
		overrides: { cwd: parentCwdAlias, extensions: "none" },
	});
	assert.equal(sameCwdAlias.projectTrusted, false);

	const newCwdPreparation = await prepareChildRuntime({
		agentId: "ordinary-new-cwd",
		role: "ordinary",
		agentDir,
		parentRuntime,
		overrides: { cwd: newCwd, extensions: "none" },
	});
	assert.equal(newCwdPreparation.projectTrusted, true);
});

test("each role normalizes Owner coordination tools and preserves empty optional selections", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "child-run-empty-tools-"));
	for (const role of ["ordinary", "moderator"] as const) {
		for (const overrides of [undefined, { tools: [] }]) {
			const options = {
				agentId: `${role}-empty-tools`, agentDir: cwd,
				parentRuntime: {
					configuration: {
						cwd, model: { provider: "test", modelId: "model" }, thinking: "off" as const,
						tools: ["read", "workflow_resume"], skills: [], extensions: [],
					},
					projectTrusted: true, skillSources: [],
				},
				overrides,
			};
			const preparation = await (role === "ordinary"
				? prepareChildRuntime({ ...options, role })
				: prepareChildRuntime({ ...options, role }));
			assert.deepEqual(preparation.configuration.tools, [
				...(overrides === undefined ? ["read"] : []),
				...(role === "ordinary"
					? ["agent_message", "agent_wait", "agent_control", "agent_observe", "agent_spawn", "ask_user"]
					: ["agent_message", "agent_wait", "agent_control", "agent_observe", "ask_user", "moderator_control", "report_to_user"]),
			]);
		}
	}
});

test("replaces inherited or configured coordination tools with the exact child role set", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "child-run-role-tools-"));
	const agentDir = join(fixture, "agent");
	const cwd = join(fixture, "workspace");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(cwd, { recursive: true }),
	]);
	const preparation = await prepareChildRuntime({
		agentId: "ordinary-role-tools",
		role: "ordinary",
		agentDir,
		parentRuntime: {
			configuration: {
				cwd,
				model: { provider: "test", modelId: "model" },
				thinking: "off",
				tools: ["bash", "agent_spawn", "moderator_control", "report_to_user"],
				skills: [],
				extensions: [],
			},
			projectTrusted: true,
			skillSources: [],
		},
		overrides: {
			tools: ["read", "moderator_control", "agent_message"],
		},
	});

	assert.deepEqual(preparation.configuration.tools, [
		"read",
		"agent_message",
		"agent_wait",
		"agent_control",
		"agent_observe",
		"agent_spawn",
		"ask_user",
	]);
});
