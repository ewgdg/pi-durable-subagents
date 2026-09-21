import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	OverlayHandle,
	TUI,
} from "@earendil-works/pi-tui";

import { PhysicalTerminalAttachment, type PhysicalTerminalPort } from "../src/presentation/physical-terminal-attachment.ts";
import type { TerminalProjection } from "../src/presentation/terminal-projection.ts";
import {
	openAgentViewSurface,
	startPhysicalAgentViewSurface,
	type DurableAgentView,
} from "../src/presentation/agent-view-surface.ts";

import { DurableAgentViewAttachment } from "../src/coordination/durable-agent-view.ts";
import { openAgentSelectorSurface } from "../src/presentation/agent-selector-surface.ts";

const AGENT_ID = "agent-view-durable-12345678";

test("selected child owns raw output, physical input, and resize until Owner restoration", async () => {
	const projection = createProjectionHarness("first");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.finishReinitialization();

	assert.deepEqual(surface.ownerStops(), [{ preserveScreen: true }]);
	assert.equal(surface.physicalStarts(), 1);
	assert.deepEqual(projection.attachedStates(), [true]);
	assert.deepEqual(projection.resizes(), [{ columns: 80, rows: 24 }]);

	projection.emitOutput("\x1b[2Jnative child frame");
	assert.deepEqual(surface.physicalWrites(), ["\x1b[2Jnative child frame"]);
	surface.emitInput("mouse-or-editor-input");
	surface.emitResize(100, 30);
	assert.deepEqual(projection.inputs(), ["mouse-or-editor-input"]);
	assert.deepEqual(projection.resizes(), [
		{ columns: 80, rows: 24 },
		{ columns: 100, rows: 30 },
	]);

	await view.closeFromHost();
	await opened;
	assert.deepEqual(projection.attachedStates(), [true, false]);
	assert.equal(surface.physicalStops(), 1);
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(surface.ownerRenderRequests(), [true]);
	assert.equal(view.cleanupCount(), 1);
});

test("a prepared physical surface becomes ready without waiting for its view to close", async () => {
	const projection = createProjectionHarness("prepared");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();

	const prepared = startPhysicalAgentViewSurface(view.view, {
		ownerTui: surface.ownerTui,
		physicalTerminal: surface.physicalTerminal,
		requestShutdown() {},
	});
	assert.ok(prepared);
	await projection.finishReinitialization();
	await prepared.ready;
	assert.equal(view.cleanupCount(), 0);
	assert.deepEqual(surface.ownerStops(), [{ preserveScreen: true }]);

	await view.closeFromHost();
	await prepared.closed;
	assert.equal(view.cleanupCount(), 1);
	assert.equal(surface.ownerStarts(), 1);
});

test("an Owner-hosted diagnostic can suspend and resume the exact selected child", async () => {
	const projection = createProjectionHarness("suspend-resume");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();
	const prepared = startPhysicalAgentViewSurface(view.view, {
		ownerTui: surface.ownerTui,
		physicalTerminal: surface.physicalTerminal,
		requestShutdown() {},
	});
	assert.ok(prepared);
	await projection.finishReinitialization();
	await prepared.ready;

	await prepared.suspend();
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(projection.attachedStates(), [true, false]);

	await prepared.resume();
	await projection.finishReinitialization();
	assert.deepEqual(surface.ownerStops(), [
		{ preserveScreen: true },
		{ preserveScreen: true },
	]);
	assert.deepEqual(projection.attachedStates(), [true, false, true]);

	prepared.close();
	await prepared.closed;
});

test("handoff keeps the Owner visible and ignores loading-time input until presentation reinitializes", async () => {
	const projection = createProjectionHarness("buffered", undefined, true);
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.waitForReinitialization();
	projection.emitOutput("complete-native-frame");
	surface.emitInput("input-after-handoff");

	assert.deepEqual(
		surface.ownerStops(),
		[],
		"Owner must remain visible until the replacement child frame is complete",
	);
	assert.equal(surface.physicalStarts(), 0);
	assert.deepEqual(surface.physicalWrites(), []);
	assert.deepEqual(projection.inputs(), []);
	await projection.finishReinitialization();

	assert.deepEqual(surface.ownerStops(), [{ preserveScreen: true }]);
	assert.equal(surface.physicalStarts(), 1);
	assert.deepEqual(surface.physicalWrites(), ["complete-native-frame"]);
	assert.deepEqual(
		projection.inputs(),
		[],
		"input entered while the loading overlay is active must not reach the child",
	);

	await view.closeFromHost();
	await opened;
});

