import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, TuiAltScreen, TuiMainScreen, getKeybindings, visibleWidth, type Component, type OverlayHandle, type OverlayOptions, type TuiMouseEvent, type TUI } from "@earendil-works/pi-tui";
import type { AgentRosterStatus } from "../src/coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface, type AgentSelectorAction, type AgentSelectorOptions } from "../src/presentation/agent-selector-surface.ts";
import { ScreenTerminal } from "./support/screen-terminal.ts";

const identity = (text: string) => text;
const theme = {
	fg: (color: string, text: string) => `\x1b[${color === "text" ? 37 : color === "accent" ? 36 : 90}m${text}\x1b[39m`,
	bg: (color: string, text: string) => `\x1b[${color === "selectedBg" ? 44 : 100}m${text}\x1b[49m`,
	getBgAnsi: (color: string) => `\x1b[${color === "selectedBg" ? 44 : 100}m`,
	bold: identity,
} as Theme;

class EditorSpy extends Editor {
	keyInputs: string[] = [];
	mouseInputs: TuiMouseEvent[] = [];
	override handleInput(data: string) { this.keyInputs.push(data); super.handleInput(data); }
	override handleMouse(event: TuiMouseEvent) { this.mouseInputs.push(event); return super.handleMouse(event); }
}

function status(agentId: string, label: string, parent: string | null = "owner"): AgentRosterStatus {
	return {
		agentId, label, workflowId: "owner", directSpawnerAgentId: parent,
		description: label + " informational details",
		primaryEvidence: { transcriptPath: null, inspectedThrough: { agentId, entryId: "entry-" + agentId } },
		run: { phase: "live", work: "settled", attention: "none", retentionReasons: [] },
		model: { provider: "test", modelId: "model" }, thinking: "off", compacting: false, queuedInputCount: 0,
	};
}
const roster = [
	status("owner", "Owner", null), status("branch", "Branch"),
	status("other", "Other"), status("nested", "Nested", "branch"),
	status("leaf", "Leaf", "nested"),
];
const sleeping: AgentRosterStatus = { ...status("sleeping", "Sleeping"), run: { phase: "dormant" as const, retentionReasons: [] } };

async function harness(t: TestContext, options: Partial<AgentSelectorOptions> = {}, mode: "fullscreen" | "regular" = "fullscreen") {
	const terminal = new ScreenTerminal();
	const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
	const editor = new EditorSpy(tui, {
		borderColor: identity,
		selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
	});
	editor.setText("ROOT EDITOR");
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.start();
	let component: (Component & { dispose?(): void }) | undefined;
	let overlay: OverlayHandle | undefined;
	let resolved = false;
	const ui = {
		custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => Component,
			config: { overlayOptions?: OverlayOptions }) {
			return new Promise<T>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, (value) => {
					resolved = true; overlay?.hide(); component?.dispose?.(); resolve(value);
				});
				overlay = tui.showOverlay(component, config.overlayOptions);
			});
		},
	} as unknown as ExtensionUIContext;
	const result = openAgentSelectorSurface(ui, { live: roster, dormant: [sleeping], selectedAgentId: "branch", ...options });
	async function frame() { tui.renderNow(); await terminal.flush(); return terminal.lines(); }
	async function input(data: string) { terminal.input(data); await frame(); }
	async function point(text: string, offset = 0) {
		const lines = await frame();
		const y = lines.findIndex((line) => line.includes(text));
		assert.ok(y >= 0, "Missing visible target " + text + "\n" + lines.join("\n"));
		return { x: visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf(text))) + offset, y };
	}
	async function click(text: string, offset = 0, button = 0) {
		const { x, y } = await point(text, offset);
		terminal.mouse(button, x, y);
		terminal.mouse(button, x, y, true);
		await frame();
	}
	t.after(() => { component?.dispose?.(); overlay?.hide(); tui.stop(); terminal.screen.dispose(); });
	await frame();
	return { terminal, tui, editor, result, frame, input, point, click, get resolved() { return resolved; }, get overlay() { return overlay; } };
}

