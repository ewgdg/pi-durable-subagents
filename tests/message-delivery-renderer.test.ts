import assert from "node:assert/strict";
import test from "node:test";

import {
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import {
	MESSAGE_DELIVERY_CUSTOM_TYPE,
	type ModelVisibleMessage,
} from "../src/protocol/message-delivery.ts";
import { renderMessageDelivery } from "../src/tools/message-delivery-renderer.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("collapsed Message Delivery shows type, sender label, compact identity, and a ten-line body snippet", () => {
	initTheme("dark");
	const senderAgentId = "019fa1ff-6e95-761e-b4ce-7415983c81e3";
	const fullBody = [
		"Context ".repeat(10),
		"second-line evidence. ",
		"More detail. ".repeat(60),
		"Distinctive ending.",
	].join("");
	const rendered = renderMessageDelivery(
		customDelivery([{
			kind: "message",
			messageId: "message-one",
			fromAgentId: senderAgentId,
			content: fullBody,
		}]),
		{ expanded: false, outputPad: 1 },
		plainTheme,
		(agentId) => agentId === senderAgentId ? "Researcher" : undefined,
	).render(60).join("\n");

	assert.match(rendered, /Message/);
	assert.match(rendered, /from Researcher · 983c81e3/);
	assert.doesNotMatch(rendered, new RegExp(senderAgentId));
	assert.match(rendered, /second-line evidence/);
	assert.match(rendered, /…/);
	assert.doesNotMatch(rendered, /Distinctive ending/);
	assert.doesNotMatch(rendered, /\{"messages"/);
	assert.equal(
		rendered.split("\n").filter((line) => line.trim().length > 0).length,
		12,
	);
});

test("collapsed Message Delivery puts a dim truncation hint after ten visible body rows", () => {
	initTheme("dark");
	const hintTheme = {
		...plainTheme,
		fg: (color: string, text: string) =>
			color === "dim" ? `\x1b[2m${text}\x1b[22m` : text,
	} as unknown as Theme;
	const rendered = renderMessageDelivery(
		customDelivery([{
			kind: "message",
			messageId: "message-one",
			fromAgentId: "sender-agent",
			content: Array.from(
				{ length: 11 },
				(_, index) => `Line ${index + 1}.`,
			).join("\n"),
		}]),
		{ expanded: false, outputPad: 1 },
		hintTheme,
	).render(60).join("\n");

	assert.match(rendered, /Line 1\./);
	assert.match(rendered, /Line 9\.\s*\n\s*Line 10\.\s*\n\s*\x1b\[2m…\x1b\[22m/);
	assert.doesNotMatch(rendered, /Line 11\./);
	assert.equal(
		rendered.split("\n").filter((line) => line.trim().length > 0).length,
		12,
	);
});

test("expanded Message Delivery shows each human-readable type and complete body", () => {
	initTheme("dark");
	const requesterAgentId = "019fa1ff-6e95-761e-b4ce-7415983c81e3";
	const projections: ModelVisibleMessage[] = [
		{
			title: "Fixture request",
			kind: "request",
			requestMessageId: "request-one",
			fromAgentId: requesterAgentId,
			question: "Review the complete request body, including this final clause.",
		},
		{
			requestTitle: "Fixture request",
			kind: "answer",
			answerId: "answer-one",
			requestMessageId: "request-one",
			fromAgentId: "responder-agent",
			answer: "The complete answer is available, including this final clause.",
		},
		{
			kind: "request_cancellation",
			cancellationId: "cancellation-one",
			requestMessageId: "request-two",
			fromAgentId: "cancelling-agent",
			reason: "The complete cancellation reason ends with this final clause.",
		},
	];
	const rendered = renderMessageDelivery(
		customDelivery(projections),
		{ expanded: true, outputPad: 1 },
		plainTheme,
		(agentId) => agentId === requesterAgentId ? "Requester" : undefined,
	).render(120).join("\n");

	assert.match(rendered, new RegExp(`Request.*from Requester · ${requesterAgentId}`, "s"));
	assert.match(rendered, /Answer.*from responder-agent/s);
	assert.match(rendered, /Request cancellation.*from cancelling-agent/s);
	assert.match(rendered, /complete request body, including this final clause/);
	assert.match(rendered, /complete answer is available, including this final clause/);
	assert.match(rendered, /complete cancellation reason ends with this final clause/);
	assert.doesNotMatch(rendered, /requestMessageId|fromAgentId|\{"messages"/);
});

test("Owner and participant extensions register the Message Delivery renderer", async (t) => {
	const unavailableView = () => {
		throw new Error("Renderer registration does not execute coordination behavior");
	};
	const ownerHost = await createTestOwnerHost(t, piAgentCoordination);
	const hosts = [
		ownerHost,
		await createTestOwnerHost(
			t,
			createAgentBoundExtension(
				unavailableView as () => OrdinaryAgentCoordinatorView,
			),
		),
	];
	const ownerRenderer = ownerHost.session.extensionRunner.getMessageRenderer(
		MESSAGE_DELIVERY_CUSTOM_TYPE,
	);
	if (!ownerRenderer) throw new Error("Owner Message Delivery renderer is unavailable");
	const ownerAgentId = ownerHost.session.sessionId;
	const ownerComponent = ownerRenderer(
		customDelivery([{
			kind: "message",
			messageId: "owner-message",
			fromAgentId: ownerAgentId,
			content: "Owner-authored direction.",
		}]),
		{ expanded: false, outputPad: 1 },
		plainTheme,
	);
	if (!ownerComponent) throw new Error("Owner Message Delivery did not render");
	const ownerDelivery = ownerComponent.render(80).join("\n");
	assert.match(ownerDelivery, new RegExp(`from Owner · ${ownerAgentId.slice(-8)}`));

	for (const host of hosts) {
		assert.equal(
			typeof host.session.extensionRunner.getMessageRenderer(
				MESSAGE_DELIVERY_CUSTOM_TYPE,
			),
			"function",
		);
		await host.runtime.dispose();
	}
});

function customDelivery(projections: readonly ModelVisibleMessage[]) {
	return {
		role: "custom" as const,
		customType: MESSAGE_DELIVERY_CUSTOM_TYPE,
		content: JSON.stringify({ messages: projections }),
		display: true,
		details: {
			messages: projections.map((_, index) => ({
				agentId: "sender-agent",
				entryId: `entry-${index}`,
				toolCallId: `call-${index}`,
			})),
		},
		timestamp: 0,
	};
}
