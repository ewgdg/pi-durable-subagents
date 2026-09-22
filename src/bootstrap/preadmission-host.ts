import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { OwnerRecoveryError } from "./owner-recovery-error.ts";
import { WorkflowCoordinator, type HumanPresentationCoordinatorView } from "../coordination/workflow-coordinator.ts";
import { capturePreadmissionRepairEvidence, type PreadmissionRepairEvidence } from "../coordination/preadmission-repair.ts";
import { transcriptFromSessionManager } from "../pi-integration/session-manager-transcript.ts";
import { readWorkflowPolicy, WorkflowPolicyStore } from "../policy/workflow-policy.ts";

/** Visible signal for preadmission setup failures; data stays untouched. */
export function preadmissionFailureNotice(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return "Preadmission repair host unavailable: " + detail + ". Diagnostics remain available; no transcript was modified.";
}

export type PreadmissionRepairSetup = Readonly<{
	coordinator: WorkflowCoordinator;
	evidence: PreadmissionRepairEvidence;
	ownerId: string;
	resolvePreadmissionRepair: () => HumanPresentationCoordinatorView;
}>;

/** Build the repair-only preadmission host from verified identity + native config. */
export async function setupPreadmissionRepairHost(options: {
	captureRuntime: () => Promise<AgentSessionRuntime>;
	entryModulePath: string;
	failure: OwnerRecoveryError;
	identifiedOwnerId: string | undefined;
	ownerIdentified: boolean;
}): Promise<PreadmissionRepairSetup> {
	if (!options.ownerIdentified) {
		throw new Error("identity_mismatch: Owner role identification did not complete");
	}
	if (options.identifiedOwnerId === undefined || options.failure.agentId !== options.identifiedOwnerId) {
		throw new Error("identity_mismatch: admission failure agent " + options.failure.agentId + " does not match verified Owner identity " + String(options.identifiedOwnerId));
	}
	const runtime = await options.captureRuntime();
	const ownerId = options.identifiedOwnerId;
	const ownerIdentity = { agentId: ownerId, workflowId: ownerId, directSpawnerAgentId: null, metadata: { label: "Owner" as const, description: "Workflow Owner" as const } };
	const sessionDir = runtime.session.sessionManager.getSessionDir();
	const agentDir = runtime.services.agentDir;
	const transcriptPath = options.failure.transcriptPath ?? runtime.session.sessionManager.getSessionFile() ?? undefined;
	const evidence = capturePreadmissionRepairEvidence({ ownerIdentity, sessionDir, agentDir, transcriptPath, stage: options.failure.stage });
	// Failed admission may retain cached coordination projections; rebuild fresh.
	transcriptFromSessionManager(runtime.session.sessionManager, { fresh: true });
	// The admitted host loads this same file in owner-bootstrap. Without it the
	// repair-only host falls back to empty exclusions and the repair Moderator
	// run can select a model the Owner explicitly banned.
	const policyRead = await readWorkflowPolicy(evidence.agentDir);
	if (!policyRead.ok) throw new Error(policyRead.diagnostic.message);
	const coordinator = new WorkflowCoordinator(runtime, ownerIdentity, {
		entryModulePath: options.entryModulePath,
		workflowPolicy: new WorkflowPolicyStore(policyRead.snapshot),
	});
	await coordinator.initializePreadmissionRepair();
	if (evidence.workflowDirectory !== coordinator.preadmissionRepairWorkflowDirectory()) {
		await coordinator.shutdown(async () => undefined).catch(() => undefined);
		throw new Error("invariant_violation: preadmission evidence workflow directory mismatch");
	}
	return { coordinator, evidence, ownerId, resolvePreadmissionRepair: () => coordinator.forAgent(ownerId) };
}
