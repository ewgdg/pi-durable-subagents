import type { HumanAttentionItem } from "../coordination/human-requests.ts";
import type { OperationalIncidentAttention } from "../coordination/operational-incidents.ts";
import type { AgentRosterStatus } from "../coordination/workflow-coordinator.ts";
import type { ReportHistoryItem } from "../protocol/moderator-report.ts";
import {
	attentionInbox,
	type AttentionInboxAction,
	type AttentionLiveStatus,
} from "./attention-inbox.ts";

/** Every selector action is an inbox action; selecting an Agent is one of them. */
export type AgentSelectorAction = AttentionInboxAction;

export type AgentSelectorTab = "live" | "dormant" | "reports" | "quarantined";

/** The existing selector snapshot, as published by the Owner and over Control. */
export type AgentSelectorSnapshot = Readonly<{
	live: readonly AgentRosterStatus[];
	dormant: readonly AgentRosterStatus[];
	quarantined?: readonly string[];
	quarantinedCandidateCount?: number;
	/** The mounted Agent. */
	selectedAgentId: string;
	humanAttention?: readonly HumanAttentionItem[];
	operationalAttention?: readonly OperationalIncidentAttention[];
	reports?: readonly ReportHistoryItem[];
}>;

/** A live refresh; fields it omits keep their previous values. */
export type AgentSelectorRosterUpdate = Omit<AgentSelectorSnapshot, "selectedAgentId">;

export type AgentSelectorIntent =
	| Readonly<{ kind: "roster_changed"; update: AgentSelectorRosterUpdate }>
	| Readonly<{ kind: "report_read_changed"; reportId: string; reports: readonly ReportHistoryItem[] }>
	| Readonly<{ kind: "next_tab" }>
	| Readonly<{ kind: "previous_tab" }>
	| Readonly<{ kind: "choose_tab"; tab: AgentSelectorTab }>
	| Readonly<{ kind: "focus_next" }>
	| Readonly<{ kind: "focus_previous" }>
	| Readonly<{ kind: "focus_row"; key: string }>
	| Readonly<{ kind: "open_children" }>
	| Readonly<{ kind: "go_to_parent" }>
	| Readonly<{ kind: "go_to_root" }>
	| Readonly<{ kind: "go_to_ancestor"; agentId: string; childId: string }>;

export type AgentSelectorRow =
	| Readonly<{
		kind: "decide";
		key: string;
		number: number;
		attention: HumanAttentionItem;
		action: Extract<AgentSelectorAction, { kind: "decide" }>;
	}>
	| Readonly<{
		kind: "incident";
		key: string;
		number: number;
		attention: OperationalIncidentAttention;
		action: Extract<AgentSelectorAction, { kind: "select_agent" }> | undefined;
	}>
	| Readonly<{
		kind: "report";
		key: string;
		item: ReportHistoryItem;
		action: Extract<AgentSelectorAction, { kind: "open_report" }>;
	}>
	| Readonly<{
		kind: "agent";
		key: string;
		status: AgentRosterStatus;
		/** Live children this row can open; only Live browses children. */
		childCount: number;
		moderator: boolean;
		mounted: boolean;
		action: Extract<AgentSelectorAction, { kind: "select_agent" }>;
	}>
	| Readonly<{ kind: "quarantined"; key: string; agentId: string; action: undefined }>
	| Readonly<{ kind: "unreadable_candidates"; key: string; count: number; action: undefined }>
	| Readonly<{
		kind: "owner";
		key: string;
		agentId: string;
		mounted: boolean;
		action: Extract<AgentSelectorAction, { kind: "select_agent" }>;
	}>;

export type AgentSelectorEmptyState =
	| "no_live_agents"
	| "no_dormant_agents"
	| "no_reports"
	| "no_quarantined_agents";

