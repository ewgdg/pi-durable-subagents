// Regenerate docs/images/agent-switcher.png, the README and Pi gallery screenshot.
//
// Opens the real Agent selector over a staged demo roster with Pi's dark theme,
// replays its ANSI output through a headless xterm, and rasterizes the cell grid
// with rsvg-convert. No model, Pi session, or real terminal is involved.
//
// Usage: node docs/images/agent-switcher.capture.ts   (needs rsvg-convert; Noto Sans Mono for a stable look)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";

import type { AgentRosterStatus } from "../../src/coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface } from "../../src/presentation/agent-selector-surface.ts";

const OUTPUT_PATH = fileURLToPath(new URL("./agent-switcher.png", import.meta.url));
const TERMINAL_COLUMNS = 80;
const TERMINAL_ROWS = 20;
// Arrow keys sent before capture: move focus from the Attention Inbox to Architecture.
const KEYS = ["\x1b[B"];

// Terminal palette around the theme's own colors; the theme leaves body text on the default foreground.
const BACKDROP = "#24262b";
const DEFAULT_FOREGROUND = "#d4d4d4";
const FONT_FAMILY = "Noto Sans Mono";
const FONT_SIZE = 14;
const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 20;
const PADDING_CELLS = { x: 3, y: 2 };
const ZOOM = 2;

const owner = demoAgent({ agentId: "owner", label: "Owner", spawner: null });
const architecture = demoAgent({
	agentId: "agent-architecture-31d5b9f2",
	label: "Architecture",
	description: "Designs the agent coordination protocol",
	spawner: "owner",
	work: "active",
	attention: "agent_wait",
	retention: ["awaiting_answer"],
	modelId: "claude-opus-5-5",
	thinking: "high",
});
const schemaReview = demoAgent({
	agentId: "agent-schema-review-8a02c4e1",
	label: "Schema review",
	spawner: architecture.agentId,
	work: "active",
	retention: ["answer_owed"],
});
const implementation = demoAgent({
	agentId: "agent-implementation-5c7e19aa",
	label: "Implementation",
	spawner: "owner",
	work: "settled",
	attention: "input_required",
});

const panel = await renderSelector();
const svg = await rasterizableSvg(panel);
const rsvg = spawnSync("rsvg-convert", ["--zoom", String(ZOOM), "--format", "png", "--output", OUTPUT_PATH], {
	input: svg,
	stdio: ["pipe", "inherit", "inherit"],
});
if (rsvg.error) throw rsvg.error;
if (rsvg.status !== 0) throw new Error(`rsvg-convert exited with ${rsvg.status}`);
console.log(`wrote ${OUTPUT_PATH}`);

async function renderSelector(): Promise<string[]> {
	const theme = await darkTheme();
	const tui = { terminal: { rows: TERMINAL_ROWS }, requestRender() {} } as unknown as TUI;
	let component: Component | undefined;
	const ui = {
		custom<T>(
			factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
		): Promise<T> {
			return new Promise<T>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, resolve);
			});
		},
	} as unknown as ExtensionUIContext;
	void openAgentSelectorSurface(ui, {
		live: [owner, architecture, schemaReview, implementation],
		dormant: [],
		selectedAgentId: owner.agentId,
		configAvailable: true,
		humanAttention: [{
			requestId: "human-request-2f9c",
			agentId: implementation.agentId,
			agentLabel: implementation.label,
			question: "Keep the v1 wire format, or migrate now?",
		}],
	});
	await Promise.resolve();
	if (!component) throw new Error("the Agent selector did not mount");
	for (const key of KEYS) component.handleInput?.(key);
	const lines = component.render(TERMINAL_COLUMNS);
	component.handleInput?.("\x1b"); // Esc closes the overlay so nothing keeps the process alive.
	return lines;
}

/** Pi's built-in dark theme in truecolor, independent of the capturing terminal. */
async function darkTheme(): Promise<Theme> {
	// The package exports only its entry point; the theme loader lives beside it.
	const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const themeModule = await import(new URL("./modes/interactive/theme/theme.js", entry).href) as {
		loadThemeFromPath(path: string, mode: "truecolor"): Theme;
	};
	return themeModule.loadThemeFromPath(
		fileURLToPath(new URL("./modes/interactive/theme/dark.json", entry)),
		"truecolor",
	);
}

