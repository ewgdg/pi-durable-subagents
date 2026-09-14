import { CoordinationRecordValidationError } from "./record-validation.ts";
import type { ToolCallPointer } from "./identities.ts";

export const MODERATOR_REPORT_CUSTOM_TYPE = "agent-coordination.moderator-report";
export const MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE = "agent-coordination.moderator-report-read";

export type ReportToUserInput = Readonly<{
	symptom: string;
	suspectedDefect: string;
	uncertainty: string;
	recoveryActions: string;
	recoveryOutcome: string;
	evidence: readonly string[];
}>;
export type Reporter = Readonly<{ agentId: string; label: string }>;
export type ModeratorReportSource = ToolCallPointer & Readonly<{ transcriptPath: string }>;
export type ModeratorReport = ReportToUserInput & Readonly<{
	reportId: string;
	createdAt: string;
	reporter: Reporter;
	source: ModeratorReportSource;
}>;
export type ReportHistoryItem = Readonly<{ report: ModeratorReport; readAt?: string }>;

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

export function formatModeratorReport(report: ModeratorReport): string {
	return [
		`# Moderator report ${report.reportId}`,
		`Created: ${report.createdAt}`,
		`Reporter: ${report.reporter.label} (${report.reporter.agentId})`,
		`Source transcript: ${report.source.transcriptPath}`,
		`Source Agent: ${report.source.agentId}`,
		`Source entry: ${report.source.entryId}`,
		`Source tool call: ${report.source.toolCallId}`,
		"", "## Symptom", report.symptom,
		"", "## Suspected defect", report.suspectedDefect,
		"", "## Uncertainty", report.uncertainty,
		"", "## Recovery actions", report.recoveryActions,
		"", "## Recovery outcome", report.recoveryOutcome,
		"", "## Evidence", ...report.evidence.map((reference) => `- ${reference}`),
	].join("\n");
}

export function validateModeratorReport(value: unknown): ModeratorReport {
	const input = validateReportToUserInput(value);
	const report = value as ModeratorReport;
	validateReportProvenance(report.reporter, report.source);
	if (typeof report.reportId !== "string" || !report.reportId || typeof report.createdAt !== "string" || !Number.isFinite(Date.parse(report.createdAt)))
		throw new CoordinationRecordValidationError("Invalid Moderator report identity or timestamp");
	// Detach nested values before freezing without mutating transcript evidence.
	return Object.freeze({ ...input, reportId: report.reportId, createdAt: report.createdAt,
		reporter: Object.freeze({ ...report.reporter }), source: Object.freeze({ ...report.source }),
	});
}

export function validateReportProvenance(reporter: Reporter, source: ModeratorReportSource): void {
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
