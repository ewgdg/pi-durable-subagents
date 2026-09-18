import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";

import type { Component, TUI } from "@earendil-works/pi-tui";
import type { RemoteAgentSelectorSnapshot } from "../src/control/agent-control-protocol.ts";

import type { HumanPresentationCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import { registerAgentsCommand } from "../src/tools/owner-surfaces.ts";
import {
	createAgentSelectionSession,
	createAgentSelectorSnapshot,
	createOwnerAgentPresentationHandlers,
	registerRemoteAgentsCommand,
} from "../src/process-runtime/remote-agent-selector.ts";
import type { PostMortemAgentView } from "../src/presentation/post-mortem-agent-view-surface.ts";

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
	workflowId: "owner",
	label: "Child",
	directSpawnerAgentId: "owner",
	primaryEvidence: {
		transcriptPath: "/sessions/child.jsonl",
		inspectedThrough: { agentId: "child", entryId: "child-entry" },
	},
	run: {
		phase: "live",
		work: "settled",
		attention: "input_required",
		retentionReasons: [{ reason: "interactive_selection", count: 1 }],
	},
} as const;

function presentationView(options: {
	refreshTranscriptFacts?: HumanPresentationCoordinatorView["refreshTranscriptFacts"];
	status?: HumanPresentationCoordinatorView["status"];
	humanAttention?: () => readonly Readonly<{
		requestId: string;
		agentId: string;
		agentLabel: string;
		question: string;
	}>[];
	openAgentView?: (agentId: string) => Promise<undefined>;
	openAgentPresentation?: HumanPresentationCoordinatorView["openAgentPresentation"];
	focusHumanAnswer?: (agentId: string, requestId: string) => Promise<void>;
} = {}): HumanPresentationCoordinatorView {
	return {
		refreshTranscriptFacts: options.refreshTranscriptFacts ?? (async () => undefined),
		status: options.status ?? (() => childStatus),
		selectionRoster: () => ({ live: [ownerStatus, childStatus], dormant: [] }),
		humanAttention: options.humanAttention ?? (() => []),
		operationalAttention: () => [],
		reportHistory: () => [],
		setReportRead: () => {},
		openAgentView: options.openAgentView ?? (async () => undefined),
		openAgentPresentation: options.openAgentPresentation ?? (async (agentId) => ({
			kind: "selected",
			view: await (options.openAgentView ?? (async () => undefined))(agentId),
		})),
		focusHumanAnswer: options.focusHumanAnswer ?? (async () => undefined),
		bindPhysicalAgentSurface: () => () => undefined,
	} as unknown as HumanPresentationCoordinatorView;
}

test("selector snapshot is one exact scoped presentation boundary value", () => {
	const attention = [{
		requestId: "request",
		agentId: "child",
		agentLabel: "Child",
		question: "Which path?",
	}] as const;
	const snapshot = createAgentSelectorSnapshot(presentationView({
		humanAttention: () => attention,
	}), "child");

	assert.deepEqual(snapshot, {
		live: [ownerStatus, childStatus],
		dormant: [],
		selectedAgentId: "child",
		humanAttention: attention,
		operationalAttention: [], reports: [],
	});
});

test("local registered /agents owner returns through the authoritative selection path without transcript refresh", async () => {
	const opened: string[] = [];
	const view = presentationView({
		refreshTranscriptFacts: async () => { throw new Error("transcript refresh unavailable"); },
		openAgentPresentation: async (agentId) => {
			opened.push(agentId);
			return { kind: "selected" };
		},
	});
	const command = captureCommand((pi) => registerAgentsCommand(pi, () => view));
	const ui = {
		custom: () => {
			throw new Error("selector must not open for /agents owner");
		},
	};

	assert.deepEqual(command.getArgumentCompletions?.(""), [{ value: "owner", label: "owner" }]);
	assert.deepEqual(command.getArgumentCompletions?.("o"), [{ value: "owner", label: "owner" }]);
	assert.deepEqual(command.getArgumentCompletions?.("x"), null);
	await command.handler("  owner  ", { ui } as unknown as ExtensionCommandContext);

	const ownerView = presentationView({
		status: () => ownerStatus,
		openAgentPresentation: async (agentId) => {
			opened.push(agentId);
			return { kind: "selected" };
		},
	});
	const ownerCommand = captureCommand((pi) => registerAgentsCommand(pi, () => ownerView));
	await ownerCommand.handler("owner", { ui } as unknown as ExtensionCommandContext);

	assert.deepEqual(opened, ["owner"]);
});

