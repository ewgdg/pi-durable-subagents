import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { backupFrozenTargets, listFrozenRepairTargets, sha256File, shouldJoinLiveRepair, verifyFrozenCopy } from "./repair-freeze.ts";
import type { LiveRepairGate } from "./repair-freeze.ts";
export type RepairFrozenSnapshotEntry = Readonly<{ source: string; sha256: string }>;
export type RepairFrozenSnapshot = Readonly<{ snapshotId: string; createdAt: string; workflowDirectory: string; entries: readonly RepairFrozenSnapshotEntry[] }>;
export type RepairReplaceApproval = Readonly<{ approvalId: string; snapshotId: string; approver: string; provenance: string; createdAt: string }>;
export type RepairApprovalLedger = { consumed: Set<string>; revoked: Set<string> };
export type RepairPreCommitAudit = Readonly<{ snapshotId: string; targetCount: number; files: readonly { source: string; sha256: string }[]; warnings: readonly string[]; outOfScope: readonly string[]; diffSummary: string; backupLocation: undefined }>;
export type RepairCommitAudit = Readonly<{ snapshotId: string; targetCount: number; files: readonly { source: string; sha256: string }[]; warnings: readonly string[]; outOfScope: readonly string[]; diffSummary: string; backupLocation: string }>;
export type RepairedOwnerIdle = Readonly<{ ownerId: string; idle: true; idleUntil: "human-message"; humanOnlyHold: true; autoResume: false; autoViewReturn: false; draftsPreserved: true; drafts: unknown; turnWithoutHumanMessage: false }>;
export function approveRepairReplace(options: Readonly<{ snapshotId: string; approver?: string; provenance: string }>): RepairReplaceApproval {
  const snapshotId = (options as { snapshotId?: unknown }).snapshotId;
  const provenance = (options as { provenance?: unknown }).provenance;
  const approver = (options as { approver?: unknown }).approver;
  if (typeof snapshotId !== "string" || snapshotId.length === 0) throw new Error("invalid_input: repair replace approval needs a frozen snapshot id");
  if (provenance !== "owner-session-confirm") throw new Error("unauthorized: repair replace needs an explicit Owner-session command (owner-session-confirm), got " + String(provenance) + "; advisory validate reports grant zero authority; model tool calls and moderator_control resolve never authorize");
  const owner = typeof approver === "string" && approver.length > 0 ? approver : "owner";
  return { approvalId: randomUUID(), snapshotId, approver: owner, provenance, createdAt: new Date().toISOString() };
}
export function createRepairApprovalLedger(): RepairApprovalLedger {
  return { consumed: new Set<string>(), revoked: new Set<string>() };
}
export function notifyRepairHumanInputBeforeCommit(ledger: RepairApprovalLedger, approvalId: string, kind: "esc" | "human-message"): void {
  if (!ledger || !(ledger.revoked instanceof Set)) throw new Error("invalid_input: repair approval ledger is required");
  if (typeof approvalId !== "string" || approvalId.length === 0) throw new Error("invalid_input: repair approval id is required");
  if (kind !== "esc" && kind !== "human-message") throw new Error("invalid_input: repair human input must be esc or human-message");
  ledger.revoked.add(approvalId);
}
function resolveExpectedSnapshotId(expected: string | Readonly<{ snapshotId?: unknown }>): string {
  if (typeof expected === "string") return expected;
  if (expected && typeof expected === "object" && typeof (expected as { snapshotId?: unknown }).snapshotId === "string") return (expected as { snapshotId: string }).snapshotId;
  return "";
}
export function assertRepairApprovalFresh(approval: Readonly<{ approvalId?: unknown; snapshotId?: unknown }>, expected: string | Readonly<{ snapshotId?: unknown }>, ledger?: Readonly<{ consumed?: ReadonlySet<string>; revoked?: ReadonlySet<string> }>): void {
  if (!approval || typeof approval.approvalId !== "string" || typeof approval.snapshotId !== "string") throw new Error("invalid_input: repair approval is required");
  const expectedId = resolveExpectedSnapshotId(expected);
  if (approval.snapshotId !== expectedId) throw new Error("stale_approval: repair approval " + approval.approvalId + " binds to snapshot " + String(approval.snapshotId) + ", not " + String(expectedId));
  if (ledger && ledger.revoked && (ledger.revoked as ReadonlySet<string>).has(approval.approvalId)) throw new Error("revoked: repair approval " + approval.approvalId + " was revoked by human input before commit; never auto-retry, ask the Owner for a fresh confirm");
  if (ledger && ledger.consumed && (ledger.consumed as ReadonlySet<string>).has(approval.approvalId)) throw new Error("consumed: repair approval " + approval.approvalId + " is single-use and already consumed");
}
export async function freezeRepairTargets(workflowDirectory: string): Promise<RepairFrozenSnapshot> {
  if (!isAbsolute(workflowDirectory) || workflowDirectory.indexOf("\0") !== -1) throw new Error("invalid_input: workflow directory must be an absolute path");
  const targets = await listFrozenRepairTargets(workflowDirectory);
  const entries: Array<{ source: string; sha256: string }> = [];
  for (const source of targets) entries.push({ source, sha256: await sha256File(source) });
  entries.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return { snapshotId: randomUUID(), createdAt: new Date().toISOString(), workflowDirectory, entries };
}
export async function runRepairPreCommitGate(options: Readonly<{ workflowDirectory: string; snapshot: RepairFrozenSnapshot; approval: RepairReplaceApproval; ledger?: RepairApprovalLedger; liveGate?: LiveRepairGate }>): Promise<RepairPreCommitAudit> {
  const snapshot = options.snapshot;
  if (!snapshot || typeof snapshot.snapshotId !== "string" || !Array.isArray(snapshot.entries)) throw new Error("invalid_input: repair snapshot is required");
  assertRepairApprovalFresh(options.approval, snapshot.snapshotId, options.ledger);
  if (shouldJoinLiveRepair(options.liveGate)) throw new Error("join_live_repair: a live repair writer still holds the repair namespace; retire it before replacing Owner targets");
  const current = await listFrozenRepairTargets(options.workflowDirectory);
  const wanted = new Map<string, string>();
  for (const entry of snapshot.entries) wanted.set(entry.source, entry.sha256);
  const currentHashes = new Map<string, string>();
  for (const source of current) currentHashes.set(source, await sha256File(source));
  const added = current.filter((source) => !wanted.has(source));
  const removed = snapshot.entries.map((entry) => entry.source).filter((source) => !currentHashes.has(source));
  const changed = snapshot.entries.filter((entry) => currentHashes.has(entry.source) && currentHashes.get(entry.source) !== entry.sha256).map((entry) => entry.source + " (expected " + entry.sha256.slice(0, 12) + ", found " + String(currentHashes.get(entry.source)).slice(0, 12) + ")");
  if (added.length > 0 || removed.length > 0 || changed.length > 0) {
    throw new Error("drift: frozen targets changed since snapshot " + snapshot.snapshotId + ": added [" + added.join(", ") + "]; removed [" + removed.join(", ") + "]; changed [" + changed.join(", ") + "]");
  }
  const warnings: string[] = [];
  const outOfScope: string[] = [];
  for (const source of current) {
    const verification = await verifyFrozenCopy(source);
    if (verification.disposition !== "pass") throw new Error("replay_failed: frozen copy failed dry-replay for " + source + ": " + verification.diagnostics.map((item) => item.reason).join("; "));
    for (const warning of verification.warnings) warnings.push(warning);
    for (const note of verification.outOfScope) outOfScope.push(note);
  }
  const files = current.map((source) => ({ source, sha256: currentHashes.get(source) as string }));
  files.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const diffSummary = files.length + " frozen targets verified against snapshot " + snapshot.snapshotId + ": no drift, replay pass (pass does not imply safe)";
  return { snapshotId: snapshot.snapshotId, targetCount: files.length, files, warnings, outOfScope, diffSummary, backupLocation: undefined };
}
export function openRepairedOwnerIdle(ownerId: string, options?: Readonly<{ drafts?: unknown }>): RepairedOwnerIdle {
  if (typeof ownerId !== "string" || ownerId.length === 0) throw new Error("invalid_input: repaired Owner idle needs an owner id");
  return { ownerId, idle: true, idleUntil: "human-message", humanOnlyHold: true, autoResume: false, autoViewReturn: false, draftsPreserved: true, drafts: options ? options.drafts : undefined, turnWithoutHumanMessage: false };
}
export type RepairCommitHooks = Readonly<{ crashAfterJournalCommit?: boolean; admitRepaired?: () => Promise<void> | void }>;
export type RepairCommitResult = Readonly<{ disposition: "committed" | "committed-admission-failed" | "joined-committed"; attemptId: string; snapshotId: string; generation: number; backupDir: string; manifestPath: string; files: readonly { source: string; sha256Before: string; sha256After: string }[]; committedAt: string; audit: RepairCommitAudit; idle: RepairedOwnerIdle; admissionError?: string }>;
function generationPath(journalDir: string): string {
  return join(journalDir, "repair-generation.json");
}
function journalPathFor(journalDir: string, attemptId: string): string {
  return join(journalDir, "repair-journal-" + attemptId + ".json");
}
async function readSealedGeneration(journalDir: string): Promise<number> {
  try {
    const raw = await readFile(generationPath(journalDir), "utf8");
    const parsed = JSON.parse(raw) as { generation?: unknown } | number;
    if (typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0) return parsed;
    if (parsed && typeof parsed === "object" && typeof parsed.generation === "number" && Number.isInteger(parsed.generation) && (parsed.generation as number) >= 0) return parsed.generation as number;
    return 0;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return 0;
    throw error;
  }
}
export async function commitRepairReplace(options: Readonly<{ workflowDirectory: string; snapshot: RepairFrozenSnapshot; approval: RepairReplaceApproval; ledger: RepairApprovalLedger; liveGate?: LiveRepairGate; repairedBySource: Readonly<Record<string, string>>; backupRoot: string; journalDir: string; attemptId?: string; ownerId: string; drafts?: unknown; testHooks?: RepairCommitHooks }>): Promise<RepairCommitResult> {
  const attemptId = options.attemptId ? options.attemptId : randomUUID();
  if (typeof attemptId !== "string" || attemptId.length === 0 || attemptId.indexOf("/") !== -1 || attemptId.indexOf(String.fromCharCode(0)) !== -1) throw new Error("invalid_input: repair attempt id must be non-empty text without path separators");
  if (!options || !isAbsolute(options.workflowDirectory)) throw new Error("invalid_input: workflow directory must be an absolute path");
  if (!options.snapshot || typeof options.snapshot.snapshotId !== "string") throw new Error("invalid_input: repair snapshot is required");
  if (!options.approval || typeof (options.approval as { approvalId?: unknown }).approvalId !== "string") throw new Error("invalid_input: repair approval is required");
  if (!options.ledger || !(options.ledger.consumed instanceof Set) || !(options.ledger.revoked instanceof Set)) throw new Error("invalid_input: repair approval ledger is required");
  if (!options.repairedBySource || typeof options.repairedBySource !== "object") throw new Error("invalid_input: repaired set is required");
  if (!isAbsolute(options.backupRoot)) throw new Error("invalid_input: backup root must be an absolute path");
  if (!isAbsolute(options.journalDir)) throw new Error("invalid_input: journal directory must be an absolute path");
  if (typeof options.ownerId !== "string" || options.ownerId.length === 0) throw new Error("invalid_input: repaired Owner idle needs an owner id");
  await mkdir(options.journalDir, { recursive: true });
  const journalPath = journalPathFor(options.journalDir, attemptId);
  try {
    const existingRaw = await readFile(journalPath, "utf8");
    const existing = JSON.parse(existingRaw) as { attemptId?: unknown; snapshotId?: unknown; generation?: unknown; backupDir?: unknown; manifestPath?: unknown; files?: unknown; committedAt?: unknown; audit?: unknown };
    const files = Array.isArray(existing.files) ? existing.files as Array<{ source: string; sha256Before: string; sha256After: string }> : [];
    const auditRaw = (existing.audit && typeof existing.audit === "object" ? existing.audit : {}) as { diffSummary?: unknown; warnings?: unknown; outOfScope?: unknown };
    const auditWarnings = Array.isArray(auditRaw.warnings) ? auditRaw.warnings as string[] : [];
    const auditOutOfScope = Array.isArray(auditRaw.outOfScope) ? auditRaw.outOfScope as string[] : [];
    const backupDir = typeof existing.backupDir === "string" ? existing.backupDir : "";
    const audit: RepairCommitAudit = { snapshotId: typeof existing.snapshotId === "string" ? existing.snapshotId : options.snapshot.snapshotId, targetCount: files.length, files: files.map((file) => ({ source: file.source, sha256: file.sha256After })), warnings: auditWarnings, outOfScope: auditOutOfScope, diffSummary: typeof auditRaw.diffSummary === "string" ? auditRaw.diffSummary : "joined committed repair", backupLocation: backupDir };
    return { disposition: "joined-committed", attemptId: typeof existing.attemptId === "string" ? existing.attemptId : attemptId, snapshotId: audit.snapshotId, generation: typeof existing.generation === "number" ? existing.generation : 0, backupDir, manifestPath: typeof existing.manifestPath === "string" ? existing.manifestPath : "", files, committedAt: typeof existing.committedAt === "string" ? existing.committedAt : new Date(0).toISOString(), audit, idle: openRepairedOwnerIdle(options.ownerId, { drafts: options.drafts }) };
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || (error as { code?: string }).code !== "ENOENT") {
      if (error instanceof SyntaxError) throw error;
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  const gate = await runRepairPreCommitGate({ workflowDirectory: options.workflowDirectory, snapshot: options.snapshot, approval: options.approval, ledger: options.ledger, liveGate: options.liveGate });
  const wantedSources = options.snapshot.entries.map((entry) => entry.source).sort();
  const repairedSources = Object.keys(options.repairedBySource).sort();
  if (wantedSources.length !== repairedSources.length || wantedSources.some((source, index) => source !== repairedSources[index])) throw new Error("invalid_input: repaired set must cover exactly the frozen snapshot: wanted [" + wantedSources.join(", ") + "], got [" + repairedSources.join(", ") + "]");
  const repairedWarnings: string[] = [...gate.warnings];
  const repairedOutOfScope: string[] = [...gate.outOfScope];
  for (const source of wantedSources) {
    const repairedPath = options.repairedBySource[source] as string;
    if (typeof repairedPath !== "string" || !isAbsolute(repairedPath)) throw new Error("invalid_input: repaired file must be an absolute path for " + source);
    const verification = await verifyFrozenCopy(repairedPath);
    if (verification.disposition !== "pass") throw new Error("replay_failed: repaired file failed dry-replay for " + source + ": " + verification.diagnostics.map((item) => item.reason).join("; "));
    for (const warning of verification.warnings) if (repairedWarnings.indexOf(warning) === -1) repairedWarnings.push(warning);
    for (const note of verification.outOfScope) if (repairedOutOfScope.indexOf(note) === -1) repairedOutOfScope.push(note);
  }
  const backup = await backupFrozenTargets(wantedSources, options.backupRoot);
  const audit: RepairCommitAudit = { snapshotId: options.snapshot.snapshotId, targetCount: wantedSources.length, files: gate.files, warnings: repairedWarnings, outOfScope: repairedOutOfScope, diffSummary: gate.diffSummary, backupLocation: backup.backupDir };
  const sealedBase = await readSealedGeneration(options.journalDir);
  const generation = sealedBase + 1;
  await writeFile(generationPath(options.journalDir), JSON.stringify({ generation, updatedAt: new Date().toISOString() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  const beforeBySource = new Map(options.snapshot.entries.map((entry) => [entry.source, entry.sha256]));
  const applied: Array<{ source: string; sha256Before: string; sha256After: string }> = [];
  for (const source of wantedSources) {
    const repairedPath = options.repairedBySource[source] as string;
    const expectedAfter = await sha256File(repairedPath);
    await copyFile(repairedPath, source);
    const actualAfter = await sha256File(source);
    if (actualAfter !== expectedAfter) throw new Error("apply_failed: hash mismatch after replacing " + source);
    applied.push({ source, sha256Before: beforeBySource.get(source) as string, sha256After: actualAfter });
  }
  applied.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const committedAt = new Date().toISOString();
  const journal = { version: 1, attemptId, snapshotId: options.snapshot.snapshotId, approvalId: options.approval.approvalId, approver: options.approval.approver, provenance: options.approval.provenance, generation, committedAt, workflowDirectory: options.workflowDirectory, backupDir: backup.backupDir, manifestPath: backup.manifestPath, files: applied, audit: { diffSummary: audit.diffSummary, warnings: audit.warnings, outOfScope: audit.outOfScope }, status: "committed" };
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  options.ledger.consumed.add(options.approval.approvalId);
  if (options.testHooks && options.testHooks.crashAfterJournalCommit) throw new Error("crash_simulated: disk commit succeeded, receipt withheld for attempt " + attemptId);
  const idle = openRepairedOwnerIdle(options.ownerId, { drafts: options.drafts });
  if (options.testHooks && options.testHooks.admitRepaired) {
    try {
      await options.testHooks.admitRepaired();
    } catch (error) {
      const admissionError = error instanceof Error ? error.message : String(error);
      return { disposition: "committed-admission-failed", attemptId, snapshotId: options.snapshot.snapshotId, generation, backupDir: backup.backupDir, manifestPath: backup.manifestPath, files: applied, committedAt, audit, idle, admissionError };
    }
  }
  return { disposition: "committed", attemptId, snapshotId: options.snapshot.snapshotId, generation, backupDir: backup.backupDir, manifestPath: backup.manifestPath, files: applied, committedAt, audit, idle };
}
export async function recoverRepairCommitFromJournal(journalPath: string): Promise<Readonly<{ disposition: "committed-awaiting-admission"; attemptId: string; snapshotId: string; generation: number; backupDir: string; files: readonly { source: string; sha256Before: string; sha256After: string }[]; committedAt: string }>> {
  if (!isAbsolute(journalPath)) throw new Error("invalid_input: journal path must be an absolute path");
  const raw = await readFile(journalPath, "utf8");
  const parsed = JSON.parse(raw) as { attemptId?: unknown; snapshotId?: unknown; generation?: unknown; backupDir?: unknown; files?: unknown; committedAt?: unknown };
  if (typeof parsed.attemptId !== "string" || typeof parsed.snapshotId !== "string" || typeof parsed.generation !== "number" || typeof parsed.backupDir !== "string" || !Array.isArray(parsed.files) || typeof parsed.committedAt !== "string") throw new Error("invalid_input: repair journal is not a committed replace receipt: " + journalPath);
  return { disposition: "committed-awaiting-admission", attemptId: parsed.attemptId, snapshotId: parsed.snapshotId, generation: parsed.generation, backupDir: parsed.backupDir, files: parsed.files as Array<{ source: string; sha256Before: string; sha256After: string }>, committedAt: parsed.committedAt };
}
export const REPAIR_STOPPED_WRITER_RECOVERY_INSTRUCTIONS = [
  "Repair stopped-writer recovery: stop ALL writers before touching frozen targets.",
  "Stop the old host and keep it stopped; history selection alone never restarts a closed repair.",
  "Recover with recover-stopped by reusing existing journal: reusing existing journal replays the receipt without reapplying bytes.",
  "A closed transaction stays closed: committed receipts are never rewritten by selection or replay."
].join("\n");
export function assertRepairRecoveryPreconditions(options: Readonly<{ allWritersStopped?: unknown; oldHostStopped?: unknown; journalPath?: unknown }>): Readonly<{ reuseJournal: true; journalPath: string }> {
  if (options.allWritersStopped !== true) throw new Error("recovery_blocked: stop ALL writers before recover-stopped reuses any journal");
  if (options.oldHostStopped !== true) throw new Error("recovery_blocked: old host must stay stopped before recover-stopped reuses any journal");
  if (typeof options.journalPath !== "string" || (options.journalPath as string).length === 0) throw new Error("invalid_input: repair recovery needs a journal path");
  return { reuseJournal: true as const, journalPath: options.journalPath as string };
}
export function selectRepairHistory(): Readonly<{ restarts: false }> {
  return { restarts: false as const };
}
export function isRepairTransactionClosed(input: Readonly<{ status?: unknown }> | string): boolean {
  const status = typeof input === "string" ? input : (input as { status?: unknown }).status;
  return status === "committed" || status === "committed-awaiting-admission" || status === "committed-admission-failed" || status === "joined-committed";
}
