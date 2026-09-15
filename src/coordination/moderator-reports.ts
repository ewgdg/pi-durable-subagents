import { readCoordinationRecord } from "../protocol/replay-rejection.ts";
import { createHash } from "node:crypto";
import type { AgentTranscript } from "../transcript/agent-transcript.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { toolCallPointerKey } from "../protocol/identities.ts";
import type { EntryPointer } from "../protocol/moderator-input.ts";
import {
	MODERATOR_REPORT_CUSTOM_TYPE,
	MODERATOR_REPORT_FINDING_CUSTOM_TYPE,
	validateReportFinding,
	type ReportFinding,
	type ReportFindingInput,
	MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE,
	validateReportToUserInput,
	validateModeratorReport,
	validateModeratorReportReadState,
	validateReportProvenance,
	type Report,
	type RuntimeReportSource,
	validateRuntimeReportSource,
	type ModeratorReportSource,
	type Reporter,
	type ReportHistoryItem,
	type ReportToUserInput,
} from "../protocol/moderator-report.ts";

export class ModeratorReportStore {
	readonly #transcript: AgentTranscript;
	readonly #append: (customType: string, data: unknown) => string;

	constructor(options: {
		transcript: AgentTranscript;
		appendCustomEntry(customType: string, data: unknown): string;
	}) {
		this.#transcript = options.transcript;
		this.#append = options.appendCustomEntry;
	}

	publish(input: ReportToUserInput, reporter: Reporter, source: ModeratorReportSource): Report {
		const validated = validateReportToUserInput(input);
		validateReportProvenance(reporter, source);
		return this.#publish(validated, source, toolCallPointerKey(source), reporter);
	}

	publishRuntime(input: ReportToUserInput, source: RuntimeReportSource): Report {
		const validated = validateReportToUserInput(input);
		validateRuntimeReportSource(source);
		return this.#publish(validated, source, JSON.stringify([source.kind, source.agentId, source.entryId]));
	}

	runtimeSourceForIncident(incidentKey: string): EntryPointer | undefined {
		const item = this.history().find(({ report }) => report.source.kind === "runtime_diagnostic" && report.source.incidentKey === incidentKey);
		return item ? Object.freeze({ agentId: item.report.source.agentId, entryId: item.report.source.entryId }) : undefined;
	}

	appendRuntimeFinding(source: EntryPointer, finding: ReportFindingInput): void {
		const item = this.history().find(({ report }) => report.source.kind === "runtime_diagnostic" && report.source.agentId === source.agentId && report.source.entryId === source.entryId);
		if (!item) throw new Error(`Unknown runtime report for ${source.agentId}/${source.entryId}`);
		const validated = validateReportFinding({ ...finding, reportId: item.report.reportId, createdAt: new Date().toISOString() });
		// Retries retain the first observation, including its original timestamp and evidence.
		if (item.findings?.some(existing => existing.key === validated.key)) return;
		this.#append(MODERATOR_REPORT_FINDING_CUSTOM_TYPE, validated);
	}

	#publish(validated: ReportToUserInput, source: ModeratorReportSource | RuntimeReportSource, sourceKey: string, reporter?: Reporter): Report {
		const reportId = createHash("sha256").update(JSON.stringify([MODERATOR_REPORT_CUSTOM_TYPE, sourceKey])).digest("base64url");
		const existing = this.history().find((item) => item.report.reportId === reportId);
		// A retried source returns its original publication, never a revised report.
		if (existing) return existing.report;
		const report = validateModeratorReport({ ...validated, reportId, createdAt: new Date().toISOString(), ...(reporter ? { reporter } : {}), source });
		this.#append(MODERATOR_REPORT_CUSTOM_TYPE, report);
		return report;
	}

	history(): readonly ReportHistoryItem[] {
		const transcript = this.#transcript.inspect();
		const reports = new Map<string, Report>();
		const reads = new Map<string, string>();
		const findings = new Map<string, ReportFinding[]>();
		for (const entry of coordinationEntries(transcript, transcript.sessionId, "coordination")) {
			if (entry.type !== "custom") continue;
			if (entry.customType === MODERATOR_REPORT_CUSTOM_TYPE) {
				const parsed = readCoordinationRecord(transcript, transcript.sessionId, entry, () => validateModeratorReport(entry.data));
				if (!parsed.accepted) continue;
				const report = parsed.value;
				if (reports.has(report.reportId)) throw new Error(`Duplicate Moderator report ${report.reportId}`);
				reports.set(report.reportId, report);
			} else if (entry.customType === MODERATOR_REPORT_FINDING_CUSTOM_TYPE) {
				const parsed = readCoordinationRecord(transcript, transcript.sessionId, entry, () => validateReportFinding(entry.data));
				if (!parsed.accepted) continue;
				const finding = parsed.value;
				if (!reports.has(finding.reportId)) throw new Error("Invalid report finding target");
				const retained = findings.get(finding.reportId) ?? [];
				if (retained.some(existing => existing.key === finding.key)) throw new Error(`Duplicate report finding ${finding.key}`);
				retained.push(finding);
				findings.set(finding.reportId, retained);
				// A finding atomically restores attention; a later explicit read
				// acknowledges all findings retained before that read entry.
				reads.delete(finding.reportId);
			} else if (entry.customType === MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE) {
				const parsed = readCoordinationRecord(transcript, transcript.sessionId, entry, () => validateModeratorReportReadState(entry.data));
				if (!parsed.accepted) continue;
				const read = parsed.value;
				if (!reports.has(read.reportId)) throw new Error("Invalid Moderator report read state");
				// A null timestamp restores attention; transcript order determines current state.
				if (read.readAt === null) reads.delete(read.reportId);
				else reads.set(read.reportId, read.readAt);
			}
		}
		return Object.freeze([...reports.values()].map((report) => Object.freeze({ report,
			...(reads.has(report.reportId) ? { readAt: reads.get(report.reportId)! } : {}),
			...(findings.has(report.reportId) ? { findings: Object.freeze(findings.get(report.reportId)!) } : {}),
		})));
	}

	get(reportId: string): Report {
		const item = this.history().find((item) => item.report.reportId === reportId);
		if (!item) throw new Error(`Unknown Moderator report ${reportId}`);
		return item.report;
	}

	setRead(reportId: string, read: boolean): void {
		const item = this.history().find((item) => item.report.reportId === reportId);
		if (!item) throw new Error(`Unknown Moderator report ${reportId}`);
		if ((item.readAt !== undefined) === read) return;
		this.#append(MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE, Object.freeze({ reportId, readAt: read ? new Date().toISOString() : null }));
	}
}
