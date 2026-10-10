import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	DEFAULT_WORKFLOW_POLICY,
	WorkflowPolicyStore,
	parseWorkflowPolicy,
	readWorkflowPolicy,
	writeExcludedModels,
	writeVirtualModels,
} from "../src/policy/workflow-policy.ts";
import type { VirtualModelDefinitions } from "../src/policy/virtual-models.ts";
import { createUnboundTestOwnerHost } from "./support/pi-host.ts";

test("strict Workflow Policy parsing fills defaults and freezes one complete snapshot", () => {
	const defaults = parseWorkflowPolicy("{}");
	assert.deepEqual(defaults, {
		maxConcurrentAgentRuns: 8,
		maxPendingDeliveriesPerAgent: 256,
		deliveryProgressIntervalMs: 60_000,
		operationReviewIntervalMs: 600_000,
		excludedModels: [],
		virtualModels: {},
	});
	assert.equal(Object.isFrozen(defaults), true);

	const configured = parseWorkflowPolicy(JSON.stringify({
		maxConcurrentAgentRuns: 3,
		maxPendingDeliveriesPerAgent: 17,
		deliveryProgressIntervalMs: 60_000,
		operationReviewIntervalMs: 1_000,
		excludedModels: ["openai-codex/*", "openrouter/anthropic/claude-sonnet-4"],
	}));
	assert.deepEqual(configured, {
		maxConcurrentAgentRuns: 3,
		maxPendingDeliveriesPerAgent: 17,
		deliveryProgressIntervalMs: 60_000,
		operationReviewIntervalMs: 1_000,
		excludedModels: ["openai-codex/*", "openrouter/anthropic/claude-sonnet-4"],
		virtualModels: {},
	});
	assert.equal(Object.isFrozen(configured.excludedModels), true);
	assert.equal(Object.isFrozen(configured), true);
	assert.equal(Object.isFrozen(DEFAULT_WORKFLOW_POLICY), true);
});

test("strict Workflow Policy parsing rejects the complete invalid document", () => {
	const invalidPolicies = [
		["non-object", "[]"],
		["unknown field", '{"maxPendingDeliveriesPerAgent": 8, "extra": true}'],
		["duplicate key", '{"maxPendingDeliveriesPerAgent": 8, "maxPendingDeliveriesPerAgent": 4}'],
		["comment", '{"maxPendingDeliveriesPerAgent": 8 /* no comments */}'],
		["trailing comma", '{"maxPendingDeliveriesPerAgent": 8,}'],
		["wrong type", '{"maxPendingDeliveriesPerAgent": "8"}'],
		["null delivery limit", '{"maxPendingDeliveriesPerAgent": null}'],
		["null review interval", '{"operationReviewIntervalMs": null}'],
		["zero delivery limit", '{"maxPendingDeliveriesPerAgent": 0}'],
		["fractional delivery limit", '{"maxPendingDeliveriesPerAgent": 1.5}'],
		["zero concurrency bound", '{"maxConcurrentAgentRuns": 0}'],
		["fractional concurrency bound", '{"maxConcurrentAgentRuns": 2.5}'],
		["null concurrency bound", '{"maxConcurrentAgentRuns": null}'],
		["unsafe delivery limit", `{"maxPendingDeliveriesPerAgent": ${Number.MAX_SAFE_INTEGER + 1}}`],
		["null delivery interval", '{"deliveryProgressIntervalMs": null}'],
		["short delivery interval", '{"deliveryProgressIntervalMs": 999}'],
		["long delivery interval", '{"deliveryProgressIntervalMs": 2147483648}'],
		["fractional delivery interval", '{"deliveryProgressIntervalMs": 1000.5}'],
		["short review interval", '{"operationReviewIntervalMs": 999}'],
		["long review interval", '{"operationReviewIntervalMs": 2147483648}'],
		["null excluded models", '{"excludedModels": null}'],
		["non-array excluded models", '{"excludedModels": "openai-codex/*"}'],
		["non-string excluded model", '{"excludedModels": [42]}'],
		["empty excluded model", '{"excludedModels": [""]}'],
		["excluded model without provider", '{"excludedModels": ["openai-codex"]}'],
		["excluded model with empty provider", '{"excludedModels": ["/gpt-6-astra"]}'],
		["excluded model with empty model id", '{"excludedModels": ["openai-codex/"]}'],
		["bare wildcard", '{"excludedModels": ["*"]}'],
		["wildcard provider", '{"excludedModels": ["*/gpt-6-astra"]}'],
		["wildcard model segment", '{"excludedModels": ["openai-codex/gpt*"]}'],
		["partial provider wildcard", '{"excludedModels": ["openai-codex*/*"]}'],
		["whitespace in excluded model", '{"excludedModels": ["openai-codex/ gpt-6-astra"]}'],
		["duplicate excluded model", '{"excludedModels": ["openai-codex/*", "openai-codex/*"]}'],
	] as const;

	for (const [name, source] of invalidPolicies) {
		assert.throws(() => parseWorkflowPolicy(source), Error, name);
	}
});

