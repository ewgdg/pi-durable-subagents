import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import { createAgentActivityExtension } from "../src/bootstrap/agent-extension.ts";
import type {
	AgentRosterStatus,
	HumanPresentationCoordinatorView,
} from "../src/coordination/workflow-coordinator.ts";
import {
	AgentActivityDock,
	AGENT_ACTIVITY_WIDGET_KEY,
	installAgentActivityDock,
	type AgentActivityDockOptions,
	type AgentActivitySnapshot,
	type AgentActivitySource,
} from "../src/presentation/agent-activity-surface.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
} as Theme;

function agent(options: {
	agentId: string;
	label: string;
	parent: string | null;
	run?: AgentRosterStatus["run"];
	model?: string;
	thinking?: AgentRosterStatus["thinking"];
	queued?: number;
	failed?: boolean;
}): AgentActivitySnapshot["scope"] {
	return {
		agentId: options.agentId,
		workflowId: "owner",
		label: options.label,
		directSpawnerAgentId: options.parent,
		primaryEvidence: {
			transcriptPath: null,
			inspectedThrough: { agentId: options.agentId, entryId: `${options.agentId}-tail` },
		},
		run: options.run ?? {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [],
		},
		model: { provider: "anthropic", modelId: options.model ?? "claude-sonnet-4" },
		thinking: options.thinking ?? "high",
		compacting: false,
		queuedInputCount: options.queued ?? 0,
		failed: options.failed ?? false,
	};
}