test("physical output backpressure pauses and resumes the selected child PTY", async () => {
	const projection = createProjectionHarness("backpressured");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness({ backpressureOn: "blocked-output" });

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.finishReinitialization();
	projection.emitOutput("blocked-output");
	projection.emitOutput("queued-output");

	assert.deepEqual(surface.physicalWrites(), ["blocked-output"]);
	assert.equal(projection.outputPauses(), 1);
	assert.equal(projection.outputResumes(), 0);
	await surface.releaseBackpressure();
	assert.deepEqual(surface.physicalWrites(), ["blocked-output", "queued-output"]);
	assert.equal(projection.outputResumes(), 1);

	await view.closeFromHost();
	await opened;
});

test("retargeting drains accepted physical output before publishing the replacement frame", async () => {
	const first = createProjectionHarness("first");
	const second = createProjectionHarness("second");
	const view = createViewHarness(first.projection);
	const surface = createSurfaceHarness({ backpressureOn: "accepted-first-output" });

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await first.finishReinitialization();
	first.emitOutput("accepted-first-output");
	view.replaceProjection(second.projection);
	await second.waitForReinitialization();
	second.emitOutput("second-frame");
	assert.deepEqual(first.attachedStates(), [true]);
	assert.deepEqual(surface.physicalWrites(), ["accepted-first-output"]);

	await surface.releaseBackpressure();
	await second.finishReinitialization();
	assert.deepEqual(second.attachedStates(), [true]);
	assert.deepEqual(surface.physicalWrites(), ["accepted-first-output", "second-frame"]);

	await view.closeFromHost();
	await opened;
});

test("a diagnostic host shows the startup snapshot without activating child presentation", async () => {
	const projection = createProjectionHarness("diagnostic", undefined, true);
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness({ supportsPhysicalAttachment: false });

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await Promise.resolve();
	surface.emitDiagnosticInput("diagnostic-input");

	assert.deepEqual(projection.attachedStates(), []);
	assert.deepEqual(projection.inputs(), ["diagnostic-input"]);
	assert.deepEqual(surface.ownerStops(), []);
	assert.equal(surface.physicalStarts(), 0);
	await view.closeFromHost();
	await opened;
});

test("child selector keeps animating until the replacement frame takes over", { timeout: 5_000 }, async () => {
	const first = createProjectionHarness("first", undefined, false, true);
	const second = createProjectionHarness("second", undefined, true);
	const view = new DurableAgentViewAttachment({
		agentId: "first", label: "first", projection: first.projection,
		requestClose: async () => view.settleClosed(),
		reportFailure: (error) => assert.fail(String(error)),
	});
	const surface = createSurfaceHarness();
	const mounted = startPhysicalAgentViewSurface(view, {
		ownerTui: surface.ownerTui,
		physicalTerminal: surface.physicalTerminal,
		requestShutdown() {},
	})!;
	await first.finishReinitialization();
	await mounted.ready;
	let selector!: Component;
	const frames: string[] = [];
	const selectorUi = {
		custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => Component) {
			return new Promise<T>((resolve) => {
				selector = factory({
					terminal: { rows: 24 },
					requestRender() {
						const frame = selector.render(80).join("\n");
						frames.push(frame);
						first.emitOutput(frame);
					},
				} as TUI, {
					fg: (_color: string, text: string) => text,
					bg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				} as Theme, {} as KeybindingsManager, resolve);
			});
		},
	} as ExtensionUIContext;
	const selection = openAgentSelectorSurface(selectorUi, {
		live: ["owner", "first", "second"].map((agentId) => ({
			agentId, workflowId: "owner", label: agentId,
			directSpawnerAgentId: agentId === "owner" ? null : "owner",
			primaryEvidence: { transcriptPath: null, inspectedThrough: { agentId, entryId: agentId } },
			run: { phase: "live", work: "settled", attention: "none", retentionReasons: [] },
			model: { provider: "test", modelId: "test" }, thinking: "off", compacting: false, queuedInputCount: 0,
		})),
		dormant: [], selectedAgentId: "second",
		prepareSelection() {
			return view.retarget({ agentId: "second", label: "second", projection: second.projection });
		},
	});
	try {
		selector.handleInput!("\r");
		// Observe actual animation without coupling the test to its frame cadence.
		const deadline = Date.now() + 1_000;
		while (new Set(frames.filter((frame) => frame.includes("loading"))).size < 2) {
			assert.ok(Date.now() < deadline, "selector did not animate while preparation was pending");
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		assert.match(frames.at(-1)!, /loading/);
		assert.equal(surface.physicalWrites().at(-1), frames.at(-1),
			"the visible spinner must advance while the replacement is preparing");
		surface.emitInput("input-during-preparation");
		assert.deepEqual(first.inputs(), []);
		assert.deepEqual(second.inputs(), []);
		surface.emitResize(100, 30);
		assert.deepEqual(second.resizes().at(-1), { columns: 100, rows: 30 });
		second.emitOutput("complete-second-frame");
		await second.finishReinitialization();
		await first.waitForDetachment();
		assert.equal(surface.physicalWrites().at(-1), "complete-second-frame",
			"the ready replacement must be visible while the old view stops rendering");
		let selectionSettled = false;
		void selection.then(() => { selectionSettled = true; });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(selectionSettled, true, "selection must not depend on old hidden presentation cleanup");
		assert.equal(surface.ownerStarts(), 0);
		first.emitOutput("stale-first-output");
		assert.equal(surface.physicalWrites().at(-1), "complete-second-frame");
	} finally {
		await second.finishReinitialization();
		await first.finishDetachment();
		await selection;
		mounted.close();
		await mounted.closed;
	}
});