export type AgentSelectorView = Readonly<{
	/** Tabs worth cycling through; Reports and Quarantined hide while empty. */
	tabs: readonly AgentSelectorTab[];
	activeTab: AgentSelectorTab;
	liveStatus: AttentionLiveStatus;
	/** Live scope ancestry below the Owner, ending at the current scope. */
	scopePath: readonly AgentRosterStatus[];
	/** One non-wrapping focus order that always ends at the Owner destination. */
	rows: readonly AgentSelectorRow[];
	focusedIndex: number;
	emptyState: AgentSelectorEmptyState | undefined;
}>;

/** A focused Agent row kept in place after a refresh moved it elsewhere. */
type RetainedRow = Readonly<{ agentId: string; index: number }>;

export type AgentSelectorState = Readonly<{
	snapshot: AgentSelectorSnapshot;
	roster: SelectorRoster;
	activeTab: AgentSelectorTab;
	scopeAgentId: string;
	/** Focus memory per tab, by row key. The active tab's entry is always resolved. */
	focus: Readonly<Partial<Record<AgentSelectorTab, string>>>;
	retained: RetainedRow | undefined;
}>;

type SelectorRoster = Readonly<{
	owner: AgentRosterStatus;
	byId: ReadonlyMap<string, AgentRosterStatus>;
	/** Every live Agent plus its ancestors as browsing paths. */
	liveTree: readonly AgentRosterStatus[];
	/** Dormant Agents outside the live tree, without the Owner. */
	dormant: readonly AgentRosterStatus[];
}>;

type AgentRoster = Readonly<{
	live: readonly AgentRosterStatus[];
	dormant: readonly AgentRosterStatus[];
}>;

/**
 * The canonical Owner lookup: the roster Agent whose Agent ID equals its
 * Workflow ID. The Owner exists whatever its Run phase: a stopped Owner Run is
 * Dormant, not absent.
 */
export function findWorkflowOwner(roster: AgentRoster): AgentRosterStatus | undefined {
	return [...roster.live, ...roster.dormant].find(
		(status) => status.agentId === status.workflowId,
	);
}

/** The canonical Owner lookup for callers that cannot proceed without an Owner. */
export function requireWorkflowOwner(roster: AgentRoster): AgentRosterStatus {
	const owner = findWorkflowOwner(roster);
	if (!owner) throw new Error("Agent selector roster has no Owner");
	return owner;
}

/** Open on the mounted Agent's tab and scope, focusing the first attention item if any. */
export function openAgentSelector(snapshot: AgentSelectorSnapshot): AgentSelectorState {
	const roster = selectorRoster(snapshot);
	const { owner } = roster;
	const mountedLive = roster.liveTree.find(({ agentId }) => agentId === snapshot.selectedAgentId);
	const mountedDormant = roster.dormant.find(({ agentId }) => agentId === snapshot.selectedAgentId);
	const state: AgentSelectorState = {
		snapshot,
		roster,
		activeTab: mountedDormant ? "dormant" : "live",
		scopeAgentId: mountedLive === undefined || mountedLive.agentId === owner.agentId
			? owner.agentId
			: mountedLive.directSpawnerAgentId ?? owner.agentId,
		focus: {
			live: inboxRows(snapshot)[0]?.key ?? (
				mountedLive?.agentId === owner.agentId ? undefined : mountedLive?.agentId
			),
			dormant: mountedDormant?.agentId ?? roster.dormant[0]?.agentId,
		},
		retained: undefined,
	};
	return resolveFocus(state);
}

