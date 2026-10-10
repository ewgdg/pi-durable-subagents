import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	SelectList,
	compositeTuiLine,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import type { ReportHistoryItem } from "../protocol/moderator-report.ts";
import { sanitizeReportTerminalText } from "./moderator-report-surface.ts";
import type { AgentRosterStatus } from "../coordination/workflow-coordinator.ts";
import type { AgentRunSuspension } from "../runtime/agent-runtime-supervisor.ts";
import {
	formatAttentionLiveStatus,
	formatOperationalIncidentHeadline,
	operationalIncidentRequestEvidence,
} from "./operational-incident-surface.ts";
import {
	agentSelectorView,
	applyAgentSelectorIntent,
	openAgentSelector,
	type AgentSelectorAction,
	type AgentSelectorEmptyState,
	type AgentSelectorIntent,
	type AgentSelectorRosterUpdate,
	type AgentSelectorRow,
	type AgentSelectorSnapshot,
	type AgentSelectorState,
	type AgentSelectorTab,
	type AgentSelectorView,
} from "./agent-selector-projection.ts";
import { boundedToolPreview } from "../tools/bounded-preview.ts";
import { frameLine } from "./overlay-frame.ts";
import {
	formatAgentWorkStatus,
	SUSPENSION_LABEL,
	selectedAgentWorkStatus,
} from "./selected-agent-status.ts";

const AGENT_SELECTOR_OVERLAY_WIDTH = 80;
const AGENT_SELECTOR_OVERLAY_MARGIN = 1;
const AGENT_SELECTOR_OVERLAY_MAX_HEIGHT_PERCENT = 90;
const MAX_VISIBLE_ROSTER_ROWS = 10;
const MAX_BREADCRUMB_AGENT_SEGMENTS = 3;
const FOCUSED_DETAIL_ROWS = 4;
const FRAME_ROWS = 2;
const TAB_ROWS = 1;
const CONTENT_GAP_ROWS = 2;
const HELP_ROWS = 1;
const OWNER_FOOTER_ROWS = 1;
const MAX_LIVE_SECTION_HEADER_ROWS = 2;
const EMPTY_LIVE_AGENT_ROWS = 1;
const FIXED_OVERLAY_ROWS =
	FRAME_ROWS + TAB_ROWS + CONTENT_GAP_ROWS + HELP_ROWS + OWNER_FOOTER_ROWS +
	MAX_LIVE_SECTION_HEADER_ROWS + EMPTY_LIVE_AGENT_ROWS + FOCUSED_DETAIL_ROWS;
const SCROLL_INDICATOR_ROWS = 1;
const SELECTION_SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
] as const;
const SELECTION_SPINNER_INTERVAL_MILLISECONDS = 80;
const QUARANTINED_DESCRIPTION = "Quarantined · transcript excluded from recovery";
const TAB_LABELS = { live: "Live", dormant: "Dormant", reports: "Reports", quarantined: "Quarantined" } as const;
const EMPTY_STATE_TEXT: Readonly<Record<AgentSelectorEmptyState, string>> = {
	no_live_agents: "  No live Agents",
	no_dormant_agents: "  No dormant Agents",
	no_reports: "  No reports",
	no_quarantined_agents: "  No quarantined Agents",
};

// One physical wheel tick can arrive as several same-direction wheel events
// (high-rate terminals, multiplexer re-emission). Repeats inside this window
// collapse into a single step so one tick always moves exactly one entry.
const WHEEL_TICK_WINDOW_MS = 30;

export type AgentSelectorOptions = AgentSelectorSnapshot & Readonly<{
	addChangeHandler?(handler: (update: AgentSelectorRosterUpdate) => void): () => void;
	setReportRead?(reportId: string, read: boolean): Promise<readonly ReportHistoryItem[]> | readonly ReportHistoryItem[];
	prepareSelection?(
		action: AgentSelectorAction,
		tui: TUI,
	): Promise<void> | void;
	onSelectionError?(error: unknown): void;
	/** Shows the Config entry (`c` or a click), which closes the selector with `open_config`. */
	configAvailable?: boolean;
	/** Clock for wheel-tick coalescing; defaults to Date.now. Tests inject a fake. */
	now?: () => number;
}>;

/** How the selector closes: a chosen action, the Config entry, or nothing. */
export type AgentSelectorResult = AgentSelectorAction | Readonly<{ kind: "open_config" }> | undefined;

/** A projection row prepared for painting through Pi's list row renderer. */
type AgentSelectorItem = SelectItem & Readonly<{
	row: AgentSelectorRow;
	childControl?: string;
}>;