test("remote presentation navigates existing Owner and Moderator identities without transcript refresh", async () => {
	const opened: string[] = [];
	const moderatorStatus = { ...childStatus, agentId: "moderator", label: "Moderator" };
	const view = { ...presentationView({
		refreshTranscriptFacts: async () => { throw new Error("transcript refresh unavailable"); },
		openAgentPresentation: async (agentId) => {
			opened.push(agentId);
			return { kind: "selected" };
		},
	}), selectionRoster: () => ({ live: [ownerStatus, moderatorStatus], dormant: [] }) };
	const presentation = createOwnerAgentPresentationHandlers(() => view, "moderator");
	const snapshot = await presentation.snapshot();
	assert.deepEqual(snapshot.live.map(({ agentId }) => agentId), ["owner", "moderator"]);
	assert.deepEqual(opened, []);
	await presentation.select({ kind: "select_agent", agentId: "owner" }, new AbortController().signal);
	const ownerPresentation = createOwnerAgentPresentationHandlers(() => view, "owner");
	await ownerPresentation.select({ kind: "select_agent", agentId: "moderator" }, new AbortController().signal);
	assert.deepEqual(opened, ["owner", "moderator"]);
});

test("remote registered /agents owner selects Owner without opening the selector", async () => {
	const actions: unknown[] = [];
	let snapshotCalls = 0;
	const presentation = {
		async setReportRead() {},
		async snapshot() {
			snapshotCalls += 1;
			return {
				live: [ownerStatus, childStatus],
				dormant: [],
				selectedAgentId: "child",
				humanAttention: [],
				operationalAttention: [], reports: [],
			};
		},
		async select(action: unknown) {
			actions.push(action);
			return { kind: "selected" as const };
		},
	};
	const command = captureCommand((pi) => registerRemoteAgentsCommand(pi, presentation));
	const ui = {
		custom: () => {
			throw new Error("selector must not open for /agents owner");
		},
	};

	await command.handler(" owner ", { ui } as unknown as ExtensionCommandContext);

	assert.equal(snapshotCalls, 1);
	assert.deepEqual(actions, [{ kind: "select_agent", agentId: "owner" }]);
});

test("remote registered /agents owner selects a Dormant Owner instead of failing", async () => {
	const actions: unknown[] = [];
	const command = captureCommand((pi) => registerRemoteAgentsCommand(pi, {
		async setReportRead() {},
		async snapshot() {
			return {
				live: [],
				dormant: [{ ...ownerStatus, run: { phase: "dormant", retentionReasons: [] } }],
				selectedAgentId: "child",
				humanAttention: [],
				operationalAttention: [], reports: [],
			};
		},
		async select(action: unknown) {
			actions.push(action);
			return { kind: "selected" as const };
		},
	}));
	const ui = {
		custom: () => {
			throw new Error("selector must not open for /agents owner");
		},
	};

	await command.handler("owner", { ui } as unknown as ExtensionCommandContext);

	assert.deepEqual(actions, [{ kind: "select_agent", agentId: "owner" }]);
});

