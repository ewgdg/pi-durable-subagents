import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	VIRTUAL_MODEL_STATE_ENTRY,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionVirtualModel,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { VirtualModelRegistrar } from "../src/pi-integration/virtual-model-registration.ts";
import { thinkingModeState } from "../src/pi-integration/recorded-model-selection.ts";
import type { ModelReference } from "../src/protocol/runtime-configuration.ts";

const LUNA: ModelReference = { provider: "openai-codex", modelId: "gpt-6.1-luna" };
const FLASH: ModelReference = { provider: "deepseek", modelId: "deepseek-flash" };
const PRO: ModelReference = { provider: "deepseek", modelId: "deepseek-pro" };
const ALL = [LUNA, FLASH, PRO];
const key = (model: ModelReference) => `${model.provider}/${model.modelId}`;

const FAST_POLICY = {
	virtualModels: {
		fast: [
			{ id: key(LUNA), thinking: "high" },
			{ id: key(FLASH), thinking: "max" },
		],
		careful: [{ id: key(PRO), thinking: "low" }],
	},
};

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

function createFakePi() {
	const registered = new Map<string, ExtensionVirtualModel>();
	const pi = {
		registerVirtualModel(definition: ExtensionVirtualModel) {
			registered.set(`${definition.provider}/${definition.id}`, definition);
		},
		unregisterVirtualModel(provider: string, id: string) {
			registered.delete(`${provider}/${id}`);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, registered };
}

function createFakeContext(
	catalogue: readonly ModelReference[],
	available: readonly ModelReference[],
	notifications: string[] = [],
	hasUI = false,
	branch: readonly SessionEntry[] = [],
) {
	const all = catalogue.map(physicalModel);
	const availableKeys = new Set(available.map(key));
	return {
		hasUI,
		cwd: "/project",
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getBranch: () => [...branch] },
		modelRegistry: {
			getAll: () => all,
			getAvailable: () => all.filter((model) => availableKeys.has(`${model.provider}/${model.id}`)),
			find: (provider: string, id: string) => all.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: Model<Api>) => availableKeys.has(`${model.provider}/${model.id}`),
		},
	} as unknown as ExtensionContext;
}

