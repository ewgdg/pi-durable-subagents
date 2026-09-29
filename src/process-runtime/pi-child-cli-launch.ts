import { isAbsolute } from "node:path";

import type { AgentRunLaunchConfiguration } from "../templates/agent-configuration.ts";
import { isBuiltinExtensionPath } from "../pi-integration/builtin-extension-paths.ts";

export type PiChildCliLaunch = Readonly<{
	command: string;
	arguments: readonly string[];
	cwd: string;
}>;

export function buildPiChildCliLaunch(options: {
	piModulePath: string;
	sessionPath: string;
	configuration: AgentRunLaunchConfiguration;
	skillPaths: readonly string[];
	bridgeExtensionPath: string;
	childEntryPath: string;
	systemPromptArtifactPath?: string;
	projectTrusted: boolean;
}): PiChildCliLaunch {
	const {
		piModulePath,
		sessionPath,
		configuration,
		skillPaths,
		bridgeExtensionPath,
		childEntryPath,
		systemPromptArtifactPath,
		projectTrusted,
	} = options;
	for (const [field, path] of [
		["Pi module", piModulePath],
		["child entry", childEntryPath],
		["session", sessionPath],
		["working directory", configuration.cwd],
		["bridge extension", bridgeExtensionPath],
		...(systemPromptArtifactPath === undefined
			? []
			: [["System prompt", systemPromptArtifactPath]]),
	] as const) {
		requireAbsolutePath(field, path);
	}
	for (const extensionPath of configuration.extensions) {
		if (!isBuiltinExtensionPath(extensionPath)) {
			requireAbsolutePath("inherited extension", extensionPath);
		}
	}
	for (const skillPath of skillPaths) requireAbsolutePath("skill", skillPath);
	if (skillPaths.length !== configuration.skills.length) {
		throw new Error(
			`invalid_child_launch: skill path count ${skillPaths.length} does not match resolved skill count ${configuration.skills.length}`,
		);
	}
	if (new Set(skillPaths).size !== skillPaths.length) {
		throw new Error("invalid_child_launch: resolved skill paths contain duplicates");
	}
	if (new Set(configuration.extensions).size !== configuration.extensions.length) {
		throw new Error("invalid_child_launch: inherited extension paths contain duplicates");
	}
	if (configuration.extensions.includes(bridgeExtensionPath)) {
		throw new Error(
			"invalid_child_launch: bridge extension must not also be an inherited extension",
		);
	}
	if ((systemPromptArtifactPath === undefined) !== (configuration.systemPrompt === undefined)) {
		throw new Error(
			"invalid_child_launch: system prompt artifact and configuration must agree",
		);
	}

	const argumentsList = [
		// The entry runs Pi's public main() with the coordination input tail as an
		// inline extension, which Pi loads after every path extension, built-ins included.
		childEntryPath,
		piModulePath,
		"--session",
		sessionPath,
		"--model",
		`${configuration.model.provider}/${configuration.model.modelId}`,
		...(configuration.thinking === undefined
			? []
			: ["--thinking", configuration.thinking]),
		// Pi's --tools/--no-tools filter its tool registry permanently. The bridge
		// applies the bootstrap selection with setActiveTools before inherited startup.
		"--no-extensions",
		// Control must be connected before inherited session_start handlers run: an
		// inherited extension may synchronously open UI or initiate Agent work.
		"--extension",
		bridgeExtensionPath,
		...configuration.extensions.flatMap((path) => ["--extension", path]),
		"--no-skills",
		...skillPaths.flatMap((path) => ["--skill", path]),
		...(configuration.loadContextFiles ? [] : ["--no-context-files"]),
		...(systemPromptArtifactPath === undefined
			? []
			: [
				configuration.systemPrompt?.mode === "replace"
					? "--system-prompt"
					: "--append-system-prompt",
				systemPromptArtifactPath,
			]),
		projectTrusted ? "--approve" : "--no-approve",
		"--tui-mode",
		"fullscreen",
	];

	return {
		command: process.execPath,
		arguments: argumentsList,
		cwd: configuration.cwd,
	};
}

function requireAbsolutePath(field: string, path: string): void {
	if (!isAbsolute(path) || path.includes("\0")) {
		throw new Error(`invalid_child_launch: ${field} path must be absolute`);
	}
}
