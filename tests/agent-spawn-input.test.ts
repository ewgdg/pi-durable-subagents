import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import { participantCoordinationToolSchemas } from "../src/tools/participant-coordination-tools.ts";

import { validateAgentSpawnInput } from "../src/protocol/agent-spawn-input.ts";

test("Agent Spawn rejects every removed conversation field", () => {
	for (const conversation of ["fork", "copy", null, undefined]) {
		const input = { title: "Fixture request", request: "Use isolated context.", conversation };
		assert.throws(() => validateAgentSpawnInput(input), /conversation.*no longer supported/);
		assert.equal(Check(participantCoordinationToolSchemas.agent_spawn, input), false);
	}
});

test("isolated spawning accepts default, Template and explicit configuration", () => {
	for (const configuration of [{}, { template: "reviewer" }, { config: { tools: ["read"] } }, { template: "reviewer", config: { tools: ["read"] } }]) {
		const input = { title: "Fixture request", request: "Use supplied context.", ...configuration };
		assert.deepEqual(validateAgentSpawnInput(input), input);
		assert.equal(Check(participantCoordinationToolSchemas.agent_spawn, input), true);
	}
});

test("Agent Spawn accepts tools as the initial selection and rejects obsolete fields", () => {
	assert.deepEqual(validateAgentSpawnInput({
		title: "Fixture request",
		request: "Inspect the child Runtime.",
		config: { tools: ["read", "extension_tool"] },
	}), {
		title: "Fixture request",
		request: "Inspect the child Runtime.",
		config: { tools: ["read", "extension_tool"] },
	});
	for (const config of [
		{ allowedTools: ["read"] },
		{ allowedTools: undefined },
		{ tools: [], allowedTools: ["read"] },
		{ allowed_tools: ["read"] },
	]) {
		assert.equal(Check(participantCoordinationToolSchemas.agent_spawn, {
			title: "Fixture request", request: "Reject obsolete fields.", config,
		}), false);
		assert.throws(
			() => validateAgentSpawnInput({
				title: "Fixture request",
				request: "Do not retain an obsolete tool field.",
				config,
			}),
			/invalid shape/,
		);
	}
});

test("Agent Spawn rejects extension path arrays at input validation", () => {
	assert.throws(
		() => validateAgentSpawnInput({
			title: "Fixture request",
			request: "Inspect the child Runtime.",
			config: { extensions: ["/extensions/arbitrary.ts"] },
		}),
		/Agent Spawn config\.extensions must be "inherit" or "none"/,
	);
});

test("Agent Spawn validates independent system-prompt and context-file controls", () => {
	assert.deepEqual(validateAgentSpawnInput({
		title: "Fixture request",
		request: "Use the native project instructions with a focused prompt.",
		config: {
			systemPrompt: "Focus on the assigned task.",
			systemPromptMode: "append",
			loadContextFiles: true,
		},
	}), {
		title: "Fixture request",
		request: "Use the native project instructions with a focused prompt.",
		config: {
			systemPrompt: "Focus on the assigned task.",
			systemPromptMode: "append",
			loadContextFiles: true,
		},
	});
	assert.throws(
		() => validateAgentSpawnInput({
			title: "Fixture request",
			request: "A prompt mode needs a prompt body.",
			config: { systemPromptMode: "replace" },
		}),
		/systemPromptMode requires systemPrompt/,
	);
	assert.throws(
		() => validateAgentSpawnInput({
			title: "Fixture request",
			request: "The aggregate context fields are obsolete.",
			config: { projectContext: "obsolete" },
		}),
		/invalid shape/,
	);
});

test("Agent Spawn validates model overrides with explicit inheritance", () => {
	assert.deepEqual(validateAgentSpawnInput({
		title: "Fixture request",
		request: "Use an explicit model with inherited thinking.",
		config: {
			model: { id: "provider/model", thinking: "inherit" },
		},
	}), {
		title: "Fixture request",
		request: "Use an explicit model with inherited thinking.",
		config: {
			model: {
				id: "provider/model",
				thinking: "inherit",
			},
		},
	});
	assert.deepEqual(validateAgentSpawnInput({
		title: "Fixture request",
		request: "Use an inherited model with explicit thinking.",
		config: {
			model: { id: "inherit", thinking: "max" },
		},
	}).config?.model, { id: "inherit", thinking: "max" });
	assert.deepEqual(validateAgentSpawnInput({
		title: "Fixture request",
		request: "Explicitly inherit both values.",
		config: { model: { id: "inherit", thinking: "inherit" } },
	}).config?.model, { id: "inherit", thinking: "inherit" });
	assert.throws(
		() => validateAgentSpawnInput({
			title: "Fixture request",
			request: "Standalone thinking is obsolete.",
			config: { thinking: "high" },
		}),
		/invalid shape/,
	);
});

test("Agent Spawn schema and validation accept independently omitted model fields", () => {
	for (const model of [{}, { id: "provider/model" }, { thinking: "high" }, { id: "inherit" }, { thinking: "inherit" }]) {
		const input = { title: "Fixture request", request: "Use selected defaults.", config: { model } };
		assert.equal(Check(participantCoordinationToolSchemas.agent_spawn, input), true);
		assert.deepEqual(validateAgentSpawnInput(input), input);
	}
	for (const model of [{ id: "invalid" }, { thinking: "invalid" }, { extra: true }, { id: null }, { thinking: null }]) {
		const input = { title: "Fixture request", request: "Reject invalid configuration.", config: { model } };
		assert.equal(Check(participantCoordinationToolSchemas.agent_spawn, input), false);
		assert.throws(() => validateAgentSpawnInput(input), /invalid/);
	}
});
