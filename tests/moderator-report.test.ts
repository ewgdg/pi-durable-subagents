import assert from "node:assert/strict";
import test from "node:test";
import { formatModeratorReport, validateReportToUserInput } from "../src/protocol/moderator-report.ts";

const input = { symptom: "Hung tool", suspectedDefect: "Missing wake", uncertainty: "Not reproduced", recoveryActions: "Resumed agent", recoveryOutcome: "Completed", evidence: ["session:entry:call"] };

test("report input requires nonblank narrative fields and evidence", () => {
	assert.deepEqual(validateReportToUserInput(input), input);
	for (const field of ["symptom", "suspectedDefect", "uncertainty", "recoveryActions", "recoveryOutcome"]) {
		for (const value of ["", " \n", null, 4]) assert.throws(() => validateReportToUserInput({ ...input, [field]: value }));
	}
	for (const evidence of [[], [" "], [2], null, "entry"]) assert.throws(() => validateReportToUserInput({ ...input, evidence }));
	assert.throws(() => validateReportToUserInput(null));
});

test("ticket formatting retains findings and exact source", () => {
	const report = { ...input, reportId: "report-1", createdAt: "2026-01-01T00:00:00.000Z", reporter: { agentId: "moderator", label: "Moderator" }, source: { agentId: "moderator", entryId: "entry-1", toolCallId: "call-1", transcriptPath: "/tmp/moderator.jsonl" } };
	const formatted = formatModeratorReport(report);
	for (const value of [...Object.values(input).flat(), report.reportId, report.createdAt, ...Object.values(report.source), report.reporter.label]) assert.ok(formatted.includes(value));
});

test("retained report validation keeps runtime diagnostic and native tool authorship distinct", async () => {
	const { validateModeratorReport } = await import("../src/protocol/moderator-report.ts");
	const report = { ...input, reportId: "runtime", createdAt: "2026-06-11T00:00:00Z",
		source: { kind: "runtime_diagnostic", agentId: "owner", entryId: "diagnostic", transcriptPath: "/tmp/owner.jsonl" } };
	assert.deepEqual(validateModeratorReport(report), report);
	assert.throws(() => validateModeratorReport({ ...report, reporter: { agentId: "owner", label: "Owner" } }));
	assert.throws(() => validateModeratorReport({ ...report, source: { ...report.source, toolCallId: "fake" } }));
	assert.throws(() => validateModeratorReport({ ...report, source: { ...report.source, entryId: " " } }));
	assert.throws(() => validateModeratorReport({ ...report, reporter: { agentId: "owner", label: "Owner" }, source: { ...report.source, kind: "unknown", toolCallId: "call" } }));
});
