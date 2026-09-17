import assert from "node:assert/strict";
import test from "node:test";

import {
	CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_LOAD_CONTEXT_FILES_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_SYSTEM_PROMPT_MODE_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_SYSTEM_PROMPT_PATH_ENVIRONMENT_VARIABLE,
	buildChildProcessEnvironment,
} from "../src/process-runtime/child-process-environment.ts";

test("child process inherits ordinary runtime configuration without physical Herdr pane ownership", () => {
	const ownerEnvironment: NodeJS.ProcessEnv = {
		HOME: "/home/test",
		PATH: "/bin",
		ANTHROPIC_API_KEY: "provider-secret",
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: "/runtime/herdr.sock",
		HERDR_PANE_ID: "pane-owner",
		UNDEFINED_VALUE: undefined,
	};

	const childEnvironment = buildChildProcessEnvironment({
		ownerEnvironment,
		bootstrapPath: "/runtime/workflow/child-bootstrap.json",
	});

	assert.deepEqual(childEnvironment, {
		HOME: "/home/test",
		PATH: "/bin",
		ANTHROPIC_API_KEY: "provider-secret",
		[CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE]:
			"/runtime/workflow/child-bootstrap.json",
	});
	assert.equal(ownerEnvironment.HERDR_PANE_ID, "pane-owner");
});

test("child process bootstrap path must be absolute", () => {
	assert.throws(
		() => buildChildProcessEnvironment({
			ownerEnvironment: {},
			bootstrapPath: "relative-bootstrap.json",
		}),
		/absolute/,
	);
});

test("child process carries and replaces explicit system-prompt launch metadata", () => {
	const childEnvironment = buildChildProcessEnvironment({
		ownerEnvironment: {
			PI_DURABLE_SUBAGENTS_BOOTSTRAP: "/stale/bootstrap.json",
			PI_DURABLE_SUBAGENTS_SYSTEM_PROMPT_MODE: "replace",
			PI_DURABLE_SUBAGENTS_SYSTEM_PROMPT_PATH: "/stale/prompt.md",
		},
		bootstrapPath: "/runtime/new-bootstrap.json",
		systemPromptMode: "append",
		systemPromptPath: "/runtime/new-prompt.md",
		loadContextFiles: false,
	});

	assert.deepEqual(childEnvironment, {
		[CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE]: "/runtime/new-bootstrap.json",
		[CHILD_PROCESS_SYSTEM_PROMPT_MODE_ENVIRONMENT_VARIABLE]: "append",
		[CHILD_PROCESS_SYSTEM_PROMPT_PATH_ENVIRONMENT_VARIABLE]: "/runtime/new-prompt.md",
		[CHILD_PROCESS_LOAD_CONTEXT_FILES_ENVIRONMENT_VARIABLE]: "0",
	});
});

test("child process system-prompt metadata requires an absolute artifact path", () => {
	assert.throws(
		() => buildChildProcessEnvironment({
			ownerEnvironment: {},
			bootstrapPath: "/runtime/bootstrap.json",
			systemPromptMode: "replace",
		}),
		/mode requires a system prompt path/,
	);
	assert.throws(
		() => buildChildProcessEnvironment({
			ownerEnvironment: {},
			bootstrapPath: "/runtime/bootstrap.json",
			systemPromptMode: "replace",
			systemPromptPath: "prompt.md",
		}),
		/system prompt path must be absolute/,
	);
});
