import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { attachNativeChildDisplay, nativeChildDisplayText } from "./support/native-child-display.ts";

import xtermHeadless from "@xterm/headless";
import { PhysicalTerminalAttachment } from "../src/presentation/physical-terminal-attachment.ts";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";

import { createPiChildProcessProjection } from "../src/process-runtime/pi-child-process-projection.ts";
import {
	PiChildProcessRuntime,
	type PiChildProcessLaunch,
	type StartPiChildProcessRuntimeOptions,
} from "../src/process-runtime/pi-child-process-runtime.ts";
import {
	PROCESS_RUNTIME_TEST_AGENT_DIR,
	PROCESS_RUNTIME_TEST_MODEL,
	PROCESS_RUNTIME_TEST_PROVIDER,
	PROCESS_RUNTIME_TEST_RESPONSE,
} from "./fixtures/process-runtime-child-extension.ts";

const TEST_TIMEOUT_MS = 5_000;
const CHILD_EXTENSION = fileURLToPath(
	new URL("./fixtures/process-runtime-child-extension.ts", import.meta.url),
);

test("launch projects the real startup PTY through runtime admission", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const options = await createLaunchOptions("startup-frame", 500);
	let launch: PiChildProcessLaunch | undefined;
	try {
		launch = await PiChildProcessRuntime.launch(options);
		const projection = createPiChildProcessProjection(launch);
		const readiness = projection.ready();
		await waitForFrame(launch, "pi v");
		const startupFrame = projection.presentation.render(80)
			.map(stripTerminalSequences)
			.join("\n");
		assert.match(startupFrame, /pi v/);
		projection.resize(100, 30);
		assert.deepEqual(
			launch.dimensions(),
			{ columns: 100, rows: 30 },
		);
		await readiness;
		const runtime = await launch.ready();
		assert.equal(runtime.pid, launch.pid);
		// No exclusion filter: the child keeps its own runtime default surface, and
		// startup completion re-merges the ordinary role's coordination tools.
		assert.deepEqual(runtime.snapshot.tools, [
			"read",
			"bash",
			"edit",
			"write",
			"agent_message",
			"agent_wait",
			"agent_spawn",
			"agent_observe",
			"agent_control",
			"ask_user",
			"runtime_sequential_probe",
		]);
		// The probe runs in the child's own session_start handler, which is before the
		// bridge applies the exclusion filter at startup completion. With no exclusions
		// configured, the child-owned startup surface and the completed surface agree.
		assert.deepEqual(
			JSON.parse(await readFile(options.ownerEnvironment!.PROCESS_RUNTIME_INITIAL_TOOLS_PROBE!, "utf8")),
			runtime.snapshot.tools,
		);
		assert.deepEqual(runtime.ready, {
			sessionId: options.expectedSessionId,
			mode: "tui",
			hasUI: true,
		});
		await attachNativeChildDisplay(launch);
		projection.dispatchInput("/runtime-probe STARTUP_INPUT_OK\r");
		const deadline = Date.now() + TEST_TIMEOUT_MS;
		while (!nativeChildDisplayText(launch).includes("INPUT=STARTUP_INPUT_OK")) {
			assert.ok(Date.now() < deadline, "native command did not complete");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.match(nativeChildDisplayText(launch), /PROCESS_RUNTIME_CHILD_WIDGET/);
		assert.match(nativeChildDisplayText(launch), /SIZE=100x30/);
	} finally {
		await launch?.dispose();
	}
});

