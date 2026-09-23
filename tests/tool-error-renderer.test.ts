import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerParticipantCoordinationTools } from "../src/tools/participant-coordination-tools.ts";

const tools = new Map<string, ToolDefinition>();
for (const role of ["owner", "moderator"] as const) {
	registerParticipantCoordinationTools({
		registerTool(tool: ToolDefinition) {
			if (!tools.has(tool.name)) tools.set(tool.name, tool);
		},
	} as ExtensionAPI, role, {} as Parameters<typeof registerParticipantCoordinationTools<typeof role>>[2]);
}

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => text,
} as Theme;
const errorText = "invalid_input: requested operation rejected";

for (const name of ["agent_spawn", "agent_wait", "agent_control", "moderator_control"]) {
	test(`${name} shows a final native error instead of a pending or receipt summary`, () => {
		const tool = tools.get(name);
		assert.ok(tool?.renderResult, `${name} is registered with a result renderer`);
		for (const expanded of [false, true]) {
			const output = tool.renderResult(
				{ content: [{ type: "text", text: errorText }], details: undefined },
				{ expanded, isPartial: false },
				theme,
				{
					args: {}, lastComponent: undefined, toolCallId: name, invalidate() {}, state: {}, cwd: process.cwd(),
					argsComplete: true, isPartial: false, expanded, showImages: false, isError: true, executionStarted: true,
				},
			).render(240).join("\n");
			assert.match(output, new RegExp(`<error>${errorText}</error>`));
			assert.doesNotMatch(output, /…|<success>|undefined/);
		}
	});
}
