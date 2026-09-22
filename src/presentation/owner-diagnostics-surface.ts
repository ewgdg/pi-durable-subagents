import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { OwnerRecoveryError } from "../bootstrap/owner-recovery-error.ts";
import { sanitizeReportTerminalText } from "./moderator-report-surface.ts";

const BLOCKAGE_WIDGET_KEY = "agent-coordination.blockage";
const PRESENTATION_ROWS = 2;

export function showOwnerBlockage(ui: ExtensionUIContext, failure: OwnerRecoveryError | undefined): void {
	ui.setWidget(BLOCKAGE_WIDGET_KEY, failure ? (_tui, theme) => {
		const heading = new Text("⚠ Subagent coordination blocked", 0, 0);
		const explanation = new Text("Saved coordination data is invalid; the protocol may have changed.", 0, 0);
		const hints = new Text("/agents diagnostics", 0, 0);
		const renderBody = (width: number) => [
			...heading.render(width).map((line) => theme.fg("warning", line)),
			...explanation.render(width),
			...hints.render(width).map((line) => theme.fg("dim", line)),
		];
		return {
			render(width: number) {
				const boundedWidth = Math.max(1, Math.floor(width));
				// Borders need one content column; on smaller terminals keep the
				// warning readable rather than producing negative interior widths.
				if (boundedWidth < 3) return renderBody(boundedWidth)
					.map((line) => truncateToWidth(line, boundedWidth, ""));
				const padding = boundedWidth >= 5 ? " " : "";
				const innerWidth = boundedWidth - 2 - padding.length * 2;
				return [
					theme.fg("warning", `┌${"─".repeat(boundedWidth - 2)}┐`),
					...renderBody(innerWidth).map((line) => `${theme.fg("warning", `│${padding}`)}${truncateToWidth(line, innerWidth, "", true)}${theme.fg("warning", `${padding}│`)}`),
					theme.fg("warning", `└${"─".repeat(boundedWidth - 2)}┘`),
				];
			},
			invalidate() { heading.invalidate(); explanation.invalidate(); hints.invalidate(); },
		};
	} : undefined);
}

export function openOwnerDiagnostics(
	ui: ExtensionUIContext,
	failure?: OwnerRecoveryError,
	options?: Readonly<{
		/** Manual repair entry from the admission-failed surface. Manual only, no watcher. */
		onRepair?: () => void | Promise<void>;
		/** Esc through the real input path revokes a pending repair approval via the persisted ledger. */
		onEsc?: () => void | Promise<void>;
	}>,
): Promise<void> {
	return ui.custom<void>((tui, theme, _keys, done) => new OwnerDiagnosticsSurface(tui, theme, failure, done, options), {
		overlay: true,
		overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
	});
}

