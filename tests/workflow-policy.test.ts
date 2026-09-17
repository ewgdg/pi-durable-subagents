import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	DEFAULT_WORKFLOW_POLICY,
	WorkflowPolicyStore,
	parseWorkflowPolicy,
	readWorkflowPolicy,
} from "../src/policy/workflow-policy.ts";
import { createUnboundTestOwnerHost } from "./support/pi-host.ts";

test("strict Workflow Policy parsing fills defaults and freezes one complete snapshot", () => {
	const defaults = parseWorkflowPolicy("{}");
	assert.deepEqual(defaults, {
		maxConcurrentAgentRuns: 8,
		maxPendingDeliveriesPerAgent: 256,
		deliveryProgressIntervalMs: 60_000,
		operationReviewIntervalMs: 600_000,
		excludedModels: [],
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
	});
	assert.equal(Object.isFrozen(configured.excludedModels), true);
	assert.equal(Object.isFrozen(configured), true);
	assert.equal(Object.isFrozen(DEFAULT_WORKFLOW_POLICY), true);
});

test("strict Workflow Policy parsing rejects the complete invalid document", () => {
	const invalidPolicies = [
		["non-object", "[]"],
		["unknown field", '{"maxConcurrentAgentRuns": 8, "extra": true}'],
		["duplicate key", '{"maxConcurrentAgentRuns": 8, "maxConcurrentAgentRuns": 4}'],
		["comment", '{"maxConcurrentAgentRuns": 8 /* no comments */}'],
		["trailing comma", '{"maxConcurrentAgentRuns": 8,}'],
		["wrong type", '{"maxConcurrentAgentRuns": "8"}'],
		["null concurrency", '{"maxConcurrentAgentRuns": null}'],
		["null delivery limit", '{"maxPendingDeliveriesPerAgent": null}'],
		["null review interval", '{"operationReviewIntervalMs": null}'],
		["zero concurrency", '{"maxConcurrentAgentRuns": 0}'],
		["fractional concurrency", '{"maxConcurrentAgentRuns": 1.5}'],
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
		'{"maxConcurrentAgentRuns": 2, "operationReviewIntervalMs": 1200}',
		"utf8",
	);
	const loaded = await readWorkflowPolicy(host.services.agentDir);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) throw new Error("Expected the configured policy to load");
	assert.deepEqual(loaded.snapshot, {
		maxConcurrentAgentRuns: 2,
		maxPendingDeliveriesPerAgent: 256,
		deliveryProgressIntervalMs: 60_000,
		operationReviewIntervalMs: 1_200,
		excludedModels: [],
	});
});

test("Workflow Policy reload publication replaces or preserves one whole snapshot", () => {
	const initial = parseWorkflowPolicy('{"maxConcurrentAgentRuns": 2}');
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
	});
});