test("fullscreen pointer tabs, Owner and summary actions use terminal mouse dispatch", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	await h.click("Dormant");
	assert.match((await h.frame()).join("\n"), /→ Sleeping/);
	await h.click("Live");
	assert.match((await h.frame()).join("\n"), /→ Branch/);
	await h.click("Other");
	assert.equal(h.resolved, true);
	assert.deepEqual(await h.result, { kind: "select_agent", agentId: "other" });

	const owner = await harness(t);
	await owner.click("Go to Owner [o]", 2);
	assert.equal(owner.resolved, true);
	assert.deepEqual(await owner.result, { kind: "select_agent", agentId: "owner" });
});

test("the entire child control browses, ancestors and Agents heading return to their scopes", { timeout: 5_000 }, async (t) => {
	for (const offset of [0, 3, 7, 8]) {
		const h = await harness(t);
		await h.click("1 child ›", offset);
		assert.equal(h.resolved, false);
		assert.match((await h.frame()).join("\n"), /→ Nested/);
		await h.click("1 child ›", 3);
		assert.match((await h.frame()).join("\n"), /→ Leaf/);
		await h.click("Branch");
		assert.match((await h.frame()).join("\n"), /→ Nested/);
		await h.click("Agents");
		assert.match((await h.frame()).join("\n"), /→ Branch/);
		await h.input("\x1b");
	}
});

test("hover highlights without moving keyboard selection; details and other buttons are inert", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	const other = await h.point("Other");
	const before = h.terminal.screen.buffer.active.getLine(other.y)!.getCell(other.x)!.getBgColor();
	h.terminal.mouse(35, other.x, other.y);
	await h.frame();
	const after = h.terminal.screen.buffer.active.getLine(other.y)!.getCell(other.x)!.getBgColor();
	assert.notEqual(after, before, "hover should visibly highlight the target");
	assert.match((await h.frame()).join("\n"), /→ Branch/);
	for (const button of [1, 2]) {
		await h.click("Other", 1, button);
		await h.click("Dormant", 1, button);
		await h.click("Owner", 1, button);
		await h.click("1 child ›", 3, button);
	}
	await h.click("Branch informational details");
	assert.equal(h.resolved, false);
	await h.input("\r");
	assert.deepEqual(await h.result, { kind: "select_agent", agentId: "branch" });
});

