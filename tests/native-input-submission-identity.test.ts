import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { NativeInputSubmissionIdentity } from "../src/process-runtime/native-input-submission-identity.ts";

test("a current native input keeps its identity while later terminal submissions queue", () => {
	const identity = new NativeInputSubmissionIdentity();
	identity.observeTerminalSubmission(1);
	assert.equal(identity.beginInput(), 1);

	identity.observeTerminalSubmission(2);
	assert.equal(identity.current(), 1);
	assert.equal(identity.beginInput(), 1);
	assert.equal(identity.take(), 1);

	assert.equal(identity.beginInput(), 2);
});

test("a completed direct input releases identity for a later submission", () => {
	const identity = new NativeInputSubmissionIdentity();
	identity.observeTerminalSubmission(1);
	assert.equal(identity.beginInput(), 1);
	assert.equal(identity.complete(1), true);

	identity.observeTerminalSubmission(2);
	assert.equal(identity.beginInput(), 2);
});

test("terminal commands without participant input do not shift the next input identity", () => {
	const identity = new NativeInputSubmissionIdentity();
	identity.observeTerminalSubmission(1);
	identity.observeTerminalSubmission(2);

	assert.equal(identity.beginInput(), 2);
	assert.equal(identity.complete(2), true);
	assert.equal(identity.complete(2), false);
	assert.equal(identity.current(), undefined);
});
