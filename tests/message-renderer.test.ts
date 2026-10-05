import assert from "node:assert/strict";
import test from "node:test";

import {
	initTheme,
	type AgentToolResult,
	type Theme,
} from "@earendil-works/pi-coding-agent";

import type { AgentMessageReceipt } from "../src/coordination/message-receipts.ts";
import type { AgentMessageInput } from "../src/protocol/agent-message-input.ts";
import {
	renderAgentMessageCall,
	renderAgentMessageResult,
} from "../src/tools/message-renderer.ts";
import { renderAgentSpawnCall } from "../src/tools/spawn-renderer.ts";
import { renderMessageProjection } from "../src/tools/message-delivery-renderer.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const targetAgentId = "019fa1ff-6e95-761e-b4ce-7415983c81e3";
const targetAgent = targetAgentId;
const resolveLabel = (agentId: string) =>
	agentId === targetAgentId ? "Researcher" : undefined;

function renderCall(args: AgentMessageInput, width = 60): string {
	initTheme("dark");
	return renderAgentMessageCall(args, plainTheme, resolveLabel)
		.render(width)
		.join("\n");
}

function renderResult(
	receipt: AgentMessageReceipt,
	expanded: boolean,
	width = 60,
): string {
	initTheme("dark");
	const result: AgentToolResult<AgentMessageReceipt> = {
		content: [],
		details: receipt,
	};
	return renderAgentMessageResult(result, { expanded, isPartial: false }, plainTheme)
		.render(width)
		.join("\n");
}

test("locally committed Answer reports omitted Delivery without claiming send or failure", () => {
	const rendered = renderResult({
		disposition: "committed", delivery: "omitted", reason: "request_source_unavailable",
		messageId: "local-answer", requestMessageId: "missing-request", requestTitle: "Preserved work",
	}, false, 100);
	assert.match(rendered, /committed · delivery omitted · Preserved work/);
	assert.match(rendered, /request_source_unavailable/);
	assert.doesNotMatch(rendered, /not_sent|unknown|delivered/);
});

