import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionVirtualModel,
} from "@earendil-works/pi-coding-agent";

import {
	isVirtualModel,
	parseVirtualModels,
	requireVirtualModelDefinition,
	selectVirtualModelEntry,
	type EntryUsability,
	type VirtualModelEntry,
} from "../src/policy/virtual-models.ts";
import { VirtualModelRegistrar } from "../src/pi-integration/virtual-model-registration.ts";
import type { ModelReference } from "../src/protocol/runtime-configuration.ts";

const LUNA: ModelReference = { provider: "openai-codex", modelId: "gpt-6.1-luna" };
const FLASH: ModelReference = { provider: "deepseek", modelId: "deepseek-flash" };
const PRO: ModelReference = { provider: "deepseek", modelId: "deepseek-pro" };

const entry = (model: ModelReference, thinking: VirtualModelEntry["thinking"]): VirtualModelEntry => ({ model, thinking });
const key = (model: ModelReference) => `${model.provider}/${model.modelId}`;
const usabilityOf = (table: Record<string, EntryUsability>) =>
	(model: ModelReference): EntryUsability => table[key(model)] ?? "usable";

// --- Pure routing decision ---------------------------------------------------

test("selection takes the first usable entry, skipping excluded and unavailable ones", () => {
	const entries = [entry(LUNA, "high"), entry(FLASH, "max"), entry(PRO, "low")];
	assert.deepEqual(
		selectVirtualModelEntry({ name: "fast", entries, usability: () => "usable" }),
		entries[0],
	);
	assert.deepEqual(
		selectVirtualModelEntry({ name: "fast", entries, usability: usabilityOf({ [key(LUNA)]: "excluded" }) }),
		entries[1],
	);
	assert.deepEqual(
		selectVirtualModelEntry({
			name: "fast",
			entries,
			usability: usabilityOf({ [key(LUNA)]: "unavailable", [key(FLASH)]: "excluded" }),
		}),
		entries[2],
	);
});

test("a sticky model wins only while it is still a usable entry", () => {
	const entries = [entry(LUNA, "high"), entry(FLASH, "max"), entry(PRO, "low")];
	// Sticky later entry beats the first usable one.
	assert.deepEqual(
		selectVirtualModelEntry({ name: "fast", entries, usability: () => "usable", sticky: PRO }),
		entries[2],
	);
	// Sticky but excluded now: falls back to the first usable entry.
	assert.deepEqual(
		selectVirtualModelEntry({
			name: "fast", entries, sticky: PRO, usability: usabilityOf({ [key(PRO)]: "excluded" }),
		}),
		entries[0],
	);
	// Sticky but unavailable now.
	assert.deepEqual(
		selectVirtualModelEntry({
			name: "fast", entries, sticky: FLASH, usability: usabilityOf({ [key(FLASH)]: "unavailable" }),
		}),
		entries[0],
	);
	// Sticky model that is no longer in the list (the list was edited).
	assert.deepEqual(
		selectVirtualModelEntry({
			name: "fast",
			entries,
			sticky: { provider: "anthropic", modelId: "claude-retired" },
			usability: () => "usable",
		}),
		entries[0],
	);
	// A sticky model with the same provider but a different id is not the same entry.
	assert.deepEqual(
		selectVirtualModelEntry({
			name: "fast",
			entries: [entry(LUNA, "high"), entry(FLASH, "max")],
			sticky: PRO,
			usability: () => "usable",
		}),
		entries[0],
	);
});

test("selection with no usable entry names the virtual model and why each entry is unusable", () => {
	const entries = [entry(LUNA, "high"), entry(FLASH, "max")];
	assert.throws(
		() => selectVirtualModelEntry({
			name: "fast",
			entries,
			usability: usabilityOf({ [key(LUNA)]: "excluded", [key(FLASH)]: "unavailable" }),
		}),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /virtual\/fast/);
			assert.match(error.message, /openai-codex\/gpt-6\.1-luna[^]*excluded by model policy/);
			assert.match(error.message, /deepseek\/deepseek-flash[^]*unavailable/);
			return true;
		},
	);
	// A usable sticky outside the list cannot rescue an all-unusable list.
	assert.throws(
		() => selectVirtualModelEntry({
			name: "fast",
			entries,
			sticky: PRO,
			usability: (model) => key(model) === key(PRO) ? "usable" : "unavailable",
		}),
		/virtual\/fast/,
	);
});

