import { SessionManager } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";

import type { AgentRecord } from "./agent-record.ts";
import { MessageCoordinator } from "./messages.ts";
import { resolveOrdinaryAgentMetadata } from "../protocol/agent-metadata.ts";
import {
	type AgentSpawnInput,
	validateAgentSpawnInput,
} from "../protocol/agent-spawn-input.ts";
import {
	commitChildAgentIdentity,
	type ChildAgentIdentity,
	validateColdChildConversationMode,
	validateCommittedChildIdentity,
} from "../protocol/child-identity.ts";
import { validateConversationForkTranscript } from "../protocol/conversation-fork.ts";
import {
	deriveMessageIdentity,
	ProtocolInvariantError,
	resolveCommittedSpawnSource,
	toolCallPointerKey,
	type ToolCallPointer,
} from "../protocol/identities.ts";
import type {
	AgentRunHandle,
	RunRetentionReason,
} from "../runtime/agent-runtime-host.ts";
import { ProcessChildSessionFactory } from "../runtime/process-child-session-factory.ts";
import type { EffectiveAgentRunConfiguration } from "../templates/agent-configuration.ts";
import {
	materializeForkedAgentTranscript,
	materializeNewAgentTranscript,
	transcriptFromSessionFile,
} from "../pi-integration/session-manager-transcript.ts";

export type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";

export type AgentSpawnReceipt =
	| Readonly<{
		spawnStatus: "created";
		agentId: string;
		requestMessageId: string;
		messageStatus: "sent";
		effectiveConfiguration: EffectiveAgentRunConfiguration;
	}>
	| Readonly<{
		spawnStatus: "created";
		agentId: string;
		requestMessageId: string;
		messageStatus: "not_sent";
		failedStage: "run_start" | "delivery_admission";
		reason: string;
		effectiveConfiguration: EffectiveAgentRunConfiguration;
	}>
	| Readonly<{
		spawnStatus: "not_created";
		failedStage: "configuration" | "identity_commit";
		reason: string;
	}>
	| Readonly<{
		spawnStatus: "unknown";
		candidateAgentId?: string;
		candidateRequestMessageId?: string;
		lastConfirmedStage?: "identity" | "run_start";
		effectiveConfiguration?: EffectiveAgentRunConfiguration;
	}>;

// Tests control only whether a concrete Pi boundary confirms, rejects, or loses
// confirmation; all session, transcript, and Run effects still use the real host.
export type SpawnBoundaryHooks = Readonly<{
	afterIdentityCommit?(context: {
		identity: ChildAgentIdentity;
	}): void | "confirmation_lost";
	beforeRunStart?(): void | "confirmed_failure";
	afterRunStart?(context: {
		handle: AgentRunHandle;
		identity: ChildAgentIdentity;
	}): void | "confirmation_lost";
	beforeDeliveryAdmission?(): void | "confirmed_failure";
	afterDeliveryAdmission?(): void | "confirmation_lost";
}>;

