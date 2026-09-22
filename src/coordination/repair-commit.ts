import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { backupFrozenTargets, listFrozenRepairTargets, sha256File, shouldJoinLiveRepair, verifyFrozenCopy } from "./repair-freeze.ts";
import type { LiveRepairGate } from "./repair-freeze.ts";
export type RepairFrozenSnapshotEntry = Readonly<{ source: string; sha256: string }>;
export type RepairFrozenSnapshot = Readonly<{ snapshotId: string; createdAt: string; workflowDirectory: string; entries: readonly RepairFrozenSnapshotEntry[] }>;
export type RepairReplaceApproval = Readonly<{ approvalId: string; snapshotId: string; approver: string; provenance: string; createdAt: string }>;
export type RepairApprovalLedger = { consumed: Set<string>; revoked: Set<string> };
export type RepairPreCommitAudit = Readonly<{ snapshotId: string; targetCount: number; files: readonly { source: string; sha256: string }[]; warnings: readonly string[]; outOfScope: readonly string[]; diffSummary: string; backupLocation: undefined }>;
export type RepairCommitAudit = Readonly<{ snapshotId: string; targetCount: number; files: readonly { source: string; sha256: string }[]; warnings: readonly string[]; outOfScope: readonly string[]; diffSummary: string; backupLocation: string }>;
export type RepairedOwnerIdle = Readonly<{ ownerId: string; idle: true; idleUntil: "human-message"; humanOnlyHold: true; autoResume: false; autoViewReturn: false; draftsPreserved: true; drafts: unknown; turnWithoutHumanMessage: false }>;
/**
 * Owner-session approval for the explicit replace path.
 *
 * Construction site is the coordinator freeze under trigger authority
 * (/agents repair IS the approval: owner-session-trigger, approver === ownerId,
 * bound to the exact snapshot). Approvals must only be constructed there with
 * approver set to the OwnerIdentity agentId of that Owner session; the boundary
 * check below enforces approver === ownerId. There is deliberately no default
 * authority: a bare "owner" string would let any caller mint approval.
 */
export function approveRepairReplace(options: Readonly<{ snapshotId: string; approver: string; ownerId: string; provenance: string }>): RepairReplaceApproval {
  const snapshotId = (options as { snapshotId?: unknown }).snapshotId;
  const provenance = (options as { provenance?: unknown }).provenance;
  const approver = (options as { approver?: unknown }).approver;
  const ownerId = (options as { ownerId?: unknown }).ownerId;
  if (typeof snapshotId !== "string" || snapshotId.length === 0) throw new Error("invalid_input: repair replace approval needs a frozen snapshot id");
  if (provenance !== "owner-session-trigger") throw new Error("unauthorized: repair replace needs an explicit Owner-session trigger (owner-session-trigger), got " + String(provenance) + "; advisory validate reports grant zero authority; model tool calls and moderator_control resolve never authorize");
  if (typeof ownerId !== "string" || ownerId.length === 0) throw new Error("invalid_input: repair replace approval needs the Owner-session Owner id");
  if (typeof approver !== "string" || approver.length === 0) throw new Error("invalid_input: repair replace approval needs an explicit approver; there is no default authority");
  if (approver !== ownerId) throw new Error("unauthorized: repair replace approver must be the Owner-session OwnerIdentity agentId");
  return { approvalId: randomUUID(), snapshotId, approver, provenance, createdAt: new Date().toISOString() };
}
export function createRepairApprovalLedger(): RepairApprovalLedger {
  return { consumed: new Set<string>(), revoked: new Set<string>() };
}
/**
 * In-memory Esc/human-message revocation. Production Owner-session input
 * wiring (Esc key + new human message via the real input path) revokes the
 * pending approvalId through revokeRepairApprovalPersisted, which persists
 * via the ledger next to the journal. Direct calls are for tests only;
 * crash-safe callers must use the persisted variant.
 */
