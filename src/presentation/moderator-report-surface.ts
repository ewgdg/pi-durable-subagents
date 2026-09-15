import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult, type TUI } from "@earendil-works/pi-tui";
import { formatModeratorReport, type ReportHistoryItem } from "../protocol/moderator-report.ts";

const FIXED_PRESENTATION_ROWS = 3;
const PAGE_OVERLAP_ROWS = 1;

export type ModeratorReportSurfaceResult = "back" | "view_reporter";
export type ModeratorReportSurfaceOptions = Readonly<{
	setRead(read: boolean): Promise<void> | void;
	copyReport(text: string): Promise<void> | void;
	prepareReporter?(): Promise<void> | void;
}>;

export function openModeratorReportSurface(
	ui: ExtensionUIContext,
	item: ReportHistoryItem,
	options: ModeratorReportSurfaceOptions,
): Promise<ModeratorReportSurfaceResult> {
	return ui.custom<ModeratorReportSurfaceResult>(
		(tui, theme, _keybindings, done) => new ModeratorReportSurface(tui, theme, item, options, done),
		{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
	);
}

class ModeratorReportSurface implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #options: ModeratorReportSurfaceOptions;
	readonly #done: (result: ModeratorReportSurfaceResult) => void;
	readonly #reportText: string;
	readonly #hasReporter: boolean;
	readonly #body: Text;
	#read: boolean;
	#pending: "action" | "reporter" | undefined;
	#closed = false;
	#feedback = "";
	#scrollTop = 0;
	#maximumScrollTop = 0;
	#viewportRows = 1;

	constructor(tui: TUI, theme: Theme, item: ReportHistoryItem,
		options: ModeratorReportSurfaceOptions, done: (result: ModeratorReportSurfaceResult) => void) {
		this.#tui = tui;
		this.#theme = theme;
		this.#options = options;
		this.#done = done;
		this.#read = item.readAt !== undefined;
		this.#hasReporter = item.report.reporter !== undefined;
		this.#reportText = formatModeratorReport(item.report, item.findings);
		// Plain wrapped Markdown keeps every source reference visible, including link destinations.
		this.#body = new Text(sanitizeReportTerminalText(this.#reportText), 0, 0);
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(1, Math.floor(width));
		const height = Math.max(1, Math.floor(this.#tui.terminal.rows));
		const body = this.#body.render(boundedWidth);
		this.#viewportRows = Math.max(1, height - FIXED_PRESENTATION_ROWS);
		this.#maximumScrollTop = Math.max(0, body.length - this.#viewportRows);
		this.#scrollTop = Math.min(this.#scrollTop, this.#maximumScrollTop);
		const lines = [
			this.#theme.fg("accent", this.#theme.bold(`${this.#hasReporter ? "Moderator" : "Runtime"} report · read-only · ${this.#read ? "Read" : "Unread"}`)),
			...body.slice(this.#scrollTop, this.#scrollTop + this.#viewportRows),
			this.#theme.fg("muted", this.#pending === "reporter" ? "Opening reporter…" : this.#pending ? "Working…" : this.#feedback),
			this.#theme.fg("dim", `m Toggle read · c Copy report · ${this.#hasReporter && this.#options.prepareReporter ? "v View reporter · " : ""}↑/↓/wheel scroll · PgUp/PgDn · Home/End · Esc/q back`),
		];
		return lines.slice(0, height).map((line) => truncateToWidth(line, boundedWidth, ""));
	}

	handleInput(data: string): void {
		// Keep the report focused until the replacement presentation is ready.
		if (this.#closed || this.#pending === "reporter") return;
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.#close("back");
			return;
		}
		if (matchesKey(data, "v")) {
			if (!this.#hasReporter || !this.#options.prepareReporter) return;
			if (!this.#pending) void this.#perform(async () => {
				await this.#options.prepareReporter!();
				this.#close("view_reporter");
			}, "reporter");
			return;
		}
		if (matchesKey(data, "m")) {
			if (!this.#pending) void this.#perform(async () => {
				const read = !this.#read;
				await this.#options.setRead(read);
				this.#read = read;
				this.#feedback = read ? "Marked read" : "Marked unread";
			});
			return;
		}
		if (matchesKey(data, "c")) {
			if (!this.#pending) void this.#perform(async () => {
				await this.#options.copyReport(this.#reportText);
				this.#feedback = "Copied report";
			});
			return;
		}
		const pageRows = Math.max(1, this.#viewportRows - PAGE_OVERLAP_ROWS);
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.#scrollTop--;
		else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.#scrollTop++;
		else if (matchesKey(data, Key.pageUp)) this.#scrollTop -= pageRows;
		else if (matchesKey(data, Key.pageDown)) this.#scrollTop += pageRows;
		else if (matchesKey(data, Key.home)) this.#scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.#scrollTop = this.#maximumScrollTop;
		else return;
		this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, this.#maximumScrollTop));
		this.#tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return undefined;
		if (this.#closed || this.#pending === "reporter" || !event.wheelDelta) {
			return { handled: true, render: false };
		}
		// Pi owns fullscreen mouse capture; consume wheel input even at the report boundaries.
		const nextScrollTop = Math.max(0, Math.min(
			this.#maximumScrollTop, this.#scrollTop + event.wheelDelta,
		));
		const changed = nextScrollTop !== this.#scrollTop;
		this.#scrollTop = nextScrollTop;
		return { handled: true, render: changed };
	}

	invalidate(): void { this.#body.invalidate(); }

	dispose(): void { this.#closed = true; }

	#close(result: ModeratorReportSurfaceResult): void {
		this.#closed = true;
		this.#done(result);
	}

	async #perform(operation: () => Promise<void>, kind: "action" | "reporter" = "action"): Promise<void> {
		this.#pending = kind;
		this.#feedback = "";
		this.#tui.requestRender();
		try {
			await operation();
		} catch (error) {
			// Failed actions stay visible; failed reporter preparation must not dismiss the report.
			this.#feedback = sanitizeReportTerminalText(error instanceof Error ? error.message : String(error))
				.replace(/\s+/g, " ");
		} finally {
			this.#pending = undefined;
			if (!this.#closed) this.#tui.requestRender();
		}
	}
}

/** Report text is evidence, not a channel for terminal commands. */
export function sanitizeReportTerminalText(value: string): string {
	return value
		.replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*(?:\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\)|\^[^\x1b]*(?:\x1b\\)|X[^\x1b]*(?:\x1b\\))/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