test("isVirtualModel recognizes only the virtual provider", () => {
	assert.equal(isVirtualModel({ provider: "virtual", modelId: "fast" }), true);
	assert.equal(isVirtualModel({ provider: "openai-codex", modelId: "virtual" }), false);
	assert.equal(isVirtualModel({ provider: "virtual-lab", modelId: "fast" }), false);
});

test("parseVirtualModels parses entries into model references and thinking", () => {
	const parsed = parseVirtualModels({
		fast: [
			{ id: "openai-codex/gpt-6.1-luna", thinking: "high" },
			{ id: "deepseek/deepseek-flash", thinking: "max" },
		],
		"deep-review": [{ id: "openrouter/anthropic/claude-sonnet-4", thinking: "off" }],
	});
	assert.deepEqual(parsed, {
		fast: [
			{ model: LUNA, thinking: "high" },
			{ model: FLASH, thinking: "max" },
		],
		"deep-review": [{ model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" }, thinking: "off" }],
	});
	assert.deepEqual(parseVirtualModels({}), {});
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.doesNotThrow(() => parseVirtualModels({ fast: [{ id: "a/b", thinking: level }] }), level);
	}
});

test("parseVirtualModels rejects every malformed definition", () => {
	const ok = { id: "openai-codex/gpt-6.1-luna", thinking: "high" };
	const invalid: Array<[string, unknown]> = [
		["null", null],
		["array", [ok]],
		["string", "fast"],
		["uppercase name", { Fast: [ok] }],
		["underscore name", { fast_model: [ok] }],
		["space name", { "fast model": [ok] }],
		["slash name", { "virtual/fast": [ok] }],
		["empty name", { "": [ok] }],
		["empty list", { fast: [] }],
		["non-array list", { fast: ok }],
		["null entry", { fast: [null] }],
		["string entry", { fast: ["openai-codex/gpt-6.1-luna"] }],
		["extra entry field", { fast: [{ ...ok, extra: true }] }],
		["model field instead of id", { fast: [{ model: ok.id, thinking: "high" }] }],
		["missing thinking", { fast: [{ id: ok.id }] }],
		["missing id", { fast: [{ thinking: "high" }] }],
		["preset thinking", { fast: [{ id: ok.id, thinking: "preset" }] }],
		["inherit thinking", { fast: [{ id: ok.id, thinking: "inherit" }] }],
		["unknown thinking", { fast: [{ id: ok.id, thinking: "extreme" }] }],
		["numeric thinking", { fast: [{ id: ok.id, thinking: 3 }] }],
		["id without provider", { fast: [{ id: "gpt-6.1-luna", thinking: "high" }] }],
		["empty provider", { fast: [{ id: "/gpt-6.1-luna", thinking: "high" }] }],
		["empty model id", { fast: [{ id: "openai-codex/", thinking: "high" }] }],
		["virtual entry", { fast: [{ id: "virtual/other", thinking: "high" }] }],
		["self-referencing virtual entry", { fast: [{ id: "virtual/fast", thinking: "high" }] }],
		["inherit id", { fast: [{ id: "inherit", thinking: "high" }] }],
		["duplicate ids", { fast: [ok, { id: ok.id, thinking: "low" }] }],
		["one bad list among good", { fast: [ok], slow: [] }],
	];
	for (const [name, value] of invalid) {
		assert.throws(() => parseVirtualModels(value), Error, name);
	}
});

test("requireVirtualModelDefinition returns defined lists and rejects undefined names, including prototype keys", () => {
	const definitions = parseVirtualModels({ fast: [{ id: "deepseek/deepseek-flash", thinking: "max" }] });
	assert.deepEqual(requireVirtualModelDefinition(definitions, "fast"), [{ model: FLASH, thinking: "max" }]);
	for (const name of ["missing", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
		assert.throws(
			() => requireVirtualModelDefinition(definitions, name),
			(error: unknown) => error instanceof Error && error.message.includes(`virtual/${name}`),
			name,
		);
	}
});

// --- Pi registration and routing ---------------------------------------------

type RouterState = { thinking: string } | undefined;
type RouteResult = { model: Model<Api>; thinkingLevel: string; state?: RouterState };

function physicalModel(model: ModelReference): Model<Api> {
	return {
		provider: model.provider,
		id: model.modelId,
		name: model.modelId,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	} as unknown as Model<Api>;
}

function virtualModel(name: string): Model<Api> {
	return { ...physicalModel({ provider: "virtual", modelId: name }), api: "pi-virtual" } as unknown as Model<Api>;
}

function createFakePi() {
	const registered = new Map<string, ExtensionVirtualModel<RouterState>>();
	const calls: string[] = [];
	const pi = {
		registerVirtualModel(definition: ExtensionVirtualModel<RouterState>) {
			calls.push(`register ${definition.provider}/${definition.id}`);
			registered.set(`${definition.provider}/${definition.id}`, definition);
		},
		unregisterVirtualModel(provider: string, id: string) {
			calls.push(`unregister ${provider}/${id}`);
			registered.delete(`${provider}/${id}`);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, registered, calls };
}

function createFakeContext(catalogue: readonly ModelReference[], available: readonly ModelReference[]) {
	const all = catalogue.map(physicalModel);
	const availableKeys = new Set(available.map(key));
	const ctx = {
		hasUI: false,
		cwd: "/project",
		ui: { notify() {} },
		modelRegistry: {
			getAll: () => all,
			getAvailable: () => all.filter((model) => availableKeys.has(`${model.provider}/${model.id}`)),
			find: (provider: string, id: string) => all.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: Model<Api>) => availableKeys.has(`${model.provider}/${model.id}`),
		},
	};
	return ctx as unknown as ExtensionContext;
}

async function createAgentDir(policy: unknown): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "virtual-models-agent-"));
	await writePolicy(agentDir, policy);
	return agentDir;
}

