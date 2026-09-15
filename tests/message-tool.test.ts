import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("native Agent Message rendering shows bounded Steer intent and typed disposition", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination);
	const tool = host.session.getToolDefinition("agent_message");
	assert.ok(tool?.renderCall);
	assert.ok(tool.renderResult);
	const parameters = tool.parameters as unknown as {
		anyOf?: Array<{
			properties?: Record<string, {
				const?: unknown;
				anyOf?: Array<{ const?: unknown }>;
			}>;
		}>;
	};
	assert.deepEqual(
		parameters.anyOf?.map((candidate) => candidate.properties?.operation?.const),
		["send", "request", "answer", "cancel", "poll", "retry"],
	);
	const requestSchema = parameters.anyOf?.find(
		(candidate) => candidate.properties?.operation?.const === "request",
	);
	const contextPreparationSchema = requestSchema?.properties?.contextPreparation as unknown as {
		properties?: Record<string, { anyOf?: Array<{ const?: unknown }> }>;
		required?: string[];
	};
	assert.deepEqual(contextPreparationSchema.required?.slice().sort(), [
		"contextDependence",
		"workScale",
	]);
	assert.deepEqual(
		contextPreparationSchema.properties?.workScale?.anyOf?.map(({ const: value }) => value),
		["small", "medium", "large"],
	);
	assert.deepEqual(
		contextPreparationSchema.properties?.contextDependence?.anyOf
			?.map(({ const: value }) => value),
		["low", "medium", "high"],
	);
	const cancelSchema = parameters.anyOf?.find(
		(candidate) => candidate.properties?.operation?.const === "cancel",
	);
	assert.deepEqual(Object.keys(cancelSchema?.properties ?? {}).sort(), [
		"operation",
		"reason",
		"requestMessageId",
	]);
	const longContent = "Direction ".repeat(200).trim();
	const receiverAgentId = host.session.sessionId;
	const args = {
		operation: "send" as const,
		targetAgent: receiverAgentId,
		content: longContent,
		deliveryMode: "steer" as const,
	};
	const renderContext = {
		args,
		toolCallId: "render-message",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: host.cwd,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		executionStarted: true,
	};
	const callText = tool.renderCall(args, plainTheme, renderContext).render(160).join("\n");
	assert.match(callText, new RegExp(`Owner · ${receiverAgentId.slice(-8)}`));
	assert.doesNotMatch(callText, new RegExp(receiverAgentId));
	assert.match(callText, /steer/);
	assert.equal(callText.includes(longContent), false);
	assert.match(callText, /…/);

	const messageId = "source-derived-message-identity";
	const resultText = tool.renderResult(
		{
			content: [{ type: "text", text: "scheduling receipt" }],
			details: { messageId, messageStatus: "sent" },
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(resultText, /sent/);
	assert.match(resultText, new RegExp(messageId.slice(-8)));

	const deferredText = tool.renderCall(
		{
			operation: "send",
			targetAgent: "recipient-agent",
			content: "Routine direction.",
		},
		plainTheme,
		{ ...renderContext, args: {
			operation: "send",
			targetAgent: "recipient-agent",
			content: "Routine direction.",
		} },
	).render(160).join("\n");
	assert.equal(deferredText.includes("deferred"), false);

	const requestText = tool.renderCall(
		{
			title: "Fixture request",
			operation: "request",
			targetAgent: receiverAgentId,
			question: "Which boundary owns this result?",
		},
		plainTheme,
		{ ...renderContext, args: {
			title: "Fixture request",
			operation: "request",
			targetAgent: receiverAgentId,
			question: "Which boundary owns this result?",
		} },
	).render(160).join("\n");
	assert.match(requestText, new RegExp(`Owner · ${receiverAgentId.slice(-8)}`));

	const answerText = tool.renderCall(
		{
			operation: "answer", requestId: "request-reference",
			answer: "One canonical Answer.",
		},
		plainTheme,
		{ ...renderContext, args: {
			operation: "answer", requestId: "request-reference",
			answer: "One canonical Answer.",
		} },
	).render(160).join("\n");
	assert.match(answerText, /One canonical Answer/);

	const cancellationText = tool.renderCall(
		{
			operation: "cancel",
			requestMessageId: "request-message-identity",
			reason: "The result is no longer needed.",
		},
		plainTheme,
		{ ...renderContext, args: {
			operation: "cancel",
			requestMessageId: "request-message-identity",
			reason: "The result is no longer needed.",
		} },
	).render(160).join("\n");
	assert.match(cancellationText, /identity/);

	const existingCancellationText = tool.renderResult(
		{
			content: [{ type: "text", text: "already cancelled" }],
			details: {
				disposition: "already_cancelled",
				cancellationMessageId: "cancellation-message-identity",
			},
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(existingCancellationText, /identity/);

	const answerRequiredText = tool.renderResult(
		{
			content: [{ type: "text", text: "Answer required" }],
			details: {
				disposition: "rejected",
				reason: "answer_required",
				requestMessageId: "active-request-identity",
			},
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(answerRequiredText, /rejected/);
	assert.match(answerRequiredText, /answer_required/);
	assert.match(answerRequiredText, /identity/);

	const retrievalText = tool.renderResult(
		{
			content: [{ type: "text", text: "retrieved Answer" }],
			details: {
				requestTitle: "Fixture request",
				disposition: "answer_delivered",
				requestMessageId: "request-identity",
				answerId: "answer-identity",
				fromAgentId: "responder-agent",
				answer: "Recovered immutable Answer.",
				answerSource: {
					agentId: "responder-agent",
					entryId: "answer-entry",
					toolCallId: "answer-call",
				},
			},
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(retrievalText, /answer_delivered/);
	assert.match(retrievalText, /answer · identity/);
	assert.match(retrievalText, /Recovered immutable Answer/);

	await host.runtime.dispose();
});

test("native Agent Spawn rendering exposes verified runtime configuration only in resolved receipts", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination);
	const tool = host.session.getToolDefinition("agent_spawn");
	assert.ok(tool?.renderCall);
	assert.ok(tool.renderResult);
	const args = {
		title: "Fixture request",
		request: "Investigate the configured repository.",
		template: "research-agent",
		label: "Researcher",
		description: "Primary-source investigation",
		config: {
			cwd: "subproject",
			model: { id: "inherit", thinking: "high" as const },
		},
	};
	const renderContext = {
		args,
		toolCallId: "render-spawn",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: host.cwd,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		executionStarted: true,
	};
	assert.doesNotThrow(() =>
		tool.renderCall!(
			{},
			plainTheme,
			{
				...renderContext,
				args: {},
				argsComplete: false,
				executionStarted: false,
			},
		).render(160)
	);

	const callText = tool.renderCall(args, plainTheme, renderContext).render(160).join("\n");
	assert.match(callText, /Researcher/);
	assert.match(callText, /Primary-source investigation/);
	assert.match(callText, /Investigate the configured repository/);

	const multilineArgs = {
		...args,
		request: [
			"First request line.",
			...Array.from(
				{ length: 9 },
				(_, index) => `Middle request line ${index + 2}.`,
			),
			"Final request line.",
		].join("\n"),
	};
	const collapsedRequestText = tool.renderCall(
		multilineArgs,
		plainTheme,
		{ ...renderContext, args: multilineArgs },
	).render(60).join("\n");
	assert.match(collapsedRequestText, /\[Request\]/);
	assert.match(collapsedRequestText, /First request line/);
	assert.match(collapsedRequestText, /…/);
	assert.doesNotMatch(collapsedRequestText, /Final request line/);
	const expandedRequestText = tool.renderCall(
		multilineArgs,
		plainTheme,
		{ ...renderContext, args: multilineArgs, expanded: true },
	).render(60).join("\n");
	assert.match(expandedRequestText, /\[Request\]/);
	assert.match(expandedRequestText, /Final request line/);
	assert.doesNotMatch(expandedRequestText, /…/);

	const effectiveConfiguration = {
		cwd: "/work/subproject",
		model: { provider: "provider", modelId: "model" },
		thinking: "high" as const,
		tools: ["read", "agent_message"],
		skills: ["research"],
		extensions: ["/extensions/research.ts"],
		systemPrompt: { mode: "append" as const, body: "Configured context" },
		loadContextFiles: true,
	};
	const receipt = {
		spawnStatus: "created" as const,
		agentId: "agent-identity-1234567890",
		requestMessageId: "request-identity",
		messageStatus: "sent" as const,
		effectiveConfiguration,
	};
	const collapsedText = tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt },
		{ expanded: false, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(collapsedText, /created/);
	assert.match(collapsedText, /sent/);
	assert.match(collapsedText, /Researcher · 34567890/);
	assert.doesNotMatch(collapsedText, new RegExp(receipt.agentId));
	assert.match(collapsedText, /provider\/model/);
	assert.match(collapsedText, /high/);
	assert.equal(collapsedText.includes(effectiveConfiguration.cwd), false);

	const expandedText = tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt },
		{ expanded: true, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(expandedText, /\/work\/subproject/);
	assert.match(expandedText, new RegExp(`Researcher · ${receipt.agentId}`));
	assert.match(expandedText, /agent_message/);
	assert.match(expandedText, /Configured context/);

	const partialText = tool.renderResult(
		{ content: [{ type: "text", text: "starting" }], details: undefined },
		{ expanded: false, isPartial: true },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.equal(partialText.includes("provider/model"), false);

	await host.runtime.dispose();
});
