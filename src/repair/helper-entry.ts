import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { REPAIR_BOOTSTRAP_ENV, REPAIR_TOOL_NAMES } from "./helper-process.ts";
import { readRepairLaunch, writeRepairRecord } from "./repair-launch.ts";
import { createRepairSnapshot, recoverRepair, type RepairSnapshot } from "./storage.ts";
import { validateRepairProposal, readRepairOwnerIdentity, prepareDuplicateDeliveryRepair } from "./workflow-validation.ts";

const REPAIR_PROMPT = `You are a repair-only Moderator belonging to the verified Workflow in your bootstrap.
The Owner actually failed transcript admission. Inspect the immutable full Workflow snapshots and the retained admission failure.
The ONLY supported correction is removal of redundant exact copies of valid Message Delivery envelopes. Keep the first copy unchanged, remove only later identical envelopes, and rewire native parentId links only when their parent was a removed duplicate.
Do not repair rejected historical records, add missing fields, turn them into text, or resurrect stale Requests. Preserve every other entry, identity/cutoff, accepted fact, message body, source, ordering and conversation. Ambiguous references, conflicting duplicates, other admission blockers and healthy histories are unsupported.
Use repair_snapshot to list and read immutable inputs, repair_candidate to write complete candidate copies, and repair_report for progress and a final complete/refuse report.
There is no shell, live transcript write, ordinary messaging, spawn, approval, or apply tool. A complete report is a proposal, not permission: the host independently validates and journals the whole Workflow.
If evidence is ambiguous, report refusal. Finish with repair_report(kind="complete") only after preparing all required candidate corrections, then stop.`;

