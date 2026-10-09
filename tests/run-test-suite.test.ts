import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("a test file fails when its tests leave a handle open, naming where it was created", {
	timeout: SUPERVISOR_TEST_TIMEOUT_MS,
}, async (t) => {
	const fixtureDirectory = await mkdtemp(join(tmpdir(), "pi-test-leaked-handles-"));
	t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
	const supervisedRunUrl = new URL("./support/supervised-run.ts", import.meta.url).href;
	const leakingPath = join(fixtureDirectory, "leaks.test.mjs");
	const cleanPath = join(fixtureDirectory, "cleans-up.test.mjs");
	await Promise.all([
		writeFile(leakingPath, [
			`import ${JSON.stringify(supervisedRunUrl)};`,
			`import { createServer } from "node:net";`,
			`import test from "node:test";`,
			`test("leaves an interval and a server running", () => {`,
			`	setInterval(() => {}, 1_000);`,
			`	createServer().listen(0, "localhost");`,
			`});`,
		].join("\n"), "utf8"),
		writeFile(cleanPath, [
			`import ${JSON.stringify(supervisedRunUrl)};`,
			`import { spawn } from "node:child_process";`,
			`import { createServer } from "node:net";`,
			`import { after, describe, test } from "node:test";`,
			`test("closes asynchronously in test-owned cleanup", (t) => {`,
			`	const server = createServer().listen(0);`,
			`	const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"]);`,
			`	t.after(() => { server.close(); child.kill(); });`,
			`});`,
			`describe("a suite sharing a server", () => {`,
			`	const server = createServer().listen(0);`,
			`	after(() => server.close());`,
			`	test("uses the shared server", () => {});`,
			`});`,
		].join("\n"), "utf8"),
	]);
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const run = (path: string) => runCommand(process.execPath, [
		"--test", "--test-force-exit", "--test-reporter=dot", path,
	], { cwd: fixtureDirectory, env });
	const [leaking, clean] = await Promise.all([run(leakingPath), run(cleanPath)]);

	assert.notEqual(leaking.code, 0, leaking.output);
	assert.match(leaking.output, /Timeout created at:\n\s+at .*leaks\.test\.mjs:5:\d+/, leaking.output);
	// The server binds after a host lookup, so only its trigger names this line.
	assert.match(leaking.output, /TCPServerWrap created at:\n\s+at .*leaks\.test\.mjs:6:\d+/i, leaking.output);
	assert.equal(clean.code, 0, clean.output);
});

for (const scenario of [
	{
		name: "a test that abandons its temporary directories",
		withDescendant: false,
		ending: "return",
		expectedExitCode: 0,
	},
	{
		name: "a surviving descendant that keeps recreating its temporary directories",
		withDescendant: true,
		ending: "return",
		expectedExitCode: 0,
	},
	{
		name: "a run that hits the supervisor deadline",
		withDescendant: true,
		ending: "deadline",
		expectedExitCode: 124,
	},
	{
		name: "a run interrupted with SIGTERM",
		withDescendant: true,
		ending: "interrupt",
		expectedExitCode: undefined,
	},
] as const) {
	test(`a supervised run leaves no temporary directories after ${scenario.name}`, {
		timeout: SUPERVISOR_TEST_TIMEOUT_MS,
		skip: process.platform === "linux"
			? false
			: "temporary runtime directories and process containment are Linux-specific",
	}, async (t) => {
		const outcome = await runTemporaryDirectoryFixture(t, scenario);

		if (scenario.expectedExitCode === undefined) {
			assert.notEqual(outcome.exitCode, 0, outcome.output);
		} else {
			assert.equal(outcome.exitCode, scenario.expectedExitCode, outcome.output);
		}
		const expectedWriters = scenario.withDescendant ? ["descendant", "test"] : ["test"];
		assert.deepEqual(outcome.evidence.map(({ writer }) => writer).sort(), expectedWriters);
		// Give a descendant that escaped containment time to recreate its directories.
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		const createdDirectories = outcome.evidence.flatMap(({ directories }) => directories);
		assert.equal(createdDirectories.length, expectedWriters.length * 2);
		assert.deepEqual(createdDirectories.filter((path) => existsSync(path)), [],
			`directories created during the run remain:\n${outcome.output}`);
		assert.deepEqual(await readdir(outcome.temporaryRoot), [],
			`the run left entries in its temporary directory:\n${outcome.output}`);
		assert.deepEqual(await readdir(outcome.runtimeRoot), [],
			`the run left entries in its runtime directory:\n${outcome.output}`);
	});
}