for (const outcome of ["admitted", "excluded", "cancelled", "exited"] as const) {
	test(`startup dialogs remain usable before startup completion: ${outcome}`, {
		timeout: TEST_TIMEOUT_MS,
		skip: process.platform === "win32",
	}, async () => {
		const options = await createLaunchOptions(`startup-dialog-${outcome}`, 0);
		const launch = await PiChildProcessRuntime.launch({
			...options,
			configuration: {
				...options.configuration,
				// The child activates "read" for itself below; the filter has to remove
				// it at startup completion instead of rejecting the launch.
				excludeTools: outcome === "excluded" ? ["read"] : [],
			},
			ownerEnvironment: {
				...options.ownerEnvironment,
				PROCESS_RUNTIME_STARTUP_DIALOG: "1",
				PROCESS_RUNTIME_INITIAL_TOOLS: JSON.stringify(["read"]),
			},
		});
		let settled = false;
		const readiness = launch.ready();
		void readiness.then(() => { settled = true; }, () => { settled = true; });
		const waitForDisplay = async (expected: string) => {
			const deadline = Date.now() + TEST_TIMEOUT_MS;
			while (!nativeChildDisplayText(launch).includes(expected)) {
				assert.ok(Date.now() < deadline, `startup display missing ${expected}`);
				await new Promise(resolve => setTimeout(resolve, 10));
			}
		};
		try {
			await attachNativeChildDisplay(launch);
			await waitForDisplay("PROCESS_RUNTIME_STARTUP_INPUT");
			assert.equal(settled, false, "startup input must not settle the child surface");
			launch.writeInput("startup answer\r");
			await waitForDisplay("PROCESS_RUNTIME_STARTUP_OVERLAY startup answer");
			assert.equal(settled, false, "startup overlay must not settle the child surface");
			if (outcome === "exited") {
				process.kill(launch.pid, "SIGKILL");
				await assert.rejects(readiness);
			} else if (outcome === "cancelled") {
				const cancellation = new Error("cancel while startup overlay waits");
				const cleanup = launch.cancelInitialization(cancellation);
				assert.ok(cleanup);
				await assert.rejects(readiness, error => error === cancellation);
				await cleanup;
			} else {
				launch.writeInput("\r");
				const runtime = await readiness;
				const expectedTools = outcome === "excluded"
					? [
						"agent_message",
						"agent_wait",
						"agent_spawn",
						"agent_observe",
						"agent_control",
						"ask_user",
					]
					: [
						"read",
						"agent_message",
						"agent_wait",
						"agent_spawn",
						"agent_observe",
						"agent_control",
						"ask_user",
					];
				assert.deepEqual(runtime.snapshot.tools, expectedTools);
				// Startup completion must not hide an already attached presentation.
				launch.writeInput("/runtime-probe POST_STARTUP_INPUT_OK\r");
				await waitForDisplay("INPUT=POST_STARTUP_INPUT_OK");
			}
			if (outcome === "cancelled" || outcome === "exited") {
				assert.equal(launch.disposed, true);
				assert.throws(() => process.kill(launch.pid, 0), hasCode("ESRCH"));
				await assert.rejects(lstat(dirname(launch.bootstrapPath)), hasCode("ENOENT"));
			}
		} finally {
			await launch.dispose();
		}
	});
}

test("cancelling pending launch rejects exact readiness and bounds all startup cleanup", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const options = await createLaunchOptions("startup-cancel", 10_000);
	let launch: PiChildProcessLaunch | undefined;
	try {
		launch = await PiChildProcessRuntime.launch(options);
		const projection = createPiChildProcessProjection(launch);
		const readiness = projection.ready();
		void readiness.catch(() => undefined);
		const attachment = launch.beginPhysicalTerminalAttachment(() => {});
		void attachment.catch(() => undefined);
		const pid = launch.pid;
		const bootstrapPath = launch.bootstrapPath;
		const cancellation = new Error("deterministic pending launch cancellation");

		// Cancellation occurs in the same turn that exposes the launch, before any
		// asynchronous admission continuation can change its pending state.
		const cleanup = projection.cancelInitialization(cancellation);
		assert.ok(cleanup);
		assert.equal(projection.cancelInitialization(new Error("too late")), undefined);
		await assert.rejects(readiness, (error) => error === cancellation);
		await assert.rejects(attachment, /deterministic pending launch cancellation/);
		await cleanup;
		assert.equal(launch.disposed, true);
		assert.throws(() => process.kill(pid, 0), hasCode("ESRCH"));
		await assert.rejects(lstat(bootstrapPath), hasCode("ENOENT"));
		await assert.rejects(lstat(dirname(bootstrapPath)), hasCode("ENOENT"));
		await projection.dispose();
	} finally {
		await launch?.dispose();
	}
});

