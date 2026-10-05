import type {
	RemoteAgentSelectorAction,
	RemoteAgentSelectorSnapshot,
} from "../control/agent-control-protocol.ts";
import type { HumanPresentationCoordinatorView } from "../coordination/workflow-coordinator.ts";
import type { AgentSelectorAction } from "../presentation/agent-selector-surface.ts";
import type { DurableAgentView } from "../presentation/agent-view-surface.ts";
import type { PostMortemAgentView } from "../presentation/post-mortem-agent-view-surface.ts";
import type { PostMortemAgentPresenter } from "../presentation/post-mortem-agent-view-surface.ts";
import type { OwnerParticipantPresentationHandlers } from "./remote-participant-control.ts";

export type AgentSelectionSession = Readonly<{
	prepare(action: AgentSelectorAction, signal?: AbortSignal): Promise<void>;
	complete(action: AgentSelectorAction, signal?: AbortSignal): Promise<void>;
	preparedView(): DurableAgentView | undefined;
	postMortemView(): PostMortemAgentView | undefined;
}>;

/** Capture every selector input at one scoped Owner presentation boundary. */
export function createAgentSelectorSnapshot(
	view: HumanPresentationCoordinatorView,
	selectedAgentId = view.status().agentId,
): RemoteAgentSelectorSnapshot {
	const roster = view.selectionRoster();
	return {
		live: [...roster.live],
		dormant: [...roster.dormant],
		quarantined: [...roster.quarantined],
		quarantinedCandidateCount: roster.quarantinedCandidateCount,
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

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException("The Control request was cancelled", "AbortError");
}
