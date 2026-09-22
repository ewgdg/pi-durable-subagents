import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { openModeratorReportSurface } from "../presentation/moderator-report-surface.ts";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

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
	AGENTS_COMMAND_USAGE,
	createAgentSelectionSession,
	createAgentSelectorSnapshot,
	getAgentsArgumentCompletions,
	parseAgentsCommandArgument,
	parseAgentsRepairReason,
} from "../process-runtime/remote-agent-selector.ts";
import { validateManualRepairReason } from "../coordination/manual-repair.ts";
import {
	registerParticipantCoordinationTools,
	type AgentObserveInput,
	type ParticipantCoordinationRole,
	type ParticipantCoordinationToolHandlers,
} from "./participant-coordination-tools.ts";
import type { AgentTemplateCatalogueSnapshot } from "../templates/agent-templates.ts";
import type { OwnerRecoveryError } from "../bootstrap/owner-recovery-error.ts";
import { openOwnerDiagnostics } from "../presentation/owner-diagnostics-surface.ts";
import { openModelPolicySurface } from "../presentation/model-policy-surface.ts";

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


export type RepairSurfaceDeps = Readonly<{
  startRepairSurface?: typeof startPhysicalAgentViewSurface;
}>;

async function prepareAndBindRepairModerator(
  view: HumanPresentationCoordinatorView,
  moderatorAgentId: string,
  opts: Readonly<{
    ownerTui: TUI;
    requestShutdown: () => void;
    startPhysical?: typeof startPhysicalAgentViewSurface;
  }>
): Promise<PhysicalAgentViewSurface | undefined> {
  const selection = createAgentSelectionSession(view, view.status().agentId);
  const action = { kind: "select_agent" as const, agentId: moderatorAgentId };
  await selection.prepare(action);
  if (selection.postMortemView()) {
    throw new Error("Repair view failed: Moderator unavailable for live view");
  }
  const preparedView = selection.preparedView();
  if (!preparedView) {
    return undefined;
  }
  let surface: PhysicalAgentViewSurface | undefined;
  try {
    surface = (opts.startPhysical ?? startPhysicalAgentViewSurface)(preparedView, {
      ownerTui: opts.ownerTui,
      requestShutdown: opts.requestShutdown,
    });
  } catch (error) {
    await preparedView.close().catch(() => undefined);
    throw error;
  }
  if (!surface) {
    await preparedView.close().catch(() => undefined);
    throw new Error("Repair view failed: physical terminal unavailable");
  }
  let unbind: (() => void) | undefined;
  try {
    unbind = view.bindPhysicalAgentSurface(surface);
  } catch (error) {
    try {
      surface.close();
    } catch {
    }
    await surface.closed.catch(() => undefined);
    throw error;
  }
  void surface.closed.finally(() => {
    try {
      if (unbind) unbind();
    } catch {
    }
  });
  try {
    await surface.ready;
  } catch (error) {
    try {
      surface.close();
    } catch {
    }
    await surface.closed.catch(() => undefined);
    throw error;
  }
  return surface;
}

async function captureRepairOwnerTui(
  ui: ExtensionUIContext
): Promise<TUI> {
  let captured: TUI | undefined;
  await ui.custom<void>((tui, _theme, _keys, done) => {
    captured = tui;
    done(undefined);
    return {
      render: () => [],
      invalidate: () => undefined,
      handleInput: () => undefined,
    } as unknown as Component;
  }, {
    overlay: true,
    overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
  });
  if (!captured) {
    throw new Error("Repair view failed: owner TUI unavailable");
  }
  return captured;
}

async function swapRepairViaTransientOverlay(
  ui: ExtensionUIContext,
  view: HumanPresentationCoordinatorView,
  moderatorAgentId: string,
  requestShutdown: () => void,
  startPhysical?: typeof startPhysicalAgentViewSurface
): Promise<PhysicalAgentViewSurface | undefined> {
  const ownerTui = await captureRepairOwnerTui(ui);
  return prepareAndBindRepairModerator(view, moderatorAgentId, { ownerTui, requestShutdown, startPhysical });
}

