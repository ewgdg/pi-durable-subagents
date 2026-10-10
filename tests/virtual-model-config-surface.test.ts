import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
	parseVirtualModels,
	serializeVirtualModels,
	type VirtualModelConfigSnapshot,
	type VirtualModelDefinitions,
	type VirtualModelEntry,
} from "../src/policy/virtual-models.ts";
import { RUNTIME_THINKING_LEVELS, type RuntimeThinkingLevel } from "../src/protocol/runtime-configuration.ts";
import {
	entryUsability,
	openVirtualModelConfigSurface,
	summarizeEntries,
} from "../src/presentation/virtual-model-config-surface.ts";

const MODELS = [
	{ provider: "openai-codex", modelId: "gpt-5.6-luna", name: "Luna" },
	{ provider: "openai-codex", modelId: "gpt-6-astra", name: "Astra" },
	{ provider: "deepseek", modelId: "deepseek-v4-flash", name: "Flash" },
] as const;
const EXCLUDED = ["deepseek/*"] as const;

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";

function entry(id: string, thinking: RuntimeThinkingLevel): VirtualModelEntry {
	const separator = id.indexOf("/");
	return { model: { provider: id.slice(0, separator), modelId: id.slice(separator + 1) }, thinking };
}

/** The persisted file shape, so assertions read like the policy file. */
function asFile(definitions: VirtualModelDefinitions): Record<string, string[]> {
	return Object.fromEntries(Object.entries(definitions).map(([name, entries]) => [
		name,
		entries.map(({ model, thinking }) => `${model.provider}/${model.modelId} ${thinking}`),
	]));
}

const FAST: VirtualModelDefinitions = {
	fast: [entry("openai-codex/gpt-5.6-luna", "high"), entry("gone/old", "low")],
};

type OpenOptions = Readonly<{
	definitions?: VirtualModelDefinitions;
	invalidReason?: string;
	persist?: (definitions: VirtualModelDefinitions) => Promise<VirtualModelConfigSnapshot>;
}>;

function snapshot(definitions: VirtualModelDefinitions): VirtualModelConfigSnapshot {
	return { availableModels: MODELS, excludedModels: EXCLUDED, virtualModels: definitions };
}

