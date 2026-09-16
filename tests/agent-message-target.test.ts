import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveCommittedAgentMessageTargetId } from "../src/coordination/agent-message-target.ts";
import { resolveAgentTarget } from "../src/coordination/agent-target.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";

const agents = [
	{ agentId: "workflow-owner-1111aaaa", label: "Owner" },
	{ agentId: "agent-research-2222bbbb", label: "Researcher" },
	{ agentId: "agent-review-3333bbbb", label: "Reviewer" },
];

test("Agent Message targets resolve exact labels and unique ID suffixes", () => {
	assert.equal(
		resolveAgentTarget(agents, agents, "Researcher").agentId,
		"agent-research-2222bbbb",
	);
	assert.equal(
		resolveAgentTarget(agents, agents, "3333bbbb").agentId,
		"agent-review-3333bbbb",
	);
});

test("Agent Message target resolution never chooses an ambiguous match", () => {
	assert.throws(
		() => resolveAgentTarget(agents, agents, "bbbb"),
		/ambiguous_target: Agent ID suffix bbbb matches 2 Agents/,
	);
	assert.throws(
		() => resolveAgentTarget([
			...agents,
			{ agentId: "agent-second-researcher", label: "Researcher" },
		], [
			...agents,
			{ agentId: "agent-second-researcher", label: "Researcher" },
		], "Researcher"),
		/ambiguous_target: Agent label Researcher matches 2 addressable Agents/,
	);
});

test("an exact full Agent ID wins before label and suffix matching", () => {
	const exactId = "agent-research-2222bbbb";
	assert.equal(
		resolveAgentTarget([
			...agents,
			{ agentId: "agent-other", label: exactId },
		], [
			...agents,
			{ agentId: "agent-other", label: exactId },
		], exactId).agentId,
		exactId,
	);
});

test("Agent Message target resolution rejects blank and unknown selectors", () => {
	assert.throws(
		() => resolveAgentTarget(agents, agents, "  "),
		/invalid_input: Agent selector must not be blank/,
	);
	assert.throws(
		() => resolveAgentTarget(agents, agents, "Missing"),
		/unknown_identity: Agent target Missing/,
	);
});

test("Agent labels resolve only within the caller's coordination neighborhood", () => {
	const localResearcher = agents[1]!;
	const remoteResearcher = {
		agentId: "remote-research-4444cccc",
		label: "Researcher",
	};
	assert.equal(
		resolveAgentTarget(
			[...agents, remoteResearcher],
			[agents[0]!, localResearcher],
			"Researcher",
		).agentId,
		localResearcher.agentId,
	);
	assert.equal(
		resolveAgentTarget(
			[...agents, remoteResearcher],
			[agents[0]!, localResearcher],
			"4444cccc",
		).agentId,
		remoteResearcher.agentId,
	);
});

test("result-less recovery cannot retarget a selector around quarantined evidence", () => {
	const authorAgentId = "workflow-owner";
	const toolCallId = "result-less-selector";
	const selector = "Researcher";
	const authorSession = session(authorAgentId);
	authorSession.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", {
			operation: "send",
			targetAgent: selector,
			content: "Keep the original target fixed.",
		}, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	const live = record("live-researcher", selector);
	const agentMap = new Map([
		[authorAgentId, record(authorAgentId, "Owner", authorSession)],
		[live.identity.agentId, live],
	]);

	assert.throws(
		() => resolveCommittedAgentMessageTargetId({
			agents: agentMap,
			quarantinedWorkflowAgentIds: new Set(["quarantined-original"]),
			authorAgentId,
			authorTranscript: transcriptFromSessionManager(authorSession).inspect(),
			toolCallId,
			targetAgent: selector,
		}),
		/evidence_unavailable: Agent Message target Researcher depends on quarantined Agent proof/,
	);
});

