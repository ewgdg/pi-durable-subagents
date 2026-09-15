import { CoordinationRecordValidationError } from "./record-validation.ts";
import type { ToolCallPointer } from "./identities.ts";
import type { EntryPointer } from "./moderator-input.ts";

export const MODERATOR_REPORT_CUSTOM_TYPE = "agent-coordination.moderator-report";
export const MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE = "agent-coordination.moderator-report-read";
export const MODERATOR_REPORT_FINDING_CUSTOM_TYPE = "agent-coordination.moderator-report-finding";

export type ReportFindingInput = Readonly<{ key: string; summary: string; evidence: readonly string[] }>;
export type ReportFinding = ReportFindingInput & Readonly<{ reportId: string; createdAt: string }>;

export type ReportToUserInput = Readonly<{
	symptom: string;
	suspectedDefect: string;
	uncertainty: string;
	recoveryActions: string;
	recoveryOutcome: string;
	evidence: readonly string[];
}>;
export type Reporter = Readonly<{ agentId: string; label: string }>;
export type ModeratorReportSource = ToolCallPointer & Readonly<{ transcriptPath: string; kind?: never }>;
export type RuntimeReportSource = EntryPointer & Readonly<{ kind: "runtime_diagnostic"; transcriptPath: string; incidentKey?: string; toolCallId?: never }>;
export type ModeratorReport = ReportToUserInput & Readonly<{
	reportId: string;
	createdAt: string;
	reporter: Reporter;
	source: ModeratorReportSource;
}>;
export type RuntimeReport = ReportToUserInput & Readonly<{
	reportId: string;
	createdAt: string;
	reporter?: never;
	source: RuntimeReportSource;
}>;
export type Report = ModeratorReport | RuntimeReport;
export type ReportHistoryItem = Readonly<{ report: Report; readAt?: string; findings?: readonly ReportFinding[] }>;

export function validateReportFinding(value: unknown): ReportFinding {
	if (typeof value !== "object" || value === null) throw new CoordinationRecordValidationError("Report finding must be an object");
	const finding = value as ReportFinding;
	for (const field of ["reportId", "key", "summary"] as const) {
		if (typeof finding[field] !== "string" || !finding[field].trim()) throw new CoordinationRecordValidationError(`Report finding ${field} must be nonblank text`);
	}
	if (typeof finding.createdAt !== "string" || !Number.isFinite(Date.parse(finding.createdAt))) throw new CoordinationRecordValidationError("Invalid report finding timestamp");
	if (!Array.isArray(finding.evidence) || finding.evidence.length === 0 || finding.evidence.some(reference => typeof reference !== "string" || !reference.trim())) throw new CoordinationRecordValidationError("Report finding evidence must contain at least one nonblank reference");
	return Object.freeze({ reportId: finding.reportId, key: finding.key, summary: finding.summary, createdAt: finding.createdAt, evidence: Object.freeze([...finding.evidence]) });
}

export function validateReportToUserInput(value: unknown): ReportToUserInput {
	if (typeof value !== "object" || value === null) throw new CoordinationRecordValidationError("Report input must be an object");
	const input = value as Record<string, unknown>;
	const text = (field: string): string => {
		const value = input[field];
		if (typeof value !== "string" || !value.trim()) throw new CoordinationRecordValidationError(`Report ${field} must be nonblank text`);
		return value;
	};
	if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.some((item) => typeof item !== "string" || !item.trim())) {
		throw new CoordinationRecordValidationError("Report evidence must contain at least one nonblank reference");
	}
	return Object.freeze({
		symptom: text("symptom"), suspectedDefect: text("suspectedDefect"),
		uncertainty: text("uncertainty"), recoveryActions: text("recoveryActions"),
		recoveryOutcome: text("recoveryOutcome"), evidence: Object.freeze([...input.evidence]),
	});
}