test("wheel scrolls the selected roster entry", { timeout: 5_000 }, async (t) => {
	const live = [status("owner", "Owner", null), ...Array.from({ length: 25 }, (_, i) => status("agent-" + String(i).padStart(2, "0"), "Agent " + String(i).padStart(2, "0")))];
	const h = await harness(t, { live, selectedAgentId: "agent-05" });
	assert.match((await h.frame()).join("\n"), /→ Agent 05/);
	assert.match((await h.frame()).join("\n"), /agent-05/);

	// Chrome wheel is handled but does not move selection.
	for (const target of ["Live", "Go to Owner", "agent-05", "Tab views"]) {
		const p = await h.point(target);
		h.terminal.mouse(65, p.x, p.y);
		h.terminal.mouse(64, p.x, p.y);
		await h.frame();
		assert.match((await h.frame()).join("\n"), /→ Agent 05/);
	}

	// Wheel down moves selection one row per event; details follow the new selection.
	let selected = await h.point("Agent 05");
	for (let step = 0; step < 2; step++) h.terminal.mouse(65, selected.x, selected.y);
	await h.frame();
	assert.match((await h.frame()).join("\n"), /→ Agent 07/);
	assert.match((await h.frame()).join("\n"), /agent-07/);

	// Wheel up moves selection back.
	selected = await h.point("Agent 07");
	for (let step = 0; step < 2; step++) h.terminal.mouse(64, selected.x, selected.y);
	await h.frame();
	assert.match((await h.frame()).join("\n"), /→ Agent 05/);
	assert.match((await h.frame()).join("\n"), /agent-05/);

	// Wheel at the top bound stays put without wrapping.
	const top = await harness(t, { live, selectedAgentId: "agent-00" });
	assert.match((await top.frame()).join("\n"), /→ Agent 00/);
	const topPoint = await top.point("Agent 00");
	for (let step = 0; step < 5; step++) top.terminal.mouse(64, topPoint.x, topPoint.y);
	await top.frame();
	assert.match((await top.frame()).join("\n"), /→ Agent 00/);
	await top.input("\x1b");

	// Wheel at the bottom bound does not wrap to the top.
	const bottom = await harness(t, { live, selectedAgentId: "agent-24" });
	const bottomPoint = await bottom.point("Agent 24");
	for (let step = 0; step < 5; step++) bottom.terminal.mouse(65, bottomPoint.x, bottomPoint.y);
	await bottom.frame();
	const bottomFrame = (await bottom.frame()).join("\n");
	assert.ok(bottomFrame.includes("Go to Owner"), "bottom bound reaches Owner footer\n" + bottomFrame);
	assert.doesNotMatch(bottomFrame, /→ Agent 00/);
	await bottom.input("\x1b");

	// Scrolling far moves selection and keeps hit targets correct after resizing.
	for (let step = 0; step < 12; step++) {
		const lines = await h.frame();
		const row = lines.find((line) => line.includes("→ Agent"))!;
		const q = await h.point(row.trim().replace(/^│\s*/, "").split("  ")[0]!);
		h.terminal.mouse(65, q.x, q.y);
		await h.frame();
	}
	assert.doesNotMatch((await h.frame()).join("\n"), /→ Agent 05/);
	for (const [columns, rows] of [[46, 15], [24, 10], [120, 30]]) {
		h.terminal.resize(columns!, rows!);
		const lines = await h.frame();
		const topIdx = lines.findIndex((line) => line.includes("┌"));
		const bottomIdx = lines.findIndex((line) => line.includes("└"));
		assert.ok(topIdx >= 1 && bottomIdx < rows! - 1, "panel retains terminal margins");
		assert.ok(bottomIdx - topIdx + 1 <= Math.floor(rows! * 0.9));
		const left = lines[topIdx]!.indexOf("┌");
		const right = lines[topIdx]!.indexOf("┐");
		assert.ok(right - left + 1 <= Math.min(80, columns!));
		assert.equal(left, Math.floor((columns! - (right - left + 1)) / 2));
	}
	const lines = await h.frame();
	const selectedLabel = lines.find((line) => line.includes("→ Agent"))!.match(/Agent (\d+)/)![1]!;
	await h.click("Agent " + selectedLabel);
	assert.equal(h.resolved, true);
	assert.deepEqual(await h.result, { kind: "select_agent", agentId: "agent-" + selectedLabel });

	// Tiny rosters keep selection at the scroll bound.
	const tiny = await harness(t, {
		live: [status("owner", "Owner", null), status("tiny", "Tiny")],
		selectedAgentId: "tiny",
	});
	const tinyTarget = await tiny.point("Tiny");
	tiny.terminal.mouse(65, tinyTarget.x, tinyTarget.y);
	tiny.terminal.mouse(64, tinyTarget.x, tinyTarget.y);
	await tiny.frame();
	assert.match((await tiny.frame()).join("\n"), /→ Tiny/, "tiny rosters keep their selection at the scroll bound");
	await tiny.input("\x1b");
});

