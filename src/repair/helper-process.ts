import { randomUUID } from "node:crypto";
import { open, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Static } from "typebox";
import { AgentControlAdmissionBroker } from "../control/agent-control-admission.ts";
import { createPlatformControlListener } from "../control/control-platform.ts";
import type { TerminalProjection } from "../presentation/terminal-projection.ts";
import { resolveInstalledPiCliPath } from "../process-runtime/pi-child-process-runtime.ts";
import { spawnPtyTerminalProjection, type PtyTerminalProjection } from "../process-runtime/pty-terminal-projection.ts";
import { repairControlProtocol, type RepairControlChannel } from "./helper-control.ts";
import { readRepairLaunch, writeRepairRecord } from "./repair-launch.ts";

export const REPAIR_TOOL_NAMES = ["repair_snapshot", "repair_candidate", "repair_report"] as const;
export const REPAIR_BOOTSTRAP_ENV = "PI_DURABLE_REPAIR_BOOTSTRAP";
const STARTUP_TIMEOUT_MS = 30_000;

export type IndependentRepairHelper = {
	readonly pid: number;
	readonly exited: Promise<{ code: number | null; signal: number | null }>;
	readonly projection: TerminalProjection;
	dimensions(): Readonly<{ columns: number; rows: number }>;
	writeInput(data: string): void;
	beginPhysicalTerminalAttachment(handler: (data: string) => void): Promise<() => void>;
	hidePresentation(): Promise<void>;
	request(action: string, payload?: unknown): Promise<unknown>;
	stop(): Promise<void>;
};

