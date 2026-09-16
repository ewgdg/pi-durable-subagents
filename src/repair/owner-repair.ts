import type { AgentSession, ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { InteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import { isOwnerAdmitted, ownerRetirementFor } from "../bootstrap/owner-bootstrap.ts";
import type { OwnerRecoveryError } from "../bootstrap/owner-recovery-error.ts";
import { workflowSessionDirectory } from "../runtime/workflow-session-directory.ts";
import { captureAgentCreationPreset, selectAgentTemplateForCreation } from "../templates/agent-templates.ts";
import { defaultAgentTemplateRoots, discoverAgentTemplates } from "../templates/agent-template-discovery.ts";
import { launchRepairHelper, type IndependentRepairHelper } from "./helper-process.ts";
import { createRepairHost, readRepairHost, type RepairHost } from "./repair-host.ts";
import { readRepairArchiveLaunch, writeRepairRecord, isSupportedAdmissionFailureReason, type RepairLaunch } from "./repair-launch.ts";
import { startSameTerminalRepair, type RepairOutcome } from "./same-terminal-repair.ts";
import { readRepairOwnerIdentity } from "./workflow-validation.ts";
import { closeRepairInput } from "./input-retirement.ts";
import { clearAbandonedRepairLease, recoverRepair } from "./storage.ts";
import { openRepairDiagnostics } from "../presentation/repair-diagnostics-surface.ts";
import { sanitizeReportTerminalText } from "../presentation/moderator-report-surface.ts";

type Attempt = {
	launch: RepairLaunch; directory: string; hostPath: string; helper: IndependentRepairHelper;
	ui: ExtensionUIContext; running: boolean; outcome?: RepairOutcome;
	switchTarget?: string;
	liveText: string; liveStatus: string; listeners: Set<() => void>;
	view?: { controller: AbortController; closed: Promise<void> };
};
const REGISTRY_KEY = "__piAgentCoordinationRepairAttempts";
const registry = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<string, Attempt>;
	__piAgentCoordinationRepairRecoverySwitches?: WeakMap<object, string>;
	__piAgentCoordinationRepairHumanWait?: Set<string> };
const attempts = registry[REGISTRY_KEY] ??= new Map();
const recoverySwitches = registry.__piAgentCoordinationRepairRecoverySwitches ??= new WeakMap();
const humanWait = registry.__piAgentCoordinationRepairHumanWait ??= new Set();

export function repairOwnerRequiresHumanInput(ctx: ExtensionContext): boolean {
	return humanWait.has(ctx.sessionManager.getSessionFile() ?? "");
}

export function repairOwnerTurnStarted(ctx: ExtensionContext): void {
	humanWait.delete(ctx.sessionManager.getSessionFile() ?? "");
}

function findAttempt(ownerPath: string, attemptId?: string): Attempt | undefined {
	return [...attempts.values()].reverse().find((attempt) => attempt.launch.owner.path === ownerPath &&
		(attemptId === undefined || attempt.launch.attemptId === attemptId));
}

function currentAttempt(ctx: ExtensionContext): Attempt | undefined {
	const host = readRepairHost(ctx.sessionManager);
	return findAttempt(host?.ownerPath ?? ctx.sessionManager.getSessionFile() ?? "", host?.attemptId);
}

export function isRepairPaused(ctx: ExtensionContext): boolean {
	if (readRepairHost(ctx.sessionManager)) return true;
	const attempt = currentAttempt(ctx);
	return !!attempt && attempt.outcome !== "admitted";
}

export function isRepairSwitchAuthorized(ctx: ExtensionContext, target: string | undefined): boolean {
	if (target && recoverySwitches.get(ctx.sessionManager) === target) return true;
	const attempt = currentAttempt(ctx);
	if (!attempt || !target || !attempt.running || attempt.switchTarget !== target) return false;
	const source = ctx.sessionManager.getSessionFile();
	return source === attempt.launch.owner.path && target === attempt.hostPath ||
		source === attempt.hostPath && target === attempt.launch.owner.path;
}

export function presentRepairHost(ctx: ExtensionContext, host: RepairHost): () => void {
	const attempt = findAttempt(host.ownerPath, host.attemptId);
	if (attempt) { attempt.ui = ctx.ui; attempt.switchTarget = undefined; }
	ctx.ui.setStatus("workflow-repair", "Workflow repair host · Owner writers retired or awaiting retirement verification");
	ctx.ui.setWidget("workflow-repair", [
		"Workflow repair — this is not an Owner Workflow.",
		`Original Owner: ${host.ownerPath}`,
		`Diagnostics: ${dirname(host.bootstrapPath)}`,
		"/agents: live Repair Moderator or read-only Owner snapshot. Ordinary prompts are paused.",
		"/agents repair · /agents repair cancel · /agents repair recover",
		"After a crash: stop ALL affected writers and old helper, then /agents repair recover-stopped.",
	]);
	return ctx.ui.onTerminalInput((data) => {
		if (data !== "\u001b" || !attempt?.running || attempt.view) return;
		void attempt.helper.request("cancel").catch((error: unknown) => attempt.ui.notify(String(error), "warning"));
		return { consume: true };
	});
}

async function inRepairView(attempt: Attempt | undefined, view: (signal: AbortSignal) => Promise<void>): Promise<void> {
	const controller = new AbortController();
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
	if (attempt) attempt.view = { controller, closed };
	try { await view(controller.signal); }
	finally { if (attempt?.view?.controller === controller) attempt.view = undefined; resolveClosed(); }
}

async function inspectAttempt(ctx: ExtensionContext, launch: RepairLaunch | Awaited<ReturnType<typeof readRepairArchiveLaunch>>, directory: string, attempt: Attempt | undefined, page = 2): Promise<void> {
	await inRepairView(attempt, (signal) => openRepairDiagnostics(ctx.ui, launch, directory, { page, signal,
		...(attempt ? { liveText: () => `${attempt.liveText}\n${attempt.liveStatus}`, subscribe: (refresh: () => void) => {
			attempt.listeners.add(refresh); return () => { attempt.listeners.delete(refresh); };
		} } : {}),
	}));
}

/** Presentation-only identities never enter ordinary Agent routing or scheduling. */
export const repairNavigation = {
	async host(ctx: ExtensionCommandContext, owner: boolean): Promise<boolean> {
		const host = readRepairHost(ctx.sessionManager);
		if (!host) return false;
		const launch = await readRepairArchiveLaunch(host.bootstrapPath);
		const attempt = findAttempt(host.ownerPath, host.attemptId);
		let page: number | undefined = owner ? 1 : undefined;
		if (!owner) await inRepairView(attempt, async (signal) => {
			const selected = await ctx.ui.select("Workflow repair · read-only navigation", ["Repair Moderator · live transcript", "Owner · immutable snapshot"], { signal });
			if (selected) page = selected.startsWith("Owner") ? 1 : 2;
		});
		if (page !== undefined) await inspectAttempt(ctx, launch, dirname(host.bootstrapPath), attempt, page);
		return true;
	},
	async entries(ctx: ExtensionCommandContext) {
		const path = ctx.sessionManager.getSessionFile();
		const entries = [...attempts.values()].filter((attempt) => attempt.launch.owner.path === path).map((attempt) => ({
			id: `repair:${attempt.launch.attemptId}`, label: "Repair Moderator", description: `${attempt.running ? "Running" : attempt.outcome} · read-only · ${attempt.launch.moderatorAgentId}`,
			open: () => inspectAttempt(ctx, attempt.launch, attempt.directory, attempt),
		}));
		if (!path) return entries;
		const hosts = join(dirname(path), "pi-agent-coordination-repair", Buffer.from(ctx.sessionManager.getSessionId()).toString("base64url"), "hosts");
		const directories = await readdir(hosts).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
		for (const id of directories) {
			if (entries.some(entry => entry.id === `repair:${id}`)) continue;
			const directory = join(hosts, id);
			const launch = await readRepairArchiveLaunch(join(directory, "launch.json"));
			if (launch.attemptId !== id || launch.owner.path !== path || launch.owner.workflowId !== ctx.sessionManager.getSessionId()) continue;
			entries.push({ id: `repair:${id}`, label: "Repair Moderator", description: `Archived · read-only · ${launch.moderatorAgentId}`,
				open: () => inspectAttempt(ctx, launch, directory, undefined) });
		}
		return entries;
	},
};

export function ownerRepairCommand(bridge: InteractiveHostBridge, admissionFailure: (manager: object) => OwnerRecoveryError | undefined) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		let presentation: Attempt | undefined;
		try {
			if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Workflow repair requires the original interactive CLI terminal");
			const action = args.trim();
			let attempt = currentAttempt(ctx);
			const host = readRepairHost(ctx.sessionManager);
			// Keep historical inspection bound to its attempt; a bare invocation must
			// independently establish a new admission blocker, never normalize history.
			if (!action && !host && attempt?.outcome === "admitted" && !attempt.running) attempt = undefined;
			if (action === "recover-stopped") {
				if (!host) throw new Error("Recover-stopped is only available in the tagged repair host. Use /agents repair park after a failed attempt.");
				if (attempt?.running) throw new Error("An attempt is still running in this host; cancel or await it first");
				const launch = await readRepairArchiveLaunch(host.bootstrapPath);
				if (launch.attemptId !== host.attemptId || launch.owner.path !== host.ownerPath) throw new Error("Repair host and durable launch disagree");
				// This explicit exceptional command attests ALL affected writers stopped.
				// It does not invent a retirement ACK or authorize a new snapshot/model.
				const evidence = "operator-attested: recover-stopped invocation attests old helper and all affected transcript writers have been stopped";
				if (attempt) await attempt.helper.stop();
				const observedHelperExit = attempt ? await attempt.helper.exited : undefined;
				await writeRepairRecord(join(dirname(host.bootstrapPath), "recovery.jsonl"), { time: new Date().toISOString(), kind: "operator-attested", evidence,
					...(observedHelperExit ? { helperRetirement: { kind: "observed-exit", ...observedHelperExit } } : {}) }, true);
				const leaseExists = await lstat(join(launch.storageRoot, "lease")).then(() => true, (error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return false; throw error;
				});
				if (leaseExists) await clearAbandonedRepairLease({ root: launch.storageRoot, helperRetirement: { verified: true, evidence } });
				await recoverRepair({ root: launch.storageRoot, attemptId: launch.attemptId, ownerPath: launch.owner.path, participantDirectory: launch.participantDirectory });
				const retiredManager = ctx.sessionManager;
				humanWait.add(launch.owner.path);
				recoverySwitches.set(retiredManager, launch.owner.path);
				try {
					const transition = await ctx.switchSession(launch.owner.path, { withSession: async (fresh) => {
						const admitted = isOwnerAdmitted(fresh.sessionManager);
						if (attempt) { attempt.ui = fresh.ui; attempt.outcome = admitted ? "admitted" : "committed_admission_failed"; }
						try { await writeRepairRecord(join(dirname(host.bootstrapPath), "admission.jsonl"), { admitted, recovery: "operator-attested" }, true); }
						catch (error) { fresh.ui.notify(`Recovery diagnostics could not be recorded: ${String(error)}`, "error"); }
						fresh.ui.notify(admitted ? "Owner reopened after operator-mediated recovery. Participants remain dormant." : "Recovered disk state retained; Owner admission still failed.", admitted ? "info" : "error");
					} });
					if (transition.cancelled) throw new Error("Recovery reopening cancelled");
				} finally { recoverySwitches.delete(retiredManager); }
				return;
			}
			if (attempt) {
				presentation = attempt;
				attempt.ui = ctx.ui;
				if (action === "park") {
					if (attempt.running || host) throw new Error("Park is only available after a refused attempt still attached to its old Owner");
					attempt.running = true;
					attempt.switchTarget = attempt.hostPath;
					try { await ctx.switchSession(attempt.hostPath, { withSession: async (fresh) => { attempt.ui = fresh.ui; } }); }
					finally { attempt.running = false; attempt.switchTarget = undefined; }
					return;
				}
				if (action === "cancel") { await attempt.helper.request("cancel"); ctx.ui.notify("Repair cancellation requested; no automatic Owner reopening.", "info"); return; }
				if (action === "recover") {
					if (attempt.running) throw new Error("Repair is still running; cancel or await its outcome first");
					if (!host) throw new Error("Recover from the tagged repair-host session, not an already-open Owner");
					const result = await attempt.helper.request("recover") as { safeToReopen?: boolean };
					if (result?.safeToReopen !== true) throw new Error("Recovery did not establish a safe Owner generation");
					attempt.running = true;
					humanWait.add(attempt.launch.owner.path);
					attempt.switchTarget = attempt.launch.owner.path;
					try {
						const transition = await ctx.switchSession(attempt.launch.owner.path, { withSession: async (fresh) => {
							attempt.ui = fresh.ui;
							const admitted = isOwnerAdmitted(fresh.sessionManager);
							attempt.outcome = admitted ? "admitted" : "committed_admission_failed";
							try { await attempt.helper.request("admission", { admitted, recovery: true }); }
							catch (error) { fresh.ui.notify(`Recovery diagnostics: ${String(error)}`, "error"); }
							fresh.ui.notify(admitted ? "Owner reopened after explicit recovery. Participants remain dormant." : "Recovery completed, but fresh Owner admission failed. Committed data remains intact.", admitted ? "info" : "error");
						} });
						if (transition.cancelled) throw new Error("Recovery reopening cancelled");
					} finally { attempt.running = false; attempt.switchTarget = undefined; }
					if (attempt.outcome === "admitted") await attempt.helper.stop();
					return;
				}
				if (action && action !== "inspect") throw new Error("Usage: /agents repair [inspect|cancel|recover|park|recover-stopped]");
				ctx.ui.notify(`Repair ${attempt.launch.attemptId}: ${attempt.running ? "running" : attempt.outcome}.\nOwner: ${attempt.launch.owner.path}\nModerator: ${attempt.launch.moderatorAgentId}\nEvidence: ${attempt.directory}\nStorage: ${attempt.launch.storageRoot}`, "info");
				await inspectAttempt(ctx, attempt.launch, attempt.directory, attempt, 0);
				return;
			}
			if (host) {
				const launch = await readRepairArchiveLaunch(host.bootstrapPath);
				ctx.ui.notify(`Unfinished or archived repair ${launch.attemptId}.\nEvidence: ${dirname(host.bootstrapPath)}\nNo retained helper exit evidence. Stop the old helper AND all affected transcript writers, then invoke /agents repair recover-stopped. This operator attestation recovers/cancels the existing journal only; it never starts new repair work.`, "warning");
				await openRepairDiagnostics(ctx.ui, launch, dirname(host.bootstrapPath));
				return;
			}
			if (action) throw new Error("No repair attempt in this attachment. Invoke /agents repair to authorize one attempt.");
			if (isOwnerAdmitted(ctx.sessionManager)) {
				ctx.ui.notify("No repair needed: Owner admission succeeded. Rejected historical records remain unchanged.", "info");
				return;
			}
			const failure = admissionFailure(ctx.sessionManager);
			if (!failure) throw new Error("Transcript repair is unavailable: no actual transcript admission failure is retained. Configuration, model, and cleanup failures require their own diagnostics.");
			if (failure.agentId !== ctx.sessionManager.getSessionId() || failure.transcriptPath !== ctx.sessionManager.getSessionFile()) throw new Error("Admission failure does not belong to this exact Owner session");
			if (!isSupportedAdmissionFailureReason(failure.protocolError.message)) throw new Error("Unsupported transcript admission failure: only exact duplicate Message Delivery envelopes can currently be repaired");
			if (process.platform === "win32") throw new Error("Workflow repair currently requires POSIX file durability; Windows is not supported");
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (!sessionPath) throw new Error("Repair requires a persisted Owner transcript");
			const ownerPath = await realpath(sessionPath);
			if (ownerPath !== sessionPath) throw new Error("Repair requires the canonical Owner transcript path");
			const owner = readRepairOwnerIdentity(await readFile(ownerPath, "utf8"), ownerPath);
			if (owner.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Persisted Owner identity does not match the active native session");
			const retirement = ownerRetirementFor(ctx.sessionManager);
			const { runtime } = await bridge.capture(ctx.sessionManager as AgentSession["sessionManager"], ctx.ui);
			const preset = captureAgentCreationPreset(selectAgentTemplateForCreation(await discoverAgentTemplates(defaultAgentTemplateRoots({
				packageRoot: resolve(import.meta.dirname, "../.."), agentDir: runtime.services.agentDir,
				parentCwd: ctx.cwd, projectTrusted: runtime.services.settingsManager.isProjectTrusted(),
			})), "moderator"));
			const candidate = preset?.models?.find(({ model }) => runtime.services.modelRuntime.getAvailableSnapshot().some((item) => item.provider === model.provider && item.id === model.modelId));
			if (preset?.models && !candidate) throw new Error("No configured Moderator model is available");
			const model = candidate?.model ?? (runtime.session.model && { provider: runtime.session.model.provider, modelId: runtime.session.model.id });
			if (!model) throw new Error("No repair Moderator model is available");
			const root = join(dirname(ownerPath), "pi-agent-coordination-repair", Buffer.from(owner.workflowId).toString("base64url"));
			const attemptId = randomUUID();
			const directory = join(root, "hosts", attemptId);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const participantDirectory = workflowSessionDirectory(ctx.sessionManager.getSessionDir(), owner.workflowId);
			await mkdir(participantDirectory, { recursive: true, mode: 0o700 });
			const launch: RepairLaunch = { version: 1, attemptId, moderatorAgentId: randomUUID(), owner: { path: ownerPath, workflowId: owner.workflowId, sessionId: owner.sessionId, identityEntryId: owner.identityEntryId },
				admissionFailure: { stage: failure.stage, reason: failure.protocolError.message, transcriptPath: ownerPath, agentId: failure.agentId },
				storageRoot: join(root, "storage"), participantDirectory, cwd: ctx.cwd, agentDir: runtime.services.agentDir,
				model, thinking: candidate?.thinking ?? runtime.session.thinkingLevel, creationPreset: preset };
			const bootstrapPath = join(directory, "launch.json");
			await writeRepairRecord(bootstrapPath, launch);
			const moderatorPath = join(directory, "moderator.jsonl");
			await writeFile(moderatorPath, JSON.stringify({ type: "session", version: 3, id: launch.moderatorAgentId, timestamp: new Date().toISOString(), cwd: ctx.cwd }) + "\n", { flag: "wx", mode: 0o600 });
			const hostPath = await createRepairHost({ directory, cwd: ctx.cwd, ownerPath, attemptId, bootstrapPath });
			let launched: Attempt | undefined;
			const helper = await launchRepairHelper({ cwd: ctx.cwd, agentDir: launch.agentDir,
				extensionPath: join(import.meta.dirname, "helper-entry.ts"), bootstrapPath, sessionPath: moderatorPath,
				logDirectory: directory, model: `${model.provider}/${model.modelId}`, thinking: launch.thinking,
				onProgress: (message) => launched?.ui.setWidget("workflow-repair-progress", [sanitizeReportTerminalText(message), `Evidence: ${directory}`]),
				onActivity: (text, status) => {
					if (!launched) return;
					if (status) launched.liveStatus = text;
					else { launched.liveStatus = ""; launched.liveText = (launched.liveText + text).slice(-200_000); }
					launched.ui.setWidget("workflow-repair-live", ["Repair Moderator · streaming (read-only)", sanitizeReportTerminalText(launched.liveStatus || launched.liveText.slice(-240))]);
					for (const refresh of launched.listeners) refresh();
				},
			});
			launched = { launch, directory, hostPath, helper, ui: ctx.ui, running: true, switchTarget: hostPath, liveText: "", liveStatus: "", listeners: new Set() };
			presentation = launched;
			attempts.set(attemptId, launched);
			closeRepairInput(runtime.session);
			const started = await startSameTerminalRepair({ context: ctx, ownerPath, repairHostPath: hostPath, retirement,
				beforeReopen: async () => {
					const view = launched?.view; view?.controller.abort(); await view?.closed;
					humanWait.add(ownerPath);
					if (launched) launched.switchTarget = ownerPath;
				},
				admission: (fresh) => isOwnerAdmitted(fresh.sessionManager), helper: {
					async repair() {
						const result = await helper.request("retired") as { status?: string };
						if (result?.status !== "committed") throw new Error("Helper did not acknowledge a durable commit");
					},
					async recordAdmission(admitted, diagnostic) { await helper.request("admission", { admitted, diagnostic, time: new Date().toISOString() }); },
					async refuse(reason) { await helper.request("refuse", reason); },
				} });
			const active = launched;
			void started.completion.then(async (outcome) => {
				active.outcome = outcome;
				active.running = false;
				active.switchTarget = undefined;
				await writeRepairRecord(join(directory, "outcome.json"), { outcome, time: new Date().toISOString() });
				if (outcome === "admitted") await helper.stop();
			}).catch((error: unknown) => { active.running = false; active.ui.notify(`Repair completion: ${String(error)}`, "error"); });
		} catch (error) {
			(presentation?.ui ?? ctx.ui).notify(`Repair unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};
}