export function notifyRepairHumanInputBeforeCommit(ledger: RepairApprovalLedger, approvalId: string, kind: "esc" | "human-message"): void {
  if (!ledger || !(ledger.revoked instanceof Set)) throw new Error("invalid_input: repair approval ledger is required");
  if (typeof approvalId !== "string" || approvalId.length === 0) throw new Error("invalid_input: repair approval id is required");
  if (kind !== "esc" && kind !== "human-message") throw new Error("invalid_input: repair human input must be esc or human-message");
  ledger.revoked.add(approvalId);
}
/** Persisted-ledger filename inside the journal dir (mode 600). */
export const REPAIR_LEDGER_FILENAME = "repair-ledger.json";
function repairLedgerPath(journalDir: string): string {
  return join(journalDir, REPAIR_LEDGER_FILENAME);
}
function readLedgerSets(raw: unknown): { consumed: string[]; revoked: string[] } {
  if (!raw || typeof raw !== "object") throw new Error("invalid_input: repair ledger is malformed");
  const consumed = (raw as { consumed?: unknown }).consumed;
  const revoked = (raw as { revoked?: unknown }).revoked;
  if (!Array.isArray(consumed) || !consumed.every((id) => typeof id === "string")) throw new Error("invalid_input: repair ledger consumed set is malformed");
  if (!Array.isArray(revoked) || !revoked.every((id) => typeof id === "string")) throw new Error("invalid_input: repair ledger revoked set is malformed");
  return { consumed: consumed as string[], revoked: revoked as string[] };
}
/** Persist the approval ledger alongside the snapshot/journal dir (mode 600). */
export async function persistRepairApprovalLedger(journalDir: string, ledger: RepairApprovalLedger): Promise<string> {
  if (!isAbsolute(journalDir) || journalDir.indexOf("\0") !== -1) throw new Error("invalid_input: journal directory must be an absolute path");
  if (!ledger || !(ledger.consumed instanceof Set) || !(ledger.revoked instanceof Set)) throw new Error("invalid_input: repair approval ledger is required");
  await mkdir(journalDir, { recursive: true });
  const ledgerPath = repairLedgerPath(journalDir);
  const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), consumed: [...ledger.consumed].sort(), revoked: [...ledger.revoked].sort() }, null, 2) + "\n";
  await writeFile(ledgerPath, body, { encoding: "utf8", mode: 0o600 });
  return ledgerPath;
}
/** Load the persisted ledger; a missing file means no persisted revocations. */
export async function loadRepairApprovalLedger(journalDir: string): Promise<RepairApprovalLedger> {
  if (!isAbsolute(journalDir) || journalDir.indexOf("\0") !== -1) throw new Error("invalid_input: journal directory must be an absolute path");
  let raw: string;
  try {
    raw = await readFile(repairLedgerPath(journalDir), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return createRepairApprovalLedger();
    throw error;
  }
  const sets = readLedgerSets(JSON.parse(raw) as unknown);
  return { consumed: new Set(sets.consumed), revoked: new Set(sets.revoked) };
}
/**
 * Crash-safe Esc/human-message revocation: records the revocation in the
 * in-memory ledger and persists it next to the journal so a restart still
 * refuses the revoked approval. The Owner-session Esc + new-human-message
 * input path calls this through the persisted ledger store; never auto-retries.
 */
export async function revokeRepairApprovalPersisted(journalDir: string, ledger: RepairApprovalLedger, approvalId: string, kind: "esc" | "human-message"): Promise<void> {
  notifyRepairHumanInputBeforeCommit(ledger, approvalId, kind);
  await persistRepairApprovalLedger(journalDir, ledger);
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
  if (ledger && ledger.revoked && (ledger.revoked as ReadonlySet<string>).has(approval.approvalId)) throw new Error("revoked: repair approval " + approval.approvalId + " was revoked by human input before commit; never auto-retry, ask the Owner for a fresh /agents repair trigger");
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
export async function runRepairPreCommitGate(options: Readonly<{ workflowDirectory: string; snapshot: RepairFrozenSnapshot; approval: RepairReplaceApproval; ledger: RepairApprovalLedger; liveGate?: LiveRepairGate }>): Promise<RepairPreCommitAudit> {
  if (!options.ledger || !(options.ledger.consumed instanceof Set) || !(options.ledger.revoked instanceof Set)) throw new Error("invalid_input: repair approval ledger is required");
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
export type RepairCommitHooks = Readonly<{ crashAfterJournalCommit?: boolean; crashAfterApplyBeforeSeal?: boolean; admitRepaired?: () => Promise<void> | void }>;
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
/** Journal filename segment: strict charset so attempt ids can never escape the journal dir. */
export const REPAIR_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * Repair artifacts must live outside the frozen workflow directory. A backup
 * or journal inside the workflow would itself end in .jsonl (backup copies)
 * or be mistaken for repair input, causing drift or self-repair loops.
 */
export function assertRepairArtifactDirOutsideWorkflow(workflowDirectory: string, artifactDir: string, kind: string): void {
  if (!isAbsolute(workflowDirectory) || !isAbsolute(artifactDir)) throw new Error("invalid_input: " + kind + " and workflow directory must be absolute paths");
  if (artifactDir === workflowDirectory || artifactDir.startsWith(workflowDirectory + sep)) {
    throw new Error("invalid_input: " + kind + " must live outside the frozen workflow directory: " + artifactDir);
  }
  const reverse = relative(artifactDir, workflowDirectory);
  if (reverse === "" || (!reverse.startsWith(".." + sep) && reverse !== "..")) {
    throw new Error("invalid_input: " + kind + " must not contain the frozen workflow directory: " + artifactDir);
  }
}
/**
 * Explicit replace path behind Owner-session trigger approval (/agents repair
 * IS the approval). Production callers must be the coordinator freeze under
 * trigger authority only (approver === ownerId,
 * provenance owner-session-trigger, bound to the exact snapshot id).
 * Wiring-time enforcement: repaired-Owner idle hold (openRepairedOwnerIdle
 * fields), draft preservation, Runtime join/release (never auto-resume or
 * auto view-return), and no cross-host adoption.
 */
export async function commitRepairReplace(options: Readonly<{ workflowDirectory: string; snapshot: RepairFrozenSnapshot; approval: RepairReplaceApproval; ledger: RepairApprovalLedger; liveGate?: LiveRepairGate; repairedBySource: Readonly<Record<string, string>>; backupRoot: string; journalDir: string; attemptId?: string; ownerId: string; drafts?: unknown; testHooks?: RepairCommitHooks }>): Promise<RepairCommitResult> {
  const attemptId = options.attemptId ? options.attemptId : randomUUID();
  if (typeof attemptId !== "string" || !REPAIR_ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error("invalid_input: repair attempt id must match /^[A-Za-z0-9_-]{1,128}$/ (safe journal filename segment, no path separators)");
  if (!options || !isAbsolute(options.workflowDirectory)) throw new Error("invalid_input: workflow directory must be an absolute path");
  if (!options.snapshot || typeof options.snapshot.snapshotId !== "string") throw new Error("invalid_input: repair snapshot is required");
  if (!options.approval || typeof (options.approval as { approvalId?: unknown }).approvalId !== "string") throw new Error("invalid_input: repair approval is required");
  if (!options.ledger || !(options.ledger.consumed instanceof Set) || !(options.ledger.revoked instanceof Set)) throw new Error("invalid_input: repair approval ledger is required");
  if (!options.repairedBySource || typeof options.repairedBySource !== "object") throw new Error("invalid_input: repaired set is required");
  if (!isAbsolute(options.backupRoot)) throw new Error("invalid_input: backup root must be an absolute path");
  if (!isAbsolute(options.journalDir)) throw new Error("invalid_input: journal directory must be an absolute path");
  assertRepairArtifactDirOutsideWorkflow(options.workflowDirectory, options.backupRoot, "backup root");
  assertRepairArtifactDirOutsideWorkflow(options.workflowDirectory, options.journalDir, "journal dir");
  if (typeof options.ownerId !== "string" || options.ownerId.length === 0) throw new Error("invalid_input: repaired Owner idle needs an owner id");
  await mkdir(options.journalDir, { recursive: true });
  const persistedLedger = await loadRepairApprovalLedger(options.journalDir);
  const effectiveLedger: RepairApprovalLedger = {
    consumed: new Set<string>([...options.ledger.consumed, ...persistedLedger.consumed]),
    revoked: new Set<string>([...options.ledger.revoked, ...persistedLedger.revoked]),
  };
  const journalPath = journalPathFor(options.journalDir, attemptId);
  try {
    const existingRaw = await readFile(journalPath, "utf8");
    const existing = JSON.parse(existingRaw) as { attemptId?: unknown; snapshotId?: unknown; approvalId?: unknown; generation?: unknown; backupDir?: unknown; manifestPath?: unknown; files?: unknown; committedAt?: unknown; audit?: unknown };
    // Same-attempt join replays the receipt without reapplying bytes, but it
    // must still enforce the approval checks a fresh commit would face.
    // Consumed is the only exemption: this identical attempt consumed its own
    // approval when it first committed.
    if (typeof existing.snapshotId !== "string" || existing.snapshotId !== options.snapshot.snapshotId) throw new Error("stale_approval: repair journal for attempt " + attemptId + " binds to snapshot " + String(existing.snapshotId) + ", not " + options.snapshot.snapshotId);
    if (options.approval.snapshotId !== options.snapshot.snapshotId) throw new Error("stale_approval: repair approval " + options.approval.approvalId + " binds to snapshot " + String(options.approval.snapshotId) + ", not " + options.snapshot.snapshotId);
    if (typeof existing.approvalId !== "string" || existing.approvalId !== options.approval.approvalId) throw new Error("stale_approval: repair journal for attempt " + attemptId + " was committed under a different approval; never reuse an attempt id across approvals");
    if (effectiveLedger.revoked.has(options.approval.approvalId)) throw new Error("revoked: repair approval " + options.approval.approvalId + " was revoked by human input before commit; never auto-retry, ask the Owner for a fresh /agents repair trigger");
    const files = Array.isArray(existing.files) ? existing.files as Array<{ source: string; sha256Before: string; sha256After: string }> : [];
    const auditRaw = (existing.audit && typeof existing.audit === "object" ? existing.audit : {}) as { diffSummary?: unknown; warnings?: unknown; outOfScope?: unknown };
    const auditWarnings = Array.isArray(auditRaw.warnings) ? auditRaw.warnings as string[] : [];
    const auditOutOfScope = Array.isArray(auditRaw.outOfScope) ? auditRaw.outOfScope as string[] : [];
    const backupDir = typeof existing.backupDir === "string" ? existing.backupDir : "";
    const audit: RepairCommitAudit = { snapshotId: typeof existing.snapshotId === "string" ? existing.snapshotId : options.snapshot.snapshotId, targetCount: files.length, files: files.map((file) => ({ source: file.source, sha256: file.sha256After })), warnings: auditWarnings, outOfScope: auditOutOfScope, diffSummary: typeof auditRaw.diffSummary === "string" ? auditRaw.diffSummary : "joined committed repair", backupLocation: backupDir };
    return { disposition: "joined-committed", attemptId: typeof existing.attemptId === "string" ? existing.attemptId : attemptId, snapshotId: audit.snapshotId, generation: typeof existing.generation === "number" ? existing.generation : 0, backupDir, manifestPath: typeof existing.manifestPath === "string" ? existing.manifestPath : "", files, committedAt: typeof existing.committedAt === "string" ? existing.committedAt : new Date(0).toISOString(), audit, idle: openRepairedOwnerIdle(options.ownerId, { drafts: options.drafts }) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code !== "ENOENT") throw error;
    if (!error || typeof error !== "object" || !("code" in error)) {
      // Join guards and malformed-journal SyntaxErrors carry no code: a
      // refusal or corrupt receipt must never fall through into a fresh commit.
      throw error;
    }
  }
  const gate = await runRepairPreCommitGate({ workflowDirectory: options.workflowDirectory, snapshot: options.snapshot, approval: options.approval, ledger: effectiveLedger, liveGate: options.liveGate });
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
  if (options.testHooks && options.testHooks.crashAfterApplyBeforeSeal) throw new Error("crash_simulated: apply finished, generation seal withheld for attempt " + attemptId);
  // Seal only after backup + apply + verify: a crash during apply must leave
  // the generation unsealed and write no journal.
  const sealedBase = await readSealedGeneration(options.journalDir);
  const generation = sealedBase + 1;
  await writeFile(generationPath(options.journalDir), JSON.stringify({ generation, updatedAt: new Date().toISOString() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  const committedAt = new Date().toISOString();
  const journal = { version: 1, attemptId, snapshotId: options.snapshot.snapshotId, approvalId: options.approval.approvalId, approver: options.approval.approver, provenance: options.approval.provenance, generation, committedAt, workflowDirectory: options.workflowDirectory, backupDir: backup.backupDir, manifestPath: backup.manifestPath, files: applied, audit: { diffSummary: audit.diffSummary, warnings: audit.warnings, outOfScope: audit.outOfScope }, status: "committed" };
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  options.ledger.consumed.add(options.approval.approvalId);
  await persistRepairApprovalLedger(options.journalDir, options.ledger);
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
  const parsed = JSON.parse(raw) as { attemptId?: unknown; snapshotId?: unknown; generation?: unknown; backupDir?: unknown; manifestPath?: unknown; files?: unknown; committedAt?: unknown };
  if (typeof parsed.attemptId !== "string" || typeof parsed.snapshotId !== "string" || typeof parsed.generation !== "number" || typeof parsed.backupDir !== "string" || !Array.isArray(parsed.files) || typeof parsed.committedAt !== "string") throw new Error("invalid_input: repair journal is not a committed replace receipt: " + journalPath);
  if (parsed.backupDir.length === 0) throw new Error("invalid_input: repair journal has no backup dir: " + journalPath);
  if (typeof parsed.manifestPath !== "string" || parsed.manifestPath.length === 0) throw new Error("invalid_input: repair journal has no backup manifest: " + journalPath);
  const files = parsed.files as Array<{ source?: unknown; sha256Before?: unknown; sha256After?: unknown }>;
  if (files.length === 0) throw new Error("invalid_input: repair journal has no committed files: " + journalPath);
  for (const file of files) {
    if (!file || typeof file !== "object" || typeof file.source !== "string" || file.source.length === 0 || typeof file.sha256Before !== "string" || typeof file.sha256After !== "string") throw new Error("invalid_input: repair journal file entry is malformed: " + journalPath);
  }
  return { disposition: "committed-awaiting-admission", attemptId: parsed.attemptId, snapshotId: parsed.snapshotId, generation: parsed.generation, backupDir: parsed.backupDir, files: files as Array<{ source: string; sha256Before: string; sha256After: string }>, committedAt: parsed.committedAt };
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
