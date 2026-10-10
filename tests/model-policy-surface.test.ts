import "./support/supervised-run.ts";
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
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

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

test("every panel row is boxed at the full width so text behind never shows through", async () => {
	const harness = surfaceHarness();
	const opened = openModelPolicySurface(harness.ui, {
		availableModels: MODELS,
		excludedModels: [],
		async persist(entries) { return entries; },
	});
	await Promise.resolve();

	const lines = harness.component.render(100);
	assert.ok(lines.every((line) => visibleWidth(line) === 100), lines.join("\n"));
	const plain = lines.map(stripTerminalSequences);
	assert.match(plain[0] ?? "", /^┌─+┐$/u);
	assert.match(plain.at(-1) ?? "", /^└─+┘$/u);
	assert.ok(plain.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")), plain.join("\n"));

	harness.component.handleInput?.("\x1b");
	await opened;
});

function surfaceHarness(rows = 30) {
	let surface: Component | undefined;
	const terminal = { rows };
	const tui = {
		terminal,
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
		resize(rows: number) { terminal.rows = rows; },
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

const pad = (index: number) => String(index).padStart(2, "0");
/** Three providers interleaved, so each provider block is long. */
const MANY_MODELS: readonly ModelPolicyModel[] = Array.from({ length: 30 }, (_, index) => ({
	provider: `p${index % 3}`,
	modelId: `m${pad(index)}`,
	name: `Model ${index}`,
}));

/** Pi's overlay height for `maxHeight: "90%"` with 1-row top and bottom margins (pi-tui `resolveOverlayLayout`). */
function overlayRowBound(terminalRows: number): number {
	return Math.max(1, Math.min(Math.floor(terminalRows * 0.9), terminalRows - 2));
}

/** The overlay would cut anything past its bound, so the frame must fit and end with help then the border. */
function assertFitsOverlay(lines: readonly string[], terminalRows: number, label: string): void {
	const plain = lines.map(stripTerminalSequences);
	const bound = overlayRowBound(terminalRows);
	assert.ok(plain.length <= bound, `${label}: ${plain.length} rows exceed the ${bound}-row overlay of a ${terminalRows}-row terminal\n${plain.join("\n")}`);
	assert.match(plain.at(-1) ?? "", /^└─+┘$/u, `${label}\n${plain.join("\n")}`);
	assert.match(plain.at(-2) ?? "", /Esc done/u, `${label}: help is not the last content row\n${plain.join("\n")}`);
}

function rowLabel(row: ModelPolicyRow): string {
	return row.kind === "provider" ? `${row.provider}/*` : `${row.modelId} [${row.provider}]`;
}

function assertFocused(component: Component, row: ModelPolicyRow, label: string): void {
	const text = render(component);
	const focused = text.split("\n").filter((line) => /^│ → /u.test(line));
	assert.equal(focused.length, 1, `${label}: exactly one focused row should be visible\n${text}`);
	assert.ok(focused[0]!.includes(rowLabel(row)), `${label}: ${rowLabel(row)} should be focused\n${text}`);
}

/** Walks searches and messages with the focus on provider and model rows; returns each state's height. */
async function visitEveryState(catalogue: readonly ModelPolicyModel[], rows: number) {
	const harness = surfaceHarness(rows);
	const provider = catalogue.at(-1)!.provider;
	const excludedModels = [`${provider}/*`];
	const opened = openModelPolicySurface(harness.ui, {
		availableModels: catalogue,
		excludedModels,
		async persist() { throw new Error("Workflow Policy could not be written: EACCES"); },
	});
	await Promise.resolve();
	const press = async (...keys: string[]) => {
		for (const key of keys) harness.component.handleInput?.(key);
		await settle();
	};
	const heights: Array<readonly [string, number]> = [];
	const record = (state: string) => {
		const lines = harness.component.render(100);
		assertFitsOverlay(lines, rows, `${rows} rows, ${state}`);
		heights.push([state, lines.length]);
	};
	const menuRows = modelPolicyRows(catalogue, excludedModels);
	const lockedIndex = menuRows.findIndex((row) => row.kind === "model" && row.locked);
	assert.ok(lockedIndex > 0, "the catalogue needs a model locked by its provider row");
	const DOWN = "\x1b[B";
	const UP = "\x1b[A";

	record("provider row focused, no model name");
	await press(DOWN);
	record("model row focused, model name shown");
	await press(UP, ...Array.from({ length: lockedIndex }, () => DOWN), "\r");
	assert.match(render(harness.component), /bans this model/u);
	record("locked-model status");
	await press(UP, "\r");
	assert.match(render(harness.component), /could not be written/u);
	record("write error");
	await press(...provider);
	record("searching");
	await press(..."zzz");
	assert.match(render(harness.component), /No matching/u);
	record("no matches");
	await press("\x7f", "\x7f", "\x7f");
	record("search narrowed back");

	harness.component.handleInput?.("\x1b");
	await opened;
	return heights;
}

test("the models menu keeps one height that fits the overlay through searches and messages", { timeout: 5_000 }, async (t) => {
	for (const rows of [30, 20, 16, 13, 12, 11, 10, 8]) {
		await t.test(`${rows}-row terminal`, async () => {
			const heights: Array<readonly [string, number]> = [];
			for (const [variant, catalogue] of [["short catalogue", MODELS], ["long catalogue", MANY_MODELS]] as const) {
				for (const [state, height] of await visitEveryState(catalogue, rows)) heights.push([`${variant}: ${state}`, height]);
			}
			const expected = heights[0]![1];
			assert.deepEqual(heights.filter(([, height]) => height !== expected), [], `states differ from ${expected} rows`);
		});
	}
});

test("the models menu scrolls to the end and back and keeps the focus across resizes", { timeout: 5_000 }, async () => {
	const harness = surfaceHarness(16);
	const opened = openModelPolicySurface(harness.ui, {
		availableModels: MANY_MODELS,
		excludedModels: [],
		async persist(entries) { return entries; },
	});
	await Promise.resolve();
	const menuRows = modelPolicyRows(MANY_MODELS, []);
	const height = harness.component.render(100).length;
	const path = [...menuRows.keys(), ...[...menuRows.keys()].reverse().slice(1)];
	for (const [step, index] of path.entries()) {
		if (step > 0) harness.component.handleInput?.(index > path[step - 1]! ? "\x1b[B" : "\x1b[A");
		assertFocused(harness.component, menuRows[index]!, `row ${index + 1} of ${menuRows.length}`);
		assert.equal(harness.component.render(100).length, height, "scrolling must not change the height");
	}

	const middle = 17;
	for (let step = 0; step < middle; step++) harness.component.handleInput?.("\x1b[B");
	const heights = new Map<number, number>();
	for (const rows of [30, 12, 20, 16]) {
		harness.resize(rows);
		assertFitsOverlay(harness.component.render(100), rows, `resized to ${rows} rows`);
		assertFocused(harness.component, menuRows[middle]!, `resized to ${rows} rows`);
		heights.set(rows, harness.component.render(100).length);
	}
	assert.notEqual(heights.get(30), heights.get(12), "a resize must change the height");

	harness.component.handleInput?.("\x1b");
	await opened;
});
