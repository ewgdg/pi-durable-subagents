import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRosterStatus } from "../src/coordination/workflow-coordinator.ts";
import type { HumanAttentionItem } from "../src/coordination/human-requests.ts";
import {
	agentSelectorView,
	applyAgentSelectorIntent,
	findWorkflowOwner,
	openAgentSelector,
	requireWorkflowOwner,
	type AgentSelectorIntent,
	type AgentSelectorRow,
	type AgentSelectorSnapshot,
	type AgentSelectorView,
} from "../src/presentation/agent-selector-projection.ts";

function live(agentId: string, directSpawnerAgentId: string | null = "owner"): AgentRosterStatus {
	return {
		agentId,
		workflowId: "owner",
		label: agentId,
		directSpawnerAgentId,
		primaryEvidence: { transcriptPath: null, inspectedThrough: { agentId, entryId: `entry-${agentId}` } },
		run: { phase: "live", work: "settled", attention: "none", retentionReasons: [] },
		model: { provider: "test", modelId: "model" },
		thinking: "off",
		compacting: false,
		queuedInputCount: 0,
	};
}

function dormant(agentId: string, directSpawnerAgentId: string | null = "owner"): AgentRosterStatus {
	return { ...live(agentId, directSpawnerAgentId), run: { phase: "dormant", retentionReasons: [] } };
}

test("the Owner is the roster Agent whose Agent ID is its Workflow ID, live or Dormant", () => {
	const rows: [string, { live: AgentRosterStatus[]; dormant: AgentRosterStatus[] }, string | undefined][] = [
		["live Owner", { live: [live("worker"), live("owner", null)], dormant: [] }, "owner"],
		["Dormant Owner", { live: [live("worker")], dormant: [dormant("owner", null)] }, "owner"],
		["a root Moderator is not the Owner", { live: [live("moderator", null)], dormant: [] }, undefined],
	];
	for (const [scenario, roster, ownerId] of rows) {
		assert.equal(findWorkflowOwner(roster)?.agentId, ownerId, scenario);
		if (ownerId) assert.equal(requireWorkflowOwner(roster).agentId, ownerId, scenario);
		else assert.throws(() => requireWorkflowOwner(roster), /Agent selector roster has no Owner/, scenario);
	}
});

const owner = live("owner", null);

function human(requestId: string, agentId = "child"): HumanAttentionItem {
	return { requestId, agentId, agentLabel: agentId, question: "Proceed?" };
}

/** A compact, human-readable row: what it is, its child count, and markers. */
function describeRow(row: AgentSelectorRow): string {
	switch (row.kind) {
		case "decide": return `decide:${row.attention.requestId}`;
		case "incident": return `incident:${row.number}` + (row.action ? `→${row.action.agentId}` : "");
		case "report": return `report:${row.item.report.reportId}` + (row.item.readAt ? " read" : "");
		case "agent": return row.status.agentId + (row.childCount ? `(${row.childCount})` : "") +
			(row.moderator ? " moderator" : "") + (row.mounted ? "*" : "");
		case "quarantined": return `quarantined:${row.agentId}`;
		case "unreadable_candidates": return `unreadable:${row.count}`;
		case "owner": return "owner" + (row.mounted ? "*" : "");
	}
}

type ViewFacts = Readonly<{
	tabs: string;
	tab: string;
	path: string;
	/** The focus order; the focused row is marked with an arrow, as on screen. */
	rows: readonly string[];
	empty: string;
}>;

function viewFacts(view: AgentSelectorView): ViewFacts {
	return {
		tabs: view.tabs.join(" "),
		tab: view.activeTab,
		path: view.scopePath.map(({ agentId }) => agentId).join(" › "),
		rows: view.rows.map((row, index) => (index === view.focusedIndex ? "→ " : "") + describeRow(row)),
		empty: view.emptyState ?? "",
	};
}

type Scenario = readonly [
	scenario: string,
	snapshot: Partial<AgentSelectorSnapshot>,
	intents: readonly AgentSelectorIntent[],
	expected: Partial<ViewFacts>,
];