function source(initial: AgentActivitySnapshot) {
	let snapshot = initial;
	const handlers = new Set<() => void>();
	const source: AgentActivitySource = {
		snapshot: () => snapshot,
		addChangeHandler(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
	};
	return {
		source,
		publish(next: AgentActivitySnapshot) {
			snapshot = next;
			for (const handler of handlers) handler();
		},
		handlerCount: () => handlers.size,
	};
}

function createDock(
	snapshot: AgentActivitySnapshot,
	options: AgentActivityDockOptions = {},
	hasOverlay: () => boolean = () => false,
) {
	let renders = 0;
	const snapshots = source(snapshot);
	const dock = new AgentActivityDock(
		{
			requestRender: () => renders += 1,
			hasOverlay,
		} as unknown as TUI,
		theme,
		snapshots.source,
		options,
	);
	return {
		dock,
		snapshots,
		renderRequests: () => renders,
	};
}

const ownerSnapshot: AgentActivitySnapshot = {
	scope: agent({ agentId: "owner", label: "Owner", parent: null }),
	children: [],
	answerMode: false,
	humanAttention: [],
	operationalAttention: [],
};

/** Only the terminal boundary encodes mouse reports; components receive these. */
function mouseEvent(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 1,
		y: 0,
		screenX: 1,
		screenY: 2,
		width: 80,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

test("activity dock opens the Agents menu on a completed primary click", () => {
	let opened = 0;
	const { dock } = createDock(ownerSnapshot, {
		openAgentsMenu: () => opened += 1,
	});

	assert.deepEqual(dock.handleMouse(mouseEvent()), { handled: true });
	assert.equal(opened, 1);
	dock.dispose();
});

test("activity dock leaves pointer gestures it does not own to the host", () => {
	let opened = 0;
	const { dock } = createDock(ownerSnapshot, {
		openAgentsMenu: () => opened += 1,
	});
	for (const event of [
		mouseEvent({ type: "press" }),
		mouseEvent({ type: "release" }),
		mouseEvent({ type: "move" }),
		mouseEvent({ type: "drag" }),
		mouseEvent({ type: "wheel", button: "none", wheelDelta: -1 }),
		mouseEvent({ button: "middle" }),
		mouseEvent({ button: "right" }),
	]) {
		assert.equal(dock.handleMouse(event), undefined);
	}
	assert.equal(opened, 0);
	dock.dispose();

	// A dock without the menu action stays purely informational.
	const { dock: inert } = createDock(ownerSnapshot);
	assert.equal(inert.handleMouse(mouseEvent()), undefined);
	inert.dispose();
});

test("activity dock ignores primary clicks while an overlay owns interaction", () => {
	let opened = 0;
	const { dock } = createDock(
		ownerSnapshot,
		{ openAgentsMenu: () => opened += 1 },
		() => true,
	);

	assert.equal(dock.handleMouse(mouseEvent()), undefined);
	assert.equal(opened, 0);
	dock.dispose();
});

test("activity install forwards the Agents menu action to the installed dock", () => {
	let installedFactory: ((tui: TUI, theme: Theme) => AgentActivityDock) | undefined;
	const ui = {
		setWidget(_key: string, factory: typeof installedFactory) {
			installedFactory = factory;
		},
	} as unknown as ExtensionUIContext;
	let opened = 0;

	installAgentActivityDock(ui, source(ownerSnapshot).source, {
		openAgentsMenu: () => opened += 1,
	});
	assert.ok(installedFactory);
	const dock = installedFactory(
		{ requestRender() {}, hasOverlay: () => false } as unknown as TUI,
		theme,
	);
	dock.handleMouse(mouseEvent());
	assert.equal(opened, 1);
	dock.dispose();
});

test("activity extension dispatches the registered Agents command on a dock click", async () => {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const sent: Array<{ content: unknown; options: unknown }> = [];
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		sendUserMessage(content: unknown, options: unknown) {
			sent.push({ content, options });
		},
	} as unknown as ExtensionAPI;
	let installedFactory: ((tui: TUI, theme: Theme) => AgentActivityDock) | undefined;
	const ui = {
		setWidget(_key: string, factory: typeof installedFactory) {
			installedFactory = factory;
		},
	} as unknown as ExtensionUIContext;

	await createAgentActivityExtension(() => ({
		agentActivity: () => ownerSnapshot,
		addAgentActivityChangeHandler: () => () => {},
		refreshAgentActivity: () => {},
	} as unknown as HumanPresentationCoordinatorView))(pi);
	const sessionStart = handlers.get("session_start")?.[0];
	assert.ok(sessionStart);
	await sessionStart({}, { ui });
	assert.ok(installedFactory);
	const dock = installedFactory(
		{ requestRender() {}, hasOverlay: () => false } as unknown as TUI,
		theme,
	);
	dock.handleMouse(mouseEvent());
	assert.deepEqual(sent, [
		{ content: "/agents", options: { expandPromptTemplates: true } },
	]);
	dock.dispose();
});

test("activity extension publishes native model-selection changes", async () => {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;
	let refreshes = 0;
	const view = {
		refreshAgentActivity() {
			refreshes += 1;
		},
	} as unknown as HumanPresentationCoordinatorView;

	await createAgentActivityExtension(() => view)(pi);
	const modelSelect = handlers.get("model_select")?.[0];
	assert.ok(modelSelect);
	await modelSelect();
	assert.equal(refreshes, 1);
});

test("activity installs as one persistent native above-editor widget", () => {
	const snapshots = source({
		scope: agent({ agentId: "leaf-12345678", label: "Leaf", parent: "owner" }),
		children: [],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});
	let installedKey: string | undefined;
	let installedFactory: ((tui: TUI, theme: Theme) => AgentActivityDock) | undefined;
	let installedOptions: unknown;
	const ui = {
		setWidget(key: string, factory: typeof installedFactory, options: unknown) {
			installedKey = key;
			installedFactory = factory;
			installedOptions = options;
		},
	} as unknown as ExtensionUIContext;

	installAgentActivityDock(ui, snapshots.source);
	assert.equal(installedKey, AGENT_ACTIVITY_WIDGET_KEY);
	assert.deepEqual(installedOptions, { placement: "aboveEditor" });
	assert.ok(installedFactory);
	const dock = installedFactory(
		{ requestRender() {} } as unknown as TUI,
		theme,
	);
	assert.match(dock.render(80).join("\n"), /Leaf.*12345678.*idle/);
	dock.dispose();
});

test("Owner activity renders Attention Inbox above direct children in creation order", () => {
	const owner = agent({ agentId: "owner", label: "Owner", parent: null });
	const first = agent({
		agentId: "researcher",
		label: "Researcher",
		parent: "owner",
		run: {
			phase: "live",
			work: "active",
			attention: "input_required",
			retentionReasons: [],
		},
	});
	const second = agent({
		agentId: "builder",
		label: "Builder",
		parent: "owner",
		queued: 2,
	});
	const { dock } = createDock({
		scope: owner,
		children: [first, second],
		answerMode: false,
		humanAttention: [{
			requestId: "request-1",
			agentId: "researcher",
			agentLabel: "Researcher",
			question: "Which boundary should remain authoritative for the final implementation?",
		}],
		operationalAttention: [{
			trigger: {
				kind: "dependency_deadlock",
				agentIds: ["researcher", "builder"],
				requests: { total: 1, sources: [] },
			},
			affectedAgents: [
				{ agentId: "researcher", label: "Researcher" },
				{ agentId: "builder", label: "Builder" },
			],
			diagnostics: [],
		}],
	});

	const rendered = dock.render(200);
	assert.match(rendered[0]!, /Attention Inbox/);
	assert.match(rendered[1]!, /DECIDE.*Researcher.*Which boundary should remain authoritative/);
	assert.match(rendered[2]!, /ATTENTION.*Dependency Deadlock.*Researcher, Builder/);
	assert.match(rendered[3]!, /Agents/);
	assert.match(rendered[4]!, /Researcher/);
	assert.match(rendered[5]!, /Builder.*2 queued/);
	dock.dispose();
});

test("Attention Inbox shows three items and reports the hidden remainder", () => {
	const { dock } = createDock({
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [],
		answerMode: false,
		humanAttention: Array.from({ length: 5 }, (_, index) => ({
			requestId: `request-${index + 1}`,
			agentId: `agent-${index + 1}`,
			agentLabel: `Agent ${index + 1}`,
			question: `Question ${index + 1}?`,
		})),
		operationalAttention: [],
	});

	const rendered = dock.render(120).map((line) =>
		stripTerminalSequences(line).replace(/<[^>]+>/g, "")
	);
	assert.deepEqual(rendered, [
		"Attention Inbox",
		"├─ DECIDE Agent 1 · Question 1?",
		"├─ DECIDE Agent 2 · Question 2?",
		"├─ DECIDE Agent 3 · Question 3?",
		"└─ … 2 more",
	]);
	dock.dispose();
});

test("activity roster shows three live children and reports the hidden remainder", () => {
	const { dock } = createDock({
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: Array.from({ length: 6 }, (_, index) => agent({
			agentId: `child-${index + 1}`,
			label: `Child ${index + 1}`,
			parent: "owner",
		})),
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});

	const rendered = dock.render(120).map((line) =>
		stripTerminalSequences(line).replace(/<[^>]+>/g, "")
	);
	assert.deepEqual(rendered, [
		"Agents",
		"├─ ○ Child 1 · anthropic/claude-sonnet-4:high · idle",
		"├─ ○ Child 2 · anthropic/claude-sonnet-4:high · idle",
		"├─ ○ Child 3 · anthropic/claude-sonnet-4:high · idle",
		"└─ … 3 more",
	]);
	dock.dispose();
});

test("Owner activity renders direct children without requiring attention", () => {
	const { dock } = createDock({
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [agent({ agentId: "child", label: "Child", parent: "owner" })],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});

	const rendered = dock.render(120).join("\n");
	assert.match(rendered, /^<toolTitle><bold>Agents/);
	assert.match(rendered, /Child/);
	assert.doesNotMatch(rendered, /Attention Inbox/);
	dock.dispose();
});

test("nested Agent activity shows identity and only its direct children", () => {
	const { dock } = createDock({
		scope: agent({
			agentId: "agent-researcher-12345678",
			label: "Researcher",
			parent: "owner",
			run: {
				phase: "live",
				work: "active",
				attention: "none",
				retentionReasons: [],
			},
		}),
		children: [
			agent({ agentId: "source-scout", label: "Source Scout", parent: "agent-researcher-12345678" }),
			agent({ agentId: "synthesizer", label: "Synthesizer", parent: "agent-researcher-12345678" }),
		],
		answerMode: false,
		humanAttention: [{
			requestId: "owner-only",
			agentId: "sibling",
			agentLabel: "Sibling",
			question: "Owner-only decision",
		}],
		operationalAttention: [],
	});

	const rendered = dock.render(160).join("\n");
	assert.match(
		rendered,
		/^<accent><bold>Researcher<\/bold><\/accent><dim> · 12345678 · <\/dim><success>active<\/success>/,
	);
	assert.match(rendered, /Source Scout/);
	assert.match(rendered, /Synthesizer/);
	assert.doesNotMatch(rendered, /Sibling|Attention Inbox|DECIDE/);
	dock.dispose();
});

test("leaf selection keeps only the plain identity directly above the editor", () => {
	const { dock } = createDock({
		scope: agent({
			agentId: "leaf-agent-87654321",
			label: "Leaf",
			parent: "owner",
		}),
		children: [],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});

	assert.deepEqual(dock.render(120), [
		"<accent><bold>Leaf</bold></accent><dim> · 87654321 · </dim><dim>idle</dim>",
	]);
	dock.dispose();
});

test("selected Agent activity projects Answer mode directly above its native editor", () => {
	const { dock } = createDock({
		scope: agent({
			agentId: "requester-12345678",
			label: "Requester",
			parent: "owner",
			run: {
				phase: "live",
				work: "active",
				attention: "input_required",
				retentionReasons: [],
			},
		}),
		children: [],
		answerMode: true,
		humanAttention: [],
		operationalAttention: [],
	});

	const rendered = dock.render(120);
	assert.match(rendered[0]!, /Requester.*waiting \(human input\)/);
	assert.equal(
		stripTerminalSequences(rendered.at(-1)!).replace(/<[^>]+>/g, ""),
		"ANSWER · Enter submits",
	);
	dock.dispose();
});

test("activity lists only Agents with a current Run", () => {
	const { dock } = createDock({
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [
			agent({
				agentId: "starting-child",
				label: "Starting Child",
				parent: "owner",
				run: { phase: "starting", attention: "none", retentionReasons: [] },
			}),
			agent({ agentId: "live-child", label: "Live Child", parent: "owner" }),
			agent({
				agentId: "ending-child",
				label: "Ending Child",
				parent: "owner",
				run: { phase: "ending", attention: "none", retentionReasons: [] },
			}),
			agent({
				agentId: "dormant-child",
				label: "Dormant Child",
				parent: "owner",
				run: { phase: "dormant", retentionReasons: [] },
			}),
		],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});

	const rendered = stripTerminalSequences(dock.render(160).join("\n"));
	assert.match(rendered, /Starting Child/);
	assert.match(rendered, /Live Child/);
	assert.match(rendered, /Ending Child/);
	assert.doesNotMatch(rendered, /Dormant Child|Dormant/);
	dock.dispose();
});

test("report inbox sanitizes OSC terminal controls in reporter labels and symptoms", () => {
	const report = {
		reportId: "report", createdAt: "2026-01-01T00:00:00.000Z",
		reporter: { agentId: "moderator", label: "Mod\x1b]8;;https://label.example\x07er" },
		source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/sessions/moderator.jsonl" },
		symptom: "Delivery\x1b]52;c;secret\x07 stalled", suspectedDefect: "Continuation absent", uncertainty: "Cause unknown",
		recoveryActions: "Retried", recoveryOutcome: "Still blocked", evidence: ["entry"],
	};
	const snapshot: AgentActivitySnapshot = {
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [], answerMode: false, humanAttention: [], operationalAttention: [],
		reports: [{ report }],
	};
	const { dock } = createDock(snapshot);
	const rendered = dock.render(120).join("\n");
	assert.match(rendered, /Moder.*Delivery.*stalled/);
	assert.doesNotMatch(rendered, /\x1b|label\.example|secret/);
	dock.dispose();
});

test("activity updates volatile state and rebinds scope without retaining a stale subscription", () => {
	const initial: AgentActivitySnapshot = {
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [agent({ agentId: "live-child", label: "Live Child", parent: "owner" })],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	};
	const { dock, snapshots, renderRequests } = createDock(initial);
	assert.match(stripTerminalSequences(dock.render(100).join("\n")), /Live Child.*idle/);

	snapshots.publish({
		scope: agent({ agentId: "nested-12345678", label: "Nested", parent: "owner" }),
		children: [],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});
	assert.equal(renderRequests(), 1);
	assert.match(
		stripTerminalSequences(dock.render(100).join("\n")).replace(/<[^>]+>/g, ""),
		/Nested · 12345678 · idle/,
	);
	assert.equal(snapshots.handlerCount(), 1);
	dock.dispose();
	assert.equal(snapshots.handlerCount(), 0);
});

test("activity redraws and animation use published state until the source changes", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const initial: AgentActivitySnapshot = {
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [agent({
			agentId: "worker",
			label: "Worker",
			parent: "owner",
			run: { phase: "live", work: "active", attention: "none", retentionReasons: [] },
		})],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	};
	const snapshots = source(initial);
	let readingPublishedState = true;
	let renderRequests = 0;
	const dock = new AgentActivityDock(
		{ requestRender: () => renderRequests += 1, hasOverlay: () => false } as unknown as TUI,
		theme,
		{
			...snapshots.source,
			snapshot() {
				assert.ok(readingPublishedState, "ordinary repaint must not query live activity evidence");
				return snapshots.source.snapshot();
			},
		},
	);
	t.after(() => dock.dispose());
	readingPublishedState = false;
	for (const width of [80, 120, 80]) {
		dock.invalidate();
		assert.match(dock.render(width).join("\n"), /Worker/);
	}
	t.mock.timers.tick(1_000);
	assert.ok(renderRequests > 0, "an active child still animates between state changes");
	assert.match(dock.render(200).join("\n"), /Worker.*active/);

	readingPublishedState = true;
	snapshots.publish({
		...initial,
		children: [agent({ agentId: "worker", label: "Worker", parent: "owner", queued: 2 })],
	});
	readingPublishedState = false;
	assert.match(dock.render(200).join("\n"), /Worker.*idle.*2 queued/);
	const requestsAfterSettlement = renderRequests;
	t.mock.timers.tick(1_000);
	assert.equal(renderRequests, requestsAfterSettlement, "settled activity stops animating");
});

