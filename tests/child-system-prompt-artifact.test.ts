import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	materializeNewChildSystemPromptArtifact,
} from "../src/process-runtime/child-system-prompt-artifact.ts";

test("new child system prompt artifact is immutable and private", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-system-prompt-"));
	const artifactPath = join(directory, "system-prompt.md");
	assert.equal(
		await materializeNewChildSystemPromptArtifact({
			path: artifactPath,
			body: "Child-specific instructions",
		}),
		artifactPath,
	);
	assert.equal(await readFile(artifactPath, "utf8"), "Child-specific instructions");
	assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
	await assert.rejects(
		materializeNewChildSystemPromptArtifact({
			path: artifactPath,
			body: "replacement",
		}),
		{ code: "EEXIST" },
	);

	const relativePath = "relative-system-prompt.md";
	await assert.rejects(
		materializeNewChildSystemPromptArtifact({ path: relativePath, body: "body" }),
		/absolute/,
	);
	await assert.rejects(lstat(relativePath), { code: "ENOENT" });
});
