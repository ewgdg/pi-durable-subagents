import { isAbsolute } from "node:path";

import type { AgentRunLaunchConfiguration } from "../templates/agent-configuration.ts";

export type PiChildCliLaunch = Readonly<{
	command: string;
	arguments: readonly string[];
	cwd: string;
}>;

export function buildPiChildCliLaunch(options: {
	cliPath: string;
	sessionPath: string;
	configuration: AgentRunLaunchConfiguration;
	skillPaths: readonly string[];
	bridgeExtensionPath: string;
	inputExtensionPath: string;
	systemPromptArtifactPath?: string;
	projectTrusted: boolean;
}): PiChildCliLaunch {
	const {
		cliPath,
		sessionPath,
		configuration,
		skillPaths,
		bridgeExtensionPath,
		inputExtensionPath,
		systemPromptArtifactPath,
		projectTrusted,
	} = options;
	for (const [field, path] of [
		["Pi CLI", cliPath],
		["session", sessionPath],
		["working directory", configuration.cwd],
		["bridge extension", bridgeExtensionPath],
		["input extension", inputExtensionPath],
		...(systemPromptArtifactPath === undefined
			? []
			: [["System prompt", systemPromptArtifactPath]]),
	] as const) {
		requireAbsolutePath(field, path);
	}
	for (const extensionPath of configuration.extensions) {
		requireAbsolutePath("inherited extension", extensionPath);
	}
	for (const skillPath of skillPaths) requireAbsolutePath("skill", skillPath);
	if (skillPaths.length !== configuration.skills.length) {
		throw new Error(
			`invalid_child_launch: skill path count ${skillPaths.length} does not match selected skill count ${configuration.skills.length}`,
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
	if (configuration.extensions.includes(inputExtensionPath)) {
		throw new Error(
			"invalid_child_launch: input extension must not also be an inherited extension",
		);
	}
	if (inputExtensionPath === bridgeExtensionPath) {
		throw new Error("invalid_child_launch: bridge and input extensions must be distinct");
	}
	if (new Set(configuration.allowedTools).size !== configuration.allowedTools.length) {
		throw new Error("invalid_child_launch: allowed tools contain duplicates");
	}
	for (const toolName of configuration.allowedTools) {
		if (toolName.includes(",")) {
			throw new Error(`invalid_child_launch: tool name cannot contain a comma: ${toolName}`);
		}
	}
	if ((systemPromptArtifactPath === undefined) !== (configuration.systemPrompt === undefined)) {
		throw new Error(
			"invalid_child_launch: system prompt artifact and configuration must agree",
		);
	}

	const argumentsList = [
		cliPath,
		"--session",
		sessionPath,
		"--model",
		`${configuration.model.provider}/${configuration.model.modelId}`,
		...(configuration.thinking === undefined
			? []
			: ["--thinking", configuration.thinking]),
		...(configuration.allowedTools.length === 0
			? ["--no-tools"]
			: ["--tools", configuration.allowedTools.join(",")]),
		"--no-extensions",
		// Control must be connected before inherited session_start handlers run: an
		// inherited extension may synchronously open UI or initiate Agent work.
		"--extension",
		bridgeExtensionPath,
		...configuration.extensions.flatMap((path) => ["--extension", path]),
		// Pi dispatches input by extension load order. Keep Control first while this
		// input-only adapter runs after every inherited transform or rejection.
		"--extension",
		inputExtensionPath,
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
