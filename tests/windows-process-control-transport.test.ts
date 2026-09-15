import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	PiChildProcessRuntime,
	type StartPiChildProcessRuntimeOptions,
} from "../src/process-runtime/pi-child-process-runtime.ts";
import {
	PROCESS_RUNTIME_TEST_MODEL,
	PROCESS_RUNTIME_TEST_PROVIDER,
} from "./fixtures/process-runtime-child-extension.ts";

const windowsOnly = process.platform === "win32" ? test : test.skip;
const CHILD_EXTENSION = fileURLToPath(
	new URL("./fixtures/process-runtime-child-extension.ts", import.meta.url),
);

windowsOnly("Windows process child starts through Control admission and shuts down cleanly", {
	timeout: 30_000,
}, async () => {
	const options = await createRuntimeOptions("graceful");
	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start(options);
		const bootstrapPath = runtime.bootstrapPath;
		const artifactDirectory = dirname(bootstrapPath);
		const systemPromptArtifactPath = runtime.snapshot.systemPrompt?.filePath;
		assert.ok(systemPromptArtifactPath);
		assert.equal(
			await realpath(systemPromptArtifactPath),
			await realpath(join(artifactDirectory, "system-prompt.md")),
		);
		assert.equal(isAbsolute(bootstrapPath), true);
		assert.equal(bootstrapPath.startsWith("\\\\.\\pipe\\"), false);
		assert.equal(runtime.ready.sessionId, options.expectedSessionId);
		assert.notEqual(runtime.pid, process.pid);
		await lstat(systemPromptArtifactPath);

		assert.deepEqual(await runtime.shutdown("Windows named-pipe integration complete"), {
			exitCode: 0,
			signal: 0,
		});
		await assert.rejects(lstat(bootstrapPath), hasCode("ENOENT"));
		await assert.rejects(lstat(systemPromptArtifactPath), hasCode("ENOENT"));
		await assert.rejects(lstat(artifactDirectory), hasCode("ENOENT"));
	} finally {
		await runtime?.dispose();
	}
});

windowsOnly("Windows process child unexpected exit closes Control and removes runtime artifacts", {
	timeout: 30_000,
}, async () => {
	const options = await createRuntimeOptions("unexpected-exit");
	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start(options);
		const bootstrapPath = runtime.bootstrapPath;
		const artifactDirectory = dirname(bootstrapPath);
		const systemPromptArtifactPath = runtime.snapshot.systemPrompt?.filePath;
		assert.ok(systemPromptArtifactPath);
		assert.equal(
			await realpath(systemPromptArtifactPath),
			await realpath(join(artifactDirectory, "system-prompt.md")),
		);
		process.kill(runtime.pid, "SIGTERM");
		const exit = await runtime.exited;
		assert.notEqual(exit.exitCode, 0);
		await assert.rejects(lstat(bootstrapPath), hasCode("ENOENT"));
		await assert.rejects(lstat(systemPromptArtifactPath), hasCode("ENOENT"));
		await assert.rejects(lstat(artifactDirectory), hasCode("ENOENT"));
	} finally {
		await runtime?.dispose();
	}
});

async function createRuntimeOptions(name: string): Promise<StartPiChildProcessRuntimeOptions> {
	const root = await mkdtemp(join(tmpdir(), `pi-windows-control-${name}-`));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const expectedSessionId = name === "graceful"
		? "019a6b4d-1b22-7000-8000-000000000201"
		: "019a6b4d-1b22-7000-8000-000000000202";
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	return {
		workflowId: `windows-control-${name}-workflow`,
		agentId: `windows-control-${name}-agent`,
		role: "ordinary",
		expectedSessionId,
		sessionPath,
		configuration: {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: [],
			skills: [],
			extensions: [CHILD_EXTENSION],
			systemPrompt: { mode: "append", body: `Windows runtime context for ${name}` },
			loadContextFiles: true,
		},
		skillPaths: [],
		projectTrusted: true,
		ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
		runtimeDirectory: root,
		columns: 80,
		rows: 24,
	};
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}
