import type {
	AgentToolResult,
	Theme,
	ThemeColor,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";

import type {
	AgentSpawnInput,
	AgentSpawnReceipt,
} from "../coordination/workflow-coordinator.ts";
import { formatKnownAgentIdentity } from "../presentation/agent-identity.ts";
import { boundedToolPreview } from "./bounded-preview.ts";
import { renderAgentMessageBody } from "./message-renderer.ts";

export function renderAgentSpawnCall(
	args: AgentSpawnInput,
	theme: Theme,
	expanded = false,
): Component {
	const label = spawnLabel(args);
	let header = theme.fg("toolTitle", theme.bold("spawn "));
	header += theme.fg("accent", label);
	if (args.description !== undefined) {
		header += theme.fg("dim", ` · ${boundedToolPreview(args.description)}`);
	}
	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(
		theme.fg("customMessageLabel", theme.bold("[Request]")) +
			(typeof args.title === "string" ? theme.fg("customMessageLabel", ` ${boundedToolPreview(args.title)}`) : ""),
		0,
		0,
	));
	// Pi renders tool calls while their JSON arguments are still streaming.
	// Add the body only after the required request string has arrived.
	if (typeof args.request === "string") {
		container.addChild(renderAgentMessageBody(args.request, theme, expanded));
	}
	return container;
}

export function renderAgentSpawnResult(
	result: AgentToolResult<AgentSpawnReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: Readonly<{ args: AgentSpawnInput }>,
): Text {
	if (options.isPartial || result.details === undefined) {
		return new Text(theme.fg("warning", "resolving configuration…"), 0, 0);
	}
	const receipt = result.details;
	let text = theme.fg(spawnStatusColor(receipt.spawnStatus), receipt.spawnStatus);
	if ("messageStatus" in receipt) {
		text += theme.fg(
			receipt.messageStatus === "sent" ? "success" : "warning",
			` · ${receipt.messageStatus}`,
		);
	}
	const agentId = "agentId" in receipt
		? receipt.agentId
		: "candidateAgentId" in receipt
			? receipt.candidateAgentId
			: undefined;
	if (agentId !== undefined) {
		text += theme.fg(
			"dim",
			` · ${formatKnownAgentIdentity(
				agentId,
				spawnLabel(context.args),
				options.expanded ? "full" : "compact",
			)}`,
		);
	}
	const configuration = "effectiveConfiguration" in receipt
		? receipt.effectiveConfiguration
		: undefined;
	if (configuration) {
		text += theme.fg(
			"dim",
			` · ${configuration.model.provider}/${configuration.model.modelId} · ${configuration.thinking}`,
		);
	}
	if ("failedStage" in receipt) {
		text += theme.fg("warning", ` · ${receipt.failedStage}`);
	}
	if ("reason" in receipt) {
		text += theme.fg("warning", ` · ${boundedToolPreview(receipt.reason)}`);
	}
	if (options.expanded) {
		text += theme.fg("dim", `\n${JSON.stringify(receipt, null, 2)}`);
	}
	return new Text(text, 0, 0);
}

function spawnLabel(args: AgentSpawnInput): string {
	return args.label ?? args.template ?? "agent";
}

function spawnStatusColor(status: AgentSpawnReceipt["spawnStatus"]): ThemeColor {
	switch (status) {
		case "created":
			return "success";
		case "not_created":
			return "error";
		case "unknown":
			return "warning";
	}
}