test("registered /agents rejects unsupported arguments before opening or selecting", async () => {
	const localOpened: string[] = [];
	const localView = presentationView({
		openAgentPresentation: async (agentId) => {
			localOpened.push(agentId);
			return { kind: "selected" };
		},
	});
	const localCommand = captureCommand((pi) => registerAgentsCommand(pi, () => localView));
	await assert.rejects(
		localCommand.handler(" teammate ", {} as ExtensionCommandContext),
		(error: unknown) => error instanceof Error && error.message === "Usage: /agents [owner]",
	);
	assert.deepEqual(localOpened, []);

	let remoteSnapshotCalls = 0;
	const remoteCommand = captureCommand((pi) => registerRemoteAgentsCommand(pi, {
		async setReportRead() {},
		async snapshot() {
			remoteSnapshotCalls += 1;
			return {
				live: [ownerStatus, childStatus],
				dormant: [],
				selectedAgentId: "child",
				humanAttention: [],
				operationalAttention: [], reports: [],
			};
		},
		async select() {
			return { kind: "selected" as const };
		},
	}));
	await assert.rejects(
		remoteCommand.handler(" teammate ", {} as ExtensionCommandContext),
		(error: unknown) => error instanceof Error && error.message === "Usage: /agents [owner]",
	);
	assert.equal(remoteSnapshotCalls, 0);
});

test("stale Human Attention after view preparation restores the previous child", async () => {
	let pending = true;
	const opened: string[] = [];
	const session = createAgentSelectionSession(presentationView({
		humanAttention: () => pending ? [{
			requestId: "request",
			agentId: "target",
			agentLabel: "Target",
			question: "Proceed?",
		}] : [],
		openAgentView: async (agentId) => {
			opened.push(agentId);
			pending = false;
			return undefined;
		},
	}), "child");

	await assert.rejects(
		session.prepare({ kind: "decide", requestId: "request", agentId: "target" }),
		/stale_request/,
	);
	assert.deepEqual(opened, ["target", "child"]);
});

test("Human Answer focus failure restores the exact previous selection", async () => {
	const opened: string[] = [];
	const view = presentationView({
		humanAttention: () => [{
			requestId: "request",
			agentId: "target",
			agentLabel: "Target",
			question: "Proceed?",
		}],
		openAgentView: async (agentId) => {
			opened.push(agentId);
			return undefined;
		},
		focusHumanAnswer: async () => {
			throw new Error("focus failed");
		},
	});
	const session = createAgentSelectionSession(view, "child");
	const action = { kind: "decide", requestId: "request", agentId: "target" } as const;
	await session.prepare(action);

	await assert.rejects(session.complete(action), /focus failed/);
	assert.deepEqual(opened, ["target", "child"]);
});

test("failed Dormant preparation returns a post-mortem selection without replacing the previous Agent", async () => {
	const opened: string[] = [];
	const presented: PostMortemAgentView[] = [];
	const view = presentationView({
		openAgentPresentation: async (agentId) => {
			opened.push(agentId);
			return {
				kind: "post_mortem",
				agentId,
				label: "Failed Agent",
				transcript: {
					sessionId: agentId,
					transcriptPath: `/sessions/${agentId}.jsonl`,
					header: null,
					entries: [],
					activeBranch: [],
					context: { messages: [], thinkingLevel: "off" as const, model: null },
				},
				preparationError: "Configured model is unavailable",
			};
		},
	});
	const handlers = createOwnerAgentPresentationHandlers(() => view, "child", {
		bindPhysicalSurface: () => () => undefined,
		async present(postMortem) {
			presented.push(postMortem);
			return "back";
		},
	});

	assert.deepEqual(
		await handlers.select(
			{ kind: "select_agent", agentId: "target" },
			new AbortController().signal,
		),
		{
			kind: "post_mortem",
			agentId: "target",
			label: "Failed Agent",
			preparationError: "Configured model is unavailable",
			outcome: "back",
		},
	);
	assert.deepEqual(opened, ["target"]);
	assert.equal(presented.length, 1);
	assert.equal(presented[0]?.transcript.transcriptPath, "/sessions/target.jsonl");
});

test("post-mortem agents outcome propagates without transcript contents", async () => {
	const view = presentationView({
		openAgentPresentation: async (agentId) => ({
			kind: "post_mortem",
			agentId,
			label: "Failed Agent",
			transcript: {
				sessionId: agentId,
				transcriptPath: `/sessions/${agentId}.jsonl`,
				header: null,
				entries: [],
				activeBranch: [],
				context: { messages: [], thinkingLevel: "off", model: null },
			},
			preparationError: "Unavailable",
		}),
	});
	const handlers = createOwnerAgentPresentationHandlers(() => view, "child", {
		bindPhysicalSurface: () => () => undefined,
		async present() { return "agents"; },
	});

	assert.deepEqual(await handlers.select(
		{ kind: "select_agent", agentId: "target" },
		new AbortController().signal,
	), {
		kind: "post_mortem",
		agentId: "target",
		label: "Failed Agent",
		preparationError: "Unavailable",
		outcome: "agents",
	});
});