test("send call shows the [Send] badge, compact target identity, and bounded content preview", () => {
	const rendered = renderCall({
		operation: "send",
		targetAgent,
		content: "Context ".repeat(100) + "Distinctive ending.",
	});
	assert.match(rendered, /\[Send\]/);
	assert.match(rendered, /to Researcher · 983c81e3/);
	assert.doesNotMatch(rendered, new RegExp(targetAgentId));
	assert.doesNotMatch(rendered, /\{"messages"/);
	assert.match(rendered, /Context/);
	assert.match(rendered, /…/);
	assert.doesNotMatch(rendered, /Distinctive ending/);
});

test("collapsed send call preserves formatting within ten visible body rows", () => {
	const rendered = renderCall({
		operation: "send",
		targetAgent,
		content: "First line.\n\nThird line.",
	});
	assert.match(rendered, /First line\.\n\nThird line\.$/);
	assert.doesNotMatch(rendered, /…/);
});

test("send call marks steer delivery", () => {
	const rendered = renderCall({
		operation: "send",
		targetAgent,
		content: "Act now.",
		deliveryMode: "steer",
	});
	assert.match(rendered, /\[Send\]/);
	assert.match(rendered, /steer/);
	assert.match(rendered, /Act now\./);
});

test("request call shows the [Request] badge and question preview", () => {
	const rendered = renderCall({
		title: "Fixture request",
		operation: "request",
		targetAgent,
		question: "Please review the design proposal.",
	});
	assert.match(rendered, /\[Request\]/);
	assert.match(rendered, /to Researcher · 983c81e3/);
	assert.match(rendered, /review the design proposal/);
	assert.doesNotMatch(rendered, /\[Send\]/);
});

test("request call marks steer delivery", () => {
	const rendered = renderCall({
		title: "Fixture request",
		operation: "request",
		targetAgent,
		question: "Please proceed immediately.",
		deliveryMode: "steer",
	});
	assert.match(rendered, /\[Request\]/);
	assert.match(rendered, /steer/);
	assert.match(rendered, /proceed immediately/);
});

test("expanded call shows the complete payload and identifies the target fully", () => {
	initTheme("dark");
	const body = "Context ".repeat(30) + "Distinctive ending.";
	const rendered = renderAgentMessageCall(
		{ operation: "send", targetAgent, content: body },
		plainTheme,
		resolveLabel,
		true,
	).render(60).join("\n");
	assert.match(rendered, /\[Send\]/);
	assert.match(rendered, /Distinctive ending/);
	assert.doesNotMatch(rendered, /…/);
	// Expansion disambiguates identities: compact collapsed, full expanded.
	assert.match(rendered, new RegExp(`to Researcher · ${targetAgentId}`));
});

test("answer and cancel calls show their own badges with payload and correlation", () => {
	initTheme("dark");
	const answer = renderAgentMessageCall(
		{
			operation: "answer", requestId: "request-reference",
			answer: "The answer is accepted.",
		},
		plainTheme,
		resolveLabel,
		false,
		targetAgentId,
	).render(60).join("\n");
	assert.match(answer, /\[Answer\]/);
	assert.match(answer, /to Researcher · 983c81e3/);
	assert.match(answer, /answer is accepted/);

	const cancel = renderCall({
		operation: "cancel",
		requestMessageId: "request-nine",
		reason: "No longer needed.",
	});
	assert.match(cancel, /\[Cancel\]/);
	assert.match(cancel, /est-nine/);
	assert.match(cancel, /No longer needed/);
});

test("a coordination badge hugs its body so blank rows only mark item boundaries", () => {
	initTheme("dark");
	const spawn = renderAgentSpawnCall(
		{ title: "Fixture request", request: "Spawn body.", label: "Fixture" },
		plainTheme,
	).render(60).join("\n");
	const cases: ReadonlyArray<readonly [string, string, string]> = [
		["[Send]", "Send body.", renderCall({ operation: "send", targetAgent, content: "Send body." })],
		["[Request]", "Request body.", renderCall({
			operation: "request", targetAgent, title: "Fixture request", question: "Request body.",
		})],
		["[Answer]", "Answer body.", renderAgentMessageCall(
			{ operation: "answer", requestId: "request-one", answer: "Answer body." },
			plainTheme,
			resolveLabel,
		).render(60).join("\n")],
		["[Cancel]", "Cancel body.", renderCall({
			operation: "cancel", requestMessageId: "request-one", reason: "Cancel body.",
		})],
		["[Request]", "Spawn body.", spawn],
		// Expanding changes the body renderer, never the block's spacing.
		["[Send]", "Send body.", renderAgentMessageCall(
			{ operation: "send", targetAgent, content: "Send body." },
			plainTheme,
			resolveLabel,
			true,
		).render(60).join("\n")],
		// Bodies arrive with framing whitespace; neither mode may render it.
		["[Send]", "Send body.", renderCall({ operation: "send", targetAgent, content: "\n\nSend body.\n\n" })],
		["[Send]", "Send body.", renderAgentMessageCall(
			{ operation: "send", targetAgent, content: "\r\nSend body.\r\n" },
			plainTheme,
			resolveLabel,
			true,
		).render(60).join("\n")],
	];
	for (const [badge, body, rendered] of cases) {
		const lines = rendered.split("\n");
		const header = lines.findIndex((line) => line.includes(badge));
		assert.notEqual(header, -1, `${badge} header must render`);
		assert.ok(lines[header + 1]?.includes(body), `${badge} body must start on its badge's next row: ${rendered}`);
	}
	// The spawn summary and the Creation Request it created are separate items.
	assert.deepEqual(
		spawn.split("\n").map((line) => line.trim()),
		[
			"spawn Fixture",
			"",
			"[Request] Fixture request",
			"Spawn body.",
		],
	);
});

test("a Request reads the same whether sent or delivered", () => {
	initTheme("dark");
	const question = "Which constants should I import?";
	const projection = {
		kind: "request" as const,
		requestMessageId: "request-one",
		fromAgentId: targetAgent,
		title: "Fixture request",
		question,
	};
	for (const expanded of [false, true]) {
		const sent = renderAgentMessageCall(
			{ operation: "request", targetAgent, title: "Fixture request", question },
			plainTheme,
			resolveLabel,
			expanded,
		).render(60).map((line) => line.trim());
		const delivered = renderMessageProjection(projection, { expanded }, plainTheme, resolveLabel)
			.render(60).map((line) => line.trim());
		const bodyStart = (lines: readonly string[]) => lines.findIndex((line) => line.includes(question));
		const sentStart = bodyStart(sent);
		const deliveredStart = bodyStart(delivered);
		// Neither frame may open a gap between its header and the body it introduces,
		// and both must show the same body rows for the same payload.
		assert.notEqual(sent[sentStart - 1], "", `expanded: ${expanded}`);
		assert.notEqual(delivered[deliveredStart - 1], "", `expanded: ${expanded}`);
		assert.deepEqual(sent.slice(sentStart), delivered.slice(deliveredStart), `expanded: ${expanded}`);
		// Identities use the same compact-collapsed, full-expanded detail either way.
		const identity = `Researcher · ${expanded ? targetAgentId : "983c81e3"}`;
		const headerText = (lines: readonly string[], bodyStart: number) => lines.slice(0, bodyStart).join(" ");
		assert.ok(headerText(sent, sentStart).includes(` to ${identity}`), `expanded: ${expanded}`);
		assert.ok(headerText(delivered, deliveredStart).includes(` from ${identity}`), `expanded: ${expanded}`);
	}
});

test("poll and retry calls show their badges and message id without a body preview", () => {
	for (const operation of ["poll", "retry"] as const) {
		const rendered = renderCall({
			operation,
			messageId: "message-three",
		});
		assert.match(rendered, new RegExp(`\\[${operation === "poll" ? "Poll" : "Retry"}\\]`));
		assert.match(rendered, /ge-three/);
		assert.equal(
			rendered.split("\n").filter((line) => line.trim().length > 0).length,
			1,
		);
	}
});

test("collapsed result shows disposition and ids without exposing the receipt", () => {
	const rendered = renderResult({
		disposition: "delivered",
		messageId: "message-one",
		deliveryEvidence: { agentId: "observer-agent", entryId: "entry-7" },
	}, false);
	assert.match(rendered, /delivered/);
	assert.match(rendered, /sage-one/);
	assert.doesNotMatch(rendered, /deliveryEvidence|entry-7/);
});

test("expanded result exposes the complete structured receipt", () => {
	const rendered = renderResult({
		disposition: "delivered",
		messageId: "message-one",
		deliveryEvidence: { agentId: "observer-agent", entryId: "entry-7" },
	}, true);
	assert.match(rendered, /"disposition": "delivered"/);
	assert.match(rendered, /"deliveryEvidence"/);
	assert.match(rendered, /"entry-7"/);
});

test("answer_delivered result shows the shared bounded answer preview with truncation", () => {
	const answer = "The complete answer body ".repeat(20) + "Distinctive tail.";
	const rendered = renderResult({
		requestTitle: "Fixture request",
		disposition: "answer_delivered",
		requestMessageId: "request-one",
		answerId: "answer-one",
		fromAgentId: "responder-agent",
		answer,
		answerSource: {
			agentId: "responder-agent",
			entryId: "entry-2",
			toolCallId: "call-2",
		},
	}, false, 30);
	assert.match(rendered, /answer_delivered/);
	assert.match(rendered, /answer · swer-one/);
	assert.match(rendered, /complete answer body/);
	assert.match(rendered, /…/);
	assert.doesNotMatch(rendered, /Distinctive tail/);
});

test("not_sent result surfaces the rejection reason", () => {
	const rendered = renderResult({
		messageStatus: "not_sent",
		reason: "target_unavailable",
		messageId: "message-two",
		targetAgentId,
	}, false);
	assert.match(rendered, /not_sent/);
	assert.match(rendered, /target_unavailable/);
});

test("badges and reason lines use the delivered-message theme roles", () => {
	initTheme("dark");
	const calls: Array<[string, string]> = [];
	const recordingTheme = {
		fg: (color: string, text: string) => {
			calls.push([color, text]);
			return text;
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	renderAgentMessageCall(
		{ operation: "send", targetAgent, content: "Act now." },
		recordingTheme,
		resolveLabel,
	).render(60);
	assert.ok(
		calls.some(([color, text]) => color === "customMessageLabel" && text === "[Send]"),
		"send badge must use the customMessageLabel role",
	);

	calls.length = 0;
	renderAgentMessageResult(
		{
			content: [],
			details: {
				messageStatus: "not_sent",
				reason: "target_unavailable",
				messageId: "message-two",
				targetAgentId,
			},
		},
		{ expanded: false, isPartial: false },
		recordingTheme,
	).render(60);
	assert.ok(
		calls.some(([color, text]) => color === "error" && text === "target_unavailable"),
		"not_sent reason must use the error role",
	);

	calls.length = 0;
	renderAgentMessageResult(
		{
			content: [],
			details: {
				messageStatus: "unknown",
				reason: "confirmation_lost",
				messageId: "message-three",
				targetAgentId,
			},
		},
		{ expanded: false, isPartial: false },
		recordingTheme,
	).render(60);
	assert.ok(
		calls.some(([color, text]) => color === "warning" && text === "confirmation_lost"),
		"unknown reason must use the warning role",
	);
});

test("Message results show a suffix collapsed and retain the full ID on expansion", () => {
	const messageId = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
	const receipt = { messageId, targetAgentId, messageStatus: "sent" as const };
	const collapsed = renderResult(receipt, false, 120);
	assert.ok(collapsed.includes(messageId.slice(-8)));
	assert.ok(!collapsed.includes(messageId));
	assert.ok(renderResult(receipt, true, 120).includes(messageId));
});

for (const expanded of [false, true]) test(`Answer uses the ordinary messaging receipt (expanded: ${expanded})`, () => {
	const receipt = {
		requestTitle: "Fixture request",
		messageId: "answer", requestMessageId: "request", messageStatus: "sent",
	} as const;
	const rendered = renderAgentMessageResult({ content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }],
		details: receipt }, { expanded, isPartial: false }, plainTheme).render(100).join("\n");
	assert.equal(rendered.split("\n")[0]?.trimEnd(), "sent · Fixture request · answer");
	assert.equal(rendered.includes('"requestMessageId"'), expanded);
});
