import {
	getMarkdownTheme,
	type AgentToolResult,
	type Theme,
	type ThemeColor,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
	type Component,
} from "@earendil-works/pi-tui";

import type { WorkflowResumeReceipt } from "../protocol/workflow-resume.ts";
import type { AgentStatus } from "../coordination/agent-record.ts";
import type {
	AgentWaitInput,
	AgentWaitProgress,
	AgentWaitResult,
} from "../protocol/agent-wait.ts";
import {
	compactAgentIdentity,
	formatAgentIdentity,
	formatKnownAgentIdentity,
	type AgentLabelResolver,
} from "../presentation/agent-identity.ts";
import {
	formatAgentWorkStatus,
	selectedAgentWorkStatus,
} from "../presentation/selected-agent-status.ts";
import type { HumanRequestInput, HumanAnswer } from "../protocol/human-request.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import type { RunControlInput, RunControlReceipt } from "../protocol/run-control.ts";
import type { AgentRunState } from "../runtime/agent-runtime-host.ts";
import type { ReportToUserInput, ReportToUserReceipt } from "../protocol/moderator-report.ts";
import type { AgentObserveInput } from "./coordination-tool-catalogue.ts";
import { boundedToolPreview } from "./bounded-preview.ts";
import { renderMessageProjection } from "./message-delivery-renderer.ts";
import { messageReceiptStatusColor } from "./message-renderer.ts";
import { formatMessageIdentity } from "../presentation/message-identity.ts";
import { normalizedBody } from "../presentation/body-text.ts";
import type { OpenIncomingRequest } from "../protocol/request-inspection.ts";

export function renderWorkflowResumeCall(_args: object, theme: Theme): Text {
	return toolCall(theme, "resume", ["Workflow"]);
}

export function renderWorkflowResumeResult(
	result: AgentToolResult<WorkflowResumeReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	const requests = result.details.outstandingRequests;
	if (requests.length === 0) {
		return new Text(theme.fg("dim", "no outstanding outbound Requests"), 0, 0);
	}
	const summary = `${requests.length} outstanding outbound Request${requests.length === 1 ? "" : "s"}`;
	const needsAttention = requests.some(request => request.status === "blocked" || request.status === "indeterminate");
	const lines = [theme.fg(needsAttention ? "warning" : "success", summary)];
	for (const request of requests) {
		const requestId = formatMessageIdentity(request.requestMessageId, options.expanded);
		const targetId = options.expanded
			? request.targetAgentId
			: compactAgentIdentity(request.targetAgentId);
		const statusColor: ThemeColor = request.status === "blocked" || request.status === "indeterminate"
			? "warning"
			: request.status === "resolved" ? "dim" : "success";
		const row = [
			`Request ID: ${requestId}`,
			`target ID: ${targetId}`,
			`status: ${request.status}`,
			...(request.reason ? [`reason: ${options.expanded ? request.reason : boundedToolPreview(request.reason)}`] : []),
		].join(" · ");
		lines.push(theme.fg(statusColor, row));
	}
	return new Text(lines.join("\n"), 0, 0);
}

export function renderAgentWaitCall(
	args: AgentWaitInput,
	theme: Theme,
	expanded = false,
): Text {
	return toolCall(theme, "wait", args.requestMessageIds?.map(id => formatMessageIdentity(id, expanded)) ?? []);
}

