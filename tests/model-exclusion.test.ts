import assert from "node:assert/strict";
import test from "node:test";

import {
	isModelExcluded,
	parseExcludedModels,
} from "../src/policy/model-exclusion.ts";

test("a provider entry excludes every model of that provider", () => {
	const entries = parseExcludedModels(["openai-codex/*"]);
	assert.equal(isModelExcluded(entries, {
		provider: "openai-codex",
		modelId: "gpt-6-astra",
	}), true);
	// A catalogue addition after the entry was stored stays excluded.
	assert.equal(isModelExcluded(entries, {
		provider: "openai-codex",
		modelId: "gpt-7-future",
	}), true);
	assert.equal(isModelExcluded(entries, {
		provider: "openai-codex-mini",
		modelId: "gpt-6-astra",
	}), false);
	assert.equal(isModelExcluded(entries, {
		provider: "deepseek",
		modelId: "deepseek-v4-flash",
	}), false);
});

test("an exact entry excludes one identity and no exceptions exist", () => {
	const entries = parseExcludedModels([
		"deepseek/deepseek-v4-pro",
		"openrouter/anthropic/claude-sonnet-4",
		"openai-codex/*",
	]);
	assert.equal(isModelExcluded(entries, {
		provider: "deepseek",
		modelId: "deepseek-v4-pro",
	}), true);
	assert.equal(isModelExcluded(entries, {
		provider: "deepseek",
		modelId: "deepseek-v4-flash",
	}), false);
	// A model id may contain slashes; only the first separator is structural.
	assert.equal(isModelExcluded(entries, {
		provider: "openrouter",
		modelId: "anthropic/claude-sonnet-4",
	}), true);
	// Union only: an absent exact entry cannot carve a model out of a provider entry.
	assert.equal(isModelExcluded(entries, {
		provider: "openai-codex",
		modelId: "gpt-5.6-luna",
	}), true);
});

test("no exclusions leave every model allowed", () => {
	const entries = parseExcludedModels([]);
	assert.equal(isModelExcluded(entries, {
		provider: "openai-codex",
		modelId: "gpt-6-astra",
	}), false);
});