function select(snapshot: Partial<AgentSelectorSnapshot>, intents: readonly AgentSelectorIntent[] = []) {
	let state = openAgentSelector({ live: [owner], dormant: [], selectedAgentId: "owner", ...snapshot });
	for (const intent of intents) state = applyAgentSelectorIntent(state, intent);
	return agentSelectorView(state);
}

function assertScenarios(scenarios: readonly Scenario[]): void {
	for (const [scenario, snapshot, intents, expected] of scenarios) {
		const facts = viewFacts(select(snapshot, intents));
		const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, facts[key as keyof ViewFacts]]));
		assert.deepEqual(actual, expected, scenario);
	}
}

test("opening starts at the mounted Agent, or at the first attention item", () => {
	assertScenarios([
		["the Owner opens on its first child", {
			live: [owner, live("first"), live("second")],
		}, [], { tabs: "live dormant", tab: "live", path: "", rows: ["→ first", "second", "owner*"], empty: "" }],
		["no Agents focuses the Owner", {}, [], { rows: ["→ owner*"], empty: "no_live_agents" }],
		["a nested Agent opens among its siblings", {
			live: [owner, live("branch"), live("first", "branch"), live("mounted", "branch")],
			selectedAgentId: "mounted",
		}, [], { path: "branch", rows: ["first", "→ mounted*", "owner"] }],
		["the first attention item wins initial focus", {
			live: [owner, live("child")], selectedAgentId: "child",
			humanAttention: [human("first"), human("second")],
		}, [], { rows: ["→ decide:first", "decide:second", "child*", "owner"] }],
		["a mounted Dormant Agent opens the Dormant tab on it", {
			dormant: [dormant("recent"), dormant("mounted")], selectedAgentId: "mounted",
		}, [], { tab: "dormant", rows: ["recent", "→ mounted*", "owner"] }],
	]);
});

const readReport = moderatorReport("history", "2026-01-02T00:00:00Z");

function moderatorReport(reportId: string, readAt?: string) {
	return {
		report: {
			reportId, createdAt: "2026-01-01T00:00:00Z",
			reporter: { agentId: "moderator", label: "Moderator" },
			source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/report.jsonl" },
			symptom: "Stalled", suspectedDefect: "Unknown", uncertainty: "Unknown",
			recoveryActions: "None", recoveryOutcome: "Unknown", evidence: [],
		},
		...(readAt ? { readAt } : {}),
	};
}

test("Reports and Quarantined appear only with entries, and tab cycling skips hidden tabs", () => {
	const dormantRoster = { dormant: [dormant("sleeper")] };
	assertScenarios([
		["empty Reports and Quarantined stay hidden", { ...dormantRoster, reports: [], quarantined: [], quarantinedCandidateCount: 0 },
			[], { tabs: "live dormant" }],
		["Tab wraps over the two visible tabs", dormantRoster,
			[{ kind: "next_tab" }, { kind: "next_tab" }], { tab: "live" }],
		["Shift Tab wraps backwards", dormantRoster,
			[{ kind: "previous_tab" }], { tab: "dormant", rows: ["→ sleeper", "owner*"] }],
		["Report history adds the Reports tab", { reports: [readReport] },
			[{ kind: "previous_tab" }], { tabs: "live dormant reports", tab: "reports", rows: ["→ report:history read", "owner*"] }],
		["quarantined identities add the Quarantined tab", { quarantined: ["zx-9", "ab-1"], quarantinedCandidateCount: 2 },
			[{ kind: "previous_tab" }],
			{ tabs: "live dormant quarantined", tab: "quarantined", rows: ["→ quarantined:zx-9", "quarantined:ab-1", "owner*"] }],
		["unreadable candidates alone still show the tab", { quarantined: [], quarantinedCandidateCount: 3 },
			[{ kind: "choose_tab", tab: "quarantined" }], { tabs: "live dormant quarantined", rows: ["→ unreadable:3", "owner*"] }],
		["unreadable candidates follow readable identities", { quarantined: ["zx-9"], quarantinedCandidateCount: 3 },
			[{ kind: "choose_tab", tab: "quarantined" }], { rows: ["→ quarantined:zx-9", "unreadable:2", "owner*"] }],
		["each tab remembers its focus", { live: [owner, live("first"), live("second")], dormant: [dormant("a"), dormant("b")] },
			[{ kind: "focus_next" }, { kind: "next_tab" }, { kind: "focus_next" }, { kind: "previous_tab" }],
			{ tab: "live", rows: ["first", "→ second", "owner*"] }],
		["an empty tab focuses the Owner", {}, [{ kind: "next_tab" }], { rows: ["→ owner*"], empty: "no_dormant_agents" }],
	]);
});

