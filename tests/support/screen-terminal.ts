import xterm from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";

/**
 * xterm-backed Terminal for fullscreen renderer tests. Mouse reports enter at
 * this boundary as real SGR sequences, so components only ever see the events
 * the renderer normalized from terminal input.
 */
export class ScreenTerminal implements Terminal {
	columns = 120;
	rows = 30;
	kittyProtocolActive = false;
	screen = new xterm.Terminal({ cols: this.columns, rows: this.rows, allowProposedApi: true });
	input: (data: string) => void = () => {};
	resizeHandler: () => void = () => {};
	start(input: (data: string) => void, resize: () => void) { this.input = input; this.resizeHandler = resize; }
	stop() {}
	async drainInput() {}
	write(data: string) { this.screen.write(data); }
	moveBy(lines: number) { this.write("\x1b[" + Math.abs(lines) + (lines < 0 ? "A" : "B")); }
	hideCursor() { this.write("\x1b[?25l"); }
	showCursor() { this.write("\x1b[?25h"); }
	clearLine() { this.write("\x1b[2K"); }
	clearFromCursor() { this.write("\x1b[J"); }
	clearScreen() { this.write("\x1b[2J"); }
	setTitle() {}
	setProgress() {}
	async flush() { await new Promise<void>((resolve) => this.screen.write("", resolve)); }
	resize(columns: number, rows: number) {
		this.columns = columns; this.rows = rows;
		this.screen.resize(columns, rows);
		this.resizeHandler();
	}
	lines() {
		return Array.from({ length: this.rows }, (_, row) =>
			this.screen.buffer.active.getLine(row)?.translateToString(true) ?? "");
	}
	mouse(code: number, x: number, y: number, release = false) {
		this.input("\x1b[<" + code + ";" + (x + 1) + ";" + (y + 1) + (release ? "m" : "M"));
	}
}
