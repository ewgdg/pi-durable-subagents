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
import { openAgentViewSurface, type DurableAgentView } from "../presentation/agent-view-surface.ts";

type Attempt = {
	launch: RepairLaunch; directory: string; hostPath: string; helper: IndependentRepairHelper;
	ui: ExtensionUIContext; running: boolean; outcome?: RepairOutcome;
	switchTarget?: string;
	context?: ExtensionCommandContext;
	ended?: boolean;
	attachment?: { close(): void; closed: Promise<void> };
	recover?(action: string): Promise<void>;
	view?: { controller: AbortController; closed: Promise<void> };
};
const REGISTRY_KEY = "__piAgentCoordinationRepairAttempts";
const registry = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<string, Attempt>;
	__piAgentCoordinationRepairRecoverySwitches?: WeakMap<object, string>;
	__piAgentCoordinationRepairHumanWait?: Set<string>;
	__piAgentCoordinationRepairLifetime?: { closing: boolean; shutdown?: Promise<void>;
		launches: Set<Promise<IndependentRepairHelper>>;
		helpers: Map<IndependentRepairHelper, string> } };
const attempts = registry[REGISTRY_KEY] ??= new Map();
const recoverySwitches = registry.__piAgentCoordinationRepairRecoverySwitches ??= new WeakMap();
const humanWait = registry.__piAgentCoordinationRepairHumanWait ??= new Set();
const lifetime: NonNullable<typeof registry.__piAgentCoordinationRepairLifetime> = registry.__piAgentCoordinationRepairLifetime ??= { closing: false, launches: new Set(), helpers: new Map() };

/** Original CLI lifetime owns helpers; replacing/reloading an Owner does not. */
export function shutdownRepairHelpers(): Promise<void> {
	return lifetime.shutdown ??= (async () => {
		lifetime.closing = true;
		// A launch has a bounded admission path and joins its own failed process.
		// Its continuation registers a successful helper before this join resumes.
		await Promise.allSettled([...lifetime.launches]);
		const results = await Promise.allSettled([...lifetime.helpers].map(async ([helper, directory]) => {
			try {
				await helper.shutdown();
				const exit = await helper.exited;
				await writeRepairRecord(join(directory, "helper-exit.json"), { kind: "observed-exit", ...exit });
			} catch (error) {
				await writeRepairRecord(join(directory, "helper-shutdown-error.jsonl"), { error: String(error) }, true);
				throw error;
			}
		}));
		const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
		if (errors.length) throw new AggregateError(errors, "Independent repair helper shutdown failed");
	})();
}

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
		"/agents: interactive Repair Moderator. /agents owner: Owner (snapshot until commit).",
		"/agents repair · /agents repair cancel · /agents repair recover",
		"After a crash: stop ALL affected writers and old helper, then /agents repair recover-stopped.",
	]);
	return () => {};
}

async function inRepairView(attempt: Attempt | undefined, view: (signal: AbortSignal) => Promise<void>): Promise<void> {
	const controller = new AbortController();
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
	if (attempt) attempt.view = { controller, closed };
	try { await view(controller.signal); }
	finally { if (attempt?.view?.controller === controller) attempt.view = undefined; resolveClosed(); }
}

async function inspectAttempt(ctx: ExtensionContext, launch: RepairLaunch | Awaited<ReturnType<typeof readRepairArchiveLaunch>>, directory: string, attempt: Attempt | undefined, page = 2, signal?: AbortSignal): Promise<void> {
	const inspect = (signal: AbortSignal) => openRepairDiagnostics(ctx.ui, launch, directory, { page, signal });
	if (signal) await inspect(signal);
	else await inRepairView(attempt, inspect);
}

async function detachModerator(attempt: Attempt): Promise<void> {
	const attachment = attempt.attachment;
	attachment?.close();
	await attachment?.closed;
}