test("exact quarantined IDs keep precedence over a live Agent label", () => {
	const authorAgentId = "workflow-owner";
	const quarantinedAgentId = "quarantined-target";
	const toolCallId = "exact-quarantined-selector";
	const authorSession = session(authorAgentId);
	authorSession.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", {
			operation: "send",
			targetAgent: quarantinedAgentId,
			content: "Do not retarget this exact identity.",
		}, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	const live = record("live-agent", quarantinedAgentId);

	assert.equal(resolveCommittedAgentMessageTargetId({
		agents: new Map([
			[authorAgentId, record(authorAgentId, "Owner", authorSession)],
			[live.identity.agentId, live],
		]),
		quarantinedWorkflowAgentIds: new Set([quarantinedAgentId]),
		authorAgentId,
		authorTranscript: transcriptFromSessionManager(authorSession).inspect(),
		toolCallId,
		targetAgent: quarantinedAgentId,
	}), quarantinedAgentId);
});

test("recipient Delivery binding precedes a later unique suffix match", () => {
	const authorAgentId = "workflow-owner";
	const originalTargetAgentId = "agent-original-target";
	const toolCallId = "delivered-label-selector";
	const content = "Keep recipient proof authoritative.";
	const authorSession = session(authorAgentId);
	const entryId = authorSession.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", {
			operation: "send",
			targetAgent: "beef",
			content,
		}, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	const source = { agentId: authorAgentId, entryId, toolCallId };
	const originalTargetSession = session(originalTargetAgentId);
	const delivery = createMessageDelivery([{
		source,
		projection: {
			kind: "message",
			messageId: deriveMessageIdentity(source),
			fromAgentId: authorAgentId,
			content,
		},
	}]);
	originalTargetSession.appendCustomMessageEntry(
		delivery.customType,
		delivery.content,
		delivery.display,
		delivery.details,
	);
	const originalTarget = record(originalTargetAgentId, "beef", originalTargetSession);
	const laterSuffixMatch = record("agent-later-beef", "Later");

	assert.equal(resolveCommittedAgentMessageTargetId({
		agents: new Map([
			[authorAgentId, record(authorAgentId, "Owner", authorSession)],
			[originalTargetAgentId, originalTarget],
			[laterSuffixMatch.identity.agentId, laterSuffixMatch],
		]),
		quarantinedWorkflowAgentIds: new Set(),
		authorAgentId,
		authorTranscript: transcriptFromSessionManager(authorSession).inspect(),
		toolCallId,
		targetAgent: "beef",
	}), originalTargetAgentId);
});

test("a healthy unique ID suffix still resolves when other Workflow evidence is quarantined", () => {
	const authorAgentId = "workflow-owner";
	const toolCallId = "healthy-suffix-with-quarantine";
	const authorSession = session(authorAgentId);
	authorSession.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", {
			operation: "send",
			targetAgent: "81e3",
			content: "Use the identifiable healthy target.",
		}, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	const target = record("healthy-target-81e3", "Researcher");

	assert.equal(resolveCommittedAgentMessageTargetId({
		agents: new Map([
			[authorAgentId, record(authorAgentId, "Owner", authorSession)],
			[target.identity.agentId, target],
		]),
		quarantinedWorkflowAgentIds: new Set(["other-quarantined-agent"]),
		authorAgentId,
		authorTranscript: transcriptFromSessionManager(authorSession).inspect(),
		toolCallId,
		targetAgent: "81e3",
	}), target.identity.agentId);
});

test("a rejected ambiguous Request is not retained as canonical Request evidence", () => {
	const authorAgentId = "workflow-owner";
	const toolCallId = "ambiguous-request";
	const authorSession = session(authorAgentId);
	authorSession.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", {
			title: "Fixture request",
			operation: "request",
			targetAgent: "native-input-review",
			question: "Review native input handling.",
		}, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	authorSession.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{
			type: "text",
			text:
				"ambiguous_target: Agent label native-input-review matches 2 addressable Agents",
		}],
		details: {},
		isError: true,
		timestamp: Date.now(),
	});
	const author = record(authorAgentId, "Owner", authorSession);
	const first = record("first-review-agent", "native-input-review");
	const second = record("second-review-agent", "native-input-review");
	const evidence = new RequestEvidence(new Map([
		[authorAgentId, author],
		[first.identity.agentId, first],
		[second.identity.agentId, second],
	]));

	assert.deepEqual(evidence.residualRelationshipsFor(author), { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
});

