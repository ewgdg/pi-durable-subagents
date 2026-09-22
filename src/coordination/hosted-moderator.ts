import { uuidv7 } from "@earendil-works/pi-ai";

import type { AgentCreationPreset } from "../templates/agent-templates.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { ProtocolInvariantError } from "../protocol/identities.ts";
import {
	createModelVisibleModeratorInput,
	createModelVisibleModeratorRoutineStart,
	validateCommittedModeratorInput,
	type ModeratorIdentity,
	type ModeratorInput,
} from "../protocol/moderator-input.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	materializeNewAgentTranscript,
	transcriptFromSessionFile,
} from "../pi-integration/session-manager-transcript.ts";
import type { ProcessChildSessionFactory } from "../runtime/process-child-session-factory.ts";
import type { AgentRecord } from "./agent-record.ts";
import type { MessageCoordinator } from "./messages.ts";

export type HostedModeratorDependencies = Readonly<{
	agents: Map<string, AgentRecord>;
	ownerIdentity: OwnerIdentity;
	sessionFactory: ProcessChildSessionFactory;
	messages: MessageCoordinator;
	integrateAgent(record: AgentRecord): void;
	isShuttingDown(): boolean;
}>;

export type HostedModeratorBootstrap = Readonly<{
	identity: ModeratorIdentity;
	input: ModeratorInput;
	sessionPath: string;
	moderator: AgentRecord;
}>;

export type HostedModeratorCommitRequest = Readonly<{
	metadata(args: Readonly<{ agentId: string; creationPreset: AgentCreationPreset }>): ModeratorIdentity["metadata"];
	input(args: Readonly<{ agentId: string }>): ModeratorInput;
	/** Workflow-directory subdirectory for the live transcript, e.g. the repair namespace. */
	sessionSubdirectory?: string;
	onStage?(stage: string): void;
	/** May return "aborted" to stop after staging, before identity and Input are built. */
	beforeInputCommit?(): void | "aborted";
	/** Runs after the bootstrap-commit stage is recorded; may throw to fail the commit. */
	beforeBootstrapCommit?(): void;
	onCommitted?(bootstrap: Readonly<{ agentId: string; sessionPath: string }>): void;
}>;

/**
 * Minimal shared hosted-Moderator core extracted from incident detection:
 * Input commit/verify plus a real integrated AgentRecord. Incident handling
 * (detection, attempts, reports) and manual repair (trigger, namespace,
 * join-or-refuse) stay with callers. Returns undefined when shutdown or an
 * aborted commit stops the bootstrap.
 */
export async function commitHostedModerator(
	dependencies: HostedModeratorDependencies,
	request: HostedModeratorCommitRequest,
): Promise<HostedModeratorBootstrap | undefined> {
	const { agents, ownerIdentity, sessionFactory } = dependencies;
	if (!agents.has(ownerIdentity.agentId)) {
		throw new Error("invariant_violation: Workflow Owner is unavailable");
	}
	request.onStage?.("Moderator runtime preparation");
	sessionFactory.admitProcessRuntimePlatform();
	const agentId = uuidv7();
	const prepared = await sessionFactory.prepareModeratorRun({ agentId });
	request.onStage?.("Moderator staging session creation");
	const sessionManager = sessionFactory.createStagingSession(prepared, request.sessionSubdirectory);
	if (dependencies.isShuttingDown()) return undefined;
	if (request.beforeInputCommit?.() === "aborted") return undefined;
	const identity: ModeratorIdentity = {
		agentId,
		workflowId: ownerIdentity.workflowId,
		directSpawnerAgentId: null,
		creationPreset: prepared.creationPreset,
		metadata: request.metadata({ agentId, creationPreset: prepared.creationPreset }),
	};
	const input = request.input({ agentId });
	request.onStage?.("Moderator bootstrap commit");
	request.beforeBootstrapCommit?.();
	if (dependencies.isShuttingDown()) return undefined;
	const modelInput = createModelVisibleModeratorInput(identity, input);
	sessionManager.appendCustomMessageEntry(
		modelInput.customType,
		modelInput.content,
		modelInput.display,
		modelInput.details,
	);
	let sessionPath: string;
	try {
		sessionPath = await materializeNewAgentTranscript(sessionManager);
	} catch (error) {
		if (error instanceof ProtocolInvariantError) throw error;
		const candidatePath = sessionManager.getSessionFile();
		if (!candidatePath || !hasExactDurableModeratorEvidence({ sessionPath: candidatePath, identity, input })) throw error;
		sessionPath = candidatePath;
	}
	request.onStage?.("Moderator bootstrap verification");
	validateCommittedModeratorInput({
		transcript: transcriptFromSessionFile(sessionPath).inspect(),
		identity,
		input,
	});
	request.onCommitted?.({ agentId, sessionPath });
	request.onStage?.("Moderator record integration");
	const moderator = sessionFactory.createModeratorRecord({
		identity,
		initialPreparation: prepared,
		sessionPath,
	});
	agents.set(agentId, moderator);
	dependencies.integrateAgent(moderator);
	return { identity, input, sessionPath, moderator };
}

/**
 * Starts the hosted Moderator Run with moderator_handling retention and admits
 * the routine-start delivery in-lane, atomically against queued Run termination.
 */
export async function startHostedModeratorRun(
	dependencies: HostedModeratorDependencies,
	options: Readonly<{
		moderator: AgentRecord;
		onStage?(stage: string): void;
		/** Runs in-lane after Run start, before routine-start admission. */
		onRunStarted?(moderator: AgentRecord): void | Promise<void>;
	}>,
): Promise<void> {
	const { moderator } = options;
	const agentId = moderator.identity.agentId;
	options.onStage?.("Moderator Run startup");
	await moderator.host.lane.run(async () => {
		if (dependencies.isShuttingDown()) return;
		await moderator.host.startInLane(["moderator_handling"]);
		await options.onRunStarted?.(moderator);
		if (dependencies.isShuttingDown()) return;
		const routineStart = createModelVisibleModeratorRoutineStart();
		// Startup is already progress before the child reports agent.start.
		// Scheduler ownership prevents treating this in-flight first turn as a stall.
		const admission = await dependencies.messages.admitCustomDeliveryInLane(moderator, {
			messageId: JSON.stringify([routineStart.customType, agentId]),
			deliveryMode: "deferred",
			customMessage: routineStart,
			inspectProof: () => {
				const entry = coordinationEntries(moderator.transcript.inspect(), agentId,
					`custom:${routineStart.customType}`).find(entry =>
					entry.type === "custom_message" && entry.content === routineStart.content);
				return entry ? { agentId, entryId: entry.id } : undefined;
			},
		});
		if (admission !== "pending") throw new Error(`Moderator startup delivery rejected: ${admission}`);
	});
}

export function hasExactDurableModeratorEvidence(options: {
	sessionPath: string;
	identity: ModeratorIdentity;
	input: ModeratorInput;
}): boolean {
	try {
		validateCommittedModeratorInput({
			transcript: transcriptFromSessionFile(options.sessionPath).inspect(),
			identity: options.identity,
			input: options.input,
		});
		return true;
	} catch (error) {
		if (error instanceof ProtocolInvariantError) throw error;
		return false;
	}
}