/** In-flight Wait names the snapshot responders; the receipt reuses them. */
export function renderAgentWaitProgress(
	result: AgentToolResult<unknown>,
	theme: Theme,
	context: Readonly<{ state: AgentWaitRenderState }>,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Text {
	if (!isAgentWaitProgress(result.details)) return renderInFlightLabel(theme, "waiting for Answers");
	context.state.progress = result.details;
	const count = result.details.waitingFor.length;
	const identities = result.details.waitingFor.map(({ responderAgentId, requestTitle }) =>
		theme.fg("customMessageLabel", boundedToolPreview(requestTitle)) +
			theme.fg("muted", ` · ${formatAgentIdentity(responderAgentId, resolveAgentLabel)}`)
	);
	return new Text([
		theme.fg("accent", `waiting for ${count} Answer${count === 1 ? "" : "s"}…`),
		...identities.map((identity) => `• ${identity}`),
	].join("\n"), 0, 0);
}

export function renderAgentWaitResult(
	result: AgentToolResult<AgentWaitResult | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: Readonly<{ state: AgentWaitRenderState }>,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Component {
	if (result.details && "disposition" in result.details) {
		return receipt(theme, "preempted", result.details, options);
	}
	if (!result.details || !("answers" in result.details)) {
		return receipt(theme, "0 Answers", result.details, options);
	}
	const count = result.details.answers.length;
	const progressByRequest = new Map<string, string>(
		context.state.progress?.waitingFor.map((waiting): [string, string] => [
			waiting.requestMessageId,
			waiting.responderAgentId,
		]) ?? [],
	);
	const container = new Container();
	container.addChild(new Text(
		theme.fg("success", `${count} Answer${count === 1 ? "" : "s"}`),
		0,
		0,
	));
	for (const answer of result.details.answers) {
		container.addChild(new Spacer(1));
		if (answer.disposition === "answer_delivered") {
			container.addChild(renderMessageProjection(
				{
					kind: "answer",
					answerId: answer.answerId,
					requestMessageId: answer.requestMessageId,
					requestTitle: answer.requestTitle,
					fromAgentId: answer.fromAgentId,
					answer: answer.answer,
				},
				options,
				theme,
				resolveAgentLabel,
			));
			continue;
		}
		const responderAgentId = progressByRequest.get(answer.requestMessageId);
		const identity = responderAgentId
			? ` from ${formatAgentIdentity(
				responderAgentId,
				resolveAgentLabel,
				options.expanded ? "full" : "compact",
			)}`
			: "";
		container.addChild(new Text(
			`${theme.fg("customMessageLabel", theme.bold("[Answer already delivered]"))} ${theme.fg("customMessageLabel", boundedToolPreview(answer.requestTitle))}${
				theme.fg("muted", identity)
			}`,
			0,
			0,
		));
	}
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(
			theme.fg("dim", JSON.stringify(result.details, null, 2)),
			0,
			0,
		));
	}
	return container;
}

type AgentWaitRenderState = { progress?: AgentWaitProgress };

function isAgentWaitProgress(value: unknown): value is AgentWaitProgress {
	return typeof value === "object" && value !== null &&
		"waitingFor" in value && Array.isArray(value.waitingFor);
}

export function renderAgentObserveCall(
	args: AgentObserveInput,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
	expanded = false,
): Text {
	// Selector rows name the identity a caller typed, so expansion reveals it in
	// full: the same compact-to-full rule as Message IDs elsewhere.
	const identityDetail = expanded ? "full" : "compact";
	if (args.operation === "obligations") return toolCall(theme, "observe", [args.operation]);
	if (args.operation === "request") {
		return toolCall(theme, "observe", [args.operation,
			typeof args.requestId === "string" ? formatMessageIdentity(args.requestId, expanded) : undefined]);
	}
	if (args.operation === "status") {
		return toolCall(theme, "observe", [
			args.operation,
			args.agentId
				? formatAgentIdentity(args.agentId, resolveAgentLabel, identityDetail)
				: undefined,
		]);
	}
	const scope = typeof args.scope === "string"
		? args.scope
		: `spawner ${formatAgentIdentity(
			args.scope.directSpawnerAgentId,
			resolveAgentLabel,
			identityDetail,
		)}`;
	return toolCall(theme, "observe", [
		args.operation,
		scope,
		args.query ? boundedToolPreview(args.query) : undefined,
		args.agentIdSuffix ? `id …${args.agentIdSuffix}` : undefined,
		args.phase,
		args.limit === undefined ? undefined : `limit ${args.limit}`,
	]);
}

