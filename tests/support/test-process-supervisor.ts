import { spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PROCESS_SCAN_INTERVAL_MS = 10;
const TERMINATION_GRACE_MS = 100;
const SUPERVISED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
// Marks the run as contained for tests/support/supervised-run.ts.
const SUPERVISED_RUN_VARIABLE = "PI_TEST_SUPERVISED";

export async function runTestProcess(arguments_: readonly string[], deadlineMs: number): Promise<number> {
	if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647) {
		throw new Error("Test deadline must be an integer between 1 and 2147483647 milliseconds");
	}
	// Test fixtures, Pi hosts, and child processes create temporary directories
	// that many tests never remove, and a timed-out or killed test cannot. Give
	// the whole run one scratch root and remove it once the process tree is gone.
	// The prefix stays short: Control sockets live below it, sometimes in a nested
	// supervised run, and Unix socket paths are limited to about 100 bytes.
	const scratchDirectory = mkdtempSync(join(tmpdir(), "pt-"));
	let requestTermination!: (signal: NodeJS.Signals) => void;
	const terminationRequested = new Promise<NodeJS.Signals>((resolve) => {
		requestTermination = resolve;
	});
	const handlers = new Map<NodeJS.Signals, () => void>();
	for (const signal of SUPERVISED_SIGNALS) {
		const handler = () => requestTermination(signal);
		handlers.set(signal, handler);
		process.on(signal, handler);
	}

	// Handlers stay installed during removal so a second interrupt cannot kill
	// the supervisor halfway through it.
	try {
		const outcome = await runOwnedTestProcess(
			arguments_,
			terminationRequested,
			deadlineMs,
			scratchEnvironment(scratchDirectory),
		).then((exitCode) => ({ exitCode }), (error: unknown) => ({ error }));
		return settleWithScratchRemoval(outcome, scratchDirectory);
	} finally {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	}
}

// A cleanup failure must not replace the run's own exit code or error.
function settleWithScratchRemoval(
	outcome: Readonly<{ exitCode: number } | { error: unknown }>,
	scratchDirectory: string,
): number {
	try {
		// Retries cover descendants that still hold files open (Windows only kills the root).
		rmSync(scratchDirectory, { recursive: true, force: true, maxRetries: 5 });
	} catch (cleanupError) {
		if ("error" in outcome) {
			throw new AggregateError([outcome.error, cleanupError], "test_run_scratch_cleanup_failed");
		}
		console.error("Failed to remove the test run scratch directory:", cleanupError);
		return outcome.exitCode || 1;
	}
	if ("error" in outcome) throw outcome.error;
	return outcome.exitCode;
}

// os.tmpdir() reads TMPDIR on Unix and TEMP/TMP on Windows. Child runtimes put
// control sockets and runtime artifacts under XDG_RUNTIME_DIR before tmpdir().
function scratchEnvironment(scratchDirectory: string): NodeJS.ProcessEnv {
	return {
		TMPDIR: scratchDirectory,
		TEMP: scratchDirectory,
		TMP: scratchDirectory,
		XDG_RUNTIME_DIR: scratchDirectory,
	};
}