async function openSurface(options: OpenOptions = {}) {
	let surface: Component | undefined;
	const tui = { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		getBgAnsi: () => "",
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
	let closed = false;
	const ui = {
		custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component): Promise<T> {
			return new Promise<T>((resolve) => {
				surface = factory(tui, theme, {} as KeybindingsManager, (result) => {
					closed = true;
					resolve(result);
				});
			});
		},
	} as unknown as ExtensionUIContext;
	const persisted: VirtualModelDefinitions[] = [];
	const opened = openVirtualModelConfigSurface(ui, {
		...snapshot(options.definitions ?? FAST),
		...(options.invalidReason === undefined ? {} : { invalidReason: options.invalidReason }),
		async persist(definitions) {
			persisted.push(definitions);
			// Every save must be something the policy file parser reads back.
			assert.deepEqual(asFile(parseVirtualModels(serializeVirtualModels(definitions))), asFile(definitions));
			return options.persist ? options.persist(definitions) : snapshot(definitions);
		},
	});
	await settle();
	const component = () => {
		assert.ok(surface);
		return surface;
	};
	return {
		opened,
		persisted,
		get closed() { return closed; },
		render: () => component().render(100).map(stripTerminalSequences).join("\n"),
		async press(...keys: string[]) {
			for (const key of keys) {
				component().handleInput?.(key);
				await settle();
			}
		},
		/** Escapes editor screens until the top-level list shows, without closing Config. */
		async backToList() {
			for (let attempt = 0; attempt < 6 && !/^Virtual Models$/mu.test(this.render()); attempt++) {
				component().handleInput?.(ESCAPE);
				await settle();
			}
			assert.match(this.render(), /^Virtual Models$/mu);
			assert.equal(closed, false);
		},
		async type(text: string) {
			for (const character of text) {
				component().handleInput?.(character);
				await settle();
			}
		},
	};
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Moves to `+ New virtual model`, below every defined name. */
function downToNewRow(definitions: VirtualModelDefinitions): string[] {
	return Array.from({ length: Object.keys(definitions).length }, () => DOWN);
}

test("entry usability: exclusion wins over availability, a missing model is unavailable", () => {
	const config = { availableModels: MODELS, excludedModels: EXCLUDED };
	const cases = [
		["openai-codex/gpt-5.6-luna", "usable"],
		["deepseek/deepseek-v4-flash", "excluded"],
		["deepseek/not-in-catalogue", "excluded"],
		["gone/old", "unavailable"],
		// The same model id under another provider is a different model.
		["other/gpt-5.6-luna", "unavailable"],
	] as const;
	for (const [id, expected] of cases) {
		assert.equal(entryUsability(config, entry(id, "low").model), expected, id);
	}
});

test("entry summaries keep routing order and collapse what does not fit into +N", () => {
	const entries = [entry("a/one", "low"), entry("b/two", "high"), entry("c/three", "max")];
	assert.equal(summarizeEntries(entries, 200), "one • low → two • high → three • max");
	const narrow = summarizeEntries(entries, 24);
	assert.match(narrow, /^one • low/);
	assert.match(narrow, /\+\d$/);
	assert.ok(narrow.length <= 24, narrow);
});

test("the list shows each name with its entries in order and one unusable marker", { timeout: 5_000 }, async () => {
	const surface = await openSurface({
		definitions: {
			fast: [entry("gone/old", "low"), entry("deepseek/deepseek-v4-flash", "high"), entry("openai-codex/gpt-6-astra", "max")],
		},
	});
	const text = surface.render();
	assert.match(text, /fast\s+old • low → deepseek-v4-flash • high → gpt-6-astra • max/);
	assert.equal(text.match(/\[2 unusable\]/g)?.length, 1, text);
	// The focused name's full ids show below the list.
	assert.match(text, /gone\/old/);
	assert.match(text, /deepseek\/deepseek-v4-flash/);
	assert.match(text, /\+ New virtual model/);
});

test("a new name is accepted exactly when the policy file parser would accept it", { timeout: 20_000 }, async () => {
	const candidates = [
		"fast-review", "a", "a1", "2fast", "fast2-b3",
		"Fast", "fast_review", "-fast", "fast-", "fast--review", "fast review", "fast.review", "",
		// Already defined.
		"fast",
	];
	for (const name of candidates) {
		let parserAccepts = true;
		try {
			parseVirtualModels({ [name]: [{ id: "provider/model", thinking: "low" }] });
		} catch {
			parserAccepts = false;
		}
		const expected = parserAccepts && !Object.hasOwn(FAST, name);
		const surface = await openSurface();
		await surface.press(...downToNewRow(FAST), ENTER);
		await surface.type(name);
		await surface.press(ENTER);
		// Pick the first model and its default thinking.
		await surface.press(ENTER, ENTER);
		if (expected) {
			assert.equal(surface.persisted.length, 1, `${JSON.stringify(name)} should be saved\n${surface.render()}`);
			assert.deepEqual(Object.keys(surface.persisted[0]!).sort(), ["fast", name].sort());
		} else {
			assert.deepEqual(surface.persisted, [], `${JSON.stringify(name)} must be refused\n${surface.render()}`);
			assert.match(surface.render(), /Virtual Models › New/, JSON.stringify(name));
		}
		if (name === "fast") assert.match(surface.render(), /virtual\/fast already exists/);
	}
});

test("a new name is written only together with its first entry", { timeout: 5_000 }, async () => {
	const surface = await openSurface();
	await surface.press(...downToNewRow(FAST), ENTER);
	await surface.type("review");
	await surface.press(ENTER);
	assert.deepEqual(surface.persisted, [], "naming alone must not save");

	// Escaping from the model picker abandons the new name.
	await surface.press(ESCAPE);
	await surface.backToList();
	assert.deepEqual(surface.persisted, []);
	assert.doesNotMatch(surface.render(), /review/);

	await surface.press(...downToNewRow(FAST), ENTER);
	await surface.type("review");
	await surface.press(ENTER);
	await surface.type("astra");
	await surface.press(ENTER);
	// Escaping from the thinking picker saves nothing either.
	await surface.press(ESCAPE);
	await surface.backToList();
	assert.deepEqual(surface.persisted, []);
	assert.doesNotMatch(surface.render(), /review/);

	await surface.press(...downToNewRow(FAST), ENTER);
	await surface.type("review");
	await surface.press(ENTER);
	await surface.type("astra");
	await surface.press(ENTER, ENTER);
	assert.deepEqual(surface.persisted.map(asFile), [{
		fast: ["openai-codex/gpt-5.6-luna high", "gone/old low"],
		review: ["openai-codex/gpt-6-astra medium"],
	}]);
});

test("the thinking picker offers every Pi thinking level and saves the chosen one", { timeout: 5_000 }, async () => {
	const surface = await openSurface();
	await surface.press(ENTER, "a");
	await surface.type("astra");
	await surface.press(ENTER);
	const text = surface.render();
	const offered = RUNTIME_THINKING_LEVELS.filter((level) => new RegExp(`^\\S?\\s*${level}\\s*$`, "mu").test(text));
	assert.deepEqual(offered, [...RUNTIME_THINKING_LEVELS], text);

	// Walk to the last level whatever the default focus is.
	const last = RUNTIME_THINKING_LEVELS.at(-1)!;
	for (let step = 0; step < RUNTIME_THINKING_LEVELS.length && !new RegExp(`→ ${last}`).test(surface.render()); step++) {
		await surface.press(DOWN);
	}
	await surface.press(ENTER);
	assert.deepEqual(surface.persisted.map(asFile), [{
		fast: ["openai-codex/gpt-5.6-luna high", "gone/old low", `openai-codex/gpt-6-astra ${last}`],
	}]);
});

test("appending refuses a model already in the list and accepts an excluded one with a marker", { timeout: 5_000 }, async () => {
	const surface = await openSurface();
	await surface.press(ENTER, "a");
	const picker = surface.render();
	assert.match(picker, /openai-codex\/gpt-5\.6-luna\s+\[in list\]/);
	assert.match(picker, /deepseek\/deepseek-v4-flash\s+\[excluded\]/);

	await surface.type("luna");
	await surface.press(ENTER, ENTER, ENTER);
	assert.deepEqual(surface.persisted, [], "a duplicate id must be refused");

	await surface.backToList();
	await surface.press(ENTER, "a");
	await surface.type("flash");
	await surface.press(ENTER, ENTER);
	assert.deepEqual(surface.persisted.map(asFile), [{
		fast: ["openai-codex/gpt-5.6-luna high", "gone/old low", "deepseek/deepseek-v4-flash low"],
	}]);
	assert.match(surface.render(), /3\s+deepseek\/deepseek-v4-flash\s+\S+\s+\[excluded\]/);
});

test("Enter on an entry replaces its model or only its thinking, never duplicating another entry", { timeout: 5_000 }, async () => {
	const surface = await openSurface();
	// Same model, new thinking: the entry's own model is not "in list" for itself.
	await surface.press(ENTER, ENTER);
	await surface.type("luna");
	await surface.press(ENTER, DOWN, DOWN, ENTER);
	assert.deepEqual(surface.persisted.map(asFile).at(-1), {
		fast: ["openai-codex/gpt-5.6-luna max", "gone/old low"],
	});

	// Replacing entry 2 with entry 1's model is refused.
	await surface.press(DOWN, ENTER);
	await surface.type("luna");
	await surface.press(ENTER, ENTER, ENTER);
	assert.equal(surface.persisted.length, 1, surface.render());

	await surface.backToList();
	await surface.press(ENTER, DOWN, ENTER);
	await surface.type("astra");
	await surface.press(ENTER, ENTER);
	assert.deepEqual(surface.persisted.map(asFile).at(-1), {
		fast: ["openai-codex/gpt-5.6-luna max", "openai-codex/gpt-6-astra low"],
	});
});

test("K and J reorder entries and save each move; moves past either end save nothing", { timeout: 5_000 }, async () => {
	const surface = await openSurface({
		definitions: { fast: [entry("a/one", "low"), entry("b/two", "high"), entry("c/three", "max")] },
	});
	await surface.press(ENTER);
	await surface.press("K");
	assert.deepEqual(surface.persisted, [], "the first entry cannot move up");
	await surface.press("J");
	assert.deepEqual(asFile(surface.persisted.at(-1)!), { fast: ["b/two high", "a/one low", "c/three max"] });
	await surface.press("J");
	assert.deepEqual(asFile(surface.persisted.at(-1)!), { fast: ["b/two high", "c/three max", "a/one low"] });
	await surface.press("J");
	assert.equal(surface.persisted.length, 2, "the last entry cannot move down");
	await surface.press("K");
	assert.deepEqual(asFile(surface.persisted.at(-1)!), { fast: ["b/two high", "a/one low", "c/three max"] });
});

test("d deletes the focused entry but never the last one", { timeout: 5_000 }, async () => {
	const surface = await openSurface();
	await surface.press(ENTER, DOWN, "d");
	assert.deepEqual(surface.persisted.map(asFile), [{ fast: ["openai-codex/gpt-5.6-luna high"] }]);
	await surface.press("k", "d");
	assert.equal(surface.persisted.length, 1);
	assert.match(surface.render(), /at least one entry/);
	assert.match(surface.render(), /1\s+openai-codex\/gpt-5\.6-luna/);
});

test("r renames with the current name editable and keeps the entries", { timeout: 5_000 }, async () => {
	const definitions: VirtualModelDefinitions = { ...FAST, slow: [entry("openai-codex/gpt-6-astra", "max")] };
	const surface = await openSurface({ definitions });
	await surface.press(ENTER, "r");
	assert.match(surface.render(), /virtual\/fast/);

	// Unchanged: not reported as a duplicate of itself.
	await surface.press(ENTER);
	assert.doesNotMatch(surface.render(), /already exists/);
	assert.ok(surface.persisted.every((saved) => Object.hasOwn(saved, "fast")));
	if (/Rename/.test(surface.render())) await surface.press(ESCAPE);

	// Renaming onto another defined name is refused.
	await surface.press("r", BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE);
	await surface.type("slow");
	await surface.press(ENTER);
	assert.match(surface.render(), /virtual\/slow already exists/);
	assert.ok(surface.persisted.every((saved) => Object.hasOwn(saved, "fast")));

	// The cursor starts after the existing name, so Backspace edits its end.
	await surface.press(ESCAPE, "r", BACKSPACE, BACKSPACE);
	await surface.type("ster");
	await surface.press(ENTER);
	assert.deepEqual(asFile(surface.persisted.at(-1)!), {
		faster: ["openai-codex/gpt-5.6-luna high", "gone/old low"],
		slow: ["openai-codex/gpt-6-astra max"],
	});
	assert.match(surface.render(), /Virtual Models › faster/);

	// An invalid name is refused like a new one.
	await surface.press("r");
	await surface.type("_X");
	const saves = surface.persisted.length;
	await surface.press(ENTER);
	assert.equal(surface.persisted.length, saves);
});

test("deleting a name needs a second d on the same name", { timeout: 5_000 }, async () => {
	const definitions: VirtualModelDefinitions = { ...FAST, slow: [entry("openai-codex/gpt-6-astra", "max")] };
	const surface = await openSurface({ definitions });
	await surface.press("d");
	assert.match(surface.render(), /Delete virtual\/fast\?/);
	await surface.press(ESCAPE);
	assert.deepEqual(surface.persisted, []);
	assert.equal(surface.closed, false, "Escape cancels the confirmation, not Config");

	// Arming on one name and confirming on another must not delete either.
	await surface.press("d", DOWN, "d");
	assert.deepEqual(surface.persisted, []);
	assert.match(surface.render(), /Delete virtual\/slow\?/);
	await surface.press("d");
	assert.deepEqual(surface.persisted.map(asFile), [{ fast: ["openai-codex/gpt-5.6-luna high", "gone/old low"] }]);
	assert.doesNotMatch(surface.render(), /slow/);

	await surface.press("k", "d", "d");
	assert.deepEqual(surface.persisted.at(-1), {});
	assert.match(surface.render(), /No virtual models/);
});

test("a failed save shows the error, keeps the previous definitions, and allows a retry", { timeout: 5_000 }, async () => {
	let failing = true;
	const surface = await openSurface({
		async persist(definitions) {
			if (failing) throw new Error("disk full");
			return snapshot(definitions);
		},
	});
	await surface.press(ENTER, "J");
	assert.match(surface.render(), /disk full/);
	assert.match(surface.render(), /1\s+openai-codex\/gpt-5\.6-luna[\s\S]*2\s+gone\/old/);

	// A failed new name does not appear in the list.
	await surface.backToList();
	await surface.press(DOWN, ENTER);
	await surface.type("review");
	await surface.press(ENTER, ENTER, ENTER);
	assert.match(surface.render(), /disk full/);
	await surface.backToList();
	assert.doesNotMatch(surface.render(), /review/);

	// A failed delete or rename keeps the name.
	await surface.press("k", "d", "d");
	assert.match(surface.render(), /disk full/);
	assert.match(surface.render(), /fast\s+gpt-5\.6-luna/);
	await surface.press(ENTER, "r");
	await surface.type("er");
	await surface.press(ENTER);
	assert.match(surface.render(), /disk full/);
	await surface.backToList();
	assert.match(surface.render(), /fast\s+gpt-5\.6-luna/);
	assert.doesNotMatch(surface.render(), /faster/);

	failing = false;
	const attempts = surface.persisted.length;
	await surface.press("k", ENTER, "J");
	assert.equal(surface.persisted.length, attempts + 1);
	assert.deepEqual(asFile(surface.persisted.at(-1)!), { fast: ["gone/old low", "openai-codex/gpt-5.6-luna high"] });
	assert.doesNotMatch(surface.render(), /disk full/);
});

test("actions during a pending save do not start an overlapping save", { timeout: 5_000 }, async () => {
	let release: (() => void) | undefined;
	const surface = await openSurface({
		definitions: { fast: [entry("a/one", "low"), entry("b/two", "high"), entry("c/three", "max")] },
		persist(definitions) {
			return new Promise((resolve) => { release = () => resolve(snapshot(definitions)); });
		},
	});
	await surface.press(ENTER, "J");
	assert.equal(surface.persisted.length, 1);
	await surface.press("J", "K", "d");
	assert.equal(surface.persisted.length, 1, "no second save may start while one is pending");

	release?.();
	await settle();
	await surface.press("d");
	assert.equal(surface.persisted.length, 2);
	assert.equal(surface.persisted[1]!.fast!.length, 2, "the next action applies to the saved definitions");
});

test("an invalid config file shows its error and the last valid definitions read-only", { timeout: 5_000 }, async () => {
	const surface = await openSurface({ invalidReason: "Workflow Policy must be strict JSON" });
	const list = surface.render();
	assert.match(list, /Workflow Policy must be strict JSON/);
	assert.match(list, /fast\s+gpt-5\.6-luna • high → old • low/);
	assert.doesNotMatch(list, /New virtual model/);

	await surface.press("d", "d", DOWN, ENTER);
	await surface.press("J", "K", "d", "a", "r", ENTER, DOWN, "K", "d");
	await surface.type("x");
	await surface.press(ENTER, ENTER, ENTER);
	assert.deepEqual(surface.persisted, []);
	assert.match(surface.render(), /Editing is disabled/);
});

test("Escape on the list closes Config", { timeout: 5_000 }, async () => {
	const surface = await openSurface();
	await surface.press(ENTER, ESCAPE);
	assert.equal(surface.closed, false);
	await surface.press(ESCAPE);
	await surface.opened;
	assert.equal(surface.closed, true);
	assert.deepEqual(surface.persisted, []);
});
