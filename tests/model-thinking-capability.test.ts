import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { clampThinkingToModelCapability } from "../src/pi-integration/model-thinking-capability.ts";

function catalogueModel(options: {
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}): Model<Api> {
	return {
		id: "model",
		name: "Model",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.invalid/v1beta",
		reasoning: options.reasoning,
		...(options.thinkingLevelMap === undefined
			? {}
			: { thinkingLevelMap: options.thinkingLevelMap }),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};
}

test("resolves the thinking level the launched child will actually run", () => {
	// google/gemini-3.8-flash declares low/medium/high only, so the levels above high
	// and below low cannot run. Pi resolves both directions when the child starts.
	const flash = catalogueModel({
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
	});
	assert.equal(clampThinkingToModelCapability(flash, "max"), "high");
	assert.equal(clampThinkingToModelCapability(flash, "xhigh"), "high");
	assert.equal(clampThinkingToModelCapability(flash, "medium"), "medium");
	assert.equal(clampThinkingToModelCapability(flash, "off"), "low");
	assert.equal(clampThinkingToModelCapability(flash, "minimal"), "low");

	// A model without reasoning support runs at off whatever was requested.
	assert.equal(clampThinkingToModelCapability(catalogueModel({ reasoning: false }), "max"), "off");
	assert.equal(clampThinkingToModelCapability(catalogueModel({ reasoning: false }), "off"), "off");

	// Without a capability map, the extended levels are the ones a provider must opt
	// into, so a reasoning model resolves them to its highest declared level.
	assert.equal(clampThinkingToModelCapability(catalogueModel({ reasoning: true }), "max"), "high");
});