async function runOwnedTestProcess(
	arguments_: readonly string[],
	terminationRequested: Promise<NodeJS.Signals>,
	deadlineMs: number,
	scratchVariables: NodeJS.ProcessEnv,
): Promise<number> {
	const cgroup = LinuxCgroupOwner.tryCreate();
	try {
		await cgroup?.startGuardian();
	} catch (error) {
		await cgroup?.dispose();
		throw error;
	}
	const childEnvironment = {
		...(cgroup?.testEnvironment() ?? process.env),
		...scratchVariables,
		[SUPERVISED_RUN_VARIABLE]: "1",
	};
	// Isolate the test runner from terminal/CI group signals. The supervisor must
	// remain alive long enough to clean descendants in separate PTY process groups.
	const child = cgroup
		? spawn("/bin/sh", [
			"-c",
			'kill -STOP "$$"; exec "$@"',
			"pi-test-runner",
			process.execPath,
			...arguments_,
		], { stdio: "inherit", detached: true, env: childEnvironment })
		: spawn(process.execPath, [...arguments_], {
			stdio: "inherit",
			detached: process.platform !== "win32",
			env: childEnvironment,
		});
	const processTree: ProcessOwner = cgroup ?? new ProcessTreeOwner(child.pid!);
	const childExit = new Promise<Readonly<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	let deadlineTimer: NodeJS.Timeout;
	const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
		deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), deadlineMs);
	});
	try {
		const rootIdentity = cgroup
			? { pid: child.pid!, startTime: statFields(child.pid!)[19]! }
			: undefined;
		if (cgroup && rootIdentity) await cgroup.admitStoppedRoot(rootIdentity);
		const outcome = await Promise.race([
			deadline,
			childExit.then((exit) => ({ kind: "exit" as const, exit })),
			terminationRequested.then((signal) => ({ kind: "termination" as const, signal })),
			...(cgroup ? [cgroup.guardianFailure] : []),
		]);
		if (outcome.kind === "exit") {
			processTree.killSurvivors();
			return outcome.exit.signal
				? 128 + signalNumber(outcome.exit.signal)
				: outcome.exit.code ?? 1;
		}
		if (outcome.kind === "deadline") {
			console.error(`Test suite exceeded its ${deadlineMs}ms supervisor deadline`);
			await processTree.terminate("SIGTERM", childExit);
			return 124;
		}
		await processTree.terminate(outcome.signal, childExit);
		return 128 + signalNumber(outcome.signal);
	} finally {
		clearTimeout(deadlineTimer!);
		await processTree.dispose();
	}
}

type ProcessIdentity = Readonly<{
	pid: number;
	startTime: string;
}>;

type ProcessObservation = ProcessIdentity & Readonly<{ ppid: number }>;

type ProcessOwner = Readonly<{
	terminate(signal: NodeJS.Signals, rootExit: Promise<unknown>): Promise<void>;
	killSurvivors(): void;
	dispose(): Promise<void>;
}>;

class LinuxCgroupOwner implements ProcessOwner {
	readonly #path: string;
	#root: ProcessIdentity | undefined;
	#guardian: ChildProcess | undefined;
	#guardianFailure: Promise<never> | undefined;
	#guardianStopping = false;

	private constructor(path: string) {
		this.#path = path;
	}