test("Workflow Policy loads only the exact optional user file", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		processVisibleModel: false,
	});
	const expectedPolicyPath = join(
		host.services.agentDir,
		"config",
		"pi-durable-subagents.json",
	);
	const missing = await readWorkflowPolicy(host.services.agentDir);
	assert.equal(missing.ok, true);
	if (!missing.ok) throw new Error("Expected a missing optional policy to use defaults");
	assert.deepEqual(missing.snapshot, DEFAULT_WORKFLOW_POLICY);

	await mkdir(join(host.services.agentDir, "config"), { recursive: true });
	await writeFile(
		expectedPolicyPath,
		'{"maxPendingDeliveriesPerAgent": 2, "operationReviewIntervalMs": 1200}',
		"utf8",
	);
	const loaded = await readWorkflowPolicy(host.services.agentDir);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) throw new Error("Expected the configured policy to load");
	assert.deepEqual(loaded.snapshot, {
		maxConcurrentAgentRuns: 8,
		maxPendingDeliveriesPerAgent: 2,
		deliveryProgressIntervalMs: 60_000,
		operationReviewIntervalMs: 1_200,
		excludedModels: [],
		virtualModels: {},
	});
});

test("Workflow Policy reload publication replaces or preserves one whole snapshot", () => {
	const initial = parseWorkflowPolicy('{"maxPendingDeliveriesPerAgent": 2}');
	const store = new WorkflowPolicyStore(initial);
	assert.equal(store.current(), initial);

	const replacement = parseWorkflowPolicy(
		'{"maxPendingDeliveriesPerAgent": 4, "operationReviewIntervalMs": 1000}',
	);
	store.publish(replacement);
	assert.equal(store.current(), replacement);
	assert.deepEqual(store.current(), {
		maxConcurrentAgentRuns: 8,
		maxPendingDeliveriesPerAgent: 4,
		deliveryProgressIntervalMs: 60_000,
		operationReviewIntervalMs: 1_000,
		excludedModels: [],
		virtualModels: {},
	});
});

test("excluded models are written atomically and preserve unrelated policy fields", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		processVisibleModel: false,
	});
	const policyDirectory = join(host.services.agentDir, "config");
	const policyPath = join(policyDirectory, "pi-durable-subagents.json");

	await writeExcludedModels(host.services.agentDir, ["openai-codex/*"]);
	const created = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
	assert.deepEqual(created, { excludedModels: ["openai-codex/*"] });

	await writeFile(
		policyPath,
		'{\n  "maxPendingDeliveriesPerAgent": 4,\n  "excludedModels": ["openai-codex/*"]\n}\n',
		"utf8",
	);
	await writeExcludedModels(host.services.agentDir, [
		"openai-codex/*",
		"deepseek/deepseek-v4-flash",
	]);
	assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), {
		maxPendingDeliveriesPerAgent: 4,
		excludedModels: ["openai-codex/*", "deepseek/deepseek-v4-flash"],
	});

	// An empty list removes the field so the file keeps only explicit values.
	await writeExcludedModels(host.services.agentDir, []);
	assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), {
		maxPendingDeliveriesPerAgent: 4,
	});

	const loaded = await readWorkflowPolicy(host.services.agentDir);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) throw new Error("Expected the written policy to load");
	assert.deepEqual(loaded.snapshot.excludedModels, []);
});