test("closing during replacement preparation restores Owner and discards late child output", { timeout: 5_000 }, async () => {
	const first = createProjectionHarness("first");
	const second = createProjectionHarness("second", undefined, true);
	const view = createViewHarness(first.projection);
	const surface = createSurfaceHarness();
	const mounted = startPhysicalAgentViewSurface(view.view, {
		ownerTui: surface.ownerTui, physicalTerminal: surface.physicalTerminal,
		requestShutdown() {},
	})!;
	await first.finishReinitialization();
	await mounted.ready;
	view.replaceProjection(second.projection);
	await second.waitForReinitialization();
	mounted.close();
	await mounted.closed;
	const restoredOutput = [...surface.physicalWrites()];
	await second.finishReinitialization();
	first.emitOutput("late-first-output");
	second.emitOutput("late-second-output");
	assert.deepEqual(surface.physicalWrites(), restoredOutput);
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(first.attachedStates(), [true, false]);
	assert.deepEqual(second.attachedStates(), [true, false]);
});

test("superseding a pending replacement keeps the current view rendering until the final target is ready", { timeout: 5_000 }, async () => {
	const first = createProjectionHarness("first");
	const second = createProjectionHarness("second", undefined, true);
	const third = createProjectionHarness("third", undefined, true);
	const view = createViewHarness(first.projection);
	const surface = createSurfaceHarness();
	const mounted = startPhysicalAgentViewSurface(view.view, {
		ownerTui: surface.ownerTui, physicalTerminal: surface.physicalTerminal,
		requestShutdown() {},
	})!;
	await first.finishReinitialization();
	await mounted.ready;
	view.replaceProjection(second.projection);
	await second.waitForReinitialization();
	view.replaceProjection(third.projection);
	await second.finishReinitialization();
	await third.waitForReinitialization();
	first.emitOutput("current-selector-loading");
	second.emitOutput("cancelled-target-output");
	assert.equal(surface.physicalWrites().at(-1), "current-selector-loading");
	third.emitOutput("final-target-frame");
	await third.finishReinitialization();
	assert.equal(surface.physicalWrites().at(-1), "final-target-frame");
	mounted.close();
	await mounted.closed;
	assert.deepEqual(second.attachedStates(), [true, false]);
	assert.deepEqual(third.attachedStates(), [true, false]);
	assert.equal(surface.ownerStarts(), 1);
});

