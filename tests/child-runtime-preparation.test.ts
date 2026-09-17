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
				extensions: ["<inline:parent-factory>", extensionAliasPath, extensionPath],
			},
			projectTrusted: false,
		},
		template: {
			models: [{
				model: { provider: "template", modelId: "template-model" },
				thinking: "medium",
			}],
			excludeTools: ["grep"],
			excludeSkills: ["review"],
			extensions: "inherit",
			systemPromptMode: "append",
			loadContextFiles: true,
			systemPrompt: "Template instructions",
		},
		overrides: {
			cwd: "subproject",
			model: { id: "template/template-model", thinking: "high" },
			excludeTools: ["read", "extension_tool"],
			extensions: "inherit",
			systemPrompt: "Spawn instructions",
			systemPromptMode: "append",
		},
	});

	// The child discovers skills for its own cwd and agent directory, so this
	// environment's global skills are legitimately part of its surface. The stable
	// claims are that the locally written project skill is discovered and that the
	// parent's selected `review` skill is not inherited.
	const { skills: discoveredSkills, ...configuration } = preparation.configuration;
	const { skillSources: discoveredSkillSources, ...rest } = preparation;
	assert.deepEqual({ ...rest, configuration }, {
		creationPreset: {
			models: [{ model: { provider: "template", modelId: "template-model" }, thinking: "medium" }],
			excludeTools: ["grep"], excludeSkills: ["review"], extensions: "inherit",
			systemPromptMode: "append", loadContextFiles: true, systemPrompt: "Template instructions",
		},
		agentId: "ordinary-child",
		role: "ordinary",
		configuration: {
			cwd: effectiveCwd,
			model: { provider: "template", modelId: "template-model" },
			thinking: "high",
			// Template rules plus Spawn exclusions accumulate; nothing is inherited
			// from the parent surface.
			excludeTools: ["grep", "read", "extension_tool"],
			excludeSkills: ["review"],
			extensions: [extensionPath],
			systemPrompt: {
				mode: "append",
				body: "Template instructions\n\nSpawn instructions",
			},
			loadContextFiles: true,
		},
		projectTrusted: true,
	});
	assert.ok(discoveredSkills.includes("project-audit"));
	assert.equal(discoveredSkills.includes("review"), false);
	assert.equal(discoveredSkillSources.some(({ name }) => name === "review"), false);
	assert.deepEqual(
		discoveredSkillSources.find(({ name }) => name === "project-audit"),
		{ name: "project-audit", path: projectSkillPath },
	);
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
				extensions: [join(fixture, "missing-parent-extension.ts")],
			},
			projectTrusted: true,
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
			extensions: [],
		},
		projectTrusted: false,
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
	// The child owns its skill discovery, so this comparison ignores the discovered
	// names and pins the exclusion rules plus the trust-derived identity.
	const { skills: sameCwdSkills, ...sameCwdConfiguration } = sameCwd.configuration;
	assert.deepEqual(sameCwdConfiguration, {
		cwd: parentCwd,
		model: { provider: "parent", modelId: "model" },
		excludeTools: [],
		excludeSkills: [],
		extensions: [],
		systemPrompt: { mode: "replace", body: "Moderator-only context" },
		loadContextFiles: false,
	});
	assert.ok(sameCwdSkills.every((name) => typeof name === "string" && name.length > 0));

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

test("accumulates Template and Spawn exclusions without inheriting the parent surface", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "child-run-exclusions-"));
	for (const role of ["ordinary", "moderator"] as const) {
		const options = {
			agentId: `${role}-exclusions`, agentDir: cwd,
			parentRuntime: {
				configuration: {
					cwd, model: { provider: "test", modelId: "model" }, thinking: "off" as const,
					extensions: [],
				},
				projectTrusted: true,
			},
			template: {
				excludeTools: ["bash"],
				excludeSkills: ["research"],
				systemPromptMode: "append" as const,
				loadContextFiles: true,
				systemPrompt: "",
			},
			overrides: { excludeTools: ["read", "bash"] },
		};
		const preparation = await (role === "ordinary"
			? prepareChildRuntime({ ...options, role })
			: prepareChildRuntime({ ...options, role }));
		// A Spawn restriction adds to the Template rule instead of replacing it, and
		// the parent surface contributes nothing.
		assert.deepEqual(preparation.configuration.excludeTools, ["bash", "read"]);
		assert.deepEqual(preparation.configuration.excludeSkills, ["research"]);
	}
});