test("selecting the already-mounted participant closes without reopening its view", async () => {
	let opens = 0;
	const session = createAgentSelectionSession(presentationView({
		openAgentPresentation: async () => {
			opens += 1;
			throw new Error("already-mounted participant was reopened");
		},
	}), "target");

	const action = { kind: "select_agent", agentId: "target" } as const;
	await session.prepare(action);
	await session.complete(action);

	assert.equal(opens, 0);
});

test("deciding on the already-mounted participant still focuses its Human Request", async () => {
	let opens = 0;
	let focused: readonly [string, string] | undefined;
	const view = presentationView({
		humanAttention: () => [{
			requestId: "request",
			agentId: "target",
			agentLabel: "Target",
			question: "Proceed?",
		}],
		openAgentPresentation: async () => {
			opens += 1;
			return { kind: "selected" };
		},
		focusHumanAnswer: async (agentId, requestId) => {
			focused = [agentId, requestId];
		},
	});
	const session = createAgentSelectionSession(view, "target");
	const action = { kind: "decide", requestId: "request", agentId: "target" } as const;

	await session.prepare(action);
	await session.complete(action);

	assert.equal(opens, 1);
	assert.deepEqual(focused, ["target", "request"]);
});

test("a successful Dormant selection acquires its Runtime exactly once", async () => {
	let acquisitions = 0;
	const session = createAgentSelectionSession(presentationView({
		openAgentPresentation: async () => {
			acquisitions += 1;
			return { kind: "selected" };
		},
	}), "child");

	await session.prepare({ kind: "select_agent", agentId: "target" });
	assert.equal(acquisitions, 1);
});

test("Owner selection handler is awaited and does not resurrect the previous child after Control cancellation", async () => {
	let finishPreparation!: () => void;
	const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
	const opened: string[] = [];
	const view = presentationView({
		openAgentView: async (agentId) => {
			opened.push(agentId);
			if (agentId === "target") await preparation;
			return undefined;
		},
	});
	const handlers = createOwnerAgentPresentationHandlers(() => view, "child");
	const cancellation = new AbortController();
	const pending = handlers.select(
		{ kind: "select_agent", agentId: "target" },
		cancellation.signal,
	);
	cancellation.abort();
	finishPreparation();

	await assert.rejects(pending, (error: unknown) =>
		error instanceof Error && error.name === "AbortError"
	);
	assert.deepEqual(opened, ["target"]);
});

type CapturedCommand = Readonly<{
	getArgumentCompletions?: (argumentPrefix: string) => unknown;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}>;

function captureCommand(register: (pi: ExtensionAPI) => void): CapturedCommand {
	let command: CapturedCommand | undefined;
	const pi = {
		registerCommand(_name: string, options: CapturedCommand) {
			command = options;
		},
	} as unknown as ExtensionAPI;
	register(pi);
	assert.ok(command);
	return command;
}

