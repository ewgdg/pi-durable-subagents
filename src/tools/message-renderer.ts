import { formatMessageIdentity } from "../presentation/message-identity.ts";
import type {
	AgentToolResult,
	Theme,
	ThemeColor,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";

import type {
	AgentMessageInput,
	AgentMessageReceipt,
} from "../coordination/workflow-coordinator.ts";
import {
	formatAgentIdentity,
	type AgentLabelResolver,
} from "../presentation/agent-identity.ts";
import { BodyPreview } from "../presentation/body-preview.ts";
import { boundedToolPreview } from "./bounded-preview.ts";

export function renderAgentMessageCall(
	args: AgentMessageInput,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
	expanded = false,
	answerTargetAgentId?: string,
): Component {
	return renderCoordinationBlock(
		renderMessageCallHeader(
			args,
			theme,
			resolveAgentLabel,
			answerTargetAgentId,
			expanded,
		),
		messageCallBody(args),
		theme,
		expanded,
	);
}

/**
 * Compose a coordination header with its optional body under one spacing policy:
 * every badge ([Send], [Request], [Answer], [Cancel], and a spawned Agent's
 * Creation Request block) starts its body after exactly one blank line.
 */
export function renderCoordinationBlock(
	header: string,
	body: string | undefined,
	theme: Theme,
	expanded = false,
): Component {
	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	if (body) {
		container.addChild(new Spacer(1));
		container.addChild(renderAgentMessageBody(body, theme, expanded));
	}
	return container;
}

/** Render tool-call coordination text with one collapsed/expanded body policy. */
function renderAgentMessageBody(
	body: string,
	theme: Theme,
	expanded = false,
): Component {
	if (expanded) {
		return new Markdown(
			body,
			0,
			0,
			getMarkdownTheme(),
			{ color: (content) => theme.fg("customMessageText", content) },
			{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
		);
	}
	return new BodyPreview(
		body,
		(content) => theme.fg("customMessageText", content),
		(content) => theme.fg("dim", content),
	);
}

function renderMessageCallHeader(
	args: AgentMessageInput,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver,
	answerTargetAgentId: string | undefined,
	expanded: boolean,
): string {
	// Badge and body reuse the delivered-message theme roles (customMessageLabel /
	// customMessageText) so sent and delivered coordination content speak one visual
	// language, even though the tool frame background differs from customMsgBg.
	let text = theme.fg(
		"customMessageLabel",
		theme.bold(`[${messageCallOperationLabel(args.operation)}]`),
	);
	// Tool-call arguments can still be streaming when Pi renders the header.
	if (args.operation === "request" && typeof args.title === "string") {
		text += theme.fg("customMessageLabel", ` ${boundedToolPreview(args.title)}`);
	}
	const targetAgentId = args.operation === "send" || args.operation === "request"
		? args.targetAgent
		: args.operation === "answer"
			? answerTargetAgentId
			: undefined;
	if (targetAgentId !== undefined) {
		text += theme.fg(
			"muted",
			` to ${formatAgentIdentity(targetAgentId, resolveAgentLabel)}`,
		);
		if (
			(args.operation === "send" || args.operation === "request") &&
			(args.deliveryMode === "steer" || args.deliveryMode === "background")
		) {
			text += theme.fg(args.deliveryMode === "steer" ? "warning" : "dim", ` · ${args.deliveryMode}`);
		}
	} else if (args.operation === "cancel") {
		text += theme.fg("dim", ` · ${formatMessageIdentity(args.requestMessageId, expanded)}`);
	} else if (args.operation === "poll" || args.operation === "retry") {
		text += theme.fg("dim", ` · ${formatMessageIdentity(args.messageId, expanded)}`);
	}
	return text;
}

function messageCallOperationLabel(operation: AgentMessageInput["operation"]): string {
	switch (operation) {
		case "send":
			return "Send";
		case "request":
			return "Request";
		case "answer":
			return "Answer";
		case "cancel":
			return "Cancel";
		case "poll":
			return "Poll";
		case "retry":
			return "Retry";
	}
}

function messageCallBody(args: AgentMessageInput): string | undefined {
	switch (args.operation) {
		case "send":
			return args.content;
		case "request":
			return args.question;
		case "answer":
			return args.answer;
		case "cancel":
			return args.reason;
		default:
			return undefined;
	}
}

export function renderAgentMessageResult(
	result: AgentToolResult<AgentMessageReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const container = new Container();
	if (options.isPartial) {
		container.addChild(new Text(theme.fg("warning", "scheduling…"), 0, 0));
		return container;
	}
	const receipt = result.details;
	const disposition = "messageStatus" in receipt
		? receipt.messageStatus
		: receipt.disposition;
	let text = theme.fg(messageReceiptStatusColor(disposition), disposition);
	if ("delivery" in receipt && receipt.delivery === "omitted") text += theme.fg("dim", " · delivery omitted");
	if ("requestTitle" in receipt) {
		text += theme.fg("customMessageLabel", ` · ${boundedToolPreview(receipt.requestTitle)}`);
	}
	if ("messageId" in receipt) {
		text += theme.fg("dim", ` · ${formatMessageIdentity(receipt.messageId, options.expanded)}`);
	} else if ("requestMessageId" in receipt) {
		text += theme.fg("dim", ` · ${formatMessageIdentity(receipt.requestMessageId, options.expanded)}`);
	} else if ("answerMessageId" in receipt) {
		text += theme.fg("dim", ` · ${formatMessageIdentity(receipt.answerMessageId, options.expanded)}`);
	} else {
		text += theme.fg("dim", ` · ${formatMessageIdentity(receipt.cancellationMessageId, options.expanded)}`);
	}
	container.addChild(new Text(text, 0, 0));
	if (
		!options.expanded &&
		"disposition" in receipt &&
		receipt.disposition === "answer_delivered"
	) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(
			theme.fg("dim", `answer · ${formatMessageIdentity(receipt.answerId, options.expanded)}`),
			0,
			0,
		));
		container.addChild(new BodyPreview(
			receipt.answer,
			(content) => theme.fg("customMessageText", content),
			(content) => theme.fg("dim", content),
		));
	}
	if (!options.expanded && "reason" in receipt) {
		container.addChild(new Text(
			theme.fg(
				"disposition" in receipt && receipt.disposition === "committed" ? "dim" :
				"messageStatus" in receipt && receipt.messageStatus === "not_sent"
					? "error"
					: "warning",
				receipt.reason,
			),
			0,
			0,
		));
	}
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(
			theme.fg("dim", JSON.stringify(receipt, null, 2)),
			0,
			0,
		));
	}
	return container;
}

export function messageReceiptStatusColor(disposition: string): ThemeColor {
	switch (disposition) {
		case "delivered":
		case "answer_delivered":
		case "answer_already_delivered":
		case "request_delivered":
		case "already_answered":
		case "already_cancelled":
		case "committed":
			return "success";
		case "rejected":
			return "error";
		case "sent":
			return "success";
		case "not_sent":
			return "error";
		case "unknown":
		case "indeterminate":
			return "warning";
		default:
			return "muted";
	}
}
