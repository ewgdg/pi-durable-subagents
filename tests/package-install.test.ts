import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("a Git checkout is install-ready without development dependencies", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	) as {
		pi?: { extensions?: string[] };
		scripts?: Record<string, string>;
	};

	assert.equal(
		manifest.scripts?.prepare,
		undefined,
		"Pi installs Git packages with devDependencies omitted, so install lifecycle scripts cannot require development tools",
	);

	const extensionEntries = manifest.pi?.extensions ?? [];
	assert.notEqual(extensionEntries.length, 0);
	for (const extensionEntry of extensionEntries) {
		await access(new URL(`../${extensionEntry}`, import.meta.url));
		const trackedEntry = extensionEntry.replace(/^\.\//, "");
		assert.equal(
			execFileSync("git", ["ls-files", "--error-unmatch", trackedEntry], {
				cwd: PACKAGE_ROOT,
				encoding: "utf8",
			}).trim(),
			trackedEntry,
			`Pi extension entry must be committed: ${extensionEntry}`,
		);
	}
});
