import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import { isRepairManagedPath } from "./manual-repair.ts";
import { transcriptFromSessionFile } from "../pi-integration/session-manager-transcript.ts";
export type LiveRepairGate = Readonly<{ phase: string; failed: boolean; hasRecord: boolean }>;
export function shouldJoinLiveRepair(existing: LiveRepairGate | undefined): boolean {
  if (!existing) return false;
  if (!existing.hasRecord) return false;
  if (existing.failed) return false;
  if (existing.phase === "dormant") return false;
  return true;
}
export async function listFrozenRepairTargets(workflowDirectory: string): Promise<readonly string[]> {
  if (!isAbsolute(workflowDirectory) || workflowDirectory.includes("\0")) {
    throw new Error("invalid_input: workflow directory must be an absolute path");
  }
  // Recursive walk with isRepairManagedPath as the filter: the repair/
  // namespace is excluded at any depth, so the guard is load-bearing rather
  // than dead on a top-level listing.
  const targets: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingDirectory(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (isRepairManagedPath(full, workflowDirectory)) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      targets.push(full);
    }
  }
  try {
    await walk(workflowDirectory);
  } catch (error) {
    if (isMissingDirectory(error)) return [];
    throw error;
  }
  targets.sort();
  return targets;
}
function isMissingDirectory(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}
export type FrozenBackupEntry = Readonly<{ source: string; backupPath: string; sha256: string }>;
export type FrozenBackup = Readonly<{ backupDir: string; manifestPath: string; entries: readonly FrozenBackupEntry[] }>;
export async function backupFrozenTargets(sources: readonly string[], backupRoot: string): Promise<FrozenBackup> {
  if (!isAbsolute(backupRoot) || backupRoot.includes("\0")) {
    throw new Error("invalid_input: backup root must be an absolute path");
  }
  if (sources.length === 0) throw new Error("invalid_input: backup needs at least one frozen target");
  for (const source of sources) {
    if (!isAbsolute(source) || source.includes("\0")) throw new Error("invalid_input: frozen target must be an absolute path: " + source);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(backupRoot, "repair-backup-" + stamp + "-" + randomUUID().slice(0, 8));
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  // mkdir mode is masked by umask: enforce owner-only on the dir itself.
  await chmod(backupDir, 0o700);
  const entries: FrozenBackupEntry[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const hash = await sha256File(source);
    let base = basename(source);
    let candidate = join(backupDir, base);
    let counter = 1;
    while (seen.has(candidate)) {
      candidate = join(backupDir, counter + "-" + base);
      counter += 1;
    }
    seen.add(candidate);
    await copyFile(source, candidate);
    // copyFile follows the source mode masked by umask: enforce owner-only.
    await chmod(candidate, 0o600);
    const copiedHash = await sha256File(candidate);
    if (copiedHash !== hash) throw new Error("backup_failed: hash mismatch after copy: " + source);
    entries.push({ source, backupPath: candidate, sha256: hash });
  }
  entries.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const manifestPath = join(backupDir, "manifest.json");
  const manifest = { createdAt: new Date().toISOString(), entries: entries.map((entry) => ({ source: entry.source, backupFile: basename(entry.backupPath), sha256: entry.sha256 })) };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return { backupDir, manifestPath, entries };
}
export type FrozenRestoreEntry = Readonly<{ backupPath: string; restoredPath: string; sha256: string }>;
/**
 * Inspect-only restore: copies backup bytes to a caller-chosen inspect dir
 * for human review. It never writes live workflow targets; the explicit
 * replace path (repair-commit.ts) is the only writer. A rename to
 * inspectFrozenBackup is deferred to checkpoint 4 (see plan).
 */
export async function restoreFrozenBackup(backupDir: string, restoreDir: string): Promise<Readonly<{ entries: readonly FrozenRestoreEntry[] }>> {
  if (!isAbsolute(backupDir) || !isAbsolute(restoreDir)) throw new Error("invalid_input: backup and restore dirs must be absolute");
  const manifestRaw = await readFile(join(backupDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as { entries?: Array<{ backupFile?: string; sha256?: string }> };
  if (!manifest || !Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error("invalid_input: backup manifest has no entries: " + backupDir);
  await mkdir(restoreDir, { recursive: true });
  const entries: FrozenRestoreEntry[] = [];
  for (const item of manifest.entries) {
    if (!item || typeof item.backupFile !== "string" || typeof item.sha256 !== "string") throw new Error("invalid_input: backup manifest entry is malformed");
    const backupPath = join(backupDir, item.backupFile);
    const restoredPath = join(restoreDir, item.backupFile);
    await copyFile(backupPath, restoredPath);
    const restoredHash = await sha256File(restoredPath);
    if (restoredHash !== item.sha256) throw new Error("restore_failed: hash mismatch for " + item.backupFile);
    entries.push({ backupPath, restoredPath, sha256: restoredHash });
  }
  entries.sort((a, b) => (a.restoredPath < b.restoredPath ? -1 : a.restoredPath > b.restoredPath ? 1 : 0));
  return { entries };
}
export type FrozenCopyInspection = Readonly<{ sessionPath: string; headerId: string; entryCount: number; blocking?: Readonly<{ reason: string; entryId?: string }> }>;
export async function inspectFrozenCopy(copyPath: string): Promise<FrozenCopyInspection> {
  if (!isAbsolute(copyPath)) throw new Error("invalid_input: frozen copy must be an absolute path");
  const transcript = transcriptFromSessionFile(copyPath, { fresh: true });
  const inspection = await transcript.refresh();
  const header = inspection.header;
  const entries = inspection.entries;
  if (!header || typeof (header as { id?: unknown }).id !== "string" || (header as { id: string }).id.length === 0) {
    return { sessionPath: copyPath, headerId: "", entryCount: entries.length, blocking: { reason: "evidence_unavailable: frozen copy has no native session header: " + copyPath } };
  }
  const headerId = (header as { id: string }).id;
  if (entries.length === 0) {
    return { sessionPath: copyPath, headerId, entryCount: 0, blocking: { reason: "evidence_unavailable: frozen copy has no entries: " + copyPath } };
  }
  return { sessionPath: copyPath, headerId, entryCount: entries.length };
}
export type FrozenCopyVerification = Readonly<{ sessionPath: string; disposition: "pass" | "fail"; diagnostics: readonly { file: string; entryId?: string; reason: string }[]; warnings: readonly string[]; outOfScope: readonly string[] }>;
const KNOWN_SPAWN_TOOLS = new Set(["agent_message", "agent_wait", "agent_spawn", "agent_observe", "agent_control", "ask_user", "workflow_resume", "moderator_control", "report_to_user", "repair_validate"]);
export async function verifyFrozenCopy(copyPath: string): Promise<FrozenCopyVerification> {
  if (!isAbsolute(copyPath)) throw new Error("invalid_input: frozen copy must be an absolute path");
  let inspection;
  try {
    const transcript = transcriptFromSessionFile(copyPath, { fresh: true });
    inspection = await transcript.refresh();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { sessionPath: copyPath, disposition: "fail", diagnostics: [{ file: copyPath, reason: "replay_failed: cannot dry-replay frozen copy: " + reason }], warnings: [], outOfScope: [] };
  }
  const diagnostics: Array<{ file: string; entryId?: string; reason: string }> = [];
  const warnings: string[] = [];
  const outOfScope: string[] = [];
  const header = inspection.header;
  if (!header || typeof (header as { id?: unknown }).id !== "string") {
    diagnostics.push({ file: copyPath, reason: "replay_failed: frozen copy has no native session header" });
    return { sessionPath: copyPath, disposition: "fail", diagnostics, warnings, outOfScope };
  }
  for (const entry of inspection.entries) {
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type?: string; name?: string; arguments?: unknown; id?: string }>) {
      if (!part || part.type !== "toolCall" || typeof part.name !== "string") continue;
      if (part.name === "agent_spawn") {
        const args = part.arguments as { title?: unknown } | null | undefined;
        const title = args && typeof args === "object" ? (args as { title?: unknown }).title : undefined;
        if (typeof title !== "string" || title.trim().length === 0) {
          const callId = typeof part.id === "string" ? part.id : "unknown-call";
          outOfScope.push("missing-title: agent_spawn without Creation Request title at entry " + entry.id + " call " + callId + " in file " + copyPath + ": cleanup is out of scope");
        }
      }
      if (!KNOWN_SPAWN_TOOLS.has(part.name)) {
        warnings.push("unknown-tool: " + part.name + " at entry " + entry.id + " in file " + copyPath + " needs human review");
      }
    }
  }
  if (outOfScope.length > 0) {
    warnings.push("replay-pass does not imply safe: missing-title cleanup is out of scope for " + copyPath);
  }
  return { sessionPath: copyPath, disposition: "pass", diagnostics, warnings, outOfScope };
}
