import assert from "node:assert/strict";
import test from "node:test";

import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type Focusable } from "@earendil-works/pi-tui";

import {
	createAdmittedPiChildProcessProjection,
	type AdmittedPiChildProjectionRuntime,
} from "../src/process-runtime/admitted-pi-child-process-projection.ts";
import {
	createPiChildProcessProjection,
	type PiChildProjectionLaunch,
} from "../src/process-runtime/pi-child-process-projection.ts";
import type { PiChildRuntimeEvent } from "../src/process-runtime/pi-child-process-runtime.ts";
import type {
	PtyExit,
	TerminalCellStyle,
	TerminalProjectionCell,
	TerminalProjectionFrame,
} from "../src/process-runtime/pty-terminal-projection.ts";

const DEFAULT_STYLE: TerminalCellStyle = {
	foreground: { kind: "default" },
	background: { kind: "default" },
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	blink: false,
	inverse: false,
	invisible: false,
	strikethrough: false,
	overline: false,
};

function cell(
	text: string,
	width = 1,
	style: TerminalCellStyle = DEFAULT_STYLE,
): TerminalProjectionCell {
	return { text, width, style };
}

test("admitted process terminal projection renders exact terminal styling, wide cells, and focused cursor metadata", () => {
	const runtime = new FakeRuntime({
		columns: 6,
		rows: 2,
		buffer: "alternate",
		cursor: { column: 3, row: 0, visible: true, style: "bar", blink: true },
		lines: [
			{
				text: "A界B",
				wrapped: false,
				cells: [
					cell("A", 1, {
						foreground: { kind: "rgb", red: 1, green: 2, blue: 3 },
						background: { kind: "indexed", index: 123 },
						bold: true,
						dim: true,
						italic: true,
						underline: true,
						blink: true,
						inverse: true,
						invisible: true,
						strikethrough: true,
						overline: true,
					}),
					cell("界", 2),
					cell("", 0),
					cell("B"),
					cell(""),
					cell(""),
				],
			},
			{ text: "", wrapped: false, cells: Array.from({ length: 6 }, () => cell("")) },
		],
	});
	const projection = createAdmittedPiChildProcessProjection(runtime);
	const presentation = projection.presentation as typeof projection.presentation & Focusable;

	const unfocused = presentation.render(6);
	assert.equal(unfocused.length, 2);
	assert.equal(stripTerminalSequences(unfocused[0]!), "A界▏");
	assert.equal(visibleWidth(unfocused[0]!), 4);
	assert.ok(!unfocused[0]!.includes(CURSOR_MARKER));
	assert.match(unfocused[0]!, /\x1b\[0;1;2;3;4;5;7;8;9;53;38;2;1;2;3;48;5;123mA/);

	presentation.focused = true;
	const focused = presentation.render(6);
	assert.ok(focused[0]!.includes(CURSOR_MARKER));
	assert.match(focused[0]!, /\x1b\[0;5;39;49m▏/);
	assert.equal(stripTerminalSequences(focused[0]!), "A界▏");
	assert.equal(visibleWidth(focused[0]!), 4);
});

test("admitted process terminal projection preserves visible cursor styles and hides cursor presentation", () => {
	for (const expected of [
		{ style: "block" as const, text: "X", sgr: /\x1b\[0;7;39;49mX/ },
		{ style: "underline" as const, text: "X", sgr: /\x1b\[0;4;39;49mX/ },
		{ style: "bar" as const, text: "▏", sgr: /\x1b\[0;39;49m▏/ },
	]) {
		const frame = frameWithText("X", 2, 1);
		const runtime = new FakeRuntime({
			...frame,
			cursor: { column: 0, row: 0, visible: true, style: expected.style, blink: false },
		});
		const projection = createAdmittedPiChildProcessProjection(runtime);
		const presentation = projection.presentation as typeof projection.presentation & Focusable;
		presentation.focused = true;
		const line = presentation.render(2)[0]!;
		assert.equal(stripTerminalSequences(line), expected.text);
		assert.match(line, expected.sgr);
		assert.ok(line.includes(CURSOR_MARKER));
	}

	const hiddenFrame = frameWithText("X", 2, 1);
	const hidden = createAdmittedPiChildProcessProjection(new FakeRuntime({
		...hiddenFrame,
		cursor: { ...hiddenFrame.cursor, visible: false },
	}));
	const presentation = hidden.presentation as typeof hidden.presentation & Focusable;
	presentation.focused = true;
	const line = presentation.render(2)[0]!;
	assert.equal(stripTerminalSequences(line), "X");
	assert.ok(!line.includes(CURSOR_MARKER));
	assert.doesNotMatch(line, /\x1b\[0;(?:4|7);/);
});

test("admitted process terminal projection bounds emoji and width-zero cursor cells", () => {
	const unicodeFrames: readonly TerminalProjectionFrame[] = [
		{
			columns: 1,
			rows: 1,
			buffer: "normal",
			cursor: { column: 0, row: 0, visible: false, style: "block", blink: false },
			lines: [{ text: "✈️", wrapped: false, cells: [cell("✈️", 1)] }],
		},
		{
			columns: 1,
			rows: 1,
			buffer: "normal",
			cursor: { column: 0, row: 0, visible: false, style: "block", blink: false },
			lines: [{ text: "🫠", wrapped: false, cells: [cell("🫠", 1)] }],
		},
		{
			columns: 4,
			rows: 1,
			buffer: "normal",
			cursor: { column: 0, row: 0, visible: false, style: "block", blink: false },
			lines: [{
				text: "👨‍👩‍👧‍👦",
				wrapped: false,
				cells: [cell("👨‍"), cell("👩‍"), cell("👧‍"), cell("👦")],
			}],
		},
	];
	for (const frame of unicodeFrames) {
		const line = createAdmittedPiChildProcessProjection(new FakeRuntime(frame))
			.presentation.render(frame.columns)[0]!;
		assert.ok(visibleWidth(line) <= frame.columns);
	}

	const combiningFrame: TerminalProjectionFrame = {
		columns: 1,
		rows: 1,
		buffer: "normal",
		cursor: { column: 0, row: 0, visible: true, style: "bar", blink: false },
		lines: [{ text: "́", wrapped: false, cells: [cell("́", 0)] }],
	};
	const combining = createAdmittedPiChildProcessProjection(new FakeRuntime(combiningFrame));
	const combiningPresentation = combining.presentation as typeof combining.presentation & Focusable;
	combiningPresentation.focused = true;
	const combiningLine = combiningPresentation.render(1)[0]!;
	assert.equal(stripTerminalSequences(combiningLine), "▏");
	assert.equal(visibleWidth(combiningLine), 1);
});

test("admitted process terminal projection maps terminal operations and events without render-driven resize", async () => {
	const runtime = new FakeRuntime(frameWithText("ready", 8, 3));
	const projection = createAdmittedPiChildProcessProjection(runtime);
	let changes = 0;
	const failures: unknown[] = [];
	let exits = 0;
	projection.addChangeHandler(() => changes += 1);
	projection.addFailureHandler((error) => failures.push(error));
	projection.addExitRequestHandler(() => exits += 1);

	projection.presentation.render(8);
	projection.presentation.render(5);
	assert.deepEqual(runtime.resizes, []);
	projection.resize(8, 3);
	assert.deepEqual(runtime.resizes, []);
	projection.resize(10, 4);
	assert.deepEqual(runtime.resizes, [{ columns: 10, rows: 4 }]);

	const input = "A\x1b[B\r\x1b[200~paste\ntext\x1b[201~";
	projection.dispatchInput(input);
	assert.deepEqual(runtime.inputs, [input]);
	projection.focusEditor();
	assert.deepEqual(runtime.inputs, [input]);
	const physicalOutput: string[] = [];
	const removeOutputHandler = await projection.physicalTerminal.beginAttachment((data) => {
		physicalOutput.push(data);
	});
	projection.physicalTerminal.pauseOutput();
	projection.physicalTerminal.resumeOutput();
	runtime.notifyOutput("raw-output");
	removeOutputHandler();
	await projection.physicalTerminal.endAttachment();
	assert.deepEqual(physicalOutput, ["raw-output"]);
	assert.deepEqual(runtime.physicalAttachmentStates, [true, false]);
	assert.equal(runtime.pauseOutputCount, 1);
	assert.equal(runtime.resumeOutputCount, 1);
	assert.equal(runtime.visibilityChangeCount, 2);

	runtime.notifyChange();
	const terminalFailure = new Error("terminal parser failed");
	runtime.notifyFailure(terminalFailure);
	const runtimeFailure = new Error("runtime bridge failed");
	runtime.notifyEvent({
		event: "runtime.fault",
		payload: { code: "test", message: runtimeFailure.message },
		sequence: 1,
	});
	assert.equal(changes, 2);
	assert.equal(failures[0], terminalFailure);
	assert.match(String(failures[1]), /runtime bridge failed/);

	runtime.settleExit({ exitCode: 0, signal: 0 });
	await runtime.exited;
	await Promise.resolve();
	assert.equal(exits, 1);
	assert.equal(failures.length, 2);
	await projection.dispose();
	await projection.dispose();
	assert.equal(runtime.disposeCount, 1);
});

test("hosted child launch keeps submitted PTY input active until Agent Run admission", async () => {
	const launch = new FakeLaunch(frameWithText("starting", 8, 3));
	const projection = createPiChildProcessProjection(launch);
	assert.equal(projection.ready(), projection.ready());
	let dispatchIdle: Promise<void> | undefined;
	launch.observeWrite = () => {
		assert.equal(projection.isProcessingInput(), true);
		dispatchIdle = projection.whenInputIdle();
	};

	projection.dispatchInput("byte-exact\r");
	assert.ok(dispatchIdle);
	let inputSettled = false;
	void dispatchIdle.then(() => inputSettled = true);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(inputSettled, false);
	assert.equal(projection.isProcessingInput(), true);
	launch.notifyEvent({
		event: "runtime.input.started",
		payload: { sequence: 1 },
		sequence: 1,
	});
	launch.notifyEvent({
		event: "runtime.input.submissionAcknowledged",
		payload: { sequence: 1 },
		sequence: 2,
	});
	assert.equal(projection.isProcessingInput(), true);
	launch.notifyEvent({
		event: "agent.start",
		payload: { runId: "native-1", queuedInputCount: 0 },
		sequence: 3,
	});
	assert.equal(projection.isProcessingInput(), false);
	await dispatchIdle;
	launch.settleReady();
	await projection.ready();
	await projection.dispose();
});

test("hosted child launch settles handled input without an Agent Run", async () => {
	const launch = new FakeLaunch(frameWithText("starting", 8, 3));
	const projection = createPiChildProcessProjection(launch);

	projection.dispatchInput("handled\r");
	const inputIdle = projection.whenInputIdle();
	launch.notifyEvent({
		event: "runtime.input.started",
		payload: { sequence: 1 },
		sequence: 1,
	});
	launch.notifyEvent({
		event: "runtime.input.submissionAcknowledged",
		payload: { sequence: 1 },
		sequence: 2,
	});
	assert.equal(projection.isProcessingInput(), true);
	launch.notifyEvent({
		event: "runtime.input.completed",
		payload: { sequence: 1 },
		sequence: 3,
	});
	await inputIdle;
	assert.equal(projection.isProcessingInput(), false);
	await projection.dispose();
});

test("hosted child launch does not treat multiline paste data as submission", async () => {
	const launch = new FakeLaunch(frameWithText("starting", 8, 3));
	const projection = createPiChildProcessProjection(launch);

	projection.dispatchInput("\u001b[200~first\nsecond\u001b[201~");
	await projection.whenInputIdle();
	assert.equal(projection.isProcessingInput(), false);
	await projection.dispose();
});

test("hosted child launch ignores late input lifecycle events after release", async () => {
	const launch = new FakeLaunch(frameWithText("starting", 8, 3));
	const projection = createPiChildProcessProjection(launch);

	projection.dispatchInput("late\r");
	const inputIdle = projection.whenInputIdle();
	await projection.dispose();
	await inputIdle;
	launch.notifyEvent({
		event: "runtime.input.started",
		payload: { sequence: 1 },
		sequence: 1,
	});
	launch.notifyEvent({
		event: "runtime.input.completed",
		payload: { sequence: 1 },
		sequence: 2,
	});
	launch.notifyEvent({
		event: "runtime.input.submissionAcknowledged",
		payload: { sequence: 1 },
		sequence: 3,
	});
	assert.equal(projection.isProcessingInput(), false);
});

test("abnormal process exit is both a projection failure and an exit request", async () => {
	const runtime = new FakeRuntime(frameWithText("failed", 8, 3));
	const projection = createAdmittedPiChildProcessProjection(runtime);
	const failures: unknown[] = [];
	let exits = 0;
	projection.addFailureHandler((error) => failures.push(error));
	projection.addExitRequestHandler(() => exits += 1);

	runtime.settleExit({ exitCode: 7, signal: 0 });
	await runtime.exited;
	await Promise.resolve();
	assert.equal(exits, 1);
	assert.match(String(failures[0]), /code 7 signal 0/);
	await projection.dispose();
});

function frameWithText(text: string, columns: number, rows: number): TerminalProjectionFrame {
	return {
		columns,
		rows,
		buffer: "alternate",
		cursor: { column: text.length, row: 0, visible: false, style: "block", blink: false },
		lines: Array.from({ length: rows }, (_, row) => ({
			text: row === 0 ? text : "",
			wrapped: false,
			cells: Array.from({ length: columns }, (_, column) =>
				cell(row === 0 ? (text[column] ?? "") : "")),
		})),
	};
}

class FakeRuntime implements AdmittedPiChildProjectionRuntime {
	readonly inputs: string[] = [];
	readonly resizes: Array<{ columns: number; rows: number }> = [];
	readonly #changeHandlers = new Set<() => void>();
	readonly #failureHandlers = new Set<(error: unknown) => void>();
	readonly #outputHandlers = new Set<(data: string) => void>();
	readonly #eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	readonly physicalAttachmentStates: boolean[] = [];
	pauseOutputCount = 0;
	resumeOutputCount = 0;
	visibilityChangeCount = 0;
	#frame: TerminalProjectionFrame;
	#settleExit!: (exit: PtyExit) => void;
	observeWrite: (() => void) | undefined;
	disposeCount = 0;
	readonly exited = new Promise<PtyExit>((resolve) => this.#settleExit = resolve);

	constructor(frame: TerminalProjectionFrame) {
		this.#frame = frame;
	}

	dimensions() {
		return { columns: this.#frame.columns, rows: this.#frame.rows };
	}

	frame(): TerminalProjectionFrame {
		return this.#frame;
	}

	writeInput(data: string | Buffer): void {
		this.inputs.push(typeof data === "string" ? data : data.toString("utf8"));
		this.observeWrite?.();
	}

	resize(columns: number, rows: number): void {
		this.resizes.push({ columns, rows });
		this.#frame = { ...this.#frame, columns, rows };
		this.notifyChange();
	}

	addChangeHandler(handler: () => void): () => void {
		this.#changeHandlers.add(handler);
		return () => this.#changeHandlers.delete(handler);
	}

	addFailureHandler(handler: (error: unknown) => void): () => void {
		this.#failureHandlers.add(handler);
		return () => this.#failureHandlers.delete(handler);
	}

	beginPhysicalTerminalAttachment(
		handler: (data: string) => void,
	): Promise<() => void> {
		this.physicalAttachmentStates.push(true);
		this.visibilityChangeCount += 1;
		this.#outputHandlers.add(handler);
		return Promise.resolve(() => this.#outputHandlers.delete(handler));
	}

	beginScreenView(): Promise<void> {
		this.physicalAttachmentStates.push(true);
		this.visibilityChangeCount += 1;
		return Promise.resolve();
	}

	hidePresentation(): Promise<void> {
		this.physicalAttachmentStates.push(false);
		this.visibilityChangeCount += 1;
		return Promise.resolve();
	}

	pauseOutput(): void {
		this.pauseOutputCount += 1;
	}

	resumeOutput(): void {
		this.resumeOutputCount += 1;
	}

	onEvent(handler: (event: PiChildRuntimeEvent) => void): () => void {
		this.#eventHandlers.add(handler);
		return () => this.#eventHandlers.delete(handler);
	}

	dispose(): Promise<void> {
		this.disposeCount += 1;
		return Promise.resolve();
	}

	notifyChange(): void {
		for (const handler of this.#changeHandlers) handler();
	}

	notifyFailure(error: unknown): void {
		for (const handler of this.#failureHandlers) handler(error);
	}

	notifyOutput(data: string): void {
		for (const handler of this.#outputHandlers) handler(data);
	}

	notifyEvent(event: PiChildRuntimeEvent): void {
		for (const handler of this.#eventHandlers) handler(event);
	}

	settleExit(exit: PtyExit): void {
		this.#settleExit(exit);
	}
}

class FakeLaunch extends FakeRuntime implements PiChildProjectionLaunch {
	#settleReady!: () => void;
	#rejectReady!: (error: unknown) => void;
	#pending = true;
	readonly #readiness = new Promise<void>((resolve, reject) => {
		this.#settleReady = resolve;
		this.#rejectReady = reject;
	});

	ready(): Promise<void> {
		return this.#readiness;
	}

	cancelInitialization(error: unknown): Promise<void> | undefined {
		if (!this.#pending) return undefined;
		this.#pending = false;
		this.#rejectReady(error);
		return Promise.resolve();
	}

	settleReady(): void {
		if (!this.#pending) return;
		this.#pending = false;
		this.#settleReady();
	}
}

test("resize reads dimensions without materializing a terminal frame", () => {
	const runtime = new FakeRuntime(frameWithText("startup", 80, 24));
	runtime.frame = () => { throw new Error("resize must not read cells"); };
	const projection = createAdmittedPiChildProcessProjection(runtime);
	projection.resize(80, 24);
	projection.resize(120, 40);
	assert.deepEqual(runtime.resizes, [{ columns: 120, rows: 40 }]);
});