test("the roster refreshes compaction and restores current activity", () => {
 const owner = agent({ agentId: "owner", label: "Owner", parent: null });
 const child = agent({ agentId: "child", label: "Child", parent: "owner" });
 const initial = { scope: owner, children: [child], answerMode: false, humanAttention: [], operationalAttention: [] };
 const harness = createDock(initial);
 try {
  harness.snapshots.publish({ ...initial, children: [{ ...child, compacting: true }] });
  assert.match(harness.dock.render(200).join("\n"), /compacting/);
  harness.snapshots.publish({ ...initial, children: [{ ...child, run: { phase: "live", work: "active", attention: "none", retentionReasons: [] } }] });
  assert.match(harness.dock.render(200).join("\n"), />active</);
  assert.doesNotMatch(harness.dock.render(200).join("\n"), /compacting/);
  assert.equal(harness.renderRequests(), 2);
 } finally { harness.dock.dispose(); }
});

test("unread reports remain in the Owner Attention Inbox until explicitly marked read", () => {
	const report = {
		reportId: "report", createdAt: "2026-01-01T00:00:00.000Z",
		reporter: { agentId: "moderator", label: "Moderator" },
		source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/sessions/moderator.jsonl" },
		symptom: "Delivery stalled", suspectedDefect: "Continuation absent", uncertainty: "Cause unknown",
		recoveryActions: "Retried", recoveryOutcome: "Still blocked", evidence: ["entry"],
	};
	const snapshot: AgentActivitySnapshot = {
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [], answerMode: false, humanAttention: [], operationalAttention: [],
		reports: [{ report }],
	};
	const { dock } = createDock(snapshot);
	assert.match(dock.render(120).join("\n"), /REPORT.*Moderator.*Delivery stalled/);
	dock.dispose();
	const { dock: readDock } = createDock({ ...snapshot, reports: [{ report, readAt: report.createdAt }] });
	assert.doesNotMatch(readDock.render(120).join("\n"), /REPORT/);
	readDock.dispose();
});

