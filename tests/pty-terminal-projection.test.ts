import assert from "node:assert/strict";
import test from "node:test";

import {
	spawnPtyTerminalProjection,
	type PtyTerminalProjection,
} from "../src/process-runtime/pty-terminal-projection.ts";

const TEST_TIMEOUT_MS = 10_000;
/** Shorter than the test timeout, so a missing repaint fails an assertion, not the clock. */
const FRAME_WAIT_BOUND_MS = 3_000;

async function spawnNodeScript(
	script: string,
	columns = 24,
	rows = 6,
): Promise<PtyTerminalProjection> {
	return spawnPtyTerminalProjection({
		file: process.execPath,
		arguments: ["-e", script],
		cwd: process.cwd(),
		environment: { ...process.env, TERM: "xterm-256color" },
		columns,
		rows,
	});
}

test("real PTY output is parsed into styled cells, cursor, and dimensions before exit resolves", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.stdout.write("\x1b[2J\x1b[Hplain\x1b[2;3H\x1b[1;3;4;38;2;12;34;56;48;5;123mX\x1b[0m\x1b[3;1H😀\x1b[4;6H");
	`);

	const exit = await projection.exited;
	const frame = projection.frame();
	assert.deepEqual(exit, { exitCode: 0, signal: 0 });
	assert.equal(frame.columns, 24);
	assert.equal(frame.rows, 6);
	assert.equal(frame.lines[0]?.text, "plain");
	assert.deepEqual(frame.cursor, {
		column: 5,
		row: 3,
		visible: true,
		style: "block",
		blink: false,
	});
	assert.equal(frame.buffer, "normal");
	assert.equal(frame.lines[2]?.cells[0]?.text, "😀");
	assert.equal(frame.lines[2]?.cells[0]?.width, 2);
	assert.equal(frame.lines[2]?.cells[1]?.width, 0);
	assert.deepEqual(frame.lines[1]?.cells[2], {
		text: "X",
		width: 1,
		style: {
			foreground: { kind: "rgb", red: 12, green: 34, blue: 56 },
			background: { kind: "indexed", index: 123 },
			bold: true,
			dim: false,
			italic: true,
			underline: true,
			blink: false,
			inverse: false,
			invisible: false,
			strikethrough: false,
			overline: false,
		},
	});

	await projection.dispose();
	await projection.dispose();
	assert.equal(projection.disposed, true);
	assert.throws(() => projection.frame(), /disposed/);
});

test("user input is written to the real PTY byte-for-byte", { timeout: TEST_TIMEOUT_MS }, async () => {
	const input = "A\x1b[B\r\x1b[200~paste\ntext\x1b[201~";
	const expectedBytes = Buffer.from(input).length;
	const projection = await spawnNodeScript(String.raw`
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdout.write("READY");
		let input = Buffer.alloc(0);
		process.stdin.on("data", chunk => {
			input = Buffer.concat([input, chunk]);
			if (input.length >= ${expectedBytes}) {
				process.stdout.write("\x1b[2J\x1b[HINPUT_HEX=" + input.toString("hex"));
				process.exit(0);
			}
		});
	`, 100, 6);
	await waitForText(projection, "READY");

	projection.writeInput(input);
	await projection.exited;
	assert.equal(
		projection.frame().lines[0]?.text,
		`INPUT_HEX=${Buffer.from(input).toString("hex")}`,
	);
	await projection.dispose();
});

test("xterm-generated terminal replies use a separate PTY write path", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.once("data", reply => {
			process.stdout.write("\x1b[2J\x1b[HREPLY_HEX=" + reply.toString("hex"));
			process.exit(0);
		});
		process.stdout.write("\x1b[3;5H\x1b[6n");
	`);

	await projection.exited;
	assert.equal(
		projection.frame().lines[0]?.text,
		`REPLY_HEX=${Buffer.from("\u001b[3;5R").toString("hex")}`,
	);
	await projection.dispose();
});

test("physical attachment receives raw output and becomes the only terminal reply path", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const projection = await spawnNodeScript(String.raw`
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.once("data", reply => {
				process.stdout.write("\x1b[2J\x1b[HGOT_HEX=" + reply.toString("hex"));
				process.exit(0);
			});
			process.stdout.write("QUERY\x1b[6n");
			setTimeout(() => process.stdout.write("NO_EMULATED_REPLY"), 30);
		});
		process.stdout.write("READY");
	`);
	t.after(async () => {
		if (!projection.disposed) await projection.dispose();
	});
	const rawOutput: string[] = [];
	const removeOutputHandler = projection.addOutputHandler((data) => rawOutput.push(data));
	await projection.enterNativeTerminalMode();
	await waitForRawOutput(rawOutput, "READY");

	projection.writeInput("GO");
	await new Promise((resolve) => setTimeout(resolve, 60));
	await projection.drain();
	assert.match(rawOutput.join(""), /QUERY\x1b\[6n/);
	assert.match(rawOutput.join(""), /NO_EMULATED_REPLY/);
	assert.doesNotMatch(rawOutput.join(""), /GOT_HEX=/);

	const physicalReply = "PHYSICAL_REPLY";
	projection.writeInput(physicalReply);
	await projection.exited;
	assert.match(
		rawOutput.join(""),
		new RegExp(`GOT_HEX=${Buffer.from(physicalReply).toString("hex")}`),
	);
	removeOutputHandler();
	await projection.dispose();
});