export function applyAgentSelectorIntent(
	state: AgentSelectorState,
	intent: AgentSelectorIntent,
): AgentSelectorState {
	switch (intent.kind) {
		case "roster_changed": {
			const rows = activeRows(state);
			const focusedIndex = rows.findIndex(({ key }) => key === state.focus[state.activeTab]);
			const focused = rows[focusedIndex];
			const snapshot = { ...state.snapshot, ...intent.update };
			// A refresh must not turn an imminent Enter into another Agent's action:
			// the focused Agent keeps its row, with current status, until focus leaves.
			return resolveFocus({
				...state,
				snapshot,
				roster: selectorRoster(snapshot),
				retained: focused?.kind === "agent" ? { agentId: focused.key, index: focusedIndex } : undefined,
			});
		}
		case "report_read_changed": {
			const rows = activeRows(state);
			const index = rows.findIndex(({ key }) => key === `report:${intent.reportId}`);
			// Reading removes the Inbox row, so triage continues at its next
			// neighbour; Report history keeps the same entry focused.
			const focusKey = index < 0
				? state.focus[state.activeTab]
				: rows[state.activeTab === "live" ? index + 1 : index]?.key;
			return resolveFocus({
				...state,
				snapshot: { ...state.snapshot, reports: intent.reports },
				focus: { ...state.focus, [state.activeTab]: focusKey },
			});
		}
		case "next_tab":
			return showTab(state, adjacentTab(state, 1));
		case "previous_tab":
			return showTab(state, adjacentTab(state, -1));
		case "choose_tab":
			return showTab(state, intent.tab);
		case "focus_next":
		case "focus_previous": {
			const rows = activeRows(state);
			const index = rows.findIndex(({ key }) => key === state.focus[state.activeTab]);
			// One linear order: the ends stay put instead of wrapping.
			const destination = rows[index + (intent.kind === "focus_next" ? 1 : -1)];
			return destination ? focusRow(state, destination.key) : state;
		}
		case "focus_row":
			return activeRows(state).some(({ key }) => key === intent.key)
				? focusRow(state, intent.key)
				: state;
		case "open_children": {
			if (state.activeTab !== "live") return state;
			const focused = activeRows(state).find(({ key }) => key === state.focus.live);
			if (focused?.kind !== "agent") return state;
			const firstChild = liveChildren(state.roster, focused.status.agentId)[0];
			return firstChild
				? browse(state, focused.status.agentId, firstChild.agentId)
				: state;
		}
		case "go_to_parent": {
			const { owner, byId } = state.roster;
			if (state.activeTab !== "live" || state.scopeAgentId === owner.agentId) return state;
			const parentId = byId.get(state.scopeAgentId)?.directSpawnerAgentId ?? owner.agentId;
			return browse(state, parentId, state.scopeAgentId);
		}
		case "go_to_root":
			return state.activeTab === "live" ? browseRoot(state) : state;
		case "go_to_ancestor":
			return state.activeTab === "live" ? browse(state, intent.agentId, intent.childId) : state;
	}
}

function browse(state: AgentSelectorState, scopeAgentId: string, focusKey: string | undefined): AgentSelectorState {
	return resolveFocus({
		...state,
		scopeAgentId,
		focus: { ...state.focus, live: focusKey },
		retained: undefined,
	});
}

/** Return to the root, focusing the top-level ancestor of the scope being left. */
function browseRoot(state: AgentSelectorState): AgentSelectorState {
	const { owner, byId } = state.roster;
	if (state.scopeAgentId === owner.agentId) return state;
	let ancestor = byId.get(state.scopeAgentId);
	while (ancestor?.directSpawnerAgentId && ancestor.directSpawnerAgentId !== owner.agentId) {
		ancestor = byId.get(ancestor.directSpawnerAgentId);
	}
	const rootAgents = liveChildren(state.roster, owner.agentId);
	// Root browsing targets an Agent, not the higher-priority Attention Inbox.
	const focusKey = rootAgents.find(({ agentId }) => agentId === ancestor?.agentId)?.agentId
		?? rootAgents[0]?.agentId ?? owner.agentId;
	return browse(state, owner.agentId, focusKey);
}

/** Changing tab or scope releases any retained row and resolves fresh focus. */
function showTab(state: AgentSelectorState, tab: AgentSelectorTab): AgentSelectorState {
	return resolveFocus({ ...state, activeTab: tab, retained: undefined });
}

function adjacentTab(state: AgentSelectorState, direction: 1 | -1): AgentSelectorTab {
	const tabs = visibleTabs(state.snapshot);
	return tabs[(tabs.indexOf(state.activeTab) + direction + tabs.length) % tabs.length] ?? "live";
}

/**
 * The destination is chosen among the displayed rows before a retained row
 * leaves, so its removal never skips a neighbour.
 */
