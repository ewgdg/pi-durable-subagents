import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Keep in sync with tests/fixtures/headless-owner-fixture.ts.
const FIXTURE = fileURLToPath(new URL("./fixtures/headless-owner-fixture.ts", import.meta.url));
const OWNER_PROMPT = "Delegate the headless work.";
const OWNER_DONE = "HEADLESS_OWNER_DONE WAITED_ANSWER ASYNC_ANSWER";
const EXIT_TIMEOUT_MS = 20_000;

function launch(mode: "rpc" | "print"): ChildProcessWithoutNullStreams {
	const child = spawn(process.execPath, [FIXTURE, mode], {
		env: { ...process.env, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	child.on("exit", (code) => {
		if (code !== 0) process.stderr.write(`headless fixture stderr:\n${stderr}\n`);
	});
	return child;
}

/** Every live descendant, so shutdown can be checked to leave no Agent process behind. */
function descendantPids(pid: number): number[] {
	let children: number[];
	try {
		children = execFileSync("ps", ["-o", "pid=", "--ppid", String(pid)], { encoding: "utf8" })
			.split("\n").map((line) => Number(line.trim())).filter((value) => value > 0);
	} catch {
		return [];
	}
	return children.flatMap((child) => [child, ...descendantPids(child)]);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function exitCode(child: ChildProcessWithoutNullStreams): Promise<number | null> {
	if (child.exitCode !== null) return child.exitCode;
	const timeout = setTimeout(() => child.kill("SIGKILL"), EXIT_TIMEOUT_MS);
	const [code] = await once(child, "exit") as [number | null];
	clearTimeout(timeout);
	return code;
}

async function assertNoneAlive(pids: readonly number[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (pids.some(isAlive)) {
		assert.ok(Date.now() < deadline, `Agent processes outlived the Owner: ${pids.filter(isAlive).join(", ")}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test("an RPC Owner completes spawn, agent_wait, and asynchronous Answer Delivery, and cleans up on replacement and shutdown", { timeout: 60_000 }, async () => {
	const child = launch("rpc");
	let stdout = "";
	const ownerDone = new Promise<void>((resolve) => {
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.includes(OWNER_DONE)) resolve();
		});
	});
	child.stdin.write(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: OWNER_PROMPT })}\n`);

	await Promise.race([
		ownerDone,
		once(child, "exit").then(() => assert.fail(`RPC fixture exited early:\n${stdout}`)),
	]);
	assert.match(stdout, /"id":"prompt-1","type":"response","command":"prompt","success":true/);
	const agentPids = descendantPids(child.pid!);
	assert.ok(agentPids.length > 0, "the RPC Owner launched Agent processes");

	// Native session replacement shuts the previous Workflow down before the new Owner starts.
	const replaced = new Promise<void>((resolve) => {
		child.stdout.on("data", () => {
			if (stdout.includes('"id":"new-1","type":"response","command":"new_session","success":true')) resolve();
		});
	});
	child.stdin.write(`${JSON.stringify({ id: "new-1", type: "new_session" })}\n`);
	await replaced;
	await assertNoneAlive(agentPids);

	// Closing stdin is the RPC client's shutdown request.
	child.stdin.end();
	assert.equal(await exitCode(child), 0);
	await assertNoneAlive(agentPids);
});

test("an RPC Owner keeps admitting prompts after resuming its own session", { timeout: 60_000 }, async (t) => {
	const child = launch("rpc");
	t.after(() => { child.kill("SIGKILL"); });
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	const ownerDoneCount = () => stdout.split("\n").filter((line) =>
		line.startsWith('{"type":"message_end"') && line.includes(OWNER_DONE)).length;
	const until = async (description: string, condition: () => boolean) => {
		const deadline = Date.now() + EXIT_TIMEOUT_MS;
		while (!condition()) {
			assert.ok(child.exitCode === null, `RPC fixture exited while waiting for ${description}:\n${stdout}`);
			assert.ok(Date.now() < deadline, `Timed out waiting for ${description}:\n${stdout}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const send = (command: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(command)}\n`);

	send({ id: "prompt-1", type: "prompt", message: OWNER_PROMPT });
	await until("the first Owner turn", () => ownerDoneCount() === 1);
	send({ id: "state-1", type: "get_state" });
	await until("the session state", () => stdout.includes('"id":"state-1"'));
	const stateLine = stdout.split("\n").find((line) => line.includes('"id":"state-1"'))!;
	const sessionFile = (JSON.parse(stateLine) as { data: { sessionFile: string } }).data.sessionFile;

	// Hosts such as T3 Code resume the live session file when a thread's model
	// changes. Pi's RPC mode binds the resumed session's extensions twice.
	send({ id: "switch-1", type: "switch_session", sessionPath: sessionFile });
	await until("the session switch", () => stdout.includes('"id":"switch-1","type":"response","command":"switch_session","success":true'));
	send({ id: "prompt-2", type: "prompt", message: OWNER_PROMPT });
	await until("the resumed Owner turn", () => ownerDoneCount() === 2 || stdout.includes("Agent input failed"));
	assert.deepEqual(stdout.match(/Agent input failed[^"]*/g) ?? [], []);

	child.stdin.end();
	assert.equal(await exitCode(child), 0);
});

test("a print-mode Owner joins and receives asynchronous Answers before it exits", { timeout: 60_000 }, async () => {
	const child = launch("print");
	let stdout = "";
	let agentPids: number[] = [];
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	const sampler = setInterval(() => {
		agentPids = [...new Set([...agentPids, ...descendantPids(child.pid!)])];
	}, 50);

	const code = await exitCode(child);
	clearInterval(sampler);

	assert.equal(code, 0);
	assert.equal(stdout.trim(), OWNER_DONE);
	assert.ok(agentPids.length > 0, "the print Owner launched Agent processes");
	await assertNoneAlive(agentPids);
});
