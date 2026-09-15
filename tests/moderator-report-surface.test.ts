import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, visibleWidth, type Terminal, type OverlayOptions, type OverlayHandle, type Component, type TuiMouseEvent, type TUI } from "@earendil-works/pi-tui";
import { openModeratorReportSurface } from "../src/presentation/moderator-report-surface.ts";
import { formatModeratorReport, type ReportHistoryItem } from "../src/protocol/moderator-report.ts";

const item: ReportHistoryItem = { report: {
	reportId: "report-1", createdAt: "2026-01-01T00:00:00Z",
	reporter: { agentId: "moderator", label: "Moderator" },
	source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/source.jsonl" },
	symptom: "Delivery stalled", suspectedDefect: "Dispatch race", uncertainty: "Not reproduced",
	recoveryActions: "Retried", recoveryOutcome: "Recovered", evidence: ["receipt-1"],
} };

function harness(rows = 15) {
	let component!: Component;
	const ui = { custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
		return new Promise<T>((resolve) => {
			component = factory({ terminal: { rows }, requestRender() {} } as unknown as TUI,
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme,
				{} as KeybindingsManager, resolve);
		});
	} } as unknown as ExtensionUIContext;
	return { ui, get component() { return component; } };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("opening, copying, and closing a report do not mark it read", async () => {
	const h = harness();
	let reads = 0;
	let copied = "";
	const result = openModeratorReportSurface(h.ui, item, {
		prepareReporter() {}, setRead() { reads++; }, copyReport(text) { copied = text; },
	});
	assert.match(h.component.render(80).join("\n"), /Unread/);
	h.component.handleInput?.("c");
	await flush();
	assert.equal(copied, formatModeratorReport(item.report));
	assert.equal(reads, 0);
	h.component.handleInput?.("\x1b");
	assert.equal(await result, "back");
	assert.equal(reads, 0);
});

test("Read toggles wait for persistence and View reporter is separate", async () => {
	const h = harness();
	let reads = 0;
	let persist!: () => void;
	const result = openModeratorReportSurface(h.ui, item, {
		prepareReporter() {}, setRead(read) { assert.equal(read, reads === 0); reads++; return new Promise<void>((resolve) => { persist = resolve; }); },
		copyReport() {},
	});
	h.component.handleInput?.("m");
	h.component.handleInput?.("m");
	assert.match(h.component.render(80).join("\n"), /Unread/);
	persist();
	await flush();
	assert.match(h.component.render(80).join("\n"), /Read/);
	assert.doesNotMatch(h.component.render(80).join("\n"), /Unread/);
	assert.match(h.component.render(80).join("\n"), /m Toggle read/);
	h.component.handleInput?.("m");
	assert.equal(reads, 2);
	persist();
	await flush();
	assert.match(h.component.render(80).join("\n"), /Unread/);
	assert.match(h.component.render(80).join("\n"), /m Toggle read/);
	h.component.handleInput?.("v");
	assert.equal(await result, "view_reporter");
});

test("failed Mark read remains unread and can retry", async () => {
	const h = harness();
	let reads = 0;
	const result = openModeratorReportSurface(h.ui, item, {
		prepareReporter() {}, setRead() { if (++reads === 1) throw new Error("Disk full"); }, copyReport() {},
	});
	h.component.handleInput?.("m");
	await flush();
	assert.match(h.component.render(80).join("\n"), /Unread/);
	assert.match(h.component.render(80).join("\n"), /Disk full/);
	h.component.handleInput?.("m");
	await flush();
	assert.doesNotMatch(h.component.render(80).join("\n"), /Unread/);
	h.component.handleInput?.("q");
	await result;
});

