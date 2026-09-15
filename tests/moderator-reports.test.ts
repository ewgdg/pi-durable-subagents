import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { ModeratorReportStore } from "../src/coordination/moderator-reports.ts";

const input = { symptom: "Hung", suspectedDefect: "Wake lost", uncertainty: "Unconfirmed", recoveryActions: "Resume", recoveryOutcome: "Recovered", evidence: ["entry:call"] };
const reporter = { agentId: "moderator", label: "Moderator" };
const source = { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/moderator.jsonl" };

test("incident linkage cold lookup retains first report source without changing publication or read state", () => {
	const manager = fixture();
	const reports = store(manager);
	const source = { kind: "runtime_diagnostic" as const, agentId: "owner", entryId: "first", transcriptPath: manager.getSessionFile()!, incidentKey: "incident:one" };
	const report = reports.publishRuntime(input, source);
	reports.setRead(report.reportId, true);
	reports.publishRuntime(input, { ...source, entryId: "second" });
	const before = reports.history();
	const reopened = store(SessionManager.open(manager.getSessionFile()!));
	assert.deepEqual(reopened.runtimeSourceForIncident("incident:one"), { agentId: "owner", entryId: "first" });
	assert.equal(reopened.runtimeSourceForIncident("incident:missing"), undefined);
	assert.deepEqual(reopened.history(), before);
	assert.deepEqual(reopened.publishRuntime(input, { ...source, incidentKey: "changed" }), report);
	assert.throws(() => reopened.publishRuntime(input, { ...source, incidentKey: " " }), /incident key/);
});

test("new runtime findings restore unread atomically while duplicates preserve later acknowledgment", () => {
	const manager = fixture();
	const reports = store(manager);
	const diagnostic = { kind: "runtime_diagnostic" as const, agentId: "owner", entryId: "diagnostic", transcriptPath: manager.getSessionFile()! };
	const report = reports.publishRuntime(input, diagnostic);
	reports.setRead(report.reportId, true);
	assert.ok(reports.history()[0]!.readAt);
	const before = manager.getEntries().length;
	reports.appendRuntimeFinding(diagnostic, { key: "recovered", summary: "Inspection recovered", evidence: ["entry:recovery"] });
	const reopened = store(SessionManager.open(manager.getSessionFile()!));
	const item = reopened.history()[0]!;
	assert.deepEqual(item.report, report);
	assert.equal(item.readAt, undefined, "the finding itself restores unread on cold replay");
	assert.equal(item.findings?.length, 1);
	assert.equal(item.findings?.[0]?.summary, "Inspection recovered");
	assert.ok(Number.isFinite(Date.parse(item.findings![0]!.createdAt)));
	assert.ok(Object.isFrozen(item.findings) && Object.isFrozen(item.findings![0]!.evidence));
	reopened.appendRuntimeFinding(diagnostic, { key: "recovered", summary: "changed", evidence: ["other"] });
	assert.deepEqual(reopened.history(), [item]);
	assert.equal(SessionManager.open(manager.getSessionFile()!).getEntries().length, before + 1);
	reopened.setRead(report.reportId, true);
	const acknowledged = store(SessionManager.open(manager.getSessionFile()!));
	const readItem = acknowledged.history()[0]!;
	assert.ok(readItem.readAt);
	const afterRead = SessionManager.open(manager.getSessionFile()!).getEntries().length;
	acknowledged.appendRuntimeFinding(diagnostic, { key: "recovered", summary: "changed again", evidence: ["replayed"] });
	assert.deepEqual(acknowledged.history(), [readItem]);
	assert.deepEqual(store(SessionManager.open(manager.getSessionFile()!)).history(), [readItem]);
	assert.equal(SessionManager.open(manager.getSessionFile()!).getEntries().length, afterRead);
	acknowledged.appendRuntimeFinding(diagnostic, { key: "later-observation", summary: "New recovery evidence", evidence: ["entry:later"] });
	const updated = store(SessionManager.open(manager.getSessionFile()!)).history();
	assert.equal(updated.length, 1);
	assert.equal(updated[0]?.readAt, undefined);
	assert.deepEqual(updated[0]?.report, report);
	assert.equal(updated[0]?.findings?.length, 2);
	assert.equal(manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "agent-coordination.moderator-report").length, 1);
	assert.throws(() => reopened.appendRuntimeFinding({ ...diagnostic, agentId: "missing" }, { key: "x", summary: "Missing", evidence: ["ref"] }), /Unknown runtime report/);
});

