import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	buildContextEntries,
	getMarkdownTheme,
	sessionEntryToContextMessages,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	Container,
	Key,
	Spacer,
	matchesKey,
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import type { PhysicalAgentViewSurface } from "./agent-view-surface.ts";

const FIXED_PRESENTATION_ROWS = 4;
const PAGE_OVERLAP_ROWS = 1;

export type PostMortemAgentViewResult = "agents" | "back";

export type PostMortemAgentView = Readonly<{
	kind: "post_mortem";
	agentId: string;
	label: string;
	transcript: TranscriptInspection;
	preparationError: string;
}>;

export type PostMortemAgentPresenter = Readonly<{
	present(view: PostMortemAgentView): Promise<PostMortemAgentViewResult>;
	bindPhysicalSurface(surface: PhysicalAgentViewSurface): () => void;
}>;

export class OwnerPostMortemAgentPresenter implements PostMortemAgentPresenter {
	readonly #ui: ExtensionUIContext;
	#physicalSurface: PhysicalAgentViewSurface | undefined;

	constructor(ui: ExtensionUIContext) {
		this.#ui = ui;
	}

	bindPhysicalSurface(surface: PhysicalAgentViewSurface): () => void {
		this.#physicalSurface = surface;
		return () => {
			if (this.#physicalSurface === surface) this.#physicalSurface = undefined;
		};
	}

	async present(view: PostMortemAgentView): Promise<PostMortemAgentViewResult> {
		const physicalSurface = this.#physicalSurface;
		if (physicalSurface) await physicalSurface.suspend();
		try {
			return await openPostMortemAgentViewSurface(this.#ui, view);
		} finally {
			if (physicalSurface && this.#physicalSurface === physicalSurface) {
				await physicalSurface.resume();
			}
		}
	}
}

export function openPostMortemAgentViewSurface(
	ui: ExtensionUIContext,
	view: PostMortemAgentView,
): Promise<PostMortemAgentViewResult> {
	return ui.custom<PostMortemAgentViewResult>(
		(tui, theme, _keybindings, done) => new PostMortemAgentViewSurface({
			tui,
			theme,
			agentId: view.agentId,
			label: view.label,
			transcript: view.transcript,
			preparationError: view.preparationError,
			done,
		}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);
}

/**
 * Owner-hosted durable evidence viewer used only when no Agent Runtime can
 * provide the normal complete interactive presentation.
 */
export class PostMortemAgentViewSurface implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #agentId: string;
	readonly #label: string;
	readonly #preparationError: string;
	readonly #done: (result: PostMortemAgentViewResult) => void;
	readonly #transcript: Component;
	#scrollTop = Number.POSITIVE_INFINITY;
	#maximumScrollTop = 0;
	#viewportRows = 1;
	#closed = false;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		agentId: string;
		label: string;
		transcript: TranscriptInspection;
		preparationError: unknown;
		done(result: PostMortemAgentViewResult): void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#agentId = sanitizeTerminalText(options.agentId);
		this.#label = sanitizeTerminalText(options.label);
		this.#preparationError = sanitizeTerminalText(errorMessage(options.preparationError));
		this.#done = options.done;
		this.#transcript = createTranscriptPresentation(
			sanitizeTranscript(options.transcript),
			options.tui,
		);
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(1, Math.floor(width));
		const body = this.#transcript.render(boundedWidth);
		this.#viewportRows = Math.max(
			1,
			Math.floor(this.#tui.terminal.rows) - FIXED_PRESENTATION_ROWS,
		);
		this.#maximumScrollTop = Math.max(0, body.length - this.#viewportRows);
		if (!Number.isFinite(this.#scrollTop)) this.#scrollTop = this.#maximumScrollTop;
		this.#scrollTop = clamp(this.#scrollTop, 0, this.#maximumScrollTop);
		const title = `${this.#label} · ${this.#agentId}`;
		const availability = `Runtime unavailable: ${this.#preparationError}`;
		const help = "↑/k ↓/j scroll · PgUp/PgDn · Home/End · a agents · Esc/q back";
		return [
			truncateToWidth(
				this.#theme.fg("accent", this.#theme.bold("Post-mortem · read-only")),
				boundedWidth,
				"",
			),
			truncateToWidth(this.#theme.fg("muted", title), boundedWidth, ""),
			...body.slice(this.#scrollTop, this.#scrollTop + this.#viewportRows),
			truncateToWidth(this.#theme.fg("warning", availability), boundedWidth, ""),
			truncateToWidth(this.#theme.fg("dim", help), boundedWidth, ""),
		];
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.#close("back");
			return;
		}
		if (matchesKey(data, "a")) {
			this.#close("agents");
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.#scrollBy(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.#scrollBy(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.#scrollBy(-this.#pageRows());
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.#scrollBy(this.#pageRows());
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.#scrollTo(0);
			return;
		}
		if (matchesKey(data, Key.end)) this.#scrollTo(this.#maximumScrollTop);
	}

	invalidate(): void {
		this.#transcript.invalidate();
	}

	scrollTop(): number {
		return this.#scrollTop;
	}

	maximumScrollTop(): number {
		return this.#maximumScrollTop;
	}

	#pageRows(): number {
		return Math.max(1, this.#viewportRows - PAGE_OVERLAP_ROWS);
	}

	#scrollBy(lines: number): void {
		this.#scrollTo(this.#scrollTop + lines);
	}

	#scrollTo(scrollTop: number): void {
		this.#scrollTop = clamp(scrollTop, 0, this.#maximumScrollTop);
		this.#tui.requestRender();
	}

	#close(result: PostMortemAgentViewResult): void {
		this.#closed = true;
		this.#done(result);
	}
}

function createTranscriptPresentation(
	transcript: TranscriptInspection,
	tui: TUI,
): Component {
	const presentation = new Container();
	const markdownTheme = getMarkdownTheme();
	const activeTail = transcript.activeBranch.at(-1)?.id;
	const entries = buildContextEntries(
		[...transcript.entries],
		activeTail,
		new Map(transcript.entries.map((entry) => [entry.id, entry])),
	);
	const pendingTools = new Map<string, ToolExecutionComponent>();
	for (const message of entries.flatMap((entry) => sessionEntryToContextMessages(entry))) {
		if (message.role === "assistant") {
			presentation.addChild(new AssistantMessageComponent(
				message,
				false,
				markdownTheme,
				"Thinking...",
				1,
			));
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const tool = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					undefined,
					undefined,
					tui,
					transcript.header?.cwd ?? process.cwd(),
				);
				presentation.addChild(tool);
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					tool.updateResult({
						content: [{
							type: "text",
							text: message.errorMessage ?? (
								message.stopReason === "aborted" ? "Operation aborted" : "Error"
							),
						}],
						isError: true,
					});
				} else {
					pendingTools.set(content.id, tool);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const tool = pendingTools.get(message.toolCallId);
			if (tool) {
				tool.updateResult(message);
				pendingTools.delete(message.toolCallId);
			}
			continue;
		}
		appendNonToolMessage(presentation, message, tui);
	}
	return presentation;
}

function appendNonToolMessage(
	presentation: Container,
	message: Exclude<AgentMessage, AssistantMessage | ToolResultMessage>,
	tui: TUI,
): void {
	const markdownTheme = getMarkdownTheme();
	if (message.role === "user") {
		const text = typeof message.content === "string"
			? message.content
			: message.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n");
		if (text.length > 0) {
			presentation.addChild(new Spacer(1));
			presentation.addChild(new UserMessageComponent(text, markdownTheme, 1));
		}
		return;
	}
	if (message.role === "custom") {
		if (message.display) {
			presentation.addChild(new CustomMessageComponent(
				message,
				undefined,
				markdownTheme,
				1,
			));
		}
		return;
	}
	if (message.role === "compactionSummary") {
		presentation.addChild(new Spacer(1));
		presentation.addChild(new CompactionSummaryMessageComponent(message, markdownTheme));
		return;
	}
	if (message.role === "branchSummary") {
		presentation.addChild(new Spacer(1));
		presentation.addChild(new BranchSummaryMessageComponent(message, markdownTheme));
		return;
	}
	if (message.role === "bashExecution") {
		const bash = new BashExecutionComponent(message.command, tui, message.excludeFromContext);
		if (message.output) bash.appendOutput(message.output);
		bash.setComplete(
			message.exitCode,
			message.cancelled,
			undefined,
			message.fullOutputPath,
		);
		presentation.addChild(bash);
	}
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sanitizeTranscript(transcript: TranscriptInspection): TranscriptInspection {
	return sanitizeEvidenceValue(transcript) as TranscriptInspection;
}

function sanitizeEvidenceValue(value: unknown): unknown {
	if (typeof value === "string") return sanitizeTerminalText(value);
	if (Array.isArray(value)) return value.map(sanitizeEvidenceValue);
	if (!value || typeof value !== "object") return value;
	const sanitized: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		// Images are not needed for this textual diagnostic surface and can invoke
		// terminal image protocols. Preserve a safe placeholder instead.
		if (key === "data" && "mimeType" in value && typeof value.mimeType === "string") {
			sanitized[key] = "";
			continue;
		}
		sanitized[key] = sanitizeEvidenceValue(nested);
	}
	return sanitized;
}

function sanitizeTerminalText(value: string): string {
	return value
		// OSC, DCS, APC, PM, and SOS strings terminated by BEL or ST.
		.replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*(?:\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\)|\^[^\x1b]*(?:\x1b\\)|X[^\x1b]*(?:\x1b\\))/g, "")
		// CSI and remaining two-byte ESC commands.
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		// C0/C1 controls except the layout characters rendered safely by Pi.
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
