import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
import { openOwnerDiagnostics, showOwnerBlockage } from "../src/presentation/owner-diagnostics-surface.ts";

function harness(rows = 15) {
	let component!: Component;
	const terminal = { rows };
	const ui = { custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
		return new Promise<T>((resolve) => {
			component = factory({ terminal, requestRender() {} } as unknown as TUI,
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme,
				{} as KeybindingsManager, resolve);
		});
	} } as unknown as ExtensionUIContext;
	return { ui, terminal, get component() { return component; } };
}

const failure = new OwnerRecoveryError("Owner coordination initialization", "owner", "/tmp/owner-transcript.jsonl",
	new ProtocolInvariantError("committed Request is invalid", {
		source: { agentId: "owner", entryId: "source-entry", toolCallId: "source-call" },
		cause: new Error('required field "title" is missing'),
	}));

test("diagnostics separates summary from complete scrollable technical evidence", { timeout: 5_000 }, async () => {
	const h = harness(12);
	const result = openOwnerDiagnostics(h.ui, failure);
	const summary: string[] = [];
	for (let i = 0; i < 30; i++) {
		summary.push(...h.component.render(60));
		h.component.handleInput?.("j");
	}
	assert.match(summary.join("\n"), /Recovery/);
	assert.match(summary.join("\n"), /Native \/fork preserves selected conversation/);
	assert.match(summary.join("\n"), /Owner role identification must have succeeded/);
	assert.match(summary.join("\n"), /first encountered failure/);
	assert.doesNotMatch(summary.join("\n"), /owner-transcript.jsonl|at TestContext|source-call/);
	h.component.handleInput?.("t");
	const technical: string[] = [];
	for (let i = 0; i < 60; i++) {
		const lines = h.component.render(40);
		assert.ok(lines.length <= 12);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
		technical.push(...lines);
		h.component.handleInput?.("j");
	}
	assert.match(technical.join("\n"), /owner-transcript.jsonl/);
	assert.match(technical.join("\n"), /source-entry/);
	assert.match(technical.join("\n"), /source-call/);
	assert.match(technical.join("\n"), /Caused by:/);
	assert.match(technical.join("\n"), /required field "title" is missing/);
	h.component.handleInput?.("s");
	assert.match(h.component.render(60).join("\n"), /Problem/);
	h.component.handleInput?.("\x1b");
	await result;
});

test("diagnostics exposes cleanup failure without interpreting evidence as terminal commands", async () => {
	const h = harness(30);
	const cleanupError = new Error("cleanup pending\x1b]52;c;attack\x07\x1b[2J");
	const result = openOwnerDiagnostics(h.ui, new OwnerRecoveryError(failure.stage, failure.agentId,
		failure.transcriptPath, failure.admissionError, cleanupError));
	assert.match(h.component.render(120).join("\n"), /cleanup also failed/);
	h.component.handleInput?.("t");
	h.component.render(120);
	h.component.handleInput?.("\x1b[F");
	const technical = h.component.render(120).join("\n");
	assert.match(technical, /cleanup pending/);
	assert.doesNotMatch(technical, /attack|\x1b\]|\x1b\[2J/);
	h.component.handleInput?.("q");
	await result;
});

test("healthy admission diagnostics does not claim an exhaustive audit", async () => {
	const h = harness();
	const result = openOwnerDiagnostics(h.ui);
	const rendered = h.component.render(80).join("\n");
	assert.match(rendered, /No Owner admission failure is recorded/);
	assert.match(rendered, /not an exhaustive audit/);
	h.component.handleInput?.("q");
	await result;
});

test("short diagnostics fills every viewport cell with controls pinned to the bottom across resizing", { timeout: 5_000 }, async () => {
	const h = harness(40);
	const result = openOwnerDiagnostics(h.ui);
	for (const [columns, rows] of [[100, 40], [20, 8], [8, 2], [1, 1], [100, 40]]) {
		h.terminal.rows = rows;
		const lines = h.component.render(columns);
		assert.equal(lines.length, rows);
		assert.ok(lines.every((line) => visibleWidth(line) === columns));
		if (columns >= 8) assert.match(lines.at(-1)!, /q close/);
	}
	h.component.handleInput?.("q");
	await result;
});

test("blockage widget uses a warning-colored responsive box", () => {
	let widget!: Component;
	const styles: Array<{ color: string; text: string }> = [];
	const ui = { setWidget(_key: string, factory: unknown) {
		assert.equal(typeof factory, "function");
		widget = (factory as (tui: TUI, theme: Theme) => Component)({} as TUI, {
			fg(color: string, text: string) { styles.push({ color, text }); return text; },
		} as Theme);
	} } as ExtensionUIContext;
	showOwnerBlockage(ui, failure);
	for (const width of [100, 40, 12, 3, 1]) {
		const lines = widget.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		if (width >= 4) {
			assert.ok(lines[0].startsWith("┌") && lines[0].endsWith("┐"));
			assert.ok(lines.at(-1)!.startsWith("└") && lines.at(-1)!.endsWith("┘"));
			assert.ok(lines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")));
		}
	}
	assert.match(widget.render(100).join("\n"), /Subagent coordination blocked/);
	assert.doesNotMatch(widget.render(100).join("\n"), /workflow blocked/);
	const rendered = widget.render(100).join("\n");
	assert.doesNotMatch(rendered, /inspect the failure|\/agents repair/);
	assert.ok(styles.some(({ color, text }) => color === "dim" && text.trim() === "/agents diagnostics"));
	assert.ok(styles.some(({ color, text }) => color === "warning" && text.trim() === "⚠ Subagent coordination blocked"));
	assert.ok(!styles.some(({ text }) => text.includes("Saved coordination data")));
	assert.ok(styles.some(({ color, text }) => color === "warning" && text.startsWith("┌")));
});

test("clearing blockage removes only its own widget", () => {
	const widgets = new Map<string, unknown>();
	widgets.set("unrelated", ["Keep this"]);
	const ui = { setWidget(key: string, widget: unknown) {
		if (widget === undefined) widgets.delete(key); else widgets.set(key, widget);
	} } as ExtensionUIContext;
	showOwnerBlockage(ui, failure);
	assert.ok(widgets.has("agent-coordination.blockage"));
	showOwnerBlockage(ui, undefined);
	assert.deepEqual([...widgets.keys()], ["unrelated"]);
});

test("non-protocol admission failure reports its own reason instead of invalid saved data", async () => {
	const hostFailure = new OwnerRecoveryError("Owner admission", "owner", undefined,
		new Error("Incompatible Pi host: cannot bind the Owner Agent extension"));
	let widget!: Component;
	showOwnerBlockage({ setWidget(_key: string, factory: unknown) {
		widget = (factory as (tui: TUI, theme: Theme) => Component)({} as TUI,
			{ fg: (_color: string, text: string) => text } as unknown as Theme);
	} } as ExtensionUIContext, hostFailure);
	const widgetText = widget.render(100).join("\n");
	assert.match(widgetText, /cannot bind the Owner Agent extension/);
	assert.doesNotMatch(widgetText, /Saved coordination data/);

	const h = harness(40);
	const result = openOwnerDiagnostics(h.ui, hostFailure);
	const summary = h.component.render(120).join("\n");
	assert.match(summary, /Reason: Incompatible Pi host/);
	assert.doesNotMatch(summary, /protocol/i);
	h.component.handleInput?.("t");
	assert.match(h.component.render(120).join("\n"), /Stage: Owner admission/);
	h.component.handleInput?.("q");
	await result;
});