test("malformed retained findings are rejected without losing the report", async () => {
	const { inspectCoordinationRejections } = await import("../src/protocol/replay-rejection.ts");
	const manager = fixture();
	const reports = store(manager);
	const report = reports.publishRuntime(input, { kind: "runtime_diagnostic", agentId: "owner", entryId: "diagnostic", transcriptPath: manager.getSessionFile()! });
	manager.appendCustomEntry("agent-coordination.moderator-report-finding", { reportId: report.reportId, key: "bad", summary: " ", evidence: [], createdAt: "bad" });
	assert.deepEqual(reports.history(), [{ report }]);
	assert.equal(inspectCoordinationRejections(transcriptFromSessionManager(manager).inspect(), manager.getSessionId()).length, 1);
});
function store(manager: SessionManager) {
	return new ModeratorReportStore({ transcript: transcriptFromSessionManager(manager), appendCustomEntry: (type, data) => manager.appendCustomEntry(type, data) });
}
function fixture() {
	const manager = SessionManager.create(tmpdir(), mkdtempSync(join(tmpdir(), "moderator-reports-")));
	// SessionManager persists custom entries after the first assistant message.
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Ready" }], api: "openai-responses", provider: "openai", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	manager.appendCustomEntry("agent-coordination.identity", { agentId: manager.getSessionId() });
	return manager;
}

test("reports and reversible read states survive cold reopen without deletion", () => {
	const manager = fixture();
	const reports = store(manager);
	const report = reports.publish(input, reporter, source);
	assert.deepEqual(reports.history(), [{ report }]);
	const reopened = store(SessionManager.open(manager.getSessionFile()!));
	assert.deepEqual(reopened.get(report.reportId), report);
	reopened.setRead(report.reportId, true);
	const afterRead = store(SessionManager.open(manager.getSessionFile()!));
	assert.deepEqual(afterRead.get(report.reportId), report);
	assert.ok(afterRead.history()[0]?.readAt);
	const firstRead = afterRead.history()[0]?.readAt;
	afterRead.setRead(report.reportId, true);
	assert.equal(afterRead.history()[0]?.readAt, firstRead);
	assert.throws(() => afterRead.setRead("missing", false));
	assert.throws(() => afterRead.get("missing"));
	afterRead.setRead(report.reportId, false);
	const afterUnread = store(SessionManager.open(manager.getSessionFile()!));
	assert.deepEqual(afterUnread.history(), [{ report }]);
	const entryCount = SessionManager.open(manager.getSessionFile()!).getEntries().length;
	afterUnread.setRead(report.reportId, false);
	assert.equal(SessionManager.open(manager.getSessionFile()!).getEntries().length, entryCount);
	assert.deepEqual(afterUnread.history(), [{ report }]);
	afterUnread.setRead(report.reportId, true);
	const readAgain = store(SessionManager.open(manager.getSessionFile()!));
	assert.ok(readAgain.history()[0]?.readAt);
	assert.deepEqual(readAgain.get(report.reportId), report);
});

test("publication is source-idempotent and reports cannot be mutated", () => {
	const manager = fixture();
	const reports = store(manager);
	const mutable = structuredClone(input);
	const report = reports.publish(mutable, reporter, source);
	mutable.evidence.push("later");
	assert.throws(() => (report.evidence as string[]).push("mutation"));
	assert.ok(Object.isFrozen(report) && Object.isFrozen(report.source) && Object.isFrozen(report.reporter));
	assert.deepEqual(store(manager).publish({ ...input, symptom: "changed" }, reporter, source), report);
	assert.equal(reports.history().length, 1);
	assert.deepEqual(report.evidence, input.evidence);
	assert.throws(() => reports.publish({ ...input, symptom: " " }, reporter, { ...source, toolCallId: "invalid" }));
	assert.equal(reports.history().length, 1);
});

