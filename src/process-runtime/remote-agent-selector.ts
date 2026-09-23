import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { openModeratorReportSurface } from "../presentation/moderator-report-surface.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	RemoteAgentSelectorAction,
	RemoteAgentSelectorSnapshot,
} from "../control/agent-control-protocol.ts";
import type { HumanPresentationCoordinatorView } from "../coordination/workflow-coordinator.ts";
import {
	openAgentSelectorSurface,
	type AgentSelectorAction,
} from "../presentation/agent-selector-surface.ts";
import type { DurableAgentView } from "../presentation/agent-view-surface.ts";
import type { PostMortemAgentView } from "../presentation/post-mortem-agent-view-surface.ts";
import type { PostMortemAgentPresenter } from "../presentation/post-mortem-agent-view-surface.ts";
import type {
	ControlBackedChildPresentationHandlers,
	OwnerParticipantPresentationHandlers,
} from "./remote-participant-control.ts";

export type AgentSelectionSession = Readonly<{
	prepare(action: AgentSelectorAction, signal?: AbortSignal): Promise<void>;
	complete(action: AgentSelectorAction, signal?: AbortSignal): Promise<void>;
	preparedView(): DurableAgentView | undefined;
	postMortemView(): PostMortemAgentView | undefined;
}>;

const AGENTS_OWNER_ARGUMENT = "owner";
export const AGENTS_COMMAND_USAGE = "Usage: /agents [owner]";

type AgentsCommandMode = "selector" | "owner";

export function parseAgentsCommandArgument(args: string): AgentsCommandMode {
	const argument = args.trim();
	if (!argument) return "selector";
	if (argument === AGENTS_OWNER_ARGUMENT) return "owner";
	throw new Error(AGENTS_COMMAND_USAGE);
}

export function getAgentsArgumentCompletions(argumentPrefix: string): {
	value: string;
	label: string;
}[] | null {
	return AGENTS_OWNER_ARGUMENT.startsWith(argumentPrefix.trim())
		? [{ value: AGENTS_OWNER_ARGUMENT, label: AGENTS_OWNER_ARGUMENT }]
		: null;
}

/** Capture every selector input at one scoped Owner presentation boundary. */
export function createAgentSelectorSnapshot(
	view: HumanPresentationCoordinatorView,
	selectedAgentId = view.status().agentId,
): RemoteAgentSelectorSnapshot {
	const roster = view.selectionRoster();
	return {
		live: [...roster.live],
		dormant: [...roster.dormant],
		selectedAgentId,
		humanAttention: [...view.humanAttention()],
		operationalAttention: [...view.operationalAttention()],
		reports: [...view.reportHistory()],
	};
}

/**
 * Owns one selector decision's preparation and rollback semantics. The previous
 * selection is an Agent identity, never a transport or attachment identity.
 */
export function createAgentSelectionSession(
	view: HumanPresentationCoordinatorView,
	selectedAgentId: string,
): AgentSelectionSession {
	let preparedAgentView: DurableAgentView | undefined;
	let postMortemAgentView: PostMortemAgentView | undefined;
	const isPendingDecision = (decision: Extract<AgentSelectorAction, { kind: "decide" }>) =>
		view.humanAttention().some(
			(item) => item.requestId === decision.requestId && item.agentId === decision.agentId,
		);
	const restorePreviousSelection = async (restoreIdentity: boolean) => {
		if (preparedAgentView) await preparedAgentView.close();
		else if (restoreIdentity) await view.openAgentPresentation(selectedAgentId);
		preparedAgentView = undefined;
		postMortemAgentView = undefined;
	};
	return {
		async prepare(action, signal) {
			throwIfCancelled(signal);
			if (action.kind === "open_report") return;
			if (action.kind === "decide" && !isPendingDecision(action)) {
				throw new Error("stale_request: Human Request is no longer pending");
			}
			// Selecting the mounted participant only closes the selector. Do not
			// reacquire its presentation, which could replace the live attachment.
			if (action.kind === "select_agent" && action.agentId === selectedAgentId) return;
			const selection = await view.openAgentPresentation(action.agentId);
			if (selection.kind === "post_mortem") postMortemAgentView = selection;
			else preparedAgentView = selection.view;
			if (signal?.aborted || (action.kind === "decide" && !isPendingDecision(action))) {
				// A cancelled child Control request means its view was already closed or
				// retargeted. Reopening that identity would resurrect the Runtime being
				// navigated away from; stale Attention still restores the prior selection.
				await restorePreviousSelection(!signal?.aborted);
				throwIfCancelled(signal);
				throw new Error("stale_request: Human Request is no longer pending");
			}
		},
		async complete(action, signal) {
			if (action.kind !== "decide") {
				if (signal?.aborted) {
					await restorePreviousSelection(false);
					throwIfCancelled(signal);
				}
				return;
			}
			try {
				throwIfCancelled(signal);
				await view.focusHumanAnswer(action.agentId, action.requestId);
				throwIfCancelled(signal);
			} catch (error) {
				await restorePreviousSelection(!signal?.aborted);
				throw error;
			}
		},
		preparedView: () => preparedAgentView,
		postMortemView: () => postMortemAgentView,
	};
}