export function openAgentSelectorSurface(
	ui: ExtensionUIContext,
	options: AgentSelectorOptions,
): Promise<AgentSelectorResult> {
	return ui.custom<AgentSelectorResult>(
		(tui, theme, _keybindings, done) =>
			new AgentSelectorSurface(tui, theme, options, done),
		{
			overlay: true,
			overlayOptions: {
				width: AGENT_SELECTOR_OVERLAY_WIDTH,
				maxHeight: `${AGENT_SELECTOR_OVERLAY_MAX_HEIGHT_PERCENT}%`,
				anchor: "center",
				margin: { top: AGENT_SELECTOR_OVERLAY_MARGIN, bottom: AGENT_SELECTOR_OVERLAY_MARGIN },
			},
		},
	);
}

type PointerAction =
	| { kind: "root" }
	| { kind: "tab"; tab: AgentSelectorTab }
	| { kind: "config" }
	| { kind: "open"; value: string }
	| { kind: "children"; value: string }
	| { kind: "ancestor"; agentId: string; childId: string };

type LineRegion = Readonly<{ start: number; end: number; text: string; action: PointerAction }>;
type SelectorLine = Readonly<{ text: string; regions?: readonly LineRegion[]; roster?: boolean }>;
type HitRegion = LineRegion & Readonly<{ row: number }>;

/**
 * How an intent moves the roster viewport: a new list centres on its focus,
 * while focus moves and refreshes keep the current scroll position.
 */
type ScrollMode = "center" | "keep";

/**
 * Paints the Agent Selector projection and turns keys and pointer events into
 * its intents. Roster, tab, scope and focus rules live in the projection.
 */
