import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	TUI,
} from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
	modelPolicyRows,
	openModelPolicySurface,
	type ModelPolicyModel,
	type ModelPolicyRow,
} from "../src/presentation/model-policy-surface.ts";

const MODELS: readonly ModelPolicyModel[] = [
	{ provider: "openai-codex", modelId: "gpt-5.6-luna", name: "Luna" },
	{ provider: "openai-codex", modelId: "gpt-6-astra", name: "Astra" },
	{ provider: "coordination-test", modelId: "deterministic-owner", name: "Deterministic" },
];

test("menu rows pair a provider row with its models and mark locked bans", () => {
	const rows = modelPolicyRows(MODELS, ["openai-codex/*", "deepseek/deepseek-v4-flash"]);
	assert.deepEqual(rows.map((row) => row.kind === "provider"
		? `${row.provider}/*`
		: `${row.provider}/${row.modelId}`), [
		"coordination-test/*",
		"coordination-test/deterministic-owner",
		"deepseek/*",
		"deepseek/deepseek-v4-flash",
		"openai-codex/*",
		"openai-codex/gpt-5.6-luna",
		"openai-codex/gpt-6-astra",
	]);

	const provider = rows.find((row) => row.kind === "provider" && row.provider === "openai-codex");
	assert.deepEqual({ banned: provider?.banned }, { banned: true });
	const luna = rows.find((row): row is Extract<ModelPolicyRow, { kind: "model" }> =>
		row.kind === "model" && row.modelId === "gpt-5.6-luna");
	assert.deepEqual(
		{ banned: luna?.banned, locked: luna?.locked, available: luna?.available },
		{ banned: true, locked: true, available: true },
	);
	// A banned identity that is not in the current catalogue stays reversible.
	const stale = rows.find((row): row is Extract<ModelPolicyRow, { kind: "model" }> =>
		row.kind === "model" && row.provider === "deepseek");
	assert.deepEqual(
		{ banned: stale?.banned, locked: stale?.locked, available: stale?.available },
		{ banned: true, locked: false, available: false },
	);
	const owner = rows.find((row): row is Extract<ModelPolicyRow, { kind: "model" }> =>
		row.kind === "model" && row.modelId === "deterministic-owner");
	assert.deepEqual({ banned: owner?.banned, locked: owner?.locked }, { banned: false, locked: false });
});

test("an excluded model is absent from the menu's exclusion entries by omission alone", () => {
	const rows = modelPolicyRows(MODELS, []);
	assert.equal(rows.filter((row) => row.banned).length, 0);
	assert.equal(rows.filter((row) => row.kind === "provider").length, 2);
});

test("Enter toggles one model row and follows the persisted entries", async () => {
	const harness = surfaceHarness();
	const persisted: Array<readonly string[]> = [];
	const opened = openModelPolicySurface(harness.ui, {
		availableModels: MODELS,
		excludedModels: [],
		async persist(entries) {
			persisted.push(entries);
			return entries;
		},
	});
	await Promise.resolve();

	// Row order is coordination-test, its model, then openai-codex rows.
	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\r");
	await settle();
	assert.deepEqual(persisted, [["openai-codex/gpt-5.6-luna"]]);
	assert.match(render(harness.component), /gpt-5\.6-luna/);

	const bannedLine = lineWith(harness.component, "gpt-5.6-luna");
	assert.doesNotMatch(bannedLine, /✓/);
	assert.match(lineWith(harness.component, "deterministic-owner"), /✓/);

	harness.component.handleInput?.("\r");
	await settle();
	assert.deepEqual(persisted.at(-1), []);

	harness.component.handleInput?.("\x1b");
	await opened;
});

test("a locked model row reports its provider entry and persists nothing", async () => {
	const harness = surfaceHarness();
	const persisted: Array<readonly string[]> = [];
	const opened = openModelPolicySurface(harness.ui, {
		availableModels: MODELS,
		excludedModels: ["openai-codex/*"],
		async persist(entries) {
			persisted.push(entries);
			return entries;
		},
	});
	await Promise.resolve();

	for (const key of ["\x1b[B", "\x1b[B", "\x1b[B"]) harness.component.handleInput?.(key);
	harness.component.handleInput?.("\r");
	await settle();
	assert.deepEqual(persisted, []);
	assert.match(render(harness.component), /openai-codex\/\* bans this model/);

	// The provider row itself still toggles.
	harness.component.handleInput?.("\x1b[A");
	harness.component.handleInput?.("\r");
	await settle();
	assert.deepEqual(persisted, [[]]);
	assert.match(lineWith(harness.component, "openai-codex/*"), /✓/);

	harness.component.handleInput?.("\x1b");
	await opened;
});