test("remote selector uses completion delivered during snapshot acquisition, not the stale RPC result", { timeout: 5_000 }, async () => {
	const initial = {
		live: [ownerStatus, { ...childStatus, compacting: true }],
		dormant: [], selectedAgentId: "child", humanAttention: [], operationalAttention: [], reports: [],
	};
	const completed = {
		...initial,
		live: [ownerStatus, { ...childStatus, compacting: false }],
	};
	let publish: ((snapshot: RemoteAgentSelectorSnapshot) => void) | undefined;
	let removed = false;
	const command = captureCommand((pi) => registerRemoteAgentsCommand(pi, {
		async setReportRead() {},
		async snapshot() {
			// The child receives completion while the older Owner RPC is still pending.
			await Promise.resolve();
			publish?.(completed);
			return initial;
		},
		addChangeHandler(handler) {
			publish = handler;
			return () => { removed = true; publish = undefined; };
		},
		async select() { return { kind: "selected" }; },
	}));
	const ui = {
		custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
			return new Promise<T>((resolve) => {
				const component = factory({
					terminal: { rows: 24 }, requestRender() {},
				} as TUI, {
					fg: (_color: string, text: string) => text,
					bg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				} as Theme, {} as KeybindingsManager, resolve);
				try {
					assert.doesNotMatch(component.render(80).join("\n"), /compacting/);
					assert.match(component.render(80).join("\n"), /→ Child.*waiting/);
					publish?.(initial);
					assert.match(component.render(80).join("\n"), /→ Child.*compacting/);
					component.handleInput?.("\x1b");
				} finally {
					(component as Component & { dispose(): void }).dispose();
				}
			});
		},
	} as ExtensionUIContext;
	await command.handler("", { ui } as ExtensionCommandContext);
	assert.equal(removed, true);
});

test("remote selector releases its subscription when snapshot acquisition fails", async () => {
	let subscribed = false;
	let removed = false;
	const command = captureCommand((pi) => registerRemoteAgentsCommand(pi, {
		async setReportRead() {},
		async snapshot() {
			assert.equal(subscribed, true);
			throw new Error("snapshot failed");
		},
		addChangeHandler() {
			subscribed = true;
			return () => { removed = true; };
		},
		async select() { return { kind: "selected" }; },
	}));
	await assert.rejects(command.handler("", {} as ExtensionCommandContext), /snapshot failed/);
	assert.equal(removed, true);
});

test("local and child /agents open immutable reports before explicitly selecting the stable reporter", { timeout: 5_000 }, async () => {
	const report = {
		reportId: "report-1", createdAt: "2026-01-01T00:00:00.000Z",
		reporter: { agentId: "original-moderator", label: "Moderator" },
		source: { agentId: "original-moderator", entryId: "original-entry", toolCallId: "original-call", transcriptPath: "/sessions/original.jsonl" },
		symptom: "Delivery stopped", suspectedDefect: "Continuation absent", uncertainty: "Cause unknown",
		recoveryActions: "Retried delivery", recoveryOutcome: "Still blocked", evidence: ["agent/entry/call"],
	};
	for (const mode of ["local", "child"] as const) {
		const selected: unknown[] = [];
		let acknowledged = false;
		const snapshot = {
			live: [ownerStatus, childStatus], dormant: [], selectedAgentId: "child",
			humanAttention: [], operationalAttention: [], reports: [{ report }],
		};
		const command = mode === "local"
			? captureCommand((pi) => registerAgentsCommand(pi, () => ({
				...presentationView(),
				refreshTranscriptFacts: async () => { throw new Error("transcript refresh unavailable"); },
				reportHistory: () => [{ report }],
				setReportRead: () => { acknowledged = true; },
				addAgentActivityChangeHandler: () => () => {},
				openAgentPresentation: async (agentId) => {
					selected.push({ kind: "select_agent", agentId });
					return { kind: "selected" };
				},
			})))
			: captureCommand((pi) => registerRemoteAgentsCommand(pi, {
				snapshot: async () => snapshot,
				setReportRead: async () => { acknowledged = true; },
				select: async (action) => { selected.push(action); return { kind: "selected" }; },
			}));
		let surfaces = 0;
		const ui = {
			custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
				return new Promise<T>((resolve) => {
					let component: Component & { dispose?(): void };
					component = factory({
						terminal: { rows: 40 }, requestRender() {},
					} as TUI, {
						fg: (_color: string, text: string) => text,
						bg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					} as Theme, {} as KeybindingsManager, (value) => { component.dispose?.(); resolve(value); });
					surfaces++;
					if (surfaces === 1) {
						assert.match(component.render(100).join("\n"), /REPORT/);
						component.handleInput?.("\r");
					} else {
						assert.equal(surfaces, 2);
						assert.deepEqual(selected, []);
						assert.match(component.render(100).join("\n"), /original-moderator/);
						component.handleInput?.("v");
					}
				});
			},
			notify(message: string) { throw new Error(message); },
		} as unknown as ExtensionUIContext;
		await command.handler("", { ui } as ExtensionCommandContext);
		assert.deepEqual(selected, [{ kind: "select_agent", agentId: "original-moderator" }], mode);
		assert.equal(acknowledged, false, mode);
		assert.equal(surfaces, 2, mode);
	}
});