class AgentSelectorSurface implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #done: (result: AgentSelectorResult) => void;
	readonly #options: AgentSelectorOptions;
	#state: AgentSelectorState;
	#view: AgentSelectorView;
	#removeChangeHandler: (() => void) | undefined;
	#visibleRows = 1;
	#rosterScrollOffset = 0;
	#lastWheelTime = Number.NEGATIVE_INFINITY;
	#lastWheelDirection = 0;
	#selectionPending = false;
	#hitRegions: HitRegion[] = [];
	#rosterRows = new Set<number>();
	#contentLeft = 0;
	#contentWidth = 0;
	#hoveredAction: PointerAction | undefined;
	#pressedAction: PointerAction | undefined;
	#selectionSpinnerFrame = 0;
	#selectionSpinnerTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		options: AgentSelectorOptions,
		done: (result: AgentSelectorResult) => void,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#done = done;
		this.#options = options;
		this.#state = openAgentSelector(options);
		this.#view = agentSelectorView(this.#state);
		this.#syncScroll("center");
		this.#removeChangeHandler = options.addChangeHandler?.((update) => {
			this.#apply({ kind: "roster_changed", update }, "keep");
			this.#tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (this.#selectionPending) return;
		this.#hoveredAction = undefined;
		const keybindings = getKeybindings();
		const liveTab = this.#view.activeTab === "live";
		if (matchesKey(data, Key.escape)) {
			this.#done(undefined);
		} else if (matchesKey(data, "m")) {
			void this.#toggleFocusedReportRead();
		} else if (this.#options.configAvailable && matchesKey(data, "c")) {
			this.#done({ kind: "open_config" });
		} else if (matchesKey(data, "o")) {
			void this.#completeSelection(this.#ownerRow().action, false);
		} else if (matchesKey(data, Key.tab)) {
			this.#apply({ kind: "next_tab" }, "center");
		} else if (matchesKey(data, Key.shift("tab"))) {
			this.#apply({ kind: "previous_tab" }, "center");
		} else if (liveTab && (matchesKey(data, Key.right) || matchesKey(data, "l"))) {
			this.#apply({ kind: "open_children" }, "center");
		} else if (liveTab && (matchesKey(data, Key.left) || matchesKey(data, "h"))) {
			this.#apply({ kind: "go_to_parent" }, "center");
		} else if (matchesKey(data, "j") || keybindings.matches(data, "tui.select.down")) {
			this.#apply({ kind: "focus_next" }, "keep");
		} else if (matchesKey(data, "k") || keybindings.matches(data, "tui.select.up")) {
			this.#apply({ kind: "focus_previous" }, "keep");
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			this.#selectRow(this.#focusedRow().key);
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.#done(undefined);
		}
		this.#tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Leave non-primary buttons to Pi/terminal behavior, never selector actions.
		if (event.button === "middle" || event.button === "right") return undefined;
		if (this.#selectionPending) return { handled: true };
		const region = this.#hitRegions.find(({ start, end, row }) =>
			event.y === row && event.x >= start && event.x < end &&
			event.x < event.width && event.y < event.height
		);
		if (event.type === "move") {
			const action = region?.action;
			const changed = !samePointerAction(this.#hoveredAction, action);
			this.#hoveredAction = action;
			return { handled: true, render: changed };
		}
		if (event.type === "wheel") {
			if (this.#rosterRows.has(event.y) &&
				event.x >= this.#contentLeft && event.x < this.#contentLeft + this.#contentWidth &&
				event.wheelDelta) {
				// Collapse a same-direction burst inside one tick window into a
				// single step; reversing direction responds immediately.
				const direction = event.wheelDelta < 0 ? -1 : 1;
				const now = this.#options.now?.() ?? Date.now();
				if (direction === this.#lastWheelDirection &&
					now - this.#lastWheelTime < WHEEL_TICK_WINDOW_MS) {
					return { handled: true, render: false };
				}
				this.#lastWheelDirection = direction;
				this.#lastWheelTime = now;
				// Wheel scrolls by moving focus one row, without wrapping.
				const beforeIndex = this.#view.focusedIndex;
				const beforeOffset = this.#rosterScrollOffset;
				this.#apply({ kind: direction < 0 ? "focus_previous" : "focus_next" }, "keep");
				this.#hoveredAction = undefined;
				const changed = this.#view.focusedIndex !== beforeIndex ||
					this.#rosterScrollOffset !== beforeOffset;
				return { handled: true, render: changed };
			}
			return { handled: true };
		}
		if (event.button !== "left") return { handled: true };
		if (event.type === "press") {
			this.#pressedAction = region?.action;
			return { handled: true, capture: true };
		}
		if (event.type === "click") {
			const action = region?.action;
			if (action && (!this.#pressedAction || samePointerAction(this.#pressedAction, action))) {
				this.#activatePointerAction(action);
			}
			this.#pressedAction = undefined;
		}
		return { handled: true };
	}

	#activatePointerAction(action: PointerAction): void {
		this.#hoveredAction = undefined;
		if (action.kind === "root") {
			this.#apply({ kind: "go_to_root" }, "center");
		} else if (action.kind === "tab") {
			this.#apply({ kind: "choose_tab", tab: action.tab }, "center");
		} else if (action.kind === "config") {
			this.#done({ kind: "open_config" });
		} else if (action.kind === "ancestor") {
			this.#apply({ kind: "go_to_ancestor", agentId: action.agentId, childId: action.childId }, "center");
		} else {
			if (!this.#view.rows.some(({ key }) => key === action.value)) return;
			this.#apply({ kind: "focus_row", key: action.value }, "keep");
			if (action.kind === "children") this.#apply({ kind: "open_children" }, "center");
			else this.#selectRow(action.value);
		}
		this.#tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		this.#removeChangeHandler?.();
		this.#removeChangeHandler = undefined;
		this.#stopSelectionSpinner();
	}

	render(width: number): string[] {
		const terminalRows = this.#tui.terminal.rows;
		const frameWidth = Math.min(width, AGENT_SELECTOR_OVERLAY_WIDTH);
		const innerWidth = Math.max(0, frameWidth - 2);
		const contentWidth = Math.max(0, innerWidth - 2);
		const border = (text: string) => this.#theme.fg("border", text);
		// Resize changes the list's visible window as well as its hit regions.
		if (this.#maximumVisibleRows() !== this.#visibleRows) this.#syncScroll("keep");
		const items = this.#items();
		const { liveStatus } = this.#view;
		const contentLines: SelectorLine[] = [
			this.#renderTabs(),
			{ text: liveStatus === "none" ? "" : this.#theme.fg("warning", formatAttentionLiveStatus(liveStatus)) },
			...this.#renderPinnedList(items, contentWidth),
			{ text: "" },
			this.#renderOwnerFooter(items),
			{ text: this.#theme.fg(
				"dim",
				"Tab views · ↑/k ↓/j · →/l children · ←/h parent · Enter · Esc",
			) },
		];
		const visibleContentLines = fitOverlayContent(
			contentLines,
			Math.max(0, this.#maximumOverlayRows() - FRAME_ROWS),
		);
		const leftMargin = Math.min(1, innerWidth);
		const rightMargin = Math.max(0, innerWidth - contentWidth - leftMargin);
		this.#contentLeft = 1 + leftMargin;
		this.#contentWidth = contentWidth;
		this.#hitRegions = [];
		this.#rosterRows.clear();
		const focusedKey = this.#focusedRow().key;
		const panel = [
			border(`┌${"─".repeat(innerWidth)}┐`),
			...visibleContentLines.map((line, index) => {
				const row = index + 1;
				if (line.roster) this.#rosterRows.add(row);
				for (const region of line.regions ?? []) {
					// A partially clipped control is informational, not a different action.
					if (region.end > contentWidth || region.start >= region.end || row >= terminalRows) continue;
					this.#hitRegions.push({
						...region, row,
						start: this.#contentLeft + region.start,
						end: this.#contentLeft + region.end,
					});
				}
				let text = line.text;
				for (const region of line.regions ?? []) {
					if (region.end > contentWidth || region.start >= region.end) continue;
					const selected = region.action.kind === "tab"
						? region.action.tab === this.#view.activeTab
						: region.action.kind === "open" && region.action.value === focusedKey;
					const hovered = samePointerAction(region.action, this.#hoveredAction);
					if (!selected && !hovered) continue;
					// userMessageBg is the neutral, subtler surface in both bundled themes.
					// Selection wins; the child button is a separate action, not part of it.
					const background = selected ? "selectedBg" : "userMessageBg";
					const regionWidth = region.end - region.start;
					// Keep each action's styled text at construction time instead of slicing
					// ANSI-painted lines, which can replay neighboring foreground codes.
					let label = truncateToWidth(region.text, regionWidth, "");
					label += " ".repeat(Math.max(0, regionWidth - visibleWidth(label)));
					// Truncation may reset all ANSI styles before the action's padding.
					if (label.includes("\x1b[0m")) {
						label = label.replaceAll("\x1b[0m", "\x1b[0m" + this.#theme.getBgAnsi(background));
					}
					text = compositeTuiLine(text, this.#theme.bg(background, label),
						region.start, regionWidth, contentWidth);
				}
				return frameLine(text, contentWidth, leftMargin, rightMargin, border);
			}),
			border(`└${"─".repeat(innerWidth)}┘`),
		];
		// Paint only the panel: a full-terminal blank overlay erases the chat below.
		return panel;
	}

	#apply(intent: AgentSelectorIntent, scroll: ScrollMode): void {
		const next = applyAgentSelectorIntent(this.#state, intent);
		// A no-op intent leaves the viewport exactly where it was.
		if (next === this.#state) return;
		this.#state = next;
		this.#view = agentSelectorView(next);
		this.#syncScroll(scroll);
	}

	#syncScroll(scroll: ScrollMode): void {
		this.#visibleRows = this.#maximumVisibleRows();
		const maximumOffset = this.#maximumRosterScrollOffset();
		this.#rosterScrollOffset = scroll === "center"
			? Math.max(0, Math.min(this.#view.focusedIndex - Math.floor(this.#visibleRows / 2), maximumOffset))
			: Math.min(this.#rosterScrollOffset, maximumOffset);
		this.#ensureFocusedVisible();
	}

	#focusedRow(): AgentSelectorRow {
		return this.#view.rows[this.#view.focusedIndex]!;
	}

	#ownerRow(): Extract<AgentSelectorRow, { kind: "owner" }> {
		const owner = this.#view.rows.at(-1);
		if (owner?.kind !== "owner") throw new Error("Agent selector focus order must end at the Owner");
		return owner;
	}

	#maximumVisibleRows(): number {
		return Math.max(1, Math.min(
			MAX_VISIBLE_ROSTER_ROWS,
			this.#maximumOverlayRows() - FIXED_OVERLAY_ROWS - SCROLL_INDICATOR_ROWS,
		));
	}

	#selectRow(key: string): void {
		// Keyboard confirmation and pointer activation share actions, not keybindings.
		// Informational rows remain focusable without dismissing the selector.
		const action = this.#view.rows.find((row) => row.key === key)?.action;
		if (action) void this.#completeSelection(action);
	}

	async #toggleFocusedReportRead(): Promise<void> {
		const focused = this.#focusedRow();
		const setRead = this.#options.setReportRead;
		if (focused.kind !== "report" || !setRead) return;
		const { reportId } = focused.item.report;
		this.#selectionPending = true;
		this.#startSelectionSpinner();
		try {
			const reports = await setRead(reportId, focused.item.readAt === undefined);
			this.#apply({ kind: "report_read_changed", reportId, reports }, "keep");
		} catch (error) {
			this.#options.onSelectionError?.(error);
		} finally {
			this.#selectionPending = false;
			this.#stopSelectionSpinner();
			this.#tui.requestRender();
		}
	}

	async #completeSelection(
		action: AgentSelectorAction,
		showSelectionSpinner = true,
	): Promise<void> {
		if (this.#selectionPending) return;
		this.#selectionPending = true;
		if (showSelectionSpinner) this.#startSelectionSpinner();
		try {
			const preparation = this.#options.prepareSelection?.(action, this.#tui);
			if (preparation) await preparation;
			this.#stopSelectionSpinner();
			this.#done(action);
		} catch (error) {
			this.#selectionPending = false;
			this.#stopSelectionSpinner();
			this.#options.onSelectionError?.(error);
			this.#tui.requestRender();
		}
	}

	#startSelectionSpinner(): void {
		this.#selectionSpinnerFrame = 0;
		this.#selectionSpinnerTimer = setInterval(() => {
			this.#selectionSpinnerFrame =
				(this.#selectionSpinnerFrame + 1) % SELECTION_SPINNER_FRAMES.length;
			this.#tui.requestRender();
		}, SELECTION_SPINNER_INTERVAL_MILLISECONDS);
		this.#tui.requestRender();
	}

	#stopSelectionSpinner(): void {
		if (this.#selectionSpinnerTimer) clearInterval(this.#selectionSpinnerTimer);
		this.#selectionSpinnerTimer = undefined;
	}

	/** The loading row replaces the focused row's description while a selection prepares. */
	#loadingDescription(): string | undefined {
		return this.#selectionSpinnerTimer
			? `${SELECTION_SPINNER_FRAMES[this.#selectionSpinnerFrame]} loading`
			: undefined;
	}

	#maximumOverlayRows(): number {
		const terminalRows = this.#tui.terminal.rows;
		const percentBound = Math.floor(
			terminalRows * AGENT_SELECTOR_OVERLAY_MAX_HEIGHT_PERCENT / 100,
		);
		const marginBound = terminalRows - AGENT_SELECTOR_OVERLAY_MARGIN * 2;
		return Math.max(2, Math.min(percentBound, marginBound));
	}

	#items(): AgentSelectorItem[] {
		const loading = this.#loadingDescription();
		return this.#view.rows.map((row, index) => {
			const item = this.#item(row);
			return loading !== undefined && index === this.#view.focusedIndex
				? { ...item, description: loading }
				: item;
		});
	}

	#item(row: AgentSelectorRow): AgentSelectorItem {
		switch (row.kind) {
			case "decide":
				return {
					row, value: row.key,
					label: `DECIDE ${row.number} · ${row.attention.agentLabel}`,
					description: boundedToolPreview(row.attention.question),
				};
			case "incident":
				return {
					row, value: row.key,
					label: `ATTENTION ${row.number} · ${formatOperationalIncidentHeadline(row.attention)}`,
				};
			case "report": {
				const { report, readAt } = row.item;
				return {
					row, value: row.key,
					label: `REPORT · ${safeReportLine(report.reporter?.label ?? "Runtime")}`,
					description: `${readAt === undefined ? "Unread" : "Read"} · ${boundedToolPreview(safeReportLine(report.symptom))}`,
				};
			}
			case "agent":
				return {
					row, value: row.key,
					label: this.#participantLabel(row.status.label, row.mounted),
					description: [
						formatRun(row.status, this.#theme),
						row.moderator ? row.status.description : undefined,
					].filter(Boolean).join(" · "),
					childControl: row.childCount === 0
						? undefined
						: `${row.childCount} ${row.childCount === 1 ? "child" : "children"} ›`,
				};
			case "quarantined":
				return { row, value: row.key, label: row.agentId, description: QUARANTINED_DESCRIPTION };
			case "unreadable_candidates":
				return {
					row, value: row.key,
					label: `+ ${row.count} unreadable candidate${plural(row.count)} without recoverable ID`,
					description: QUARANTINED_DESCRIPTION,
				};
			case "owner":
				return { row, value: row.key, label: "Owner" };
		}
	}

	#detailLines(row: AgentSelectorRow): readonly string[] {
		switch (row.kind) {
			case "decide":
				return [
					"",
					`Agent ${row.attention.agentId}`,
					boundedToolPreview(row.attention.question),
					`Human Request ${row.attention.requestId}`,
				];
			case "incident": {
				const { attention } = row;
				const requests = operationalIncidentRequestEvidence(attention);
				return [
					"",
					...(attention.summary ? [attention.summary] : []),
					`Affected ${attention.affectedAgents.map(({ label }) => label).join(", ")}`,
					requests.sources.length === 0
						? `Requests ${requests.total}`
						: requests.sources.map(
							(pointer) =>
								`Request ${pointer.agentId}/${pointer.entryId}/${pointer.toolCallId}`,
						).join(" · "),
					attention.diagnostics.length === 0
						? ""
						: attention.diagnostics.map(
							(pointer) => `Diagnostic ${pointer.agentId}/${pointer.entryId}`,
						).join(" · "),
				];
			}
			case "report": {
				const { report, readAt } = row.item;
				return [
					safeReportLine(report.symptom),
					`Report ${safeReportLine(report.reportId)}`,
					`Created ${safeReportLine(report.createdAt)}`,
					`${readAt === undefined ? "Unread" : `Read ${safeReportLine(readAt)}`} · ${this.#options.setReportRead ? "m Toggle read · " : ""}Enter opens report`,
				];
			}
			case "quarantined":
				return [
					QUARANTINED_DESCRIPTION,
					"Agent " + row.agentId,
					"Excluded from cold-start recovery as untrusted proof",
					"Inspect the transcript directly · not selectable here",
				];
			case "unreadable_candidates":
				return [
					QUARANTINED_DESCRIPTION,
					`${row.count} candidate${plural(row.count)} without recoverable ID`,
					"Excluded from cold-start recovery as untrusted proof",
					"Inspect the session directory directly · not selectable here",
				];
			case "agent":
			case "owner":
				return [];
		}
	}

	#maximumRosterScrollOffset(): number {
		return Math.max(0, this.#view.rows.length - 1 - this.#visibleRows);
	}

	#ensureFocusedVisible(): void {
		if (this.#focusedRow().kind === "owner") return;
		const focusedIndex = this.#view.focusedIndex;
		const maximumOffset = this.#maximumRosterScrollOffset();
		if (focusedIndex < this.#rosterScrollOffset) {
			this.#rosterScrollOffset = focusedIndex;
		} else if (focusedIndex >= this.#rosterScrollOffset + this.#visibleRows) {
			this.#rosterScrollOffset = focusedIndex - this.#visibleRows + 1;
		}
		this.#rosterScrollOffset = Math.max(0, Math.min(this.#rosterScrollOffset, maximumOffset));
	}

	#renderRosterViewport(
		width: number,
		items: readonly AgentSelectorItem[],
		startIndex: number,
		visibleItems: AgentSelectorItem[],
	): string[] {
		const focusedIndex = this.#view.focusedIndex;
		const focusedOffset = focusedIndex - startIndex;
		const focusedVisible = focusedOffset >= 0 && focusedOffset < visibleItems.length;
		const theme = focusedVisible
			? this.#selectListTheme()
			: {
				selectedPrefix: (text: string) => text,
				selectedText: (text: string) => text.startsWith("→ ") ? "  " + text.slice(2) : text,
				description: (text: string) => this.#theme.fg("dim", text),
				scrollInfo: (text: string) => this.#theme.fg("muted", text),
				noMatch: (text: string) => this.#theme.fg("muted", text),
			};
		// Pi's list renders rows only; focus belongs to the projection.
		const viewport = new SelectList(visibleItems, Math.max(1, visibleItems.length), theme);
		viewport.setSelectedIndex(focusedVisible ? focusedOffset : 0);
		const lines = viewport.render(width).slice(0, visibleItems.length);
		if (startIndex > 0 || startIndex + visibleItems.length < items.length - 1) {
			const range = `  (${Math.min(focusedIndex + 1, items.length - 1)}/${items.length - 1})`;
			lines.push(this.#theme.fg("muted", truncateToWidth(range, Math.max(0, width - 2), "")));
		}
		return lines;
	}

	#renderPinnedList(items: readonly AgentSelectorItem[], width: number): SelectorLine[] {
		const startIndex = Math.max(0, Math.min(
			this.#rosterScrollOffset, this.#maximumRosterScrollOffset(),
		));
		const visibleItems = items.slice(startIndex, Math.min(startIndex + this.#visibleRows, items.length - 1));
		const listLines = this.#renderRosterViewport(width, items, startIndex, visibleItems);
		const { activeTab, emptyState } = this.#view;
		const reportHistory = activeTab === "reports";
		// Quarantine rows count here too: the budget reserves a heading row for them.
		const visibleAttention = visibleItems.some(({ row }) => row.kind !== "agent" && row.kind !== "owner");
		const visibleBodyRows = visibleItems.length;
		// Short terminals trade detail rows for navigation and the fixed footer.
		const detailRows = Math.max(0, Math.min(FOCUSED_DETAIL_ROWS,
			this.#maximumOverlayRows() - FRAME_ROWS - TAB_ROWS - HELP_ROWS - OWNER_FOOTER_ROWS - 1 -
			(visibleAttention || reportHistory ? 1 : 0) - visibleBodyRows - (emptyState ? 1 : 0) -
			(listLines.length > visibleItems.length ? SCROLL_INDICATOR_ROWS : 0),
		));
		const attention: SelectorLine[] = [];
		const agents: SelectorLine[] = [];
		for (const [offset, item] of visibleItems.entries()) {
			const { row } = item;
			const lines = isAttentionRow(row) ? attention : agents;
			let line = listLines[offset] ?? "";
			let bodyText = line;
			const regions: LineRegion[] = [];
			let bodyEnd = width;
			if (item.childControl) {
				// Reserve the hierarchy action before truncating the participant body.
				const childWidth = visibleWidth(item.childControl);
				const bodyWidth = Math.max(0, width - childWidth - 1);
				line = truncateToWidth(line, bodyWidth, "");
				if (childWidth <= width) {
					// Leave one unowned cell between independent controls, matching tabs and Owner.
					const bodyTextWidth = visibleWidth(line);
					const childStart = Math.max(bodyTextWidth + 1, width - childWidth);
					line += " ".repeat(Math.max(1, childStart - bodyTextWidth));
					bodyEnd = childStart - 1;
					regions.push({ start: childStart, end: childStart + childWidth,
						text: this.#theme.fg("dim", item.childControl),
						action: { kind: "children", value: item.value } });
				} else {
					line += " ".repeat(Math.max(1, width - visibleWidth(line) - childWidth));
					// Never turn the clipped child-control fragment into an open action.
					bodyEnd = 0;
				}
				bodyText = line;
				line += this.#theme.fg("dim", item.childControl);
			}
			// Quarantine rows carry no action: the region only moves keyboard/mouse
			// focus, while confirmation stays a no-op.
			if (row.action || row.kind === "quarantined" || row.kind === "unreadable_candidates") {
				regions.push({ start: 0, end: bodyEnd, text: bodyText, action: { kind: "open", value: item.value } });
			}
			lines.push({ text: line, regions, roster: true });
			if (startIndex + offset === this.#view.focusedIndex) {
				// Details are informational for clicks; wheel over them scrolls selection.
				lines.push(...this.#focusedDetailLines(row, width)
					.slice(0, detailRows).map((text) => ({ text, roster: true })));
			}
		}
		const rendered: SelectorLine[] = [
			...(attention.length || reportHistory ? [{ text: this.#theme.fg("toolTitle", this.#theme.bold(reportHistory ? "History" : "Attention Inbox")), roster: true }, ...attention] : []),
			...(reportHistory ? [] : [activeTab === "live"
				? { ...this.#scopeTitle(width), roster: true }
				: { text: this.#theme.fg("toolTitle", "Agents"), roster: true }]),
			...agents,
			...(emptyState ? [{ text: this.#theme.fg("dim", EMPTY_STATE_TEXT[emptyState]), roster: true }] : []),
		];
		// Share one terminal-bounded budget across tabs, including optional headers,
		// empty messages and scrolling, so content changes never move the frame.
		const targetRows = this.#visibleRows + FOCUSED_DETAIL_ROWS +
			MAX_LIVE_SECTION_HEADER_ROWS + EMPTY_LIVE_AGENT_ROWS + SCROLL_INDICATOR_ROWS;
		rendered.push(...listLines.slice(visibleItems.length).map((text) => ({ text, roster: true })));
		while (rendered.length < targetRows) rendered.push({ text: "", roster: true });
		return rendered;
	}

	#focusedDetailLines(row: AgentSelectorRow, width: number): string[] {
		if (row.kind !== "agent") {
			const detailLines = this.#detailLines(row);
			return Array.from({ length: FOCUSED_DETAIL_ROWS }, (_, index) =>
				this.#theme.fg(
					index < 2 ? "muted" : "dim",
					truncateToWidth(`  ${detailLines[index] ?? ""}`, width, ""),
				)
			);
		}
		const { status } = row;
		const description = `  ${status.description ?? "No description."}`;
		return [
			this.#theme.fg("muted", truncateToWidth(description, width, "")),
			this.#theme.fg("muted", truncateToWidth(`  ${status.agentId}`, width, "")),
			this.#theme.fg("dim", truncateToWidth(`  ${formatDetailedRun(status)}`, width, "")),
			this.#theme.fg(
				"dim",
				truncateToWidth(
					`  ${status.model.provider}/${status.model.modelId} · thinking ${status.thinking} · ${status.queuedInputCount} queued`,
					width,
					"",
				),
			),
		];
	}

	#scopeTitle(width: number): SelectorLine {
		const ancestors = this.#view.scopePath;
		const scope = ancestors.at(-1);
		const regions: LineRegion[] = [{
			start: 0, end: visibleWidth("Agents"), text: this.#theme.fg("toolTitle", "Agents"),
			action: { kind: "root" },
		}];
		if (!scope) return { text: this.#theme.fg("toolTitle", "Agents"), regions };
		const visibleAncestors = ancestors.slice(-MAX_BREADCRUMB_AGENT_SEGMENTS);
		const rootPrefix = "Agents › ";
		const prefix = () => rootPrefix + (ancestors.length > visibleAncestors.length ? "… › " : "");
		const title = () => prefix() + visibleAncestors.map(({ label }) => label).join(" › ");
		while (visibleAncestors.length > 1 && visibleWidth(title()) > width) {
			visibleAncestors.shift();
		}
		if (visibleWidth(title()) <= width) {
			let column = visibleWidth(prefix());
			for (const [index, ancestor] of visibleAncestors.entries()) {
				const child = visibleAncestors[index + 1];
				// The current scope segment browses up one level, like Left/h.
				const action = child
					? { kind: "ancestor" as const, agentId: ancestor.agentId, childId: child.agentId }
					: {
						kind: "ancestor" as const,
						agentId: scope.directSpawnerAgentId ?? this.#ownerRow().agentId,
						childId: scope.agentId,
					};
				regions.push({
					start: column, end: column + visibleWidth(ancestor.label),
					text: this.#theme.fg("toolTitle", ancestor.label),
					action,
				});
				column += visibleWidth(ancestor.label) + visibleWidth(" › ");
			}
			return { text: this.#theme.fg("toolTitle", title()), regions };
		}
		// Omitted and clipped path text is informational, never a partial action.
		return { text: this.#theme.fg("toolTitle", rootPrefix + truncateToWidth(
			visibleAncestors.at(-1)?.label ?? "",
			Math.max(0, width - visibleWidth(rootPrefix)), "…",
		)), regions };
	}

	#participantLabel(label: string, mounted: boolean): string {
		// Mounted identity is independent of keyboard focus and hierarchy browsing.
		return mounted ? this.#theme.bold(`${label}*`) : label;
	}

	#renderOwnerFooter(items: readonly AgentSelectorItem[]): SelectorLine {
		const owner = this.#ownerRow();
		const text = this.#theme.fg("toolTitle", `Go to ${this.#participantLabel("Owner", owner.mounted)}`) + this.#theme.fg("dim", " [o]");
		const pending = this.#focusedRow().kind === "owner"
			? items[this.#view.focusedIndex]?.description : undefined;
		return {
			text: text + (pending ? this.#theme.fg("dim", ` ${pending}`) : ""),
			regions: [{ start: 0, end: visibleWidth(text), text,
				action: { kind: "open", value: owner.key } }],
		};
	}

	#renderTabs(): SelectorLine {
		const tab = (name: string, active: boolean) =>
			active
				? this.#theme.bg("selectedBg", this.#theme.fg("text", " " + name + " "))
				: this.#theme.fg("muted", " " + name + " ");
		let text = "";
		const regions: LineRegion[] = [];
		let column = 0;
		for (const [index, name] of this.#view.tabs.entries()) {
			const rendered = tab(TAB_LABELS[name], this.#view.activeTab === name);
			const width = visibleWidth(rendered);
			// One unowned cell between independent controls, matching Owner rows.
			if (index > 0) text += " ";
			regions.push({ start: column, end: column + width, text: rendered, action: { kind: "tab", tab: name } });
			text += rendered;
			column += width + 1;
		}
		if (this.#options.configAvailable) {
			// Config sits after the cycled tabs; the bar marks that Tab never lands on it.
			const separator = this.#theme.fg("dim", "|");
			const label = this.#theme.fg("muted", " Config") + this.#theme.fg("dim", " [c] ");
			const start = column + visibleWidth(separator);
			text += ` ${separator}${label}`;
			regions.push({ start, end: start + visibleWidth(label), text: label, action: { kind: "config" } });
		}
		return { text, regions };
	}

	#selectListTheme(): SelectListTheme {
		return {
			selectedPrefix: (text) => this.#theme.fg("accent", text),
			selectedText: (text) => this.#theme.fg("accent", text),
			description: (text) => this.#theme.fg("dim", text),
			scrollInfo: (text) => this.#theme.fg("muted", text),
			noMatch: (text) => this.#theme.fg("muted", text),
		};
	}
}

/** Inbox and Report history rows sit under their own heading; the rest under Agents. */
function isAttentionRow(row: AgentSelectorRow): boolean {
	return row.kind === "decide" || row.kind === "incident" || row.kind === "report";
}

function safeReportLine(text: string): string {
	return sanitizeReportTerminalText(text).replace(/\s+/g, " ").trim();
}

function plural(count: number): string {
	return count === 1 ? "" : "s";
}

function fitOverlayContent(lines: SelectorLine[], maximumRows: number): SelectorLine[] {
	const content = [...lines];
	while (content.length > maximumRows) {
		const emptyLine = content.findLastIndex((line) => visibleWidth(line.text) === 0);
		if (emptyLine < 0) break;
		content.splice(emptyLine, 1);
	}
	// Keep the session action and help visible even when detail rows must be clipped.
	const footer = content.splice(-OWNER_FOOTER_ROWS - HELP_ROWS);
	return [...content.slice(0, Math.max(0, maximumRows - footer.length)), ...footer].slice(0, maximumRows);
}

function samePointerAction(left: PointerAction | undefined, right: PointerAction | undefined): boolean {
	if (!left || !right) return left === right;
	switch (left.kind) {
		case "root": return right.kind === "root";
		case "tab": return right.kind === "tab" && left.tab === right.tab;
		case "config": return right.kind === "config";
		case "open":
		case "children": return right.kind === left.kind && left.value === right.value;
		case "ancestor": return right.kind === "ancestor" &&
			left.agentId === right.agentId && left.childId === right.childId;
	}
}

function formatRun(status: AgentRosterStatus, theme: Theme): string {
	return formatAgentWorkStatus(selectedAgentWorkStatus(status.run, false, status.compacting), theme);
}

function formatDetailedRun(status: AgentRosterStatus): string {
	const { run } = status;
	if (run.suspension) {
		return formatSuspensionDetail(run.suspension);
	}
	const state = run.phase === "dormant"
		? [run.queued ? "Queued" : "Dormant"]
		: [
			capitalize(run.phase),
			run.work,
			run.attention === "input_required"
				? "input required"
				: run.attention === "agent_wait" ? "agent answers" : undefined,
		];
	const retention = run.retentionReasons.length === 0
		? undefined
		: run.retentionReasons.map(({ reason, count }) => [
			reason.replaceAll("_", " "),
			count > 1 ? `×${count}` : undefined,
		].filter(Boolean).join(" ")).join(", ");
	return [...state, retention].filter(Boolean).join(" · ");
}

function capitalize(value: string): string {
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

/** Retained stop evidence; showing it never implies recovery or resumption. */
function formatSuspensionDetail(suspension: AgentRunSuspension): string {
	const { evidence } = suspension;
	return [SUSPENSION_LABEL, `Stage: ${evidence.stage}`, evidence.error, `Provenance: ${evidence.provenance}`].join(" · ");
}