function focusRow(state: AgentSelectorState, key: string): AgentSelectorState {
	return resolveFocus({ ...state, focus: { ...state.focus, [state.activeTab]: key } });
}

export function agentSelectorView(state: AgentSelectorState): AgentSelectorView {
	const rows = activeRows(state);
	const focusedIndex = rows.findIndex(({ key }) => key === state.focus[state.activeTab]);
	return {
		tabs: visibleTabs(state.snapshot),
		activeTab: state.activeTab,
		liveStatus: inbox(state.snapshot).liveStatus,
		scopePath: scopePath(state),
		rows,
		focusedIndex,
		emptyState: emptyState(state.activeTab, rows),
	};
}

function selectorRoster(snapshot: AgentSelectorSnapshot): SelectorRoster {
	const owner = requireWorkflowOwner(snapshot);
	const allStatuses = [...snapshot.live, ...snapshot.dormant];
	const byId = new Map(allStatuses.map((status) => [status.agentId, status]));
	const liveTreeIds = new Set<string>();
	// Keep every ancestor as a browsing path; its Run status remains unchanged.
	for (const status of snapshot.live) {
		let current: AgentRosterStatus | undefined = status;
		while (current && !liveTreeIds.has(current.agentId)) {
			liveTreeIds.add(current.agentId);
			current = current.directSpawnerAgentId === null
				? undefined : byId.get(current.directSpawnerAgentId);
		}
	}
	return {
		owner,
		byId,
		liveTree: allStatuses.filter(({ agentId }) => liveTreeIds.has(agentId)),
		// The Owner is a global destination, never a roster row: a Dormant Owner
		// belongs to that destination, not to the Dormant list.
		dormant: snapshot.dormant.filter(({ agentId }) =>
			agentId !== owner.agentId && !liveTreeIds.has(agentId)),
	};
}

function liveChildren(roster: SelectorRoster, agentId: string): AgentRosterStatus[] {
	const ownerId = roster.owner.agentId;
	// Root browsing also includes live Moderators without a Direct Spawner.
	return roster.liveTree.filter((status) =>
		status.agentId !== ownerId &&
		(status.directSpawnerAgentId === agentId ||
			(agentId === ownerId && status.directSpawnerAgentId === null))
	);
}

function inbox(snapshot: AgentSelectorSnapshot) {
	return attentionInbox({
		humanAttention: snapshot.humanAttention ?? [],
		operationalAttention: snapshot.operationalAttention ?? [],
		reports: snapshot.reports ?? [],
	});
}

function inboxRows(snapshot: AgentSelectorSnapshot): AgentSelectorRow[] {
	const counts = { human_request: 0, operational_incident: 0 };
	return inbox(snapshot).items.map((item): AgentSelectorRow => {
		switch (item.kind) {
			case "human_request":
				return {
					kind: "decide",
					key: `human:${item.attention.requestId}`,
					number: ++counts.human_request,
					attention: item.attention,
					action: item.action,
				};
			case "operational_incident": {
				const number = ++counts.operational_incident;
				return {
					kind: "incident",
					key: `operational:${number - 1}`,
					number,
					attention: item.attention,
					action: item.action,
				};
			}
			case "report":
				return reportRow(item.item);
		}
	});
}

function reportRow(item: ReportHistoryItem): AgentSelectorRow {
	return {
		kind: "report",
		key: `report:${item.report.reportId}`,
		item,
		action: { kind: "open_report", reportId: item.report.reportId },
	};
}

function quarantineRows(snapshot: AgentSelectorSnapshot): AgentSelectorRow[] {
	const ids = snapshot.quarantined ?? [];
	const unreadable = Math.max(0, (snapshot.quarantinedCandidateCount ?? ids.length) - ids.length);
	return [
		// No action: choosing a quarantined row is never an admission.
		...ids.map((agentId): AgentSelectorRow => ({
			kind: "quarantined", key: `quarantined:${agentId}`, agentId, action: undefined,
		})),
		...(unreadable > 0
			? [{ kind: "unreadable_candidates", key: "quarantined:unreadable", count: unreadable, action: undefined } as const]
			: []),
	];
}

