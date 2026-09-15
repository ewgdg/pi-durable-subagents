import type { ReportHistoryItem } from "../protocol/moderator-report.ts";
import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

import type {
	AgentRosterStatus,
} from "../coordination/workflow-coordinator.ts";
import type { LiveRunState } from "../runtime/agent-runtime-host.ts";
import type { HumanAttentionItem } from "../coordination/human-requests.ts";
import type { OperationalIncidentAttention } from "../coordination/operational-incidents.ts";
import {
	formatOperationalIncidentHeadline,
} from "./operational-incident-surface.ts";
import {
	formatAgentWorkStatus,
	formatSelectedAgentIdentity,
	selectedAgentWorkStatus,
	type AgentWorkStatus,
} from "./selected-agent-status.ts";
import { boundedToolPreview } from "../tools/bounded-preview.ts";
import { sanitizeReportTerminalText } from "./moderator-report-surface.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_FRAME_INTERVAL_MS = 80;
const MAX_VISIBLE_ATTENTION_ROWS = 3;
const MAX_VISIBLE_AGENT_ROWS = 3;

export const AGENT_ACTIVITY_WIDGET_KEY = "agent-coordination-activity";

export type AgentActivityStatus = AgentRosterStatus & Readonly<{
	failed: boolean;
}>;

export type AgentActivitySnapshot = Readonly<{
	scope: AgentActivityStatus;
	children: readonly AgentActivityStatus[];
	answerMode: boolean;
	humanAttention: readonly HumanAttentionItem[];
	operationalAttention: readonly OperationalIncidentAttention[];
	reports?: readonly ReportHistoryItem[];
}>;

export type AgentActivitySource = Readonly<{
	snapshot(): AgentActivitySnapshot;
	addChangeHandler(handler: () => void): () => void;
}>;

export function installAgentActivityDock(
	ui: Pick<ExtensionUIContext, "setWidget">,
	source: AgentActivitySource,
): void {
	ui.setWidget(
		AGENT_ACTIVITY_WIDGET_KEY,
		(tui, theme) => new AgentActivityDock(tui, theme, source),
		{ placement: "aboveEditor" },
	);
}

export class AgentActivityDock implements Component {
	readonly #tui: Pick<TUI, "requestRender">;
	readonly #theme: Theme;
	readonly #removeChangeHandler: () => void;
	#snapshot: AgentActivitySnapshot;
	#spinnerTimer: ReturnType<typeof setInterval> | undefined;
	#disposed = false;