test("a failed cancellation is observed while replacement preparation is still pending", { timeout: 5_000 }, async () => {
	const first = createProjectionHarness("first");
	const second = createProjectionHarness("second", undefined, true);
	const third = createProjectionHarness("third");
	const failure = new Error("cancelled replacement could not detach");
	const view = new DurableAgentViewAttachment({
		agentId: "first", label: "first", projection: first.projection,
		requestClose: async () => view.settleClosed(),
		reportFailure() {},
	});
	const surface = createSurfaceHarness();
	const mounted = startPhysicalAgentViewSurface(view, {
		ownerTui: surface.ownerTui, physicalTerminal: surface.physicalTerminal,
		requestShutdown() {},
	})!;
	await first.finishReinitialization();
	await mounted.ready;
	const pending = view.retarget({
		agentId: "second", label: "second",
		projection: {
			...second.projection,
			physicalTerminal: {
				...second.projection.physicalTerminal,
				async endAttachment() {
					await second.projection.physicalTerminal.endAttachment();
					throw failure;
				},
			},
		},
	}).catch((error: unknown) => error);
	await second.waitForReinitialization();
	const superseding = view.retarget({
		agentId: "third", label: "third", projection: third.projection,
	}).catch((error: unknown) => error);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await second.finishReinitialization();
	assert.equal(await pending, failure);
	assert.equal(await superseding, failure);
	mounted.close();
	await mounted.closed;
	assert.equal(surface.ownerStarts(), 1);
});

test("failed replacement rejects selection and restores Owner", { timeout: 5_000 }, async () => {
	const first = createProjectionHarness("first");
	const failure = new Error("replacement presentation failed");
	const second = createProjectionHarness("second", failure);
	const failures: unknown[] = [];
	const view = new DurableAgentViewAttachment({
		agentId: "first", label: "first", projection: first.projection,
		requestClose: async () => view.settleClosed(),
		reportFailure: (error) => { failures.push(error); },
	});
	const surface = createSurfaceHarness();
	const mounted = startPhysicalAgentViewSurface(view, {
		ownerTui: surface.ownerTui, physicalTerminal: surface.physicalTerminal,
		requestShutdown() {},
	})!;
	await first.finishReinitialization();
	await mounted.ready;
	try {
		await assert.rejects(view.retarget({
			agentId: "second", label: "second", projection: second.projection,
		}), failure);
	} finally {
		mounted.close();
		await mounted.closed;
	}
	assert.deepEqual(failures, [failure]);
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(first.attachedStates(), [true, false]);
	assert.deepEqual(second.attachedStates(), [true, false]);
});

test("attachment setup failure restores Owner exactly once and reports the view failure", async () => {
	const setupFailure = new Error("child presentation reinitialization failed");
	const projection = createProjectionHarness("failed", setupFailure);
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();

	await openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});

	assert.deepEqual(view.failures().map(String), [String(setupFailure)]);
	assert.deepEqual(projection.attachedStates(), [true, false]);
	assert.deepEqual(surface.ownerStops(), []);
	assert.equal(surface.physicalStarts(), 0);
	assert.equal(surface.physicalStops(), 0);
	assert.equal(surface.ownerStarts(), 0);
	assert.equal(view.cleanupCount(), 1);
});

test("an existing projection failure prevents physical mode from starting", async () => {
	const existingFailure = new Error("projection already failed");
	const projection = createProjectionHarness(
		"already-failed",
		undefined,
		false,
		false,
		existingFailure,
	);
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();

	await openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});

	assert.deepEqual(view.failures(), [existingFailure]);
	assert.deepEqual(projection.attachedStates(), [false]);
	assert.equal(surface.physicalStarts(), 0);
	assert.equal(view.cleanupCount(), 1);
});

test("physical output failure still restores Owner and settles the view", async () => {
	const outputFailure = new Error("physical terminal output failed");
	const projection = createProjectionHarness("output-failure");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness({ writeFailure: outputFailure });

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.finishReinitialization();
	assert.doesNotThrow(() => projection.emitOutput("unwritable-child-output"));
	await opened;

	assert.equal(surface.physicalStops(), 1);
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(surface.ownerRenderRequests(), [true]);
	assert.equal(view.failures().length, 1);
	assert.match(String(view.failures()[0]), /physical terminal output failed/);
});

