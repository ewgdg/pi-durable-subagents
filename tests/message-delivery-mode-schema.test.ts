import assert from "node:assert/strict";
import test from "node:test";
import { fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { participantCoordinationToolSchemas } from "../src/tools/participant-coordination-tools.ts";
import { agentControlMethods } from "../src/control/agent-control-protocol.ts";

const parameters = participantCoordinationToolSchemas.agent_message;
const tool = { name: "agent_message", description: "Coordinate", parameters };
const baseInputs = [
	{ operation: "send", targetAgent: "recipient", content: "Information" },
	{ operation: "request", targetAgent: "recipient", title: "Review", question: "Review the change" },
];

function nodes(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(nodes);
	if (!value || typeof value !== "object") return [];
	return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
}

test("deliveryMode description is emitted once and both authoring operations reference it", () => {
	const schema = JSON.parse(JSON.stringify(parameters));
	const fields = schema.anyOf.filter((branch: { properties: Record<string, unknown> }) => branch.properties.deliveryMode)
		.map((branch: { properties: Record<string, unknown> }) => branch.properties.deliveryMode);
	assert.equal(fields.length, 2);
	assert.deepEqual(fields, [{ $ref: "#/$defs/deliveryMode" }, { $ref: "#/$defs/deliveryMode" }]);
	const description = schema.$defs.deliveryMode.description;
	assert.match(description, /deferred.*default/i);
	assert.match(description, /agent_wait/);
	assert.match(description, /steer/);
	assert.match(description, /background/);
	assert.match(description, /FIFO/);
	assert.match(description, /starv/);
	assert.equal(nodes(schema).filter(node => node.description === description).length, 1);
});

test("all delivery modes and omission validate through TypeBox and native Pi tool validation", () => {
	const validator = Compile(parameters);
	for (const base of baseInputs) {
		for (const deliveryMode of [undefined, "deferred", "steer", "background"]) {
			const input = deliveryMode === undefined ? base : { ...base, deliveryMode };
			assert.equal(validator.Check(input), true, JSON.stringify(input));
			assert.deepEqual(validateToolArguments(tool, fauxToolCall(tool.name, input)), input);
		}
	}
});

test("shared references preserve closed operation-specific arguments", () => {
	const invalid = [
		...baseInputs.flatMap(base => [{ ...base, deliveryMode: "invalid" }, { ...base, extra: true }]),
		{ operation: "answer", requestId: "request", answer: "Done", deliveryMode: "steer" },
		{ operation: "cancel", requestMessageId: "request", reason: "Withdrawn", deliveryMode: "background" },
		{ operation: "poll", messageId: "message", deliveryMode: "deferred" },
		{ operation: "retry", messageId: "message", deliveryMode: "deferred" },
	];
	for (const input of invalid) {
		assert.equal(Check(parameters, input), false, JSON.stringify(input));
		assert.throws(() => validateToolArguments(tool, fauxToolCall(tool.name, input)), /Validation failed/);
	}
});

test("references retain their scope when the tool schema is nested in control transport", () => {
	const request = agentControlMethods["coordination.message"].request;
	// An unrelated outer definition must not change the nested tool's mode contract.
	const envelope = Type.Object({ request }, { $defs: { deliveryMode: Type.Literal("wrong-scope") } });
	for (const schema of [request, JSON.parse(JSON.stringify(request))]) {
		const validator = Compile(schema);
		for (const base of baseInputs) {
			const value = { toolCallId: "call", input: { ...base, deliveryMode: "background" } };
			assert.equal(validator.Check(value), true);
			assert.equal(Check(envelope, { request: value }), true);
			assert.equal(validator.Check({ ...value, input: { ...base, deliveryMode: "wrong-scope" } }), false);
		}
	}
});
