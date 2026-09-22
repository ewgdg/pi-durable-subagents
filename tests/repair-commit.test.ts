import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { repairSessionDirectory } from "../src/coordination/manual-repair.ts";
import { sha256File } from "../src/coordination/repair-freeze.ts";
import { approveRepairReplace, assertRepairApprovalFresh, assertRepairRecoveryPreconditions, commitRepairReplace, createRepairApprovalLedger, freezeRepairTargets, isRepairTransactionClosed, loadRepairApprovalLedger, notifyRepairHumanInputBeforeCommit, openRepairedOwnerIdle, persistRepairApprovalLedger, recoverRepairCommitFromJournal, revokeRepairApprovalPersisted, runRepairPreCommitGate, selectRepairHistory, REPAIR_ATTEMPT_ID_PATTERN, REPAIR_LEDGER_FILENAME, REPAIR_STOPPED_WRITER_RECOVERY_INSTRUCTIONS } from "../src/coordination/repair-commit.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";
function ordinaryChild(owner: SessionManager, workflowId: string, toolCallId: string, label: string) {
  const directory = workflowSessionDirectory(owner.getSessionDir(), workflowId);
  const entryId = owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { title: label, request: "Work", label }, { id: toolCallId })));
  const session = SessionManager.create(owner.getSessionDir(), directory);
  session.appendCustomEntry("agent-coordination.identity", { agentId: session.getSessionId(), workflowId, directSpawnerAgentId: owner.getSessionId(), creationPreset: null, spawnSource: { agentId: owner.getSessionId(), entryId, toolCallId }, metadata: { label } });
  session.appendMessage(fauxAssistantMessage("Persist " + label));
  return session;
}
async function makeWorkflow(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const owner = SessionManager.create(root, root);
  const workflowId = owner.getSessionId();
  owner.appendCustomEntry("agent-coordination.identity", { agentId: owner.getSessionId(), workflowId, directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } });
  const directory = workflowSessionDirectory(root, workflowId);
  const child = ordinaryChild(owner, workflowId, "spawn-" + prefix + "a", "child-a");
  return { root, owner, workflowId, directory, childPath: child.getSessionFile() as string };
}
async function makeRepairedCopy(sourcePath: string, scratchDir: string, note: string): Promise<string> {
  const repairedPath = join(scratchDir, basename(sourcePath).replace(/\.jsonl$/, "") + ".repaired.jsonl");
  await copyFile(sourcePath, repairedPath);
  const session = SessionManager.open(repairedPath);
  session.appendMessage(fauxAssistantMessage(note));
  return repairedPath;
}
test("replace approval needs explicit Owner-session confirm; stale snapshot refuses", async () => {
  const ctx = await makeWorkflow("repair-commit-approval-");
  const snapshot = await freezeRepairTargets(ctx.directory);
  assert.ok(snapshot.snapshotId.length > 0);
  assert.equal(snapshot.workflowDirectory, ctx.directory);
  for (const provenance of ["model", "moderator_control", "advisory", ""]) {
    assert.throws(() => approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance }), /unauthorized/);
  }
  const ledger = createRepairApprovalLedger();
  const approval = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  assert.equal(approval.provenance, "owner-session-confirm");
  assert.throws(() => assertRepairApprovalFresh(approval, "different-snapshot-id", ledger), /stale_approval/);
  await assert.rejects(runRepairPreCommitGate({ workflowDirectory: ctx.directory, snapshot: { ...snapshot, snapshotId: "different-snapshot-id" }, approval, ledger }), /stale_approval/);
  assert.doesNotThrow(() => assertRepairApprovalFresh(approval, snapshot.snapshotId, ledger));
  const audit = await runRepairPreCommitGate({ workflowDirectory: ctx.directory, snapshot, approval, ledger });
  assert.equal(audit.snapshotId, snapshot.snapshotId);
  assert.equal(audit.backupLocation, undefined);
  assert.ok(audit.diffSummary.length > 0);
});
test("esc and human-message revoke approval with no auto-retry; fresh approval works", async () => {
  const ctx = await makeWorkflow("repair-commit-revoke-");
  const snapshot = await freezeRepairTargets(ctx.directory);
  const ledger = createRepairApprovalLedger();
  const escApproval = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  notifyRepairHumanInputBeforeCommit(ledger, escApproval.approvalId, "esc");
  assert.throws(() => assertRepairApprovalFresh(escApproval, snapshot.snapshotId, ledger), /revoked/);
  assert.throws(() => assertRepairApprovalFresh(escApproval, snapshot.snapshotId, ledger), /revoked/);
  await assert.rejects(runRepairPreCommitGate({ workflowDirectory: ctx.directory, snapshot, approval: escApproval, ledger }), /revoked/);
  const hmApproval = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  notifyRepairHumanInputBeforeCommit(ledger, hmApproval.approvalId, "human-message");
  assert.throws(() => assertRepairApprovalFresh(hmApproval, snapshot.snapshotId, ledger), /revoked/);
  assert.throws(() => assertRepairApprovalFresh(hmApproval, snapshot.snapshotId, ledger), /revoked/);
  const fresh = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  const audit = await runRepairPreCommitGate({ workflowDirectory: ctx.directory, snapshot, approval: fresh, ledger });
  assert.equal(audit.targetCount, snapshot.entries.length);
  assert.equal(audit.backupLocation, undefined);
});
test("drift on added and changed targets refuses; live repair appends excluded", async () => {
  const added = await makeWorkflow("repair-commit-drift-add-");
  const snapAdded = await freezeRepairTargets(added.directory);
  const ledgerAdded = createRepairApprovalLedger();
  const approvalAdded = approveRepairReplace({ snapshotId: snapAdded.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  ordinaryChild(added.owner, added.workflowId, "spawn-late-child", "late-child");
  await assert.rejects(runRepairPreCommitGate({ workflowDirectory: added.directory, snapshot: snapAdded, approval: approvalAdded, ledger: ledgerAdded }), /drift/);
  const changed = await makeWorkflow("repair-commit-drift-chg-");
  const snapChanged = await freezeRepairTargets(changed.directory);
  const ledgerChanged = createRepairApprovalLedger();
  const approvalChanged = approveRepairReplace({ snapshotId: snapChanged.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  const opener = SessionManager.open(snapChanged.entries[0].source);
  opener.appendMessage(fauxAssistantMessage("Late Owner write changes the hash."));
  await assert.rejects(runRepairPreCommitGate({ workflowDirectory: changed.directory, snapshot: snapChanged, approval: approvalChanged, ledger: ledgerChanged }), /drift/);
  const live = await makeWorkflow("repair-commit-livedrift-");
  const snapLive = await freezeRepairTargets(live.directory);
  const ledgerLive = createRepairApprovalLedger();
  const approvalLive = approveRepairReplace({ snapshotId: snapLive.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  const repairDir = repairSessionDirectory(live.root, live.workflowId);
  const repair = SessionManager.create(live.root, repairDir);
  repair.appendCustomEntry("agent-coordination.identity", { agentId: repair.getSessionId(), workflowId: live.workflowId, directSpawnerAgentId: null, metadata: { label: "Moderator", description: "Manual repair" } });
  repair.appendMessage(fauxAssistantMessage("Live repairer persists."));
  const audit = await runRepairPreCommitGate({ workflowDirectory: live.directory, snapshot: snapLive, approval: approvalLive, ledger: ledgerLive });
  assert.equal(audit.targetCount, snapLive.entries.length);
  repair.appendMessage(fauxAssistantMessage("Live repairer appends during gate."));
  const audit2 = await runRepairPreCommitGate({ workflowDirectory: live.directory, snapshot: snapLive, approval: approvalLive, ledger: ledgerLive });
  assert.equal(audit2.targetCount, snapLive.entries.length);
  await assert.rejects(runRepairPreCommitGate({ workflowDirectory: live.directory, snapshot: snapLive, approval: approvalLive, ledger: ledgerLive, liveGate: { phase: "live", failed: false, hasRecord: true } }), /join_live_repair/);
});
test("happy-path commit seals generation, journals receipt, single-use approval, same-attempt join", async () => {
  const ctx = await makeWorkflow("repair-commit-happy-");
  const snapshot = await freezeRepairTargets(ctx.directory);
  const ledger = createRepairApprovalLedger();
  const approval = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  const scratch = await mkdtemp(join(tmpdir(), "repair-commit-scratch-"));
  const repairedBySource: Record<string, string> = {};
  for (const entry of snapshot.entries) repairedBySource[entry.source] = await makeRepairedCopy(entry.source, scratch, "Repaired note.");
  const firstRepaired = SessionManager.open(repairedBySource[snapshot.entries[0].source] as string);
  firstRepaired.appendMessage(fauxAssistantMessage(fauxToolCall("mystery_tool_xyz", { x: 1 }, { id: "call-mystery-1" })));
  firstRepaired.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", { request: "Work without title", label: "untitled" }, { id: "call-untitled-1" })));
  const backupRoot = await mkdtemp(join(tmpdir(), "repair-commit-backup-"));
  const journalDir = await mkdtemp(join(tmpdir(), "repair-commit-journal-"));
  const attemptId = "attempt-happy-1";
  const result = await commitRepairReplace({ workflowDirectory: ctx.directory, snapshot, approval, ledger, repairedBySource, backupRoot, journalDir, attemptId, ownerId: "owner-1" });
  assert.equal(result.disposition, "committed");
  assert.equal(result.generation, 1);
  assert.equal(result.attemptId, attemptId);
  assert.ok((await stat(result.backupDir)).isDirectory());
  const manifestRaw = await readFile(join(result.backupDir, "manifest.json"), "utf8");
  assert.ok(manifestRaw.indexOf("sha256") !== -1);
  const journalRaw = await readFile(join(journalDir, "repair-journal-" + attemptId + ".json"), "utf8");
  const journal = JSON.parse(journalRaw);
  assert.equal(journal.attemptId, attemptId);
  assert.equal(journal.snapshotId, snapshot.snapshotId);
  assert.equal(journal.approver, "owner-1");
  assert.equal(journal.provenance, "owner-session-confirm");
  assert.equal(journal.generation, 1);
  assert.equal(journal.status, "committed");
  assert.ok(result.audit.diffSummary.length > 0);
  assert.ok(result.audit.warnings.some((w) => w.indexOf("unknown-tool") !== -1));
  assert.ok(result.audit.outOfScope.some((n) => n.indexOf("title") !== -1));
  assert.equal(result.audit.backupLocation, result.backupDir);
  for (const entry of snapshot.entries) assert.equal(await sha256File(entry.source), await sha256File(repairedBySource[entry.source] as string));
  assert.ok(ledger.consumed.has(approval.approvalId));
  await assert.rejects(commitRepairReplace({ workflowDirectory: ctx.directory, snapshot, approval, ledger, repairedBySource, backupRoot, journalDir, attemptId: "attempt-happy-2", ownerId: "owner-1" }), /consumed/);
  const genBefore = await readFile(join(journalDir, "repair-generation.json"), "utf8");
  const joined = await commitRepairReplace({ workflowDirectory: ctx.directory, snapshot, approval, ledger, repairedBySource, backupRoot, journalDir, attemptId, ownerId: "owner-1" });
  assert.equal(joined.disposition, "joined-committed");
  assert.equal(joined.generation, 1);
  assert.equal(await readFile(join(journalDir, "repair-generation.json"), "utf8"), genBefore);
  assert.equal((await readdir(backupRoot)).length, 1);
  assert.equal(joined.idle.idle, true);
  assert.equal(joined.idle.autoResume, false);
});
test("crash after journal commit recovers without touching targets", async () => {
  const ctx = await makeWorkflow("repair-commit-crash-");
  const snapshot = await freezeRepairTargets(ctx.directory);
  const ledger = createRepairApprovalLedger();
  const approval = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  const scratch = await mkdtemp(join(tmpdir(), "repair-commit-crash-scratch-"));
  const repairedBySource: Record<string, string> = {};
  for (const entry of snapshot.entries) repairedBySource[entry.source] = await makeRepairedCopy(entry.source, scratch, "Crash-path repair.");
  const backupRoot = await mkdtemp(join(tmpdir(), "repair-commit-crash-backup-"));
  const journalDir = await mkdtemp(join(tmpdir(), "repair-commit-crash-journal-"));
  const attemptId = "attempt-crash-1";
  await assert.rejects(commitRepairReplace({ workflowDirectory: ctx.directory, snapshot, approval, ledger, repairedBySource, backupRoot, journalDir, attemptId, ownerId: "owner-1", testHooks: { crashAfterJournalCommit: true } }), /crash_simulated/);
  const journalPath = join(journalDir, "repair-journal-" + attemptId + ".json");
  const beforeHash = await sha256File(snapshot.entries[0].source);
  const beforeStat = await stat(snapshot.entries[0].source);
  const recovered = await recoverRepairCommitFromJournal(journalPath);
  assert.equal(recovered.disposition, "committed-awaiting-admission");
  assert.equal(recovered.attemptId, attemptId);
  assert.equal(recovered.snapshotId, snapshot.snapshotId);
  assert.equal(recovered.generation, 1);
  assert.ok(recovered.backupDir.length > 0);
  assert.equal(await sha256File(snapshot.entries[0].source), beforeHash);
  assert.equal((await stat(snapshot.entries[0].source)).mtimeMs, beforeStat.mtimeMs);
  const second = await recoverRepairCommitFromJournal(journalPath);
  assert.deepEqual(second, recovered);
});
test("failed post-commit admission keeps committed data with truthful error; idle holds for human", async () => {
  const ctx = await makeWorkflow("repair-commit-admit-");
  const snapshot = await freezeRepairTargets(ctx.directory);
  const ledger = createRepairApprovalLedger();
  const approval = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  const scratch = await mkdtemp(join(tmpdir(), "repair-commit-admit-scratch-"));
  const repairedBySource: Record<string, string> = {};
  for (const entry of snapshot.entries) repairedBySource[entry.source] = await makeRepairedCopy(entry.source, scratch, "Admission-path repair.");
  const backupRoot = await mkdtemp(join(tmpdir(), "repair-commit-admit-backup-"));
  const journalDir = await mkdtemp(join(tmpdir(), "repair-commit-admit-journal-"));
  const result = await commitRepairReplace({ workflowDirectory: ctx.directory, snapshot, approval, ledger, repairedBySource, backupRoot, journalDir, attemptId: "attempt-admit-1", ownerId: "owner-1", testHooks: { admitRepaired: async () => { throw new Error("admission-boom"); } } });
  assert.equal(result.disposition, "committed-admission-failed");
  assert.ok((result.admissionError as string).indexOf("admission-boom") !== -1);
  for (const entry of snapshot.entries) assert.equal(await sha256File(entry.source), await sha256File(repairedBySource[entry.source] as string));
  assert.ok((await stat(result.backupDir)).isDirectory());
  assert.equal(result.idle.ownerId, "owner-1");
  assert.equal(result.idle.idle, true);
  assert.equal(result.idle.idleUntil, "human-message");
  assert.equal(result.idle.humanOnlyHold, true);
  assert.equal(result.idle.autoResume, false);
  assert.equal(result.idle.autoViewReturn, false);
  assert.equal(result.idle.draftsPreserved, true);
  assert.equal(result.idle.turnWithoutHumanMessage, false);
  const idle = openRepairedOwnerIdle("owner-9", { drafts: { a: 1 } });
  assert.equal(idle.ownerId, "owner-9");
  assert.equal(idle.idle, true);
  assert.equal(idle.idleUntil, "human-message");
  assert.equal(idle.humanOnlyHold, true);
  assert.equal(idle.autoResume, false);
  assert.equal(idle.autoViewReturn, false);
  assert.equal(idle.draftsPreserved, true);
  assert.deepEqual(idle.drafts, { a: 1 });
  assert.equal(idle.turnWithoutHumanMessage, false);
});
test("stopped-writer recovery instructions and closed-transaction checks", async () => {
  for (const needle of ["stop ALL writers", "old host", "recover-stopped", "reusing existing journal", "history selection alone never restarts", "closed transaction stays closed"]) {
    assert.ok(REPAIR_STOPPED_WRITER_RECOVERY_INSTRUCTIONS.indexOf(needle) !== -1, "missing instruction: " + needle);
  }
  assert.throws(() => assertRepairRecoveryPreconditions({ allWritersStopped: false, oldHostStopped: true, journalPath: "/tmp/j.json" }), /recovery_blocked: stop ALL writers/);
  assert.throws(() => assertRepairRecoveryPreconditions({ allWritersStopped: true, oldHostStopped: false, journalPath: "/tmp/j.json" }), /recovery_blocked/);
  try {
    assertRepairRecoveryPreconditions({ allWritersStopped: true, oldHostStopped: false, journalPath: "/tmp/j.json" });
    assert.fail("old host must block");
  } catch (error) {
    assert.ok((error as Error).message.indexOf("old host") !== -1);
  }
  assert.deepEqual(assertRepairRecoveryPreconditions({ allWritersStopped: true, oldHostStopped: true, journalPath: "/tmp/j.json" }), { reuseJournal: true, journalPath: "/tmp/j.json" });
  assert.deepEqual(selectRepairHistory(), { restarts: false });
  assert.equal(isRepairTransactionClosed({ status: "committed" }), true);
  assert.equal(isRepairTransactionClosed({ status: "committed-awaiting-admission" }), true);
  assert.equal(isRepairTransactionClosed({ status: "committed-admission-failed" }), true);
  assert.equal(isRepairTransactionClosed({ status: "open" }), false);
});
async function makeCommitFixture(prefix: string, attemptId: string) {
  const ctx = await makeWorkflow(prefix);
  const snapshot = await freezeRepairTargets(ctx.directory);
  const ledger = createRepairApprovalLedger();
  const approval = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  const scratch = await mkdtemp(join(tmpdir(), prefix + "scratch-"));
  const repairedBySource: Record<string, string> = {};
  for (const entry of snapshot.entries) repairedBySource[entry.source] = await makeRepairedCopy(entry.source, scratch, "Fixture repair.");
  const backupRoot = await mkdtemp(join(tmpdir(), prefix + "backup-"));
  const journalDir = await mkdtemp(join(tmpdir(), prefix + "journal-"));
  const base = { workflowDirectory: ctx.directory, snapshot, approval, ledger, repairedBySource, backupRoot, journalDir, attemptId, ownerId: "owner-1" };
  return { ctx, snapshot, ledger, approval, backupRoot, journalDir, base };
}
test("replace approval binds the approver to the Owner-session Owner id", async () => {
  const ctx = await makeWorkflow("repair-commit-authority-");
  const snapshot = await freezeRepairTargets(ctx.directory);
  const ok = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  assert.equal(ok.approver, "owner-1");
  assert.throws(() => approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-2", provenance: "owner-session-confirm" }), /unauthorized/);
  assert.throws(() => approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "", ownerId: "owner-1", provenance: "owner-session-confirm" }), /invalid_input/);
  assert.throws(() => approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "", provenance: "owner-session-confirm" }), /invalid_input/);
  assert.throws(() => (approveRepairReplace as (options: unknown) => unknown)({ snapshotId: snapshot.snapshotId, provenance: "owner-session-confirm" }), /invalid_input/);
});
test("pre-commit gate requires the approval ledger", async () => {
  const ctx = await makeWorkflow("repair-commit-ledger-required-");
  const snapshot = await freezeRepairTargets(ctx.directory);
  const approval = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  await assert.rejects(runRepairPreCommitGate({ workflowDirectory: ctx.directory, snapshot, approval, ledger: undefined as never }), /invalid_input: repair approval ledger is required/);
});
test("same-attempt join still enforces snapshot binding, approval identity, and revocation", async () => {
  const fx = await makeCommitFixture("repair-commit-join-guard-", "attempt-join-guard-1");
  const first = await commitRepairReplace(fx.base);
  assert.equal(first.disposition, "committed");
  notifyRepairHumanInputBeforeCommit(fx.ledger, fx.approval.approvalId, "esc");
  await assert.rejects(commitRepairReplace({ ...fx.base }), /revoked/);
  const otherLedger = createRepairApprovalLedger();
  const other = approveRepairReplace({ snapshotId: fx.snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-confirm" });
  await assert.rejects(commitRepairReplace({ ...fx.base, approval: other, ledger: otherLedger }), /stale_approval/);
  const drifted = { ...fx.snapshot, snapshotId: "different-snapshot-id" };
  await assert.rejects(commitRepairReplace({ ...fx.base, snapshot: drifted, ledger: createRepairApprovalLedger() }), /stale_approval/);
});
test("revocation through the persisted ledger refuses commit without in-memory notify", async () => {
  const fx = await makeCommitFixture("repair-commit-persisted-revoke-", "attempt-persisted-revoke-1");
  const witness = createRepairApprovalLedger();
  await revokeRepairApprovalPersisted(fx.journalDir, witness, fx.approval.approvalId, "human-message");
  assert.ok(witness.revoked.has(fx.approval.approvalId));
  const persisted = await loadRepairApprovalLedger(fx.journalDir);
  assert.ok(persisted.revoked.has(fx.approval.approvalId));
  const ledgerRaw = await readFile(join(fx.journalDir, REPAIR_LEDGER_FILENAME), "utf8");
  assert.ok((JSON.parse(ledgerRaw) as { revoked: string[] }).revoked.includes(fx.approval.approvalId));
  const roundTripDir = await mkdtemp(join(tmpdir(), "repair-commit-ledger-roundtrip-"));
  await persistRepairApprovalLedger(roundTripDir, witness);
  assert.ok((await loadRepairApprovalLedger(roundTripDir)).revoked.has(fx.approval.approvalId));
  await assert.rejects(commitRepairReplace(fx.base), /revoked/);
});
test("crash during apply leaves generation unsealed and writes no journal", async () => {
  const fx = await makeCommitFixture("repair-commit-apply-crash-", "attempt-apply-crash-1");
  await assert.rejects(commitRepairReplace({ ...fx.base, testHooks: { crashAfterApplyBeforeSeal: true } }), /crash_simulated/);
  await assert.rejects(readFile(join(fx.journalDir, "repair-generation.json"), "utf8"), /ENOENT/);
  const journalNames = (await readdir(fx.journalDir)).filter((name) => name.startsWith("repair-journal-"));
  assert.equal(journalNames.length, 0);
});
test("repaired Owner idle pins the host-enforced hold fields", async () => {
  const idle = openRepairedOwnerIdle("owner-7", { drafts: { view: "repair-state" } });
  assert.deepEqual(idle, { ownerId: "owner-7", idle: true, idleUntil: "human-message", humanOnlyHold: true, autoResume: false, autoViewReturn: false, draftsPreserved: true, drafts: { view: "repair-state" }, turnWithoutHumanMessage: false });
});
test("journal recovery refuses malformed receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repair-commit-malformed-"));
  const good = { attemptId: "a", snapshotId: "s", generation: 1, backupDir: "/tmp/b", manifestPath: "/tmp/b/manifest.json", files: [{ source: "/tmp/x", sha256Before: "aa", sha256After: "bb" }], committedAt: new Date().toISOString() };
  async function refuses(name: string, value: unknown) {
    const journalPath = join(dir, name + ".json");
    await writeFile(journalPath, JSON.stringify(value), "utf8");
    await assert.rejects(recoverRepairCommitFromJournal(journalPath), /invalid_input/);
  }
  await refuses("empty-files", { ...good, files: [] });
  await refuses("bad-entry", { ...good, files: [{ source: "/tmp/x" }] });
  await refuses("no-backup", { ...good, backupDir: "" });
  await refuses("no-manifest", { ...good, manifestPath: "" });
});
test("attempt ids use a strict charset", async () => {
  assert.ok(REPAIR_ATTEMPT_ID_PATTERN.test("attempt-happy-1"));
  assert.equal(REPAIR_ATTEMPT_ID_PATTERN.test("../evil"), false);
  assert.equal(REPAIR_ATTEMPT_ID_PATTERN.test("bad/id"), false);
  assert.equal(REPAIR_ATTEMPT_ID_PATTERN.test("has space"), false);
  assert.equal(REPAIR_ATTEMPT_ID_PATTERN.test(""), false);
  assert.equal(REPAIR_ATTEMPT_ID_PATTERN.test("x".repeat(129)), false);
  const fx = await makeCommitFixture("repair-commit-attempt-id-", "not/an/id");
  await assert.rejects(commitRepairReplace(fx.base), /invalid_input/);
});
