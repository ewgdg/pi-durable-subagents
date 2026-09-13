import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import { renderMessageProjection } from "../src/tools/message-delivery-renderer.ts";
import { renderAgentMessageCall, renderAgentMessageResult } from "../src/tools/message-renderer.ts";
import { renderAgentSpawnCall } from "../src/tools/spawn-renderer.ts";
import { renderAgentWaitResult } from "../src/tools/coordination-renderers.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const options = { expanded: false, isPartial: false };
const requestTitle = "Confirm checkpoint storage constants";
const answer = {
	disposition: "answer_delivered" as const,
	requestMessageId: "request-constants",
	requestTitle,
	answerId: "answer-constants",
	fromAgentId: "storage-agent",
	answer: "Use RECORD_FILE_PREFIX and LOCK_FILE_NAME.",
	answerSource: { agentId: "storage-agent", entryId: "answer-entry", toolCallId: "answer-call" },
};

test("Request and Creation Request calls identify work by the sender-authored title", () => {
	initTheme("dark");
	const request = renderAgentMessageCall({
		operation: "request", targetAgent: "storage-agent", title: requestTitle,
		question: "Which constants should the observation module import?",
	}, theme).render(160).join("\n");
	const spawn = renderAgentSpawnCall({
		title: requestTitle, request: "Inspect the storage contract.", label: "Storage",
	}, theme).render(160).join("\n");
	assert.match(request, /\[Request\].*Confirm checkpoint storage constants/);
	assert.match(spawn, /\[Request\].*Confirm checkpoint storage constants/);
});

test("direct Request and Answer delivery display the originating Request title", () => {
	initTheme("dark");
	for (const projection of [
		{ kind: "request" as const, requestMessageId: answer.requestMessageId,
			fromAgentId: "observation-agent", title: requestTitle, question: "Which constants should I import?" },
		{ kind: "answer" as const, ...answer },
	]) {
		const rendered = renderMessageProjection(projection, options, theme).render(160).join("\n");
		assert.match(rendered.split("\n")[0], /Confirm checkpoint storage constants/);
	}
});

test("Wait progress and both Answer outcomes retain the Request title", () => {
	initTheme("dark");
	const context = { state: {} };
	const progress = renderAgentWaitResult({
		content: [], details: { waitingFor: [{
			requestMessageId: answer.requestMessageId, responderAgentId: answer.fromAgentId, requestTitle,
		}] },
	}, { ...options, isPartial: true }, theme, context).render(160).join("\n");
	assert.match(progress, /Confirm checkpoint storage constants/);
	for (const entry of [answer, {
		disposition: "answer_already_delivered" as const,
		requestMessageId: answer.requestMessageId, requestTitle, answerId: answer.answerId,
		deliveryEvidence: { agentId: "observation-agent", entryId: "delivered-answer" },
	}]) {
		const rendered = renderAgentWaitResult({ content: [], details: { answers: [entry] } },
			options, theme, context).render(160).join("\n");
		assert.match(rendered, /Confirm checkpoint storage constants/);
	}
});

test("Answer author receipt and retry retrieval identify the originating Request", () => {
	initTheme("dark");
	for (const details of [answer, {
		messageId: answer.answerId, requestMessageId: answer.requestMessageId,
		requestTitle, messageStatus: "sent" as const,
	}]) {
		const rendered = renderAgentMessageResult({ content: [], details }, options, theme)
			.render(160).join("\n");
		assert.match(rendered, /Confirm checkpoint storage constants/);
	}
});
