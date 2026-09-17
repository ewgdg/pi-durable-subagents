import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { PI_TEST_ENVIRONMENT_MARKER } from "./support/pi-test-environment.ts";

const FEEDBACK_TIMEOUT_MS = 5_000;
const SUPERVISOR_TEST_TIMEOUT_MS = 10_000;
const PROCESS_TEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 10;
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the suite supervisor leaves no test descendants", {
	timeout: SUPERVISOR_TEST_TIMEOUT_MS,
	skip: process.platform === "linux"
		? false
		: "process-tree hardening uses Linux cgroup-v2 and /proc",
}, async (t) => {
	const interrupted = await launchFixture(t, "hang");
	process.kill(-interrupted.runner.pid!, "SIGTERM");
	await waitForExitWithEscalation(interrupted.runner);
	await assertNoProcessesAlive(interrupted.evidence);

	const forceKilled = await launchFixture(t, "block");
	forceKilled.runner.kill("SIGKILL");
	await waitForProcessExit(forceKilled.runner.pid!, FEEDBACK_TIMEOUT_MS);
	await assertNoProcessesAlive(forceKilled.evidence);

	const guardianLost = await launchFixture(t, "hang");
	signalIfAlive(guardianLost.evidence.guardianPid, "SIGKILL");
	await waitForProcessExit(guardianLost.runner.pid!, FEEDBACK_TIMEOUT_MS);
	await assertNoProcessesAlive(guardianLost.evidence);

	const completed = await launchFixture(t, "complete");
	await waitForProcessExit(completed.runner.pid!, FEEDBACK_TIMEOUT_MS);
	await assertNoProcessesAlive(completed.evidence);

	const timedOut = await launchFixture(t, "timeout");
	await waitForProcessExit(timedOut.runner.pid!, FEEDBACK_TIMEOUT_MS);
	await assertNoProcessesAlive(timedOut.evidence);

	const parallel = await Promise.all([
		launchFixture(t, "complete"),
		launchFixture(t, "complete"),
	]);
	for (const fixture of parallel) {
		await waitForProcessExit(fixture.runner.pid!, FEEDBACK_TIMEOUT_MS);
		await assertNoProcessesAlive(fixture.evidence);
	}
});

test("the supervisor deadline contains synchronous spin and ignored termination", {
	timeout: SUPERVISOR_TEST_TIMEOUT_MS,
	skip: process.platform !== "linux",
}, async (t) => {
	for (const mode of ["block", "hang"] as const) {
		const fixture = await launchFixture(t, mode, 300);
		await waitForProcessExit(fixture.runner.pid!, 2_000);
		if (fixture.runner.exitCode === null && fixture.runner.signalCode === null) {
			await new Promise<void>((resolve) => fixture.runner.once("exit", () => resolve()));
		}
		assert.equal(fixture.runner.exitCode, 124);
		await assertNoProcessesAlive(fixture.evidence);
	}
});

test("conformance uses supervised selection and rejects invalid deadlines", {
	timeout: FEEDBACK_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const listed = await runCommand("npm", ["run", "test:conformance", "--",
		"--file=host-shape.test.ts", "--list"], { cwd: PROJECT_ROOT, env });
	assert.equal(listed.code, 0, listed.output);
	assert.ok(listed.output.trim().endsWith("host-shape.test.ts"));
	const expired = await runCommand(process.execPath, [
		"tests/support/run-test-suite.ts", "fast", "--file=host-shape.test.ts",
		"--deadline-ms=1",
	], { cwd: PROJECT_ROOT, env });
	assert.equal(expired.code, 124, expired.output);
	assert.match(expired.output, /supervisor deadline/);
	for (const value of ["", "0", "-1", "NaN", "1.5", "2147483648"]) {
		const invalid = await runCommand(process.execPath, [
			"tests/support/run-test-suite.ts", "fast", "--file=host-shape.test.ts",
			"--deadline-ms=" + value,
		], { cwd: PROJECT_ROOT, env });
		assert.notEqual(invalid.code, 0);
		assert.match(invalid.output, /deadline/i);
	}
});

