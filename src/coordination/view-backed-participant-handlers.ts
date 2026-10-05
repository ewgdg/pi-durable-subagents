import type { ParticipantLifecycleHandlers } from "../pi-integration/participant-lifecycle.ts";
import type { AgentObserveInput } from "../tools/coordination-tool-catalogue.ts";
import type {
	CoordinationRole,
	CoordinationToolHandlers,
} from "../tools/coordination-tools.ts";
import type {
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "./workflow-coordinator.ts";

type ParticipantView = OrdinaryAgentCoordinatorView | ModeratorAgentCoordinatorView;

export type ViewBackedParticipantHandlers<Role extends CoordinationRole> = Readonly<{
	coordination: CoordinationToolHandlers<Role>;
	lifecycle: ParticipantLifecycleHandlers;
}>;

/**
 * Adapt one participant view to the coordination and lifecycle handler ports.
 * The view is resolved on every call, so the Owner can register its tools before
 * admission binds a view.
 */
export function createViewBackedParticipantHandlers(
	role: "ordinary",
	resolveView: () => OrdinaryAgentCoordinatorView,
): ViewBackedParticipantHandlers<"ordinary">;
export function createViewBackedParticipantHandlers(
	role: "owner",
	resolveView: () => OrdinaryAgentCoordinatorView,
): ViewBackedParticipantHandlers<"owner">;
export function createViewBackedParticipantHandlers(
	role: "moderator",
	resolveView: () => ModeratorAgentCoordinatorView,
): ViewBackedParticipantHandlers<"moderator">;
export function createViewBackedParticipantHandlers(
	role: CoordinationRole,
	resolveView: () => ParticipantView,
): ViewBackedParticipantHandlers<CoordinationRole> {
	return {
		coordination: coordinationHandlers(role, resolveView),
		lifecycle: lifecycleHandlers(resolveView),
	};
}

function coordinationHandlers(
	role: CoordinationRole,
	resolveView: () => ParticipantView,
): CoordinationToolHandlers<CoordinationRole> {
	const common = {
		message: (toolCallId: string, input: Parameters<ParticipantView["message"]>[1]) =>
			resolveView().message(toolCallId, input),
		wait: (
			toolCallId: string,
			input: Parameters<ParticipantView["wait"]>[1],
			signal: AbortSignal | undefined,
			onProgress: Parameters<ParticipantView["wait"]>[3],
		) => resolveView().wait(toolCallId, input, signal, onProgress),
		async observe(input: AgentObserveInput) {
			const view = resolveView();
			await view.refreshTranscriptFacts();
			switch (input.operation) {
				case "status": return view.status(input.agentId);
				case "search": return view.search(input);
				case "obligations": return view.openIncomingRequests();
				case "request": return view.inspectRequest(input.requestId);
			}
		},
		control: (toolCallId: string, input: Parameters<ParticipantView["control"]>[1]) =>
			resolveView().control(toolCallId, input),
	};
	if (role === "moderator") {
		const moderatorView = resolveView as () => ModeratorAgentCoordinatorView;
		return {
			...common,
			askUser: (toolCallId, input, signal) =>
				moderatorView().askHuman(toolCallId, input, signal),
			reportToUser: (toolCallId, input) => moderatorView().reportToUser(toolCallId, input),
			moderatorControl: (toolCallId, input) =>
				moderatorView().moderatorControl(toolCallId, input),
		};
	}
	const ordinaryView = resolveView as () => OrdinaryAgentCoordinatorView;
	const spawn = (toolCallId: string, input: Parameters<OrdinaryAgentCoordinatorView["spawn"]>[1]) =>
		ordinaryView().spawn(toolCallId, input);
	const agentTemplateSnapshot = (refresh = false) => refresh
		? ordinaryView().refreshAgentTemplateSnapshot()
		: ordinaryView().agentTemplateSnapshot();
	return role === "ordinary"
		? {
			...common,
			spawn,
			agentTemplateSnapshot,
			askUser: (toolCallId, input, signal) =>
				ordinaryView().askHuman(toolCallId, input, signal),
		}
		: { ...common, spawn, agentTemplateSnapshot, resumeWorkflow: (toolCallId) => ordinaryView().resumeWorkflow(toolCallId) };
}

function lifecycleHandlers(resolveView: () => ParticipantView): ParticipantLifecycleHandlers {
	// Tool start and execution end reconcile committed tool results after the
	// transcript refresh; the safe boundary includes that same step first.
	const reconcileCommittedFacts = async () => {
		await resolveView().refreshTranscriptFacts();
		resolveView().reconcileCommittedToolResults();
	};
	return {
		executionStarted: async (submissionSequence) => {
			await resolveView().beginExecution(submissionSequence);
			return resolveView().obligationFrames();
		},
		humanInputSubmitted: (input) =>
			resolveView().resumeFromHuman(
				input.text,
				input.images,
				input.submissionSequence,
			),
		primaryInputQueued: () => resolveView().primaryInputQueued(),
		async humanInputMode() {
			return resolveView().humanInputMode();
		},
		async toolResultCommitting(input) {
			await resolveView().refreshTranscriptFacts();
			return resolveView().guardToolResult(input.message);
		},
		// A previous sequential tool result is committed before Pi admits the next
		// sibling. Reconcile here so input-required attention cannot cross that barrier.
		async rootToolExecutionStarted(input) {
			await reconcileCommittedFacts();
			resolveView().assertNotShutDownOrSuspended();
			resolveView().beginToolExecution(input.toolCallId, input.toolName);
		},
		async safeBoundaryReached() {
			await resolveView().refreshTranscriptFacts();
			await resolveView().reachSafeBoundary();
		},
		// Aborted and failed turns may not reach turn_end. agent_end follows all native
		// message commits, so it safely reconciles their final Human result as well.
		async executionEnded() {
			await reconcileCommittedFacts();
		},
	};
}