async function openPreadmissionRepairSelector(ui: ExtensionUIContext, view: HumanPresentationCoordinatorView): Promise<void> {
 const buildRepairSnapshot = () => {
 const roster = view.selectionRoster();
 const repaired = view.repairedOwnerEntry();
 const isModeratorRow = (status: { agentId: string; workflowId: string }) => status.agentId !== status.workflowId;
 const liveMods = [...roster.live].filter(isModeratorRow);
 const dormantMods = [...roster.dormant].filter(isModeratorRow);
 const mountedId = view.status().agentId;
 const selectedId = liveMods[0]?.agentId ?? dormantMods[0]?.agentId ?? repaired?.ownerId ?? mountedId;
 return { liveMods, dormantMods, repaired, mountedId, selectedId };
 };
 const initial = buildRepairSnapshot();
 const selection = createAgentSelectionSession(view, initial.mountedId);
 let reopen = true;
 while (reopen) {
 reopen = false;
 const current = buildRepairSnapshot();
 const action = await openAgentSelectorSurface(ui, {
 live: [...current.liveMods],
 dormant: [...current.dormantMods],
 selectedAgentId: current.selectedId,
 repairedOwner: current.repaired ?? undefined,
 humanAttention: [...view.humanAttention()],
 operationalAttention: [...view.operationalAttention()],
 reports: [...view.reportHistory()],
 setReportRead(reportId, read) {
 view.setReportRead(reportId, read);
 return view.reportHistory();
 },
 addChangeHandler: (handler) => view.addAgentActivityChangeHandler(() => {
 const next = buildRepairSnapshot();
 handler({ live: [...next.liveMods], dormant: [...next.dormantMods], repairedOwner: next.repaired ?? undefined, humanAttention: [...view.humanAttention()], operationalAttention: [...view.operationalAttention()], reports: [...view.reportHistory()] });
 }),
 prepareSelection: async (act) => {
 if (act.kind === "open_report") return;
 const repairedId = current.repaired?.ownerId;
 if (act.kind === "select_agent" && repairedId && act.agentId === repairedId) {
const stage = current.repaired?.stage === "admission-pending" ? "admission-pending" : "snapshot-only";
if (stage === "admission-pending") {
await view.admitRepairedOwner();
return;
}
throw new Error("unavailable: repaired Owner is available after repair completes");
 }
 await selection.prepare(act);
 },
 onSelectionError(error) {
 ui.notify("Agent view failed: " + (error instanceof Error ? error.message : String(error)), "error");
 },
 });
 if (!action) return;
 if (action.kind === "open_report") {
 reopen = true;
 continue;
 }
 if (action.kind === "decide") {
 try {
 await selection.complete(action);
 } catch (error) {
 ui.notify("Human Request selection failed: " + (error instanceof Error ? error.message : String(error)), "error");
 return;
 }
 continue;
 }
 const repairedId = current.repaired?.ownerId;
 if (repairedId && action.agentId === repairedId) {
 const entry = view.repairedOwnerEntry();
 const stage = entry?.stage === "admission-pending" ? "admission-pending" : "snapshot-only";
if (stage === "admission-pending") {
ui.notify("Repaired Owner " + stage + " acknowledged idle until human message: " + repairedId, "info");
} else {
ui.notify("Repaired Owner is available after repair completes: " + repairedId, "info");
}
 return;
 }
 const prepared = selection.preparedView();
 if (prepared) {
 await openAgentViewSurface(ui, prepared, { requestShutdown: () => undefined });
 return;
 }
 return;
 }
}
export function registerAgentsCommand(
	pi: ExtensionAPI,
	resolveView: () => HumanPresentationCoordinatorView,
	ownerAdmission?: OwnerRecoveryError | "admitted",
	/** Present only in the Workflow Owner session; enables `/agents models`. */
	admittedOwnerView?: () => OrdinaryAgentCoordinatorView,
	/** Preadmission repair host for admission-failed Owner sessions. Manual only. */
	preadmissionRepair?: () => HumanPresentationCoordinatorView,
  repairDeps?: RepairSurfaceDeps,
): void {
	const admissionFailure = ownerAdmission === "admitted" ? undefined : ownerAdmission;
	pi.registerCommand("agents", {
		description: ownerAdmission ? "Show Agents or inspect coordination diagnostics" : "Show Agents in the current Workflow",
		getArgumentCompletions: (prefix) => {
			const completions = [
				...(getAgentsArgumentCompletions(prefix, (ownerAdmission === "admitted" || preadmissionRepair) ? { includeRepair: true } : undefined) ?? []),
				...(ownerAdmission && "diagnostics".startsWith(prefix.trim()) ? [{ value: "diagnostics", label: "diagnostics" }] : []),
				...(admittedOwnerView && "models".startsWith(prefix.trim()) ? [{ value: "models", label: "models" }] : []),
			];
			return completions.length ? completions : null;
		},
		handler: async (args, ctx) => {
			if (ownerAdmission && args.trim() === "diagnostics") {
				if (ctx.mode !== "tui") return;
				const repairHost = admissionFailure ? preadmissionRepair?.() : undefined;
				const ownerHost = admissionFailure ? undefined : admittedOwnerView?.();
				const activeHost = repairHost ?? ownerHost;
				await openOwnerDiagnostics(ctx.ui, admissionFailure, {
          onRepair: activeHost ? async (ownerTui: TUI) => {
            let receipt;
            try {
              receipt = await activeHost.requestManualRepair(validateManualRepairReason(undefined));
            } catch (error) {
              ctx.ui.notify("Repair Moderator failed: " + (error instanceof Error ? error.message : String(error)), "error");
              throw error;
            }
            ctx.ui.notify("Repair Moderator " + receipt.disposition + ": " + receipt.moderatorAgentId, "info");
            try {
              const surface = await prepareAndBindRepairModerator(activeHost, receipt.moderatorAgentId, {
                ownerTui,
                requestShutdown: () => ctx.shutdown(),
                startPhysical: repairDeps?.startRepairSurface,
              });
              if (surface) {
                void surface.closed.catch((error) => {
                  ctx.ui.notify("Agent view failed: " + (error instanceof Error ? error.message : String(error)), "error");
                });
              }
            } catch (error) {
              ctx.ui.notify("Repair view failed: " + (error instanceof Error ? error.message : String(error)), "error");
              throw error;
            }
          } : undefined,
					// Esc aborts the in-flight repair step only and preserves trigger
					// authority; explicit cancel (deliberate intent) is the path that clears.
					onEsc: activeHost ? () => activeHost.notifyRepairHumanInput("esc").catch((error) => { ctx.ui.notify("Repair interrupt failed: " + (error instanceof Error ? error.message : String(error)), "error"); }) : undefined,
				});
				return;
			}
			if (admittedOwnerView && args.trim() === "models") {
				if (ctx.mode !== "tui") return;
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
				const mode = (() => { try { return parseAgentsCommandArgument(args); } catch { return "selector"; } })();
				if (mode === "repair" && preadmissionRepair) {
					const host = preadmissionRepair();
					try {
						const receipt = await host.requestManualRepair(validateManualRepairReason(parseAgentsRepairReason(args)));
						ctx.ui.notify("Repair Moderator " + receipt.disposition + ": " + receipt.moderatorAgentId, "info");
						try {
                            const surface = await swapRepairViaTransientOverlay(ctx.ui, host, receipt.moderatorAgentId, () => ctx.shutdown(), repairDeps?.startRepairSurface);
                            if (surface) {
                              void surface.closed.catch((error) => {
                                ctx.ui.notify("Agent view failed: " + (error instanceof Error ? error.message : String(error)), "error");
                              });
                            }
						} catch (error) {
						  ctx.ui.notify("Repair view failed: " + (error instanceof Error ? error.message : String(error)), "error");
						}
					} catch (error) {
						ctx.ui.notify("Repair failed: " + (error instanceof Error ? error.message : String(error)), "error");
					}
					return;
				}
				if (preadmissionRepair) {
					if (ctx.mode !== "tui") return;
					const host = preadmissionRepair();
					if (mode === "owner") {
						try {
							const entry = host.repairedOwnerEntry();
							const stage = entry?.stage === "admission-pending" ? "admission-pending" : "snapshot-only";
							if (stage === "admission-pending") {
								await host.admitRepairedOwner();
								const admitted = host.repairedOwnerEntry();
								ctx.ui.notify("Repaired Owner admission-pending acknowledged idle until human message: " + (admitted?.ownerId ?? host.status().agentId), "info");
							} else {
								ctx.ui.notify("Repaired Owner is available after repair completes: " + (entry?.ownerId ?? host.status().agentId), "info");
							}
						} catch (error) {
							ctx.ui.notify("Repaired Owner view failed: " + (error instanceof Error ? error.message : String(error)), "error");
						}
					}
					try {
						await openPreadmissionRepairSelector(ctx.ui, host);
					} catch (error) {
						ctx.ui.notify("Agent view failed: " + (error instanceof Error ? error.message : String(error)), "error");
					}
					return;
				}
				ctx.ui.notify("Subagent coordination is unavailable. Use /agents diagnostics.", "warning");
				return;
			}
			const commandMode = parseAgentsCommandArgument(args);
			if (commandMode === "repair") {
				if (!ownerAdmission) throw new Error(AGENTS_COMMAND_USAGE);
				const repairView = resolveView();
				let receipt;
				try {
					receipt = await repairView.requestManualRepair(
						validateManualRepairReason(parseAgentsRepairReason(args)),
					);
				} catch (error) {
					ctx.ui.notify(
						"Repair Moderator failed: " + (error instanceof Error ? error.message : String(error)),
						"error",
					);
					return;
				}
				ctx.ui.notify(
					receipt.disposition === "created"
						? "Repair Moderator created: " + receipt.moderatorAgentId
						: "Repair Moderator already active: " + receipt.moderatorAgentId,
					"info",
				);
				try {
                    const ownerTui = await captureRepairOwnerTui(ctx.ui);
                    const surface = await prepareAndBindRepairModerator(repairView, receipt.moderatorAgentId, {
                      ownerTui,
                      requestShutdown: () => ctx.shutdown(),
                      startPhysical: repairDeps?.startRepairSurface,
                    });
                    if (surface) {
                      void surface.closed.catch((error) => {
                        ctx.ui.notify("Agent view failed: " + (error instanceof Error ? error.message : String(error)), "error");
                      });
                    }
				} catch (error) {
					ctx.ui.notify(
						"Repair view failed: " + (error instanceof Error ? error.message : String(error)),
						"error",
					);
				}
				return;
			}
			if (ownerAdmission && args.trim() && args.trim() !== "owner") {
				throw new Error(AGENTS_COMMAND_USAGE);
			}
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
			repairValidate: (toolCallId, input) => moderatorView().repairValidate(toolCallId, input),
			repairFreeze: (toolCallId, input) => moderatorView().repairFreeze(toolCallId, input),
			repairCommit: (toolCallId, input) => moderatorView().repairCommit(toolCallId, input),
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