export function renderAgentObserveResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: Readonly<{ args: AgentObserveInput }>,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Component {
	const details = asRecord(result.details);
	if (context.args.operation === "obligations" && Array.isArray(details?.requests)) {
		const requests = details.requests as readonly OpenIncomingRequest[];
		return new Text([
			theme.fg("success", `${requests.length} outstanding Request${requests.length === 1 ? "" : "s"}`),
			...requests.map(request =>
				`${theme.fg("customMessageLabel", boundedToolPreview(request.title))} · ${
					formatAgentIdentity(request.requesterAgentId, resolveAgentLabel, options.expanded ? "full" : "compact")
				} · ${formatMessageIdentity(request.requestMessageId, options.expanded)}`),
		].join("\n"), 0, 0);
	}
	if (context.args.operation === "request" && typeof details?.question === "string" &&
		typeof details.title === "string" && typeof details.requestMessageId === "string" &&
		typeof details.requesterAgentId === "string") {
		const container = new Container();
		container.addChild(renderMessageProjection({
			kind: "request", requestMessageId: details.requestMessageId,
			fromAgentId: details.requesterAgentId, title: details.title, question: details.question,
		}, options, theme, resolveAgentLabel));
		container.addChild(new Text(theme.fg("dim", formatMessageIdentity(details.requestMessageId, options.expanded)), 0, 0));
		return container;
	}
	const matches = Array.isArray(details?.matches) ? details.matches : undefined;
	if (matches) {
		const hasMore = details?.hasMore === true;
		return receipt(
			theme,
			`${matches.length} match${matches.length === 1 ? "" : "es"}${hasMore ? " · more" : ""}`,
			result.details,
			options,
		);
	}
	const status = observedAgentStatus(details);
	return status
		? agentStatusReceipt(theme, status, result.details, options)
		: receipt(theme, "observed", result.details, options);
}

export function renderAgentControlCall(
	args: RunControlInput,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
	expanded = false,
): Text {
	return toolCall(theme, "control", [
		args.operation,
		formatAgentIdentity(args.agentId, resolveAgentLabel, expanded ? "full" : "compact"),
		args.operation === "resume" ? boundedToolPreview(args.content) : undefined,
	]);
}

