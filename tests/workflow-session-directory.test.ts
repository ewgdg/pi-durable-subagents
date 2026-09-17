import assert from "node:assert/strict";
import test from "node:test";

import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";

const SESSION_ID = "019fd467-4379-70ec-99d3-7c70387be148";

test("the workflow directory keeps the Owner session id intact", () => {
	assert.equal(
		workflowSessionDirectory("/sessions/project", SESSION_ID),
		`/sessions/project/pi-durable-subagents/${SESSION_ID}`,
	);
});

test("an unsafe workflow id never becomes a path segment", () => {
	const unsafe = [
		"",
		".",
		"..",
		".hidden",
		"trailing.",
		"a/b",
		"../escape",
		"nested/path",
		"has space",
		"tab\tseparated",
		"back\\slash",
		"nul\0byte",
	];
	for (const workflowId of unsafe) {
		assert.throws(
			() => workflowSessionDirectory("/sessions/project", workflowId),
			/Workflow id/,
			`expected ${JSON.stringify(workflowId)} to be rejected`,
		);
	}
});

test("a missing Owner session directory is refused", () => {
	assert.throws(
		() => workflowSessionDirectory("", SESSION_ID),
		/Owner has no durable Pi session directory/,
	);
});
