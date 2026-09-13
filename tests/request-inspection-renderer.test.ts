import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { renderAgentObserveCall, renderAgentObserveResult } from "../src/tools/coordination-renderers.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("obligation observation presents a compact titled list rather than hidden generic status", () => {
	const args = { operation: "obligations" as const };
	const result = renderAgentObserveResult({ content: [], details: { requests: [{
		requestMessageId: "request-constants", requesterAgentId: "observation-agent", title: "Confirm storage constants",
	}] } }, { expanded: false, isPartial: false }, theme, { args }).render(160).join("\n");
	assert.match(result, /1 outstanding Request/);
	assert.match(result, /Confirm storage constants/);
	assert.match(result, /observation-agent/);
	assert.match(renderAgentObserveCall(args, theme).render(160).join("\n"), /obligations/);
});

test("Request inspection call tolerates a streamed operation before its Request ID", () => {
	const args = { operation: "request" } as Parameters<typeof renderAgentObserveCall>[0];
	assert.match(renderAgentObserveCall(args, theme).render(160).join("\n"), /request/);
});

test("Request inspection renders its title and full instructions on expansion", () => {
	initTheme("dark");
	const args = { operation: "request" as const, requestId: "req-one" };
	const question = Array.from({ length: 12 }, (_, i) => `Instruction ${i + 1}.`).join("\n") + "\nFinal constraint: do not write.";
	const result = renderAgentObserveResult({ content: [], details: {
		requestMessageId: args.requestId, requesterAgentId: "observation-agent", responderAgentId: "storage-agent",
		title: "Confirm storage constants", question,
	} }, { expanded: true, isPartial: false }, theme, { args }).render(160).join("\n");
	assert.match(result, /Confirm storage constants/);
	assert.match(result, /Final constraint: do not write/);
	assert.match(result, /req-one/);
	assert.match(renderAgentObserveCall(args, theme).render(160).join("\n"), /req-one/);
});