type TemporaryDirectoryEvidence = Readonly<{
	writer: "test" | "descendant";
	pid: number;
	directories: readonly string[];
}>;

async function runTemporaryDirectoryFixture(
	t: TestContext,
	scenario: Readonly<{ withDescendant: boolean; ending: "return" | "deadline" | "interrupt" }>,
): Promise<Readonly<{
	exitCode: number | null;
	output: string;
	evidence: readonly TemporaryDirectoryEvidence[];
	temporaryRoot: string;
	runtimeRoot: string;
}>> {
	const fixtureDirectory = await mkdtemp(join(tmpdir(), "pi-test-temporary-directories-"));
	// The run's temporary and runtime roots are private and start empty, so any
	// entry left in them afterwards is a net leak, whatever created it.
	const temporaryRoot = join(fixtureDirectory, "tmp");
	const runtimeRoot = join(fixtureDirectory, "runtime");
	const evidenceDirectory = join(fixtureDirectory, "evidence");
	const fixturePath = join(fixtureDirectory, "leaks-temporary-directories.test.mjs");
	const descendantPath = join(fixtureDirectory, "temporary-directory-writer.mjs");
	const launcherPath = join(fixtureDirectory, "supervisor-launcher.mjs");
	await Promise.all([temporaryRoot, runtimeRoot, evidenceDirectory]
		.map((path) => mkdir(path, { mode: 0o700 })));
	const deadlineMs = scenario.ending === "deadline" ? 1_500 : 5_000;
	await Promise.all([
		writeFile(fixturePath, temporaryDirectoryFixture(scenario, descendantPath), "utf8"),
		writeFile(descendantPath, temporaryDirectoryDescendant(), "utf8"),
		writeFile(launcherPath, testSupervisorLauncher(
			new URL("./support/test-process-supervisor.ts", import.meta.url).href,
			fixturePath,
			scenario.ending === "return" ? "complete" : "hang",
			deadlineMs,
		), "utf8"),
	]);

	const environment: NodeJS.ProcessEnv = {
		...process.env,
		TMPDIR: temporaryRoot,
		TMP: temporaryRoot,
		TEMP: temporaryRoot,
		XDG_RUNTIME_DIR: runtimeRoot,
		EVIDENCE_DIRECTORY: evidenceDirectory,
	};
	// Keep the user's session bus reachable even though the runtime root moved.
	if (process.env.XDG_RUNTIME_DIR && !environment.DBUS_SESSION_BUS_ADDRESS) {
		environment.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(process.env.XDG_RUNTIME_DIR, "bus")}`;
	}
	delete environment.NODE_TEST_CONTEXT;
	const runner = spawn(process.execPath, [launcherPath], {
		cwd: fixtureDirectory,
		detached: true,
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	runner.stdout!.on("data", (chunk) => output += String(chunk));
	runner.stderr!.on("data", (chunk) => output += String(chunk));
	const exited = new Promise<number | null>((resolve, reject) => {
		runner.once("error", reject);
		runner.once("exit", (code) => resolve(code));
	});
	// This watchdog lives outside the fixture supervisor, so a run that never
	// ends still fails within the test timeout instead of hanging it.
	const watchdog = setTimeout(() => signalIfAlive(-runner.pid!, "SIGKILL"), deadlineMs + 2_500);
	t.after(async () => {
		clearTimeout(watchdog);
		for (const { pid } of await readTemporaryDirectoryEvidence(evidenceDirectory)) {
			signalIfAlive(pid, "SIGKILL");
		}
		if (runner.pid) signalIfAlive(-runner.pid, "SIGKILL");
		await rm(fixtureDirectory, { recursive: true, force: true });
	});

	if (scenario.ending === "interrupt") {
		const expectedWriters = scenario.withDescendant ? 2 : 1;
		const deadline = Date.now() + FEEDBACK_TIMEOUT_MS;
		while ((await readTemporaryDirectoryEvidence(evidenceDirectory)).length < expectedWriters) {
			if (Date.now() > deadline) throw new Error(`fixture never recorded its directories:\n${output}`);
			await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
		process.kill(-runner.pid!, "SIGTERM");
	}
	const exitCode = await exited;
	clearTimeout(watchdog);
	return {
		exitCode,
		output,
		evidence: await readTemporaryDirectoryEvidence(evidenceDirectory),
		temporaryRoot,
		runtimeRoot,
	};
}

async function readTemporaryDirectoryEvidence(
	evidenceDirectory: string,
): Promise<readonly TemporaryDirectoryEvidence[]> {
	const names = (await readdir(evidenceDirectory)).filter((name) => name.endsWith(".json"));
	return Promise.all(names.map(async (name) =>
		JSON.parse(await readFile(join(evidenceDirectory, name), "utf8")) as TemporaryDirectoryEvidence));
}

// Shared by the test worker and its descendant: create nested directories in
// both the temporary and runtime roots, then record them for the outer test.
const TEMPORARY_DIRECTORY_FIXTURE_HELPERS = `
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createAbandonedDirectories(writer) {
	const directories = [tmpdir(), process.env.XDG_RUNTIME_DIR].map((root) => {
		const directory = mkdtempSync(join(root, writer + "-"));
		mkdirSync(join(directory, "nested", "deeper"), { recursive: true });
		writeFileSync(join(directory, "nested", "deeper", "file.txt"), "left behind");
		return directory;
	});
	const evidencePath = join(process.env.EVIDENCE_DIRECTORY, writer + ".json");
	writeFileSync(evidencePath + ".tmp", JSON.stringify({ writer, pid: process.pid, directories }));
	renameSync(evidencePath + ".tmp", evidencePath);
	return directories;
}
`;

function temporaryDirectoryDescendant(): string {
	return `${TEMPORARY_DIRECTORY_FIXTURE_HELPERS}
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
const directories = createAbandonedDirectories("descendant");
let sequence = 0;
// Keep writing, and recreate the directories if they disappear, so removal
// that races a still-running descendant is observable as a leftover.
setInterval(() => {
	for (const directory of directories) {
		try {
			mkdirSync(join(directory, "churn"), { recursive: true });
			writeFileSync(join(directory, "churn", String(sequence++)), "x");
		} catch {}
	}
}, 2);
`;
}

function temporaryDirectoryFixture(
	scenario: Readonly<{ withDescendant: boolean; ending: "return" | "deadline" | "interrupt" }>,
	descendantPath: string,
): string {
	return `${TEMPORARY_DIRECTORY_FIXTURE_HELPERS}
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";

test("abandons temporary directories", async () => {
	createAbandonedDirectories("test");
	${scenario.withDescendant ? `
	const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
		detached: true,
		stdio: "ignore",
	});
	descendant.unref();
	const descendantEvidence = join(process.env.EVIDENCE_DIRECTORY, "descendant.json");
	while (!existsSync(descendantEvidence)) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}` : ""}
	${scenario.ending === "return" ? "" : "setInterval(() => {}, 1000); await new Promise(() => {});"}
});
`;
}

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