export function renderAgentControlResult(
	result: AgentToolResult<RunControlReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Text {
	const details = result.details;
	const disposition = "disposition" in details
		? details.disposition
		: "messageStatus" in details
			? details.messageStatus
			: details.delivery;
	const color = "messageStatus" in details || "delivery" in details
		? messageReceiptStatusColor(disposition)
		: "success";
	return receipt(
		theme,
		disposition,
		details,
		options,
		color,
		` · ${formatAgentIdentity(
			details.agentId,
			resolveAgentLabel,
			options.expanded ? "full" : "compact",
		)}`,
	);
}

export function renderHumanRequestCall(
	args: HumanRequestInput,
	theme: Theme,
	context: Readonly<{ isPartial: boolean; outputPad: number }>,
): Component {
	return transcriptBlock({
		label: context.isPartial ? "[Ask User]  waiting" : "[Ask User]",
		markdown: typeof args.question === "string" ? args.question : "",
		theme,
		outputPad: context.outputPad,
		background: "customMessageBg",
		textColor: "customMessageText",
	});
}

/** An interrupted Human Request keeps its transcript block shape. */
export function renderHumanRequestError(
	result: AgentToolResult<unknown>,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: Readonly<{ outputPad: number }>,
): Component {
	return transcriptBlock({
		label: "[Interrupted]",
		markdown: toolResultText(result),
		theme,
		outputPad: context.outputPad,
		background: "toolErrorBg",
		textColor: "error",
	});
}

export function renderHumanRequestResult(
	result: AgentToolResult<HumanAnswer | undefined>,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: Readonly<{ outputPad: number }>,
): Component {
	return transcriptBlock({
		label: "[Answer]",
		markdown: result.details?.answer ?? toolResultText(result),
		theme,
		outputPad: context.outputPad,
		background: "userMessageBg",
		textColor: "userMessageText",
	});
}

export function renderModeratorControlCall(
	args: ModeratorControlInput,
	theme: Theme,
): Text {
	return args.operation === "renew_review_deadline"
		? toolCall(theme, "moderate", [
			"renew review",
			args.toolCall.toolCallId,
			`${args.nextReviewInMs} ms`,
		])
		: toolCall(theme, "moderate", ["resolve", boundedToolPreview(args.summary)]);
}

export function renderModeratorControlResult(
	result: AgentToolResult<ModeratorControlReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	return receipt(theme, result.details.disposition, result.details, options);
}

export function renderReportToUserCall(args: ReportToUserInput, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", "Report to User") + " " + boundedToolPreview(args.symptom ?? ""), 0, 0);
}

export function renderReportToUserResult(
	result: AgentToolResult<ReportToUserReceipt | undefined>,
	theme: Theme,
): Text {
	return new Text(theme.fg(
		result.details ? "success" : "muted",
		result.details ? `Report retained · ${result.details.reportId}` : boundedToolPreview(toolResultText(result)),
	), 0, 0);
}

function toolCall(
	theme: Theme,
	label: string,
	details: readonly (string | undefined)[],
): Text {
	let text = theme.fg("toolTitle", theme.bold(`${label} `));
	text += details
		.filter((detail): detail is string => detail !== undefined && detail.length > 0)
		.map((detail, index) => theme.fg(index === 0 ? "accent" : "dim", detail))
		.join(theme.fg("dim", " · "));
	return new Text(text, 0, 0);
}

// In-flight coordination needs no user action, so it must not borrow the warning role.
export function renderInFlightLabel(theme: Theme, label: string): Text {
	return new Text(theme.fg("accent", `${label}…`), 0, 0);
}

function receipt(
	theme: Theme,
	summary: string,
	details: unknown,
	options: ToolRenderResultOptions,
	color: ThemeColor = "success",
	dimmedSuffix?: string,
): Text {
	let text = theme.fg(color, summary);
	if (dimmedSuffix) text += theme.fg("dim", dimmedSuffix);
	if (options.expanded) text += theme.fg("dim", `\n${JSON.stringify(details, null, 2)}`);
	return new Text(text, 0, 0);
}

function agentStatusReceipt(
	theme: Theme,
	status: Pick<AgentStatus, "agentId" | "label" | "run">,
	details: unknown,
	options: ToolRenderResultOptions,
): Text {
	const identity = theme.fg(
		"toolTitle",
		theme.bold(formatKnownAgentIdentity(
			status.agentId,
			status.label,
			options.expanded ? "full" : "compact",
		)),
	);
	const workStatus = formatAgentWorkStatus(
		selectedAgentWorkStatus(status.run, false),
		theme,
	);
	let text = `${identity}\n${workStatus}`;
	if (options.expanded) text += theme.fg("dim", `\n${JSON.stringify(details, null, 2)}`);
	return new Text(text, 0, 0);
}

function observedAgentStatus(
	value: Record<string, unknown> | undefined,
): Pick<AgentStatus, "agentId" | "label" | "run"> | undefined {
	if (
		typeof value?.agentId !== "string" ||
		typeof value.label !== "string" ||
		!isAgentRunState(value.run)
	) return undefined;
	return {
		agentId: value.agentId,
		label: value.label,
		run: value.run,
	};
}

function isAgentRunState(value: unknown): value is AgentRunState {
	const run = asRecord(value);
	if (!run || !Array.isArray(run.retentionReasons)) return false;
	if (run.phase === "dormant") return true;
	return (
		(run.phase === "starting" || run.phase === "live" || run.phase === "ending") &&
		(run.work === undefined || run.work === "active" || run.work === "settled") &&
		(
			run.attention === "none" ||
			run.attention === "input_required" ||
			run.attention === "agent_wait"
		)
	);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: undefined;
}

function transcriptBlock(options: {
	label: string;
	markdown: string;
	theme: Theme;
	/** Pi's outputPad setting; Ask User renders its own shell, so Pi does not pad it. */
	outputPad: number;
	background: "customMessageBg" | "toolErrorBg" | "userMessageBg";
	textColor: "customMessageText" | "error" | "userMessageText";
}): Component {
	const box = new Box(
		options.outputPad,
		1,
		(content) => options.theme.bg(options.background, content),
	);
	box.addChild(new Text(
		options.theme.fg(options.textColor, options.theme.bold(options.label)),
		0,
		0,
	));
	box.addChild(new Markdown(
		// A label and its body are one item, so blank rows around the body would
		// read as an item boundary that does not exist.
		normalizedBody(options.markdown),
		0,
		0,
		getMarkdownTheme(),
		{ color: (content) => options.theme.fg(options.textColor, content) },
		{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
	));
	return box;
}

/** A final native error carries its message in content, not in typed details. */
export function renderToolError(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	const error = toolResultText(result);
	return new Text(theme.fg("error", options.expanded ? error : boundedToolPreview(error)), 0, 0);
}

function toolResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(({ text }) => text)
		.join("\n");
}
