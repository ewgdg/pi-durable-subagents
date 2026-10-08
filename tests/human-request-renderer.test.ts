import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import {
	renderHumanRequestCall,
	renderHumanRequestError,
	renderHumanRequestResult,
} from "../src/tools/coordination-renderers.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const options = { expanded: false, isPartial: false };
const context = { outputPad: 1 };

test("the human question block packs its label with the question", () => {
	initTheme("dark");
	const question = "Which boundary is authoritative?";
	const rows = (isPartial: boolean) => renderHumanRequestCall(
		{ question },
		plainTheme,
		{ isPartial, ...context },
	).render(60).map((line) => line.trim());
	assert.deepEqual(rows(false), ["", "[Ask User]", question, ""]);
	assert.deepEqual(rows(true), ["", "[Ask User]  waiting", question, ""]);
});

test("the human Answer block packs its label with the Answer", () => {
	initTheme("dark");
	const rendered = renderHumanRequestResult(
		{
			content: [],
			details: { requestId: "human-request", answer: "\r\n\r\nKeep native Pi.\r\n\r\n" },
		},
		options,
		plainTheme,
		context,
	).render(60).map((line) => line.trim());
	assert.deepEqual(rendered, ["", "[Answer]", "Keep native Pi.", ""]);
});

test("an interrupted Human Request reports the failure without a body gap", () => {
	initTheme("dark");
	const rendered = renderHumanRequestError(
		{
			content: [{ type: "text", text: "Input was interrupted before an Answer arrived." }],
			details: undefined,
		},
		options,
		plainTheme,
		context,
	).render(60).map((line) => line.trim());
	assert.deepEqual(rendered, [
		"",
		"[Interrupted]",
		"Input was interrupted before an Answer arrived.",
		"",
	]);
});

test("Human Request blocks indent by Pi's outputPad setting", () => {
	initTheme("dark");
	const answer = { content: [], details: { requestId: "human-request", answer: "Keep native Pi." } };
	const interruption = { content: [{ type: "text" as const, text: "Interrupted." }], details: undefined };
	for (const outputPad of [0, 1]) {
		const blocks = [
			renderHumanRequestCall({ question: "Which boundary?" }, plainTheme, { isPartial: false, outputPad }),
			renderHumanRequestResult(answer, options, plainTheme, { outputPad }),
			renderHumanRequestError(interruption, options, plainTheme, { outputPad }),
		];
		for (const block of blocks) {
			const labelLine = block.render(60).find((line) => line.includes("["));
			assert.equal(labelLine?.indexOf("["), outputPad, `outputPad ${outputPad}: ${labelLine}`);
		}
	}
});
