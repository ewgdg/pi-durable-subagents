import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import type { RemoteAgentSelectorSnapshot } from "../src/control/agent-control-protocol.ts";
import type { HumanPresentationCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import type { PhysicalAgentViewSurface } from "../src/presentation/agent-view-surface.ts";
import {
	createProjectionHarness,
	createSurfaceHarness,
	createViewHarness,
} from "./support/agent-view-harness.ts";
import {
	createControlAgentsNavigation,
	createLocalAgentsNavigation,
} from "../src/presentation/agents-navigation-adapters.ts";
import {
	navigateAgents,
	type AgentSelectionAction,
	type AgentsNavigationAdapter,
	type AgentsNavigationNext,
} from "../src/presentation/agents-navigation.ts";

const ownerStatus = {
	agentId: "owner",
	workflowId: "owner",
	label: "Owner",
	directSpawnerAgentId: null,
	primaryEvidence: {
		transcriptPath: "/sessions/owner.jsonl",
		inspectedThrough: { agentId: "owner", entryId: "owner-entry" },
	},
	run: {
		phase: "live",
		work: "settled",
		attention: "none",
		retentionReasons: [{ reason: "owner_host_binding", count: 1 }],
	},
	model: { provider: "provider", modelId: "model" },
	thinking: "high",
	compacting: false,
	queuedInputCount: 0,
} as const;
const childStatus = {
	...ownerStatus,
	agentId: "child",
	label: "Child",
	directSpawnerAgentId: "owner",
	primaryEvidence: {
		transcriptPath: "/sessions/child.jsonl",
		inspectedThrough: { agentId: "child", entryId: "child-entry" },
	},
	run: {
		phase: "live",
		work: "settled",
		attention: "none",
		retentionReasons: [{ reason: "interactive_selection", count: 1 }],
	},
} as const;
const report = {
	reportId: "report-1", createdAt: "2026-01-01T00:00:00.000Z",
	reporter: { agentId: "moderator", label: "Moderator" },
	source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/sessions/moderator.jsonl" },
	symptom: "Delivery stopped", suspectedDefect: "Continuation absent", uncertainty: "Cause unknown",
	recoveryActions: "Retried delivery", recoveryOutcome: "Still blocked", evidence: ["agent/entry/call"],
};

function rosterSnapshot(overrides: Partial<RemoteAgentSelectorSnapshot> = {}): RemoteAgentSelectorSnapshot {
	return {
		live: [ownerStatus, childStatus],
		dormant: [],
		selectedAgentId: "child",
		humanAttention: [],
		operationalAttention: [],
		reports: [],
		...overrides,
	};
}

type Prepared = Readonly<{ action: AgentSelectionAction }>;

/** A scripted adapter that records every navigation request in order. */
function scriptedAdapter(options: {
	snapshot?: () => Promise<RemoteAgentSelectorSnapshot>;
	prepare?: (action: AgentSelectionAction) => Promise<void>;
	present?: (action: AgentSelectionAction) => AgentsNavigationNext;
	addChangeHandler?: AgentsNavigationAdapter<Prepared>["addChangeHandler"];
} = {}): AgentsNavigationAdapter<Prepared> & { events: string[] } {
	const events: string[] = [];
	return {
		events,
		snapshot: options.snapshot ?? (async () => rosterSnapshot()),
		addChangeHandler: options.addChangeHandler ?? (() => () => undefined),
		async setReportRead(reportId, read) {
			events.push(`read ${reportId} ${read}`);
		},
		async prepare(action) {
			events.push(`prepare ${action.agentId}`);
			await options.prepare?.(action);
			return { action };
		},
		async present({ action }) {
			events.push(`present ${action.agentId}`);
			return options.present?.(action) ?? "done";
		},
	};
}

type SurfaceStep = (component: Component, surfaceNumber: number) => void | Promise<void>;

/** Drive each opened surface through one scripted step; extra surfaces fail the test. */
function scriptedUi(steps: readonly SurfaceStep[], tui = { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI): ExtensionUIContext & {
	notifications: string[];
	surfaces(): number;
} {
	let surfaces = 0;
	const notifications: string[] = [];
	return {
		notifications,
		surfaces: () => surfaces,
		custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
			const surfaceNumber = ++surfaces;
			return new Promise<T>((resolve, reject) => {
				const component: Component & { dispose?(): void } = factory(tui, {
					fg: (_color: string, text: string) => text,
					bg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				} as Theme, {} as KeybindingsManager, (value) => { component.dispose?.(); resolve(value); });
				const step = steps[surfaceNumber - 1];
				if (!step) {
					reject(new Error(`unexpected surface ${surfaceNumber}`));
					return;
				}
				void Promise.resolve(step(component, surfaceNumber)).catch(reject);
			});
		},
		notify(message: string) { notifications.push(message); },
	} as unknown as ExtensionUIContext & { notifications: string[]; surfaces(): number };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const selectOwner: SurfaceStep = (selector) => selector.handleInput?.("o");
const cancel: SurfaceStep = (surface) => surface.handleInput?.("\x1b");

test("a presented selection ending with agents reopens the selector", { timeout: 5_000 }, async () => {
	let presented = 0;
	const adapter = scriptedAdapter({ present: () => ++presented === 1 ? "reopen_selector" : "done" });
	const ui = scriptedUi([selectOwner, selectOwner]);

	await navigateAgents(ui, adapter, "selector");

	assert.deepEqual(adapter.events, ["prepare owner", "present owner", "prepare owner", "present owner"]);
	assert.equal(ui.surfaces(), 2);
});

test("a presented selection that ends any other way ends the command", { timeout: 5_000 }, async () => {
	const adapter = scriptedAdapter({ present: () => "done" });
	const ui = scriptedUi([selectOwner]);

	await navigateAgents(ui, adapter, "selector");

	assert.deepEqual(adapter.events, ["prepare owner", "present owner"]);
	assert.equal(ui.surfaces(), 1);
});

test("cancelling the selector ends without preparing or presenting", { timeout: 5_000 }, async () => {
	const adapter = scriptedAdapter();
	const ui = scriptedUi([cancel]);

	await navigateAgents(ui, adapter, "selector");

	assert.deepEqual(adapter.events, []);
});

test("closing a Report reopens the selector without selecting its reporter", { timeout: 5_000 }, async () => {
	const adapter = scriptedAdapter({ snapshot: async () => rosterSnapshot({ reports: [{ report }] }) });
	const openReport: SurfaceStep = (selector) => selector.handleInput?.("\r");
	const ui = scriptedUi([openReport, (reportSurface) => reportSurface.handleInput?.("q"), cancel]);

	await navigateAgents(ui, adapter, "selector");

	assert.deepEqual(adapter.events, []);
	assert.equal(ui.surfaces(), 3);
});

test("View reporter prepares the reporter, then presents it after the Report closes", { timeout: 5_000 }, async () => {
	const adapter = scriptedAdapter({ snapshot: async () => rosterSnapshot({ reports: [{ report }] }) });
	const ui = scriptedUi([
		(selector) => selector.handleInput?.("\r"),
		(reportSurface) => {
			assert.match(reportSurface.render(100).join("\n"), /moderator/);
			reportSurface.handleInput?.("v");
		},
	]);

	await navigateAgents(ui, adapter, "selector");

	assert.deepEqual(adapter.events, ["prepare moderator", "present moderator"]);
	assert.equal(ui.surfaces(), 2);
});

test("a failed preparation keeps the selector open with the error", { timeout: 5_000 }, async () => {
	let attempts = 0;
	const adapter = scriptedAdapter({
		prepare: async () => {
			if (++attempts === 1) throw new Error("Runtime unavailable");
		},
	});
	const ui = scriptedUi([async (selector) => {
		selector.handleInput?.("o");
		await settle();
		assert.deepEqual(ui.notifications, ["Agent view failed: Runtime unavailable"]);
		selector.handleInput?.("o");
	}]);

	await navigateAgents(ui, adapter, "selector");

	assert.deepEqual(adapter.events, ["prepare owner", "prepare owner", "present owner"]);
	assert.equal(ui.surfaces(), 1);
});

test("/agents owner selects a Dormant Owner without opening the selector", { timeout: 5_000 }, async () => {
	const adapter = scriptedAdapter({
		snapshot: async () => rosterSnapshot({
			live: [childStatus],
			dormant: [{ ...ownerStatus, run: { phase: "dormant", retentionReasons: [] } }],
		}),
	});
	const ui = scriptedUi([]);

	await navigateAgents(ui, adapter, "owner");

	assert.deepEqual(adapter.events, ["prepare owner", "present owner"]);
	assert.equal(ui.surfaces(), 0);
});

test("/agents owner fails when the roster has no Owner", { timeout: 5_000 }, async () => {
	const adapter = scriptedAdapter({ snapshot: async () => rosterSnapshot({ live: [childStatus] }) });

	await assert.rejects(navigateAgents(scriptedUi([]), adapter, "owner"), /roster has no Owner/);
	assert.deepEqual(adapter.events, []);
});

test("a change delivered during the first snapshot wins over its result", { timeout: 5_000 }, async () => {
	const initial = rosterSnapshot({ live: [ownerStatus, { ...childStatus, compacting: true }] });
	const completed = rosterSnapshot();
	let publish: ((snapshot: RemoteAgentSelectorSnapshot) => void) | undefined;
	let removed = false;
	const adapter = scriptedAdapter({
		async snapshot() {
			// The change arrives while the older snapshot request is still pending.
			await Promise.resolve();
			publish?.(completed);
			return initial;
		},
		addChangeHandler(handler) {
			publish = handler;
			return () => { removed = true; publish = undefined; };
		},
	});
	const ui = scriptedUi([(selector) => {
		assert.doesNotMatch(selector.render(80).join("\n"), /compacting/);
		publish?.(initial);
		assert.match(selector.render(80).join("\n"), /→ Child.*compacting/);
		selector.handleInput?.("\x1b");
	}]);

	await navigateAgents(ui, adapter, "selector");

	assert.equal(removed, true);
});

test("the change subscription is released when the snapshot fails", { timeout: 5_000 }, async () => {
	let subscribed = false;
	let removed = false;
	const adapter = scriptedAdapter({
		async snapshot() {
			assert.equal(subscribed, true);
			throw new Error("snapshot failed");
		},
		addChangeHandler() {
			subscribed = true;
			return () => { removed = true; };
		},
	});

	await assert.rejects(navigateAgents(scriptedUi([]), adapter, "selector"), /snapshot failed/);
	assert.equal(removed, true);
});

/** An Owner-session view with the child mounted; only selection behaviour varies. */
function localView(overrides: Partial<HumanPresentationCoordinatorView> = {}): HumanPresentationCoordinatorView {
	return {
		status: () => childStatus,
		selectionRoster: () => ({ live: [ownerStatus, childStatus], dormant: [], quarantined: [], quarantinedCandidateCount: 0 }),
		humanAttention: () => [],
		operationalAttention: () => [],
		reportHistory: () => [],
		setReportRead: () => undefined,
		addAgentActivityChangeHandler: () => () => undefined,
		openAgentPresentation: async () => ({ kind: "selected" }),
		focusHumanAnswer: async () => undefined,
		bindPhysicalAgentSurface: () => () => undefined,
		...overrides,
	} as unknown as HumanPresentationCoordinatorView;
}

// Adapter contract: the same scenarios hold for the Owner session's local view
// and for a child reaching the Owner over Control.

type ContractWorld = Readonly<{
	reports(): RemoteAgentSelectorSnapshot["reports"];
	setRead(reportId: string, read: boolean): void;
	select(agentId: string): Promise<void>;
}>;

const ADAPTER_KINDS = ["local", "control"] as const;

/** Run `/agents` selector navigation over the named adapter. */
function contractNavigation(kind: typeof ADAPTER_KINDS[number], world: ContractWorld, ui: ExtensionUIContext): () => Promise<void> {
	if (kind === "control") {
		const adapter = createControlAgentsNavigation({
			snapshot: async () => rosterSnapshot({ reports: world.reports() }),
			setReportRead: async (reportId, read) => world.setRead(reportId, read),
			async select(action) {
				assert.equal(action.kind, "select_agent");
				await world.select((action as { agentId: string }).agentId);
				return { kind: "selected" };
			},
			addChangeHandler: () => () => undefined,
		});
		return () => navigateAgents(ui, adapter, "selector");
	}
	const view = localView({
		reportHistory: () => world.reports(),
		setReportRead: (reportId, read) => world.setRead(reportId, read),
		async openAgentPresentation(agentId) {
			await world.select(agentId);
			return { kind: "selected" };
		},
	});
	const adapter = createLocalAgentsNavigation(view, { ui, shutdown() {} });
	return () => navigateAgents(ui, adapter, "selector");
}

for (const kind of ADAPTER_KINDS) {
	test(`${kind}: a Report opens read-only before View reporter explicitly selects the stable reporter`, { timeout: 5_000 }, async () => {
		const selected: string[] = [];
		let read = false;
		const ui = scriptedUi([
			(selector) => {
				assert.match(selector.render(100).join("\n"), /REPORT/);
				selector.handleInput?.("\r");
			},
			(reportSurface) => {
				assert.deepEqual(selected, []);
				assert.match(reportSurface.render(100).join("\n"), /moderator/);
				reportSurface.handleInput?.("v");
			},
		]);
		const navigate = contractNavigation(kind, {
			reports: () => [{ report }],
			setRead: () => { read = true; },
			select: async (agentId) => { selected.push(agentId); },
		}, ui);

		await navigate();

		assert.deepEqual(selected, ["moderator"]);
		assert.equal(read, false);
		assert.equal(ui.surfaces(), 2);
		assert.deepEqual(ui.notifications, []);
	});

	test(`${kind}: View reporter keeps the focused Report through delayed preparation and failure`, { timeout: 5_000 }, async () => {
		let rejectFirst!: (error: Error) => void;
		let finishRetry!: () => void;
		const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
		const retry = new Promise<void>((resolve) => { finishRetry = resolve; });
		let attempts = 0;
		let reads = 0;
		let reportSurface: Component | undefined;
		const ui = scriptedUi([
			(selector) => selector.handleInput?.("\r"),
			(surface) => { reportSurface = surface; },
		]);
		const navigate = contractNavigation(kind, {
			reports: () => [{ report }],
			setRead: () => { reads++; },
			async select(agentId) {
				assert.equal(agentId, "moderator");
				await (++attempts === 1 ? first : retry);
			},
		}, ui);

		const completed = navigate();
		await settle();
		assert.ok(reportSurface);
		reportSurface.handleInput?.("v");
		await settle();
		assert.equal(attempts, 1);
		assert.match(reportSurface.render(120).join("\n"), /Opening reporter/);
		for (const key of ["v", "\x1b", "q", "m", "c", "typed input", "\r"]) reportSurface.handleInput?.(key);
		assert.equal(attempts, 1);
		assert.equal(reads, 0);
		rejectFirst(new Error("Reporter preparation failed"));
		await settle();
		assert.match(reportSurface.render(120).join("\n"), /Reporter preparation failed/);
		assert.match(reportSurface.render(120).join("\n"), /Unread/);
		reportSurface.handleInput?.("v");
		await settle();
		assert.equal(attempts, 2);
		finishRetry();
		await completed;
		assert.equal(reads, 0);
		assert.equal(ui.surfaces(), 2);
	});

	test(`${kind}: Report read state toggles in place across inbox, history, and detail`, { timeout: 5_000 }, async () => {
		const selected: string[] = [];
		let acknowledged = false;
		const ui = scriptedUi([
			async (selector) => {
				assert.match(selector.render(100).join("\n"), /REPORT/);
				selector.handleInput?.("m");
				await settle();
				assert.equal(acknowledged, true);
				assert.doesNotMatch(selector.render(100).join("\n"), /REPORT/);
				selector.handleInput?.("\x1b[Z");
				assert.match(selector.render(100).join("\n"), /m Toggle read/);
				selector.handleInput?.("m");
				await settle();
				assert.equal(acknowledged, false);
				assert.match(selector.render(100).join("\n"), /m Toggle read/);
				selector.handleInput?.("\t");
				assert.match(selector.render(100).join("\n"), /REPORT/);
				selector.handleInput?.("\x1b[Z");
				selector.handleInput?.("\r");
			},
			async (reportSurface) => {
				assert.deepEqual(selected, []);
				assert.match(reportSurface.render(100).join("\n"), /· Unread/);
				reportSurface.handleInput?.("m");
				await settle();
				assert.equal(acknowledged, true);
				reportSurface.handleInput?.("v");
			},
		]);
		const navigate = contractNavigation(kind, {
			reports: () => [{ report, ...(acknowledged ? { readAt: "2026-01-02T00:00:00Z" } : {}) }],
			setRead: (_reportId, read) => { acknowledged = read; },
			select: async (agentId) => { selected.push(agentId); },
		}, ui);

		await navigate();

		assert.deepEqual(selected, ["moderator"]);
		assert.equal(acknowledged, true);
		assert.equal(ui.surfaces(), 2);
	});
}

// Local adapter: the Owner session hosts every surface itself.

test("local: selecting an Agent starts and binds its physical attachment before the selector closes", { timeout: 5_000 }, async () => {
	const projection = createProjectionHarness("target");
	const targetView = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();
	const bound: PhysicalAgentViewSurface[] = [];
	let selectorClosed = false;
	const ui = scriptedUi([async (selector) => {
		selector.handleInput?.("o");
		await settle();
		assert.equal(surface.physicalStarts(), 1);
		assert.equal(bound.length, 1);
		assert.equal(selectorClosed, false);
	}], surface.ownerTui);
	const adapter = createLocalAgentsNavigation(localView({
		openAgentPresentation: async () => ({ kind: "selected", view: targetView.view }),
		bindPhysicalAgentSurface(physical) {
			bound.push(physical);
			return () => undefined;
		},
	}), { ui, shutdown() {} }, surface.physicalTerminal);

	await navigateAgents(ui, adapter, "selector");
	selectorClosed = true;

	assert.equal(ui.surfaces(), 1, "the physical attachment replaces the selector without another surface");
	assert.deepEqual(projection.attachedStates(), [true]);
	await targetView.closeFromHost();
	await bound[0]!.closed;
});

test("local: without physical attachment support the selected Agent opens in the fallback view", { timeout: 5_000 }, async () => {
	const targetView = createViewHarness(createProjectionHarness("fallback-target").projection);
	const surface = createSurfaceHarness({ supportsPhysicalAttachment: false });
	const ui = scriptedUi([
		selectOwner,
		async (agentView) => {
			assert.match(agentView.render(80).join("\n"), /fallback-target/);
			await targetView.closeFromHost();
		},
	]);
	const adapter = createLocalAgentsNavigation(localView({
		openAgentPresentation: async () => ({ kind: "selected", view: targetView.view }),
	}), { ui, shutdown() {} }, surface.physicalTerminal);

	await navigateAgents(ui, adapter, "selector");

	assert.equal(ui.surfaces(), 2);
	assert.equal(surface.physicalStarts(), 0);
});

test("local: a DECIDE whose focus fails restores the previous selection and keeps the selector open", { timeout: 5_000 }, async () => {
	const opened: string[] = [];
	const ui = scriptedUi([async (selector) => {
		assert.match(selector.render(100).join("\n"), /DECIDE/);
		selector.handleInput?.("\r");
		await settle();
		assert.deepEqual(ui.notifications, ["Agent view failed: focus failed"]);
		selector.handleInput?.("\x1b");
	}]);
	const adapter = createLocalAgentsNavigation(localView({
		humanAttention: () => [{ requestId: "request", agentId: "owner", agentLabel: "Owner", question: "Proceed?" }],
		async openAgentPresentation(agentId) {
			opened.push(agentId);
			return { kind: "selected" };
		},
		focusHumanAnswer: async () => { throw new Error("focus failed"); },
	}), { ui, shutdown() {} });

	await navigateAgents(ui, adapter, "selector");

	assert.deepEqual(opened, ["owner", "child"]);
	assert.equal(ui.surfaces(), 1);
});