test("Live browses scopes by children, parent, root and ancestor", () => {
	const tree = {
		live: [owner, live("researcher"), live("scout", "researcher"), live("synth", "researcher"), live("builder"), live("reviewer", "builder")],
	};
	const deep = {
		live: [owner, live("first"), live("branch"), live("nested", "branch"), live("leaf", "nested")],
		selectedAgentId: "leaf",
	};
	assertScenarios([
		["the root lists direct children with child counts", tree, [], { path: "", rows: ["→ researcher(2)", "builder(1)", "owner*"] }],
		["opening children focuses the first child", tree, [{ kind: "open_children" }],
			{ path: "researcher", rows: ["→ scout", "synth", "owner*"] }],
		["going to the parent refocuses the previous scope", tree, [{ kind: "open_children" }, { kind: "go_to_parent" }],
			{ path: "", rows: ["→ researcher(2)", "builder(1)", "owner*"] }],
		["a row without live children does not open", tree, [{ kind: "focus_next" }, { kind: "open_children" }, { kind: "open_children" }],
			{ path: "builder", rows: ["→ reviewer", "owner*"] }],
		["the Owner destination does not open", tree, [{ kind: "focus_next" }, { kind: "focus_next" }, { kind: "open_children" }],
			{ path: "", rows: ["researcher(2)", "builder(1)", "→ owner*"] }],
		["the root has no parent", tree, [{ kind: "go_to_parent" }], { path: "", rows: ["→ researcher(2)", "builder(1)", "owner*"] }],
		["going to the root focuses the top-level ancestor", deep, [{ kind: "go_to_root" }],
			{ path: "", rows: ["first", "→ branch(1)", "owner"] }],
		["going to the root at the root keeps focus", deep, [{ kind: "go_to_root" }, { kind: "focus_previous" }, { kind: "go_to_root" }],
			{ path: "", rows: ["→ first", "branch(1)", "owner"] }],
		["an ancestor jump focuses the child along the path", deep, [{ kind: "go_to_ancestor", agentId: "branch", childId: "nested" }],
			{ path: "branch", rows: ["→ nested(1)", "owner"] }],
		["children browse only on Live", { live: [owner, live("child")], dormant: [dormant("parent")] },
			[{ kind: "next_tab" }, { kind: "open_children" }, { kind: "go_to_root" }], { tab: "dormant", rows: ["→ parent", "owner*"] }],
		["live Moderators without a Direct Spawner sit at the root", { live: [owner, live("moderator", null), live("child")] },
			[], { rows: ["→ moderator moderator", "child", "owner*"] }],
	]);
});

