import * as hostAi from "@earendil-works/pi-ai";
import * as hostPi from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";
import * as hostTypebox from "typebox";
import type {
	ExtensionContext,
	ExtensionFactory,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
	initializeOwnerWorkflow,
	type ConstructWorkflowCoordinator,
} from "./bootstrap/owner-bootstrap.ts";
import { OwnerAdmission, type OwnerAdmissionOutcome } from "./bootstrap/owner-admission.ts";
import { headlessOwnerDiagnostics, showOwnerBlockage } from "./presentation/owner-diagnostics-surface.ts";
import { WorkflowCoordinator } from "./coordination/workflow-coordinator.ts";
import {
	assertExtensionApiShape,
	assertHostModuleShape,
	assertPiAiModuleShape,
	assertTuiModuleShape,
	assertTypeboxModuleShape,
} from "./pi-integration/host-shape.ts";
import { registerHerdrQuestionAttention } from "./pi-integration/herdr-question-attention.ts";
import { registerSessionStartup } from "./pi-integration/session-startup.ts";
import { VirtualModelRegistrar } from "./pi-integration/virtual-model-registration.ts";
import { installInteractiveHostBridge } from "./pi-integration/interactive-host-bridge.ts";
import { workflowInteractionForMode } from "./pi-integration/workflow-interaction.ts";
import { registerMessageDeliveryRenderer } from "./tools/message-delivery-renderer.ts";
import { registerAgentsCommand } from "./tools/agents-command.ts";
import {
	registerOwnerAgentTools,
	setOwnerAgentToolsActive,
} from "./tools/owner-surfaces.ts";

const ENTRY_MODULE_PATH = import.meta.filename;

type OwnerSessionStart = Readonly<{
	event: SessionStartEvent;
	ctx: ExtensionContext;
	sessionManager: ExtensionContext["sessionManager"];
}>;

/**
 * Build the Workflow Owner extension. Each Owner admission, including a reload,
 * constructs its Workflow Coordinator through `constructWorkflowCoordinator`.
 */
export const createOwnerExtension = (
	constructWorkflowCoordinator: ConstructWorkflowCoordinator,
): ExtensionFactory => async (pi) => {
	assertExtensionApiShape(pi);
	registerSessionStartup(pi);
	registerHerdrQuestionAttention(pi, () => admission.ownerView());
	assertHostModuleShape(hostPi);
	assertPiAiModuleShape(hostAi, hostPi.VERSION);
	assertTuiModuleShape(hostTui, hostPi.VERSION);
	assertTypeboxModuleShape(hostTypebox, hostPi.VERSION);
	registerMessageDeliveryRenderer(
		pi,
		(agentId) => admission.ownerView()?.agentLabel(agentId),
	);
	const bridge = installInteractiveHostBridge(hostPi);
	const virtualModels = await VirtualModelRegistrar.create(pi, hostPi.getAgentDir());
	// Pi reconstructs replacement transcripts before session_start. Register the
	// official tool definitions now so historical calls receive their renderers.
	const ownerTools = registerOwnerAgentTools(pi, () => admission.admittedOwnerView());
	const presentOutcome = (outcome: OwnerAdmissionOutcome, { ctx }: OwnerSessionStart) => {
		const interaction = workflowInteractionForMode(ctx.mode);
		switch (outcome.state) {
			case "pending":
				setOwnerAgentToolsActive(pi, interaction, false);
				return;
			case "admitted":
				ownerTools.refreshSpawnGuidance(outcome.ownerView().agentTemplateSnapshot());
				setOwnerAgentToolsActive(pi, interaction, true);
				registerAgentsCommand(pi, {
					kind: "admitted_owner",
					view: outcome.ownerView,
					tools: ownerTools,
					syncVirtualModels: () => virtualModels.sync(hostPi.getAgentDir()),
				});
				if (interaction === "terminal") showOwnerBlockage(ctx.ui, undefined);
				return;
			case "blocked": {
				const { failure } = outcome;
				setOwnerAgentToolsActive(pi, interaction, false);
				// A blocked Owner has no coordinator-backed commands. Keep diagnostics
				// independent of that failed admission and out of restored chat history.
				registerAgentsCommand(pi, { kind: "blocked_owner", failure });
				if (interaction === "terminal") showOwnerBlockage(ctx.ui, failure);
				else if (ctx.hasUI) ctx.ui.notify(headlessOwnerDiagnostics(failure), "error");
				// Print and JSON have no UI; stderr keeps the blockage out of their stdout result.
				else process.stderr.write(`${headlessOwnerDiagnostics(failure)}\n`);
				return;
			}
			case "inactive":
				return;
		}
	};
	const admission = new OwnerAdmission<OwnerSessionStart>({
		bootstrapOwner: ({ event, ctx }, onOwnerIdentified) => initializeOwnerWorkflow({
			pi,
			ctx,
			bridge,
			interaction: workflowInteractionForMode(ctx.mode),
			entryModulePath: ENTRY_MODULE_PATH,
			constructWorkflowCoordinator,
			virtualModels,
			event,
			onOwnerIdentified,
		}),
		presentOutcome,
	});
	// An earlier extension can launch fire-and-forget model work from session_start.
	// Hold that turn until this exact Owner admission has settled.
	pi.on("before_agent_start", () => admission.settled());
	pi.on("session_start", (event, ctx) => admission.start({ event, ctx, sessionManager: ctx.sessionManager }));
	pi.on("session_before_fork", (_event, ctx) => {
		const verdict = admission.nativeReplacementVerdict("fork");
		if (verdict === "allow") return;
		if (verdict === "refuse_with_identification_notice") {
			ctx.ui.notify(
				"Cannot fork this session: safe Workflow Owner identification did not complete. Child Agents and Moderators cannot fork; use native /new for a clean Owner session.",
				"error",
			);
		}
		return { cancel: true };
	});
	pi.on("session_before_switch", (event) => {
		const verdict = admission.nativeReplacementVerdict(event.reason === "new" ? "new_session" : "resume");
		return verdict === "allow" ? undefined : { cancel: true };
	});
};

export default createOwnerExtension(
	(runtime, identity, options) => new WorkflowCoordinator(runtime, identity, options),
);