test("linked Run Failure reports own inbox visibility while unresolved status remains live", () => {
	const report = {
		reportId: "failure", createdAt: "2026-06-11T00:00:00Z",
		source: { kind: "runtime_diagnostic" as const, agentId: "owner", entryId: "diagnostic", transcriptPath: "/tmp/owner.jsonl" },
		symptom: "Run failed", suspectedDefect: "Unknown", uncertainty: "Unknown",
		recoveryActions: "None", recoveryOutcome: "Unknown", evidence: ["diagnostic"],
	};
	for (const readAt of [undefined, report.createdAt]) {
		for (const reportSource of [
			{ agentId: "owner", entryId: "diagnostic" },
			{ agentId: "other", entryId: "diagnostic" },
			{ agentId: "owner", entryId: "other" },
		]) {
			const { dock } = createDock({
				scope: agent({ agentId: "owner", label: "Owner", parent: null }), children: [], answerMode: false,
				humanAttention: [], operationalAttention: [{
					trigger: { kind: "run_failure", agentId: "child", runSequence: 1, obligations: { total: 1, sources: [] } },
					affectedAgents: [{ agentId: "child", label: "Child" }], diagnostics: [], reportSource,
				}],
				reports: [{ report, ...(readAt ? { readAt } : {}) }],
			});
			try {
				const rendered = dock.render(160).join("\n");
				assert.match(rendered, /Operational incident unresolved · live status/);
				if (reportSource.agentId === "owner" && reportSource.entryId === "diagnostic") {
					assert.doesNotMatch(rendered, /ATTENTION/);
					if (readAt) assert.doesNotMatch(rendered, /Attention Inbox/);
				} else assert.match(rendered, /ATTENTION.*Run Failure/);
				if (readAt) assert.doesNotMatch(rendered, /REPORT/);
				else assert.match(rendered, /REPORT.*Runtime.*Run failed/);
			} finally { dock.dispose(); }
		}
	}
});

