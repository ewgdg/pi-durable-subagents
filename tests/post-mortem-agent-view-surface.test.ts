import assert from "node:assert/strict";
import test from "node:test";

import {
	SessionManager,
	Theme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import {
	PostMortemAgentViewSurface,
	type PostMortemAgentViewResult,
} from "../src/presentation/post-mortem-agent-view-surface.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";

const AGENT_ID = "post-mortem-agent";

initTheme("dark", false);

test("post-mortem view renders durable evidence and starts at its tail", () => {
	const { surface } = createHarness();
	const rendered = stripTerminalSequences(surface.render(80).join("\n"));

	assert.match(rendered, /Post-mortem · read-only/);
	assert.match(rendered, /Failed Moderator/);
	assert.match(rendered, new RegExp(AGENT_ID));
	assert.match(rendered, /Last durable line/);
	assert.doesNotMatch(rendered, /First durable line/);
	assert.match(rendered, /Runtime unavailable: deterministic preparation failure/);
	assert.match(rendered, /↑\/k ↓\/j scroll · PgUp\/PgDn · Home\/End · a agents · Esc\/q back/);
});

test("post-mortem view scrolls with arrows and j/k plus paging and endpoints", () => {
	const { surface } = createHarness();
	surface.render(80);

	surface.handleInput("k");
	assert.equal(surface.scrollTop(), surface.maximumScrollTop() - 1);
	surface.handleInput("\x1b[A");
	assert.equal(surface.scrollTop(), surface.maximumScrollTop() - 2);
	surface.handleInput("j");
	assert.equal(surface.scrollTop(), surface.maximumScrollTop() - 1);
	surface.handleInput("\x1b[B");
	assert.equal(surface.scrollTop(), surface.maximumScrollTop());

	surface.handleInput("\x1b[5~");
	assert.equal(surface.scrollTop() < surface.maximumScrollTop(), true);
	surface.handleInput("\x1b[6~");
	assert.equal(surface.scrollTop(), surface.maximumScrollTop());
	surface.handleInput("\x1b[H");
	assert.equal(surface.scrollTop(), 0);
	surface.handleInput("\x1b[F");
	assert.equal(surface.scrollTop(), surface.maximumScrollTop());
});

test("post-mortem view returns agents or back without mutating transcript", () => {
	for (const [input, result] of [
		["a", "agents"],
		["q", "back"],
		["\x1b", "back"],
	] as const) {
		const harness = createHarness();
		const before = harness.sessionManager.getEntries();
		harness.surface.handleInput(input);
		assert.deepEqual(harness.results, [result satisfies PostMortemAgentViewResult]);
		assert.deepEqual(harness.sessionManager.getEntries(), before);
	}
});

test("post-mortem rendering removes terminal controls from metadata and evidence", () => {
	const controls = [
		"\x1b]52;c;Y2xpcGJvYXJk\x07",
		"\x1b]0;owned-title\x07",
		"\x1b[2J\x1b[H",
		"\x1b_pi:image=owned\x07",
	];
	const sessionManager = SessionManager.inMemory(process.cwd(), { id: AGENT_ID });
	sessionManager.appendMessage({
		role: "user",
		content: `user ${controls.join(" ")} evidence`,
		timestamp: Date.now(),
	});
	sessionManager.appendMessage(fauxAssistantMessage(
		`assistant ${controls.join(" ")} evidence`,
		{ stopReason: "error", errorMessage: `error ${controls.join(" ")}` },
	));
	const surface = new PostMortemAgentViewSurface({
		tui: {
			terminal: { columns: 80, rows: 24 },
			requestRender() {},
		} as unknown as TUI,
		theme: createTheme(),
		agentId: `agent-${controls.join("")}`,
		label: `label-${controls.join("")}`,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		preparationError: `preparation-${controls.join("")}`,
		done() {},
	});

	const rendered = surface.render(160).join("\n");
	for (const control of controls) assert.doesNotMatch(rendered, new RegExp(escapeRegExp(control)));
	assert.doesNotMatch(rendered, /\x1b\](?:52|0);/);
	assert.doesNotMatch(rendered, /\x1b\[(?:2J|H)/);
	assert.doesNotMatch(rendered, /\x1b_pi:/);
});

function createHarness(): {
	surface: PostMortemAgentViewSurface;
	results: PostMortemAgentViewResult[];
	sessionManager: SessionManager;
} {
	const sessionManager = SessionManager.inMemory(process.cwd(), { id: AGENT_ID });
	for (let index = 0; index < 30; index += 1) {
		sessionManager.appendMessage({
			role: "user",
			content: index === 0
				? "First durable line"
				: index === 29 ? "Last durable line" : `Durable line ${index}`,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(fauxAssistantMessage(`Assistant line ${index}`));
	}
	const results: PostMortemAgentViewResult[] = [];
	const theme = createTheme();
	const tui = {
		terminal: { columns: 80, rows: 12 },
		requestRender() {},
	} as unknown as TUI;
	return {
		surface: new PostMortemAgentViewSurface({
			tui,
			theme,
			agentId: AGENT_ID,
			label: "Failed Moderator",
			transcript: transcriptFromSessionManager(sessionManager).inspect(),
			preparationError: new Error("deterministic preparation failure"),
			done: (result) => results.push(result),
		}),
		results,
		sessionManager,
	};
}

function createTheme(): Theme {
	return new Theme(
		Object.fromEntries([
			"accent", "border", "borderAccent", "borderMuted", "success", "error",
			"warning", "muted", "dim", "text", "thinkingText", "userMessageText",
			"customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
			"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
			"mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
			"toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment",
			"syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
			"syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
			"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium",
			"thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
		].map((name) => [name, "#ffffff"])) as ConstructorParameters<typeof Theme>[0],
		{
			selectedBg: "#000000",
			userMessageBg: "#000000",
			customMessageBg: "#000000",
			toolPendingBg: "#000000",
			toolSuccessBg: "#000000",
			toolErrorBg: "#000000",
		},
		"truecolor",
	) as Theme;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