test("the complete report scrolls safely within terminal bounds", async () => {
	const h = harness(12);
	const unsafeItem = { report: { ...item.report,
		symptom: "Safe\x1b]52;c;attack\x07\x1b[2J\rtext\x85",
		evidence: Array.from({ length: 30 }, (_, i) => `Evidence ${i} 界`),
	} };
	const result = openModeratorReportSurface(h.ui, unsafeItem, { prepareReporter() {}, setRead() {}, copyReport() {} });
	const seen: string[] = [];
	for (let i = 0; i < 100; i++) {
		const lines = h.component.render(40);
		assert.ok(lines.length <= 12);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
		seen.push(...lines);
		h.component.handleInput?.("j");
	}
	const rendered = seen.join("\n");
	assert.match(rendered, /source.jsonl/);
	assert.match(rendered, /Evidence 29/);
	assert.doesNotMatch(rendered, /\x1b\]|\x1b\[2J|\r|\x85|attack/);
	h.component.handleInput?.("\x1b[H");
	assert.match(h.component.render(40).join("\n"), /Moderator report report-1/);
	h.component.handleInput?.("q");
	await result;
});

test("View reporter leaves an unread report unread, and prior read state survives reopening", async () => {
	for (const historyItem of [item, { ...item, readAt: "2026-01-02T00:00:00Z" }]) {
		const h = harness();
		let reads = 0;
		const result = openModeratorReportSurface(h.ui, historyItem, {
			prepareReporter() {}, setRead() { reads++; }, copyReport() {},
		});
		assert.match(h.component.render(80).join("\n"), historyItem.readAt ? / · Read/ : / · Unread/);
		h.component.handleInput?.("v");
		assert.equal(await result, "view_reporter");
		assert.equal(reads, 0);
	}
});

const wheel = (wheelDelta: number): TuiMouseEvent => ({
	type: "wheel", button: "none", x: 2, y: 2, screenX: 2, screenY: 2,
	width: 80, height: 12, shift: false, alt: false, ctrl: false, wheelDelta,
});

test("wheel scrolls the report, clamps at both ends, and preserves read state", { timeout: 5_000 }, async () => {
	const h = harness(12);
	let reads = 0;
	const result = openModeratorReportSurface(h.ui, item, {
		prepareReporter() {}, setRead() { reads++; }, copyReport() {},
	});
	const initial = h.component.render(80);
	assert.deepEqual(h.component.handleMouse?.(wheel(1)), { handled: true, render: true });
	const scrolled = h.component.render(80);
	assert.notDeepEqual(scrolled, initial);
	assert.equal(scrolled[0], initial[0]);
	assert.equal(scrolled.at(-1), initial.at(-1));
	h.component.handleMouse?.(wheel(-1));
	assert.deepEqual(h.component.render(80), initial);
	assert.deepEqual(h.component.handleMouse?.(wheel(-1)), { handled: true, render: false });
	for (let i = 0; i < 100; i++) h.component.handleMouse?.(wheel(1));
	const bottom = h.component.render(80);
	h.component.handleInput?.("\x1b[F");
	assert.deepEqual(h.component.render(80), bottom);
	assert.deepEqual(h.component.handleMouse?.(wheel(1)), { handled: true, render: false });
	assert.equal(reads, 0);
	h.component.handleInput?.("q");
	assert.equal(await result, "back");
	h.component.handleMouse?.(wheel(-1));
	assert.deepEqual(h.component.render(80), bottom);
});

test("wheel does not change the report during reporter handoff or for other pointer events", { timeout: 5_000 }, async () => {
	const h = harness(12);
	let ready!: () => void;
	const result = openModeratorReportSurface(h.ui, item, {
		prepareReporter: () => new Promise<void>((resolve) => { ready = resolve; }),
		setRead() {}, copyReport() {},
	});
	const initial = h.component.render(80);
	h.component.handleMouse?.({ ...wheel(1), type: "click", button: "left" });
	assert.deepEqual(h.component.render(80), initial);
	h.component.handleInput?.("v");
	const pending = h.component.render(80);
	assert.deepEqual(h.component.handleMouse?.(wheel(1)), { handled: true, render: false });
	assert.deepEqual(h.component.render(80), pending);
	ready();
	assert.equal(await result, "view_reporter");
});

