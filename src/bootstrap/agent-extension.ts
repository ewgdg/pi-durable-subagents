import type {
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionHandler,
	ExtensionUIContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import type {
	HumanPresentationCoordinatorView,
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../coordination/workflow-coordinator.ts";
import {
	registerAgentsCommand,
	registerModeratorAgentSurfaces,
	registerOrdinaryAgentSurfaces,
} from "../tools/owner-surfaces.ts";
import { registerMessageDeliveryRenderer } from "../tools/message-delivery-renderer.ts";
import {
	installAgentActivityDock,
	type AgentActivitySource,
} from "../presentation/agent-activity-surface.ts";
import {
	registerParticipantLifecycle,
	type ParticipantLifecycleHandlers,
} from "../pi-integration/participant-lifecycle.ts";
import { registerParticipantNativeSessionPolicy } from "../pi-integration/participant-native-session-policy.ts";
import { bindPrimarySteeringAdmission } from "../pi-integration/primary-steering-admission.ts";

export function createAgentBoundExtension(
	resolveView: () => OrdinaryAgentCoordinatorView,
): ExtensionFactory {
	return createParticipantBoundExtension(
		resolveView,
		registerOrdinaryAgentSurfaces,
	);
}

export function createModeratorBoundExtension(
	resolveView: () => ModeratorAgentCoordinatorView,
): ExtensionFactory {
	return createParticipantBoundExtension(
		resolveView,
		registerModeratorAgentSurfaces,
	);
}

export function createAgentActivityExtension(
	resolveView: () => HumanPresentationCoordinatorView,
): ExtensionFactory {
	return (pi) => registerAgentActivityDock(pi, resolveView);
}

function createParticipantBoundExtension<
	View extends OrdinaryAgentCoordinatorView | ModeratorAgentCoordinatorView,
>(
	resolveView: () => View,
	registerSurfaces: (pi: ExtensionAPI, resolveView: () => View) => void,
): ExtensionFactory {
	return (pi) => {
		registerMessageDeliveryRenderer(
			pi,
			(agentId) => resolveView().agentLabel(agentId),
		);
		registerParticipantNativeSessionPolicy(pi);
		registerSurfaces(pi, resolveView);
		registerParticipantLifecycle(
			pi,
			participantLifecycleHandlers(resolveView),
		);
	};
}

function registerAgentActivityDock(
	pi: ExtensionAPI,
	resolveView: () => HumanPresentationCoordinatorView,
): void {
	pi.on("session_start", (_event, ctx) => {
		installResolvedAgentActivityDock(ctx.ui, resolveView);
	});
	// AgentSession publishes model changes only through the extension event path;
	// forward that native invalidation to every scoped activity subscriber.
	pi.on("model_select", () => resolveView().refreshAgentActivity());
}

export function installResolvedAgentActivityDock(
	ui: ExtensionUIContext,
	resolveView: () => HumanPresentationCoordinatorView,
): void {
	const source: AgentActivitySource = {
		snapshot: () => resolveView().agentActivity(),
		addChangeHandler: (handler) =>
			resolveView().addAgentActivityChangeHandler(handler),
	};
	installAgentActivityDock(ui, source);
}

export function bindHiddenOwnerAgentExtension(options: {
	pi: ExtensionAPI;
	runtime: AgentSessionRuntime;
	bootstrapHandler: ExtensionHandler<SessionStartEvent>;
	resolveView: () => OrdinaryAgentCoordinatorView;
	prepareOwnerReplacement: () => Promise<void>;
}): void {
	const {
		pi,
		runtime,
		bootstrapHandler,
		resolveView,
		prepareOwnerReplacement,
	} = options;
	const ownerExtension = requireOwnerAgentExtension(runtime, bootstrapHandler);

	// Pi loads package extensions publicly. Once this session is authenticated as
	// Owner, the same extension becomes its hidden identity-bound Owner surface.
	ownerExtension.hidden = true;
	registerAgentsCommand(pi, resolveView, "admitted");
	const lifecycleHandlers = participantLifecycleHandlers(resolveView);
	const unbindPrimarySteeringAdmission = bindPrimarySteeringAdmission(
		runtime.session,
		() => lifecycleHandlers.primaryInputQueued(),
		(error) => {
			runtime.services.diagnostics.push({
				type: "error",
				message: `Owner steering admission failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		},
	);
	registerParticipantLifecycle(pi, lifecycleHandlers, {
		deferPrimaryInputQueued: false,
	});
	pi.on("session_shutdown", (event) => {
		unbindPrimarySteeringAdmission();
		if (event.reason !== "reload") return prepareOwnerReplacement();
	});
}

export function assertOwnerAgentExtensionBindingReady(options: {
	runtime: AgentSessionRuntime;
	bootstrapHandler: ExtensionHandler<SessionStartEvent>;
}): void {
	requireOwnerAgentExtension(options.runtime, options.bootstrapHandler);
}

function requireOwnerAgentExtension(
	runtime: AgentSessionRuntime,
	bootstrapHandler: ExtensionHandler<SessionStartEvent>,
) {
	const matchingExtensions = runtime.services.resourceLoader
		.getExtensions()
		.extensions.filter((extension) =>
			extension.handlers
				.get("session_start")
				?.some((handler) => handler === bootstrapHandler),
		);
	if (matchingExtensions.length !== 1) {
		throw new Error("Incompatible Pi host: cannot bind the Owner Agent extension");
	}
	return matchingExtensions[0]!;
}

export function participantLifecycleHandlers(
	resolveView: () => OrdinaryAgentCoordinatorView | ModeratorAgentCoordinatorView,
): ParticipantLifecycleHandlers {
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
			return resolveView().agentActivity().answerMode ? "answer" : "agent";
		},
		async toolResultCommitting(input) {
			await resolveView().refreshTranscriptFacts();
			return resolveView().guardToolResult(input.message);
		},
		// A previous sequential tool result is committed before Pi admits the next
		// sibling. Reconcile here so input-required attention cannot cross that barrier.
		async toolExecutionStarted(input) {
			await resolveView().refreshTranscriptFacts();
			resolveView().reconcileHumanToolResults();
			resolveView().reconcileCommittedToolResults();
			await resolveView().ensureExecution();
			resolveView().beginToolExecution(input.toolCallId, input.toolName);
		},
		async safeBoundaryReached() {
			await resolveView().refreshTranscriptFacts();
			resolveView().reconcileHumanToolResults();
			resolveView().reconcileCommittedToolResults();
			await resolveView().ensureExecution();
			await resolveView().reachSafeBoundary();
		},
		// Aborted and failed turns may not reach turn_end. agent_end follows all native
		// message commits, so it safely reconciles their final Human result as well.
		async executionEnded() {
			await resolveView().refreshTranscriptFacts();
			resolveView().reconcileCommittedToolResults();
			resolveView().endExecution();
			resolveView().reconcileHumanToolResults();
		},
	};
}
