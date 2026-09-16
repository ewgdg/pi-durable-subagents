import * as hostAi from "@earendil-works/pi-ai";
import * as hostPi from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";
import * as hostTypebox from "typebox";
import type {
	ExtensionFactory,
	ExtensionHandler,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { initializeOwnerWorkflow } from "./bootstrap/owner-bootstrap.ts";
import { OwnerRecoveryError } from "./bootstrap/owner-recovery-error.ts";
import { ownerRepairCommand, isRepairPaused, isRepairSwitchAuthorized, presentRepairHost } from "./repair/owner-repair.ts";
import { readRepairHost } from "./repair/repair-host.ts";
import { closeRepairInput } from "./repair/input-retirement.ts";
import { ProtocolInvariantError } from "./protocol/identities.ts";
import { showOwnerBlockage } from "./presentation/owner-diagnostics-surface.ts";
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
	const repair = ownerRepairCommand(bridge);
	let removeRepairInput: (() => void) | undefined;
	pi.on("session_shutdown", () => { removeRepairInput?.(); });
	pi.on("input", (_event, ctx) => isRepairPaused(ctx) ? { action: "handled" } : undefined);
	pi.on("session_before_compact", (_event, ctx) => isRepairPaused(ctx) ? { cancel: true } : undefined);
	pi.on("session_before_tree", (_event, ctx) => isRepairPaused(ctx) ? { cancel: true } : undefined);
	type OwnerAdmissionState = "pending" | "admitted" | "failed";
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

	const bootstrapOwner: ExtensionHandler<SessionStartEvent> = async (event, ctx) => {
		ownerAdmissionState = "pending";
		ownerIdentified = false;
		deactivateOwnerAgentTools(pi);
		try {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			const repairHost = readRepairHost(ctx.sessionManager);
			if (repairHost) {
				const { runtime } = await bridge.capture(ctx.sessionManager as hostPi.SessionManager, ctx.ui);
				closeRepairInput(runtime.session);
				ownerAdmissionState = "failed";
				pi.setActiveTools([]);
				registerAgentsCommand(pi, resolveAdmittedOwnerView, new Error("This is an unrelated repair host, not an Owner Workflow. Use /agents repair."), repair);
				removeRepairInput = presentRepairHost(ctx, repairHost);
				return;
			}
			resolveOwnerView = await initializeOwnerWorkflow({
				pi,
				ctx,
				bridge,
				entryModulePath: ENTRY_MODULE_PATH,
				bootstrapHandler: bootstrapOwner,
				event,
				onOwnerIdentified: () => { ownerIdentified = true; },
			});
			registerOwnerAgentTools(
				pi,
				resolveAdmittedOwnerView,
				resolveOwnerView().agentTemplateSnapshot(),
			);
			activateOwnerAgentTools(pi);
			ownerAdmissionState = "admitted";
			registerAgentsCommand(pi, resolveAdmittedOwnerView, "admitted", repair);
			showOwnerBlockage(ctx.ui, undefined);
		} catch (error) {
			ownerAdmissionState = "failed";
			resolveOwnerView = undefined;
			deactivateOwnerAgentTools(pi);
			const failure = error instanceof OwnerRecoveryError ? error
				: error instanceof ProtocolInvariantError ? new OwnerRecoveryError(
					"Owner transcript recovery", ctx.sessionManager.getSessionId(),
					ctx.sessionManager.getSessionFile(), error,
				) : undefined;
			if (!failure) {
				registerAgentsCommand(pi, resolveAdmittedOwnerView, error instanceof Error ? error : new Error(String(error)), repair);
				throw error;
			}
			// A blocked Owner has no coordinator-backed commands. Keep diagnostics
			// independent of that failed admission and out of restored chat history.
			registerAgentsCommand(pi, resolveAdmittedOwnerView, failure, repair);
			showOwnerBlockage(ctx.ui, failure);
		} finally {
			settleOwnerAdmission();
		}
	};
	pi.on("session_start", bootstrapOwner);
	pi.on("session_before_fork", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (isRepairPaused(ctx)) return { cancel: true };
		if (ownerAdmissionState === "admitted") return;
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
	pi.on("session_before_switch", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (isRepairSwitchAuthorized(ctx, event.targetSessionFile)) return;
		if (isRepairPaused(ctx)) return { cancel: true };
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
