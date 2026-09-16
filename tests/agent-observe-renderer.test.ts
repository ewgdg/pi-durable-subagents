import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { renderAgentObserveResult } from "../src/tools/coordination-renderers.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const args = { operation: "status" as const, agentId: "agent-one" };

function renderResult(expanded: boolean): string {
	return renderAgentObserveResult(
		{
			content: [{ type: "text", text: "agent is not available" }],
			details: undefined,
		},
		{ expanded, isPartial: false },
		plainTheme,
		{ args, isError: true },
	).render(120).join("\n");
}

test("Agent Observe renders tool errors instead of an observed empty result", () => {
	for (const expanded of [false, true]) {
		const rendered = renderResult(expanded);
		assert.match(rendered, /agent is not available/);
		assert.doesNotMatch(rendered, /observed/);
	}
});
