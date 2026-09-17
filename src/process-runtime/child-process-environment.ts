import { isAbsolute } from "node:path";

export const CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE =
	"PI_DURABLE_SUBAGENTS_BOOTSTRAP";
export const CHILD_PROCESS_SYSTEM_PROMPT_MODE_ENVIRONMENT_VARIABLE =
	"PI_DURABLE_SUBAGENTS_SYSTEM_PROMPT_MODE";
export const CHILD_PROCESS_SYSTEM_PROMPT_PATH_ENVIRONMENT_VARIABLE =
	"PI_DURABLE_SUBAGENTS_SYSTEM_PROMPT_PATH";
export const CHILD_PROCESS_LOAD_CONTEXT_FILES_ENVIRONMENT_VARIABLE =
	"PI_DURABLE_SUBAGENTS_LOAD_CONTEXT_FILES";

const PHYSICAL_HERDR_OWNERSHIP_VARIABLES = new Set([
	"HERDR_ENV",
	"HERDR_SOCKET_PATH",
	"HERDR_PANE_ID",
]);
const CHILD_RUNTIME_OWNED_VARIABLES = new Set([
	CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_SYSTEM_PROMPT_MODE_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_SYSTEM_PROMPT_PATH_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_LOAD_CONTEXT_FILES_ENVIRONMENT_VARIABLE,
]);

export function buildChildProcessEnvironment(options: {
	ownerEnvironment: NodeJS.ProcessEnv;
	bootstrapPath: string;
	systemPromptMode?: "append" | "replace";
	systemPromptPath?: string;
	loadContextFiles?: boolean;
}): Record<string, string> {
	if (!isAbsolute(options.bootstrapPath) || options.bootstrapPath.includes("\0")) {
		throw new Error("invalid_child_environment: bootstrap path must be absolute");
	}
	const environment = Object.fromEntries(
		Object.entries(options.ownerEnvironment).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined &&
				!PHYSICAL_HERDR_OWNERSHIP_VARIABLES.has(entry[0]) &&
				!CHILD_RUNTIME_OWNED_VARIABLES.has(entry[0]),
		),
	);
	environment[CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE] =
		options.bootstrapPath;
	if (options.systemPromptMode !== undefined) {
		if (options.systemPromptPath === undefined) {
			throw new Error(
				"invalid_child_environment: system prompt mode requires a system prompt path",
			);
		}
		if (!isAbsolute(options.systemPromptPath) || options.systemPromptPath.includes("\0")) {
			throw new Error("invalid_child_environment: system prompt path must be absolute");
		}
		environment[CHILD_PROCESS_SYSTEM_PROMPT_MODE_ENVIRONMENT_VARIABLE] =
			options.systemPromptMode;
		environment[CHILD_PROCESS_SYSTEM_PROMPT_PATH_ENVIRONMENT_VARIABLE] =
			options.systemPromptPath;
	}
	if (options.loadContextFiles !== undefined) {
		environment[CHILD_PROCESS_LOAD_CONTEXT_FILES_ENVIRONMENT_VARIABLE] =
			options.loadContextFiles ? "1" : "0";
	}
	return environment;
}
