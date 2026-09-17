import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getKeybindings, isKeyRelease } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { REPAIR_BOOTSTRAP_ENV, REPAIR_TOOL_NAMES } from "./helper-process.ts";
import { connectRepairControl } from "./helper-control.ts";
import { writeRepairRecord } from "./repair-launch.ts";
import { createRepairSnapshot, recoverRepair, type RepairSnapshot } from "./storage.ts";
import { validateRepairProposal, readRepairOwnerIdentity, prepareDuplicateDeliveryRepair } from "./workflow-validation.ts";
import { ProposalSettlementGate } from "./proposal-settlement.ts";
import { captureInteractivePresentation, type InteractivePresentation } from "../pi-integration/interactive-presentation.ts";

/** The native TUI has already framed keys; protocol replies/paste are not submissions. */
export function isRepairProposalRevocationInput(data: string): boolean {
	if (isKeyRelease(data)) return false;
	const keys = getKeybindings();
	return keys.matches(data, "tui.input.submit") || keys.matches(data, "app.message.followUp") || keys.matches(data, "app.interrupt");
}

/** Native compaction owns a second editor queue that input hooks cannot drain. */
export function createRepairCompactionHandler(gate: ProposalSettlementGate, isCommitted: () => boolean) {
	return (_event: SessionBeforeCompactEvent, ctx: ExtensionContext): { cancel: true } | undefined => {
		if (isCommitted()) return;
		gate.revokeCompletion();
		ctx.ui.notify("Compaction is unavailable until repair commits. The proposal was invalidated; discuss or report complete again without compaction.", "warning");
		return { cancel: true };
	};
}

const REPAIR_PROMPT = `You are a repair-only Moderator belonging to the verified Workflow in your bootstrap.
The Owner actually failed transcript admission. Inspect the immutable full Workflow snapshots and the retained admission failure.
The ONLY supported correction is removal of redundant exact copies of valid Message Delivery envelopes. Keep the first copy unchanged, remove only later identical envelopes, and rewire native parentId links only when their parent was a removed duplicate.
Do not repair rejected historical records, add missing fields, turn them into text, or resurrect stale Requests. Preserve every other entry, identity/cutoff, accepted fact, message body, source, ordering and conversation. Ambiguous references, conflicting duplicates, other admission blockers and healthy histories are unsupported.
Use repair_snapshot to list and read immutable inputs, repair_candidate to write complete candidate copies, and repair_report for progress and a final complete/refuse report.
There is no shell, live transcript write, ordinary messaging, spawn, approval, or apply tool. A complete report is a proposal, not permission: the host independently validates and journals the whole Workflow after a successful idle settlement.
You may discuss the proposal with the human before completion. New input, edits, or an aborted turn invalidate an earlier complete report. If validation rejects a proposal, correct it and report complete again.
After commit the conversation remains available for explanation, but candidate changes and further completion reports are disabled. No participant Runs are resumed automatically.`;

