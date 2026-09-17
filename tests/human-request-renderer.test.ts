import assert from "node:assert/strict";
import test from "node:test";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import {
	renderHumanRequestCall,
	renderHumanRequestResult,
} from "../src/tools/coordination-renderers.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const options = { expanded: false, isPartial: false };

test("the human question block packs its label with the question", () => {
	initTheme("dark");
	const question = "Which boundary is authoritative?";
	const rows = (isPartial: boolean) => renderHumanRequestCall(
		{ question },
		plainTheme,
		{ isPartial },
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
		{ isError: false },
	).render(60).map((line) => line.trim());
	assert.deepEqual(rendered, ["", "[Answer]", "Keep native Pi.", ""]);
});

test("an interrupted Human Request reports the failure without a body gap", () => {
	initTheme("dark");
	const rendered = renderHumanRequestResult(
		{
			content: [{ type: "text", text: "Input was interrupted before an Answer arrived." }],
			details: { requestId: "human-request", answer: "" },
		},
		options,
		plainTheme,
		{ isError: true },
	).render(60).map((line) => line.trim());
	assert.deepEqual(rendered, [
		"",
		"[Interrupted]",
		"Input was interrupted before an Answer arrived.",
		"",
	]);
});
