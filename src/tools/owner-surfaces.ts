import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { openModeratorReportSurface } from "../presentation/moderator-report-surface.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	HumanPresentationCoordinatorView,
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface, type AgentSelectorAction } from "../presentation/agent-selector-surface.ts";
import {
	openAgentViewSurface,
	startPhysicalAgentViewSurface,
	type PhysicalAgentViewSurface,
} from "../presentation/agent-view-surface.ts";
import { openPostMortemAgentViewSurface } from "../presentation/post-mortem-agent-view-surface.ts";
import {
	createAgentSelectionSession,
	createAgentSelectorSnapshot,
	getAgentsArgumentCompletions,
	parseAgentsCommandArgument,
} from "../process-runtime/remote-agent-selector.ts";
import {
	registerParticipantCoordinationTools,
	type AgentObserveInput,
	type ParticipantCoordinationRole,
	type ParticipantCoordinationToolHandlers,
} from "./participant-coordination-tools.ts";
import type { AgentTemplateCatalogueSnapshot } from "../templates/agent-templates.ts";
import type { OwnerRecoveryError } from "../bootstrap/owner-recovery-error.ts";
import { openOwnerDiagnostics } from "../presentation/owner-diagnostics-surface.ts";

type AgentCoordinatorView =
	| OrdinaryAgentCoordinatorView
	| ModeratorAgentCoordinatorView;
type ViewResolver = () => AgentCoordinatorView;

const OWNER_AGENT_TOOL_NAMES = new Set([
	"workflow_resume",
	"agent_message",
	"agent_wait",
	"agent_spawn",
	"agent_observe",
	"agent_control",
]);

export function activateOwnerAgentTools(pi: ExtensionAPI): void {
	pi.setActiveTools([
		...new Set([...pi.getActiveTools(), ...OWNER_AGENT_TOOL_NAMES]),
	]);
}

export function deactivateOwnerAgentTools(pi: ExtensionAPI): void {
	pi.setActiveTools(
		pi.getActiveTools().filter((toolName) => !OWNER_AGENT_TOOL_NAMES.has(toolName)),
	);
}

