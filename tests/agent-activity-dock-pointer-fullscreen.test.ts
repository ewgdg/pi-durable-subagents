import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	Spacer,
	TuiAltScreen,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import type { AgentRosterStatus } from "../src/coordination/workflow-coordinator.ts";
import {
	AgentActivityDock,
	type AgentActivitySnapshot,
} from "../src/presentation/agent-activity-surface.ts";
import { ScreenTerminal } from "./support/screen-terminal.ts";

const identity = (text: string) => text;
const theme = {
	fg: (_color: string, text: string) => text,
	bold: identity,
} as Theme;

class EditorSpy extends Editor {
	mouseInputs: TuiMouseEvent[] = [];
	override handleMouse(event: TuiMouseEvent) {
		this.mouseInputs.push(event);
		return super.handleMouse(event);
	}
}

function agent(options: {
	agentId: string;
	label: string;
	parent: string | null;
}): AgentRosterStatus {
	return {
		agentId: options.agentId,
		workflowId: "owner",
		label: options.label,
		directSpawnerAgentId: options.parent,
		primaryEvidence: {
			transcriptPath: null,
			inspectedThrough: { agentId: options.agentId, entryId: `${options.agentId}-tail` },
		},
		run: { phase: "live", work: "settled", attention: "none", retentionReasons: [] },
		model: { provider: "anthropic", modelId: "claude-sonnet-4" },
		thinking: "high",
		compacting: false,
		queuedInputCount: 0,
	};
}

/** Mount the dock the way the host does: a widget container above the editor. */
async function harness(t: { after(callback: () => void): void }) {
	const terminal = new ScreenTerminal();
	const tui = new TuiAltScreen(terminal);
	let opened = 0;
	const dock = new AgentActivityDock(
		tui,
		theme,
		{
			snapshot: (): AgentActivitySnapshot => ({
				scope: { ...agent({ agentId: "owner", label: "Owner", parent: null }), failed: false },
				children: [{
					...agent({ agentId: "child", label: "Child", parent: "owner" }),
					failed: false,
				}],
				answerMode: false,
				humanAttention: [],
				operationalAttention: [],
			}),
			addChangeHandler: () => () => {},
		},
		{ openAgentsMenu: () => opened += 1 },
	);
	const widgetContainer = new Container();
	widgetContainer.addChild(new Spacer(1));
	widgetContainer.addChild(dock);
	const editor = new EditorSpy(tui, {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	});
	editor.setText("ROOT EDITOR");
	tui.addChild(widgetContainer);
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.start();
	t.after(() => {
		dock.dispose();
		tui.stop();
		terminal.screen.dispose();
	});
	async function frame() {
		tui.renderNow();
		await terminal.flush();
		return terminal.lines();
	}
	async function dockPoint(text: string) {
		const lines = await frame();
		const y = lines.findIndex((line) => line.includes(text));
		assert.ok(y >= 0, `Missing dock row ${text}\n${lines.join("\n")}`);
		return { x: 2, y };
	}
	return {
		terminal,
		editor,
		frame,
		dockPoint,
		opened: () => opened,
		async click(text: string) {
			const { x, y } = await dockPoint(text);
			terminal.mouse(0, x, y);
			terminal.mouse(0, x, y, true);
			await frame();
		},
	};
}

test("a fullscreen primary click on the activity dock opens the Agents menu", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	const lines = await h.frame();
	assert.match(lines.join("\n"), /Agents/);
	assert.match(lines.join("\n"), /Child/);

	await h.click("Agents");
	assert.equal(h.opened(), 1, "the heading row is part of the dock target");
	await h.click("Child");
	assert.equal(h.opened(), 2, "each rendered dock row opens the menu");
	assert.equal(h.editor.mouseInputs.length, 0, "handled dock clicks must not reach the mounted editor");
});

test("the activity dock keeps drag-selection and non-primary buttons native", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	const { x, y } = await h.dockPoint("Child");

	// A drag is a text selection, never a dock activation.
	h.terminal.mouse(0, x, y);
	h.terminal.mouse(32, x + 8, y);
	h.terminal.mouse(0, x + 8, y, true);
	await h.frame();
	assert.equal(h.opened(), 0);

	for (const button of [1, 2]) {
		h.terminal.mouse(button, x, y);
		h.terminal.mouse(button, x, y, true);
		await h.frame();
	}
	assert.equal(h.opened(), 0, "middle and secondary buttons have no dock action");
	assert.equal(h.editor.mouseInputs.length, 0);
});
