import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
	validateHumanAnswer,
	validateHumanRequestInput,
} from "../src/protocol/human-request.ts";

test("Human Request accepts exactly one nonblank free-form question", () => {
	assert.deepEqual(
		validateHumanRequestInput({ question: "Which boundary should remain authoritative?" }),
		{ question: "Which boundary should remain authoritative?" },
	);
	for (const malformed of [
		{},
		{ question: "" },
		{ question: "   \n\t" },
		{ question: "Valid", extra: true },
		{ prompt: "Wrong field" },
	]) {
		assert.throws(
			() => validateHumanRequestInput(malformed),
			/invalid_input/,
		);
	}
});

test("Human Answer accepts exactly one nonblank free-form answer", () => {
	assert.deepEqual(
		validateHumanAnswer("human-request", {
			requestId: "human-request",
			answer: "Keep native Pi.",
		}),
		{ requestId: "human-request", answer: "Keep native Pi." },
	);
	for (const malformed of [
		{ requestId: "human-request", answer: "" },
		{ requestId: "human-request", answer: " \n" },
		{ requestId: "other-request", answer: "Keep native Pi." },
		{ requestId: "human-request", answers: [] },
	]) {
		assert.throws(
			() => validateHumanAnswer("human-request", malformed),
			/invalid_(?:input|correlation)/,
		);
	}
});
