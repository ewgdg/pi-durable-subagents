import assert from "node:assert/strict";
import test from "node:test";
import { createQuotaSuspensionReport } from "../src/presentation/quota-suspension-report.ts";

test("quota notice preserves exact evidence without inventing a reset time", () => {
	const diagnostic = "Codex error: The usage limit has been reached";
	const report = createQuotaSuspensionReport({ agentId: "child-id", label: "Researcher", runSequence: 3,
		evidence: { diagnostic, provider: "openai-codex", model: "gpt-5" } });
	assert.match(report.symptom, /Suspended · Usage limit reached/);
	assert.ok(report.evidence.includes(`Diagnostic: ${diagnostic}`));
	assert.ok(report.evidence.includes("Provider: openai-codex"));
	assert.ok(report.evidence.includes("Model: gpt-5"));
	assert.ok(report.evidence.every(line => !line.startsWith("Reset time:")));
	assert.match(report.recoveryActions, /explicit/i);
	assert.match(report.recoveryOutcome, /Reading.*does not resume/);
});

test("quota notice includes reset time only when supplied by provider evidence", () => {
	const report = createQuotaSuspensionReport({ agentId: "child-id", label: "Researcher", runSequence: 3,
		evidence: { diagnostic: '{"error":{"code":"insufficient_quota"}}', resetAt: "2030-01-01T00:00:00.000Z" } });
	assert.ok(report.evidence.includes("Reset time: 2030-01-01T00:00:00.000Z"));
	assert.ok(report.evidence.every(line => !line.startsWith("Provider:") && !line.startsWith("Model:")));
});