test("hidden PTYs drain ANSI and progress output without parsing a background screen", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const projection = await spawnNodeScript(String.raw`
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", () => {
			for (let index = 0; index < 2_000; index += 1) {
				process.stdout.write("\x1b[2J\x1b[HHIDDEN_" + index);
			}
			process.stdout.write("\x1b]9;4;0\x07HIDDEN_DONE");
		});
		process.stdout.write("STARTUP");
	`, 80, 8);
	t.after(() => projection.dispose());
	await waitForText(projection, "STARTUP");
	await projection.enterNativeTerminalMode();
	const output: string[] = [];
	projection.addOutputHandler(data => output.push(data));
	let changes = 0;
	projection.addChangeHandler(() => changes++);
	projection.writeInput("WORK");
	await waitForRawOutput(output, "HIDDEN_DONE");
	await projection.drain();
	assert.equal(changes, 0);
	assert.equal(projection.frame().lines[0]?.text, "STARTUP");
	assert.match(output.join(""), /\x1b\]9;4;0\x07/);
	projection.resize(100, 30);
	assert.deepEqual(projection.dimensions(), { columns: 100, rows: 30 });
});

test("physical output backpressure pauses and resumes PTY reads", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const projection = await spawnNodeScript(String.raw`
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.once("data", () => process.exit(0));
		process.stdout.write("READY");
		setTimeout(() => process.stdout.write("BACKPRESSURED_OUTPUT"), 20);
	`);
	t.after(async () => {
		if (!projection.disposed) await projection.dispose();
	});
	const raw: string[] = [];
	const removeOutputHandler = projection.addOutputHandler((data) => raw.push(data));
	await waitForText(projection, "READY");

	projection.pauseOutput();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.doesNotMatch(
		projection.frame().lines.map(({ text }) => text).join("\n"),
		/BACKPRESSURED_OUTPUT/,
	);
	projection.resumeOutput();
	await waitForRawOutput(raw, "BACKPRESSURED_OUTPUT");
	assert.match(
		projection.frame().lines.map(({ text }) => text).join(""),
		/BACKPRESSURED_OUTPUT/,
	);
	projection.writeInput("EXIT");
	await projection.exited;
	removeOutputHandler();
	await projection.dispose();
});

test("live disposal parses final PTY output before releasing terminal state", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.on("SIGHUP", () => {
			process.stdout.write("\x1b[2J\x1b[HFINAL_SHUTDOWN_OUTPUT");
			process.exit(0);
		});
		process.stdout.write("READY");
		setInterval(() => undefined, 1000);
	`);
	await waitForText(projection, "READY");
	let finalOutputObserved = false;
	projection.addChangeHandler(() => {
		finalOutputObserved ||= projection.frame().lines.some((line) =>
			line.text.includes("FINAL_SHUTDOWN_OUTPUT")
		);
	});

	await projection.dispose();

	assert.equal(finalOutputObserved, true);
	assert.equal(projection.disposed, true);
});

test("child exit discards terminal replies before node-pty closes", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const errors: unknown[][] = [];
	const originalConsoleError = console.error;
	console.error = (...args: unknown[]) => errors.push(args);
	t.after(() => {
		console.error = originalConsoleError;
	});
	const projection = await spawnNodeScript(String.raw`
		process.stdout.write("\x1b[6n".repeat(100_000));
	`);

	await projection.exited;
	await projection.dispose();
	await new Promise<void>((resolve) => setTimeout(resolve, 50));

	assert.equal(
		errors.some((args) => args[0] === "Unhandled pty write error"),
		false,
	);
});

test("PTY disposal terminates stubborn descendants in the owned process group", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		const { spawn } = require("node:child_process");
		const descendantScript = [
			'process.on("SIGHUP", () => undefined);',
			'process.stdout.write("READY");',
			'setInterval(() => undefined, 1000);',
		].join("");
		const descendant = spawn(process.execPath, ["-e", descendantScript], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		descendant.stdout.once("data", () => {
			process.stdout.write("DESCENDANT_PID=" + descendant.pid);
		});
		setInterval(() => undefined, 1000);
	`);
	await waitForText(projection, "DESCENDANT_PID=");
	const rendered = projection.frame().lines.map((line) => line.text).join("\n");
	const descendantPid = Number(/DESCENDANT_PID=(\d+)/.exec(rendered)?.[1]);
	assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);

	try {
		await projection.dispose();
		await waitForProcessExit(descendantPid);
	} finally {
		try {
			process.kill(descendantPid, "SIGKILL");
		} catch {
			// The process-group cleanup under test already won.
		}
	}
});