test("child exit intent restores Owner before delegating shutdown", async () => {
	const projection = createProjectionHarness("exiting");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();
	let shutdownRequests = 0;

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown: () => shutdownRequests += 1,
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.finishReinitialization();
	projection.emitExitRequest();
	projection.emitExitRequest();
	await opened;

	assert.equal(shutdownRequests, 1);
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(projection.attachedStates(), [true, false]);
});

function createProjectionHarness(
	name: string,
	reinitializationFailure?: Error,
	blockReinitialization = false,
	blockDetachment = false,
	existingFailure?: Error,
): {
	projection: TerminalProjection;
	waitForReinitialization(): Promise<void>;
	finishReinitialization(): Promise<void>;
	waitForDetachment(): Promise<void>;
	finishDetachment(): Promise<void>;
	emitOutput(data: string): void;
	emitFailure(error: unknown): void;
	emitExitRequest(): void;
	attachedStates(): readonly boolean[];
	outputPauses(): number;
	outputResumes(): number;
	inputs(): readonly string[];
	resizes(): readonly Readonly<{ columns: number; rows: number }>[];
} {
	const outputHandlers = new Set<(data: string) => void>();
	const failureHandlers = new Set<(error: unknown) => void>();
	const exitHandlers = new Set<() => void>();
	const attachedStates: boolean[] = [];
	let outputPauses = 0;
	let outputResumes = 0;
	const inputs: string[] = [];
	const resizes: Array<{ columns: number; rows: number }> = [];
	let settleReinitialization!: () => void;
	const reinitialized = new Promise<void>((resolve) => {
		settleReinitialization = resolve;
	});
	let releaseReinitialization!: () => void;
	const reinitializationGate = new Promise<void>((resolve) => {
		releaseReinitialization = resolve;
	});
	let settleReinitializationFinished!: () => void;
	const reinitializationFinished = new Promise<void>((resolve) => {
		settleReinitializationFinished = resolve;
	});
	let settleDetachmentStarted!: () => void;
	const detachmentStarted = new Promise<void>((resolve) => {
		settleDetachmentStarted = resolve;
	});
	let releaseDetachment!: () => void;
	const detachmentGate = new Promise<void>((resolve) => {
		releaseDetachment = resolve;
	});
	let settleDetachmentFinished!: () => void;
	const detachmentFinished = new Promise<void>((resolve) => {
		settleDetachmentFinished = resolve;
	});
	const projection: TerminalProjection = {
		presentation: {
			render: () => [name],
			invalidate() {},
		},
		screenView: {
			async begin() {},
			async end() {},
		},
		physicalTerminal: {
			async beginAttachment(handler) {
				attachedStates.push(true);
				outputHandlers.add(handler);
				settleReinitialization();
				if (blockReinitialization) await reinitializationGate;
				settleReinitializationFinished();
				if (reinitializationFailure) throw reinitializationFailure;
				return () => outputHandlers.delete(handler);
			},
			async endAttachment() {
				attachedStates.push(false);
				settleDetachmentStarted();
				if (blockDetachment) await detachmentGate;
				settleDetachmentFinished();
			},
			pauseOutput() {
				outputPauses += 1;
			},
			resumeOutput() {
				outputResumes += 1;
			},
		},
		resize(columns, rows) {
			resizes.push({ columns, rows });
		},
		dispatchInput(data) {
			inputs.push(data);
		},
		focusEditor() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler(handler) {
			failureHandlers.add(handler);
			if (existingFailure) handler(existingFailure);
			return () => failureHandlers.delete(handler);
		},
		addExitRequestHandler(handler) {
			exitHandlers.add(handler);
			return () => exitHandlers.delete(handler);
		},
	};
	return {
		projection,
		waitForReinitialization: () => reinitialized,
		async finishReinitialization() {
			releaseReinitialization();
			await reinitializationFinished;
			await Promise.resolve();
		},
		waitForDetachment: () => detachmentStarted,
		async finishDetachment() {
			releaseDetachment();
			await detachmentFinished;
			await Promise.resolve();
		},
		emitOutput(data) {
			for (const handler of outputHandlers) handler(data);
		},
		emitFailure(error) {
			for (const handler of failureHandlers) handler(error);
		},
		emitExitRequest() {
			for (const handler of exitHandlers) handler();
		},
		// Repeated hide is idempotent; assert state transitions, not cleanup call counts.
		attachedStates: () => attachedStates.filter((state, index) =>
			index === 0 || state !== attachedStates[index - 1]),
		outputPauses: () => outputPauses,
		outputResumes: () => outputResumes,
		inputs: () => inputs,
		resizes: () => resizes,
	};
}

