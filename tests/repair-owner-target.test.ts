// Freeze the retired Owner transcript + explicit unrepairable exit.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listFrozenRepairTargets } from "../src/coordination/repair-freeze.ts";
import { freezeRepairTargets } from "../src/coordination/repair-commit.ts";
import { validateRepairFreezeAdvisory } from "../src/coordination/repair-validate.ts";
import { MANUAL_REPAIR_PROCEDURE, repairSessionDirectory } from "../src/coordination/manual-repair.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";
import { buildBrokenOwnerSession } from "./support/broken-session-fixture.ts";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function demoLayout() {
  const root = await mkdtemp(join(tmpdir(), "repair-owner-target-"));
  const built = await buildBrokenOwnerSession(root, repoRoot);
  const workflowId = built.agentId;
  const directory = workflowSessionDirectory(root, workflowId);
  const repairDir = repairSessionDirectory(root, workflowId);
  await mkdir(repairDir, { recursive: true });
  return { root, built, workflowId, directory };
}
test("freeze includes retired Owner when workflow dir holds only repair/", async () => {
  const { directory, built } = await demoLayout();
  const snapshot = await freezeRepairTargets(directory, [built.sessionFile]);
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0]!.source, built.sessionFile);
});
test("bare workflow-dir walk never returns empty silently", async () => {
  const { directory } = await demoLayout();
  let threw = "";
  try { await listFrozenRepairTargets(directory); } catch (e) { threw = (e as Error).message; }
  // Fixed behavior: refuse with precise reason, never return [].
  assert.ok(threw.length > 0, "empty freeze must refuse, never return []");
  assert.ok(threw.includes("freeze_failed") || threw.includes("no frozen"), "precise reason, got: " + threw);
});
test("validate surfaces duplicate-Deliveries on frozen Owner", async () => {
  const { built } = await demoLayout();
  const report = await validateRepairFreezeAdvisory({ transcriptPaths: [built.sessionFile], stage: "validate" });
  const text = JSON.stringify(report);
  assert.ok(text.toLowerCase().includes("duplicate"), "validate must surface duplicate, got: " + text.slice(0, 2000));
});
test("fix-copy removes duplicate and validates clean", async () => {
  const { built } = await demoLayout();
  const bytes = await readFile(built.sessionFile, "utf8");
  const lines = bytes.trim().split("\n");
  const idxs: number[] = [];
  lines.forEach((l, i) => { if (l.includes("message-delivery")) idxs.push(i); });
  assert.equal(idxs.length, 2);
  const fixed = lines.filter((_, i) => i !== idxs[1]);
  const scratch = await mkdtemp(join(tmpdir(), "repair-owner-fix-"));
  const fixedPath = join(scratch, basename(built.sessionFile));
  await writeFile(fixedPath, fixed.join("\n") + "\n");
  const clean = await validateRepairFreezeAdvisory({ transcriptPaths: [fixedPath], stage: "validate" });
  assert.equal(clean.diagnostics.length, 0);
});
test("procedure names explicit unrepairable exit", () => {
  const p = MANUAL_REPAIR_PROCEDURE;
  assert.ok(p.includes("report_to_user"));
  assert.ok(p.includes("moderator_control"));
  const low = p.toLowerCase();
  assert.ok(low.includes("unrepairable") || low.includes("blocker") || low.includes("without"), "dead-end named, got:\n" + p);
  assert.ok(!p.includes("abandon"));
});
test("seeded freeze fix-copy commits with conservation (backend)", async () => {
  const { directory, built } = await demoLayout();
  const { approveRepairReplace, createRepairApprovalLedger, commitRepairReplace } = await import("../src/coordination/repair-commit.ts");
  const snapshot = await freezeRepairTargets(directory, [built.sessionFile]);
  assert.equal(snapshot.entries.length, 1);
  const ledger = createRepairApprovalLedger();
  const approval = approveRepairReplace({ snapshotId: snapshot.snapshotId, approver: "owner-1", ownerId: "owner-1", provenance: "owner-session-trigger" });
  const bytes = await readFile(built.sessionFile, "utf8");
  const lines = bytes.trim().split("\n");
  const idxs: number[] = [];
  lines.forEach((l, i) => { if (l.includes("message-delivery")) idxs.push(i); });
  const fixed = lines.filter((_, i) => i !== idxs[1]);
  const scratch = await mkdtemp(join(tmpdir(), "repair-owner-commit-"));
  const fixedPath = join(scratch, basename(built.sessionFile));
  await writeFile(fixedPath, fixed.join("\n") + "\n");
  const backupRoot = await mkdtemp(join(tmpdir(), "repair-owner-backup-"));
  const journalDir = await mkdtemp(join(tmpdir(), "repair-owner-journal-"));
  const result = await commitRepairReplace({
    workflowDirectory: directory, snapshot, approval, ledger,
    repairedBySource: { [built.sessionFile]: fixedPath },
    backupRoot, journalDir, attemptId: "attempt-owner-target-1", ownerId: "owner-1",
  });
  assert.equal(result.disposition, "committed");
  assert.equal(result.files[0]!.source, built.sessionFile);
});