test("fullscreen terminal wheel input reaches the report overlay and returns to underlying content on close", { timeout: 5_000 }, async (t) => {
	let input: (data: string) => void = () => {};
	const terminal: Terminal = {
		columns: 80, rows: 12, kittyProtocolActive: false,
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {},
		write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const tui = new TuiAltScreen(terminal);
	let underlyingWheels = 0;
	const underlying: Component = {
		render: () => ["Underlying content"], invalidate() {},
		handleMouse(event) { if (event.type === "wheel") underlyingWheels++; return { handled: true }; },
	};
	tui.addChild(underlying);
	tui.setFocus(underlying);
	let component!: Component & { dispose?(): void };
	let overlay: OverlayHandle | undefined;
	t.after(() => { overlay?.hide(); component?.dispose?.(); tui.stop(); });
	tui.start();
	const ui = { custom<T>(
		factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => Component,
		config: { overlayOptions?: OverlayOptions },
	) {
		return new Promise<T>((resolve) => {
			component = factory(tui, {
				fg: (_color: string, text: string) => text, bold: (text: string) => text,
			} as Theme, {} as KeybindingsManager, (value) => {
				overlay?.hide(); component.dispose?.(); resolve(value);
			});
			overlay = tui.showOverlay(component, config.overlayOptions);
		});
	} } as unknown as ExtensionUIContext;
	const result = openModeratorReportSurface(ui, item, { prepareReporter() {}, setRead() {}, copyReport() {} });
	tui.renderNow();
	const initial = component.render(80);
	input("\x1b[<65;3;3M");
	tui.renderNow();
	assert.notDeepEqual(component.render(80), initial);
	input("\x1b[<64;3;3M");
	tui.renderNow();
	assert.deepEqual(component.render(80), initial);
	assert.equal(underlyingWheels, 0);
	input("q");
	assert.equal(await result, "back");
	tui.renderNow();
	input("\x1b[<65;1;1M");
	assert.equal(underlyingWheels, 1);
});

test("failed Mark unread preserves the read state and retries the desired state", { timeout: 5_000 }, async () => {
	const h = harness();
	let attempts = 0;
	const result = openModeratorReportSurface(h.ui, { ...item, readAt: "2026-01-02T00:00:00Z" }, {
		prepareReporter() {}, copyReport() {},
		setRead(read) {
			assert.equal(read, false);
			if (++attempts === 1) throw new Error("Disk full");
		},
	});
	h.component.handleInput?.("m");
	await flush();
	assert.match(h.component.render(80).join("\n"), /m Toggle read/);
	assert.match(h.component.render(80).join("\n"), /Disk full/);
	h.component.handleInput?.("m");
	await flush();
	assert.match(h.component.render(80).join("\n"), /m Toggle read/);
	assert.match(h.component.render(80).join("\n"), /· Unread/);
	h.component.handleInput?.("q");
	assert.equal(await result, "back");
});

test("runtime reports are copyable and acknowledgeable without fictional reporter navigation", async () => {
	const runtimeItem: ReportHistoryItem = { report: {
		...item.report, reporter: undefined,
		source: { kind: "runtime_diagnostic", agentId: "owner", entryId: "diagnostic-exact", transcriptPath: "/tmp/owner.jsonl" },
	}, findings: [{ reportId: item.report.reportId, key: "recovery", summary: "Inspection recovered", evidence: ["entry:recovered"], createdAt: "2026-01-02T00:00:00Z" }] };
	const h = harness();
	const reads: boolean[] = [];
	let copied = "";
	let navigations = 0;
	const result = openModeratorReportSurface(h.ui, runtimeItem, {
		setRead(read) { reads.push(read); }, copyReport(text) { copied = text; }, prepareReporter() { navigations++; },
	});
	assert.match(h.component.render(180).join("\n"), /Runtime report/);
	assert.doesNotMatch(h.component.render(180).join("\n"), /View reporter/);
	h.component.handleInput?.("v"); await flush();
	assert.equal(navigations, 0);
	h.component.handleInput?.("c"); await flush();
	assert.match(copied, /Source entry: diagnostic-exact/);
	assert.match(copied, /Finding: recovery/);
	assert.match(copied, /Inspection recovered/);
	assert.match(copied, /entry:recovered/);
	h.component.handleInput?.("\u001b[F");
	assert.match(h.component.render(180).join("\n"), /Inspection recovered/);
	assert.doesNotMatch(copied, /Source tool call|Reporter:/);
	assert.deepEqual(reads, []);
	h.component.handleInput?.("m"); await flush();
	h.component.handleInput?.("m"); await flush();
	assert.deepEqual(reads, [true, false]);
	h.component.handleInput?.("q");
	assert.equal(await result, "back");
});