async function openModerator(ctx: ExtensionCommandContext, attempt: Attempt): Promise<void> {
	if (attempt.ended) return inspectAttempt(ctx, attempt.launch, attempt.directory, undefined);
	if (attempt.attachment) return;
	attempt.context = ctx;
	attempt.ui = ctx.ui;
	const closeHandlers = new Set<() => void>();
	let closed = false;
	const close = () => { closed = true; for (const handler of closeHandlers) handler(); };
	const view: DurableAgentView = {
		agentId: attempt.launch.moderatorAgentId, label: "Repair Moderator",
		projection: () => attempt.helper.projection,
		addPresentationHandler: () => () => {},
		addCloseHandler(handler) { closeHandlers.add(handler); if (closed) queueMicrotask(handler); return () => { closeHandlers.delete(handler); }; },
		fail(error) { ctx.ui.notify(`Repair terminal: ${String(error)}`, "error"); },
		async close() {},
	};
	const display = openAgentViewSurface(ctx.ui, view);
	const attachment = { close, closed: display };
	attempt.attachment = attachment;
	try { await display; }
	finally { if (attempt.attachment === attachment) attempt.attachment = undefined; }
}

/** The user selects Owner; a committed generation is never reopened by model completion. */
async function selectRepairOwner(ctx: ExtensionCommandContext, attempt: Attempt): Promise<void> {
	await detachModerator(attempt);
	if (!readRepairHost(ctx.sessionManager)) return;
	if (attempt.outcome !== "committed_awaiting_admission" && attempt.outcome !== "committed_admission_failed" && attempt.outcome !== "admitted") {
		await inspectAttempt(ctx, attempt.launch, attempt.directory, attempt, 1);
		return;
	}
	if (attempt.switchTarget) throw new Error("Owner navigation is already in progress");
	attempt.running = true;
	attempt.switchTarget = attempt.launch.owner.path;
	humanWait.add(attempt.launch.owner.path);
	try {
		const result = await ctx.switchSession(attempt.launch.owner.path, { withSession: async fresh => {
			attempt.context = fresh; attempt.ui = fresh.ui;
			const admitted = isOwnerAdmitted(fresh.sessionManager);
			attempt.outcome = admitted ? "admitted" : "committed_admission_failed";
			try {
				await attempt.helper.request("admission", { admitted, time: new Date().toISOString() });
				await writeRepairRecord(join(attempt.directory, "admission-outcome.jsonl"), { outcome: attempt.outcome }, true);
			} catch (error) { fresh.ui.notify(`Admission diagnostics: ${String(error)}`, "error"); }
			fresh.ui.notify(admitted ? "Owner reopened idle. Send a new message to continue." : "Repair committed; fresh Owner admission failed. Data remains intact.", admitted ? "info" : "error");
		} });
		if (result.cancelled) throw new Error("Owner reopening cancelled");
	} finally { attempt.running = false; attempt.switchTarget = undefined; }
}

async function navigateFromModerator(attempt: Attempt, target: "owner" | "inspect" | "cancel" | "recover" | "recover-stopped"): Promise<void> {
	const ctx = attempt.context;
	if (!ctx) throw new Error("Repair presenter is not attached");
	if (target === "cancel") { await attempt.helper.request("cancel"); return; }
	await detachModerator(attempt);
	if (target === "recover" || target === "recover-stopped") { await attempt.recover?.(target); return; }
	if (target === "owner") await selectRepairOwner(ctx, attempt);
	else await inspectAttempt(ctx, attempt.launch, attempt.directory, attempt, 0);
	// Snapshot/audit inspection returns to the same native conversation, not a new turn.
	if (attempt.context === ctx && (target === "inspect" || readRepairHost(ctx.sessionManager))) {
		void openModerator(ctx, attempt).catch(error => ctx.ui.notify(String(error), "error"));
	}
}