test("Live keeps Dormant ancestors as browsing paths and Dormant keeps only fully Dormant branches", () => {
	const branches = {
		live: [owner, live("leaf", "middle")],
		dormant: [dormant("root"), dormant("middle", "root"), dormant("quiet", "root"), dormant("quiet-leaf", "quiet")],
	};
	assertScenarios([
		["a Dormant ancestor counts only live paths", branches, [], { rows: ["→ root(1)", "owner*"] }],
		["Dormant ancestors open their live descendants", branches, [{ kind: "open_children" }, { kind: "open_children" }],
			{ path: "root › middle", rows: ["→ leaf", "owner*"] }],
		["the Dormant tab lists only fully Dormant branches", branches, [{ kind: "next_tab" }],
			{ rows: ["→ quiet", "quiet-leaf", "owner*"] }],
		["a mounted Dormant ancestor opens in Live", { live: [owner, live("child", "parent")], dormant: [dormant("parent")], selectedAgentId: "parent" },
			[], { tab: "live", rows: ["→ parent(1)*", "owner"] }],
		["a Dormant Owner is only the Owner destination", { live: [], dormant: [dormant("owner", null), dormant("worker")] },
			[{ kind: "next_tab" }], { rows: ["→ worker", "owner*"] }],
		...(["starting", "ending"] as const).map((phase): Scenario => [
			`a Dormant ancestor of a ${phase} Agent stays on Live`,
			{ live: [owner, { ...live("child", "parent"), run: { phase, attention: "none", retentionReasons: [] } }], dormant: [dormant("parent")] },
			[], { tab: "live", rows: ["→ parent(1)", "owner*"] },
		]),
		["going to the root focuses a Dormant top-level ancestor", {
			live: [owner, live("root"), live("leaf", "sleeping")], dormant: [dormant("sleeping")],
			selectedAgentId: "leaf", humanAttention: [human("request", "leaf")],
		}, [{ kind: "go_to_root" }], { path: "", rows: ["decide:request", "root", "→ sleeping(1)", "owner"] }],
	]);
});

test("a refresh moves a branch between Live and Dormant once its last live descendant changes", () => {
	const parentAndChild = { live: [owner, live("parent"), live("child", "parent")] };
	const branchEnds = refresh({ live: [owner], dormant: [dormant("parent"), dormant("child", "parent")] });
	const childResumes = refresh({ live: [owner, live("child", "parent")], dormant: [dormant("parent")] });
	assertScenarios([
		["the focused Dormant parent stays while its branch ends", parentAndChild, [branchEnds],
			{ tab: "live", rows: ["→ parent", "owner*"] }],
		["leaving it moves the whole branch to Dormant", parentAndChild, [branchEnds, { kind: "focus_next" }],
			{ rows: ["→ owner*"], empty: "no_live_agents" }],
		["the ended branch is listed on Dormant", parentAndChild, [branchEnds, { kind: "focus_next" }, { kind: "next_tab" }],
			{ tab: "dormant", rows: ["→ parent", "child", "owner*"] }],
		["a resumed child leaves the focused parent on Dormant until focus leaves", parentAndChild,
			[branchEnds, { kind: "focus_next" }, { kind: "next_tab" }, childResumes],
			{ tab: "dormant", rows: ["→ parent", "owner*"] }],
		["leaving it empties Dormant", parentAndChild,
			[branchEnds, { kind: "focus_next" }, { kind: "next_tab" }, childResumes, { kind: "focus_next" }],
			{ rows: ["→ owner*"], empty: "no_dormant_agents" }],
		["a resumed child takes the branch back to Live", parentAndChild,
			[branchEnds, { kind: "focus_next" }, { kind: "next_tab" }, childResumes, { kind: "focus_next" }, { kind: "previous_tab" }],
			{ tab: "live", rows: ["parent(1)", "→ owner*"] }],
		["the resumed branch browses from its Dormant parent", parentAndChild,
			[branchEnds, { kind: "focus_next" }, { kind: "next_tab" }, childResumes, { kind: "previous_tab" }, { kind: "focus_previous" }, { kind: "open_children" }],
			{ path: "parent", rows: ["→ child", "owner*"] }],
		["a refresh publishes quarantined identities", {},
			[refresh({ live: [owner], dormant: [], quarantined: ["zx-9"], quarantinedCandidateCount: 1 })],
			{ tabs: "live dormant quarantined" }],
	]);
});

function refresh(update: Partial<AgentSelectorSnapshot> & Pick<AgentSelectorSnapshot, "live" | "dormant">): AgentSelectorIntent {
	return { kind: "roster_changed", update };
}