export function formatModeratorReport(report: Report, findings: readonly ReportFinding[] = []): string {
	return [
		`# ${report.reporter ? "Moderator" : "Runtime"} report ${report.reportId}`,
		`Created: ${report.createdAt}`,
		report.reporter ? `Reporter: ${report.reporter.label} (${report.reporter.agentId})` : "Author: Workflow runtime (not an Agent)",
		`Source transcript: ${report.source.transcriptPath}`,
		`${report.reporter ? "Source Agent" : "Diagnostic host Agent"}: ${report.source.agentId}`,
		`Source entry: ${report.source.entryId}`,
		...(report.reporter ? [`Source tool call: ${report.source.toolCallId}`] : ["Source kind: runtime diagnostic entry"]),
		"", "## Symptom", report.symptom,
		"", "## Suspected defect", report.suspectedDefect,
		"", "## Uncertainty", report.uncertainty,
		"", "## Recovery actions", report.recoveryActions,
		"", "## Recovery outcome", report.recoveryOutcome,
		"", "## Evidence", ...report.evidence.map((reference) => `- ${reference}`),
		...findings.flatMap(finding => ["", `## Finding: ${finding.key}`, `Created: ${finding.createdAt}`, finding.summary, ...finding.evidence.map(reference => `- ${reference}`)]),
	].join("\n");
}

export function validateModeratorReport(value: unknown): Report {
	const input = validateReportToUserInput(value);
	const report = value as Report;
	if (report.source?.kind === "runtime_diagnostic") {
		validateRuntimeReportSource(report.source);
		if (report.reporter !== undefined) throw new CoordinationRecordValidationError("Runtime report cannot name an Agent reporter");
	} else {
		validateReportProvenance(report.reporter!, report.source);
	}
	if (typeof report.reportId !== "string" || !report.reportId || typeof report.createdAt !== "string" || !Number.isFinite(Date.parse(report.createdAt)))
		throw new CoordinationRecordValidationError("Invalid Moderator report identity or timestamp");
	// Detach nested values before freezing without mutating transcript evidence.
	return Object.freeze({ ...input, reportId: report.reportId, createdAt: report.createdAt,
		...(report.reporter ? { reporter: Object.freeze({ ...report.reporter }) } : {}), source: Object.freeze({ ...report.source }),
	}) as Report;
}

export function validateRuntimeReportSource(source: RuntimeReportSource): void {
	if (source?.kind !== "runtime_diagnostic" || source.toolCallId !== undefined)
		throw new CoordinationRecordValidationError("Runtime report requires diagnostic-entry provenance, not a tool call");
	if (source.incidentKey !== undefined && (typeof source.incidentKey !== "string" || !source.incidentKey.trim()))
		throw new CoordinationRecordValidationError("Runtime report incident key must be nonblank text");
	for (const value of [source.agentId, source.entryId, source.transcriptPath]) {
		if (typeof value !== "string" || !value.trim()) throw new CoordinationRecordValidationError("Runtime report source must be nonblank");
	}
}

export function validateReportProvenance(reporter: Reporter, source: ModeratorReportSource): void {
	if (source?.kind !== undefined) throw new CoordinationRecordValidationError("Moderator report requires native tool-call provenance");
	for (const [field, value] of Object.entries({
		reporterAgentId: reporter?.agentId, reporterLabel: reporter?.label,
		sourceAgentId: source?.agentId, entryId: source?.entryId,
		toolCallId: source?.toolCallId, transcriptPath: source?.transcriptPath,
	})) {
		if (typeof value !== "string" || !value.trim()) throw new CoordinationRecordValidationError(`Report ${field} must be nonblank text`);
	}
	if (reporter.agentId !== source.agentId) throw new Error("Report reporter must match source Agent");
}

export function validateModeratorReportReadState(value: unknown): Readonly<{reportId: string; readAt: string | null}> {
	const read = value as {reportId?: unknown; readAt?: unknown} | null;
	if (!read || typeof read.reportId !== "string" || !read.reportId ||
		(read.readAt !== null && (typeof read.readAt !== "string" || !Number.isFinite(Date.parse(read.readAt)))))
		throw new CoordinationRecordValidationError("Invalid Moderator report read state");
	return {reportId: read.reportId, readAt: read.readAt};
}
