import {
	CURSOR_MARKER,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";

import type { TerminalProjection } from "../presentation/terminal-projection.ts";
import type { PiChildRuntimeEvent } from "./pi-child-process-runtime.ts";
import type {
	PtyExit,
	TerminalCellColor,
	TerminalCellStyle,
	TerminalProjectionCell,
	TerminalProjectionFrame,
} from "./pty-terminal-projection.ts";

const DEFAULT_CELL_STYLE: TerminalCellStyle = {
	foreground: { kind: "default" },
	background: { kind: "default" },
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	blink: false,
	inverse: false,
	invisible: false,
	strikethrough: false,
	overline: false,
};

/** Already-admitted Runtime surface consumed by the terminal Adapter. */
export type AdmittedPiChildProjectionRuntime = Readonly<{
	exited: Promise<PtyExit>;
	dimensions(): Readonly<{ columns: number; rows: number }>;
	frame(): TerminalProjectionFrame;
	writeInput(data: string | Buffer): void;
	resize(columns: number, rows: number): void;
	addChangeHandler(handler: () => void): () => void;
	addFailureHandler(handler: (error: unknown) => void): () => void;
	beginPhysicalTerminalAttachment(handler: (data: string) => void): Promise<() => void>;
	beginScreenView(): Promise<void>;
	/** Handoff note for the current viewer, when the screen handoff was bounded. */
	screenViewDiagnostic?(): string | undefined;
	hidePresentation(): Promise<void>;
	pauseOutput(): void;
	resumeOutput(): void;
	onEvent(handler: (event: PiChildRuntimeEvent) => void): () => void;
	dispose(): Promise<void>;
}>;

export type AdmittedPiChildProcessProjection = TerminalProjection & Readonly<{
	dispose(): Promise<void>;
}>;

/**
 * Adapt one fully admitted real Pi child Runtime to the terminal seam.
 * Pre-admission readiness and cancellation are composed by
 * createPiChildProcessProjection; this lower Adapter stays terminal-only.
 */
export function createAdmittedPiChildProcessProjection(
	runtime: AdmittedPiChildProjectionRuntime,
): AdmittedPiChildProcessProjection {
	const changes = new ChangeNotifications();
	const failures = new FailureNotifications();
	const exits = new ChangeNotifications();
	const presentation = new PiChildTerminalComponent(() => runtime.frame());
	let disposed = false;
	let disposal: Promise<void> | undefined;

	const removeTerminalChangeHandler = runtime.addChangeHandler(() => changes.notify());
	const removeTerminalFailureHandler = runtime.addFailureHandler((error) => {
		failures.notify(error);
	});
	const removeRuntimeEventHandler = runtime.onEvent((event) => {
		if (event.event !== "runtime.fault") return;
		failures.notify(new Error(
			`child_runtime_fault: ${event.payload.code}: ${event.payload.message}`,
		));
	});
	void runtime.exited.then((exit) => {
		if (disposed) return;
		if (exit.exitCode !== 0 || exit.signal !== 0) {
			failures.notify(withScreenViewDiagnostic(
				new Error(
					`child_runtime_unexpected_exit: code ${exit.exitCode} signal ${exit.signal}`,
				),
				runtime,
			));
		}
		exits.notify();
	}, (error) => {
		if (disposed) return;
		failures.notify(error);
		exits.notify();
	});

	const dispose = () => {
		disposal ??= (async () => {
			disposed = true;
			removeTerminalChangeHandler();
			removeTerminalFailureHandler();
			removeRuntimeEventHandler();
			changes.dispose();
			failures.dispose();
			exits.dispose();
			await runtime.dispose();
		})();
		return disposal;
	};

	return Object.freeze({
		presentation,
		screenView: Object.freeze({
			begin: () => runtime.beginScreenView(),
			end: () => runtime.hidePresentation(),
		}),
		physicalTerminal: Object.freeze({
			beginAttachment: (handler: (data: string) => void) =>
				runtime.beginPhysicalTerminalAttachment(handler),
			endAttachment: () => runtime.hidePresentation(),
			pauseOutput: () => runtime.pauseOutput(),
			resumeOutput: () => runtime.resumeOutput(),
		}),
		resize(columns, rows) {
			const dimensions = runtime.dimensions();
			if (columns === dimensions.columns && rows === dimensions.rows) return;
			runtime.resize(columns, rows);
		},
		dispatchInput(data) {
			// node-pty accepts strings without key parsing or newline normalization.
			runtime.writeInput(data);
		},
		focusEditor() {
			// The attached PTY already owns Pi's native focus. A synthetic key or
			// focus report would alter child input without actually selecting its editor.
		},
		addChangeHandler: (handler) => changes.addHandler(handler),
		addFailureHandler: (handler) => failures.addHandler(handler),
		addExitRequestHandler: (handler) => exits.addHandler(handler),
		dispose,
	});
}

class PiChildTerminalComponent implements Component, Focusable {
	readonly #readFrame: () => TerminalProjectionFrame;
	focused = false;

	constructor(readFrame: () => TerminalProjectionFrame) {
		this.#readFrame = readFrame;
	}

	render(width: number): string[] {
		const frame = this.#readFrame();
		const columns = Math.min(frame.columns, Math.max(0, Math.floor(width)));
		return frame.lines.map((line, row) => renderTerminalLine(
			line.cells,
			columns,
			frame.cursor.visible && frame.cursor.row === row
				? frame.cursor
				: undefined,
			this.focused,
		));
	}

	invalidate(): void {
		// Frames are read directly from xterm; no themed or rendered state is cached.
	}
}

function renderTerminalLine(
	cells: readonly TerminalProjectionCell[],
	columns: number,
	frameCursor: TerminalProjectionFrame["cursor"] | undefined,
	focused: boolean,
): string {
	const visibleCells = cells.slice(0, columns);
	const cursorColumn = normalizeCursorColumn(frameCursor, visibleCells, columns);
	let endColumn = 0;
	for (let column = 0; column < visibleCells.length; column += 1) {
		const cell = visibleCells[column]!;
		if (
			(cell.width > 0 && (cell.text.length > 0 || !isDefaultStyle(cell.style)))
			|| (cell.width === 0 && cell.text.length > 0)
		) {
			endColumn = Math.min(columns, column + Math.max(1, cell.width));
		}
	}
	if (cursorColumn !== undefined) endColumn = Math.max(endColumn, cursorColumn + 1);

	let output = "";
	let column = 0;
	while (column < endColumn) {
		const cell = visibleCells[column] ?? {
			text: "",
			width: 1,
			style: DEFAULT_CELL_STYLE,
		};
		const isCursor = cursorColumn === column && frameCursor !== undefined;
		if (isCursor && focused) output += CURSOR_MARKER;
		if (cell.width === 0) {
			// An empty width-zero cell was consumed with its preceding wide lead.
			// A nonempty one is a standalone combining sequence and keeps this grid slot.
			if (cell.text.length > 0) {
				const styled = renderCursorCell(cell, frameCursor, isCursor, 1);
				const padding = Math.max(0, 1 - visibleWidth(styled.text));
				output += `${renderCellStyle(styled.style)}${styled.text}${" ".repeat(padding)}`;
			}
			column += 1;
			continue;
		}
		if (column + cell.width > columns) {
			output += `${renderCellStyle(DEFAULT_CELL_STYLE)}${" ".repeat(columns - column)}`;
			break;
		}
		const styled = renderCursorCell(cell, frameCursor, isCursor, cell.width);
		output += `${renderCellStyle(styled.style)}${styled.text}`;
		column += cell.width;
	}
	if (output.length === 0) return "";
	// xterm and Pi can disagree on newly standardized grapheme widths. The
	// Component contract is strict, so never leak a wider line to the Owner TUI.
	return truncateToWidth(`${output}\x1b[0m`, columns, "");
}

function normalizeCursorColumn(
	cursor: TerminalProjectionFrame["cursor"] | undefined,
	cells: readonly TerminalProjectionCell[],
	columns: number,
): number | undefined {
	if (!cursor || columns === 0 || cursor.column < 0) return undefined;
	let column = Math.min(cursor.column, columns - 1);
	while (column > 0 && cells[column]?.width === 0 && cells[column]?.text.length === 0) {
		column -= 1;
	}
	return column;
}

function renderCursorCell(
	cell: TerminalProjectionCell,
	cursor: TerminalProjectionFrame["cursor"] | undefined,
	isCursor: boolean,
	width: number,
): Readonly<{ text: string; style: TerminalCellStyle }> {
	const text = cell.text || " ".repeat(width);
	if (!isCursor || !cursor) return { text, style: cell.style };
	const style = {
		...cell.style,
		blink: cell.style.blink || cursor.blink,
		inverse: cursor.style === "block" ? !cell.style.inverse : cell.style.inverse,
		underline: cursor.style === "underline" ? true : cell.style.underline,
		invisible: false,
	};
	return {
		text: cursor.style === "bar" ? `▏${" ".repeat(Math.max(0, width - 1))}` : text,
		style,
	};
}

function renderCellStyle(style: TerminalCellStyle): string {
	const codes = [
		"0",
		...(style.bold ? ["1"] : []),
		...(style.dim ? ["2"] : []),
		...(style.italic ? ["3"] : []),
		...(style.underline ? ["4"] : []),
		...(style.blink ? ["5"] : []),
		...(style.inverse ? ["7"] : []),
		...(style.invisible ? ["8"] : []),
		...(style.strikethrough ? ["9"] : []),
		...(style.overline ? ["53"] : []),
		...renderColor(style.foreground, "foreground"),
		...renderColor(style.background, "background"),
	];
	return `\x1b[${codes.join(";")}m`;
}

function renderColor(
	color: TerminalCellColor,
	layer: "foreground" | "background",
): string[] {
	if (color.kind === "default") return [layer === "foreground" ? "39" : "49"];
	const prefix = layer === "foreground" ? "38" : "48";
	return color.kind === "indexed"
		? [prefix, "5", String(color.index)]
		: [prefix, "2", String(color.red), String(color.green), String(color.blue)];
}

function isDefaultStyle(style: TerminalCellStyle): boolean {
	return style.foreground.kind === "default"
		&& style.background.kind === "default"
		&& !style.bold
		&& !style.dim
		&& !style.italic
		&& !style.underline
		&& !style.blink
		&& !style.inverse
		&& !style.invisible
		&& !style.strikethrough
		&& !style.overline;
}

/**
 * Carry the viewer's own screen-handoff note into a child failure message. A bounded
 * handoff is not itself a failure, but it explains a child view that never painted.
 */
function withScreenViewDiagnostic(
	error: Error,
	runtime: AdmittedPiChildProjectionRuntime,
): Error {
	const diagnostic = runtime.screenViewDiagnostic?.();
	return diagnostic === undefined
		? error
		: new Error(`${error.message}\n${diagnostic}`, { cause: error });
}

class ChangeNotifications {
	readonly #handlers = new Set<() => void>();
	#disposed = false;

	addHandler(handler: () => void): () => void {
		if (this.#disposed) return () => undefined;
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	notify(): void {
		if (this.#disposed) return;
		for (const handler of this.#handlers) handler();
	}

	dispose(): void {
		this.#disposed = true;
		this.#handlers.clear();
	}
}

class FailureNotifications {
	readonly #handlers = new Set<(error: unknown) => void>();
	#disposed = false;

	addHandler(handler: (error: unknown) => void): () => void {
		if (this.#disposed) return () => undefined;
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	notify(error: unknown): void {
		if (this.#disposed) return;
		for (const handler of this.#handlers) handler(error);
	}

	dispose(): void {
		this.#disposed = true;
		this.#handlers.clear();
	}
}
