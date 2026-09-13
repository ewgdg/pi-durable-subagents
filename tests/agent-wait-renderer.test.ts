import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import {
	renderAgentWaitCall,
	renderAgentWaitResult,
} from "../src/tools/coordination-renderers.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const labels = new Map([
	["research-agent", "Researcher"],
	["review-agent", "Reviewer"],
]);
const resolveAgentLabel = (agentId: string) => labels.get(agentId);

function renderContext() {
	return {
		args: {},
		toolCallId: "render-agent-wait",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		executionStarted: true,
	};
}

test("selected Wait shows the requested references in its call", () => {
	const call = renderAgentWaitCall({ requestMessageIds: ["abc123", "def456"] }, plainTheme).render(120).join("\n");
	assert.match(call, /abc123/);
	assert.match(call, /def456/);
});

test("Agent Wait rendering shows snapshot responders, then their Answers", () => {
	const context = renderContext();
	const call = renderAgentWaitCall({}, plainTheme).render(120).join("\n");
	assert.equal(call.trim(), "wait");

	const progress = {
		waitingFor: [
			{ requestTitle: "Fixture request", requestMessageId: "request-research", responderAgentId: "research-agent" },
			{ requestTitle: "Fixture request", requestMessageId: "request-review", responderAgentId: "review-agent" },
		],
	};
	const waiting = renderAgentWaitResult(
		{ content: [{ type: "text", text: "waiting" }], details: progress },
		{ expanded: false, isPartial: true },
		plainTheme,
		context,
		resolveAgentLabel,
	).render(120).join("\n");
	assert.equal(
		waiting.split("\n").map((line) => line.trimEnd()).join("\n"),
		[
			"waiting for 2 Answers…",
			"• Fixture request · Researcher · ch-agent",
			"• Fixture request · Reviewer · ew-agent",
		].join("\n"),
	);
	assert.doesNotMatch(waiting, /request-research/);

	const answers = {
		answers: [
			{
				requestTitle: "Fixture request",
				disposition: "answer_delivered" as const,
				requestMessageId: "request-research",
				answerId: "answer-research",
				fromAgentId: "research-agent",
				answer: "The implementation is viable.",
				answerSource: {
					agentId: "research-agent",
					entryId: "answer-entry-research",
					toolCallId: "answer-call-research",
				},
			},
			{
				requestTitle: "Fixture request",
				disposition: "answer_delivered" as const,
				requestMessageId: "request-review",
				answerId: "answer-review",
				fromAgentId: "review-agent",
				answer: "The race handling is sound.",
				answerSource: {
					agentId: "review-agent",
					entryId: "answer-entry-review",
					toolCallId: "answer-call-review",
				},
			},
		],
	};
	const completed = renderAgentWaitResult(
		{ content: [{ type: "text", text: JSON.stringify(answers) }], details: answers },
		{ expanded: false, isPartial: false },
		plainTheme,
		context,
		resolveAgentLabel,
	).render(120).join("\n");
	assert.match(completed, /2 Answers/);
	assert.match(
		completed,
		/\[Answer\] Fixture request from Researcher · ch-agent\s*\nThe implementation is viable\./,
	);
	assert.match(
		completed,
		/\[Answer\] Fixture request from Reviewer · ew-agent\s*\nThe race handling is sound\./,
	);
	assert.doesNotMatch(
		completed,
		/Researcher · ch-agent[^\n]*The implementation is viable\./,
	);
	assert.doesNotMatch(completed, /answerSource/);
});