test("local and child View reporter retain focused report UI through delayed preparation and failure", { timeout: 5_000 }, async (t) => {
	for (const mode of ["local", "child"] as const) {
		await t.test(mode, async () => {
			const report = {
				reportId: "report", createdAt: "2026-01-01T00:00:00.000Z",
				reporter: { agentId: "moderator", label: "Moderator" },
				source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/sessions/moderator.jsonl" },
				symptom: "Stopped", suspectedDefect: "Lost continuation", uncertainty: "Unknown cause",
				recoveryActions: "Retried", recoveryOutcome: "Blocked", evidence: ["entry"],
			};
			let rejectFirst!: (error: Error) => void;
			let finishRetry!: () => void;
			const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
			const retry = new Promise<void>((resolve) => { finishRetry = resolve; });
			let attempts = 0;
			let reads = 0;
			const prepare = async (agentId: string) => {
				assert.equal(agentId, report.reporter.agentId);
				await (++attempts === 1 ? first : retry);
				return { kind: "selected" as const };
			};
			const command = mode === "local"
				? captureCommand((pi) => registerAgentsCommand(pi, () => ({
					...presentationView(),
					reportHistory: () => [{ report }],
					setReportRead: () => { reads++; },
					addAgentActivityChangeHandler: () => () => {},
					openAgentPresentation: prepare,
				})))
				: captureCommand((pi) => registerRemoteAgentsCommand(pi, {
					snapshot: async () => ({
						live: [ownerStatus, childStatus], dormant: [], selectedAgentId: "child",
						humanAttention: [], operationalAttention: [], reports: [{ report }],
					}),
					setReportRead: async () => { reads++; },
					select: (action) => {
						assert.equal(action.kind, "select_agent");
						return prepare((action as { agentId: string }).agentId);
					},
				}));
			let reportSurface: Component | undefined;
			let surfaces = 0;
			let reportClosed = false;
			const ui = {
				custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
					const surfaceNumber = ++surfaces;
					return new Promise<T>((resolve) => {
						let component: Component & { dispose?(): void };
						component = factory({ terminal: { rows: 40 }, requestRender() {} } as TUI, {
							fg: (_color: string, text: string) => text,
							bg: (_color: string, text: string) => text, bold: (text: string) => text,
						} as Theme, {} as KeybindingsManager, (value) => {
							if (surfaceNumber === 2) reportClosed = true;
							component.dispose?.();
							resolve(value);
						});
						if (surfaceNumber === 1) component.handleInput?.("\r");
						else {
							assert.equal(surfaceNumber, 2);
							reportSurface = component;
						}
					});
				},
				notify(message: string) { throw new Error(message); },
			} as unknown as ExtensionUIContext;
			const completed = command.handler("", { ui } as ExtensionCommandContext);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(reportSurface);
			reportSurface.handleInput?.("v");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(attempts, 1);
			assert.equal(reportClosed, false, "report must keep input focus until preparation finishes");
			assert.match(reportSurface.render(120).join("\n"), /Opening reporter/);
			for (const key of ["v", "\x1b", "q", "m", "c", "typed input", "\r"]) reportSurface.handleInput?.(key);
			assert.equal(attempts, 1);
			assert.equal(reads, 0);
			assert.equal(reportClosed, false);
			rejectFirst(new Error("Reporter preparation failed"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(reportClosed, false);
			assert.match(reportSurface.render(120).join("\n"), /Reporter preparation failed/);
			assert.match(reportSurface.render(120).join("\n"), /Unread/);
			reportSurface.handleInput?.("v");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(attempts, 2);
			assert.equal(reportClosed, false);
			finishRetry();
			await completed;
			assert.equal(reportClosed, true);
			assert.equal(reads, 0);
		});
	}
});

test("local and child /agents toggle reports in place across inbox, history, and detail", { timeout: 5_000 }, async () => {
	const report = {
		reportId: "report-1", createdAt: "2026-01-01T00:00:00.000Z",
		reporter: { agentId: "original-moderator", label: "Moderator" },
		source: { agentId: "original-moderator", entryId: "original-entry", toolCallId: "original-call", transcriptPath: "/sessions/original.jsonl" },
		symptom: "Delivery stopped", suspectedDefect: "Continuation absent", uncertainty: "Cause unknown",
		recoveryActions: "Retried delivery", recoveryOutcome: "Still blocked", evidence: ["agent/entry/call"],
	};
	for (const mode of ["local", "child"] as const) {
		const selected: unknown[] = [];
		let acknowledged = false;
		const reportHistory = () => [{ report, ...(acknowledged ? { readAt: "2026-01-02T00:00:00Z" } : {}) }];
		const snapshot = {
			live: [ownerStatus, childStatus], dormant: [], selectedAgentId: "child",
			humanAttention: [], operationalAttention: [], reports: [{ report }],
		};
		const command = mode === "local"
			? captureCommand((pi) => registerAgentsCommand(pi, () => ({
				...presentationView(),
				reportHistory,
				setReportRead: (_id, read) => { acknowledged = read; },
				addAgentActivityChangeHandler: () => () => {},
				openAgentPresentation: async (agentId) => {
					selected.push({ kind: "select_agent", agentId });
					return { kind: "selected" };
				},
			})))
			: captureCommand((pi) => registerRemoteAgentsCommand(pi, {
				snapshot: async () => ({ ...snapshot, reports: reportHistory() }),
				setReportRead: async (_id, read) => { acknowledged = read; },
				select: async (action) => { selected.push(action); return { kind: "selected" }; },
			}));
		let surfaces = 0;
		const ui = {
			custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
				return new Promise<T>((resolve, reject) => {
					let component: Component & { dispose?(): void };
					component = factory({
						terminal: { rows: 40 }, requestRender() {},
					} as TUI, {
						fg: (_color: string, text: string) => text,
						bg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					} as Theme, {} as KeybindingsManager, (value) => { component.dispose?.(); resolve(value); });
					surfaces++;
					if (surfaces === 1) {
						assert.match(component.render(100).join("\n"), /REPORT/);
						void (async () => {
							component.handleInput?.("m");
							await new Promise((resolve) => setImmediate(resolve));
							assert.equal(acknowledged, true);
							assert.equal(surfaces, 1);
							assert.doesNotMatch(component.render(100).join("\n"), /REPORT/);
							component.handleInput?.("\x1b[Z");
							assert.match(component.render(100).join("\n"), /m Toggle read/);
							component.handleInput?.("m");
							await new Promise((resolve) => setImmediate(resolve));
							assert.equal(acknowledged, false);
							assert.match(component.render(100).join("\n"), /m Toggle read/);
							component.handleInput?.("\t");
							assert.match(component.render(100).join("\n"), /REPORT/);
							component.handleInput?.("\x1b[Z");
							component.handleInput?.("\r");
						})().catch(reject);
					} else {
						assert.equal(surfaces, 2);
						assert.deepEqual(selected, []);
						assert.match(component.render(100).join("\n"), /original-moderator/);
						assert.match(component.render(100).join("\n"), /· Unread/);
						void (async () => {
							component.handleInput?.("m");
							await new Promise((resolve) => setImmediate(resolve));
							assert.equal(acknowledged, true);
							assert.match(component.render(100).join("\n"), /m Toggle read/);
							component.handleInput?.("v");
						})().catch(reject);
					}
				});
			},
			notify(message: string) { throw new Error(message); },
		} as unknown as ExtensionUIContext;
		await command.handler("", { ui } as ExtensionCommandContext);
		assert.deepEqual(selected, [{ kind: "select_agent", agentId: "original-moderator" }], mode);
		assert.equal(acknowledged, true, mode);
		assert.equal(surfaces, 2, mode);
	}
});