function agentRow(state: AgentSelectorState, status: AgentRosterStatus): AgentSelectorRow {
	return {
		kind: "agent",
		key: status.agentId,
		status,
		childCount: state.activeTab === "live" ? liveChildren(state.roster, status.agentId).length : 0,
		moderator: status.agentId !== status.workflowId && status.directSpawnerAgentId === null,
		mounted: status.agentId === state.snapshot.selectedAgentId,
		action: { kind: "select_agent", agentId: status.agentId },
	};
}

function ownerRow(state: AgentSelectorState): AgentSelectorRow {
	const { agentId } = state.roster.owner;
	return {
		kind: "owner",
		key: agentId,
		agentId,
		mounted: agentId === state.snapshot.selectedAgentId,
		action: { kind: "select_agent", agentId },
	};
}

/** The active tab's rows in focus order, before any retained row. */
function tabRows(state: AgentSelectorState): AgentSelectorRow[] {
	const { snapshot, roster } = state;
	const body = state.activeTab === "live"
		? [
			...inboxRows(snapshot),
			...liveChildren(roster, state.scopeAgentId).map((status) => agentRow(state, status)),
		]
		: state.activeTab === "reports"
			? (snapshot.reports ?? []).map(reportRow)
			: state.activeTab === "quarantined"
				? quarantineRows(snapshot)
				: roster.dormant.map((status) => agentRow(state, status));
	return [...body, ownerRow(state)];
}

/** The active tab's rows, keeping a retained focused row where it was. */
function activeRows(state: AgentSelectorState): AgentSelectorRow[] {
	const rows = tabRows(state);
	const { retained } = state;
	if (!retained || rows.some(({ key }) => key === retained.agentId)) return rows;
	const status = state.roster.byId.get(retained.agentId);
	if (status) rows.splice(Math.min(retained.index, rows.length - 1), 0, agentRow(state, status));
	return rows;
}

/**
 * Resolve the active tab's focus to a present row, remembering the resolved
 * fallback rather than an absent preferred row. A retained row survives only
 * while it keeps focus.
 */
function resolveFocus(state: AgentSelectorState): AgentSelectorState {
	const preferred = state.focus[state.activeTab];
	const { retained: candidate } = state;
	const retained = candidate && candidate.agentId === preferred &&
		state.roster.byId.has(candidate.agentId)
		? candidate
		: undefined;
	const rows = activeRows({ ...state, retained });
	const preferredIndex = rows.findIndex(({ key }) => key === preferred);
	const index = preferredIndex >= 0
		? preferredIndex
		: Math.max(0, rows.findIndex(({ kind }) => kind !== "owner"));
	return { ...state, retained, focus: { ...state.focus, [state.activeTab]: rows[index]!.key } };
}

function visibleTabs(snapshot: AgentSelectorSnapshot): AgentSelectorTab[] {
	return [
		"live",
		"dormant",
		...((snapshot.reports ?? []).length > 0 ? ["reports" as const] : []),
		...(quarantineRows(snapshot).length > 0 ? ["quarantined" as const] : []),
	];
}

function scopePath(state: AgentSelectorState): AgentRosterStatus[] {
	const path: AgentRosterStatus[] = [];
	let current = state.roster.byId.get(state.scopeAgentId);
	while (current && current.agentId !== state.roster.owner.agentId) {
		path.unshift(current);
		current = current.directSpawnerAgentId === null
			? undefined : state.roster.byId.get(current.directSpawnerAgentId);
	}
	return path;
}

function emptyState(
	tab: AgentSelectorTab,
	rows: readonly AgentSelectorRow[],
): AgentSelectorEmptyState | undefined {
	switch (tab) {
		case "live": return rows.some(({ kind }) => kind === "agent") ? undefined : "no_live_agents";
		case "dormant": return rows.some(({ kind }) => kind === "agent") ? undefined : "no_dormant_agents";
		case "reports": return rows.length > 1 ? undefined : "no_reports";
		case "quarantined": return rows.length > 1 ? undefined : "no_quarantined_agents";
	}
}
