import { copyToClipboard, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import type { RemoteAgentSelectorSnapshot } from "../control/agent-control-protocol.ts";
import {
	openAgentSelectorSurface,
	requireWorkflowOwner,
	type AgentSelectorAction,
} from "./agent-selector-surface.ts";
import { openModeratorReportSurface } from "./moderator-report-surface.ts";

export type AgentsNavigationTarget = "selector" | "owner";

/** A selector choice that selects an Agent; Report actions stay inside the loop. */
export type AgentSelectionAction = Exclude<AgentSelectorAction, { kind: "open_report" }>;

/** `reopen_selector` when a presented Post-mortem View was left with `a`. */
export type AgentsNavigationNext = "reopen_selector" | "done";

/**
 * What differs between the Owner session and a child process. Selection is
 * two-phase: `prepare` runs while the selector shows its loading row, and
 * `present` runs after the selector or Report has closed.
 */
export type AgentsNavigationAdapter<Prepared> = Readonly<{
	snapshot(): Promise<RemoteAgentSelectorSnapshot>;
	addChangeHandler(handler: (snapshot: RemoteAgentSelectorSnapshot) => void): () => void;
	setReportRead(reportId: string, read: boolean): Promise<void>;
	/** `tui` is the selector's terminal UI; `/agents owner` has none. */
	prepare(action: AgentSelectionAction, tui: TUI | undefined): Promise<Prepared>;
	present(prepared: Prepared): Promise<AgentsNavigationNext>;
}>;

/** Run one `/agents` command: return to the Owner, or open the selector until it ends. */
export async function navigateAgents<Prepared>(
	ui: ExtensionUIContext,
	adapter: AgentsNavigationAdapter<Prepared>,
	target: AgentsNavigationTarget,
): Promise<void> {
	let next: AgentsNavigationNext = target === "owner"
		? await returnToOwner(adapter)
		: "reopen_selector";
	while (next === "reopen_selector") next = await runSelector(ui, adapter);
}

async function returnToOwner<Prepared>(
	adapter: AgentsNavigationAdapter<Prepared>,
): Promise<AgentsNavigationNext> {
	const owner = requireWorkflowOwner(await adapter.snapshot());
	return adapter.present(await adapter.prepare({ kind: "select_agent", agentId: owner.agentId }, undefined));
}

/** Open the selector once, plus any Report it leads to, and present the chosen selection. */
async function runSelector<Prepared>(
	ui: ExtensionUIContext,
	adapter: AgentsNavigationAdapter<Prepared>,
): Promise<AgentsNavigationNext> {
	let currentSnapshot: RemoteAgentSelectorSnapshot | undefined;
	let publishSnapshot: ((snapshot: RemoteAgentSelectorSnapshot) => void) | undefined;
	// Listen before the snapshot request: a change delivered while it is pending
	// is newer than its result and is replayed when the selector mounts.
	const removeChangeHandler = adapter.addChangeHandler((snapshot) => {
		currentSnapshot = snapshot;
		publishSnapshot?.(snapshot);
	});
	try {
		const initialSnapshot = await adapter.snapshot();
		currentSnapshot ??= initialSnapshot;
		let prepared: { selection: Prepared } | undefined;
		let selectorTui: TUI | undefined;
		const prepare = async (action: AgentSelectionAction) => {
			prepared = { selection: await adapter.prepare(action, selectorTui) };
		};
		const action = await openAgentSelectorSurface(ui, {
			...currentSnapshot,
			addChangeHandler(handler) {
				publishSnapshot = handler;
				handler(currentSnapshot!);
				return () => { publishSnapshot = undefined; };
			},
			async setReportRead(reportId, read) {
				await adapter.setReportRead(reportId, read);
				currentSnapshot = await adapter.snapshot();
				return currentSnapshot.reports;
			},
			async prepareSelection(action, tui) {
				selectorTui = tui;
				if (action.kind !== "open_report") await prepare(action);
			},
			onSelectionError(error) {
				ui.notify(`Agent view failed: ${errorMessage(error)}`, "error");
			},
		});
		if (action?.kind === "open_report") {
			const item = currentSnapshot.reports.find(({ report }) => report.reportId === action.reportId);
			if (!item) throw new Error("Report is unavailable");
			const reporter = "reporter" in item.report ? item.report.reporter : undefined;
			const outcome = await openModeratorReportSurface(ui, item, {
				setRead: (read) => adapter.setReportRead(action.reportId, read),
				copyReport: copyToClipboard,
				prepareReporter: reporter
					? () => prepare({ kind: "select_agent", agentId: reporter.agentId })
					: undefined,
			});
			if (outcome !== "view_reporter") return "reopen_selector";
		}
		return prepared ? await adapter.present(prepared.selection) : "done";
	} finally {
		removeChangeHandler();
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