test("a focused Agent keeps its row across refreshes until focus leaves it", () => {
	const child = live("child");
	const sleepingChild = dormant("child");
	const siblings = { live: [owner, live("previous"), child, live("next")], selectedAgentId: "child" };
	const migrated = refresh({ live: [owner, live("previous"), live("next")], dormant: [sleepingChild] });
	assertScenarios([
		["a focused Agent turning Dormant stays in place on Live", siblings, [migrated, migrated],
			{ tab: "live", rows: ["previous", "→ child*", "next", "owner"] }],
		["moving down leaves to the displayed neighbour", siblings, [migrated, { kind: "focus_next" }],
			{ rows: ["previous", "→ next", "owner"] }],
		["moving up leaves to the displayed neighbour", siblings, [migrated, { kind: "focus_previous" }],
			{ rows: ["→ previous", "next", "owner"] }],
		["focusing another row releases it", siblings, [migrated, { kind: "focus_row", key: "next" }],
			{ rows: ["previous", "→ next", "owner"] }],
		["the migrated Agent appears normally on its new tab", { live: [owner, child] },
			[refresh({ live: [owner], dormant: [sleepingChild] }), { kind: "next_tab" }],
			{ tab: "dormant", rows: ["→ child", "owner*"] }],
		["changing tabs releases it", { live: [owner, child] },
			[refresh({ live: [owner], dormant: [sleepingChild] }), { kind: "next_tab" }, { kind: "previous_tab" }],
			{ tab: "live", rows: ["→ owner*"] }],
		["a focused Dormant Agent turning live stays on Dormant", { dormant: [dormant("child"), dormant("sibling")], selectedAgentId: "child" },
			[refresh({ live: [owner, child], dormant: [dormant("sibling")] })], { tab: "dormant", rows: ["→ child*", "sibling", "owner"] }],
		["changing scope releases it", { live: [owner, live("branch"), live("child", "branch"), live("sibling", "branch")], selectedAgentId: "child" },
			[refresh({ live: [owner, live("branch"), live("sibling", "branch")], dormant: [dormant("child", "branch")] }),
				{ kind: "go_to_parent" }, { kind: "open_children" }],
			{ path: "branch", rows: ["→ sibling", "owner"] }],
		["a mounted but unfocused Agent is not retained", { live: [owner, child, live("sibling")], selectedAgentId: "child" },
			[{ kind: "focus_next" }, refresh({ live: [owner, live("sibling")], dormant: [sleepingChild] })],
			{ rows: ["→ sibling", "owner"] }],
		["an Agent gone from both rosters falls back to a stable neighbour", { live: [owner, child, live("sibling")], selectedAgentId: "child" },
			[refresh({ live: [owner, live("sibling")], dormant: [] }), refresh({ live: [owner, child, live("sibling")], dormant: [] })],
			{ rows: ["child*", "→ sibling", "owner"] }],
		["arriving attention does not steal focus", { live: [owner, child] },
			[refresh({ live: [owner, child], dormant: [], humanAttention: [human("request")] })],
			{ rows: ["decide:request", "→ child", "owner*"] }],
		["a parent turning Dormant stays a browsing path until its last live descendant ends", { live: [owner, live("parent"), live("child", "parent")] },
			[refresh({ live: [owner, live("child", "parent")], dormant: [dormant("parent")] })],
			{ rows: ["→ parent(1)", "owner*"] }],
	]);
});

test("Attention, Agents and the Owner form one focus order that does not wrap", () => {
	const snapshot = { live: [owner, live("child")], selectedAgentId: "child", humanAttention: [human("request")] };
	assertScenarios([
		["down stops at the Owner", snapshot, [{ kind: "focus_next" }, { kind: "focus_next" }, { kind: "focus_next" }],
			{ rows: ["decide:request", "child*", "→ owner"] }],
		["up stops at the first item", snapshot, [{ kind: "focus_previous" }], { rows: ["→ decide:request", "child*", "owner"] }],
		["an absent row cannot take focus", snapshot, [{ kind: "focus_row", key: "missing" }], { rows: ["→ decide:request", "child*", "owner"] }],
	]);
});

function incident(agentIds: readonly string[], reportSource?: { agentId: string; entryId: string }) {
	return {
		trigger: { kind: "run_failure" as const, agentId: agentIds[0]!, runSequence: 1, obligations: { total: 0, sources: [] } },
		affectedAgents: agentIds.map((agentId) => ({ agentId, label: agentId })),
		diagnostics: [],
		...(reportSource ? { reportSource } : {}),
	};
}

