import type { HumanAttentionItem } from "../coordination/human-requests.ts";
import type { OperationalIncidentAttention } from "../coordination/operational-incidents.ts";
import type { ReportHistoryItem } from "../protocol/moderator-report.ts";

/** What choosing an inbox item does. Selecting an Agent is also the selector's roster action. */
export type AttentionInboxAction =
	| Readonly<{ kind: "decide"; requestId: string; agentId: string }>
	| Readonly<{ kind: "select_agent"; agentId: string }>
	| Readonly<{ kind: "open_report"; reportId: string }>;

export type AttentionInboxItem =
	| Readonly<{
		kind: "human_request";
		attention: HumanAttentionItem;
		action: Extract<AttentionInboxAction, { kind: "decide" }>;
	}>
	| Readonly<{
		kind: "operational_incident";
		attention: OperationalIncidentAttention;
		/** Only an incident with exactly one affected Agent has an unambiguous target. */
		action: Extract<AttentionInboxAction, { kind: "select_agent" }> | undefined;
	}>
	| Readonly<{
		kind: "report";
		item: ReportHistoryItem;
		action: Extract<AttentionInboxAction, { kind: "open_report" }>;
	}>;

/** A continuing condition shown beside the inbox, so reading its Report never hides it. */
export type AttentionLiveStatus = "moderation_unavailable" | "unresolved_incident" | "none";

export type AttentionInboxSources = Readonly<{
	humanAttention: readonly HumanAttentionItem[];
	operationalAttention: readonly OperationalIncidentAttention[];
	reports: readonly ReportHistoryItem[];
}>;

export type AttentionInbox = Readonly<{
	items: readonly AttentionInboxItem[];
	liveStatus: AttentionLiveStatus;
}>;

/** The Workflow Owner's Attention Inbox: Human Requests, then incidents, then unread Reports. */
export function attentionInbox(sources: AttentionInboxSources): AttentionInbox {
	return {
		items: [
			...sources.humanAttention.map((attention): AttentionInboxItem => ({
				kind: "human_request",
				attention,
				action: { kind: "decide", requestId: attention.requestId, agentId: attention.agentId },
			})),
			...sources.operationalAttention
				.filter((attention) => isInboxIncident(attention, sources.reports))
				.map((attention): AttentionInboxItem => ({
					kind: "operational_incident",
					attention,
					action: attention.affectedAgents.length === 1
						? { kind: "select_agent", agentId: attention.affectedAgents[0]!.agentId }
						: undefined,
				})),
			...sources.reports
				.filter(({ readAt }) => readAt === undefined)
				.map((item): AttentionInboxItem => ({
					kind: "report",
					item,
					action: { kind: "open_report", reportId: item.report.reportId },
				})),
		],
		liveStatus: attentionLiveStatus(sources.operationalAttention),
	};
}

function isInboxIncident(
	attention: OperationalIncidentAttention,
	reports: readonly ReportHistoryItem[],
): boolean {
	// Moderation Unavailable is a live status, never an inbox item.
	if (attention.trigger.kind === "moderation_unavailable") return false;
	const reportSource = attention.reportSource;
	// The runtime Report row stands for its incident; reading it must not
	// resurrect the same incident as a second inbox row.
	return !reportSource || !reports.some(({ report }) =>
		report.source.kind === "runtime_diagnostic" &&
		report.source.agentId === reportSource.agentId &&
		report.source.entryId === reportSource.entryId
	);
}

function attentionLiveStatus(
	operationalAttention: readonly OperationalIncidentAttention[],
): AttentionLiveStatus {
	if (operationalAttention.some(({ trigger }) => trigger.kind === "moderation_unavailable")) {
		return "moderation_unavailable";
	}
	return operationalAttention.some(({ reportSource }) => reportSource !== undefined)
		? "unresolved_incident"
		: "none";
}