test("failed startup removes its owned system-prompt artifact and launch directory", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const options = await createLaunchOptions("startup-failure", 10_000);
	const launch = await PiChildProcessRuntime.launch({
		...options,
		startupTimeoutMilliseconds: 10,
	});

	await assert.rejects(launch.ready(), /child_runtime_startup_timeout/);
	await assert.rejects(lstat(dirname(launch.bootstrapPath)), hasCode("ENOENT"));
});

async function createLaunchOptions(
	name: string,
	startupDelayMilliseconds: number,
): Promise<StartPiChildProcessRuntimeOptions> {
	const root = await mkdtemp(join(tmpdir(), `pi-child-launch-${name}-`));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const expectedSessionId = name === "startup-frame"
		? "019a6b4d-1b22-7000-8000-000000000101"
		: name === "startup-cancel"
			? "019a6b4d-1b22-7000-8000-000000000102"
			: "019a6b4d-1b22-7000-8000-000000000103";
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	return {
		workflowId: `process-launch-${name}-workflow`,
		agentId: `process-launch-${name}-agent`,
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
			excludeTools: [],
			excludeSkills: [],
			skills: [],
			extensions: [CHILD_EXTENSION],
			systemPrompt: { mode: "append", body: `Launch context for ${name}` },
			loadContextFiles: true,
		},
		skillPaths: [],
		projectTrusted: true,
		ownerEnvironment: {
			...process.env,
			PI_SKIP_VERSION_CHECK: "1",
			PROCESS_RUNTIME_STARTUP_DELAY_MS: String(startupDelayMilliseconds),
			PROCESS_RUNTIME_INITIAL_TOOLS_PROBE: join(root, "initial-tools.jsonl"),
		},
		runtimeDirectory: root,
		columns: 80,
		rows: 24,
	};
}

function frameText(projection: Pick<PiChildProcessLaunch, "frame">): string {
	return projection.frame().lines.map((line) => line.text).join("\n");
}