/** Presentation-only identities never enter ordinary Agent routing or scheduling. */
export const repairNavigation = {
	async host(ctx: ExtensionCommandContext, owner: boolean): Promise<boolean> {
		const host = readRepairHost(ctx.sessionManager);
		if (!host) return false;
		const attempt = findAttempt(host.ownerPath, host.attemptId);
		if (attempt && !attempt.ended) {
			attempt.context = ctx;
			if (owner) await selectRepairOwner(ctx, attempt);
			else await openModerator(ctx, attempt);
			return true;
		}
		await inRepairView(attempt, async (signal) => {
			const launch = await readRepairArchiveLaunch(host.bootstrapPath);
			if (signal.aborted) return;
			let page: number | undefined = owner ? 1 : undefined;
			if (!owner) {
				const selected = await ctx.ui.select("Archived repair · read-only navigation", ["Repair Moderator · archived transcript", "Owner · immutable snapshot"], { signal });
				if (selected) page = selected.startsWith("Owner") ? 1 : 2;
			}
			if (page !== undefined && !signal.aborted) await inspectAttempt(ctx, launch, dirname(host.bootstrapPath), attempt, page, signal);
		});
		return true;
	},
	async entries(ctx: ExtensionCommandContext) {
		const path = ctx.sessionManager.getSessionFile();
		const entries = [...attempts.values()].filter((attempt) => attempt.launch.owner.path === path).map((attempt) => ({
			id: `repair:${attempt.launch.attemptId}`, label: "Repair Moderator", description: `${attempt.running ? "Running" : attempt.outcome} · ${attempt.ended ? "archived" : "interactive"} · ${attempt.launch.moderatorAgentId}`,
			open: () => openModerator(ctx, attempt),
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
			if (lifetime.closing) throw new Error("Original CLI is shutting down");
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
			const launching = launchRepairHelper({ cwd: ctx.cwd, agentDir: launch.agentDir,
				extensionPath: join(import.meta.dirname, "helper-entry.ts"), bootstrapPath, sessionPath: moderatorPath,
				logDirectory: directory, model: `${model.provider}/${model.modelId}`, thinking: launch.thinking,
				onProgress: (message) => launched?.ui.setWidget("workflow-repair-progress", [sanitizeReportTerminalText(message), `Evidence: ${directory}`]),
				onNavigate: async target => { if (!launched) throw new Error("Repair is not attached"); await navigateFromModerator(launched, target); },
			});
			lifetime.launches.add(launching);
			let helper: IndependentRepairHelper;
			try { helper = await launching; lifetime.helpers.set(helper, directory); }
			finally { lifetime.launches.delete(launching); }
			if (lifetime.closing) throw new Error("Original CLI shut down during repair helper startup");
			launched = { launch, directory, hostPath, helper, ui: ctx.ui, running: true, switchTarget: hostPath };
			presentation = launched;
			attempts.set(attemptId, launched);
			closeRepairInput(runtime.session);
			const started = await startSameTerminalRepair({ context: ctx, repairHostPath: hostPath, retirement, helper: {
					async repair() {
						const result = await helper.request("retired") as { status?: string };
						if (result?.status !== "committed") throw new Error("Helper did not acknowledge a durable commit");
					},
					async refuse(reason) { await helper.request("refuse", reason); },
				} });
			const active = launched;
			active.recover = async action => {
				if (!active.context) throw new Error("Repair presenter is unavailable");
				await ownerRepairCommand(bridge, admissionFailure)(action, active.context);
			};
			void started.completion.then(async (outcome) => {
				active.outcome = outcome;
				active.running = false;
				active.switchTarget = undefined;
				await writeRepairRecord(join(directory, "outcome.json"), { outcome, time: new Date().toISOString() });
			}).catch((error: unknown) => { active.running = false; active.ui.notify(`Repair completion: ${String(error)}`, "error"); });
			void helper.exited.then(() => { active.ended = true; }, () => { active.ended = true; });
			if (started.context) await openModerator(started.context, active);
		} catch (error) {
			(presentation?.ui ?? ctx.ui).notify(`Repair unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};
}
