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
	MouseRegion,
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

interface DeliveryExpansionState {
	expanded: boolean;
	projections: Map<number, boolean>;
}

export function registerMessageDeliveryRenderer(
	pi: ExtensionAPI,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): void {
	// Pi rebuilds custom components on invalidation; retain clicks for the same
	// message without keeping discarded transcript messages alive.
	const states = new WeakMap<object, DeliveryExpansionState>();
	pi.registerMessageRenderer(
		MESSAGE_DELIVERY_CUSTOM_TYPE,
		(message, options, theme) => {
			let state = states.get(message);
			if (!state || state.expanded !== options.expanded) {
				// A global keyboard toggle supersedes individual click overrides.
				state = { expanded: options.expanded, projections: new Map() };
				states.set(message, state);
			}
			return renderMessageDelivery(message, options, theme, resolveAgentLabel, state);
		},
	);
}

export function renderMessageDelivery(
	message: Readonly<{ content: unknown }>,
	options: MessageRenderOptions,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
	state: DeliveryExpansionState = { expanded: options.expanded, projections: new Map() },
): Component {
	const projections = parseMessageDeliveryContent(message.content);
	const box = new Box(
		options.outputPad,
		1,
		(content) => theme.bg("customMessageBg", content),
	);

	for (const [index, projection] of projections.entries()) {
		if (index > 0) box.addChild(new Spacer(1));
		const content = new Container();
		const isExpanded = () => state.projections.get(index) ?? state.expanded;
		const rebuild = () => {
			content.clear();
			content.addChild(renderMessageProjection(
				projection, { expanded: isExpanded() }, theme, resolveAgentLabel,
			));
		};
		rebuild();
		box.addChild(new MouseRegion(content, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			state.projections.set(index, !isExpanded());
			rebuild();
			return { handled: true };
		}));
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