test("async preparation retains keyboard focus and blocks pointer actions inside the panel", { timeout: 5_000 }, async (t) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const actions: AgentSelectorAction[] = [];
	const h = await harness(t, { prepareSelection(action) { actions.push(action); return pending; } });
	try {
		await h.click("Branch");
		assert.equal(actions.length, 1);
		assert.equal(h.resolved, false);
		const bounds = h.overlay!.getBounds()!;
		assert.equal(bounds.width, 80);
		assert.ok(bounds.row > 0 && bounds.height < h.terminal.rows);
		assert.match((await h.frame()).join("\n"), /ROOT EDITOR/);
		for (const [x, y] of [[bounds.col, bounds.row], [bounds.col + bounds.width - 1, bounds.row + bounds.height - 1]]) {
			for (const button of [0, 1, 2]) {
				h.terminal.mouse(button, x!, y!);
				h.terminal.mouse(button, x!, y!, true);
			}
			h.terminal.mouse(65, x!, y!);
		}
		await h.input("z");
		await h.input("\r");
		await h.input("\x1b");
		await h.click("Other");
		await h.click("Dormant");
		assert.equal(actions.length, 1);
		assert.equal(h.resolved, false);
		assert.deepEqual(h.editor.mouseInputs, []);
		assert.deepEqual(h.editor.keyInputs, []);
		assert.equal(h.editor.getText(), "ROOT EDITOR");
	} finally { release(); }
	assert.deepEqual(await h.result, { kind: "select_agent", agentId: "branch" });
	await h.input("z");
	assert.deepEqual(h.editor.keyInputs, ["z"], "closing restores the mounted Editor focus");
});

test("preparation feedback survives resizing the roster viewport", { timeout: 5_000 }, async (t) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const live = [status("owner", "Owner", null), ...Array.from({ length: 20 }, (_, i) => status("agent-" + i, "Agent " + i))];
	const h = await harness(t, { live, selectedAgentId: "agent-0", prepareSelection: () => pending });
	try {
		await h.click("Agent 1");
		h.terminal.resize(80, 15);
		assert.match((await h.frame()).join("\n"), /→ Agent 1\s+⠋ loading/);
		assert.equal(h.overlay?.getBounds()?.width, 80);
		assert.ok(h.overlay!.getBounds()!.height < 15);
	} finally { release(); }
	await h.result;
});

test("visible breadcrumb cells navigate; current segments go to their parent", { timeout: 5_000 }, async (t) => {
	const live = [
		status("owner", "Owner", null), status("alpha", "Alpha"),
		status("beta", "研究", "alpha"), status("gamma", "Gamma", "beta"),
		status("delta", "Delta", "gamma"), status("leaf", "Leaf", "delta"),
	];
	const h = await harness(t, { live, selectedAgentId: "leaf" });
	await h.click("…");
	assert.match((await h.frame()).join("\n"), /→ Leaf/);
	// The current scope segment acts like Left/h: it selects that scope's
	// parent while keeping the current scope Agent selected in the roster.
	const current = await h.point("Delta");
	h.terminal.mouse(35, current.x, current.y);
	await h.frame();
	assert.equal(h.terminal.screen.buffer.active.getLine(current.y)!.getCell(current.x)!.getBgColor(), 8);
	h.terminal.mouse(0, current.x, current.y);
	h.terminal.mouse(0, current.x, current.y, true);
	await h.frame();
	assert.equal(h.resolved, false);
	assert.match((await h.frame()).join("\n"), /→ Delta/);
	const keyboard = await harness(t, { live, selectedAgentId: "leaf" });
	await keyboard.input("\x1b[D");
	assert.equal(keyboard.resolved, false);
	assert.match((await keyboard.frame()).join("\n"), /→ Delta/);
	await keyboard.input("\x1b");

	// Older visible ancestors retain their existing direct-scope navigation.
	const ancestor = await h.point("研究");
	h.terminal.mouse(0, ancestor.x + 2, ancestor.y);
	h.terminal.mouse(0, ancestor.x + 2, ancestor.y, true);
	await h.frame();
	assert.match((await h.frame()).join("\n"), /→ Gamma/);

	// A narrowed path may show a truncated current label, but that fragment
	// must not leave an unsafe parent hit target behind.
	const narrow = await harness(t, { live, selectedAgentId: "leaf" });
	narrow.terminal.resize(19, 15);
	await narrow.frame();
	await narrow.click("Delta");
	assert.match((await narrow.frame()).join("\n"), /→ Leaf/);
	assert.equal(narrow.resolved, false);
	await narrow.input("\x1b");
	await h.input("\x1b");

	const clipped = await harness(t);
	clipped.terminal.resize(12, 15);
	await clipped.frame();
	await clipped.click("1 child");
	assert.equal(clipped.resolved, false);
	clipped.terminal.resize(80, 30);
	assert.match((await clipped.frame()).join("\n"), /→ Branch/);
	// The blank cell immediately before the complete child control is a
	// separator, matching the gap between the Live/Dormant tabs.
	const child = await clipped.point("1 child ›");
	clipped.terminal.mouse(0, child.x - 1, child.y);
	clipped.terminal.mouse(0, child.x - 1, child.y, true);
	await clipped.frame();
	assert.equal(clipped.resolved, false);
	clipped.terminal.mouse(0, child.x - 2, child.y);
	clipped.terminal.mouse(0, child.x - 2, child.y, true);
	await clipped.frame();
	assert.deepEqual(await clipped.result, { kind: "select_agent", agentId: "branch" });
});