/** Stock Pi owns the editor and conversation; control carries lifecycle only. */
export async function launchRepairHelper(options: {
	cwd: string;
	agentDir: string;
	extensionPath: string;
	bootstrapPath: string;
	sessionPath: string;
	logDirectory: string;
	model: string;
	thinking: string;
	onProgress?(message: string): void;
	onNavigate?(target: Static<typeof repairControlProtocol.methods.navigate.request>["target"]): Promise<void>;
}): Promise<IndependentRepairHelper> {
	const launch = await readRepairLaunch(options.bootstrapPath);
	await mkdir(options.logDirectory, { recursive: true, mode: 0o700 });
	const log = await open(join(options.logDirectory, "helper.terminal.log"), "a", 0o600);
	let broker: AgentControlAdmissionBroker<typeof repairControlProtocol> | undefined;
	let channel: RepairControlChannel | undefined;
	let native: PtyTerminalProjection | undefined;
	let ended = false;
	let closed = false;
	let logTail = Promise.resolve();
	let logError: unknown;
	let cleanupPromise: Promise<void> | undefined;
	let exited: IndependentRepairHelper["exited"] | undefined;
	const exitHandlers = new Set<() => void>();
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	void ready.catch(() => undefined);
	const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
		closed = true;
		const results = await Promise.allSettled([
			channel?.close(), broker?.close(),
			(async () => { await logTail; await log.close(); if (logError) throw logError; })(),
			// Never dispose a live successful helper merely to hide its presentation.
			native && ended ? native.dispose() : undefined,
		]);
		const failure = results.find(result => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	})();
	const startupTimer = setTimeout(() => rejectReady(new Error("Repair helper did not initialize; inspect " + options.logDirectory)), STARTUP_TIMEOUT_MS);
	try {
		const listener = await createPlatformControlListener({ workflowId: launch.owner.workflowId });
		broker = new AgentControlAdmissionBroker({ listener, protocol: repairControlProtocol, workflowId: launch.owner.workflowId });
		const connectionToken = randomUUID();
		const admission = broker.admit({ agentId: launch.moderatorAgentId, expectedSessionId: launch.moderatorAgentId, connectionToken }, candidate => {
			channel = candidate;
			candidate.onClose(error => { closed = true; rejectReady(error); });
			candidate.onEvent(event => {
				if (event.event === "ready") {
					if (event.payload.error !== undefined) rejectReady(new Error(event.payload.error));
					else resolveReady();
				} else options.onProgress?.(event.payload.message);
			});
			candidate.onRequest(async request => {
				if (request.method !== "navigate") throw new Error("Repair host accepts navigation only");
				await options.onNavigate?.(request.payload.target);
				return null;
			});
		});
		void admission.catch(rejectReady);
		await writeRepairRecord(join(dirname(options.bootstrapPath), "control.json"), { endpoint: listener.endpoint, connectionToken, attemptId: launch.attemptId });
		const environment: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: options.agentDir, [REPAIR_BOOTSTRAP_ENV]: options.bootstrapPath };
		delete environment.PI_AGENT_COORDINATION_BOOTSTRAP;
		native = spawnPtyTerminalProjection({
			file: process.execPath,
			arguments: [resolveInstalledPiCliPath(), "--session", options.sessionPath,
				"--model", options.model, "--thinking", options.thinking,
				"--no-extensions", "--extension", options.extensionPath,
				"--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
				"--no-builtin-tools", "--tools", REPAIR_TOOL_NAMES.join(","), "--no-approve"],
			cwd: options.cwd, environment, columns: process.stdout.columns || 80, rows: process.stdout.rows || 24,
		});
		exited = native.exited.then(async result => {
			ended = true;
			rejectReady(new Error("Repair helper exited; inspect " + options.logDirectory));
			try { await cleanup(); }
			finally { for (const handler of exitHandlers) handler(); exitHandlers.clear(); }
			return { code: result.exitCode, signal: result.signal || null };
		});
		void exited.catch(rejectReady);
		native.addFailureHandler(error => rejectReady(error instanceof Error ? error : new Error(String(error))));
		native.addOutputHandler(data => {
			logTail = logTail.then(async () => { if (!logError) await log.writeFile(data); }).catch(error => {
				logError = error;
				rejectReady(error instanceof Error ? error : new Error(String(error)));
			});
		});
		await ready;
		await admission;
	} catch (error) {
		if (native && !ended) native.killProcessGroup("SIGKILL");
		if (exited) await exited;
		else await cleanup();
		throw error;
	} finally { clearTimeout(startupTimer); }

	const terminal = native!;
	const actualExit = exited!;
	const request = (action: string, payload?: unknown): Promise<unknown> => {
		if (ended || closed || !channel) return Promise.reject(new Error("Repair helper is not connected"));
		return channel.request("command", { action, payload });
	};
	let presentationRevision = 0;
	const beginPhysicalTerminalAttachment = async (handler: (data: string) => void): Promise<() => void> => {
		const revision = ++presentationRevision;
		await terminal.enterNativeTerminalMode();
		if (revision !== presentationRevision) return () => undefined;
		const remove = terminal.addOutputHandler(handler);
		try {
			await request("visible", true);
			if (revision !== presentationRevision) { remove(); return () => undefined; }
			return remove;
		} catch (error) { remove(); throw error; }
	};
	const hidePresentation = async (): Promise<void> => {
		++presentationRevision;
		if (ended || closed) return;
		terminal.resumeOutput();
		try { await request("visible", false); }
		catch (error) { if (!ended && !closed) throw error; }
	};
	const projection: TerminalProjection = {
		presentation: { render: () => ["Repair helper requires native terminal attachment."], invalidate() {} },
		physicalTerminal: { beginAttachment: beginPhysicalTerminalAttachment, endAttachment: hidePresentation,
			pauseOutput: () => terminal.pauseOutput(), resumeOutput: () => terminal.resumeOutput() },
		resize: (columns, rows) => terminal.resize(columns, rows),
		dispatchInput: data => terminal.writeInput(data),
		focusEditor() {},
		addChangeHandler: handler => terminal.addChangeHandler(handler),
		addFailureHandler: handler => terminal.addFailureHandler(handler),
		addExitRequestHandler: handler => {
			if (ended) { queueMicrotask(handler); return () => undefined; }
			exitHandlers.add(handler);
			return () => { exitHandlers.delete(handler); };
		},
	};
	return {
		pid: terminal.pid, exited: actualExit, projection, request,
		dimensions: () => terminal.dimensions(), writeInput: data => terminal.writeInput(data),
		beginPhysicalTerminalAttachment, hidePresentation,
		async stop() {
			if (!ended) await request("stop");
			await actualExit;
		},
	};
}