test("an invalid exclusion entry or unreadable policy refuses the write", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		processVisibleModel: false,
	});
	const policyDirectory = join(host.services.agentDir, "config");
	const policyPath = join(policyDirectory, "pi-durable-subagents.json");
	await mkdir(policyDirectory, { recursive: true });
	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 4}', "utf8");

	await assert.rejects(
		() => writeExcludedModels(host.services.agentDir, ["openai-codex"]),
		/Workflow Policy excludedModels entries must be/,
	);
	assert.equal(await readFile(policyPath, "utf8"), '{"maxPendingDeliveriesPerAgent": 4}');

	await writeFile(policyPath, "{not json", "utf8");
	await assert.rejects(
		() => writeExcludedModels(host.services.agentDir, ["openai-codex/*"]),
		/Workflow Policy must be strict JSON/,
	);
	assert.equal(await readFile(policyPath, "utf8"), "{not json");
});

test("Workflow Policy parses virtual models into frozen model and thinking entries", () => {
	const policy = parseWorkflowPolicy(JSON.stringify({
		excludedModels: ["openai-codex/*"],
		virtualModels: {
			fast: [
				{ id: "openai-codex/gpt-6.1-luna", thinking: "high" },
				{ id: "deepseek/deepseek-flash", thinking: "max" },
			],
			"deep-review": [{ id: "openrouter/anthropic/claude-sonnet-4", thinking: "off" }],
		},
	}));
	assert.deepEqual(policy.virtualModels, {
		fast: [
			{ model: { provider: "openai-codex", modelId: "gpt-6.1-luna" }, thinking: "high" },
			{ model: { provider: "deepseek", modelId: "deepseek-flash" }, thinking: "max" },
		],
		"deep-review": [
			{ model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" }, thinking: "off" },
		],
	});
	// A virtual entry may name an excluded model; exclusion applies at routing time.
	assert.deepEqual(policy.excludedModels, ["openai-codex/*"]);
	assert.equal(Object.isFrozen(policy.virtualModels), true);
	assert.equal(Object.isFrozen(policy.virtualModels.fast), true);
	assert.equal(Object.isFrozen(DEFAULT_WORKFLOW_POLICY.virtualModels), true);
	assert.deepEqual(DEFAULT_WORKFLOW_POLICY.virtualModels, {});
});

test("an invalid virtual model definition rejects the complete Workflow Policy", () => {
	const ok = { id: "openai-codex/gpt-6.1-luna", thinking: "high" };
	const withFast = (entry: unknown) => JSON.stringify({ virtualModels: { fast: [entry] } });
	const invalidPolicies: Array<[string, string]> = [
		["null virtual models", '{"virtualModels": null}'],
		["array virtual models", `{"virtualModels": [${JSON.stringify(ok)}]}`],
		["string virtual models", '{"virtualModels": "fast"}'],
		["uppercase name", JSON.stringify({ virtualModels: { Fast: [ok] } })],
		["underscore name", JSON.stringify({ virtualModels: { fast_model: [ok] } })],
		["slash name", JSON.stringify({ virtualModels: { "virtual/fast": [ok] } })],
		["empty name", JSON.stringify({ virtualModels: { "": [ok] } })],
		["empty list", JSON.stringify({ virtualModels: { fast: [] } })],
		["non-array list", JSON.stringify({ virtualModels: { fast: ok } })],
		["one bad list among good", JSON.stringify({ virtualModels: { fast: [ok], slow: [] } })],
		["null entry", withFast(null)],
		["string entry", withFast(ok.id)],
		["extra entry field", withFast({ ...ok, note: "x" })],
		["model field instead of id", withFast({ model: ok.id, thinking: "high" })],
		["missing thinking", withFast({ id: ok.id })],
		["missing id", withFast({ thinking: "high" })],
		["preset thinking", withFast({ id: ok.id, thinking: "preset" })],
		["inherit thinking", withFast({ id: ok.id, thinking: "inherit" })],
		["unknown thinking", withFast({ id: ok.id, thinking: "extreme" })],
		["numeric thinking", withFast({ id: ok.id, thinking: 3 })],
		["virtual entry", withFast({ id: "virtual/slow", thinking: "high" })],
		["self-referencing entry", withFast({ id: "virtual/fast", thinking: "high" })],
		["inherit id", withFast({ id: "inherit", thinking: "high" })],
		["id without provider", withFast({ id: "luna", thinking: "high" })],
		["empty provider", withFast({ id: "/luna", thinking: "high" })],
		["empty model id", withFast({ id: "openai-codex/", thinking: "high" })],
		["duplicate entry ids", JSON.stringify({ virtualModels: { fast: [ok, { ...ok, thinking: "low" }] } })],
		["duplicate names", `{"virtualModels": {"fast": [${JSON.stringify(ok)}], "fast": [${JSON.stringify(ok)}]}}`],
		["valid virtual models next to an invalid field", JSON.stringify({ virtualModels: { fast: [ok] }, excludedModels: ["*"] })],
	];
	for (const [name, source] of invalidPolicies) {
		assert.throws(() => parseWorkflowPolicy(source), Error, name);
	}
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.doesNotThrow(() => parseWorkflowPolicy(withFast({ id: ok.id, thinking: level })), level);
	}
});

