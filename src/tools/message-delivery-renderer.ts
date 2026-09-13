import {
	getMarkdownTheme,
	type ExtensionAPI,
	type MessageRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
	type Component,
} from "@earendil-works/pi-tui";

import {
	formatAgentIdentity,
	type AgentIdentityDetail,
	type AgentLabelResolver,
} from "../presentation/agent-identity.ts";
import { BodyPreview } from "../presentation/body-preview.ts";
import { boundedToolPreview } from "./bounded-preview.ts";
import {
	MESSAGE_DELIVERY_CUSTOM_TYPE,
	parseMessageDeliveryContent,
	type ModelVisibleMessage,
} from "../protocol/message-delivery.ts";

export function registerMessageDeliveryRenderer(
	pi: ExtensionAPI,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): void {
	pi.registerMessageRenderer(
		MESSAGE_DELIVERY_CUSTOM_TYPE,
		(message, options, theme) =>
			renderMessageDelivery(message, options, theme, resolveAgentLabel),
	);
}

export function renderMessageDelivery(
	message: Readonly<{ content: unknown }>,
	options: MessageRenderOptions,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Component {
	const projections = parseMessageDeliveryContent(message.content);
	const box = new Box(
		options.outputPad,
		1,
		(content) => theme.bg("customMessageBg", content),
	);

	for (const [index, projection] of projections.entries()) {
		if (index > 0) box.addChild(new Spacer(1));
		box.addChild(renderMessageProjection(
			projection,
			options,
			theme,
			resolveAgentLabel,
		));
	}

	return box;
}

export function renderMessageProjection(
	projection: ModelVisibleMessage,
	options: Pick<MessageRenderOptions, "expanded">,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Component {
	const container = new Container();
	container.addChild(new Text(
		renderHeader(
			projection,
			theme,
			resolveAgentLabel,
			options.expanded ? "full" : "compact",
		),
		0,
		0,
	));
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(
			messageBody(projection),
			0,
			0,
			getMarkdownTheme(),
			{ color: (content) => theme.fg("customMessageText", content) },
			{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
		));
	} else {
		container.addChild(new BodyPreview(
			messageBody(projection),
			(content) => theme.fg("customMessageText", content),
			(content) => theme.fg("dim", content),
		));
	}
	return container;
}

function renderHeader(
	projection: ModelVisibleMessage,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver,
	identityDetail: AgentIdentityDetail,
): string {
	const title = projection.kind === "request" ? projection.title
		: projection.kind === "answer" ? projection.requestTitle : undefined;
	return [
		theme.fg(
			"customMessageLabel",
			theme.bold(`[${messageTypeLabel(projection.kind)}]`),
		),
		title === undefined ? "" : theme.fg("customMessageLabel", ` ${boundedToolPreview(title)}`),
		theme.fg(
			"muted",
			` from ${formatAgentIdentity(
				projection.fromAgentId,
				resolveAgentLabel,
				identityDetail,
			)}`,
		),
	].join("");
}

function messageTypeLabel(kind: ModelVisibleMessage["kind"]): string {
	switch (kind) {
		case "message":
			return "Message";
		case "request":
			return "Request";
		case "answer":
			return "Answer";
		case "request_cancellation":
			return "Request cancellation";
	}
}

function messageBody(projection: ModelVisibleMessage): string {
	switch (projection.kind) {
		case "message":
			return projection.content;
		case "request":
			return projection.question;
		case "answer":
			return projection.answer;
		case "request_cancellation":
			return projection.reason;
	}
}