test("search scopes bulk ban and allow to the visible rows", async () => {
	const harness = surfaceHarness();
	const persisted: Array<readonly string[]> = [];
	const opened = openModelPolicySurface(harness.ui, {
		availableModels: MODELS,
		excludedModels: [],
		async persist(entries) {
			persisted.push(entries);
			return entries;
		},
	});
	await Promise.resolve();

	for (const character of "codex") harness.component.handleInput?.(character);
	await settle();
	const rendered = render(harness.component);
	assert.match(rendered, /gpt-5\.6-luna/);
	assert.match(rendered, /\[openai-codex\]/);
	assert.doesNotMatch(rendered, /deterministic-owner/);

	harness.component.handleInput?.("\x18");
	await settle();
	assert.deepEqual(persisted.at(-1), ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-6-astra"]);

	harness.component.handleInput?.("\x01");
	await settle();
	assert.deepEqual(persisted.at(-1), []);

	harness.component.handleInput?.("\x1b");
	await opened;
});

test("a pending save blocks overlapping changes and dismissal", async () => {
	const harness = surfaceHarness();
	const persisted: Array<readonly string[]> = [];
	let finishSave: () => void = () => {};
	let closed = false;
	const opened = openModelPolicySurface(harness.ui, {
		availableModels: MODELS,
		excludedModels: [],
		persist(entries) {
			persisted.push(entries);
			return new Promise((resolve) => { finishSave = () => resolve(entries); });
		},
	}).then(() => { closed = true; });
	await Promise.resolve();

	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\r");
	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\r");
	harness.component.handleInput?.("\x1b");
	await settle();
	assert.deepEqual(persisted, [["openai-codex/gpt-5.6-luna"]]);
	assert.equal(closed, false);

	finishSave();
	await settle();
	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\r");
	await settle();
	assert.deepEqual(persisted.at(-1), ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-6-astra"]);

	finishSave();
	await settle();
	harness.component.handleInput?.("\x1b");
	await opened;
	assert.equal(closed, true);
});

test("a refused write keeps the previous state and reports the failure", async () => {
	const harness = surfaceHarness();
	let attempts = 0;
	const opened = openModelPolicySurface(harness.ui, {
		availableModels: MODELS,
		excludedModels: [],
		async persist(entries) {
			attempts += 1;
			if (attempts === 1) throw new Error("Workflow Policy could not be written: EACCES");
			return entries;
		},
	});
	await Promise.resolve();

	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\x1b[B");
	harness.component.handleInput?.("\r");
	await settle();
	assert.match(render(harness.component), /could not be written/);
	assert.match(lineWith(harness.component, "gpt-5.6-luna"), /✓/);

	// A failed save releases the pending guard so the change can be retried.
	harness.component.handleInput?.("\r");
	await settle();
	assert.equal(attempts, 2);
	assert.doesNotMatch(lineWith(harness.component, "gpt-5.6-luna"), /✓/);

	harness.component.handleInput?.("\x1b");
	await opened;
});

function surfaceHarness(rows = 30) {
	let surface: Component | undefined;
	const tui = {
		terminal: { rows },
		requestRender() {},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		getBgAnsi: () => "",
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
		): Promise<T> {
			return new Promise<T>((resolve) => {
				surface = factory(tui, theme, {} as KeybindingsManager, resolve);
			});
		},
	} as unknown as ExtensionUIContext;
	return {
		ui,
		get component(): Component {
			assert.ok(surface);
			return surface;
		},
	};
}

function render(component: Component): string {
	return component.render(100).map(stripTerminalSequences).join("\n");
}

function lineWith(component: Component, needle: string): string {
	const line = component.render(100)
		.map(stripTerminalSequences)
		.find((candidate) => candidate.includes(needle));
	assert.ok(line, `expected a rendered line containing ${needle}`);
	return line;
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}