	testEnvironment(): NodeJS.ProcessEnv {
		if (!this.#guardian?.pid) {
			throw new Error("Test process guardian has no process identity");
		}
		return { ...process.env, PI_TEST_GUARDIAN_PID: String(this.#guardian.pid) };
	}

	get guardianFailure(): Promise<never> {
		if (!this.#guardianFailure) {
			throw new Error("Test process guardian has not started");
		}
		return this.#guardianFailure;
	}

	static tryCreate(): LinuxCgroupOwner | undefined {
		if (process.platform !== "linux") return undefined;
		const membership = readFileSync("/proc/self/cgroup", "utf8")
			.split("\n")
			.find((line) => line.startsWith("0::"));
		if (!membership) return undefined;
		const parent = join("/sys/fs/cgroup", membership.slice("0::".length));
		if (!existsSync(join(parent, "cgroup.kill"))) return undefined;
		reapEmptyTestCgroups(parent);
		const path = join(parent, `pi-test-${process.pid}-${randomUUID()}`);
		try {
			mkdirSync(path);
			return new LinuxCgroupOwner(path);
		} catch (error) {
			if (["EACCES", "ENOENT", "EPERM", "EROFS"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)) return undefined;
			throw error;
		}
	}

	async startGuardian(): Promise<void> {
		const guardian = spawn(process.execPath, [
			new URL("./test-process-guardian.ts", import.meta.url).pathname,
		], {
			detached: true,
			env: {
				...process.env,
				PI_TEST_SUPERVISOR_PID: String(process.pid),
				PI_TEST_SUPERVISOR_START_TIME: statFields(process.pid)[19]!,
				PI_TEST_CGROUP_PATH: this.#path,
			},
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		this.#guardian = guardian;
		this.#guardianFailure = new Promise<never>((_resolve, reject) => {
			guardian.on("error", (error) => {
				if (!this.#guardianStopping) reject(error);
			});
			guardian.on("exit", (code, signal) => {
				if (!this.#guardianStopping) reject(new Error(
					`Test process guardian exited unexpectedly: ${code ?? signal}`,
				));
			});
		});
		void this.#guardianFailure.catch(() => undefined);
		await waitForGuardianReady(guardian);
	}

	async admitStoppedRoot(root: ProcessIdentity): Promise<void> {
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline) {
			if (!sameProcess(root)) {
				throw new Error("Test runner exited before cgroup admission");
			}
			if (processState(root.pid) === "T") {
				try {
					writeFileSync(join(this.#path, "cgroup.procs"), String(root.pid));
					this.#root = root;
					signalIdentity(root, "SIGCONT");
					return;
				} catch (error) {
					signalIdentity(root, "SIGKILL");
					throw error;
				}
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
		signalIdentity(root, "SIGKILL");
		throw new Error("Test runner did not stop for cgroup admission");
	}

	async terminate(signal: NodeJS.Signals, rootExit: Promise<unknown>): Promise<void> {
		if (this.#root) signalIdentity(this.#root, signal);
		await Promise.race([
			rootExit,
			new Promise<void>((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS)),
		]);
		this.killSurvivors();
		await rootExit;
	}

	killSurvivors(): void {
		try {
			writeFileSync(join(this.#path, "cgroup.kill"), "1");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	async dispose(): Promise<void> {
		this.killSurvivors();
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline && this.#isPopulated()) {
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
		try {
			rmdirSync(this.#path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		} finally {
			this.#guardianStopping = true;
			await stopGuardian(this.#guardian);
			this.#guardian = undefined;
		}
	}

	#isPopulated(): boolean {
		try {
			return readFileSync(join(this.#path, "cgroup.events"), "utf8")
				.split("\n")
				.some((line) => line === "populated 1");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
}

class ProcessTreeOwner implements ProcessOwner {
	readonly #rootPid: number;
	readonly #owned = new Map<number, ProcessIdentity>();
	readonly #scanTimer: NodeJS.Timeout | undefined;

	constructor(rootPid: number) {
		this.#rootPid = rootPid;
		if (process.platform === "linux") {
			this.#refresh();
			this.#scanTimer = setInterval(
				() => this.#refresh(),
				PROCESS_SCAN_INTERVAL_MS,
			);
			this.#scanTimer.unref();
		}
	}

	async terminate(signal: NodeJS.Signals, rootExit: Promise<unknown>): Promise<void> {
		this.#refresh();
		this.#signalRoot(signal);
		await Promise.race([
			rootExit,
			new Promise<void>((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS)),
		]);
		this.killSurvivors();
		await rootExit;
	}

	killSurvivors(): void {
		this.#refresh();
		if (process.platform === "linux") {
			for (const identity of [...this.#owned.values()].reverse()) {
				signalIdentity(identity, "SIGKILL");
			}
			return;
		}
		if (process.platform !== "win32") {
			try {
				process.kill(-this.#rootPid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			return;
		}
		try {
			process.kill(this.#rootPid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}

	dispose(): Promise<void> {
		if (this.#scanTimer) clearInterval(this.#scanTimer);
		return Promise.resolve();
	}

	#signalRoot(signal: NodeJS.Signals): void {
		const root = this.#owned.get(this.#rootPid);
		if (root) signalIdentity(root, signal);
	}

	#refresh(): void {
		if (process.platform !== "linux") return;
		const observed = observeProcesses();
		const root = observed.get(this.#rootPid);
		const ownedRoot = this.#owned.get(this.#rootPid);
		if (root && (!ownedRoot || observationMatches(ownedRoot, root))) {
			this.#owned.set(this.#rootPid, identityOf(root));
		}
		let added = true;
		while (added) {
			added = false;
			for (const process_ of observed.values()) {
				if (this.#owned.has(process_.pid)) continue;
				const parent = this.#owned.get(process_.ppid);
				if (!parent || !observationMatches(parent, observed.get(parent.pid))) continue;
				this.#owned.set(process_.pid, identityOf(process_));
				added = true;
			}
		}
	}
}

function observeProcesses(): Map<number, ProcessObservation> {
	const processes = new Map<number, ProcessObservation>();
	for (const entry of readdirSync("/proc", { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number(entry.name);
		try {
			const fields = statFields(pid);
			processes.set(pid, {
				pid,
				ppid: Number(fields[1]),
				startTime: fields[19]!,
			});
		} catch (error) {
			if (!isExitedProcessError(error)) throw error;
		}
	}
	return processes;
}

function identityOf(observation: ProcessObservation): ProcessIdentity {
	return { pid: observation.pid, startTime: observation.startTime };
}

function observationMatches(
	identity: ProcessIdentity,
	observation: ProcessObservation | undefined,
): boolean {
	return observation?.startTime === identity.startTime;
}

function waitForGuardianReady(guardian: ChildProcess): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Test process guardian readiness timed out"));
		}, 1_000);
		const onMessage = (message: unknown) => {
			cleanup();
			if (message === "ready") resolve();
			else reject(new Error("Test process guardian sent an invalid handshake"));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			reject(new Error(
				`Test process guardian exited before readiness: ${code ?? signal}`,
			));
		};
		const cleanup = () => {
			clearTimeout(timeout);
			guardian.off("message", onMessage);
			guardian.off("error", onError);
			guardian.off("exit", onExit);
		};
		guardian.on("message", onMessage);
		guardian.on("error", onError);
		guardian.on("exit", onExit);
	});
}

async function stopGuardian(guardian: ChildProcess | undefined): Promise<void> {
	if (!guardian || guardian.exitCode !== null || guardian.signalCode !== null) return;
	const exit = new Promise<void>((resolve) => guardian.once("exit", () => resolve()));
	guardian.send?.("release");
	await Promise.race([
		exit,
		new Promise<void>((resolve) => setTimeout(resolve, 100)),
	]);
	if (guardian.exitCode === null && guardian.signalCode === null) {
		guardian.kill("SIGKILL");
		await exit;
	}
}

function reapEmptyTestCgroups(parent: string): void {
	for (const entry of readdirSync(parent, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("pi-test-")) continue;
		const ownerPid = Number(/^pi-test-(\d+)-/.exec(entry.name)?.[1]);
		const ownerState = Number.isSafeInteger(ownerPid)
			? processState(ownerPid)
			: undefined;
		if (ownerState && ownerState !== "Z") continue;
		const path = join(parent, entry.name);
		try {
			const populated = readFileSync(join(path, "cgroup.events"), "utf8")
				.split("\n")
				.some((line) => line === "populated 1");
			if (!populated) rmdirSync(path);
		} catch (error) {
			if (!["EBUSY", "ENOENT", "ENOTEMPTY"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)) throw error;
		}
	}
}

function processState(pid: number): string | undefined {
	try {
		return statFields(pid)[0];
	} catch (error) {
		if (isExitedProcessError(error)) return undefined;
		throw error;
	}
}

function signalIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): void {
	if (!sameProcess(identity)) return;
	try {
		process.kill(identity.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function sameProcess(identity: ProcessIdentity): boolean {
	try {
		return statFields(identity.pid)[19] === identity.startTime;
	} catch (error) {
		if (isExitedProcessError(error)) return false;
		throw error;
	}
}

// A process that exits between the /proc listing and the read surfaces as
// ENOENT on open, or ESRCH when the exit lands after open.
function isExitedProcessError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ESRCH";
}

function statFields(pid: number): string[] {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
}

function signalNumber(signal: NodeJS.Signals): number {
	return osConstants.signals[signal] ?? 1;
}