test("acknowledged moderation failure keeps live unavailable status outside the inbox", () => {
	const report = {
		reportId: "failure", createdAt: "2026-06-11T00:00:00Z",
		source: { kind: "runtime_diagnostic" as const, agentId: "owner", entryId: "diagnostic", transcriptPath: "/tmp/owner.jsonl" },
		symptom: "Inspection blocked", suspectedDefect: "Unknown", uncertainty: "No incident established",
		recoveryActions: "None", recoveryOutcome: "Unknown", evidence: ["diagnostic"],
	};
	for (const readAt of [undefined, report.createdAt]) {
		const { dock } = createDock({
			scope: agent({ agentId: "owner", label: "Owner", parent: null }), children: [], answerMode: false,
			humanAttention: [], operationalAttention: [{
				trigger: { kind: "moderation_unavailable" }, affectedAgents: [], diagnostics: [],
				reportSource: { agentId: "owner", entryId: "diagnostic" },
			}],
			reports: [{ report, ...(readAt ? { readAt } : {}) }],
		});
		const rendered = dock.render(160).join("\n");
		assert.match(rendered, /Moderation Unavailable · live status/);
		assert.doesNotMatch(rendered, /Operational incident unresolved/);
		assert.doesNotMatch(rendered, /ATTENTION.*Moderation/);
		if (readAt) assert.doesNotMatch(rendered, /Attention Inbox|REPORT/);
		else assert.match(rendered, /REPORT.*Runtime.*Inspection blocked/);
		dock.dispose();
	}
});
