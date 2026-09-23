import { indexedState, coordinationEntries } from "../transcript/retained-transcript.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { resolveCommittedToolCall } from "../protocol/identities.ts";
import { deliveriesBySource } from "../protocol/message-delivery.ts";
import { resolveCommittedAgentMessageInput } from "../protocol/message.ts";
import { validateAgentMessageResultShape } from "../protocol/message-result-shape.ts";
import { readCoordinationRecord } from "../protocol/replay-rejection.ts";
import { EvidenceUnavailableError, type AgentRecord } from "./agent-record.ts";
import { resolveAgentTarget, resolveIdentityCandidate } from "./agent-target.ts";

type CommittedAgentMessageTargetInspection =
	| Readonly<{ state: "resolved"; targetAgentId: string }>
	| Readonly<{ state: "not_created" }>
	| Readonly<{ state: "indeterminate" }>;

type CommittedAgentMessageTargetOptions = Readonly<{
	agents: ReadonlyMap<string, AgentRecord>;
	quarantinedWorkflowAgentIds: ReadonlySet<string>;
	authorAgentId: string;
	authorTranscript: TranscriptInspection;
	toolCallId: string;
	targetAgent: string;
}>;

export function resolveCommittedAgentMessageTargetId(
	options: CommittedAgentMessageTargetOptions,
): string {
	const inspection = inspectCommittedAgentMessageTarget(options);
	if (inspection.state === "resolved") return inspection.targetAgentId;
	if (inspection.state === "not_created") {
		throw new Error("not_created: Agent Message authoring failed");
	}
	return resolveCurrentAgentMessageTargetId(options);
}

export function inspectCommittedAgentMessageTarget(
	options: CommittedAgentMessageTargetOptions,
): CommittedAgentMessageTargetInspection {
	const {
		agents,
		quarantinedWorkflowAgentIds,
		authorAgentId,
		authorTranscript,
		toolCallId,
		targetAgent,
	} = options;
	const persistedResult = inspectPersistedTargetResult({
		authorAgentId,
		transcript: authorTranscript,
		toolCallId,
	});
	if (persistedResult.state === "resolved") {
		const target = agents.get(persistedResult.targetAgentId);
		if (target) {
			validateTargetMatchesSelector(target, targetAgent);
			return persistedResult;
		}
		if (quarantinedWorkflowAgentIds.has(persistedResult.targetAgentId)) {
			// The binding remains canonical when cold recovery quarantines the target;
			// availability is a separate decision at the operation boundary.
			return persistedResult;
		}
		throw new Error(
			`invariant_violation: Agent Message author result names unknown target ${persistedResult.targetAgentId}`,
		);
	}

	const selector = targetAgent.trim();
	if (!selector) {
		throw new Error("invalid_input: Agent Message targetAgent must not be blank");
	}

	// Delivery fixes the target even when the author result is missing or contradictory.
	// It must win before a later roster change can reinterpret the selector.
	const { source } = resolveCommittedToolCall({
		agentId: authorAgentId,
		transcript: authorTranscript,
		toolCallId,
		toolName: "agent_message",
	});
	const observations = [...agents.values()].map((record) => {
		const transcript = record.transcript.inspect();
		return {
			record,
			state: indexedState(transcript),
			count: deliveriesBySource({
				recipientAgentId: record.identity.agentId,
				transcript,
				source,
			}).length,
		};
	});
	const deliveredTargets = indexedState(authorTranscript).memo(
		inspectCommittedAgentMessageTarget,
		toolCallId,
		observations.flatMap(({ record, state, count }) => [record, state, state.scopeVersion, count]),
		() => observations.filter(({ count }) => count > 0).map(({ record }) => record),
	);
	if (deliveredTargets.length > 1) {
		throw new Error(
			`invariant_violation: Agent Message ${toolCallId} has Deliveries to multiple Agents`,
		);
	}
	if (deliveredTargets[0]) {
		validateTargetMatchesSelector(deliveredTargets[0], targetAgent);
		return {
			state: "resolved",
			targetAgentId: deliveredTargets[0].identity.agentId,
		};
	}
	if (persistedResult.state === "not_created") {
		if (quarantinedWorkflowAgentIds.size > 0) {
			throw new EvidenceUnavailableError(
				`Agent Message target ${selector} depends on quarantined Agent proof`,
			);
		}
		return persistedResult;
	}
	return { state: "indeterminate" };
}

