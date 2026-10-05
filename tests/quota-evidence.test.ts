import assert from "node:assert/strict";
import test from "node:test";
import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";

import { classifyQuotaEvidence } from "../src/runtime/quota-evidence.ts";

test("quota evidence distinguishes exhausted quota from temporary throttling", () => {
	for (const [diagnostic, exhausted] of [
		["Codex error: The usage limit has been reached", true],
		["Codex error: usage_limit_reached", true],
		["Codex error: insufficient_quota", true],
		["Codex error: rate_limit_exceeded", false],
		['{"error":{"code":"usage_limit_reached"}}', true],
		['{"error":{"type":"insufficient_quota"}}', true],
		['429: {"code":"insufficient_quota"}', true],
		['429: {"code":"rate_limit_exceeded"}', false],
		['{"error":{"code":"rate_limit_exceeded","message":"Codex error: The usage limit has been reached"}}', false],
		["429 Too Many Requests", false], ["context limit exceeded", false], ["unrelated failure", false],
	] as const) {
		assert.deepEqual(
			classifyQuotaEvidence({ provider: "openai-codex", model: "gpt-5", errorMessage: diagnostic }),
			exhausted ? { diagnostic, provider: "openai-codex", model: "gpt-5" } : undefined,
			diagnostic,
		);
	}
});

test("quota evidence recognizes retained OpenAI formatter bodies, not arbitrary prefixes", () => {
	for (const prefix of ["OpenAI API error", "Azure OpenAI API error", "unrelated API error"]) {
		for (const code of ["usage_limit_reached", "insufficient_quota", "rate_limit_exceeded"]) {
			const error = Object.assign(new Error("Request rejected"), { status: 429, error: { code, resets_at: 1893456000 } });
			const diagnostic = formatProviderError(normalizeProviderError(error), prefix);
			assert.deepEqual(classifyQuotaEvidence({ errorMessage: diagnostic }), prefix !== "unrelated API error" && code !== "rate_limit_exceeded"
				? { diagnostic, resetAt: "2030-01-01T00:00:00.000Z" } : undefined);
		}
	}
});

test("quota evidence never invents identity or reset time", () => {
	for (const [assistant, expected] of [
		[{ errorMessage: '{"error":{"code":"usage_limit_reached","resets_at":"soon"}}' }, { diagnostic: '{"error":{"code":"usage_limit_reached","resets_at":"soon"}}' }],
		[{ errorMessage: "Codex error: The usage limit has been reached", provider: "unrelated-provider" }, undefined],
		[{ errorMessage: "You have hit your ChatGPT usage limit. Try again in ~5 min." }, undefined],
	] as const) {
		assert.deepEqual(classifyQuotaEvidence(assistant), expected);
	}
});
