import { readCoordinationRecord } from "../protocol/replay-rejection.ts";
import { createHash } from "node:crypto";
import type { AgentTranscript } from "../transcript/agent-transcript.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { toolCallPointerKey } from "../protocol/identities.ts";
import {
	MODERATOR_REPORT_CUSTOM_TYPE,
	MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE,
	validateReportToUserInput,
	validateModeratorReport,
	validateModeratorReportReadState,
	validateReportProvenance,
	type ModeratorReport,
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

	publish(input: ReportToUserInput, reporter: Reporter, source: ModeratorReportSource): ModeratorReport {
		const validated = validateReportToUserInput(input);
		validateReportProvenance(reporter, source);
		const reportId = createHash("sha256").update(JSON.stringify([MODERATOR_REPORT_CUSTOM_TYPE, toolCallPointerKey(source)])).digest("base64url");
		const existing = this.history().find((item) => item.report.reportId === reportId);
		// A retried source returns its original publication, never a revised report.
		if (existing) return existing.report;
		const report = validateModeratorReport({ ...validated, reportId, createdAt: new Date().toISOString(), reporter, source });
		this.#append(MODERATOR_REPORT_CUSTOM_TYPE, report);
		return report;
	}

	history(): readonly ReportHistoryItem[] {
		const transcript = this.#transcript.inspect();
		const reports = new Map<string, ModeratorReport>();
		const reads = new Map<string, string>();
		for (const entry of coordinationEntries(transcript, transcript.sessionId, "coordination")) {
			if (entry.type !== "custom") continue;
			if (entry.customType === MODERATOR_REPORT_CUSTOM_TYPE) {
				const parsed = readCoordinationRecord(transcript, transcript.sessionId, entry, () => validateModeratorReport(entry.data));
				if (!parsed.accepted) continue;
				const report = parsed.value;
				if (reports.has(report.reportId)) throw new Error(`Duplicate Moderator report ${report.reportId}`);
				reports.set(report.reportId, report);
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
		return Object.freeze([...reports.values()].map((report) => Object.freeze({ report, ...(reads.has(report.reportId) ? { readAt: reads.get(report.reportId)! } : {}) })));
	}

	get(reportId: string): ModeratorReport {
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