	constructor(
		tui: Pick<TUI, "requestRender">,
		theme: Theme,
		source: AgentActivitySource,
	) {
		this.#tui = tui;
		this.#theme = theme;
		// Snapshot construction can inspect entire child histories. Keep that work
		// on activity changes so editor, resize, and animation redraws stay cheap.
		this.#snapshot = source.snapshot();
		this.#removeChangeHandler = source.addChangeHandler(() => {
			this.#snapshot = source.snapshot();
			this.#syncSpinner();
			this.#tui.requestRender();
		});
		this.#syncSpinner();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const snapshot = this.#snapshot;
		const ownerScope = snapshot.scope.agentId === snapshot.scope.workflowId;
		const identityLines = ownerScope
			? []
			: [formatSelectedAgentIdentity({
				label: snapshot.scope.label,
				agentId: snapshot.scope.agentId,
				status: selectedAgentWorkStatus(
					snapshot.scope.run,
					snapshot.scope.failed,
					snapshot.scope.compacting,
				),
			}, this.#theme)];
		const attentionLines = ownerScope
			? this.#renderAttention(
				snapshot.humanAttention,
				snapshot.operationalAttention.filter(({ trigger, reportSource }) => {
					if (trigger.kind === "moderation_unavailable") return false;
					// Linked reports own inbox acknowledgement; unresolved state remains a live status.
					return !reportSource || !(snapshot.reports ?? []).some(({ report }) =>
						report.source.kind === "runtime_diagnostic" && report.source.agentId === reportSource.agentId && report.source.entryId === reportSource.entryId);
				}),
				snapshot.reports ?? [],
			)
			: [];
		const liveChildren = snapshot.children.filter(hasLiveRun);
		const visibleChildren = liveChildren.slice(0, MAX_VISIBLE_AGENT_ROWS);
		const hiddenChildCount = liveChildren.length - visibleChildren.length;
		const visibleAgentRowCount = visibleChildren.length + (hiddenChildCount > 0 ? 1 : 0);
		const agentLines = liveChildren.length === 0
			? []
			: [
				this.#heading("Agents"),
				...visibleChildren.map((child, index) =>
					this.#renderAgent(child, index, visibleAgentRowCount)
				),
				...(hiddenChildCount > 0
					? [this.#theme.fg("dim", `└─ … ${hiddenChildCount} more`)]
					: []),
			];
		const answerModeLines = snapshot.answerMode
			? [
				`${this.#theme.fg("accent", this.#theme.bold("ANSWER"))}${this.#theme.fg("dim", " · Enter submits")}`,
			]
			: [];
		const operationalStatus = !ownerScope ? []
			: snapshot.operationalAttention.some(({ trigger }) => trigger.kind === "moderation_unavailable")
				? [this.#theme.fg("warning", "Moderation Unavailable · live status")]
				: snapshot.operationalAttention.some(({ reportSource }) => reportSource !== undefined)
					? [this.#theme.fg("warning", "Operational incident unresolved · live status")] : [];
		return [...identityLines, ...operationalStatus, ...attentionLines, ...agentLines, ...answerModeLines].map(
			(line) => truncateToWidth(line, safeWidth, ""),
		);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#removeChangeHandler();
		this.#stopSpinner();
	}

	#renderAttention(
		human: readonly HumanAttentionItem[],
		operational: readonly OperationalIncidentAttention[],
		reports: readonly ReportHistoryItem[],
	): string[] {
		const items = [
			...human.map((attention) => ({
				kind: "human" as const,
				attention,
			})),
			...operational.map((attention) => ({
				kind: "operational" as const,
				attention,
			})),
			...reports.filter(({ readAt }) => readAt === undefined).map(({ report }) => ({ kind: "report" as const, report })),
		];
		if (items.length === 0) return [];
		const visibleItems = items.slice(0, MAX_VISIBLE_ATTENTION_ROWS);
		const hiddenItemCount = items.length - visibleItems.length;
		const visibleRowCount = visibleItems.length + (hiddenItemCount > 0 ? 1 : 0);
		return [
			this.#heading("Attention Inbox"),
			...visibleItems.map((item, index) => {
				const branch = index === visibleRowCount - 1 ? "└─" : "├─";
				if (item.kind === "report") {
					return `${branch} ${this.#theme.fg("warning", "REPORT")} ${boundedToolPreview(sanitizeReportTerminalText(item.report.reporter?.label ?? "Runtime"))} · ${boundedToolPreview(sanitizeReportTerminalText(item.report.symptom))}`;
				}
				if (item.kind === "human") {
					return `${branch} ${this.#theme.fg("warning", "DECIDE")} ${this.#theme.bold(item.attention.agentLabel)} · ${boundedToolPreview(item.attention.question)}`;
				}
				return `${branch} ${this.#theme.fg("warning", "ATTENTION")} ${formatOperationalIncidentHeadline(item.attention)}`;
			}),
			...(hiddenItemCount > 0
				? [this.#theme.fg("dim", `└─ … ${hiddenItemCount} more`)]
				: []),
		];
	}

	#renderAgent(
		agent: LiveAgentActivityStatus,
		index: number,
		count: number,
	): string {
		const branch = index === count - 1 ? "└─" : "├─";
		const status = activityRowStatus(agent);
		const glyph = this.#activityGlyph(agent, status);
		const model = `${agent.model.provider}/${agent.model.modelId}:${agent.thinking}`;
		const queued = agent.queuedInputCount === 0
			? ""
			: ` · ${agent.queuedInputCount} queued`;
		return `${branch} ${glyph} ${this.#theme.bold(agent.label)} · ${model} · ${formatActivityRowStatus(status, this.#theme)}${queued}`;
	}

	#activityGlyph(agent: LiveAgentActivityStatus, status: AgentWorkStatus): string {
		if (status.kind === "active" || status.kind === "starting" || status.kind === "compacting") {
			const frame = SPINNER_FRAMES[
				Math.floor(Date.now() / SPINNER_FRAME_INTERVAL_MS) % SPINNER_FRAMES.length
			]!;
			return this.#theme.fg("accent", frame);
		}
		if (status.kind === "waiting") return this.#theme.fg("warning", "■");
		if (status.kind === "failed") return this.#theme.fg("error", "×");
		return this.#theme.fg("dim", "○");
	}

	#heading(label: string): string {
		return this.#theme.fg("toolTitle", this.#theme.bold(label));
	}

	#syncSpinner(): void {
		if (this.#disposed) return;
		const animated = this.#snapshot.children
			.filter(hasLiveRun)
			.slice(0, MAX_VISIBLE_AGENT_ROWS)
			.some((child) => {
			const status = activityRowStatus(child);
			return status.kind === "active" || status.kind === "starting" || status.kind === "compacting";
		});
		if (!animated) {
			this.#stopSpinner();
			return;
		}
		if (this.#spinnerTimer) return;
		this.#spinnerTimer = setInterval(
			() => this.#tui.requestRender(),
			SPINNER_FRAME_INTERVAL_MS,
		);
		this.#spinnerTimer.unref?.();
	}

	#stopSpinner(): void {
		if (!this.#spinnerTimer) return;
		clearInterval(this.#spinnerTimer);
		this.#spinnerTimer = undefined;
	}
}

type LiveAgentActivityStatus = Omit<AgentActivityStatus, "run"> & Readonly<{
	run: LiveRunState;
}>;

function hasLiveRun(agent: AgentActivityStatus): agent is LiveAgentActivityStatus {
	return agent.run.phase !== "dormant";
}

function activityRowStatus(agent: LiveAgentActivityStatus): AgentWorkStatus {
	return selectedAgentWorkStatus(agent.run, agent.failed, agent.compacting);
}

function formatActivityRowStatus(status: AgentWorkStatus, theme: Theme): string {
	return formatAgentWorkStatus(status, theme);
}
