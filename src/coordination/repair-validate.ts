import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectFrozenCopy, sha256File, verifyFrozenCopy } from "./repair-freeze.ts";
export type InstalledRepairSource = Readonly<{ packageDir: string; version: string; docPaths: readonly string[]; stage: string; errorMessage?: string; errorStack?: string }>;
export async function describeInstalledRepairSource(options: Readonly<{ stage: string; error?: unknown }>): Promise<InstalledRepairSource> {
  if (!options || typeof options.stage !== "string" || options.stage.trim().length === 0) {
    throw new Error("invalid_input: installed-src diagnosis needs a stage");
  }
  const stage = options.stage;
  const here = fileURLToPath(import.meta.url);
  let directory = dirname(here);
  let packageDir = "";
  let version = "unknown";
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, "package.json");
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed && typeof parsed.name === "string" && parsed.name.indexOf("pi-durable-subagents") !== -1) {
        packageDir = directory;
        if (typeof parsed.version === "string" && parsed.version.length > 0) version = parsed.version;
        break;
      }
    } catch {
      // Keep walking up: never assume cwd or repo HEAD, only the executing file path.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (packageDir.length === 0) {
    throw new Error("evidence_unavailable: executing package source directory was not found from " + here);
  }
  const docPaths = [
    join(packageDir, "docs/operational-incident-moderation.md"),
    join(packageDir, "docs/cold-host-recovery.md"),
    join(packageDir, "docs/coordination-replay-rejection-design.md"),
  ];
  const error = (options as { error?: unknown }).error;
  let errorMessage: string | undefined;
  let errorStack: string | undefined;
  if (error instanceof Error) {
    errorMessage = error.message;
    errorStack = error.stack ? error.stack : String(error);
  } else if (typeof error === "string") {
    errorMessage = error;
    errorStack = error;
  } else if (error !== undefined) {
    errorMessage = String(error);
    errorStack = String(error);
  }
  return { packageDir, version, docPaths, stage, ...(errorMessage === undefined ? {} : { errorMessage }), ...(errorStack === undefined ? {} : { errorStack }) };
}
export type RepairValidateDiagnostic = Readonly<{ file: string; entryId?: string; reason: string }>;
export type RepairValidateReport = Readonly<{ advisory: true; authorizesBytes: false; sealsNothing: true; effectsApplied: false; resolveInvoked: false; diagnostics: readonly RepairValidateDiagnostic[]; unknowns: readonly string[]; warnings: readonly string[]; outOfScope: readonly string[]; files: readonly { path: string; sha256: string; entryCount: number }[]; installedSource: InstalledRepairSource }>;
export async function validateRepairFreezeAdvisory(options: Readonly<{ transcriptPaths: readonly string[]; stage?: string }>): Promise<RepairValidateReport> {
  if (!options || !Array.isArray(options.transcriptPaths) || options.transcriptPaths.length === 0) {
    throw new Error("invalid_input: repair_validate needs at least one frozen transcript path");
  }
  const stage = options.stage ? options.stage : "validate";
  const diagnostics: RepairValidateDiagnostic[] = [];
  const unknowns: string[] = [];
  const warnings: string[] = [];
  const outOfScope: string[] = [];
  const files: Array<{ path: string; sha256: string; entryCount: number }> = [];
  for (const transcriptPath of options.transcriptPaths) {
    const inspection = await inspectFrozenCopy(transcriptPath);
    const hash = await sha256File(transcriptPath);
    files.push({ path: transcriptPath, sha256: hash, entryCount: inspection.entryCount });
    if (inspection.blocking) {
      diagnostics.push({ file: transcriptPath, entryId: inspection.blocking.entryId, reason: inspection.blocking.reason });
    }
    const verification = await verifyFrozenCopy(transcriptPath);
    for (const item of verification.diagnostics) diagnostics.push(item);
    for (const note of verification.outOfScope) outOfScope.push(note);
    for (const warning of verification.warnings) {
      warnings.push(warning);
      if (warning.indexOf("unknown-tool:") === 0) unknowns.push(warning + " in file " + transcriptPath);
    }
  }
  warnings.push("prior validate reports are advisory and can never authorize changed bytes: re-validate after any write");
  const installedSource = await describeInstalledRepairSource({ stage });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { advisory: true, authorizesBytes: false, sealsNothing: true, effectsApplied: false, resolveInvoked: false, diagnostics, unknowns, warnings, outOfScope, files, installedSource };
}