test("pointer opening is independent of confirmation bindings while keyboard uses them", { timeout: 5_000 }, async (t) => {
	const keybindings = getKeybindings();
	const previousBindings = keybindings.getUserBindings();
	t.after(() => keybindings.setUserBindings(previousBindings));
	keybindings.setUserBindings({
		...previousBindings,
		"tui.select.confirm": "space",
		"tui.select.down": "enter",
	});

	const agent = await harness(t);
	await agent.click("Other");
	assert.equal(agent.resolved, true, "Agent click must not dispatch a confirmation key");
	assert.deepEqual(await agent.result, { kind: "select_agent", agentId: "other" });

	const owner = await harness(t);
	await owner.click("Owner");
	assert.equal(owner.resolved, true);
	assert.deepEqual(await owner.result, { kind: "select_agent", agentId: "owner" });

	const attention = await harness(t, {
		humanAttention: [{ requestId: "decision", agentId: "branch", agentLabel: "Branch", question: "Proceed?" }],
	});
	await attention.click("DECIDE");
	assert.equal(attention.resolved, true);
	assert.deepEqual(await attention.result, { kind: "decide", requestId: "decision", agentId: "branch" });

	const keyboard = await harness(t);
	await keyboard.input("\r");
	assert.equal(keyboard.resolved, false, "rebound Enter moves selection rather than confirming");
	assert.match((await keyboard.frame()).join("\n"), /→ Other/);
	await keyboard.input(" ");
	assert.deepEqual(await keyboard.result, { kind: "select_agent", agentId: "other" });
});

for (const mode of ["fullscreen", "regular"] as const) {
	test(mode + " selector preserves the mounted chat outside its frame", { timeout: 5_000 }, async (t) => {
		const h = await harness(t, {}, mode);
		assert.match((await h.frame()).join("\n"), /ROOT EDITOR/);
		h.editor.setText("CHAT UPDATED UNDER SELECTOR");
		assert.match((await h.frame()).join("\n"), /CHAT UPDATED UNDER SELECTOR/);
	});
}

test("hover adds a faint background without changing foregrounds or selected backgrounds", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	for (const target of ["Owner", "Other", "Branch", "1 child ›", "Dormant"]) {
		const p = await h.point(target);
		const before = Array.from({ length: h.terminal.columns }, (_, x) => h.terminal.screen.buffer.active.getLine(p.y)!.getCell(x)!.getFgColor());
		h.terminal.mouse(35, p.x, p.y);
		await h.frame();
		const row = h.terminal.screen.buffer.active.getLine(p.y)!;
		const hovered = row.getCell(p.x)!;
		const background = target === "Branch" ? 4 : 8;
		assert.equal(hovered.getBgColor(), background, target + " uses the appropriate background");
		const right = row.translateToString(true).lastIndexOf("│");
		for (let x = right - 1; x < h.terminal.columns; x++) {
			assert.equal(row.getCell(x)!.isBgDefault(), true, target + " background ends before frame padding at " + x);
		}
		const end = target === "Other" ? right - 1
			: target === "Branch" ? row.translateToString(true).indexOf("1 child") - 1
			: p.x + visibleWidth(target);
		for (let x = p.x; x < end; x++) {
			assert.equal(row.getCell(x)!.getFgColor(), before[x], target + " retains its foreground at " + x);
			assert.equal(row.getCell(x)!.getBgColor(), background, target + " fills the pointed control at " + x);
		}
		if (target === "Owner") {
			assert.equal(row.getCell(p.x + "Owner [o]".length)!.isBgDefault(), true, "Owner hover must stop after its shortcut");
		}
	}
});

