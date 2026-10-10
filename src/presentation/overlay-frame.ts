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
