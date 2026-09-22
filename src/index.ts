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
import { WorkflowCoordinator } from "./coordination/workflow-coordinator.ts";
import { capturePreadmissionRepairEvidence } from "./coordination/preadmission-repair.ts";
import { OwnerRecoveryError } from "./bootstrap/owner-recovery-error.ts";
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
	let preadmissionCoordinator: WorkflowCoordinator | undefined;
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
		if (preadmissionCoordinator) { const prev = preadmissionCoordinator; preadmissionCoordinator = undefined; void prev.shutdown(async () => undefined).catch(() => undefined); }
		deactivateOwnerAgentTools(pi);
		try {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			resolveOwnerView = await initializeOwnerWorkflow({
				pi,
				ctx,
				bridge,
				entryModulePath: ENTRY_MODULE_PATH,
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
			if (!failure) throw error;
			let resolvePreadmissionRepair: (() => import("./coordination/workflow-coordinator.ts").HumanPresentationCoordinatorView) | undefined;
			if (ownerIdentified) {
				try {
					const captured = await bridge.capture(ctx.sessionManager as import("@earendil-works/pi-coding-agent").AgentSession["sessionManager"], ctx.ui);
					const runtime = captured.runtime;
					const ownerId = failure.agentId;
					const ownerIdentity = { agentId: ownerId, workflowId: ownerId, directSpawnerAgentId: null, metadata: { label: "Owner" as const, description: "Workflow Owner" as const } };
					const sessionDir = runtime.session.sessionManager.getSessionDir();
					const agentDir = runtime.services.agentDir;
					const transcriptPath = failure.transcriptPath ?? runtime.session.sessionManager.getSessionFile() ?? undefined;
					capturePreadmissionRepairEvidence({ ownerIdentity, sessionDir, agentDir, transcriptPath, stage: failure.stage });
					const coordinator = new WorkflowCoordinator(runtime, ownerIdentity, { entryModulePath: ENTRY_MODULE_PATH });
					await coordinator.initializePreadmissionRepair();
					preadmissionCoordinator = coordinator;
					resolvePreadmissionRepair = () => coordinator.forAgent(ownerId);
				} catch (repairError) {
					void repairError;
				}
			}
			// A blocked Owner has no admitted coordinator. Diagnostics stays independent
			// of that failed admission and out of restored chat history. Manual repair
			// trigger from the failed surface uses the preadmission host (verified Owner
			// identity + native config, no history replay, no fabricated records).
			registerAgentsCommand(pi, resolveAdmittedOwnerView, failure, undefined, resolvePreadmissionRepair);
			showOwnerBlockage(ctx.ui, failure);
		} finally {
			settleOwnerAdmission();
		}
	};
	pi.on("session_start", bootstrapOwner);
	pi.on("session_before_fork", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
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
