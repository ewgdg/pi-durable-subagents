import assert from "node:assert/strict";
import test from "node:test";

import type { HumanAttentionItem } from "../src/coordination/human-requests.ts";
import type { OperationalIncidentAttention } from "../src/coordination/operational-incidents.ts";
import type { ReportHistoryItem } from "../src/protocol/moderator-report.ts";
import {
	attentionInbox,
	type AttentionInboxItem,
	type AttentionInboxSources,
} from "../src/presentation/attention-inbox.ts";

function human(requestId: string, agentId = "asker"): HumanAttentionItem {
	return { requestId, agentId, agentLabel: agentId, question: "Proceed?" };
}

function runFailure(
	agentIds: readonly string[],
	reportSource?: { agentId: string; entryId: string },
): OperationalIncidentAttention {
	return {
		trigger: { kind: "run_failure", agentId: agentIds[0]!, runSequence: 1, obligations: { total: 0, sources: [] } },
		affectedAgents: agentIds.map((agentId) => ({ agentId, label: agentId })),
		diagnostics: [],
		...(reportSource ? { reportSource } : {}),
	};
}

function moderationUnavailable(reportSource?: { agentId: string; entryId: string }): OperationalIncidentAttention {
	return {
		trigger: { kind: "moderation_unavailable" }, affectedAgents: [], diagnostics: [],
		...(reportSource ? { reportSource } : {}),
	};
}

const reportFields = {
	createdAt: "2026-01-01T00:00:00Z", symptom: "Stalled", suspectedDefect: "Unknown",
	uncertainty: "Unknown", recoveryActions: "None", recoveryOutcome: "Unknown", evidence: [],
};

function runtimeReport(reportId: string, entryId: string, readAt?: string): ReportHistoryItem {
	return {
		report: {
			...reportFields, reportId,
			source: { kind: "runtime_diagnostic", agentId: "owner", entryId, transcriptPath: "/tmp/owner.jsonl" },
		},
		...(readAt ? { readAt } : {}),
	};
}

function moderatorReport(reportId: string, entryId: string, readAt?: string): ReportHistoryItem {
	return {
		report: {
			...reportFields, reportId,
			reporter: { agentId: "owner", label: "Moderator" },
			source: { agentId: "owner", entryId, toolCallId: "call", transcriptPath: "/tmp/moderator.jsonl" },
		},
		...(readAt ? { readAt } : {}),
	};
}

/** One readable word per item: its kind and what Enter does. */
function describe(item: AttentionInboxItem): string {
	const action = item.action === undefined
		? "none"
		: item.action.kind === "decide"
			? `decide ${item.action.requestId}`
			: item.action.kind === "select_agent"
				? `select ${item.action.agentId}`
				: `open ${item.action.reportId}`;
	return `${item.kind}: ${action}`;
}

function inbox(sources: Partial<AttentionInboxSources>) {
	const result = attentionInbox({ humanAttention: [], operationalAttention: [], reports: [], ...sources });
	return { items: result.items.map(describe), liveStatus: result.liveStatus };
}

test("the inbox lists Human Requests, then incidents, then unread Reports, each with its action", () => {
	const rows: [string, Partial<AttentionInboxSources>, string[]][] = [
		["empty", {}, []],
		["each kind in a fixed order", {
			reports: [runtimeReport("report", "elsewhere")],
			operationalAttention: [runFailure(["worker"])],
			humanAttention: [human("first"), human("second")],
		}, [
			"human_request: decide first",
			"human_request: decide second",
			"operational_incident: select worker",
			"report: open report",
		]],
		["an incident over several Agents has no action", {
			operationalAttention: [runFailure(["first", "second"])],
		}, ["operational_incident: none"]],
		["read Reports leave the inbox", {
			reports: [moderatorReport("read", "entry", "2026-01-02T00:00:00Z"), moderatorReport("unread", "entry")],
		}, ["report: open unread"]],
		["Moderation Unavailable is never an item", {
			operationalAttention: [moderationUnavailable()],
		}, []],
		["a runtime Report covers its incident, read or unread", {
			operationalAttention: [runFailure(["a"], { agentId: "owner", entryId: "unread" }), runFailure(["b"], { agentId: "owner", entryId: "read" })],
			reports: [runtimeReport("unread-report", "unread"), runtimeReport("read-report", "read", "2026-01-02T00:00:00Z")],
		}, ["report: open unread-report"]],
		["a Report on another entry covers nothing", {
			operationalAttention: [runFailure(["a"], { agentId: "owner", entryId: "incident" })],
			reports: [runtimeReport("report", "other", "2026-01-02T00:00:00Z")],
		}, ["operational_incident: select a"]],
		["a Report from another Agent covers nothing", {
			operationalAttention: [runFailure(["a"], { agentId: "other", entryId: "incident" })],
			reports: [runtimeReport("report", "incident", "2026-01-02T00:00:00Z")],
		}, ["operational_incident: select a"]],
		["a Moderator Report never covers an incident", {
			operationalAttention: [runFailure(["a"], { agentId: "owner", entryId: "incident" })],
			reports: [moderatorReport("report", "incident", "2026-01-02T00:00:00Z")],
		}, ["operational_incident: select a"]],
	];
	for (const [scenario, sources, items] of rows) {
		assert.deepEqual(inbox(sources).items, items, scenario);
	}
});

test("the live status names a continuing condition whether or not its Report is read", () => {
	const rows: [string, Partial<AttentionInboxSources>, string][] = [
		["nothing continuing", { operationalAttention: [runFailure(["a"])] }, "none"],
		["an incident with a report source", {
			operationalAttention: [runFailure(["a"], { agentId: "owner", entryId: "incident" })],
			reports: [runtimeReport("report", "incident", "2026-01-02T00:00:00Z")],
		}, "unresolved_incident"],
		["Moderation Unavailable after its Report is read", {
			operationalAttention: [moderationUnavailable({ agentId: "owner", entryId: "diagnostic" })],
			reports: [runtimeReport("report", "diagnostic", "2026-01-02T00:00:00Z")],
		}, "moderation_unavailable"],
		["Moderation Unavailable outranks an unresolved incident", {
			operationalAttention: [runFailure(["a"], { agentId: "owner", entryId: "incident" }), moderationUnavailable()],
		}, "moderation_unavailable"],
	];
	for (const [scenario, sources, liveStatus] of rows) {
		assert.equal(inbox(sources).liveStatus, liveStatus, scenario);
	}
});