function thinkingModeEntry(name: string, mode: "preset" | "explicit"): SessionEntry {
	return {
		type: "custom",
		id: `${name}-${mode}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: VIRTUAL_MODEL_STATE_ENTRY,
		data: thinkingModeState({ provider: "virtual", modelId: name }, mode),
	};
}

async function writePolicy(agentDir: string, policy: unknown): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "pi-durable-subagents.json"),
		typeof policy === "string" ? policy : JSON.stringify(policy),
		"utf8",
	);
}

async function createAgentDir(policy?: unknown): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "virtual-models-agent-"));
	if (policy !== undefined) await writePolicy(agentDir, policy);
	return agentDir;
}

type RouteRequest = {
	thinkingLevel?: string;
	reason?: "user" | "continuation" | "retry" | "direct";
	previous?: ModelReference;
	failed?: ModelReference;
};
type RouteResult = { model: Model<Api>; thinkingLevel: string };

async function route(
	fake: ReturnType<typeof createFakePi>,
	name: string,
	ctx: ExtensionContext,
	request: RouteRequest = {},
): Promise<RouteResult> {
	const definition = fake.registered.get(`virtual/${name}`);
	assert.ok(definition, `expected virtual/${name} to be registered`);
	return await definition.route({
		model: { ...physicalModel({ provider: "virtual", modelId: name }), api: "pi-virtual" },
		thinkingLevel: request.thinkingLevel ?? "medium",
		reason: request.reason ?? "user",
		messages: [],
		...(request.previous === undefined ? {} : {
			previous: { model: physicalModel(request.previous), thinkingLevel: "minimal" },
		}),
		...(request.failed === undefined ? {} : {
			failed: {
				model: physicalModel(request.failed),
				thinkingLevel: "minimal",
				message: { role: "assistant", stopReason: "error", errorMessage: "overloaded", content: [] },
			},
		}),
	} as never, ctx) as RouteResult;
}

const routedKey = (result: RouteResult) => `${result.model.provider}/${result.model.id}`;

test("the registrar registers each policy name under the virtual provider and follows syncs", { timeout: 5_000 }, async () => {
	const empty = createFakePi();
	await VirtualModelRegistrar.create(empty.pi, await createAgentDir());
	assert.equal(empty.registered.size, 0, "a missing policy file registers nothing");

	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	const registrar = await VirtualModelRegistrar.create(fake.pi, agentDir);
	assert.deepEqual([...fake.registered.keys()].sort(), ["virtual/careful", "virtual/fast"]);
	const fast = fake.registered.get("virtual/fast");
	assert.deepEqual({ provider: fast?.provider, id: fast?.id, name: fast?.name }, {
		provider: "virtual", id: "fast", name: "fast",
	});
	assert.ok(Array.isArray(fast?.thinkingLevels) && fast.thinkingLevels.length > 0);

	// A name removed from a valid file stops routing even before the next sync.
	const cheap = [{ id: key(FLASH), thinking: "low" }];
	await writePolicy(agentDir, { virtualModels: { fast: FAST_POLICY.virtualModels.fast, cheap } });
	await assert.rejects(async () => route(fake, "careful", createFakeContext(ALL, ALL)), /virtual\/careful/);

	await registrar.sync(agentDir);
	assert.deepEqual([...fake.registered.keys()].sort(), ["virtual/cheap", "virtual/fast"]);
	await writePolicy(agentDir, {});
	await registrar.sync(agentDir);
	assert.deepEqual([...fake.registered.keys()], []);
});

test("each request re-reads the policy and routes to the sticky or first usable entry", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	const excluding = (excludedModels: string[]) => ({ ...FAST_POLICY, excludedModels });
	const cases: Array<{
		name: string;
		policy?: unknown;
		catalogue?: ModelReference[];
		available?: ModelReference[];
		request?: RouteRequest;
		expected: ModelReference;
	}> = [
		{ name: "first usable entry", expected: LUNA },
		{ name: "provider glob exclusion", policy: excluding(["openai-codex/*"]), expected: FLASH },
		{ name: "exact exclusion", policy: excluding([key(LUNA)]), expected: FLASH },
		{ name: "catalogued without credentials", available: [FLASH, PRO], expected: FLASH },
		{ name: "retired from the catalogue", catalogue: [FLASH, PRO], available: [FLASH, PRO], expected: FLASH },
		{
			name: "edited entry list applies without sync",
			policy: { virtualModels: { ...FAST_POLICY.virtualModels, fast: [{ id: key(PRO), thinking: "low" }] } },
			expected: PRO,
		},
		{ name: "continuation sticks to previous", request: { reason: "continuation", previous: FLASH }, expected: FLASH },
		{ name: "retry sticks to failed over previous", request: { reason: "retry", failed: FLASH, previous: LUNA }, expected: FLASH },
		{ name: "user request does not stick", request: { reason: "user", previous: FLASH }, expected: LUNA },
		{ name: "previous outside the list does not stick", request: { reason: "continuation", previous: PRO }, expected: LUNA },
		{
			name: "previous without credentials does not stick",
			available: [LUNA, PRO],
			request: { reason: "continuation", previous: FLASH },
			expected: LUNA,
		},
		{
			name: "previous now excluded does not stick",
			policy: excluding([key(FLASH)]),
			request: { reason: "continuation", previous: FLASH },
			expected: LUNA,
		},
	];
	for (const routingCase of cases) {
		await writePolicy(agentDir, routingCase.policy ?? FAST_POLICY);
		const ctx = createFakeContext(routingCase.catalogue ?? ALL, routingCase.available ?? ALL);
		const result = await route(fake, "fast", ctx, routingCase.request);
		assert.equal(routedKey(result), key(routingCase.expected), routingCase.name);
		// Routing returns a physical model, never the virtual one.
		assert.notEqual(result.model.api, "pi-virtual", routingCase.name);
	}
});

test("routing fails naming the virtual model and why each entry is unusable", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir({ ...FAST_POLICY, excludedModels: [key(LUNA)] });
	const fake = createFakePi();
	await VirtualModelRegistrar.create(fake.pi, agentDir);
	await assert.rejects(
		// FLASH has no credentials; a usable model outside the list cannot rescue it.
		async () => route(fake, "fast", createFakeContext(ALL, [PRO]), { reason: "continuation", previous: PRO }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /virtual\/fast/);
			assert.match(error.message, /openai-codex\/gpt-6\.1-luna[^]*excluded by model policy/);
			assert.match(error.message, /deepseek\/deepseek-flash[^]*unavailable/);
			return true;
		},
	);
});

test("preset thinking applies only to the named virtual model until the switch to explicit", { timeout: 5_000 }, async () => {
	const agentDir = await createAgentDir(FAST_POLICY);
	const ctx = createFakeContext(ALL, ALL);
	const thinkingFor = async (
		fake: ReturnType<typeof createFakePi>,
		name: string,
		context = ctx,
		request: RouteRequest = {},
	) => (await route(fake, name, context, { thinkingLevel: "minimal", ...request })).thinkingLevel;

	const explicit = createFakePi();
	await VirtualModelRegistrar.create(explicit.pi, agentDir);
	assert.equal(await thinkingFor(explicit, "fast"), "minimal", "no preset: the selected level");

	const branch: SessionEntry[] = [];
	const recordMode = (mode: "preset" | "explicit") => branch.push(thinkingModeEntry("fast", mode));
	const presetContext = createFakeContext(ALL, ALL, [], false, branch);
	recordMode("preset");
	assert.equal(await thinkingFor(explicit, "fast", presetContext), "high", "preset: the routed entry's level");
	assert.equal(
		await thinkingFor(explicit, "fast", createFakeContext(ALL, [FLASH, PRO], [], false, branch)),
		"max",
		"preset follows the serving entry",
	);
	assert.equal(
		await thinkingFor(explicit, "fast", presetContext, { reason: "continuation", previous: FLASH }),
		"max",
		"preset follows a sticky entry",
	);
	assert.equal(await thinkingFor(explicit, "careful", presetContext), "minimal", "another virtual name routes explicitly");

	recordMode("explicit");
	assert.equal(await thinkingFor(explicit, "fast", presetContext), "minimal", "after the switch: the selected level");
	assert.equal(await thinkingFor(explicit, "fast", presetContext, { reason: "direct" }), "minimal");
});

test("an invalid policy edit keeps the last valid definitions and is reported once per routing process", { timeout: 5_000 }, async (t) => {
	const invalidEdits = [
		"{not json",
		JSON.stringify({ virtualModels: { fast: [] } }),
		JSON.stringify({ virtualModels: { fast: [{ id: "virtual/fast", thinking: "high" }] } }),
	];
	for (const hasUI of [true, false]) {
		const agentDir = await createAgentDir(FAST_POLICY);
		const fake = createFakePi();
		const registrar = await VirtualModelRegistrar.create(fake.pi, agentDir);
		const notifications: string[] = [];
		const stderr: string[] = [];
		const write = t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		});
		try {
			// Sync is silent about an invalid file and keeps the registrations.
			await writePolicy(agentDir, invalidEdits[0]);
			await registrar.sync(agentDir);
			assert.deepEqual([...fake.registered.keys()].sort(), ["virtual/careful", "virtual/fast"]);
			assert.deepEqual({ notifications, stderr }, { notifications: [], stderr: [] }, `hasUI: ${hasUI}`);

			const ctx = createFakeContext(ALL, ALL, notifications, hasUI, [thinkingModeEntry("fast", "preset")]);
			for (const [index, invalid] of invalidEdits.entries()) {
				await writePolicy(agentDir, invalid);
				for (let request = 0; request < 2; request += 1) {
					const result = await route(fake, "fast", ctx);
					assert.equal(routedKey(result), key(LUNA), invalid);
					assert.equal(result.thinkingLevel, "high", invalid);
				}
				if (index === 0) {
					// Two requests against the same invalid file produce one report.
					const reports = hasUI ? notifications : stderr;
					assert.equal(reports.length, 1, `hasUI: ${hasUI}: ${JSON.stringify(reports)}`);
					assert.deepEqual(hasUI ? stderr : notifications, [], `hasUI: ${hasUI}: reported on one channel`);
				}
			}
		} finally {
			write.mock.restore();
		}
	}
});