async function waitForFrame(
	projection: Pick<PiChildProcessLaunch, "frame" | "drain">,
	expected: string,
): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await projection.drain();
		if (frameText(projection as PiChildProcessLaunch).includes(expected)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for startup frame ${JSON.stringify(expected)}`);
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

test("cancelled startup attachment stays hidden and retained child reattaches with a complete native frame", {
	timeout: TEST_TIMEOUT_MS, skip: process.platform === "win32",
}, async () => {
	const launchOptions = await createLaunchOptions("cancelled-attachment", 500);
	const options = { ...launchOptions, agentId: launchOptions.expectedSessionId };
	await appendFile(options.sessionPath, JSON.stringify({
		type: "custom", id: "identity", parentId: null,
		timestamp: new Date().toISOString(), customType: "agent-coordination.identity",
		data: { agentId: options.agentId, workflowId: options.workflowId,
			directSpawnerAgentId: options.workflowId, creationPreset: null,
			spawnSource: { agentId: options.workflowId, entryId: "spawn", toolCallId: "spawn-child" },
			metadata: { label: "Retained child" } },
	}) + "\n");
	const unexpectedOwnerRequest = async (): Promise<never> => {
		throw new Error("unexpected coordination request in attachment regression");
	};
	const launch = await PiChildProcessRuntime.launch({
		...options,
		ownerRequestHandlers: {
			lifecycle: {
				async executionStarted() { return []; },
				async humanInputSubmitted() { return "continue"; },
				async primaryInputQueued() {},
				async humanInputMode() { return "agent"; },
				async toolResultCommitting() { return undefined; },
				async toolExecutionStarted() {},
				async safeBoundaryReached() {},
				async executionEnded() {},
			},
			presentation: {
				setReportRead: unexpectedOwnerRequest,
				async snapshot() { return {
					live: [{
						agentId: options.agentId, workflowId: options.workflowId,
						label: "Retained child", directSpawnerAgentId: null,
						primaryEvidence: { transcriptPath: options.sessionPath,
							inspectedThrough: { agentId: options.agentId, entryId: "startup" } },
						run: { phase: "live", work: "settled", attention: "none",
							retentionReasons: [{ reason: "interactive_selection", count: 1 }] },
						model: { provider: PROCESS_RUNTIME_TEST_PROVIDER, modelId: PROCESS_RUNTIME_TEST_MODEL },
						thinking: "off", compacting: false, queuedInputCount: 0,
					}], dormant: [], selectedAgentId: options.agentId,
					humanAttention: [], operationalAttention: [], reports: [],
				}; },
				select: unexpectedOwnerRequest,
			},
			coordination: {
				async agentTemplateSnapshot() { return { templates: [] }; },
				observe: unexpectedOwnerRequest, message: unexpectedOwnerRequest,
				wait: unexpectedOwnerRequest, control: unexpectedOwnerRequest,
				spawn: unexpectedOwnerRequest, askUser: unexpectedOwnerRequest,
			},
		},
		ownerEnvironment: {
			...options.ownerEnvironment,
			PROCESS_RUNTIME_VISIBILITY_PROBE: join(dirname(options.sessionPath), "visibility-events"),
		},
	});
	const projection = createPiChildProcessProjection(launch);
	const display = new xtermHeadless.Terminal({ cols: 80, rows: 60, allowProposedApi: true });
	display.onData(data => launch.writeInput(data));
	let ownerRestored = false;
	const makeAttachment = () => new PhysicalTerminalAttachment({
		ownerTui: {
			stop() {}, start() { ownerRestored = true; }, requestRender() {},
		} as unknown as TUI,
		physicalTerminal: {
			supportsPhysicalAttachment: true,
			columns: () => 80, rows: () => 60, write(data) { display.write(data); return true; },
			waitForDrain: async () => {}, start() {}, stop() {},
		},
		fail(error) { throw error; }, requestExit() {},
	});
	const cancelled = makeAttachment();
	const retained = makeAttachment();
	try {
		const selecting = cancelled.attach(projection);
		await new Promise<void>(resolve => setImmediate(resolve));
		const closing = cancelled.close();
		await Promise.all([selecting, closing]);
		const runtime = await launch.ready();
		// Owner was never suspended for an unprepared child.
		assert.equal(ownerRestored, false);
		const settled = new Promise<void>(resolve => {
			const removeHandler = runtime.onEvent(event => {
				if (event.event === "agent.settled") { removeHandler(); resolve(); }
			});
		});
		await runtime.channel.request("message.deliver", { deliveryId: "retained-work", delivery: { kind: "user", content: "CANCELLED_RETAINED_WORK" } });
		await settled;
		assert.doesNotMatch(
			await readFile(join(dirname(options.sessionPath), "visibility-events"), "utf8"),
			/^render$/m,
			"cancelled attachment must keep completed work hidden until reattachment",
		);
		await retained.attach(projection);
		const screen = () => Array.from({ length: display.rows }, (_, row) =>
			display.buffer.active.getLine(display.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
		const deadline = Date.now() + TEST_TIMEOUT_MS;
		while (!screen().includes("VISIBILITY_EDITOR_1")) {
			assert.ok(Date.now() < deadline, "reattachment must publish a complete frame");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.doesNotMatch(screen(), /error:|invariant_violation/);
		assert.match(screen(), /VISIBILITY_WIDGET_1/);
		assert.match(await readFile(options.sessionPath, "utf8"), new RegExp(PROCESS_RUNTIME_TEST_RESPONSE));
		projection.dispatchInput("\x15/runtime-probe RETAINED_INPUT_OK\r");
		while (!screen().includes("INPUT=RETAINED_INPUT_OK")) {
			assert.ok(Date.now() < deadline, "retained child must accept native input");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.match(screen(), /SIZE=80x60/);
	} finally {
		await cancelled.close();
		await retained.close();
		display.dispose();
		await launch.dispose();
	}
});
