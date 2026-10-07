import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerCoordinationTools, type CoordinationToolHandlers } from "../src/tools/coordination-tools.ts";
import type { WorkflowResumeReceipt } from "../src/protocol/workflow-resume.ts";

let resumeTool: ToolDefinition;
registerCoordinationTools({
	registerTool(tool: ToolDefinition) {
		if (tool.name === "workflow_resume") resumeTool = tool;
	},
} as ExtensionAPI, "owner", {} as CoordinationToolHandlers<"owner">);

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
} as Theme;
const context = {
	args: {}, lastComponent: undefined, toolCallId: "resume", invalidate() {}, state: {}, cwd: process.cwd(),
	argsComplete: true, isPartial: false, expanded: false, showImages: false,
	isError: false, executionStarted: true, durationMs: undefined, outputPad: 0,
};
const receipt: WorkflowResumeReceipt = {
	workflowId: "workflow-full-id",
	outstandingRequests: [
		{
			requestMessageId: "request-12345678",
			targetAgentId: "target-87654321",
			status: "delivery_scheduled",
		},
		{
			requestMessageId: "blocked-ABCDEFGH",
			targetAgentId: "blocked-IJKLMNOP",
			status: "blocked",
			reason: "target is ending",
		},
	],
};
function rendered(details: WorkflowResumeReceipt | undefined, expanded = false, isPartial = false, error?: string) {
	return resumeTool.renderResult!(
		{ content: [{ type: "text", text: error ?? JSON.stringify(details) ?? "" }], details },
		{ expanded, isPartial }, theme, { ...context, isError: !!error },
	).render(240).join("\n");
}

test("registered Workflow Resume uses a themed call and concise outstanding-request rows", () => {
	const call = resumeTool.renderCall!({}, theme, context).render(120).join("\n");
	assert.match(call, /<toolTitle><bold>/);
	assert.match(call, /resume/);
	const output = rendered(receipt);
	assert.match(output, /<warning>2 outstanding outbound Requests<\/warning>/);
	for (const value of [
		"Request ID: 12345678",
		"target ID: 87654321",
		"status: delivery_scheduled",
		"Request ID: ABCDEFGH",
		"target ID: IJKLMNOP",
		"status: blocked",
		"reason: target is ending",
	]) assert.match(output, new RegExp(value));
	assert.doesNotMatch(output, /workflow-full-id|request-12345678|target-87654321|blocked-ABCDEFGH|blocked-IJKLMNOP/);
	assert.doesNotMatch(output, /[{}\[\]"]/);
});

test("Workflow Resume expands full request and target identities without raw JSON", () => {
	const output = rendered(receipt, true);
	for (const id of [
		"request-12345678",
		"target-87654321",
		"blocked-ABCDEFGH",
		"blocked-IJKLMNOP",
	]) assert.match(output, new RegExp(id));
	assert.match(output, /Request ID: request-12345678/);
	assert.match(output, /target ID: target-87654321/);
	assert.match(output, /reason: target is ending/);
	assert.doesNotMatch(output, /workflow-full-id/);
	assert.doesNotMatch(output, /[{}\[\]"]/);
});

test("Workflow Resume reports an empty outbound-request view explicitly", () => {
	const output = rendered({ workflowId: "workflow-full-id", outstandingRequests: [] });
	assert.match(output, /no outstanding outbound Requests/);
	assert.doesNotMatch(output, /no eligible work|no workflow work/);
});

test("Workflow Resume renders pending and tool errors rather than undefined JSON", () => {
	assert.match(rendered(undefined, false, true), /<accent>.*resuming Workflow/);
	const output = rendered(undefined, false, false, "admission_closed: shutting down");
	assert.match(output, /<error>/);
	assert.match(output, /admission_closed: shutting down/);
	assert.doesNotMatch(output, /undefined|scheduled|admitted/);
});

test("Workflow Resume guidance explains automatic continuation without redundant wake-ups", () => {
	assert.match(resumeTool.description, /scheduling eligible pending/i);
	const guide = resumeTool.promptGuidelines!.join("\n");
	assert.match(guide, /wake-up/i);
	assert.match(guide, /do not send redundant/i);
	assert.match(guide, /genuinely new instructions/i);
	assert.match(guide, /blocked.*indeterminate/i);
	assert.match(guide, /Interrupted tools and volatile Wait calls are not restored/i);
});