async function writePolicy(agentDir: string, policy: unknown): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "pi-durable-subagents.json"),
		typeof policy === "string" ? policy : JSON.stringify(policy),
		"utf8",
	);
}

const FAST_POLICY = {
	virtualModels: {
		fast: [
			{ id: "openai-codex/gpt-6.1-luna", thinking: "high" },
			{ id: "deepseek/deepseek-flash", thinking: "max" },
		],
		careful: [{ id: "deepseek/deepseek-pro", thinking: "low" }],
	},
};
const ALL = [LUNA, FLASH, PRO];

type RouteRequestOverrides = {
	thinkingLevel?: string;
	reason?: "user" | "continuation" | "retry" | "direct";
	previous?: ModelReference;
	failed?: ModelReference;
	state?: RouterState;
};

async function route(
	fake: ReturnType<typeof createFakePi>,
	name: string,
	ctx: ExtensionContext,
	overrides: RouteRequestOverrides = {},
): Promise<RouteResult> {
	const definition = fake.registered.get(`virtual/${name}`);
	assert.ok(definition, `expected virtual/${name} to be registered`);
	const request = {
		model: virtualModel(name),
		thinkingLevel: overrides.thinkingLevel ?? "medium",
		reason: overrides.reason ?? "user",
		messages: [],
		...(overrides.previous === undefined ? {} : {
			previous: { model: physicalModel(overrides.previous), thinkingLevel: "minimal" },
		}),
		...(overrides.failed === undefined ? {} : {
			failed: {
				model: physicalModel(overrides.failed),
				thinkingLevel: "minimal",
				message: { role: "assistant", stopReason: "error", errorMessage: "overloaded", content: [] },
			},
		}),
		...(overrides.state === undefined ? {} : { state: overrides.state }),
	};
	return await definition.route(request as never, ctx) as RouteResult;
}

const routedKey = (result: RouteResult) => `${result.model.provider}/${result.model.id}`;

test("the registrar registers one virtual model per policy name under the virtual provider", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	assert.deepEqual([...fake.registered.keys()].sort(), ["virtual/careful", "virtual/fast"]);
	const fast = fake.registered.get("virtual/fast");
	assert.equal(fast?.provider, "virtual");
	assert.equal(fast?.id, "fast");
	assert.equal(fast?.name, "fast");
	assert.ok(Array.isArray(fast?.thinkingLevels) && fast.thinkingLevels.length > 0);
});

test("a registrar with no policy file registers nothing", { timeout: 5_000 }, async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "virtual-models-empty-"));
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	assert.equal(fake.registered.size, 0);
});

test("sync registers added names and unregisters removed ones", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	const registrar = await VirtualModelRegistrar.create(fake.pi, agentDir);
	await writePolicy(agentDir, {
		virtualModels: { fast: FAST_POLICY.virtualModels.fast, cheap: [{ id: "deepseek/deepseek-flash", thinking: "low" }] },
	});
	await registrar.sync(agentDir);
	assert.deepEqual([...fake.registered.keys()].sort(), ["virtual/cheap", "virtual/fast"]);
	assert.ok(fake.calls.includes("unregister virtual/careful"));

	await writePolicy(agentDir, {});
	await registrar.sync(agentDir);
	assert.deepEqual([...fake.registered.keys()], []);
});