function createViewHarness(initialProjection: TerminalProjection): {
	view: DurableAgentView;
	replaceProjection(projection: TerminalProjection): void;
	closeFromHost(): Promise<void>;
	cleanupCount(): number;
	failures(): readonly unknown[];
} {
	let projection = initialProjection;
	let closed = false;
	let cleanups = 0;
	const failures: unknown[] = [];
	const changeHandlers = new Set<() => void>();
	const closeHandlers = new Set<() => void>();
	const view: DurableAgentView = {
		agentId: AGENT_ID,
		label: "Durable Agent",
		projection: () => projection,
		addPresentationHandler(handler) {
			changeHandlers.add(handler);
			return () => changeHandlers.delete(handler);
		},
		addCloseHandler(handler) {
			closeHandlers.add(handler);
			return () => closeHandlers.delete(handler);
		},
		async close() {
			if (closed) return;
			closed = true;
			cleanups += 1;
			for (const handler of closeHandlers) handler();
		},
		fail(error) {
			failures.push(error);
			void view.close();
		},
	};
	return {
		view,
		replaceProjection(next) {
			projection = next;
			for (const handler of changeHandlers) handler();
		},
		closeFromHost: () => view.close(),
		cleanupCount: () => cleanups,
		failures: () => failures,
	};
}