/** Build the authenticated child's Owner-side presentation boundary. */
export function createOwnerAgentPresentationHandlers(
	resolveView: () => HumanPresentationCoordinatorView,
	selectedAgentId: string,
	postMortemPresenter?: PostMortemAgentPresenter,
): OwnerParticipantPresentationHandlers {
	return {
		setReportRead: async (reportId, read) => resolveView().setReportRead(reportId, read),
		snapshot: async () => {
			const view = resolveView();
			// Child navigation uses the same admitted projection as Owner navigation,
			// not a transcript refresh that could block the route back to Owner.
			return createAgentSelectorSnapshot(view, selectedAgentId);
		},
		addChangeHandler(handler) {
			return resolveView().addAgentActivityChangeHandler(() =>
				handler(createAgentSelectorSnapshot(resolveView(), selectedAgentId))
			);
		},
		async select(action, signal) {
			if (action.kind === "open_report") throw new Error("Report selection belongs to the read-only report surface");
			const selection = createAgentSelectionSession(resolveView(), selectedAgentId);
			await selection.prepare(action as AgentSelectorAction, signal);
			await selection.complete(action as AgentSelectorAction, signal);
			const postMortem = selection.postMortemView();
			let outcome: "agents" | "back" | undefined;
			if (postMortem) {
				if (!postMortemPresenter) {
					throw new Error("post_mortem_presentation_unavailable");
				}
				outcome = await postMortemPresenter.present(postMortem);
			}
			return postMortem
				? {
					kind: "post_mortem",
					agentId: postMortem.agentId,
					label: postMortem.label,
					preparationError: postMortem.preparationError,
					outcome: outcome!,
				}
				: { kind: "selected" };
		},
	};
}

/** Register the real child-local selector against its truthful Pi TUI context. */
export function registerRemoteAgentsCommand(
	pi: ExtensionAPI,
	presentation: ControlBackedChildPresentationHandlers,
): void {
	pi.registerCommand("agents", {
		description: "Show Agents in the current Workflow",
		getArgumentCompletions: getAgentsArgumentCompletions,
		handler: async (args, ctx) => {
			if (parseAgentsCommandArgument(args) === "owner") {
				const snapshot = await presentation.snapshot();
				// The Owner exists in the roster whatever its Run phase, so /agents owner
				// still returns to it while a stopped Owner Run is Dormant.
				const owner = [...snapshot.live, ...snapshot.dormant].find(
					(status) => status.agentId === status.workflowId,
				);
				if (!owner) throw new Error("Agent selector roster has no Owner");
				await presentation.select({
					kind: "select_agent",
					agentId: owner.agentId,
				});
				return;
			}
			let reopenSelector = true;
			while (reopenSelector) {
				reopenSelector = false;
				let currentSnapshot: RemoteAgentSelectorSnapshot | undefined;
				let publishSnapshot: ((snapshot: RemoteAgentSelectorSnapshot) => void) | undefined;
				// Listen before the RPC: changes delivered while it is pending take
				// precedence over its result and are replayed when the surface mounts.
				const removeChangeHandler = presentation.addChangeHandler?.((snapshot) => {
					currentSnapshot = snapshot;
					publishSnapshot?.(snapshot);
				});
				try {
					const snapshot = await presentation.snapshot();
					currentSnapshot ??= snapshot;
					let postMortemResult: Awaited<ReturnType<typeof presentation.select>> | undefined;
					const action = await openAgentSelectorSurface(ctx.ui, {
						...currentSnapshot,
						addChangeHandler(handler) {
							publishSnapshot = handler;
							handler(currentSnapshot!);
							return () => { publishSnapshot = undefined; };
						},
						async setReportRead(reportId, read) {
							await presentation.setReportRead(reportId, read);
							currentSnapshot = await presentation.snapshot();
							return currentSnapshot.reports;
						},
						async prepareSelection(action) {
							if (action.kind === "open_report") return;
							postMortemResult = await presentation.select(
								action as RemoteAgentSelectorAction,
							);
						},
						onSelectionError(error) {
							ctx.ui.notify(
								`Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						},
					});
					if (action?.kind === "open_report") {
						const item = currentSnapshot.reports.find(({ report }) => report.reportId === action.reportId);
						if (!item) throw new Error("Report is unavailable");
						const reporter = "reporter" in item.report ? item.report.reporter : undefined;
						const outcome = await openModeratorReportSurface(ctx.ui, item, {
							setRead: (read) => presentation.setReportRead(item.report.reportId, read),
							copyReport: copyToClipboard,
							prepareReporter: reporter ? async () => {
								postMortemResult = await presentation.select({ kind: "select_agent", agentId: reporter.agentId });
							} : undefined,
						});
						if (outcome !== "view_reporter") {
							reopenSelector = true;
						}
					}
					if (postMortemResult?.kind === "post_mortem") {
						reopenSelector = postMortemResult.outcome === "agents";
					}
				} finally {
					removeChangeHandler?.();
				}
			}
		},
	});
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException("The Control request was cancelled", "AbortError");
}