test("the suite isolates Pi settings inherited from a spawned Agent", {
	timeout: PROCESS_TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async (t) => {
	await assertPiSettingsRemainUnchanged(t, [
		"tests/support/run-test-suite.ts",
		"process",
		"--file=pi-child-hosted-runtime.test.ts",
		"--test-name-pattern=the common Runtime Host supervises",
	]);
});

test("direct process-test execution isolates Pi settings inherited from a spawned Agent", {
	timeout: PROCESS_TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async (t) => {
	await assertPiSettingsRemainUnchanged(t, [
		"--test",
		"--test-concurrency=1",
		"--test-reporter=spec",
		"--test-name-pattern=the common Runtime Host supervises",
		"tests/pi-child-hosted-runtime.test.ts",
	]);
});

async function assertPiSettingsRemainUnchanged(
	t: TestContext,
	arguments_: readonly string[],
): Promise<void> {
	const inheritedAgentDir = await mkdtemp(join(tmpdir(), "pi-inherited-agent-dir-"));
	const settingsPath = join(inheritedAgentDir, "settings.json");
	const originalSettings = `${JSON.stringify({
		defaultProvider: "user-provider",
		defaultModel: "user-model",
		defaultThinkingLevel: "high",
	}, null, 2)}\n`;
	await writeFile(settingsPath, originalSettings, "utf8");
	t.after(() => rm(inheritedAgentDir, { recursive: true, force: true }));

	const environment: NodeJS.ProcessEnv = {
		...process.env,
		PI_DURABLE_SUBAGENTS_BOOTSTRAP: join(inheritedAgentDir, "inherited-bootstrap.json"),
		PI_CODING_AGENT_DIR: inheritedAgentDir,
		PI_SKIP_VERSION_CHECK: "1",
	};
	delete environment.NODE_TEST_CONTEXT;
	// Model a production Agent launching tests, not the test process that launches this probe.
	delete environment[PI_TEST_ENVIRONMENT_MARKER];
	const outcome = await runCommand(process.execPath, arguments_, {
		cwd: PROJECT_ROOT,
		env: environment,
	});

	assert.equal(outcome.code, 0, outcome.output);
	assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
}

type ProcessEvidence = Readonly<{
	testRunnerPid: number;
	workerPid: number;
	descendantPid: number;
	guardianPid: number;
	cgroups: readonly string[];
}>;

type FixtureHarness = Readonly<{
	runner: ChildProcess;
	evidence: ProcessEvidence;
}>;

async function launchFixture(
	t: TestContext,
	mode: "hang" | "block" | "complete" | "timeout",
	deadlineMs = 5_000,
): Promise<FixtureHarness> {
	const fixtureDirectory = await mkdtemp(join(tmpdir(), "pi-test-runner-tree-"));
	const fixturePath = join(fixtureDirectory, "orphan-process-tree.test.mjs");
	const launcherPath = join(fixtureDirectory, "supervisor-launcher.mjs");
	const processEvidencePath = join(fixtureDirectory, "processes.json");
	await Promise.all([
		writeFile(fixturePath, processTreeFixture(mode), "utf8"),
		writeFile(
			launcherPath,
			testSupervisorLauncher(
				new URL("./support/test-process-supervisor.ts", import.meta.url).href,
				fixturePath,
				mode,
				deadlineMs,
			),
			"utf8",
		),
	]);
	const runnerEnvironment: NodeJS.ProcessEnv = {
		...process.env,
		PROCESS_EVIDENCE_PATH: processEvidencePath,
	};
	delete runnerEnvironment.NODE_TEST_CONTEXT;
	const runner = spawn(process.execPath, [launcherPath], {
		detached: true,
		env: runnerEnvironment,
		stdio: "ignore",
	});
	// This watchdog lives outside the fixture supervisor, so a missing deadline
	// still fails safely. Teardown also kills recorded detached descendants.
	const watchdog = setTimeout(() => runner.kill("SIGTERM"), 2_500);
	runner.once("exit", () => clearTimeout(watchdog));
	let evidence: ProcessEvidence | undefined;
	t.after(async () => {
		clearTimeout(watchdog);
		for (const pid of [
			evidence?.descendantPid,
			evidence?.guardianPid,
			evidence?.workerPid,
			evidence?.testRunnerPid,
			runner.pid,
		]) {
			if (pid) signalIfAlive(pid, "SIGKILL");
		}
		await rm(fixtureDirectory, { recursive: true, force: true });
	});
	evidence = JSON.parse(
		await waitForFile(processEvidencePath, FEEDBACK_TIMEOUT_MS),
	) as ProcessEvidence;
	return { runner, evidence };
}

async function runCommand(
	command: string,
	arguments_: readonly string[],
	options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>,
): Promise<Readonly<{ code: number | null; output: string }>> {
	const child = spawn(command, arguments_, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout!.on("data", (chunk) => output += String(chunk));
	child.stderr!.on("data", (chunk) => output += String(chunk));
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	return { code, output };
}

async function waitForExitWithEscalation(runner: ChildProcess): Promise<void> {
	try {
		await waitForProcessExit(runner.pid!, 500);
	} catch {
		// Model an external timeout escalating if graceful supervision regresses.
		runner.kill("SIGKILL");
		await waitForProcessExit(runner.pid!, 500);
	}
}

async function assertNoProcessesAlive(evidence: ProcessEvidence): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(
		[
			evidence.guardianPid,
			evidence.testRunnerPid,
			evidence.workerPid,
			evidence.descendantPid,
		].filter(isProcessAlive),
		[],
		`the suite supervisor left descendants alive: ${JSON.stringify(evidence)}`,
	);
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(`Timed out waiting for process evidence: ${path}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(`Process ${pid} did not exit`);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
			return state !== "Z";
		}
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH" || code === "ENOENT") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function testSupervisorLauncher(
	supervisorUrl: string,
	fixturePath: string,
	mode: "hang" | "block" | "complete" | "timeout",
	deadlineMs: number,
): string {
	return `
import { runTestProcess } from ${JSON.stringify(supervisorUrl)};
process.exitCode = await runTestProcess([
	"--test",
	"--test-concurrency=1",
	"--test-reporter=dot",
	${mode === "timeout" ? '"--test-timeout=100",' : ""}
	${JSON.stringify(fixturePath)},
], ${deadlineMs});
`;
}

function processTreeFixture(
	mode: "hang" | "block" | "complete" | "timeout",
): string {
	return `
import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import test from "node:test";

test("orphan process tree fixture", async () => {
	process.on("SIGTERM", () => {});
	const descendant = spawn(process.execPath, [
		"--input-type=module",
		"--eval",
		"process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); setInterval(() => {}, 1000);",
	], { detached: true, stdio: "ignore" });
	descendant.unref();
	const evidence = JSON.stringify({
		testRunnerPid: process.ppid,
		workerPid: process.pid,
		descendantPid: descendant.pid,
		guardianPid: Number(process.env.PI_TEST_GUARDIAN_PID),
		cgroups: await Promise.all([
			readFile("/proc/" + process.ppid + "/cgroup", "utf8"),
			readFile("/proc/" + process.pid + "/cgroup", "utf8"),
			readFile("/proc/" + descendant.pid + "/cgroup", "utf8"),
		]),
	});
	await writeFile(process.env.PROCESS_EVIDENCE_PATH + ".tmp", evidence);
	await rename(process.env.PROCESS_EVIDENCE_PATH + ".tmp", process.env.PROCESS_EVIDENCE_PATH);
	${mode === "complete"
		? ""
		: mode === "block"
			? "while (true) {}"
			: "setInterval(() => {}, 1000); await new Promise(() => {});"}
});
`;
}
