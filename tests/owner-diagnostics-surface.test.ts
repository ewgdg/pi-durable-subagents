import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
import { openOwnerDiagnostics, showOwnerBlockage } from "../src/presentation/owner-diagnostics-surface.ts";

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
		failure.transcriptPath, failure.protocolError, cleanupError));
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