function runtimeReport(reportId: string, entryId: string, readAt?: string) {
	return {
		report: {
			reportId, createdAt: "2026-01-01T00:00:00Z",
			source: { kind: "runtime_diagnostic" as const, agentId: "owner", entryId, transcriptPath: "/tmp/owner.jsonl" },
			symptom: "Run failed", suspectedDefect: "Unknown", uncertainty: "Unknown",
			recoveryActions: "None", recoveryOutcome: "Unknown", evidence: [],
		},
		...(readAt ? { readAt } : {}),
	};
}

test("Attention Inbox rows carry the exact action Enter performs", () => {
	const view = select({
		live: [owner, live("asker")],
		humanAttention: [human("first", "asker"), human("second", "asker")],
		operationalAttention: [incident(["worker"]), incident(["a", "b"]), incident(["covered"], { agentId: "owner", entryId: "covered" })],
		reports: [moderatorReport("unread"), readReport, runtimeReport("covering", "covered", "2026-01-02T00:00:00Z")],
	});
	assert.deepEqual(view.rows.map((row) => [row.key, row.action]), [
		["human:first", { kind: "decide", requestId: "first", agentId: "asker" }],
		["human:second", { kind: "decide", requestId: "second", agentId: "asker" }],
		["operational:0", { kind: "select_agent", agentId: "worker" }],
		["operational:1", undefined],
		["report:unread", { kind: "open_report", reportId: "unread" }],
		["asker", { kind: "select_agent", agentId: "asker" }],
		["owner", { kind: "select_agent", agentId: "owner" }],
	]);
	assert.deepEqual(view.rows.flatMap((row) => row.kind === "decide" || row.kind === "incident" ? [row.number] : []), [1, 2, 1, 2]);
	assert.equal(view.liveStatus, "unresolved_incident");
});

test("reading a Report moves Inbox focus to the next item and keeps it in Report history", () => {
	const reports = [moderatorReport("first"), moderatorReport("second"), moderatorReport("third")];
	const markRead = (reportId: string): AgentSelectorIntent => ({
		kind: "report_read_changed", reportId,
		reports: reports.map((item) => item.report.reportId === reportId ? { ...item, readAt: "2026-01-02T00:00:00Z" } : item),
	});
	assertScenarios([
		["the Inbox moves on to the next item", { reports }, [{ kind: "focus_next" }, markRead("second")],
			{ rows: ["report:first", "→ report:third", "owner*"] }],
		["the last Inbox item moves on to the first Agent", { live: [owner, live("child")], reports }, [{ kind: "focus_row", key: "report:third" }, markRead("third")],
			{ rows: ["report:first", "report:second", "→ child", "owner*"] }],
		["Report history keeps the Report focused as Read", { reports }, [{ kind: "choose_tab", tab: "reports" }, { kind: "focus_next" }, markRead("second")],
			{ tab: "reports", rows: ["report:first", "→ report:second read", "report:third", "owner*"] }],
		["marking it unread again restores the Inbox row", { reports }, [markRead("second"), { kind: "report_read_changed", reportId: "second", reports }],
			{ rows: ["report:first", "report:second", "→ report:third", "owner*"] }],
	]);
});

test("the mounted marker follows the mounted Agent on rows and the Owner destination, never the scope path", () => {
	assertScenarios([
		["a mounted Agent stays marked when focus moves", { live: [owner, live("builder"), live("peer")], selectedAgentId: "builder" },
			[{ kind: "focus_next" }], { rows: ["builder*", "→ peer", "owner"] }],
		["a mounted scope is not marked in the path", { live: [owner, live("builder"), live("child", "builder")], selectedAgentId: "builder" },
			[{ kind: "open_children" }], { path: "builder", rows: ["→ child", "owner"] }],
		["a mounted Owner marks only its destination", { live: [owner, live("builder")] },
			[{ kind: "next_tab" }], { rows: ["→ owner*"] }],
		["Dormant Moderators are flagged", { dormant: [dormant("moderator", null)] },
			[{ kind: "next_tab" }], { rows: ["→ moderator moderator", "owner*"] }],
	]);
});
