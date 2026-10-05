import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type {
	RemoteAgentSelectionResult,
	RemoteAgentSelectorSnapshot,
} from "../control/agent-control-protocol.ts";
import type { HumanPresentationCoordinatorView } from "../coordination/workflow-coordinator.ts";
import {
	createAgentSelectionSession,
	createAgentSelectorSnapshot,
	type AgentSelectionSession,
} from "../process-runtime/remote-agent-selector.ts";
import type { ControlBackedChildPresentationHandlers } from "../process-runtime/remote-participant-control.ts";
import {
	openAgentViewSurface,
	startPhysicalAgentViewSurface,
	type PhysicalAgentViewSurface,
} from "./agent-view-surface.ts";
import type { AgentsNavigationAdapter } from "./agents-navigation.ts";
import type { PhysicalTerminalPort } from "./physical-terminal-attachment.ts";
import { openPostMortemAgentViewSurface } from "./post-mortem-agent-view-surface.ts";

type LocalPreparedSelection = Readonly<{
	selection: AgentSelectionSession;
	physicalSurface: PhysicalAgentViewSurface | undefined;
}>;

/**
 * Agents Navigation for the Owner session, over its own participant view. The
 * Owner's terminal hosts every surface, so this adapter starts the physical
 * attachment itself and presents the Post-mortem View in its own UI.
 */
export function createLocalAgentsNavigation(
	view: HumanPresentationCoordinatorView,
	ctx: Pick<ExtensionCommandContext, "ui" | "shutdown">,
	physicalTerminal?: PhysicalTerminalPort,
): AgentsNavigationAdapter<LocalPreparedSelection> {
	// Navigation uses the admitted projection; a transcript refresh must not
	// prevent opening the selector or returning to Owner.
	const selectedAgentId = view.status().agentId;
	const snapshot = () => createAgentSelectorSnapshot(view, selectedAgentId);
	return {
		snapshot: async () => snapshot(),
		addChangeHandler: (handler) => view.addAgentActivityChangeHandler(() => handler(snapshot())),
		setReportRead: async (reportId, read) => view.setReportRead(reportId, read),
		async prepare(action, ownerTui) {
			const selection = createAgentSelectionSession(view, selectedAgentId);
			await selection.prepare(action);
			const preparedView = selection.preparedView();
			const physicalSurface = preparedView && ownerTui
				? startPhysicalAgentViewSurface(preparedView, {
					ownerTui,
					requestShutdown: () => ctx.shutdown(),
					physicalTerminal,
				})
				: undefined;
			try {
				if (physicalSurface) {
					// The Post-mortem presenter suspends and resumes this attachment.
					const unbind = view.bindPhysicalAgentSurface(physicalSurface);
					void physicalSurface.closed.finally(unbind);
					await physicalSurface.ready;
				}
				// Focus failure rolls the transaction back to the previous selection.
				await selection.complete(action);
			} catch (error) {
				physicalSurface?.close();
				throw error;
			}
			return { selection, physicalSurface };
		},
		async present({ selection, physicalSurface }) {
			const postMortem = selection.postMortemView();
			if (postMortem) {
				return await openPostMortemAgentViewSurface(ctx.ui, postMortem) === "agents"
					? "reopen_selector"
					: "done";
			}
			const preparedView = selection.preparedView();
			if (physicalSurface) {
				void physicalSurface.closed.catch((error) => ctx.ui.notify(
					`Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				));
			} else if (preparedView) {
				// Terminals without physical attachment support get the non-physical view.
				await openAgentViewSurface(ctx.ui, preparedView, { requestShutdown: () => ctx.shutdown() });
			}
			return "done";
		},
	};
}

/** A child's presentation proxy; changes come from the child's own activity subscription. */
export type ChildAgentsPresentation = ControlBackedChildPresentationHandlers & Readonly<{
	addChangeHandler(handler: (snapshot: RemoteAgentSelectorSnapshot) => void): () => void;
}>;

/**
 * Agents Navigation for a child process. The Owner side prepares, focuses, and
 * presents any Post-mortem View inside the select request, so presenting here
 * only reads that request's bounded outcome.
 */
export function createControlAgentsNavigation(
	presentation: ChildAgentsPresentation,
): AgentsNavigationAdapter<RemoteAgentSelectionResult> {
	return {
		snapshot: () => presentation.snapshot(),
		addChangeHandler: (handler) => presentation.addChangeHandler(handler),
		setReportRead: (reportId, read) => presentation.setReportRead(reportId, read),
		prepare: (action) => presentation.select(action),
		present: async (result) =>
			result.kind === "post_mortem" && result.outcome === "agents" ? "reopen_selector" : "done",
	};
}