test("a new Owner identity cutoff excludes copied reports", () => {
	const manager = fixture();
	const reports = store(manager);
	reports.publish(input, reporter, source);
	manager.appendCustomEntry("agent-coordination.identity", { agentId: manager.getSessionId() });
	assert.deepEqual(reports.history(), []);
});

test("rejected report records and read states preserve independent valid publications", async () => {
	const { inspectCoordinationRejections } = await import("../src/protocol/replay-rejection.ts");
	const manager = fixture();
	manager.appendCustomEntry("agent-coordination.moderator-report", { ...input, reportId: "broken" });
	const reports = store(manager);
	const report = reports.publish(input, reporter, source);
	manager.appendCustomEntry("agent-coordination.moderator-report-read", { reportId: report.reportId, readAt: 42 });
	assert.deepEqual(reports.history(), [{ report }]);
	const transcript = transcriptFromSessionManager(manager).inspect();
	assert.equal(inspectCoordinationRejections(transcript, manager.getSessionId()).length, 2);
	assert.deepEqual(store(SessionManager.open(manager.getSessionFile()!)).history(), [{ report }]);
});

test("report replay retains valid-record provenance and duplicate invariants", () => {
	const manager = fixture();
	const reports = store(manager);
	const report = reports.publish(input, reporter, source);
	manager.appendCustomEntry("agent-coordination.moderator-report", { ...report, reporter: { ...reporter, agentId: "other" } });
	assert.throws(() => reports.history(), /reporter must match source Agent/);
});

test("runtime diagnostic reports retain truthful provenance and read state across cold reopen", () => {
	const manager = fixture();
	const reports = store(manager);
	const source = { kind: "runtime_diagnostic" as const, agentId: manager.getSessionId(), entryId: manager.appendCustomEntry("agent-coordination.operational-diagnostic", { message: "Inspection blocked" }), transcriptPath: manager.getSessionFile()! };
	const report = reports.publishRuntime(input, source);
	assert.equal(report.reporter, undefined, "runtime does not impersonate Moderator or Owner");
	assert.equal(report.source.toolCallId, undefined);
	reports.setRead(report.reportId, true);
	const reopened = store(SessionManager.open(manager.getSessionFile()!));
	assert.deepEqual(reopened.get(report.reportId), report);
	assert.ok(reopened.history()[0]?.readAt);
	assert.deepEqual(reopened.publishRuntime({ ...input, symptom: "still failing" }, source), report);
	assert.equal(reopened.history().length, 1);
	assert.ok(reopened.history()[0]?.readAt, "publication does not re-notify after read");
	reopened.setRead(report.reportId, false);
	assert.equal(reopened.history()[0]?.readAt, undefined);
});

test("early runtime reports share native delayed persistence without synthesizing an assistant", () => {
	const manager = SessionManager.create(tmpdir(), mkdtempSync(join(tmpdir(), "early-runtime-report-")));
	manager.appendCustomEntry("agent-coordination.identity", { agentId: manager.getSessionId() });
	const reports = store(manager);
	const source = { kind: "runtime_diagnostic" as const, agentId: manager.getSessionId(), entryId: manager.appendCustomEntry("agent-coordination.operational-diagnostic", { message: "Initial inspection failed" }), transcriptPath: manager.getSessionFile()! };
	const report = reports.publishRuntime(input, source);
	reports.setRead(report.reportId, true);
	assert.ok(reports.history()[0]?.readAt);
	assert.equal(existsSync(source.transcriptPath), false, "report publication does not force native persistence");
	assert.equal(manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant"), false);
	manager.appendMessage(fauxAssistantMessage("First real assistant response."));
	assert.deepEqual(store(SessionManager.open(source.transcriptPath)).history(), reports.history());
});