export class DefaultChildSpawner {
	readonly #agents: Map<string, AgentRecord>;
	readonly #sessionFactory: ProcessChildSessionFactory;
	readonly #boundaryHooks: SpawnBoundaryHooks;
	readonly #isShuttingDown: () => boolean;
	readonly #messages: MessageCoordinator;
	readonly #integrateAgent: (record: AgentRecord) => void;
	readonly #agentIdBySpawnSource: Map<string, string>;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		agentIdBySpawnSource?: Map<string, string>;
		sessionFactory: ProcessChildSessionFactory;
		messages: MessageCoordinator;
		integrateAgent(record: AgentRecord): void;
		boundaryHooks?: SpawnBoundaryHooks;
		isShuttingDown(): boolean;
	}) {
		this.#agents = options.agents;
		this.#agentIdBySpawnSource = options.agentIdBySpawnSource ?? new Map();
		this.#sessionFactory = options.sessionFactory;
		this.#messages = options.messages;
		this.#integrateAgent = options.integrateAgent;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#isShuttingDown = options.isShuttingDown;
	}

	async spawn(
		callerAgentId: string,
		toolCallId: string,
		providedInput: AgentSpawnInput,
	): Promise<AgentSpawnReceipt> {
		if (this.#isShuttingDown()) {
			throw new Error("host_shutting_down: Workflow is shutting down");
		}
		const parent = this.#requireAgent(callerAgentId);
		const parentTranscript = parent.transcript.inspect();
		const { source, input: committedInput } = resolveCommittedSpawnSource({
			agentId: callerAgentId,
			transcript: parentTranscript,
			toolCallId,
		});
		const input = validateAgentSpawnInput(committedInput);
		if (!isDeepStrictEqual(input, providedInput)) {
			throw new Error("invariant_violation: executed Agent Spawn input differs from its source");
		}
		this.#assertUnclaimedSpawnSource(source);

		let metadata: ReturnType<typeof resolveOrdinaryAgentMetadata>;
		const agentId = uuidv7();
		const requestId = deriveMessageIdentity(source);
		let prepared: Awaited<
			ReturnType<ProcessChildSessionFactory["prepareOrdinaryRun"]>
		>;
		let sessionManager: SessionManager;
		try {
			this.#sessionFactory.admitProcessRuntimePlatform();
			metadata = resolveOrdinaryAgentMetadata({
				explicitLabel: input.label,
				explicitDescription: input.description,
				templateName: input.template,
			});
			prepared = await this.#sessionFactory.prepareOrdinaryRun({
				agentId,
				parent,
				spawnInput: input,
				// Configured forks use their resolved tools, not the parent active surface.
				preserveParentPromptSurface: input.conversation === "fork" &&
					input.template === undefined && input.config === undefined,
			});
		} catch (error) {
			if (error instanceof ProtocolInvariantError) throw error;
			return {
				spawnStatus: "not_created",
				failedStage: "configuration",
				reason: errorMessage(error),
			};
		}
		try {
			sessionManager = this.#sessionFactory.createStagingSession(prepared);
		} catch (error) {
			if (error instanceof ProtocolInvariantError) throw error;
			return {
				spawnStatus: "not_created",
				failedStage: "identity_commit",
				reason: errorMessage(error),
			};
		}
		if (this.#isShuttingDown()) {
			return {
				spawnStatus: "not_created",
				failedStage: "identity_commit",
				reason: "host_shutting_down: Workflow is shutting down",
			};
		}

		const identity: ChildAgentIdentity = {
			agentId,
			workflowId: parent.identity.workflowId,
			directSpawnerAgentId: callerAgentId,
			spawnSource: source,
			creationPreset: prepared.creationPreset,
			metadata,
		};
		if (input.conversation !== "fork") {
			try {
				commitChildAgentIdentity(sessionManager, identity);
			} catch (error) {
				if (error instanceof ProtocolInvariantError) throw error;
				return {
					spawnStatus: "not_created",
					failedStage: "identity_commit",
					reason: errorMessage(error),
				};
			}
		}

		let sessionPath: string;
		let materializationUncertain = false;
		try {
			sessionPath = input.conversation === "fork"
				? await materializeForkedAgentTranscript({
					sessionManager,
					parentTranscript,
					identity,
				})
				: await materializeNewAgentTranscript(sessionManager);
		} catch (error) {
			if (error instanceof ProtocolInvariantError) throw error;
			const candidatePath = sessionManager.getSessionFile();
			if (!candidatePath || !this.#hasExactDurableEvidence(
				candidatePath,
				identity,
				input.conversation === "fork",
				parentTranscript,
			)) {
				return {
					spawnStatus: "not_created",
					failedStage: "identity_commit",
					reason: errorMessage(error),
				};
			}
			sessionPath = candidatePath;
			materializationUncertain = true;
		}
		const identityConfirmation = this.#boundaryHooks.afterIdentityCommit?.({ identity });
		const childInspection = transcriptFromSessionFile(sessionPath).inspect();
		validateCommittedChildIdentity(
			childInspection,
			identity,
			{ inheritedConversation: input.conversation === "fork" },
		);
		validateColdChildConversationMode({
			entries: childInspection.entries,
			identity,
			inheritedConversation: input.conversation === "fork",
		});
		if (input.conversation === "fork") {
			validateConversationForkTranscript({
				parentTranscript,
				childTranscript: childInspection,
				identity,
			});
		}

		const child = this.#sessionFactory.createAgentRecord({
			identity,
			spawnInput: input,
			parent,
			initialPreparation: prepared,
			sessionPath,
		});
		this.#agents.set(agentId, child);
		this.#agentIdBySpawnSource.set(toolCallPointerKey(source), agentId);
		parent.children.push(agentId);
		this.#integrateAgent(child);
		this.#addRetentionReason(parent, "awaiting_answer", requestId);
		const creationDelivery = {
			recipient: child, requestId, fromAgentId: callerAgentId, title: input.title, question: input.request, source,
		};
		if (materializationUncertain || identityConfirmation === "confirmation_lost") {
			this.#messages.recordCreationRequestFailure(creationDelivery,
				new Error("Creation Request scheduling stopped after uncertain Identity confirmation"));
			return {
				spawnStatus: "unknown",
				candidateAgentId: agentId,
				candidateRequestMessageId: requestId,
				effectiveConfiguration: prepared.configuration,
			};
		}

		try {
			if (this.#boundaryHooks.beforeRunStart?.() === "confirmed_failure") {
				throw new Error("Confirmed Run startup failure");
			}
			await child.host.lane.run(() => {
				if (this.#isShuttingDown()) {
					throw new Error("host_shutting_down: Workflow is shutting down");
				}
				return child.host.startInLane(["pending_delivery"]);
			});
		} catch (error) {
			this.#messages.recordCreationRequestFailure(creationDelivery, error);
			if (error instanceof ProtocolInvariantError) throw error;
			return {
				spawnStatus: "created",
				agentId,
				requestMessageId: requestId,
				messageStatus: "not_sent",
				failedStage: "run_start",
				reason: errorMessage(error),
				effectiveConfiguration: prepared.configuration,
			};
		}
		const startedHandle = child.host.currentHandle();
		if (!startedHandle) {
			throw new Error("invariant_violation: confirmed child Run has no handle");
		}
		if (
			this.#boundaryHooks.afterRunStart?.({
				handle: startedHandle,
				identity,
			}) === "confirmation_lost"
		) {
			this.#messages.recordCreationRequestFailure(creationDelivery,
				new Error("Creation Request scheduling stopped after uncertain Run confirmation"));
			return {
				spawnStatus: "unknown",
				candidateAgentId: agentId,
				candidateRequestMessageId: requestId,
				lastConfirmedStage: "identity",
				effectiveConfiguration: prepared.configuration,
			};
		}

		try {
			if (this.#boundaryHooks.beforeDeliveryAdmission?.() === "confirmed_failure") {
				throw new Error("Confirmed Delivery admission failure");
			}
			const admission = await this.#messages.admitCreationRequest(creationDelivery);
			if (admission !== "pending") throw new Error(admission);
		} catch (error) {
			this.#messages.recordCreationRequestFailure(creationDelivery, error);
			try {
				await this.#messages.requestRelease(child);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Creation Request admission cleanup failed");
			}
			if (error instanceof ProtocolInvariantError) throw error;
			return {
				spawnStatus: "created",
				agentId,
				requestMessageId: requestId,
				messageStatus: "not_sent",
				failedStage: "delivery_admission",
				reason: errorMessage(error),
				effectiveConfiguration: prepared.configuration,
			};
		}
		if (this.#boundaryHooks.afterDeliveryAdmission?.() === "confirmation_lost") {
			return {
				spawnStatus: "unknown",
				candidateAgentId: agentId,
				candidateRequestMessageId: requestId,
				lastConfirmedStage: "run_start",
				effectiveConfiguration: prepared.configuration,
			};
		}
		return {
			spawnStatus: "created",
			agentId,
			requestMessageId: requestId,
			messageStatus: "sent",
			effectiveConfiguration: prepared.configuration,
		};
	}

	#hasExactDurableEvidence(
		sessionPath: string,
		identity: ChildAgentIdentity,
		inheritedConversation: boolean,
		parentTranscript: ReturnType<AgentRecord["transcript"]["inspect"]>,
	): boolean {
		try {
			const inspection = transcriptFromSessionFile(sessionPath).inspect();
			validateCommittedChildIdentity(
				inspection,
				identity,
				{ inheritedConversation },
			);
			validateColdChildConversationMode({
				entries: inspection.entries,
				identity,
				inheritedConversation,
			});
			if (inheritedConversation) {
				validateConversationForkTranscript({
					parentTranscript,
					childTranscript: inspection,
					identity,
				});
			}
			return true;
		} catch (error) {
			if (error instanceof ProtocolInvariantError) throw error;
			return false;
		}
	}

	#assertUnclaimedSpawnSource(source: ToolCallPointer): void {
		if (this.#agentIdBySpawnSource.has(toolCallPointerKey(source))) {
			throw new Error("invariant_violation: Agent Spawn source already has a child");
		}
	}

	#addRetentionReason(
		record: AgentRecord,
		reason: RunRetentionReason,
		requestId?: string,
	): void {
		record.host.addRetentionReason(reason, requestId);
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.trim() || "Unknown Agent Spawn failure";
}