function resolveCurrentAgentMessageTargetId(
	options: CommittedAgentMessageTargetOptions,
): string {
	const {
		agents,
		quarantinedWorkflowAgentIds,
		authorAgentId,
		targetAgent,
	} = options;
	const selector = targetAgent.trim();
	const knownCandidates = [...agents.values()].map((record) => ({
		agentId: record.identity.agentId,
		label: record.identity.metadata.label,
	}));
	const identityCandidates = [
		...knownCandidates,
		...[...quarantinedWorkflowAgentIds]
			.filter((agentId) => !agents.has(agentId))
			.map((agentId) => ({ agentId, label: "" })),
	];
	const identity = resolveIdentityCandidate(identityCandidates, selector);
	if (identity) return identity.agentId;

	// A quarantined Workflow candidate has unavailable label metadata, so an
	// unbound label cannot be proven unique even when one verified label matches.
	if (quarantinedWorkflowAgentIds.size > 0) {
		throw new EvidenceUnavailableError(
			`Agent Message target ${selector} depends on quarantined Agent proof`,
		);
	}
	const labelCandidateIds = labelCandidateAgentIds(agents, authorAgentId);
	return resolveAgentTarget(
		[],
		knownCandidates.filter(({ agentId }) => labelCandidateIds.has(agentId)),
		targetAgent,
	).agentId;
}

function labelCandidateAgentIds(
	agents: ReadonlyMap<string, AgentRecord>,
	authorAgentId: string,
): ReadonlySet<string> {
	const author = agents.get(authorAgentId);
	if (!author) throw new Error(`unknown_identity: ${authorAgentId}`);
	if (!("spawnSource" in author.identity)) return new Set(agents.keys());
	return new Set([
		author.identity.agentId,
		author.identity.directSpawnerAgentId,
		...author.children,
	]);
}

function validateTargetMatchesSelector(
	target: AgentRecord,
	targetAgent: string,
): void {
	const selector = targetAgent.trim();
	if (
		target.identity.agentId !== selector &&
		target.identity.metadata.label !== selector &&
		!target.identity.agentId.endsWith(selector)
	) {
		throw new Error(
			"invariant_violation: Agent Message resolved target does not match its selector",
		);
	}
}

function inspectPersistedTargetResult(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): CommittedAgentMessageTargetInspection {
	const entries = coordinationEntries(
		options.transcript,
		options.authorAgentId,
		`result:${options.toolCallId}`,
	);
	return indexedState(options.transcript).memo(
		inspectPersistedTargetResult,
		`${options.authorAgentId}\0${options.toolCallId}`,
		entries.length,
		(): CommittedAgentMessageTargetInspection => {
			const { operation } = resolveCommittedAgentMessageInput({
				agentId: options.authorAgentId,
				transcript: options.transcript,
				toolCallId: options.toolCallId,
			});
			const results = entries.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "agent_message" &&
					entry.message.toolCallId === options.toolCallId,
			).filter((entry) => {
				if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) return true;
				const details = entry.message.details;
				// A rejected receipt stays in the replay-rejection index but must not
				// bind a target or count as a duplicate author result.
				return readCoordinationRecord(options.transcript, options.authorAgentId, entry,
					() => validateAgentMessageResultShape(details, operation), options.toolCallId).accepted;
			});
			if (results.length > 1) {
				throw new Error(
					`invariant_violation: Agent Message ${options.toolCallId} has multiple author results`,
				);
			}
			const result = results[0];
			if (!result || result.type !== "message" || result.message.role !== "toolResult")
				return { state: "indeterminate" };
			if (result.message.isError) return { state: "not_created" };
			if (
				typeof result.message.details !== "object" ||
				result.message.details === null ||
				!("targetAgentId" in result.message.details)
			)
				return { state: "indeterminate" };
			// The accepted-shape filter above guarantees a non-blank string target.
			return { state: "resolved", targetAgentId: result.message.details.targetAgentId as string };
		},
	);
}
