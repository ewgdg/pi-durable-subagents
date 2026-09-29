import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getPackageDir } from "@earendil-works/pi-coding-agent";

import { buildPiChildCliLaunch } from "../src/process-runtime/pi-child-cli-launch.ts";
import { resolveInstalledPiModulePath } from "../src/process-runtime/pi-child-process-runtime.ts";

test("installed Pi module path follows the package-declared public import", () => {
	const packageManifest = JSON.parse(
		readFileSync(join(getPackageDir(), "package.json"), "utf8"),
	) as { exports?: { "."?: { import?: unknown } } };
	const publicImport = packageManifest.exports?.["."]?.import;
	assert.equal(typeof publicImport, "string");
	assert.equal(
		resolveInstalledPiModulePath(),
		join(getPackageDir(), publicImport as string),
	);
});

test("Pi child CLI launch uses the exact session and immutable explicit resources", () => {
	assert.deepEqual(
		buildPiChildCliLaunch({
			piModulePath: "/package/pi/dist/index.js",
			sessionPath: "/sessions/child.jsonl",
			configuration: {
				cwd: "/work/project",
				model: { provider: "anthropic", modelId: "claude-test" },
				thinking: "high",
				excludeTools: ["read", "agent_message", "agent_spawn"],
				excludeSkills: [],
				skills: ["review", "testing"],
				extensions: ["/extensions/first.ts", "/extensions/second.ts"],
				systemPrompt: { mode: "append", body: "Child prompt" },
				loadContextFiles: true,
			},
			skillPaths: ["/skills/review/SKILL.md", "/skills/testing/SKILL.md"],
			bridgeExtensionPath: "/package/src/process-runtime/child-runtime-bridge.ts",
			childEntryPath: "/package/src/process-runtime/pi-child-entry.mjs",
			systemPromptArtifactPath: "/runtime/system-prompt.md",
			projectTrusted: true,
		}),
		{
			command: process.execPath,
			cwd: "/work/project",
			arguments: [
				// The entry runs Pi's public main() with the coordination input tail
				// loaded after every Pi extension, built-ins included.
				"/package/src/process-runtime/pi-child-entry.mjs",
				"/package/pi/dist/index.js",
				"--session", "/sessions/child.jsonl",
				"--model", "anthropic/claude-test",
				"--thinking", "high",
				"--no-extensions",
				// The bridge must bind Control before inherited session_start handlers
				// can synchronously activate child work.
				"--extension", "/package/src/process-runtime/child-runtime-bridge.ts",
				"--extension", "/extensions/first.ts",
				"--extension", "/extensions/second.ts",
				"--no-skills",
				"--skill", "/skills/review/SKILL.md",
				"--skill", "/skills/testing/SKILL.md",
				"--append-system-prompt", "/runtime/system-prompt.md",
				"--approve",
				"--tui-mode", "fullscreen",
			],
		},
	);
});

test("Pi child CLI launch lets Pi select its default thinking when preparation leaves it unset", () => {
	const launch = buildPiChildCliLaunch({
		piModulePath: "/package/pi/dist/index.js",
		sessionPath: "/sessions/moderator.jsonl",
		configuration: {
			cwd: "/work/project",
			model: { provider: "anthropic", modelId: "claude-test" },
			excludeTools: ["moderator_control"],
			excludeSkills: [],
			skills: [],
			extensions: [],
			loadContextFiles: true,
		},
		skillPaths: [],
		bridgeExtensionPath: "/package/src/process-runtime/child-runtime-bridge.ts",
		childEntryPath: "/package/src/process-runtime/pi-child-entry.mjs",
		projectTrusted: true,
	});

	assert.equal(launch.arguments.includes("--thinking"), false);
});

test("Pi child CLI launch fails before spawn when resolved resources are ambiguous", () => {
	const common = {
		piModulePath: "/package/pi/dist/index.js",
		sessionPath: "/sessions/child.jsonl",
		configuration: {
			cwd: "/work/project",
			model: { provider: "anthropic", modelId: "claude-test" },
			thinking: "high" as const,
			excludeTools: ["read"],
			excludeSkills: [],
			skills: ["review"],
			extensions: ["/extensions/first.ts"],
			loadContextFiles: true,
		},
		bridgeExtensionPath: "/package/src/process-runtime/child-runtime-bridge.ts",
		childEntryPath: "/package/src/process-runtime/pi-child-entry.mjs",
		projectTrusted: false,
	};

	assert.throws(
		() => buildPiChildCliLaunch({ ...common, skillPaths: [] }),
		/skill path count/,
	);
	assert.throws(
		() => buildPiChildCliLaunch({
			...common,
			skillPaths: ["/skills/review/SKILL.md"],
			bridgeExtensionPath: "/extensions/first.ts",
		}),
		/bridge extension.*inherited extension/i,
	);
});

test("Pi child CLI launch isolates project context and replaces the base prompt independently", () => {
	const launch = buildPiChildCliLaunch({
		piModulePath: "/package/pi/dist/index.js",
		sessionPath: "/sessions/child.jsonl",
		configuration: {
			cwd: "/work/project",
			model: { provider: "anthropic", modelId: "claude-test" },
			thinking: "high",
			excludeTools: ["read"],
			excludeSkills: [],
			skills: [],
			extensions: [],
			systemPrompt: { mode: "replace", body: "Private prompt" },
			loadContextFiles: false,
		},
		skillPaths: [],
		bridgeExtensionPath: "/package/src/process-runtime/child-runtime-bridge.ts",
		childEntryPath: "/package/src/process-runtime/pi-child-entry.mjs",
		systemPromptArtifactPath: "/runtime/system-prompt.md",
		projectTrusted: false,
	});

	assert.ok(launch.arguments.includes("--no-context-files"));
	assert.deepEqual(
		launch.arguments.slice(-6),
		[
			"--no-context-files",
			"--system-prompt",
			"/runtime/system-prompt.md",
			"--no-approve",
			"--tui-mode",
			"fullscreen",
		],
	);
});

test("Pi child CLI launch can suppress native context without an explicit prompt", () => {
	const launch = buildPiChildCliLaunch({
		piModulePath: "/package/pi/dist/index.js",
		sessionPath: "/sessions/child.jsonl",
		configuration: {
			cwd: "/work/project",
			model: { provider: "anthropic", modelId: "claude-test" },
			thinking: "off",
			excludeTools: [],
			excludeSkills: [],
			skills: [],
			extensions: [],
			loadContextFiles: false,
		},
		skillPaths: [],
		bridgeExtensionPath: "/package/src/process-runtime/child-runtime-bridge.ts",
		childEntryPath: "/package/src/process-runtime/pi-child-entry.mjs",
		projectTrusted: false,
	});

	assert.ok(launch.arguments.includes("--no-context-files"));
	assert.equal(launch.arguments.includes("--append-system-prompt"), false);
	assert.equal(launch.arguments.includes("--system-prompt"), false);
});