/** Independent, resource-restricted stock Pi TUI; control never carries chat output. */
export default async function repairHelperEntry(pi: ExtensionAPI): Promise<void> {
	// A rejected extension factory is discarded by Pi, including its restrictions.
	// Keep a failed bootstrap as a loaded, blocked extension instead. Reload must
	// not reconnect to the one-shot broker before those restrictions are installed.
	let bootstrapAccepted = false;
	let bootstrapFailure = "Repair helper bootstrap did not complete";
	pi.on("input", () => bootstrapAccepted ? undefined : { action: "handled" });
	pi.on("user_bash", () => ({ result: { output: "Shell commands are unavailable in the repair-only Moderator.", exitCode: 1, cancelled: false, truncated: false } }));
	pi.on("session_before_switch", () => ({ cancel: true }));
	pi.on("session_before_fork", () => ({ cancel: true }));
	pi.on("session_before_tree", () => ({ cancel: true }));
	pi.on("session_before_compact", () => bootstrapAccepted ? undefined : { cancel: true });
	pi.on("session_start", (_event, ctx) => {
		if (bootstrapAccepted) return;
		pi.setActiveTools([]);
		ctx.ui.notify(bootstrapFailure, "error");
		ctx.shutdown();
	});
	const lifetime = globalThis as typeof globalThis & { __piRepairHelperStarted?: boolean };
	if (lifetime.__piRepairHelperStarted) {
		bootstrapFailure = "Repair helper reload/reinitialization is unsupported; this attempt was not restarted";
		return;
	}
	lifetime.__piRepairHelperStarted = true;
	const bootstrapPath = process.env[REPAIR_BOOTSTRAP_ENV];
	let connection: Awaited<ReturnType<typeof connectRepairControl>>;
	try {
		if (!bootstrapPath) throw new Error("Repair helper requires its host-owned bootstrap");
		connection = await connectRepairControl(bootstrapPath);
	} catch (error) {
		bootstrapFailure = error instanceof Error ? error.message : String(error);
		return;
	}
	bootstrapAccepted = true;
	const { launch, channel } = connection;
	const directory = dirname(bootstrapPath!);
	const scope = { root: launch.storageRoot, attemptId: launch.attemptId,
		ownerPath: launch.owner.path, participantDirectory: launch.participantDirectory };
	const gate = new ProposalSettlementGate();
	let context: ExtensionContext | undefined;
	let presentation: InteractivePresentation | undefined;
	let removeTerminalInput: (() => void) | undefined;
	let snapshot: RepairSnapshot | undefined;
	let cachedSnapshots = new Map<string, string>();
	let phase: "waiting" | "snapshot" | "model" | "validating" | "applying" | "committed" | "refused" = "waiting";
	pi.on("session_before_compact", createRepairCompactionHandler(gate, () => phase === "committed"));
	let cancelled = false;
	let closing = false;
	let retirementAcknowledged = false;
	let starting: Promise<void> | undefined;
	let settling: Promise<void> | undefined;
	let cancellation: Promise<void> | undefined;
	let retirement: Promise<void> | undefined;
	let modelActive = false;
	let modelOutcome: "completed" | "aborted" | "error" = "completed";
	let idle = Promise.resolve();
	let resolveIdle = () => {};
	let resolveAttempt!: (value: unknown) => void;
	let rejectAttempt!: (error: Error) => void;
	const attempt = new Promise<unknown>((resolve, reject) => { resolveAttempt = resolve; rejectAttempt = reject; });
	void attempt.catch(() => {});
	const mutations = new Set<Promise<unknown>>();
	const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
	const notify = (error: unknown) => context?.ui.notify(errorText(error), "error");
	const progress = async (message: string) => {
		await writeRepairRecord(join(directory, "events.jsonl"), { time: new Date().toISOString(), phase, message }, true);
		await channel.sendEvent("progress", { message });
	};
	const trackMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
		const pending = operation();
		mutations.add(pending);
		try { return await pending; } finally { mutations.delete(pending); }
	};
	const assertEditing = () => {
		if (phase !== "model" || cancelled || closing || gate.state !== "editing" || !snapshot) {
			throw new Error("Repair proposal is not editable");
		}
		return snapshot;
	};
	const releaseSnapshot = async () => { await snapshot?.release(); };
	const joinModelAndMutations = async () => {
		context?.abort();
		while (modelActive) await idle;
		await Promise.allSettled([...mutations]);
	};
	async function cancelAttempt(reason: string): Promise<void> {
		if (phase === "applying" || phase === "committed") throw new Error("Application has begun; use diagnostics, not cancellation");
		if (cancellation) return cancellation;
		cancelled = true;
		if (gate.state === "editing") gate.invalidate();
		cancellation = (async () => {
			await joinModelAndMutations();
			await starting?.catch(() => {});
			await settling?.catch(() => {});
			await releaseSnapshot();
			phase = "refused";
			rejectAttempt(new Error(reason));
			await progress(reason);
		})();
		return cancellation;
	}
	function retireHelper(cause: Error): Promise<void> {
		if (retirement) return retirement;
		closing = true;
		cancelled = true;
		gate.revokeCompletion();
		// An application that crossed its irreversible boundary owns its result.
		// No progress IPC here: disconnected and CLI-quit cleanup must both join.
		retirement = (async () => {
			try {
				await joinModelAndMutations();
				await starting?.catch(() => {});
				await settling?.catch(() => {});
				await cancellation?.catch(() => {});
				await releaseSnapshot();
			} finally {
				if (phase !== "committed") rejectAttempt(cause);
			}
		})();
		return retirement;
	}
	channel.onClose(cause => {
		void retireHelper(cause).finally(() => context?.shutdown()).catch(notify);
	});

	pi.registerTool({
		name: "repair_snapshot", label: "Repair snapshot", description: "List immutable snapshot IDs or read one original transcript. Available after commit for discussion.",
		parameters: Type.Object({ id: Type.Optional(Type.String()) }),
		async execute(_id, input) {
			if (!snapshot || (phase !== "model" && phase !== "committed" && phase !== "refused")) throw new Error("Repair snapshots are not ready");
			const value = input.id === undefined
				? snapshot.manifest.files.map(({ id, path, unreadable }) => ({ id, name: basename(path), unreadable }))
				: cachedSnapshots.get(input.id);
			if (value === undefined) throw new Error("Unknown or unreadable repair snapshot ID");
			return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} };
		},
	});
	pi.registerTool({
		name: "repair_candidate", label: "Repair candidate", description: "Replace one complete candidate copy by exact snapshot ID. Never writes a live transcript.",
		parameters: Type.Object({ id: Type.String(), contents: Type.String() }),
		execute: (_id, input) => trackMutation(async () => {
			const path = assertEditing().candidatePath(input.id);
			gate.invalidate();
			await writeFile(path, input.contents, { mode: 0o600 });
			return { content: [{ type: "text" as const, text: "Candidate copy written; not validated or applied." }], details: {} };
		}),
	});
	pi.registerTool({
		name: "repair_report", label: "Repair report", description: "Record progress, complete a proposal, or refuse. After commit only progress reports are accepted.",
		parameters: Type.Object({ kind: Type.Union([Type.Literal("progress"), Type.Literal("complete"), Type.Literal("refuse")]), text: Type.String({ minLength: 1 }) }),
		execute: (_id, input) => trackMutation(async () => {
			if (closing) throw new Error("Repair Moderator is closing");
			if (phase === "committed" || phase === "refused") {
				if (input.kind !== "progress") throw new Error("This repair attempt is closed; only discussion and progress reports remain available");
			} else assertEditing();
			const generation = gate.generation;
			await progress(input.kind + ": " + input.text);
			if (input.kind === "complete") {
				assertEditing();
				if (generation !== gate.generation) throw new Error("Proposal changed while recording completion; report complete again");
				gate.reportComplete();
			}
			if (input.kind === "refuse") {
				cancelled = true;
				gate.invalidate();
				// Do not join the tool's own model Run until this result has returned.
				setImmediate(() => { void cancelAttempt("Moderator refused: " + input.text).catch(notify); });
			}
			return { content: [{ type: "text" as const, text: "Report recorded. Host validation is independent." }], details: {} };
		}),
	});
	pi.on("before_agent_start", () => ({ systemPrompt: REPAIR_PROMPT + (launch.creationPreset?.systemPrompt ? "\n\nCaptured Moderator guidance (subject to the repair-only role):\n" + launch.creationPreset.systemPrompt : "") }));
	pi.on("input", event => {
		if (closing) return { action: "handled" };
		if (phase === "committed") return;
		if (phase === "validating") {
			gate.revokeCompletion();
			context?.ui.setEditorText(event.text);
			context?.ui.notify("Proposal revoked by new input. Validation will finish without applying; send your message again afterwards.", "warning");
			return { action: "handled" };
		}
		if (phase === "model" && !cancelled && gate.state === "editing") {
			gate.invalidate();
			return;
		}
		context?.ui.notify(phase === "applying"
			? "Repair validation/application is in progress. Retry your message after it settles."
			: "This repair attempt is not accepting model input.", "warning");
		return { action: "handled" };
	});
	pi.on("agent_start", () => {
		// Native retry/compaction can start another loop before one final settled
		// edge. Keep all abort/join waiters attached to that same active interval.
		if (!modelActive) idle = new Promise<void>(resolve => { resolveIdle = resolve; });
		modelActive = true;
		modelOutcome = "completed";
	});
	pi.on("message_end", event => {
		const message = event.message;
		if (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
			modelOutcome = message.stopReason;
			if (gate.state === "editing") gate.invalidate();
		}
	});
	pi.on("agent_end", (event, ctx) => {
		const assistant = [...event.messages].reverse().find(message => message.role === "assistant");
		// Esc can abort during a tool batch without a new aborted assistant entry.
		const outcome = ctx.signal?.aborted ? "aborted"
			: assistant?.role === "assistant" && (assistant.stopReason === "aborted" || assistant.stopReason === "error")
				? assistant.stopReason : undefined;
		if (outcome) {
			modelOutcome = outcome;
			if (gate.state === "editing") gate.invalidate();
		}
	});
	pi.on("agent_settled", () => {
		modelActive = false;
		resolveIdle();
		if (phase !== "model" || cancelled || mutations.size || settling) return;
		const authorization = gate.freezeOnSettlement({
			generation: gate.generation, outcome: modelOutcome, hasPendingMessages: context!.hasPendingMessages(),
		});
		if (!authorization) return;
		phase = "validating";
		const pending = (async () => {
			let seal;
			try {
				await progress("Validating the complete candidate generation and recording the protocol-effect audit.");
				seal = await snapshot!.seal(async ({ before, after }) => {
					const report = await validateRepairProposal({ before, after, ownerPath: launch.owner.path, workflowId: launch.owner.workflowId });
					return { valid: report.valid, report: JSON.stringify(report, null, 2) };
				});
			} catch (error) {
				if (cancelled) return;
				try {
					await progress("Validation rejected; editing reopened: " + errorText(error));
				} finally {
					// A failed diagnostics write must not strand a correctable proposal
					// behind the validation fence. Cancellation still owns terminal cleanup.
					if (!cancelled) {
						gate.validationRejected(authorization);
						settling = undefined;
						phase = "model";
						notify("Proposal was not applied: " + errorText(error) + ". Correct it and report complete again.");
					}
				}
				return;
			}
			if (cancelled) return;
			if (!gate.beginApplication(authorization)) {
				settling = undefined;
				phase = "model";
				context?.ui.notify("Proposal revoked by input or abort during validation. Report complete again when ready.", "warning");
				return;
			}
			phase = "applying";
			try {
				await progress("Applying the sealed generation under the original repair-command authorization.");
				const result = await snapshot!.apply(seal, { authorizedAttemptId: launch.attemptId });
				await releaseSnapshot();
				phase = "committed";
				pi.setActiveTools(["repair_snapshot", "repair_report"]);
				resolveAttempt(result);
				await progress("Disk repair committed. Continue discussing here or use /agents owner; no participant Runs were resumed.");
			} catch (error) {
				if (phase === "committed") throw error;
				phase = "refused";
				cancelled = true;
				await releaseSnapshot();
				rejectAttempt(new Error(errorText(error)));
				await progress("Application failed; diagnostics/recovery required: " + errorText(error));
				throw error;
			}
		})();
		settling = pending;
		void pending.finally(() => { if (settling === pending) settling = undefined; }).catch(notify);
	});
	pi.registerCommand("agents", { description: "Navigate the repair conversation, Owner, and repair diagnostics.", handler: async (args, ctx) => {
		const command = args.trim();
		if (command === "repair cancel") { await cancelAttempt("Repair attempt cancelled by the human"); return; }
		let target: "owner" | "inspect" | "recover" | undefined;
		if (command === "owner") target = "owner";
		else if (command === "repair inspect") target = "inspect";
		else if (command === "repair recover") target = "recover";
		else if (command === "repair recover-stopped") { ctx.ui.notify("Stop this live repair helper before recover-stopped.", "warning"); return; }
		else if (command) { ctx.ui.notify("Use /agents, /agents owner, /agents repair inspect, /agents repair recover, or /agents repair cancel.", "warning"); return; }
		else {
			const selected = await ctx.ui.select("Agents", ["Repair Moderator", "Owner", "Repair diagnostics"]);
			target = selected === "Owner" ? "owner" : selected === "Repair diagnostics" ? "inspect" : undefined;
		}
		if (target) await channel.request("navigate", { target });
	} });
	pi.on("session_shutdown", async () => {
		removeTerminalInput?.();
		await retireHelper(new Error("Repair Moderator shut down before commit"));
	});

	async function startRepair(): Promise<void> {
		if (phase !== "waiting" || cancelled || closing) throw new Error("Repair handoff was already consumed or cancelled");
		phase = "snapshot";
		retirementAcknowledged = true;
		try {
			await writeRepairRecord(join(directory, "retirement.json"), { kind: "host-verified-retirement", attemptId: launch.attemptId, time: new Date().toISOString() });
			snapshot = await createRepairSnapshot({ ...scope, retirement: { verified: true, evidence: "Host verified original coordinator cleanup, native bash/abort/idle joins and unrelated-session replacement before control handoff." } });
			const identity = readRepairOwnerIdentity(await snapshot.readSnapshot("file-0"), launch.owner.path);
			if (identity.workflowId !== launch.owner.workflowId || identity.sessionId !== launch.owner.sessionId || identity.identityEntryId !== launch.owner.identityEntryId) throw new Error("Retired snapshot Owner identity differs from authorized launch");
			cachedSnapshots = new Map(await Promise.all(snapshot.manifest.files.map(async ({ id }) => [id, await snapshot!.readSnapshot(id)] as const)));
			const originalFiles = snapshot.manifest.files.map(({ id, path }) => ({ path, contents: cachedSnapshots.get(id)! }));
			const preparation = await prepareDuplicateDeliveryRepair({ ownerPath: launch.owner.path, workflowId: launch.owner.workflowId, files: originalFiles });
			await writeRepairRecord(join(directory, "eligibility.json"), { eligible: preparation.eligible, errors: preparation.errors, certificate: preparation.certificate });
			if (!preparation.eligible) throw new Error("Unsupported admission repair: " + preparation.errors.map(({ message }) => message).join("; "));
			const manifestDigest = createHash("sha256").update(JSON.stringify(snapshot.manifest)).digest("hex");
			const bootstrap = { version: 1, kind: "repair_moderator", agentId: launch.moderatorAgentId, workflowId: identity.workflowId,
				directSpawnerAgentId: null, creationPreset: launch.creationPreset, attemptId: launch.attemptId, owner: identity, manifestDigest };
			await writeRepairRecord(join(directory, "moderator-bootstrap.json"), bootstrap);
			pi.appendEntry("agent-coordination.repair-moderator", bootstrap);
			if (cancelled) throw new Error("Repair cancelled before model work");
			phase = "model";
			await progress("Writers retired. Verified repair Moderator ready for native conversation.");
			if (cancelled) throw new Error("Repair cancelled before model work");
			pi.sendUserMessage("Repair attempt " + launch.attemptId + "; verified Workflow " + identity.workflowId + "; Moderator " + launch.moderatorAgentId +
				". Actual admission failure: " + JSON.stringify(launch.admissionFailure) + ". Supported correction constraints: " + JSON.stringify(preparation.certificate) +
				". Inspect the full snapshot set and propose only the supported exact-duplicate Delivery correction or refuse. Existing rejected historical records must remain unchanged.");
		} catch (error) {
			phase = "refused";
			cancelled = true;
			await releaseSnapshot();
			rejectAttempt(new Error(errorText(error)));
			await progress(errorText(error));
			throw error;
		}
	}
	pi.on("session_start", async (event, ctx) => {
		try {
			context = ctx;
			if (closing) { pi.setActiveTools([]); ctx.shutdown(); return; }
			if (event.reason === "reload") throw new Error("Repair helper reload is unsupported; inspect this attempt rather than restarting it");
			if (ctx.mode !== "tui") throw new Error("Repair Moderator requires native TUI mode");
			if (ctx.sessionManager.getSessionId() !== launch.moderatorAgentId) throw new Error("Repair Moderator native identity mismatch");
			removeTerminalInput = ctx.ui.onTerminalInput(data => {
				// Observe before native editor admission: Esc while idle validation is
				// pending otherwise has no model signal to abort. Never consume input.
				if ((phase === "model" || phase === "validating") && isRepairProposalRevocationInput(data)) gate.revokeCompletion();
			});
			presentation = captureInteractivePresentation(ctx.ui);
			presentation.setVisible(false);
			pi.setActiveTools([...REPAIR_TOOL_NAMES]);
			if (pi.getActiveTools().sort().join() !== [...REPAIR_TOOL_NAMES].sort().join()) throw new Error("Repair-only tool surface is unavailable");
			await writeRepairRecord(join(directory, "helper.json"), { pid: process.pid, attemptId: launch.attemptId, moderatorAgentId: launch.moderatorAgentId });
			channel.onRequest(async ({ method, payload }) => {
				if (method !== "command") throw new Error("Unknown repair control method");
				switch (payload.action) {
					case "visible":
						if (typeof payload.payload !== "boolean") throw new Error("Repair visibility requires a boolean");
						presentation!.setVisible(payload.payload); return null;
					case "retired":
						if (starting || phase !== "waiting") throw new Error("Repair handoff was already consumed");
						starting = startRepair();
						await starting;
						return await attempt;
					case "cancel": await cancelAttempt("Repair attempt cancelled by the human"); return { cancelled: true };
					case "refuse": await cancelAttempt(String(payload.payload)); return null;
					case "admission": await writeRepairRecord(join(directory, "admission.jsonl"), payload.payload, true); return null;
					case "recover":
						if (!retirementAcknowledged) throw new Error("Repair has no verified retirement handoff; stop writers and use recover-stopped");
						if (phase !== "refused" && phase !== "committed") throw new Error("Repair is still running");
						await cancellation;
						await settling;
						await releaseSnapshot(); return await recoverRepair(scope);
					case "inspect": return { phase, directory, launch, events: await readFile(join(directory, "events.jsonl"), "utf8").catch(() => "No progress recorded.") };
					case "shutdown":
						await retireHelper(new Error("Original CLI is shutting down"));
						// Let the control response enter its writer before native shutdown.
						setImmediate(() => ctx.shutdown()); return null;
					case "stop":
						if (!cancelled && phase !== "committed" && phase !== "waiting") throw new Error("Cancel or await the active attempt before closing its helper");
						closing = true;
						await joinModelAndMutations();
						await starting?.catch(() => {});
						await cancellation;
						await settling;
						await releaseSnapshot();
						setImmediate(() => ctx.shutdown()); return null;
					default: throw new Error("Unknown repair helper command");
				}
			});
			await channel.sendEvent("ready", {});
		} catch (error) {
			try { await channel.sendEvent("ready", { error: errorText(error) }); }
			finally { setImmediate(() => ctx.shutdown()); }
			throw error;
		}
	});
}
