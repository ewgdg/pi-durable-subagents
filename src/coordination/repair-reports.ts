import { appendFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { toolCallPointerKey } from "../protocol/identities.ts";
import {
  MODERATOR_REPORT_CUSTOM_TYPE,
  validateModeratorReport,
  validateReportProvenance,
  validateReportToUserInput,
  type ModeratorReportSource,
  type Report,
  type ReportHistoryItem,
  type Reporter,
  type ReportToUserInput,
} from "../protocol/moderator-report.ts";
export const REPAIR_REPORTS_FILENAME = "repair-reports.jsonl";
export function repairReportsPath(journalDir: string): string {
  if (!isAbsolute(journalDir) || journalDir.includes("\0")) {
    throw new Error("invalid_input: repair report journal dir must be an absolute path");
  }
  return join(journalDir, REPAIR_REPORTS_FILENAME);
}
function reportIdFor(source: ModeratorReportSource): string {
  return createHash("sha256").update(JSON.stringify([MODERATOR_REPORT_CUSTOM_TYPE, toolCallPointerKey(source)])).digest("base64url");
}
export async function publishRepairReport(options: Readonly<{ journalDir: string; input: ReportToUserInput; reporter: Reporter; source: ModeratorReportSource }>): Promise<Report> {
  const validated = validateReportToUserInput(options.input);
  validateReportProvenance(options.reporter, options.source);
  if (!isAbsolute(options.journalDir) || options.journalDir.includes("\0")) {
    throw new Error("invalid_input: repair report journal dir must be an absolute path");
  }
  await mkdir(options.journalDir, { recursive: true });
  const path = repairReportsPath(options.journalDir);
  const wantedId = reportIdFor(options.source);
  const existing = (await listRepairReports(options.journalDir)).find((item) => item.report.reportId === wantedId);
  if (existing) return existing.report;
  const report = validateModeratorReport({ ...validated, reportId: wantedId, createdAt: new Date().toISOString(), reporter: options.reporter, source: options.source });
  await appendFile(path, JSON.stringify(report) + "\n", { encoding: "utf8", mode: 0o600 });
  return report;
}
export async function listRepairReports(journalDir: string): Promise<readonly ReportHistoryItem[]> {
  if (!isAbsolute(journalDir) || journalDir.includes("\0")) {
    throw new Error("invalid_input: repair report journal dir must be an absolute path");
  }
  let raw: string;
  try {
    raw = await readFile(repairReportsPath(journalDir), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  const items: ReportHistoryItem[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const report = validateModeratorReport(JSON.parse(line) as unknown);
    if (seen.has(report.reportId)) throw new Error("Duplicate repair report " + report.reportId);
    seen.add(report.reportId);
    items.push(Object.freeze({ report }));
  }
  return Object.freeze(items);
}

/** Sync history for coordinator views: frozen Owner file is never touched. */
export function listRepairReportsSync(journalDir: string): readonly ReportHistoryItem[] {
  if (!isAbsolute(journalDir) || journalDir.includes("\0")) {
    throw new Error("invalid_input: repair report journal dir must be an absolute path");
  }
  let raw: string;
  try {
    raw = readFileSync(repairReportsPath(journalDir), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  const items: ReportHistoryItem[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const report = validateModeratorReport(JSON.parse(line) as unknown);
    if (seen.has(report.reportId)) throw new Error("Duplicate repair report " + report.reportId);
    seen.add(report.reportId);
    items.push(Object.freeze({ report }));
  }
  return Object.freeze(items);
}