type DemoAgent = Readonly<{
	agentId: string;
	label: string;
	description?: string;
	spawner: string | null;
	work?: "active" | "settled";
	attention?: "none" | "input_required" | "agent_wait";
	retention?: readonly ("awaiting_answer" | "answer_owed")[];
	modelId?: string;
	thinking?: AgentRosterStatus["thinking"];
}>;

function demoAgent(agent: DemoAgent): AgentRosterStatus {
	return {
		agentId: agent.agentId,
		workflowId: "owner",
		label: agent.label,
		...(agent.description ? { description: agent.description } : {}),
		directSpawnerAgentId: agent.spawner,
		primaryEvidence: {
			transcriptPath: null,
			inspectedThrough: { agentId: agent.agentId, entryId: "entry" },
		},
		run: {
			phase: "live",
			work: agent.work ?? "settled",
			attention: agent.attention ?? "none",
			retentionReasons: (agent.retention ?? []).map((reason) => ({ reason, count: 1 })),
		},
		model: { provider: "anthropic", modelId: agent.modelId ?? "claude-sonnet-5-5" },
		thinking: agent.thinking ?? "medium",
		compacting: false,
		queuedInputCount: 0,
	};
}

/** Replays ANSI lines through xterm so SGR parsing matches a real terminal, then paints each cell. */
async function rasterizableSvg(lines: readonly string[]): Promise<string> {
	const columns = TERMINAL_COLUMNS + PADDING_CELLS.x * 2;
	const rows = lines.length + PADDING_CELLS.y * 2;
	const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
	const padded = lines.map((line) => " ".repeat(PADDING_CELLS.x) + line);
	await new Promise<void>((resolve) =>
		terminal.write("\r\n".repeat(PADDING_CELLS.y) + padded.join("\r\n"), resolve)
	);
	const width = columns * CELL_WIDTH;
	const height = rows * CELL_HEIGHT;
	const shapes: string[] = [`<rect width="${width}" height="${height}" fill="${BACKDROP}"/>`];
	const buffer = terminal.buffer.active;
	for (let row = 0; row < rows; row += 1) {
		const line = buffer.getLine(row);
		if (!line) continue;
		for (let column = 0; column < columns; column += 1) {
			const cell = line.getCell(column);
			if (!cell || cell.getWidth() === 0) continue;
			const x = column * CELL_WIDTH;
			const y = row * CELL_HEIGHT;
			const cellWidth = CELL_WIDTH * cell.getWidth();
			const foreground = cell.isFgRGB() ? hexColor(cell.getFgColor()) : DEFAULT_FOREGROUND;
			if (cell.isBgRGB()) {
				shapes.push(`<rect x="${x}" y="${y}" width="${cellWidth}" height="${CELL_HEIGHT}" fill="${hexColor(cell.getBgColor())}"/>`);
			}
			const character = cell.getChars();
			if (!character.trim()) continue;
			const opacity = cell.isDim() ? ` opacity="0.6"` : "";
			const box = boxDrawing(character, x, y, cellWidth, foreground);
			if (box) {
				shapes.push(box);
				continue;
			}
			const weight = cell.isBold() ? ` font-weight="bold"` : "";
			shapes.push(
				`<text x="${x}" y="${y + CELL_HEIGHT * 0.72}" fill="${foreground}"${weight}${opacity}>${escapeXml(character)}</text>`,
			);
		}
	}
	terminal.dispose();
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`,
		` font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" xml:space="preserve">`,
		...shapes,
		"</svg>",
	].join("\n");
}

/** Font box-drawing glyphs rarely span the full cell height, so frame edges are drawn as strokes. */
function boxDrawing(character: string, x: number, y: number, width: number, color: string): string | undefined {
	const midX = x + width / 2;
	const midY = y + CELL_HEIGHT / 2;
	const right = x + width;
	const bottom = y + CELL_HEIGHT;
	const path = {
		"─": `M${x} ${midY}H${right}`,
		"│": `M${midX} ${y}V${bottom}`,
		"┌": `M${right} ${midY}H${midX}V${bottom}`,
		"┐": `M${x} ${midY}H${midX}V${bottom}`,
		"└": `M${midX} ${y}V${midY}H${right}`,
		"┘": `M${midX} ${y}V${midY}H${x}`,
	}[character];
	return path && `<path d="${path}" stroke="${color}" stroke-width="1.2" fill="none"/>`;
}

function hexColor(rgb: number): string {
	return `#${rgb.toString(16).padStart(6, "0")}`;
}

function escapeXml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