test("writing excluded models preserves valid virtual models and refuses an invalid definition", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		processVisibleModel: false,
	});
	const policyDirectory = join(host.services.agentDir, "config");
	const policyPath = join(policyDirectory, "pi-durable-subagents.json");
	const virtualModels = {
		fast: [
			{ id: "openai-codex/gpt-6.1-luna", thinking: "high" },
			{ id: "deepseek/deepseek-flash", thinking: "max" },
		],
	};
	await mkdir(policyDirectory, { recursive: true });
	await writeFile(policyPath, JSON.stringify({ virtualModels }), "utf8");

	await writeExcludedModels(host.services.agentDir, ["openai-codex/*"]);
	assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), {
		virtualModels,
		excludedModels: ["openai-codex/*"],
	});
	await writeExcludedModels(host.services.agentDir, []);
	assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), { virtualModels });

	const loaded = await readWorkflowPolicy(host.services.agentDir);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) throw new Error("Expected the written policy to load");
	assert.deepEqual(loaded.snapshot.virtualModels, {
		fast: [
			{ model: { provider: "openai-codex", modelId: "gpt-6.1-luna" }, thinking: "high" },
			{ model: { provider: "deepseek", modelId: "deepseek-flash" }, thinking: "max" },
		],
	});

	// An invalid definition on disk fails the read and refuses the write untouched.
	const invalid = JSON.stringify({ virtualModels: { fast: [] } });
	await writeFile(policyPath, invalid, "utf8");
	assert.equal((await readWorkflowPolicy(host.services.agentDir)).ok, false);
	await assert.rejects(() => writeExcludedModels(host.services.agentDir, ["openai-codex/*"]));
	assert.equal(await readFile(policyPath, "utf8"), invalid);
});

function virtualDefinitions(source: Record<string, ReadonlyArray<readonly [string, string]>>): VirtualModelDefinitions {
	return Object.fromEntries(Object.entries(source).map(([name, entries]) => [name, entries.map(([id, thinking]) => {
		const separator = id.indexOf("/");
		return { model: { provider: id.slice(0, separator), modelId: id.slice(separator + 1) }, thinking };
	})])) as unknown as VirtualModelDefinitions;
}