test("hovering a keyboard-focused Owner does not paint the rest of its row", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	await h.input("j");
	await h.input("j");
	const p = await h.point("Go to Owner [o]");
	h.terminal.mouse(35, p.x, p.y);
	await h.frame();
	const row = h.terminal.screen.buffer.active.getLine(p.y)!;
	for (let x = p.x + "Go to Owner [o]".length; x < h.terminal.columns; x++) {
		assert.equal(row.getCell(x)!.isBgDefault(), true, "Owner background leaked to column " + x);
	}
});

test("row and child button expose separate bounded hover actions", { timeout: 5_000 }, async (t) => {
	const h = await harness(t, { selectedAgentId: "other" });
	const body = await h.point("Branch");
	const child = await h.point("1 child ›");
	const selected = await h.point("Other");
	const bg = (x: number, y: number) => h.terminal.screen.buffer.active.getLine(y)!.getCell(x)!.getBgColor();
	assert.equal(bg(selected.x, selected.y), 4, "keyboard-selected row has the stronger background");
	h.terminal.mouse(35, body.x, body.y);
	await h.frame();
	assert.equal(bg(body.x, body.y), 8);
	assert.equal(
		h.terminal.screen.buffer.active.getLine(child.y)!.getCell(child.x - 1)!.isBgDefault(),
		true,
		"the one-cell margin before child navigation stays unhighlighted",
	);
	assert.equal(bg(child.x - 2, child.y), 8, "open action reaches the margin boundary");
	assert.equal(h.terminal.screen.buffer.active.getLine(child.y)!.getCell(child.x)!.isBgDefault(), true);
	h.terminal.mouse(35, child.x, child.y);
	await h.frame();
	assert.equal(h.terminal.screen.buffer.active.getLine(body.y)!.getCell(body.x)!.isBgDefault(), true);
	for (let x = child.x; x < child.x + "1 child ›".length; x++) assert.equal(bg(x, child.y), 8);
	assert.equal(bg(selected.x, selected.y), 4, "child hover does not replace selection");
	// The margin is a true separator, matching the Live/Dormant tab gap.
	h.terminal.mouse(0, child.x - 1, child.y);
	h.terminal.mouse(0, child.x - 1, child.y, true);
	await h.frame();
	assert.equal(h.resolved, false, "the margin must not activate the row");
	await h.click("1 child ›", 8);
	assert.equal(h.resolved, false);
	assert.match((await h.frame()).join("\n"), /→ Nested/);
});

test("selected tabs and Owner retain selection color when hovered", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	await h.input("j");
	await h.input("j");
	for (const target of ["Live", "Owner"]) {
		const p = await h.point(target);
		const before = h.terminal.screen.buffer.active.getLine(p.y)!.getCell(p.x)!;
		const foreground = before.getFgColor();
		assert.equal(before.getBgColor(), 4);
		h.terminal.mouse(35, p.x, p.y);
		await h.frame();
		const after = h.terminal.screen.buffer.active.getLine(p.y)!.getCell(p.x)!;
		assert.equal(after.getBgColor(), 4);
		assert.equal(after.getFgColor(), foreground);
	}
	await h.click("Dormant");
	const p = await h.point("Dormant");
	assert.equal(h.terminal.screen.buffer.active.getLine(p.y)!.getCell(p.x)!.getBgColor(), 4);
});

test("truncated Agent summaries keep tint through their padding without swallowing the child button", { timeout: 5_000 }, async (t) => {
	const h = await harness(t, {
		live: [status("owner", "Owner", null), status("branch", "Long ".repeat(30)), status("other", "Other"), status("child", "Child", "branch")],
		selectedAgentId: "other",
	});
	h.terminal.resize(46, 30);
	const p = await h.point("Long ");
	const child = await h.point("1 child ›");
	h.terminal.mouse(35, p.x, p.y);
	await h.frame();
	const row = h.terminal.screen.buffer.active.getLine(p.y)!;
	for (let x = p.x; x < child.x - 1; x++) assert.equal(row.getCell(x)!.getBgColor(), 8);
	assert.equal(row.getCell(child.x - 1)!.isBgDefault(), true, "summary padding ends before the separator");
	assert.equal(row.getCell(child.x)!.isBgDefault(), true);
});

