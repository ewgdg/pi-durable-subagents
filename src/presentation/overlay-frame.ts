import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * One boxed overlay row. Padding fills every cell up to the side borders, so text
 * behind the overlay never shows next to a short line.
 */
export function frameLine(
	line: string,
	blockWidth: number,
	leftMargin: number,
	rightMargin: number,
	border: (text: string) => string,
): string {
	// Compositing may end on a styled cell; frame padding must never inherit it.
	const content = truncateToWidth(line, blockWidth, "") + "\x1b[0m";
	const contentPadding = " ".repeat(Math.max(0, blockWidth - visibleWidth(content)));
	return `${border("│")}${" ".repeat(leftMargin)}${content}${contentPadding}${" ".repeat(rightMargin)}${border("│")}`;
}

/** Boxes content rendered for the width inside the frame and its one-column margins. */
export function framePanel(
	renderContent: (contentWidth: number) => readonly string[],
	width: number,
	border: (text: string) => string,
): string[] {
	const innerWidth = Math.max(0, width - 2);
	const contentWidth = Math.max(0, innerWidth - 2);
	const leftMargin = Math.min(1, innerWidth);
	const rightMargin = Math.max(0, innerWidth - contentWidth - leftMargin);
	return [
		border(`┌${"─".repeat(innerWidth)}┐`),
		...renderContent(contentWidth).map((line) => frameLine(line, contentWidth, leftMargin, rightMargin, border)),
		border(`└${"─".repeat(innerWidth)}┘`),
	];
}

const PANEL_OVERLAY_WIDTH = 80;
const PANEL_OVERLAY_MARGIN = 1;
const PANEL_OVERLAY_MAX_HEIGHT_PERCENT = 90;
/** The top and bottom frame borders. */
export const PANEL_FRAME_ROWS = 2;
const SCROLL_INDICATOR_ROWS = 1;

/** Centered, bounded overlay shared by the `/agents` selector and its panels. */
export const PANEL_OVERLAY_OPTIONS = {
	anchor: "center",
	width: PANEL_OVERLAY_WIDTH,
	maxHeight: `${PANEL_OVERLAY_MAX_HEIGHT_PERCENT}%`,
	margin: { top: PANEL_OVERLAY_MARGIN, bottom: PANEL_OVERLAY_MARGIN },
} as const;

/** The most rows a panel may paint, frame included, so the overlay never clips it. */
export function maximumPanelRows(terminalRows: number): number {
	const percentBound = Math.floor(terminalRows * PANEL_OVERLAY_MAX_HEIGHT_PERCENT / 100);
	const marginBound = terminalRows - PANEL_OVERLAY_MARGIN * 2;
	return Math.max(PANEL_FRAME_ROWS, Math.min(percentBound, marginBound));
}

/** Pads or cuts lines to exactly `rows`, so content changes never move the frame. */
export function fitRows(lines: readonly string[], rows: number): string[] {
	return Array.from({ length: Math.max(0, rows) }, (_, index) => lines[index] ?? "");
}

/**
 * At most `maximumRows` lines: a window centered on the focused line, as pi-tui's
 * `SelectList` scrolls, with its `(i/n)` indicator when lines overflow.
 */
export function scrollWindow(
	lines: readonly string[],
	focusIndex: number,
	maximumRows: number,
	indicator: (text: string) => string,
): string[] {
	if (lines.length <= maximumRows) return [...lines];
	const visible = Math.max(1, maximumRows - SCROLL_INDICATOR_ROWS);
	const start = Math.max(0, Math.min(focusIndex - Math.floor(visible / 2), lines.length - visible));
	const focusNumber = Math.max(0, Math.min(focusIndex, lines.length - 1)) + 1;
	return [
		...lines.slice(start, start + visible),
		indicator(`  (${focusNumber}/${lines.length})`),
	].slice(0, Math.max(0, maximumRows));
}
