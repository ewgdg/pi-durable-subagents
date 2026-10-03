import * as hostAi from "@earendil-works/pi-ai";
import * as hostPi from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";
import * as hostTypebox from "typebox";
import type {
	ExtensionContext,
	ExtensionFactory,
	ExtensionHandler,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { initializeOwnerWorkflow } from "./bootstrap/owner-bootstrap.ts";
import { OwnerRecoveryError } from "./bootstrap/owner-recovery-error.ts";
import { ProtocolInvariantError } from "./protocol/identities.ts";
import { headlessOwnerDiagnostics, showOwnerBlockage } from "./presentation/owner-diagnostics-surface.ts";
import type { OrdinaryAgentCoordinatorView } from "./coordination/workflow-coordinator.ts";
import {
	assertExtensionApiShape,
	assertHostModuleShape,
	assertPiAiModuleShape,
	assertTuiModuleShape,
	assertTypeboxModuleShape,
} from "./pi-integration/host-shape.ts";
import { registerHerdrQuestionAttention } from "./pi-integration/herdr-question-attention.ts";
import { registerSessionStartup } from "./pi-integration/session-startup.ts";
import { installInteractiveHostBridge } from "./pi-integration/interactive-host-bridge.ts";
import { workflowInteractionForMode } from "./pi-integration/workflow-interaction.ts";
import { registerMessageDeliveryRenderer } from "./tools/message-delivery-renderer.ts";
import {
	activateOwnerAgentTools,
	deactivateOwnerAgentTools,
	registerOwnerAgentTools,
	registerAgentsCommand,
} from "./tools/owner-surfaces.ts";

const ENTRY_MODULE_PATH = import.meta.filename;

const piAgentCoordination: ExtensionFactory = (pi) => {
	let resolveOwnerView: (() => OrdinaryAgentCoordinatorView) | undefined;
	assertExtensionApiShape(pi);
	registerSessionStartup(pi);
	registerHerdrQuestionAttention(pi, () => resolveOwnerView?.());
	assertHostModuleShape(hostPi);
	assertPiAiModuleShape(hostAi, hostPi.VERSION);
	assertTuiModuleShape(hostTui, hostPi.VERSION);
	assertTypeboxModuleShape(hostTypebox, hostPi.VERSION);
	registerMessageDeliveryRenderer(
		pi,
		(agentId) => resolveOwnerView?.().agentLabel(agentId),
	);
	const bridge = installInteractiveHostBridge(hostPi);
	// "inactive" is an SDK host that binds a headless session without a Runtime.
	type OwnerAdmissionState = "pending" | "admitted" | "failed" | "inactive";
	let ownerAdmissionState: OwnerAdmissionState = "pending";
	let ownerIdentified = false;
	let settleOwnerAdmission: () => void = () => {};
	const ownerAdmissionSettled = new Promise<void>((resolve) => {
		settleOwnerAdmission = resolve;
	});
	// An earlier extension can launch fire-and-forget model work from session_start.
	// Hold that turn until this exact Owner admission has either succeeded or failed.
	pi.on("before_agent_start", () => ownerAdmissionSettled);
	const resolveAdmittedOwnerView = () => {
		if (!resolveOwnerView) {
			throw new Error("Owner Workflow is not admitted");
		}
		return resolveOwnerView();
	};
	// Pi reconstructs replacement transcripts before session_start. Register the
	// official tool definitions now so historical calls receive their renderers.
	registerOwnerAgentTools(pi, resolveAdmittedOwnerView);

	let bootstrappedSessionManager: ExtensionContext["sessionManager"] | undefined;
	const bootstrapOwner: ExtensionHandler<SessionStartEvent> = async (event, ctx) => {
		// Pi's RPC mode binds a replaced session's extensions twice (e.g. on
		// switch_session), repeating session_start with no session_shutdown between.
		// Re-admitting would shut down the live Workflow while handlers bound to it
		// stay registered, so a repeat for the same session is a no-op. Genuine
		// replacements and reloads always bring a new session manager or extension instance.
		if (ctx.sessionManager === bootstrappedSessionManager) return;
		bootstrappedSessionManager = ctx.sessionManager;
		ownerAdmissionState = "pending";
		ownerIdentified = false;
		deactivateOwnerAgentTools(pi);
		const interaction = workflowInteractionForMode(ctx.mode);
		try {
			const ownerView = await initializeOwnerWorkflow({
				pi,
				ctx,
				bridge,
				interaction,
				entryModulePath: ENTRY_MODULE_PATH,
				event,
				onOwnerIdentified: () => { ownerIdentified = true; },
			});
			if (!ownerView) {
				ownerAdmissionState = "inactive";
				return;
			}
			resolveOwnerView = ownerView;
			registerOwnerAgentTools(
				pi,
				resolveAdmittedOwnerView,
				resolveOwnerView().agentTemplateSnapshot(),
			);
			activateOwnerAgentTools(pi);
			ownerAdmissionState = "admitted";
			if (interaction === "terminal") showOwnerBlockage(ctx.ui, undefined);
		} catch (error) {
			ownerAdmissionState = "failed";
			resolveOwnerView = undefined;
			deactivateOwnerAgentTools(pi);
			const failure = error instanceof OwnerRecoveryError ? error : new OwnerRecoveryError(
				error instanceof ProtocolInvariantError ? "Owner transcript recovery" : "Owner admission",
				ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), error,
			);
			// A blocked Owner has no coordinator-backed commands. Keep diagnostics
			// independent of that failed admission and out of restored chat history.
			registerAgentsCommand(pi, resolveAdmittedOwnerView, failure);
			if (interaction === "terminal") showOwnerBlockage(ctx.ui, failure);
			else if (ctx.hasUI) ctx.ui.notify(headlessOwnerDiagnostics(failure), "error");
			// Print and JSON have no UI; stderr keeps the blockage out of their stdout result.
			else process.stderr.write(`${headlessOwnerDiagnostics(failure)}\n`);
		} finally {
			settleOwnerAdmission();
		}
	};
	pi.on("session_start", bootstrapOwner);
	pi.on("session_before_fork", (_event, ctx) => {
		if (ownerAdmissionState === "admitted" || ownerAdmissionState === "inactive") return;
		// A failed protocol scan must not trap an identified Owner. The native
		// replacement path still owns shutdown and the fresh Workflow cutoff.
		if (ownerAdmissionState === "failed" && ownerIdentified) return;
		if (ownerAdmissionState === "failed") {
			ctx.ui.notify(
				"Cannot fork this session: safe Workflow Owner identification did not complete. Child Agents and Moderators cannot fork; use native /new for a clean Owner session.",
				"error",
			);
		}
		return { cancel: true };
	});
	pi.on("session_before_switch", (event) => {
		if (ownerAdmissionState === "inactive") return;
		// A failed bootstrap must not trap the user in a session that cannot host
		// coordination. Keep native /resume fenced until admission succeeds,
		// but let native /new create a clean Owner transcript for recovery.
		const canRecoverWithNewSession =
			ownerAdmissionState === "failed" && event.reason === "new";
		return ownerAdmissionState === "admitted" || canRecoverWithNewSession
			? undefined
			: { cancel: true };
	});
};

export default piAgentCoordination;