test("writing virtual models replaces only that field and reads back", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, { processVisibleModel: false });
	const policyDirectory = join(host.services.agentDir, "config");
	const policyPath = join(policyDirectory, "pi-durable-subagents.json");

	// A missing file is created.
	await writeVirtualModels(host.services.agentDir, virtualDefinitions({ fast: [["openai-codex/gpt-6-astra", "high"]] }));
	assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), {
		virtualModels: { fast: [{ id: "openai-codex/gpt-6-astra", thinking: "high" }] },
	});

	await writeFile(policyPath, JSON.stringify({
		maxPendingDeliveriesPerAgent: 4,
		excludedModels: ["deepseek/*"],
		virtualModels: { fast: [{ id: "openai-codex/gpt-6-astra", thinking: "high" }], old: [{ id: "a/b", thinking: "low" }] },
	}), "utf8");
	// The complete next definitions win: a deleted name disappears, order is kept.
	await writeVirtualModels(host.services.agentDir, virtualDefinitions({
		fast: [["deepseek/deepseek-v4-flash", "max"], ["openrouter/vendor/model", "off"]],
		renamed: [["a/b", "low"]],
	}));
	assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), {
		maxPendingDeliveriesPerAgent: 4,
		excludedModels: ["deepseek/*"],
		virtualModels: {
			fast: [{ id: "deepseek/deepseek-v4-flash", thinking: "max" }, { id: "openrouter/vendor/model", thinking: "off" }],
			renamed: [{ id: "a/b", thinking: "low" }],
		},
	});
	const loaded = await readWorkflowPolicy(host.services.agentDir);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) throw new Error("Expected the written policy to load");
	assert.deepEqual(Object.keys(loaded.snapshot.virtualModels), ["fast", "renamed"]);
	assert.deepEqual(loaded.snapshot.virtualModels.fast?.[1]?.model, { provider: "openrouter", modelId: "vendor/model" });

	// No definitions removes the field.
	await writeVirtualModels(host.services.agentDir, {});
	assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), {
		maxPendingDeliveriesPerAgent: 4,
		excludedModels: ["deepseek/*"],
	});
	assert.deepEqual(await readdir(policyDirectory), ["pi-durable-subagents.json"], "no temporary file is left behind");
});

test("writing virtual models refuses what the parser rejects and an invalid file, leaving it untouched", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, { processVisibleModel: false });
	const policyDirectory = join(host.services.agentDir, "config");
	const policyPath = join(policyDirectory, "pi-durable-subagents.json");
	await mkdir(policyDirectory, { recursive: true });
	const original = '{"maxPendingDeliveriesPerAgent": 4}';
	await writeFile(policyPath, original, "utf8");

	const invalidDefinitions: Record<string, Record<string, ReadonlyArray<readonly [string, string]>>> = {
		"uppercase name": { Fast: [["a/b", "low"]] },
		"underscore name": { fast_review: [["a/b", "low"]] },
		"empty list": { fast: [] },
		"duplicate id": { fast: [["a/b", "low"], ["a/b", "high"]] },
		"virtual entry": { fast: [["virtual/other", "low"]] },
		"missing model id": { fast: [["a/", "low"]] },
		"unknown thinking": { fast: [["a/b", "ultra"]] },
	};
	for (const [label, definitions] of Object.entries(invalidDefinitions)) {
		await assert.rejects(() => writeVirtualModels(host.services.agentDir, virtualDefinitions(definitions)), Error, label);
		assert.equal(await readFile(policyPath, "utf8"), original, label);
	}

	const invalidFile = JSON.stringify({ virtualModels: { fast: [] } });
	await writeFile(policyPath, invalidFile, "utf8");
	await assert.rejects(() => writeVirtualModels(host.services.agentDir, virtualDefinitions({ fast: [["a/b", "low"]] })));
	assert.equal(await readFile(policyPath, "utf8"), invalidFile);
	assert.deepEqual(await readdir(policyDirectory), ["pi-durable-subagents.json"]);
});