export function registerAgentsCommand(
	pi: ExtensionAPI,
	resolveView: () => HumanPresentationCoordinatorView,
	ownerAdmission?: OwnerRecoveryError | "admitted",
): void {
	const admissionFailure = ownerAdmission === "admitted" ? undefined : ownerAdmission;
	pi.registerCommand("agents", {
		description: ownerAdmission ? "Show Agents or inspect coordination diagnostics" : "Show Agents in the current Workflow",
		getArgumentCompletions: (prefix) => {
			const completions = [
				...(getAgentsArgumentCompletions(prefix) ?? []),
				...(ownerAdmission && "diagnostics".startsWith(prefix.trim()) ? [{ value: "diagnostics", label: "diagnostics" }] : []),
			];
			return completions.length ? completions : null;
		},
		handler: async (args, ctx) => {
			if (ownerAdmission && (args.trim() === "diagnostics" || (admissionFailure && !args.trim()))) {
				if (ctx.mode !== "tui") return;
				await openOwnerDiagnostics(ctx.ui, admissionFailure);
				return;
			}
			if (admissionFailure) {
				ctx.ui.notify("Subagent coordination workflow blocked. Use /agents diagnostics.", "warning");
				return;
			}
			if (ownerAdmission && args.trim() && args.trim() !== "owner") {
				throw new Error("Usage: /agents [owner|diagnostics]");
			}
			const commandMode = parseAgentsCommandArgument(args);
			const view = resolveView();
			await view.refreshTranscriptFacts();
			const status = view.status();
			if (commandMode === "owner") {
				const selection = createAgentSelectionSession(view, status.agentId);
				const action = {
					kind: "select_agent" as const,
					agentId: status.workflowId,
				};
				await selection.prepare(action);
				await selection.complete(action);
				return;
			}
			const selectedAgentId = status.agentId;
			let reopenSelector = true;
			while (reopenSelector) {
				reopenSelector = false;
				const selection = createAgentSelectionSession(view, selectedAgentId);
				let physicalSurface: PhysicalAgentViewSurface | undefined;
				let selectorTui: TUI | undefined;
				const prepareSelection = async (action: AgentSelectorAction, ownerTui: TUI) => {
					selectorTui = ownerTui;
					if (action.kind === "open_report") return;
					await selection.prepare(action);
					const preparedAgentView = selection.preparedView();
					if (!preparedAgentView) return;
					physicalSurface = startPhysicalAgentViewSurface(preparedAgentView, {
						ownerTui,
						requestShutdown: () => ctx.shutdown(),
					});
					if (physicalSurface) {
						const unbind = view.bindPhysicalAgentSurface(physicalSurface);
						void physicalSurface.closed.finally(unbind);
					}
					await physicalSurface?.ready;
				};
				let action = await openAgentSelectorSurface(ctx.ui, {
					...createAgentSelectorSnapshot(view, selectedAgentId),
					addChangeHandler: (handler) => view.addAgentActivityChangeHandler(() =>
						handler(createAgentSelectorSnapshot(view, selectedAgentId))),
					setReportRead(reportId, read) {
						view.setReportRead(reportId, read);
						return view.reportHistory();
					},
					prepareSelection,
					onSelectionError(error) {
						ctx.ui.notify(
							`Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					},
				});
				if (action?.kind === "open_report") {
					const reportId = action.reportId;
					const item = view.reportHistory().find(({ report }) => report.reportId === reportId);
					if (!item) throw new Error("Report is unavailable");
					const outcome = await openModeratorReportSurface(ctx.ui, item, {
						setRead: (read) => view.setReportRead(reportId, read),
						copyReport: copyToClipboard,
						prepareReporter: () => prepareSelection({ kind: "select_agent", agentId: item.report.reporter.agentId }, selectorTui!),
					});
					if (outcome !== "view_reporter") {
						reopenSelector = true;
						continue;
					}
					action = { kind: "select_agent", agentId: item.report.reporter.agentId };
				}
				if (action?.kind === "decide") {
					try {
						await selection.complete(action);
					} catch (error) {
						physicalSurface?.close();
						ctx.ui.notify(
							`Human Request selection failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
				}
				const postMortem = selection.postMortemView();
				if (postMortem) {
					reopenSelector = await openPostMortemAgentViewSurface(ctx.ui, postMortem) === "agents";
					continue;
				}
				if (action) {
					const preparedAgentView = selection.preparedView();
					if (preparedAgentView && !physicalSurface) {
						await openAgentViewSurface(ctx.ui, preparedAgentView, {
							requestShutdown: () => ctx.shutdown(),
						});
					} else {
						void physicalSurface?.closed.catch((error) => ctx.ui.notify(
							`Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						));
					}
				}
			}
		},
	});
}

export function registerOrdinaryAgentSurfaces(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView,
): void {
	const handlers = participantCoordinatorHandlers("ordinary", resolveView);
	const resolveAgentLabel = (agentId: string) => resolveView().agentLabel(agentId);
	registerParticipantCoordinationTools(
		pi,
		"ordinary",
		handlers,
		resolveAgentLabel,
		undefined,
		(toolCallId) => resolveView().answerTargetAgent(toolCallId),
	);
	pi.on("session_start", () => registerParticipantCoordinationTools(
		pi,
		"ordinary",
		handlers,
		resolveAgentLabel,
		resolveView().agentTemplateSnapshot(),
		(toolCallId) => resolveView().answerTargetAgent(toolCallId),
	));
	registerAgentsCommand(pi, resolveView);
}

export function registerOwnerAgentTools(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView,
	agentTemplateSnapshot?: AgentTemplateCatalogueSnapshot,
): void {
	registerParticipantCoordinationTools(
		pi,
		"owner",
		participantCoordinatorHandlers("owner", resolveView),
		(agentId) => resolveView().agentLabel(agentId),
		agentTemplateSnapshot,
		(toolCallId) => resolveView().answerTargetAgent(toolCallId),
	);
}

export function registerModeratorAgentSurfaces(
	pi: ExtensionAPI,
	resolveView: () => ModeratorAgentCoordinatorView,
): void {
	registerParticipantCoordinationTools(
		pi,
		"moderator",
		participantCoordinatorHandlers("moderator", resolveView),
		(agentId) => resolveView().agentLabel(agentId),
		undefined,
		(toolCallId) => resolveView().answerTargetAgent(toolCallId),
	);
	registerAgentsCommand(pi, resolveView);
}

export function participantCoordinatorHandlers(
	role: "ordinary",
	resolveView: () => OrdinaryAgentCoordinatorView,
): ParticipantCoordinationToolHandlers<"ordinary">;
export function participantCoordinatorHandlers(
	role: "owner",
	resolveView: () => OrdinaryAgentCoordinatorView,
): ParticipantCoordinationToolHandlers<"owner">;
export function participantCoordinatorHandlers(
	role: "moderator",
	resolveView: () => ModeratorAgentCoordinatorView,
): ParticipantCoordinationToolHandlers<"moderator">;
export function participantCoordinatorHandlers(
	role: ParticipantCoordinationRole,
	resolveView: ViewResolver,
): ParticipantCoordinationToolHandlers<ParticipantCoordinationRole> {
	const common = {
		message: (toolCallId: string, input: Parameters<AgentCoordinatorView["message"]>[1]) =>
			resolveView().message(toolCallId, input),
		wait: (
			toolCallId: string,
			input: Parameters<AgentCoordinatorView["wait"]>[1],
			signal: AbortSignal | undefined,
			onProgress: Parameters<AgentCoordinatorView["wait"]>[3],
		) => resolveView().wait(toolCallId, input, signal, onProgress),
		async observe(input: AgentObserveInput) {
			const view = resolveView();
			await view.refreshTranscriptFacts();
			switch (input.operation) {
				case "status": return view.status(input.agentId);
				case "search": return view.search(input);
				case "obligations": return view.openIncomingRequests();
				case "request": return view.inspectRequest(input.requestId);
			}
		},
		control: (toolCallId: string, input: Parameters<AgentCoordinatorView["control"]>[1]) =>
			resolveView().control(toolCallId, input),
	};
	if (role === "moderator") {
		const moderatorView = resolveView as () => ModeratorAgentCoordinatorView;
		return {
			...common,
			askUser: (toolCallId, input, signal) =>
				moderatorView().askHuman(toolCallId, input, signal),
			reportToUser: (toolCallId, input) => moderatorView().reportToUser(toolCallId, input),
			moderatorControl: (toolCallId, input) =>
				moderatorView().moderatorControl(toolCallId, input),
		};
	}
	const ordinaryView = resolveView as () => OrdinaryAgentCoordinatorView;
	const spawn = (toolCallId: string, input: Parameters<OrdinaryAgentCoordinatorView["spawn"]>[1]) =>
		ordinaryView().spawn(toolCallId, input);
	const agentTemplateSnapshot = (refresh = false) => refresh
		? ordinaryView().refreshAgentTemplateSnapshot()
		: ordinaryView().agentTemplateSnapshot();
	return role === "ordinary"
		? {
			...common,
			spawn,
			agentTemplateSnapshot,
			askUser: (toolCallId, input, signal) =>
				ordinaryView().askHuman(toolCallId, input, signal),
		}
		: { ...common, spawn, agentTemplateSnapshot, resumeWorkflow: (toolCallId) => ordinaryView().resumeWorkflow(toolCallId) };
}