test("an unresolved ambiguous Request stays out of relationship reconciliation", () => {
	const authorAgentId = "workflow-owner";
	const toolCallId = "unresolved-ambiguous-request";
	const authorSession = session(authorAgentId);
	authorSession.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", {
			title: "Fixture request",
			operation: "request",
			targetAgent: "native-input-review",
			question: "Review native input handling.",
		}, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	const author = record(authorAgentId, "Owner", authorSession);
	const first = record("first-review-agent", "native-input-review");
	const second = record("second-review-agent", "native-input-review");
	const evidence = new RequestEvidence(new Map([
		[authorAgentId, author],
		[first.identity.agentId, first],
		[second.identity.agentId, second],
	]));

	assert.deepEqual(evidence.residualRelationshipsFor(author), { awaitingAnswerRequestIds: [], answerOwedRequestIds: [] });
});

test("an error result plus Request Delivery remains contradictory evidence", () => {
	const authorAgentId = "workflow-owner";
	const targetAgentId = "first-review-agent";
	const toolCallId = "contradictory-request";
	const input = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: "native-input-review",
		question: "Review native input handling.",
	};
	const authorSession = session(authorAgentId);
	const entryId = authorSession.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", input, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	authorSession.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Scheduling failed." }],
		details: {},
		isError: true,
		timestamp: Date.now(),
	});
	const source = { agentId: authorAgentId, entryId, toolCallId };
	const targetSession = session(targetAgentId);
	const delivery = createMessageDelivery([{
		source,
		projection: {
			title: "Fixture request",
			kind: "request",
			requestMessageId: deriveMessageIdentity(source),
			fromAgentId: authorAgentId,
			question: input.question,
		},
	}]);
	targetSession.appendCustomMessageEntry(
		delivery.customType,
		delivery.content,
		delivery.display,
		delivery.details,
	);
	const author = record(authorAgentId, "Owner", authorSession);
	const first = record(targetAgentId, "native-input-review", targetSession);
	const second = record("second-review-agent", "native-input-review");
	const evidence = new RequestEvidence(new Map([
		[authorAgentId, author],
		[first.identity.agentId, first],
		[second.identity.agentId, second],
	]));

	assert.throws(
		() => evidence.residualRelationshipsFor(author),
		/error result and Delivery/,
	);
});

test("persisted selector results must name a known or quarantined full identity", () => {
	const authorAgentId = "workflow-owner";
	const toolCallId = "malformed-persisted-target";
	const authorSession = session(authorAgentId);
	const entryId = authorSession.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", {
			operation: "send",
			targetAgent: "Researcher",
			content: "Reject the malformed target binding.",
		}, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	const source = { agentId: authorAgentId, entryId, toolCallId };
	authorSession.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Malformed target." }],
		details: {
			messageId: deriveMessageIdentity(source),
			targetAgentId: "unknown-target",
			messageStatus: "sent",
		},
		isError: false,
		timestamp: Date.now(),
	});

	assert.throws(() => resolveCommittedAgentMessageTargetId({
		agents: new Map([
			[authorAgentId, record(authorAgentId, "Owner", authorSession)],
		]),
		quarantinedWorkflowAgentIds: new Set(),
		authorAgentId,
		authorTranscript: transcriptFromSessionManager(authorSession).inspect(),
		toolCallId,
		targetAgent: "Researcher",
	}), /invariant_violation: Agent Message author result names unknown target unknown-target/);
});

function session(agentId: string): SessionManager {
	const manager = SessionManager.inMemory(process.cwd(), { id: agentId });
	manager.appendCustomEntry("agent-coordination.identity", { agentId });
	return manager;
}

function record(
	agentId: string,
	label: string,
	manager = session(agentId),
): AgentRecord {
	return {
		identity: {
			agentId,
			workflowId: "workflow-owner",
			directSpawnerAgentId: null,
			metadata: { label },
		} as AgentRecord["identity"],
		host: {} as AgentRecord["host"],
		transcript: transcriptFromSessionManager(manager),
		children: [],
	};
}
