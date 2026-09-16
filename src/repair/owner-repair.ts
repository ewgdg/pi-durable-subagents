import type { AgentSession, ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { InteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import { isOwnerAdmitted, ownerRetirementFor } from "../bootstrap/owner-bootstrap.ts";
import type { OwnerRecoveryError } from "../bootstrap/owner-recovery-error.ts";
import { workflowSessionDirectory } from "../runtime/workflow-session-directory.ts";
import { captureAgentCreationPreset, selectAgentTemplateForCreation } from "../templates/agent-templates.ts";
import { defaultAgentTemplateRoots, discoverAgentTemplates } from "../templates/agent-template-discovery.ts";
import { launchRepairHelper, type IndependentRepairHelper } from "./helper-process.ts";
import { createRepairHost, readRepairHost, type RepairHost } from "./repair-host.ts";
import { readRepairArchiveLaunch, writeRepairRecord, type RepairLaunch } from "./repair-launch.ts";
import { runSameTerminalRepair, type RepairOutcome } from "./same-terminal-repair.ts";
import { readRepairOwnerIdentity } from "./workflow-validation.ts";
import { closeRepairInput } from "./input-retirement.ts";
import { clearAbandonedRepairLease, recoverRepair } from "./storage.ts";
import { openRepairDiagnostics } from "../presentation/repair-diagnostics-surface.ts";
import { sanitizeReportTerminalText } from "../presentation/moderator-report-surface.ts";

type Attempt = {
	launch: RepairLaunch; directory: string; hostPath: string; helper: IndependentRepairHelper;
	ui: ExtensionUIContext; running: boolean; outcome?: RepairOutcome;
};
const REGISTRY_KEY = "__piAgentCoordinationRepairAttempts";
const registry = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<string, Attempt>;
	__piAgentCoordinationRepairRecoverySwitches?: WeakMap<object, string> };
const attempts = registry[REGISTRY_KEY] ??= new Map();
const recoverySwitches = registry.__piAgentCoordinationRepairRecoverySwitches ??= new WeakMap();

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
	if (!attempt || !target || !attempt.running) return false;
	const source = ctx.sessionManager.getSessionFile();
	return source === attempt.launch.owner.path && target === attempt.hostPath ||
		source === attempt.hostPath && target === attempt.launch.owner.path;
}

export function presentRepairHost(ctx: ExtensionContext, host: RepairHost): () => void {
	const attempt = findAttempt(host.ownerPath, host.attemptId);
	if (attempt) attempt.ui = ctx.ui;
	ctx.ui.setStatus("workflow-repair", "Workflow repair host · Owner writers retired or awaiting retirement verification");
	ctx.ui.setWidget("workflow-repair", [
		"Workflow repair — this is not an Owner Workflow.",
		`Original Owner: ${host.ownerPath}`,
		`Diagnostics: ${dirname(host.bootstrapPath)}`,
		"Esc cancels before application. Ordinary input is paused during repair.",
		"/agents repair · /agents repair cancel · /agents repair recover",
		"After a crash: stop ALL affected writers and old helper, then /agents repair recover-stopped.",
	]);
	return ctx.ui.onTerminalInput((data) => {
		if (!attempt?.running) return;
		// Native replacement awaits withSession before accepting another command.
		// A raw terminal cancellation stays usable during that awaited handoff.
		if (data === "\u001b") void attempt.helper.request("cancel").catch((error: unknown) => {
			attempt.ui.notify(`Repair cancellation: ${String(error)}`, "warning");
		});
		return { consume: true };
	});
}

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
					try { await ctx.switchSession(attempt.hostPath, { withSession: async (fresh) => { attempt.ui = fresh.ui; } }); }
					finally { attempt.running = false; }
					return;
				}
				if (action === "cancel") { await attempt.helper.request("cancel"); ctx.ui.notify("Repair cancellation requested; no automatic Owner reopening.", "info"); return; }
				if (action === "recover") {
					if (attempt.running) throw new Error("Repair is still running; cancel or await its outcome first");
					if (!host) throw new Error("Recover from the tagged repair-host session, not an already-open Owner");
					const result = await attempt.helper.request("recover") as { safeToReopen?: boolean };
					if (result?.safeToReopen !== true) throw new Error("Recovery did not establish a safe Owner generation");
					attempt.running = true;
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
					} finally { attempt.running = false; }
					if (attempt.outcome === "admitted") await attempt.helper.stop();
					return;
				}
				if (action && action !== "inspect") throw new Error("Usage: /agents repair [inspect|cancel|recover|park|recover-stopped]");
				ctx.ui.notify(`Repair ${attempt.launch.attemptId}: ${attempt.running ? "running" : attempt.outcome}.\nOwner: ${attempt.launch.owner.path}\nModerator: ${attempt.launch.moderatorAgentId}\nEvidence: ${attempt.directory}\nStorage: ${attempt.launch.storageRoot}`, "info");
				if (!attempt.running) await openRepairDiagnostics(ctx.ui, attempt.launch, attempt.directory);
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
			if (failure.protocolError.message !== "invariant_violation: Message has duplicate Deliveries") throw new Error("Unsupported transcript admission failure: only exact duplicate Message Delivery envelopes can currently be repaired");
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
			});
			launched = { launch, directory, hostPath, helper, ui: ctx.ui, running: true };
			presentation = launched;
			attempts.set(attemptId, launched);
			closeRepairInput(runtime.session);
			launched.outcome = await runSameTerminalRepair({ context: ctx, ownerPath, repairHostPath: hostPath, retirement,
				admission: (fresh) => isOwnerAdmitted(fresh.sessionManager), helper: {
					async repair() {
						const result = await helper.request("retired") as { status?: string };
						if (result?.status !== "committed") throw new Error("Helper did not acknowledge a durable commit");
					},
					async recordAdmission(admitted, diagnostic) { await helper.request("admission", { admitted, diagnostic, time: new Date().toISOString() }); },
					async refuse(reason) { await helper.request("refuse", reason); },
				} });
			launched.running = false;
			await writeRepairRecord(join(directory, "outcome.json"), { outcome: launched.outcome, time: new Date().toISOString() });
			if (launched.outcome === "admitted") await helper.stop();
		} catch (error) {
			(presentation?.ui ?? ctx.ui).notify(`Repair unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};
}