test("explicit signals force a stubborn real PTY child to exact exit", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.on("SIGHUP", () => process.stdout.write("IGNORED_SIGHUP"));
		process.stdin.resume();
		process.stdout.write("READY");
	`);
	await waitForText(projection, "READY");

	projection.kill("SIGHUP");
	await waitForText(projection, "IGNORED_SIGHUP");
	projection.kill("SIGKILL");
	const exit = await projection.exited;
	assert.notEqual(exit.signal, 0);
	await projection.dispose();
});

test("frame changes expose cursor presentation and identical resize is a no-op", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		let resizeCount = 0;
		process.on("SIGWINCH", () => resizeCount += 1);
		process.stdin.setRawMode(true);
		process.stdin.resume();
		let inputCount = 0;
		process.stdin.on("data", () => {
			inputCount += 1;
			if (inputCount === 1) {
				process.stdout.write("\x1bc\x1b[0 qRESET");
				return;
			}
			process.stdout.write("\x1b[?25h\x1b[4 q\x1b[2J\x1b[HRESIZES=" + resizeCount);
			process.exit(0);
		});
		process.stdout.write("\x1b[?25l\x1b[5 qREADY");
	`);
	let changes = 0;
	const removeChangeHandler = projection.addChangeHandler(() => changes += 1);
	await waitForText(projection, "READY");
	assert.deepEqual(projection.frame().cursor, {
		column: 5,
		row: 0,
		visible: false,
		style: "bar",
		blink: true,
	});
	assert.ok(changes > 0);

	projection.writeInput("RESET");
	await waitForText(projection, "RESET");
	assert.deepEqual(projection.frame().cursor, {
		column: 5,
		row: 0,
		visible: true,
		style: "block",
		blink: true,
	});

	const changesBeforeIdenticalResize = changes;
	projection.resize(24, 6);
	assert.equal(changes, changesBeforeIdenticalResize);
	projection.writeInput("REPORT");
	await projection.exited;
	assert.equal(projection.frame().lines[0]?.text, "RESIZES=0");
	assert.deepEqual(projection.frame().cursor, {
		column: 9,
		row: 0,
		visible: true,
		style: "underline",
		blink: false,
	});
	removeChangeHandler();
	await projection.dispose();
});

test("resize updates xterm before notifying the real PTY", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.stdout.write("READY");
		process.on("SIGWINCH", () => {
			process.stdout.write("\x1b[2J\x1b[HPTY_SIZE=" + process.stdout.columns + "x" + process.stdout.rows);
			process.exit(0);
		});
		process.stdin.resume();
	`);
	await waitForText(projection, "READY");

	projection.resize(40, 9);
	assert.deepEqual(
		{ columns: projection.frame().columns, rows: projection.frame().rows },
		{ columns: 40, rows: 9 },
	);

	await projection.exited;
	assert.equal(projection.frame().lines[0]?.text, "PTY_SIZE=40x9");
	await projection.dispose();
});

test("a complete-frame wait settles on the child's full repaint, not an earlier incremental frame", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.stdout.write("READY");
		process.stdin.resume();
		process.stdin.once("data", () => {
			// Pi brackets a one-line incremental update exactly like a full redraw, so a
			// viewer handoff must not treat this frame as the child's complete screen.
			process.stdout.write("\x1b[?2026h\x1b[3;1H\x1b[?25l\x1b[?2026l");
			setTimeout(() => {
				process.stdout.write("\x1b[?2026h\x1b[2J\x1b[HREPAINTED\x1b[?25l\x1b[?2026l");
			}, 50);
		});
	`);
	await waitForText(projection, "READY");
	const frameWait = projection.waitForCompleteFrame(FRAME_WAIT_BOUND_MS);
	// The child's PTY is in cooked mode until it asks for raw input, so the command
	// needs its line terminator to reach the child's stdin handler.
	projection.writeInput("repaint\r");

	assert.equal(await frameWait.outcome, "complete");
	// The settled frame is the parsed repaint, not the grid the incremental frame left.
	assert.equal(projection.frame().lines[0]?.text, "REPAINTED");
	await projection.dispose();
});

test("a complete-frame wait stays bounded for a child that only repaints incrementally", { timeout: TEST_TIMEOUT_MS }, async () => {
	const projection = await spawnNodeScript(String.raw`
		process.stdout.write("READY");
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdout.write("\x1b[?2026h\x1b[3;1H\x1b[?25l\x1b[?2026l");
		});
	`);
	await waitForText(projection, "READY");
	const frameWait = projection.waitForCompleteFrame(250);
	projection.writeInput("incremental\r");

	assert.equal(await frameWait.outcome, "bounded");
	await projection.dispose();
});

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`PTY descendant ${pid} remained alive after disposal`);
}

async function waitForRawOutput(
	chunks: readonly string[],
	text: string,
): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (chunks.join("").includes(text)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`PTY raw output did not contain ${JSON.stringify(text)}`);
}

async function waitForText(
	projection: PtyTerminalProjection,
	text: string,
): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await projection.drain();
		if (projection.frame().lines.some((line) => line.text.includes(text))) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Terminal projection did not render ${JSON.stringify(text)}`);
}
