import type {
	AgentSessionRuntime,
	Extension,
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import type {
	HumanPresentationCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../coordination/workflow-coordinator.ts";
import { createViewBackedParticipantHandlers } from "../coordination/view-backed-participant-handlers.ts";
import { MESSAGE_DELIVERY_CUSTOM_TYPE } from "../protocol/message-delivery.ts";
import {
	installAgentActivityDock,
	type AgentActivityDockOptions,
	type AgentActivitySource,
} from "../presentation/agent-activity-surface.ts";
import { registerParticipantLifecycle } from "../pi-integration/participant-lifecycle.ts";
import { bindPrimarySteeringAdmission } from "../pi-integration/primary-steering-admission.ts";
import { disposeSessionStartup } from "../pi-integration/session-startup.ts";

export function installResolvedAgentActivityDock(
	ui: ExtensionUIContext,
	resolveView: () => HumanPresentationCoordinatorView,
	options: AgentActivityDockOptions = {},
): void {
	const source: AgentActivitySource = {
		snapshot: () => resolveView().agentActivity(),
		addChangeHandler: (handler) =>
			resolveView().addAgentActivityChangeHandler(handler),
	};
	installAgentActivityDock(ui, source, options);
}

export function bindHiddenOwnerAgentExtension(options: {
	pi: ExtensionAPI;
	runtime: AgentSessionRuntime;
	resolveView: () => OrdinaryAgentCoordinatorView;
	prepareOwnerReplacement: () => Promise<void>;
}): void {
	const {
		pi,
		runtime,
		resolveView,
		prepareOwnerReplacement,
	} = options;
	const ownerExtension = requireOwnerAgentExtension(runtime);

	// Pi loads package extensions publicly. Once this session is authenticated as
	// Owner, the same extension becomes its hidden identity-bound Owner surface.
	ownerExtension.hidden = true;
	const lifecycleHandlers = createViewBackedParticipantHandlers("owner", resolveView).lifecycle;
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
	// The Owner Runtime reports thinking-level changes itself, but Pi publishes a
	// native model change only through this extension event.
	pi.on("model_select", () => resolveView().refreshAgentActivity());
	pi.on("session_shutdown", () => {
		unbindPrimarySteeringAdmission();
		disposeSessionStartup(runtime.session);
		return prepareOwnerReplacement();
	});
}

export function assertOwnerAgentExtensionBindingReady(options: {
	runtime: AgentSessionRuntime;
}): void {
	requireOwnerAgentExtension(options.runtime);
}

function requireOwnerAgentExtension(runtime: AgentSessionRuntime): Extension {
	// Pi wraps registered event handlers, so the Owner bootstrap handler reference
	// cannot identify its own extension. Match the extension that registered this
	// plugin's Delivery renderer instead: the factory registers it for file-loaded
	// package entries and inline in-process extensions alike.
	const matchingExtensions = runtime.services.resourceLoader
		.getExtensions()
		.extensions.filter((extension) =>
			extension.messageRenderers.has(MESSAGE_DELIVERY_CUSTOM_TYPE));
	if (matchingExtensions.length !== 1) {
		throw new Error("Incompatible Pi host: cannot bind the Owner Agent extension");
	}
	return matchingExtensions[0]!;
}