test("explicit mode routes to the first usable entry with the selected thinking level", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	const ctx = createFakeContext(ALL, ALL);
	const result = await route(fake, "fast", ctx, { thinkingLevel: "low" });
	assert.equal(routedKey(result), "openai-codex/gpt-6.1-luna");
	assert.equal(result.thinkingLevel, "low");
	// The returned model is a physical model, never the virtual one.
	assert.notEqual(result.model.provider, "virtual");
	assert.notEqual(result.model.api, "pi-virtual");
});

test("preset mode routes with the routed entry's own thinking level", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir, "preset");
	const ctx = createFakeContext(ALL, ALL);
	const first = await route(fake, "fast", ctx, { thinkingLevel: "low" });
	assert.equal(routedKey(first), "openai-codex/gpt-6.1-luna");
	assert.equal(first.thinkingLevel, "high");

	// When the first entry is unavailable, the thinking follows the entry that serves.
	const withoutLuna = createFakeContext(ALL, [FLASH, PRO]);
	const second = await route(fake, "fast", withoutLuna, { thinkingLevel: "low" });
	assert.equal(routedKey(second), "deepseek/deepseek-flash");
	assert.equal(second.thinkingLevel, "max");
});

test("routing skips entries excluded by policy globs and entries without credentials or catalogue presence", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir({ ...FAST_POLICY, excludedModels: ["openai-codex/*"] });
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	const excluded = await route(fake, "fast", createFakeContext(ALL, ALL));
	assert.equal(routedKey(excluded), "deepseek/deepseek-flash");

	await writePolicy(agentDir, FAST_POLICY);
	// Catalogued but no credentials.
	const noAuth = await route(fake, "fast", createFakeContext(ALL, [FLASH]));
	assert.equal(routedKey(noAuth), "deepseek/deepseek-flash");
	// Not in the catalogue at all (a retired model).
	const retired = await route(fake, "fast", createFakeContext([FLASH, PRO], [FLASH, PRO]));
	assert.equal(routedKey(retired), "deepseek/deepseek-flash");
});

test("routing fails naming the virtual model when no entry is usable", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir({ ...FAST_POLICY, excludedModels: ["openai-codex/gpt-6.1-luna"] });
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	await assert.rejects(
		async () => route(fake, "fast", createFakeContext(ALL, [PRO])),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /virtual\/fast/);
			assert.match(error.message, /excluded by model policy/);
			assert.match(error.message, /unavailable/);
			return true;
		},
	);
});

test("continuations stick to the previous model and retries to the failed model while still usable", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir, "preset");
	const ctx = createFakeContext(ALL, ALL);

	const continuation = await route(fake, "fast", ctx, { reason: "continuation", previous: FLASH });
	assert.equal(routedKey(continuation), "deepseek/deepseek-flash");
	assert.equal(continuation.thinkingLevel, "max");

	const retry = await route(fake, "fast", ctx, { reason: "retry", failed: FLASH, previous: LUNA });
	assert.equal(routedKey(retry), "deepseek/deepseek-flash");

	// A previous model that is not an entry does not stick.
	const foreign = await route(fake, "fast", ctx, { reason: "continuation", previous: PRO });
	assert.equal(routedKey(foreign), "openai-codex/gpt-6.1-luna");

	// A previous model that lost its credentials does not stick.
	const lost = await route(fake, "fast", createFakeContext(ALL, [LUNA, PRO]), {
		reason: "continuation", previous: FLASH,
	});
	assert.equal(routedKey(lost), "openai-codex/gpt-6.1-luna");
});

test("a previous model that the policy now excludes no longer sticks", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	const ctx = createFakeContext(ALL, ALL);
	await writePolicy(agentDir, { ...FAST_POLICY, excludedModels: ["deepseek/deepseek-flash"] });
	const result = await route(fake, "fast", ctx, { reason: "continuation", previous: FLASH });
	assert.equal(routedKey(result), "openai-codex/gpt-6.1-luna");
});