function errorDescription(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function technicalError(error: unknown, seen = new Set<unknown>()): string {
	if (seen.has(error)) return "[Repeated error]";
	seen.add(error);
	if (!(error instanceof Error)) return String(error);
	return [error.stack ?? error.message,
		...(error.cause === undefined ? [] : ["Caused by:", technicalError(error.cause, seen)]),
		...(error instanceof AggregateError ? error.errors.map((item) => technicalError(item, seen)) : []),
	].join("\n");
}

function summaryText(failure: OwnerRecoveryError | undefined): string {
	if (!failure) return "No Owner admission failure is recorded in this attachment.\nThis is not an exhaustive audit of the Workflow.";
	const error = failure.protocolError;
	return [
		"Problem",
		"Saved coordination evidence fails current protocol validation.",
		`Reason: ${errorDescription(error.cause ?? error)}`,
		"A protocol version change may explain the incompatibility.",
		"This is the first encountered failure, not a complete list of problems.",
		"",
		"Impact",
		"Owner coordination admission failed; ordinary coordination tools are disabled here.",
		"Pi and conversation context remain available. No transcript repair was performed.",
		...(failure.cleanupError === undefined ? [] : ["Partial coordinator cleanup also failed; inspect technical details."]),
		"This diagnostic does not establish the state of other running processes.",
		"",
		"Recovery",
	"Manual repair: /agents repair <reason> opens a real Moderator for diagnosis first (diagnostics r uses the default reason).",
	"Replace path (Owner only): /agents repair-freeze, then /agents repair-confirm <snapshotId>, then /agents repair-commit <snapshotId> seals the exact frozen bytes with backup/verify/journal, then the Owner stays idle until a new human message. Esc revokes a pending approval.",
	"Unadmitted originals stay unavailable; no auto trigger, no watcher.",
		"Native /fork preserves selected conversation in a new independent Workflow; /clone copies the active branch.",
		"Owner role identification must have succeeded; otherwise fork is refused. Native /new remains available.",
		"Copied coordination history grants no authority or pending obligations; the source transcript is unchanged.",
		"Keep the original session; inspect technical details before planning a repair.",
	].join("\n");
}

function technicalText(failure: OwnerRecoveryError | undefined): string {
	if (!failure) return summaryText(failure);
	const source = failure.protocolError.source;
	// An admission scan can encounter another Agent's evidence. Do not label
	// that source with the Owner's file merely because the Owner was bootstrapping.
	const transcriptPath = failure.protocolError.transcriptPath !== undefined
		? failure.protocolError.transcriptPath
		: !source || source.agentId === failure.agentId ? failure.transcriptPath ?? null : undefined;
	return [
		`Stage: ${failure.stage}`,
		`Agent: ${source?.agentId ?? failure.agentId}`,
		`Transcript: ${transcriptPath === null ? "Not file-backed" : transcriptPath ?? "Unavailable"}`,
		...(source ? [`Entry: ${source.entryId}`, `Tool call: ${source.toolCallId}`] : []),
		"",
		technicalError(failure.protocolError),
		...(failure.cleanupError === undefined ? [] : ["", "Cleanup failure:", technicalError(failure.cleanupError)]),
	].join("\n");
}

class OwnerDiagnosticsSurface implements Component {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly failure: OwnerRecoveryError | undefined;
	readonly done: () => void;
	readonly onRepair: (() => void | Promise<void>) | undefined;
	readonly onEsc: (() => void | Promise<void>) | undefined;
	readonly #body = new Text("", 0, 0);
	#technical = false;
	#scrollTop = 0;
	#maximumScrollTop = 0;
	#viewportRows = 1;

	constructor(tui: TUI, theme: Theme, failure: OwnerRecoveryError | undefined,
		done: () => void,
		options?: Readonly<{ onRepair?: () => void | Promise<void>; onEsc?: () => void | Promise<void> }>) {
		this.tui = tui;
		this.theme = theme;
		this.failure = failure;
		this.done = done;
		this.onRepair = options?.onRepair;
		this.onEsc = options?.onEsc;
		this.#updateBody();
	}

	#updateBody(): void {
		this.#body.setText(sanitizeReportTerminalText(this.#technical ? technicalText(this.failure) : summaryText(this.failure)));
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(1, Math.floor(width));
		const height = Math.max(1, Math.floor(this.tui.terminal.rows));
		const body = this.#body.render(boundedWidth);
		this.#viewportRows = Math.max(0, height - PRESENTATION_ROWS);
		this.#maximumScrollTop = Math.max(0, body.length - this.#viewportRows);
		this.#scrollTop = Math.min(this.#scrollTop, this.#maximumScrollTop);
		const footer = this.theme.fg("dim", "q close · Esc close" + (this.onRepair ? " · r repair" : "") + " · " + (this.#technical ? "s Summary" : "t Technical details") + " · ↑/↓/wheel · PgUp/PgDn · Home/End");
		// Overlay composition covers only returned rows. Emit the whole viewport,
		// including blank cells, so short diagnostics cannot expose underlying chat.
		return [
			...(height > 1 ? [this.theme.fg("accent", this.theme.bold(`${this.failure ? "Subagent coordination blocked" : "Subagent coordination diagnostics"} · ${this.#technical ? "Technical details" : "Summary"}`))] : []),
			...Array.from({ length: this.#viewportRows }, (_, row) => body[this.#scrollTop + row] ?? ""),
			footer,
		].map((line) => truncateToWidth(line, boundedWidth, "", true));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) { if (matchesKey(data, Key.escape) && this.onEsc) void this.onEsc(); this.done(); return; }
		if (matchesKey(data, "r") && this.onRepair) {
			try {
				const result = this.onRepair!();
				if (result instanceof Promise) {
					void result.then(
						() => this.done(),
						() => undefined,
					);
				} else {
					this.done();
				}
			} catch {
				}
			return;
		}
		if (matchesKey(data, "t") || matchesKey(data, "s")) {
			this.#technical = matchesKey(data, "t");
			this.#scrollTop = 0;
			this.#updateBody();
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.#scrollTop--;
		else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.#scrollTop++;
		else if (matchesKey(data, Key.pageUp)) this.#scrollTop -= Math.max(1, this.#viewportRows - 1);
		else if (matchesKey(data, Key.pageDown)) this.#scrollTop += Math.max(1, this.#viewportRows - 1);
		else if (matchesKey(data, Key.home)) this.#scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.#scrollTop = this.#maximumScrollTop;
		else return;
		this.#clampScroll();
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return undefined;
		const previous = this.#scrollTop;
		this.#scrollTop += event.wheelDelta ?? 0;
		this.#clampScroll();
		return { handled: true, render: previous !== this.#scrollTop };
	}

	#clampScroll(): void { this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, this.#maximumScrollTop)); }
	invalidate(): void { this.#body.invalidate(); }
}