test("dormant-only children expose no child-navigation control, including Owner", { timeout: 5_000 }, async (t) => {
	const h = await harness(t, { live: [status("owner", "Owner", null)], dormant: [sleeping], selectedAgentId: "owner" });
	assert.doesNotMatch((await h.frame()).join("\n"), /›|\d+ child/);
	await h.input("l");
	assert.doesNotMatch((await h.frame()).join("\n"), /›|\d+ child/);
	const owner = await h.point("Go to Owner* [o]");
	// The cell after the complete footer action is informational.
	h.terminal.mouse(0, owner.x + "Go to Owner* [o]".length, owner.y);
	h.terminal.mouse(0, owner.x + "Go to Owner* [o]".length, owner.y, true);
	await h.frame();
	assert.equal(h.resolved, false);

	const parent = await harness(t, {
		live: [status("owner", "Owner", null), status("branch", "Branch")],
		dormant: [{ ...sleeping, directSpawnerAgentId: "branch" }],
		selectedAgentId: "branch",
	});
	assert.doesNotMatch((await parent.frame()).join("\n"), /\d+ child/);
	await parent.input("l");
	assert.match((await parent.frame()).join("\n"), /→ Branch/);
	// Without a child button, the trailing content remains part of the open action.
	const p = await parent.point("Branch");
	const right = (await parent.frame())[p.y]!.lastIndexOf("│");
	parent.terminal.mouse(0, right - 2, p.y);
	parent.terminal.mouse(0, right - 2, p.y, true);
	await parent.frame();
	assert.deepEqual(await parent.result, { kind: "select_agent", agentId: "branch" });
});

test("mixed children count and browse only the live roster, including idle children", { timeout: 5_000 }, async (t) => {
	const h = await harness(t, {
		live: [status("owner", "Owner", null), status("branch", "Branch"), status("child", "Idle Child", "branch")],
		dormant: [{ ...sleeping, directSpawnerAgentId: "branch" }],
		selectedAgentId: "branch",
	});
	assert.match((await h.frame()).join("\n"), /1 child ›/);
	await h.click("1 child ›");
	assert.match((await h.frame()).join("\n"), /→ Idle Child/);
	assert.doesNotMatch((await h.frame()).join("\n"), /Sleeping/);
	await h.click("Agents");
	assert.match((await h.frame()).join("\n"), /→ Branch/);
});

test("text buttons are bracket-free and neighboring actions stay independent", { timeout: 5_000 }, async (t) => {
	const h = await harness(t, { live: [...roster, status("custom", "[Custom]")] });
	const lines = await h.frame();
	assert.doesNotMatch(lines.join("\n"), /\[Owner\]|\[›\]|\[1 child ›\]/);
	assert.match(lines.join("\n"), /Agents/);
	assert.match(lines.join("\n"), /1 child ›/);
	assert.match(lines.join("\n"), /\[Custom\]/, "user-provided label brackets are preserved");
	const owner = await h.point("Go to Owner [o]");
	h.terminal.mouse(0, owner.x + "Go to Owner [o]".length, owner.y);
	h.terminal.mouse(0, owner.x + "Go to Owner [o]".length, owner.y, true);
	await h.frame();
	assert.equal(h.resolved, false, "separator is not an Owner action");
	await h.click("1 child ›", "1 child ›".length - 1);
	assert.match((await h.frame()).join("\n"), /→ Nested/);
	await h.click("Agents");
	assert.match((await h.frame()).join("\n"), /→ Branch/);
	await h.click("Owner", "Owner".length - 1);
	assert.deepEqual(await h.result, { kind: "select_agent", agentId: "owner" });
});
