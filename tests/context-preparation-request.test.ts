import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import {
	createMessageDeliveryItem,
	resolveCommittedMessage,
	sameAgentMessageInput,
	validateAgentMessageInput,
} from "../src/protocol/message.ts";

test("context preparation is an exact optional Agent Request field", () => {
	const request = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: "recipient-agent",
		question: "Continue the bounded implementation work.",
		contextPreparation: {
			workScale: "large" as const,
			contextDependence: "high" as const,
		},
	};
	assert.deepEqual(validateAgentMessageInput(request), request);
	assert.deepEqual(validateAgentMessageInput({
		title: "Fixture request",
		operation: "request",
		targetAgent: "recipient-agent",
		question: "Use ordinary Pi compaction behavior.",
	}), {
		title: "Fixture request",
		operation: "request",
		targetAgent: "recipient-agent",
		question: "Use ordinary Pi compaction behavior.",
	});

	for (const contextPreparation of [
		{ workScale: "small" },
		{ contextDependence: "low" },
		{ workScale: "tiny", contextDependence: "low" },
		{ workScale: "small", contextDependence: "critical" },
		{ workScale: "small", contextDependence: "low", extra: true },
	]) {
		assert.throws(() => validateAgentMessageInput({
			title: "Fixture request",
			operation: "request",
			targetAgent: "recipient-agent",
			question: "Reject incomplete preparation intent.",
			contextPreparation,
		}), /contextPreparation|invalid shape/);
	}

	assert.throws(() => validateAgentMessageInput({
		operation: "retry",
		messageId: "prepared-request",
		contextPreparation: request.contextPreparation,
	}), /invalid shape/);

	assert.throws(() => validateAgentMessageInput({
		operation: "send",
		targetAgent: "recipient-agent",
		content: "Preparation is unavailable for Messages.",
		contextPreparation: request.contextPreparation,
	}), /invalid shape/);

	assert.equal(sameAgentMessageInput(request, request), true);
	assert.equal(sameAgentMessageInput(request, {
		...request,
		contextPreparation: { workScale: "small", contextDependence: "high" },
	}), false);
	assert.equal(sameAgentMessageInput(request, {
		title: "Fixture request",
		operation: "request",
		targetAgent: request.targetAgent,
		question: request.question,
	}), false);
});

test("committed preparation intent stays outside the model-visible Request projection", () => {
	const fromAgentId = "request-author";
	const workflowId = "working-zone-workflow";
	const toolCallId = "prepared-request-call";
	const input = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: "recipient-agent",
		question: "Continue from the context you already acquired.",
		contextPreparation: {
			workScale: "medium" as const,
			contextDependence: "high" as const,
		},
	};
	const sessionManager = SessionManager.inMemory(process.cwd(), { id: fromAgentId });
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: fromAgentId });
	const entryId = sessionManager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", input, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	const message = resolveCommittedMessage({
		fromAgentId,
		workflowId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		toolCallId,
		providedInput: input,
		resolvedTargetAgentId: input.targetAgent,
	});

	assert.equal(message.kind, "request");
	if (message.kind !== "request") throw new Error("Expected a committed Request");
	assert.deepEqual(message.contextPreparation, input.contextPreparation);
	assert.deepEqual(createMessageDeliveryItem(message), {
		source: { agentId: fromAgentId, entryId, toolCallId },
		projection: {
			title: "Fixture request",
			kind: "request",
			requestMessageId: message.messageId,
			fromAgentId,
			question: input.question,
		},
	});
});