/** Loaded only by an independent, resource-restricted stock Pi RPC process. */
export default async function repairHelperEntry(pi: ExtensionAPI): Promise<void> {
	const bootstrapPath = process.env[REPAIR_BOOTSTRAP_ENV];
	if (!bootstrapPath || !process.send) throw new Error("Repair helper requires its host-owned IPC bootstrap");
	try {
		const launch = await readRepairLaunch(bootstrapPath);
		const directory = dirname(bootstrapPath);
		const scope = { root: launch.storageRoot, attemptId: launch.attemptId,
			ownerPath: launch.owner.path, participantDirectory: launch.participantDirectory };
		let context: ExtensionContext | undefined;
		let snapshot: RepairSnapshot | undefined;
		let phase: "waiting" | "snapshot" | "model" | "validating" | "applying" | "committed" | "refused" = "waiting";
		let cancelled = false;
		let retirementAcknowledged = false;
		let completed = false;
		let resolveModel: (() => void) | undefined;
		let active: Promise<unknown> | undefined;
		const emit = (value: unknown) => { if (process.connected) process.send?.(value); };
		let toolArgumentCharacters = 0;
		pi.on("message_update", ({ assistantMessageEvent: event }) => {
			if (event.type === "toolcall_start") toolArgumentCharacters = 0;
			if (event.type === "toolcall_delta") {
				toolArgumentCharacters += event.delta.length;
				emit({ type: "activity", text: `Preparing tool arguments: ${toolArgumentCharacters} characters streamed`, status: true });
			}
			if (event.type === "text_delta" || event.type === "thinking_delta") {
				emit({ type: "activity", text: event.delta });
			}
		});
		pi.on("tool_execution_start", (event) => emit({ type: "activity", text: `\n[Tool: ${event.toolName}]\n` }));
		pi.on("tool_execution_end", (event) => emit({ type: "activity", text: `\n[${event.toolName}: ${event.isError ? "error" : "complete"}]\n` }));
		const progress = async (message: string) => {
			await writeRepairRecord(join(directory, "events.jsonl"), { time: new Date().toISOString(), phase, message }, true);
			emit({ type: "progress", message });
		};
		const assertModelWorkspace = () => {
			if (phase !== "model" || !snapshot || cancelled) throw new Error("Repair Moderator workspace is not active");
			return snapshot;
		};
		pi.registerTool({
			name: "repair_snapshot", label: "Repair snapshot", description: "List immutable snapshot IDs or read one complete original transcript.",
			parameters: Type.Object({ id: Type.Optional(Type.String()) }),
			async execute(_id, input) {
				const workspace = assertModelWorkspace();
				const value = input.id === undefined
					? workspace.manifest.files.map(({ id, path, unreadable }) => ({ id, name: basename(path), unreadable }))
					: await workspace.readSnapshot(input.id);
				return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} };
			},
		});
		pi.registerTool({
			name: "repair_candidate", label: "Repair candidate", description: "Replace one complete candidate copy by exact snapshot ID. Never writes a live transcript.",
			parameters: Type.Object({ id: Type.String(), contents: Type.String() }),
			async execute(_id, input) {
				const path = assertModelWorkspace().candidatePath(input.id);
				await writeFile(path, input.contents, { mode: 0o600 });
				completed = false;
				return { content: [{ type: "text", text: "Candidate copy written; not validated or applied." }], details: {} };
			},
		});
		pi.registerTool({
			name: "repair_report", label: "Repair report", description: "Record progress, a completed proposal, or refusal. Cannot approve or apply repair.",
			parameters: Type.Object({ kind: Type.Union([Type.Literal("progress"), Type.Literal("complete"), Type.Literal("refuse")]), text: Type.String({ minLength: 1 }) }),
			async execute(_id, input) {
				assertModelWorkspace();
				await progress(`${input.kind}: ${input.text}`);
				if (input.kind === "complete") completed = true;
				if (input.kind === "refuse") { cancelled = true; completed = false; }
				return { content: [{ type: "text", text: "Report recorded. Host validation is independent." }], details: {} };
			},
		});
		pi.on("before_agent_start", () => ({ systemPrompt: REPAIR_PROMPT + (launch.creationPreset?.systemPrompt ? `\n\nCaptured Moderator guidance (subject to the repair-only role):\n${launch.creationPreset.systemPrompt}` : "") }));
		pi.on("input", () => phase === "model" ? undefined : { action: "handled" });
		pi.on("agent_settled", () => resolveModel?.());
		pi.on("session_shutdown", async () => {
			if (phase !== "applying" && phase !== "committed") { cancelled = true; context?.abort(); resolveModel?.(); }
			await active?.catch(() => undefined);
			await snapshot?.release();
		});
		async function repair() {
			if (phase !== "waiting" || cancelled) throw new Error("Repair handoff was already consumed or cancelled");
			phase = "snapshot";
			retirementAcknowledged = true;
			try {
				await writeRepairRecord(join(directory, "retirement.json"), { kind: "host-verified-retirement", attemptId: launch.attemptId, time: new Date().toISOString() });
				snapshot = await createRepairSnapshot({ ...scope,
					retirement: { verified: true, evidence: "Host verified original coordinator cleanup, native bash/abort/idle joins and completed unrelated-session replacement before IPC handoff." } });
				const identity = readRepairOwnerIdentity(await snapshot.readSnapshot("file-0"), launch.owner.path);
				if (identity.workflowId !== launch.owner.workflowId || identity.sessionId !== launch.owner.sessionId || identity.identityEntryId !== launch.owner.identityEntryId) throw new Error("Retired snapshot Owner identity differs from the authorized launch");
				const originalFiles = await Promise.all(snapshot.manifest.files.map(async ({ id, path }) => ({ path, contents: await snapshot!.readSnapshot(id) })));
				const preparation = await prepareDuplicateDeliveryRepair({ ownerPath: launch.owner.path, workflowId: launch.owner.workflowId, files: originalFiles });
				await writeRepairRecord(join(directory, "eligibility.json"), { eligible: preparation.eligible, errors: preparation.errors, certificate: preparation.certificate });
				if (!preparation.eligible) throw new Error(`Unsupported admission repair: ${preparation.errors.map(({ message }) => message).join("; ")}`);
				// The deterministic reference is validation authority, not a prewritten
				// model proposal. Candidate files remain untouched until scoped tool use.
				const manifestDigest = createHash("sha256").update(JSON.stringify(snapshot.manifest)).digest("hex");
				const bootstrap = { version: 1, kind: "repair_moderator", agentId: launch.moderatorAgentId,
					workflowId: identity.workflowId, directSpawnerAgentId: null, creationPreset: launch.creationPreset,
					attemptId: launch.attemptId, owner: identity, manifestDigest };
				await writeRepairRecord(join(directory, "moderator-bootstrap.json"), bootstrap);
				pi.appendEntry("agent-coordination.repair-moderator", bootstrap);
				if (cancelled) throw new Error("Repair cancelled before model work");
				phase = "model";
				await progress("Writers retired. Verified Workflow-owned repair Moderator inspecting immutable snapshots.");
				const settled = new Promise<void>((resolve) => { resolveModel = resolve; });
				pi.sendUserMessage(`Repair attempt ${launch.attemptId}; verified Workflow ${identity.workflowId}; Moderator ${launch.moderatorAgentId}. Actual admission failure: ${JSON.stringify(launch.admissionFailure)}. Supported correction constraints: ${JSON.stringify(preparation.certificate)}. Inspect the full snapshot set and propose only the supported exact-duplicate Delivery correction or refuse. Existing rejected historical records must remain unchanged.`);
				await settled;
				resolveModel = undefined;
				if (cancelled || !completed) throw new Error(cancelled ? "Repair cancelled or refused by Moderator" : "Moderator settled without a complete repair proposal");
				phase = "validating";
				await progress("Validating the exhaustive candidate generation and recording protocol-effect audit.");
				const seal = await snapshot.seal(async ({ before, after }) => {
					const report = await validateRepairProposal({ before, after, ownerPath: launch.owner.path, workflowId: launch.owner.workflowId });
					return { valid: report.valid, report: JSON.stringify(report, null, 2) };
				});
				if (cancelled) throw new Error("Repair cancelled before application");
				phase = "applying";
				await progress("Applying the sealed generation under the original repair-command authorization.");
				const result = await snapshot.apply(seal, { authorizedAttemptId: launch.attemptId });
				phase = "committed";
				await snapshot.release();
				await progress("Disk repair committed. Awaiting fresh Owner admission; no participant Runs will be resumed.");
				return result;
			} catch (error) {
				phase = "refused";
				await snapshot?.release();
				await progress(error instanceof Error ? error.message : String(error));
				throw error;
			}
		}
		pi.on("session_start", async (_event, ctx) => {
			try {
			context = ctx;
			if (ctx.sessionManager.getSessionId() !== launch.moderatorAgentId) throw new Error("Repair Moderator native identity mismatch");
			pi.setActiveTools([...REPAIR_TOOL_NAMES]);
			if (pi.getActiveTools().sort().join() !== [...REPAIR_TOOL_NAMES].sort().join()) throw new Error("Repair-only tool surface is unavailable");
			await writeRepairRecord(join(directory, "helper.json"), { pid: process.pid, attemptId: launch.attemptId, moderatorAgentId: launch.moderatorAgentId });
			process.on("message", (value) => {
				if (typeof value !== "object" || value === null) return;
				const message = value as { id?: unknown; action?: unknown; payload?: unknown };
				if (typeof message.id !== "string" || typeof message.action !== "string") return;
				const handle = async () => {
					switch (message.action) {
						case "retired":
							if (active) throw new Error("Repair handoff was already consumed");
							active = repair(); return await active;
						case "cancel":
							if (phase === "applying" || phase === "committed") throw new Error("Application has begun; use diagnostics, not cancellation");
							cancelled = true; ctx.abort(); resolveModel?.(); return { cancelled: true };
						case "refuse": cancelled = true; if (phase !== "committed") phase = "refused"; await progress(String(message.payload)); return null;
						case "admission": await writeRepairRecord(join(directory, "admission.jsonl"), message.payload, true); return null;
						case "recover":
							// No journal intent proves only unchanged bytes, not writer cleanup.
							// Ordinary recovery cannot turn an unacknowledged refusal into permission.
							if (!retirementAcknowledged) throw new Error("Repair has no verified retirement handoff; stop all affected writers and use recover-stopped");
							if (active && phase !== "refused" && phase !== "committed") throw new Error("Repair is still running");
							await snapshot?.release(); return await recoverRepair(scope);
						case "inspect": return { phase, directory, launch, events: await readFile(join(directory, "events.jsonl"), "utf8").catch(() => "No progress recorded.") };
						case "stop":
							if (phase === "model" || phase === "validating" || phase === "applying") throw new Error("Cancel or await the active attempt before closing its helper");
							await snapshot?.release(); return null;
						default: throw new Error("Unknown repair helper command");
					}
				};
				void handle().then((result) => emit({ type: "result", id: message.id, value: result }), (error) => emit({ type: "result", id: message.id, error: error instanceof Error ? error.message : String(error) }));
			});
			emit({ type: "ready" });
			} catch (error) {
				emit({ type: "ready_error", error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		});
	} catch (error) {
		process.send?.({ type: "ready_error", error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}
