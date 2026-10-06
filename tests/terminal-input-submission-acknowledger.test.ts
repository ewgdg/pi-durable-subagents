import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { TerminalInputSubmissionAcknowledger } from "../src/process-runtime/terminal-input-submission-acknowledger.ts";

test("submission acknowledgment continuity survives listener replacement", () => {
	const acknowledged: number[] = [];
	const acknowledger = new TerminalInputSubmissionAcknowledger((sequence) => {
		acknowledged.push(sequence);
	});
	const firstGeneration = acknowledger.bind();

	firstGeneration.handleInput("before reload\r");
	firstGeneration.dispose();
	const secondGeneration = acknowledger.bind();
	firstGeneration.handleInput("stale generation\r");
	secondGeneration.handleInput("after reload\r");

	assert.deepEqual(acknowledged, [1, 2]);
	secondGeneration.dispose();
});

test("submission acknowledgment keeps fragmented terminal and paste semantics across generations", () => {
	const acknowledged: number[] = [];
	const acknowledger = new TerminalInputSubmissionAcknowledger((sequence) => {
		acknowledged.push(sequence);
	});
	const firstGeneration = acknowledger.bind();

	firstGeneration.handleInput("\x1b[200~multiline\r");
	firstGeneration.handleInput("paste\n\x1b[201~");
	assert.deepEqual(acknowledged, []);
	firstGeneration.handleInput("\r");
	assert.deepEqual(acknowledged, [1]);

	const secondGeneration = acknowledger.bind();
	firstGeneration.handleInput("\r");
	secondGeneration.handleInput("\r");
	assert.deepEqual(acknowledged, [1, 2]);
	firstGeneration.dispose();
	secondGeneration.dispose();
});
