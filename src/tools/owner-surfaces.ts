import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { openModeratorReportSurface } from "../presentation/moderator-report-surface.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	HumanPresentationCoordinatorView,
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
import { registerParticipantCoordinationTools } from "./participant-coordination-tools.ts";
import { createViewBackedParticipantHandlers } from "../coordination/view-backed-participant-handlers.ts";
import type { AgentTemplateCatalogueSnapshot } from "../templates/agent-templates.ts";
import type { OwnerRecoveryError } from "../bootstrap/owner-recovery-error.ts";
import { headlessOwnerDiagnostics, openOwnerDiagnostics } from "../presentation/owner-diagnostics-surface.ts";
import { openModelPolicySurface } from "../presentation/model-policy-surface.ts";

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

const HEADLESS_AGENTS_COMMAND_MESSAGE =
	"The Agents selector, Agent views, reports, and model policy need Pi's terminal UI. " +
	"Reopen this session interactively (pi --session <file>) to use them.";

export function registerAgentsCommand(
	pi: ExtensionAPI,
	resolveView: () => HumanPresentationCoordinatorView,
	ownerAdmission?: OwnerRecoveryError | "admitted",
	/** Present only in the Workflow Owner session; enables `/agents models`. */
	admittedOwnerView?: () => OrdinaryAgentCoordinatorView,
): void {
	const admissionFailure = ownerAdmission === "admitted" ? undefined : ownerAdmission;
	pi.registerCommand("agents", {
		description: ownerAdmission ? "Show Agents or inspect coordination diagnostics" : "Show Agents in the current Workflow",
		getArgumentCompletions: (prefix) => {
			const completions = [
				...(getAgentsArgumentCompletions(prefix) ?? []),
				...(ownerAdmission && "diagnostics".startsWith(prefix.trim()) ? [{ value: "diagnostics", label: "diagnostics" }] : []),
				...(admittedOwnerView && "models".startsWith(prefix.trim()) ? [{ value: "models", label: "models" }] : []),
			];
			return completions.length ? completions : null;
		},
		handler: async (args, ctx) => {
			if (ownerAdmission && args.trim() === "diagnostics") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(headlessOwnerDiagnostics(admissionFailure), admissionFailure ? "error" : "info");
					return;
				}
				await openOwnerDiagnostics(ctx.ui, admissionFailure);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(HEADLESS_AGENTS_COMMAND_MESSAGE, "warning");
				return;
			}
			if (admittedOwnerView && args.trim() === "models") {
				const view = admittedOwnerView();
				await openModelPolicySurface(ctx.ui, {
					...view.modelPolicy(),
					persist: async (entries) => (await view.setModelExclusions(entries)).excludedModels,
				});
				// Spawn guidance is baked into the registered tool definitions, so refresh
				// them rather than leaving the Owner's own prompt describing stale bans.
				registerOwnerAgentTools(pi, admittedOwnerView, view.agentTemplateSnapshot());
				return;
			}
			if (admissionFailure) {
				ctx.ui.notify("Subagent coordination is unavailable. Use /agents diagnostics.", "warning");
				return;
			}
			if (ownerAdmission && args.trim() && args.trim() !== "owner") {
				throw new Error("Usage: /agents [owner|diagnostics]");
			}
			const commandMode = parseAgentsCommandArgument(args);
			const view = resolveView();
			// Navigation uses the admitted projection; transcript refresh must not
			// prevent opening the selector or returning to Owner.
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
					const reporter = item.report.reporter;
					const outcome = await openModeratorReportSurface(ctx.ui, item, {
						setRead: (read) => view.setReportRead(reportId, read),
						copyReport: copyToClipboard,
						prepareReporter: reporter ? () => prepareSelection({ kind: "select_agent", agentId: reporter.agentId }, selectorTui!) : undefined,
					});
					if (outcome !== "view_reporter" || !reporter) {
						reopenSelector = true;
						continue;
					}
					action = { kind: "select_agent", agentId: reporter.agentId };
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

export function registerOwnerAgentTools(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView,
	agentTemplateSnapshot?: AgentTemplateCatalogueSnapshot,
): void {
	registerParticipantCoordinationTools(
		pi,
		"owner",
		createViewBackedParticipantHandlers("owner", resolveView).coordination,
		(agentId) => resolveView().agentLabel(agentId),
		agentTemplateSnapshot,
		(toolCallId) => resolveView().answerTargetAgent(toolCallId),
	);
}
