import type {
	AgentSession,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
	type OrdinaryAgentCoordinatorView,
	WorkflowCoordinator,
} from "../coordination/workflow-coordinator.ts";
import type { InteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import {
	installOwnerSettlementParker,
	type OwnerSettlementParkingBinding,
} from "../pi-integration/owner-settlement-parker.ts";
import { adoptOrValidateOwnerIdentity } from "../protocol/owner-identity.ts";
import { captureOwnerForkProvenance } from "../protocol/fork-provenance.ts";
import { OperationalIncidentSurface } from "../presentation/operational-incident-surface.ts";
import { OwnerPostMortemAgentPresenter } from "../presentation/post-mortem-agent-view-surface.ts";
import {
	WorkflowPolicyStore,
	readWorkflowPolicy,
} from "../policy/workflow-policy.ts";
import {
	assertOwnerAgentExtensionBindingReady,
	bindHiddenOwnerAgentExtension,
	installResolvedAgentActivityDock,
} from "./agent-extension.ts";
import { discoverColdWorkflow } from "./cold-host-discovery.ts";
import { transcriptFromSessionManager } from "../pi-integration/session-manager-transcript.ts";
import { extensionCommandAction } from "../pi-integration/extension-command-action.ts";
import { OwnerRecoveryError } from "./owner-recovery-error.ts";

type InitializedWorkflow = {
	policy: WorkflowPolicyStore;
	prepareOwnerReplacement(): Promise<void>;
};

const WORKFLOW_REGISTRY_KEY = "__piAgentCoordinationOwnerWorkflows";
const globalWorkflowRegistry = globalThis as typeof globalThis & {
	[WORKFLOW_REGISTRY_KEY]?: WeakMap<AgentSession, InitializedWorkflow>;
};
// Retain only the shutdown owner across module reload. New code must not trust
// the previous coordinator or its cached protocol projections.
const initializedWorkflows = (globalWorkflowRegistry[WORKFLOW_REGISTRY_KEY] ??= new WeakMap());

export async function initializeOwnerWorkflow(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	bridge: InteractiveHostBridge;
	entryModulePath: string;
	event: SessionStartEvent;
	onOwnerIdentified(): void;
}): Promise<() => OrdinaryAgentCoordinatorView> {
	const { pi, ctx, bridge, entryModulePath, event } = options;
	const { runtime } = await bridge.capture(
		ctx.sessionManager as AgentSession["sessionManager"],
		ctx.ui,
	);
	const existing = initializedWorkflows.get(runtime.session);
	if (existing) {
		// Shutdown closes ordinary admission before its first await and joins all
		// managed writers. Keep the registry entry on failure: another reload must
		// not mistake failed cleanup for a repair-safe snapshot.
		await existing.prepareOwnerReplacement();
		initializedWorkflows.delete(runtime.session);
	}
	assertOwnerAgentExtensionBindingReady({ runtime });

	const initialPolicy = await readWorkflowPolicy(runtime.services.agentDir);
	if (!initialPolicy.ok) {
		runtime.services.diagnostics.push(initialPolicy.diagnostic);
		if (!existing) throw new Error(initialPolicy.diagnostic.message);
	}
	const policy = new WorkflowPolicyStore(initialPolicy.ok
		? initialPolicy.snapshot : existing!.policy.current());
	// Admission always rebuilds projections, including when the host loader retains modules.
	transcriptFromSessionManager(runtime.session.sessionManager, { fresh: true });
	const identity = adoptOrValidateOwnerIdentity(runtime, {
		allowCopiedCoordinationContext: event.reason === "fork",
	});
	// Role identification is sufficient for an independent native fork, even if
	// current-scope coordination evidence fails the admission that follows.
	options.onOwnerIdentified();
	await captureOwnerForkProvenance(runtime.session.sessionManager);
	const recoveredWorkflow = await discoverColdWorkflow({
		ownerIdentity: identity,
		ownerSessionManager: runtime.session.sessionManager,
	});
	const coordinator = new WorkflowCoordinator(runtime, identity, {
		entryModulePath,
		operationalIncidentPresentation: new OperationalIncidentSurface(),
		postMortemAgentPresenter: new OwnerPostMortemAgentPresenter(ctx.ui),
		workflowPolicy: policy,
		recoveredWorkflow,
	});
	try {
		await coordinator.initialize();
	} catch (error) {
		let cleanupError: unknown;
		try {
			// Admission has not installed lifecycle disposal yet. Release its partial
			// coordinator here without disposing the still-usable native Pi session.
			await coordinator.shutdown(async () => undefined);
		} catch (failure) {
			cleanupError = failure;
		}
		throw new OwnerRecoveryError("Owner coordination initialization", identity.agentId,
			runtime.session.sessionManager.getSessionFile(), error, cleanupError);
	}
	let parkingBinding: OwnerSettlementParkingBinding | undefined;
	let ownerReplacementPreparation: Promise<void> | undefined;
	const prepareOwnerReplacement = () => {
		if (ownerReplacementPreparation) return ownerReplacementPreparation;
		// Pi owns native Runtime disposal after awaited session shutdown handlers.
		ownerReplacementPreparation = coordinator.shutdown(() => runtime.session.abort())
			.finally(() => parkingBinding?.dispose());
		return ownerReplacementPreparation;
	};
	const resolveView = () => coordinator.forAgent(identity.agentId);
	installResolvedAgentActivityDock(ctx.ui, resolveView, {
		openAgentsMenu: extensionCommandAction(pi, "/agents"),
	});
	bindHiddenOwnerAgentExtension({
		pi,
		runtime,
		resolveView,
		prepareOwnerReplacement,
	});
	parkingBinding = installOwnerSettlementParker({
		agent: runtime.session.agent,
		hasAutonomousProgress: () => coordinator.hasAutonomousWorkflowProgress(),
		subscribeToProgressChanges: (handler) => resolveView().addAgentActivityChangeHandler(handler),
		beginParking: (runSignal) =>
			coordinator.beginOwnerSettlementParking(runSignal),
		shutdownSignal: coordinator.ownerShutdownSignal(),
		reportError: (error) => {
			runtime.services.diagnostics.push({
				type: "error",
				message: `Owner settlement parking failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		},
	});
	initializedWorkflows.set(runtime.session, {
		policy,
		prepareOwnerReplacement,
	});
	if (recoveredWorkflow.quarantinedCandidateCount > 0) {
		ctx.ui.notify(
			`${recoveredWorkflow.quarantinedCandidateCount} Agent transcript candidate${recoveredWorkflow.quarantinedCandidateCount === 1 ? " was" : "s were"} quarantined.`,
			"warning",
		);
	}
	return resolveView;
}