function createSurfaceHarness(options: Readonly<{
	supportsPhysicalAttachment?: boolean;
	backpressureOn?: string;
	writeFailure?: Error;
}> = {}): {
	ui: ExtensionUIContext;
	ownerTui: TUI;
	physicalTerminal: PhysicalTerminalPort;
	emitInput(data: string): void;
	emitDiagnosticInput(data: string): void;
	emitResize(columns: number, rows: number): void;
	releaseBackpressure(): Promise<void>;
	physicalWrites(): readonly string[];
	physicalStarts(): number;
	physicalStops(): number;
	ownerStops(): readonly Readonly<{ preserveScreen?: boolean }>[];
	ownerStarts(): number;
	ownerRenderRequests(): readonly boolean[];
} {
	let activeInput: ((data: string) => void) | undefined;
	let activeResize: ((columns: number, rows: number) => void) | undefined;
	const physicalWrites: string[] = [];
	let settleBackpressure!: () => void;
	const backpressure = new Promise<void>((resolve) => {
		settleBackpressure = resolve;
	});
	let physicalStarts = 0;
	let physicalStops = 0;
	const ownerStops: Array<{ preserveScreen?: boolean }> = [];
	let ownerStarts = 0;
	const ownerRenderRequests: boolean[] = [];
	const physicalTerminal: PhysicalTerminalPort = {
		supportsPhysicalAttachment: options.supportsPhysicalAttachment ?? true,
		columns: () => 80,
		rows: () => 24,
		write(data) {
			if (options.writeFailure) throw options.writeFailure;
			physicalWrites.push(data);
			return data !== options.backpressureOn;
		},
		waitForDrain: () => backpressure,
		start(onInput, onResize) {
			physicalStarts += 1;
			activeInput = onInput;
			activeResize = onResize;
		},
		stop() {
			physicalStops += 1;
			activeInput = undefined;
			activeResize = undefined;
		},
	};
	let customComponent: Component | undefined;
	let focused = true;
	const handle: OverlayHandle = {
		hide() {
			focused = false;
			customComponent = undefined;
		},
		setHidden(value) {
			focused = !value;
		},
		isHidden: () => !focused,
		focus() {
			focused = true;
		},
		unfocus() {
			focused = false;
		},
		isFocused: () => focused,
		getBounds: () => undefined,
	};
	const inputListeners = new Set<(
		data: string,
	) => Readonly<{ consume?: boolean; data?: string }> | undefined>();
	const tui = {
		mode: "fullscreen",
		terminal: { columns: 80, rows: 24, write() {} },
		inputListeners,
		addInputListener(listener: (
			data: string,
		) => Readonly<{ consume?: boolean; data?: string }> | undefined) {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
		stop(options?: { preserveScreen?: boolean }) {
			ownerStops.push(options ?? {});
		},
		start() {
			ownerStarts += 1;
		},
		requestRender(force = false) {
			ownerRenderRequests.push(force);
		},
	} as unknown as TUI;
	const ui = {
		custom: <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
			options?: { onHandle?: (handle: OverlayHandle) => void },
		) => new Promise<T>(() => {
			customComponent = factory(
				tui,
				{} as Theme,
				{} as KeybindingsManager,
				() => undefined,
			);
			options?.onHandle?.(handle);
		}),
	} as unknown as ExtensionUIContext;
	return {
		ui,
		ownerTui: tui,
		physicalTerminal,
		emitInput(data) {
			if (activeInput) {
				activeInput(data);
				return;
			}
			let current = data;
			for (const listener of inputListeners) {
				const result = listener(current);
				if (result?.consume) return;
				if (result?.data !== undefined) current = result.data;
			}
		},
		emitDiagnosticInput(data) {
			customComponent?.handleInput?.(data);
		},
		emitResize(columns, rows) {
			activeResize?.(columns, rows);
		},
		async releaseBackpressure() {
			settleBackpressure();
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		physicalWrites: () => physicalWrites,
		physicalStarts: () => physicalStarts,
		physicalStops: () => physicalStops,
		ownerStops: () => ownerStops,
		ownerStarts: () => ownerStarts,
		ownerRenderRequests: () => ownerRenderRequests,
	};
}

test("reselecting a child waits for that child's previous asynchronous hide", { timeout: 5_000 }, async () => {
	const surface = createSurfaceHarness();
	const attachment = new PhysicalTerminalAttachment({
		ownerTui: surface.ownerTui, physicalTerminal: surface.physicalTerminal,
		fail(error) { throw error; }, requestExit() {},
	});
	let releaseHide!: () => void;
	const hideGate = new Promise<void>(resolve => { releaseHide = resolve; });
	let visible = false;
	let hideCount = 0;
	const first = createProjectionHarness("first").projection;
	const firstProjection: TerminalProjection = {
		...first,
		physicalTerminal: {
			...first.physicalTerminal,
			async beginAttachment(handler) {
				const disconnect = await first.physicalTerminal.beginAttachment(handler);
				visible = true;
				return disconnect;
			},
			async endAttachment() {
				if (++hideCount === 1) await hideGate;
				visible = false;
			},
		},
	};
	const second = createProjectionHarness("second").projection;
	try {
		await attachment.attach(firstProjection);
		await attachment.attach(second);
		const reselecting = attachment.attach(firstProjection);
		await new Promise<void>(resolve => setImmediate(resolve));
		releaseHide();
		await reselecting;
		assert.equal(visible, true, "old cleanup must finish before the selected child shows");
	} finally {
		releaseHide();
		await attachment.close();
	}
});

test("cancelling asynchronous attachment hides the child after its eventual show", { timeout: 5_000 }, async () => {
	const surface = createSurfaceHarness();
	const attachment = new PhysicalTerminalAttachment({
		ownerTui: surface.ownerTui, physicalTerminal: surface.physicalTerminal,
		fail(error) { throw error; }, requestExit() {},
	});
	let releaseShow!: () => void;
	const showGate = new Promise<void>(resolve => { releaseShow = resolve; });
	let started!: () => void;
	const showing = new Promise<void>(resolve => { started = resolve; });
	let visible = false;
	const child = createProjectionHarness("cancelled").projection;
	const projection: TerminalProjection = {
		...child,
		physicalTerminal: {
			...child.physicalTerminal,
			async beginAttachment(handler) {
				started();
				await showGate;
				const disconnect = await child.physicalTerminal.beginAttachment(handler);
				visible = true;
				return disconnect;
			},
			async endAttachment() { visible = false; },
		},
	};
	try {
		await attachment.attach(createProjectionHarness("current").projection);
		const selecting = attachment.attach(projection);
		await showing;
		const suspending = attachment.suspend();
		assert.equal(surface.ownerStarts(), 1, "Owner restoration cannot wait for pending show");
		releaseShow();
		await selecting;
		await suspending;
		assert.equal(visible, false, "a cancelled child must not render after a late show");
	} finally {
		releaseShow();
		await attachment.close();
	}
});