test("each route re-reads the policy file, so an edited entry list applies on the next request", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir, "preset");
	const ctx = createFakeContext(ALL, ALL);
	assert.equal(routedKey(await route(fake, "fast", ctx)), "openai-codex/gpt-6.1-luna");

	// Retire Luna in one place; no sync is needed for existing names.
	await writePolicy(agentDir, {
		virtualModels: { ...FAST_POLICY.virtualModels, fast: [{ id: "deepseek/deepseek-pro", thinking: "minimal" }] },
	});
	const edited = await route(fake, "fast", ctx);
	assert.equal(routedKey(edited), "deepseek/deepseek-pro");
	assert.equal(edited.thinkingLevel, "minimal");

	// Exclusions edited in the file also apply on the next request.
	await writePolicy(agentDir, { ...FAST_POLICY, excludedModels: ["openai-codex/*"] });
	assert.equal(routedKey(await route(fake, "fast", ctx)), "deepseek/deepseek-flash");
});

test("an invalid policy edit keeps the last valid definitions for routing", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir, "preset");
	const ctx = createFakeContext(ALL, ALL);
	assert.equal(routedKey(await route(fake, "fast", ctx)), "openai-codex/gpt-6.1-luna");

	for (const invalid of [
		"{not json",
		JSON.stringify({ virtualModels: { fast: [] } }),
		JSON.stringify({ virtualModels: { fast: [{ id: "virtual/fast", thinking: "high" }] } }),
		JSON.stringify({ unknownField: true }),
	]) {
		await writePolicy(agentDir, invalid);
		const result = await route(fake, "fast", ctx);
		assert.equal(routedKey(result), "openai-codex/gpt-6.1-luna", invalid);
		assert.equal(result.thinkingLevel, "high", invalid);
	}
});

test("a manual thinking switch in preset mode persists explicit thinking as router state", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	const registrar = await VirtualModelRegistrar.create(fake.pi, agentDir, "preset");
	const ctx = createFakeContext(ALL, ALL);
	const before = await route(fake, "fast", ctx, { thinkingLevel: "low" });
	assert.equal(before.thinkingLevel, "high");
	assert.notDeepEqual(before.state, { thinking: "explicit" });

	registrar.switchToExplicitThinking();
	// A direct request (e.g. a compaction summary) cannot store state, so it must not
	// consume the pending switch.
	await route(fake, "fast", ctx, { reason: "direct", thinkingLevel: "low" });
	const switched = await route(fake, "fast", ctx, { thinkingLevel: "low" });
	assert.deepEqual(switched.state, { thinking: "explicit" });
	assert.equal(switched.thinkingLevel, "low");

	// Later requests on the branch carry the stored state and stay explicit.
	const later = await route(fake, "fast", ctx, {
		thinkingLevel: "minimal", reason: "continuation", previous: FLASH, state: { thinking: "explicit" },
	});
	assert.equal(routedKey(later), "deepseek/deepseek-flash");
	assert.equal(later.thinkingLevel, "minimal");
	const laterDirect = await route(fake, "fast", ctx, { reason: "direct", thinkingLevel: "medium" });
	assert.equal(laterDirect.thinkingLevel, "medium");
});

test("a preset registrar resumed on a branch whose state says explicit routes explicitly thereafter", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir, "preset");
	const ctx = createFakeContext(ALL, ALL);
	const resumed = await route(fake, "fast", ctx, { thinkingLevel: "low", state: { thinking: "explicit" } });
	assert.equal(routedKey(resumed), "openai-codex/gpt-6.1-luna");
	assert.equal(resumed.thinkingLevel, "low");

	// A direct request carries no state; the branch's explicit choice still holds.
	const direct = await route(fake, "fast", ctx, { reason: "direct", thinkingLevel: "minimal" });
	assert.equal(direct.thinkingLevel, "minimal");
});

test("an explicit registrar ignores the switch and keeps the selected thinking level", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	const registrar = await VirtualModelRegistrar.create(fake.pi, agentDir);
	const ctx = createFakeContext(ALL, ALL);
	registrar.switchToExplicitThinking();
	const result = await route(fake, "fast", ctx, { thinkingLevel: "xhigh" });
	assert.equal(result.thinkingLevel, "xhigh");
});

test("a user request starts from the first usable entry even after another entry answered", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	const ctx = createFakeContext(ALL, ALL);
	const result = await route(fake, "fast", ctx, { reason: "user", previous: FLASH });
	assert.equal(routedKey(result), "openai-codex/gpt-6.1-luna");
});

test("a name removed from a valid policy file stops routing before the next sync", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	const ctx = createFakeContext(ALL, ALL);
	await writePolicy(agentDir, { virtualModels: { fast: FAST_POLICY.virtualModels.fast } });
	await assert.rejects(async () => route(fake, "careful", ctx), /virtual\/careful/);
});
