import { spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveInstalledPiCliPath } from "../process-runtime/pi-child-process-runtime.ts";

export const REPAIR_TOOL_NAMES = ["repair_snapshot", "repair_candidate", "repair_report"] as const;
export const REPAIR_BOOTSTRAP_ENV = "PI_DURABLE_REPAIR_BOOTSTRAP";

export type IndependentRepairHelper = {
	readonly pid: number;
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	request(action: string, payload?: unknown): Promise<unknown>;
	stop(): Promise<void>;
};

/** Launch stock Pi so installed TypeScript extensions use Pi's supported loader. */
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
}): Promise<IndependentRepairHelper> {
	await mkdir(options.logDirectory, { recursive: true, mode: 0o700 });
	const stdout = await open(join(options.logDirectory, "helper.rpc.jsonl"), "a", 0o600);
	const stderr = await open(join(options.logDirectory, "helper.stderr.log"), "a", 0o600);
	let child;
	try {
		const environment: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: options.agentDir, [REPAIR_BOOTSTRAP_ENV]: options.bootstrapPath };
		// The independent helper must never join the managed-child bootstrap path.
		delete environment.PI_AGENT_COORDINATION_BOOTSTRAP;
		child = spawn(process.execPath, [
			resolveInstalledPiCliPath(), "--mode", "rpc", "--session", options.sessionPath,
			"--model", options.model, "--thinking", options.thinking,
			"--no-extensions", "--extension", options.extensionPath,
			"--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
			"--no-builtin-tools", "--tools", REPAIR_TOOL_NAMES.join(","), "--no-approve",
		], { cwd: options.cwd, env: environment, detached: true, stdio: ["pipe", stdout.fd, stderr.fd, "ipc"] });
	} finally {
		await Promise.all([stdout.close(), stderr.close()]);
	}
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	void ready.catch(() => undefined);
	let sequence = 0;
	let ended = false;
	const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
	const fail = (error: Error) => {
		rejectReady(error);
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => {
			ended = true;
			fail(new Error(`Repair helper exited (${code ?? signal}); inspect ${options.logDirectory}`));
			resolve({ code, signal });
		});
		child.once("error", (error) => {
			ended = true;
			fail(error);
			resolve({ code: null, signal: null });
		});
	});
	child.on("message", (value) => {
		if (typeof value !== "object" || value === null) return;
		const message = value as Record<string, unknown>;
		if (message.type === "ready") resolveReady();
		else if (message.type === "ready_error" && typeof message.error === "string") rejectReady(new Error(message.error));
		else if (message.type === "progress" && typeof message.message === "string") options.onProgress?.(message.message);
		else if (message.type === "result" && typeof message.id === "string") {
			const request = pending.get(message.id);
			pending.delete(message.id);
			if (typeof message.error === "string") request?.reject(new Error(message.error));
			else request?.resolve(message.value);
		}
	});
	const request = (action: string, payload?: unknown): Promise<unknown> => {
		if (ended || !child.connected) return Promise.reject(new Error("Repair helper is not connected"));
		const id = String(++sequence);
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			child.send({ id, action, payload }, (error) => {
				if (!error) return;
				pending.delete(id);
				reject(error);
			});
		});
	};
	// Pi contains extension-load failures. Missing readiness is a refusal, not an
	// indefinitely hidden helper. No handoff has been sent at this boundary.
	const startupTimer = setTimeout(() => rejectReady(new Error(`Repair helper did not initialize; inspect ${options.logDirectory}`)), 30_000);
	try { await ready; }
	catch (error) {
		if (!ended) {
			child.kill("SIGKILL");
			await exited;
		}
		throw error;
	} finally { clearTimeout(startupTimer); }
	return {
		pid: child.pid!, exited, request,
		async stop() {
			if (ended) return;
			await request("stop");
			// RPC's stdin EOF is shutdown, never authorization for repair application.
			child.stdin!.end();
			await exited;
		},
	};
}
