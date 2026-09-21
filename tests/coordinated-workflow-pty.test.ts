import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import xtermHeadless from "@xterm/headless";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type Context,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { PI_CLI_READY_EVIDENCE_ENV } from "./fixtures/pi-cli-startup-ready-extension.ts";
import { createProcessModelBroker } from "./support/process-model-broker.ts";

// These tests launch an *Owner* Pi CLI. A Pi-hosted test runner (one whose own
// process is a coordination child) carries the child-only bootstrap variables,
// and launchPiCli spreads process.env into the spawned CLI. The startup-ready
// fixture deliberately ignores inherited child startup, so a leaked bootstrap
// path would stall every real-CLI test here. `tests/support/pi-host.ts` clears
// the same names for its own file; this file does not import it.
delete process.env.PI_DURABLE_SUBAGENTS_BOOTSTRAP;
delete process.env.PI_DURABLE_SUBAGENTS_SYSTEM_PROMPT_MODE;
delete process.env.PI_DURABLE_SUBAGENTS_SYSTEM_PROMPT_PATH;
delete process.env.PI_DURABLE_SUBAGENTS_LOAD_CONTEXT_FILES;

const SCRIPT = "/usr/bin/script";
const PTY_WAIT_TIMEOUT_MS = 20_000;
const SCREEN_POLL_INTERVAL_MS = 10;
const PI_CLI_READY_EVIDENCE_FILE = "pi-cli-startup-ready";
const FIXTURE = fileURLToPath(
	new URL("./fixtures/coordinated-workflow-pty-fixture.ts", import.meta.url),
);
const FAILURE_FIXTURE = fileURLToPath(
	new URL("./fixtures/agent-view-failure-pty-fixture.ts", import.meta.url),
);
const DIRECT_AGENT_INPUT = "direct input through child editor";
const PI_CLI = fileURLToPath(
	new URL(
		"../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		import.meta.url,
	),
);
const COORDINATION_EXTENSION = fileURLToPath(
	new URL("../src/index.ts", import.meta.url),
);
const PI_CLI_READY_EXTENSION = fileURLToPath(
	new URL("./fixtures/pi-cli-startup-ready-extension.ts", import.meta.url),
);

test("real fullscreen PTY /agents view mouse-scrolls and returns to the exact Owner", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture();
	try {
		const setup = await terminal.marker<{
			ownerId: string;
			childAgentId: string;
			cwd: string;
			ownerEditorText: string;
		}>("__PTY_AGENT_VIEW_SETUP__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Viewed Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		await terminal.waitForScreen((frame) => frame.some((line) =>
			line.includes("→") && line.includes("PTY Viewed Worker")
		));
		terminal.write("\r");
		const agentViewFrame = await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 59")) &&
			frame.some((line) =>
				line.includes("PTY Viewed Worker") &&
				line.includes(setup.childAgentId.slice(-8)) &&
				line.includes("waiting (agent answer)")
			) &&
			frame.some((line) => line.includes("PTY Nested Worker")) &&
			frame.some((line) => line.includes("deterministic-owner")) &&
			!frame.some((line) => line.includes("Tab views"))
		);
		assert.equal(agentViewFrame.length, 24);
		assert.equal(
			agentViewFrame.some((line) => line.includes(setup.ownerEditorText)),
			false,
		);
		const identityRow = agentViewFrame.findIndex((line) =>
			line.includes("PTY Viewed Worker") && line.includes("waiting (agent answer)")
		);
		const agentsHeadingRow = agentViewFrame.findIndex((line) => line.trim() === "Agents");
		const nestedActivityRow = agentViewFrame.findIndex((line) =>
			line.includes("PTY Nested Worker")
		);
		assert.ok(identityRow >= 0);
		assert.equal(
			agentViewFrame.filter((line) =>
				line.includes("PTY Viewed Worker") && line.includes("waiting (agent answer)")
			).length,
			1,
		);
		assert.ok(agentsHeadingRow > identityRow);
		assert.ok(nestedActivityRow > agentsHeadingRow);
		for (let notch = 0; notch < 25; notch += 1) {
			terminal.write("\x1b[<64;10;8M");
		}
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 3")) &&
			!frame.some((line) => line.includes("Viewed child transcript line 59"))
		);
		terminal.write("\x1b[F");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 59"))
		);
		terminal.write(DIRECT_AGENT_INPUT);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes(DIRECT_AGENT_INPUT))
		);
		terminal.write("\r");
		await terminal.waitForScreen(
			(frame) => frame.some((line) => /Streaming child update \d+/.test(line)),
			"first streamed child frame",
		);
		await terminal.waitFor("__PTY_CHILD_INPUT_SETTLED__");
		for (let notch = 0; notch < 80; notch += 1) {
			terminal.write("\x1b[<64;10;8M");
		}
		const inspectedSettledFrame = await terminal.waitForScreen(
			(frame) =>
				frame.some((line) => line.includes("Viewed child transcript line")) &&
				!frame.some((line) => line.includes("Streaming child update 39")),
			"mouse wheel transcript movement",
		);
		assert.ok(
			inspectedSettledFrame.some((line) => line.includes("Viewed child transcript line")),
			JSON.stringify(inspectedSettledFrame),
		);
		assert.equal(
			inspectedSettledFrame.some((line) => line.includes("Streaming child update 39")),
			false,
		);
		terminal.write("\x1b[F");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Streaming child update 39"))
		);
		terminal.write("/agents");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("/agents"))
		);
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("o");
		await terminal.waitFor("__PTY_AGENT_VIEW_CLOSED__");
		const ownerFrame = await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner baseline response remains mounted")) &&
			frame.some((line) => line.includes(setup.ownerEditorText)) &&
			frame.some((line) => line.includes(setup.cwd)) &&
			frame.some((line) => line.includes("/128k") && line.includes("deterministic-owner")) &&
			!frame.some((line) => line.includes("Viewed child transcript line")) &&
			!frame.some((line) => line.includes("Tab views"))
		);
		assert.equal(ownerFrame.length, 24);
		await terminal.closed();
		assert.match(terminal.output(), /__PTY_AGENT_VIEW_CLOSED__/);
	} finally {
		terminal.kill();
	}
});

for (const failureKind of ["input", "render"] as const) {
	test(`real fullscreen PTY returns to Owner after child ${failureKind} failure`, {
		skip: !existsSync(SCRIPT),
	}, async () => {
		const terminal = launchFixture(FAILURE_FIXTURE, {
			PTY_AGENT_VIEW_FAILURE: failureKind,
		});
		try {
			const setup = await terminal.marker<{
				childAgentId: string;
				ownerEditorText: string;
			}>("__PTY_AGENT_VIEW_FAILURE_SETUP__");
			await terminal.waitForScreen((frame) =>
				frame.some((line) => line.includes("PTY Failure Worker")) &&
				frame.some((line) => line.includes("Tab views"))
			);
			await terminal.waitForScreen((frame) => frame.some(
				(line) => line.includes("→") && line.includes("PTY Failure Worker"),
			));
			terminal.write("\r");
			await terminal.waitForScreen((frame) =>
				frame.some((line) => line.includes("Failure PTY child is ready."))
			);
			terminal.write("x");
			await terminal.waitFor(`__PTY_AGENT_VIEW_FAILURE_RESTORED__${failureKind}`);
			const ownerFrame = await terminal.waitForScreen((frame) =>
				frame.some((line) => line.includes("Owner failure baseline remains mounted")) &&
				frame.some((line) => line.includes(setup.ownerEditorText))
			);
			assert.equal(ownerFrame.length, 24);
			await terminal.closed();
		} finally {
			terminal.kill();
		}
	});
}

test("real fullscreen PTY closes a failed Agent runtime initialization and restores Owner", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture(FAILURE_FIXTURE, {
		PTY_AGENT_VIEW_FAILURE: "initialization",
	});
	try {
		const setup = await terminal.marker<{
			ownerEditorText: string;
			initializationReleasePath: string;
		}>(
			"__PTY_AGENT_VIEW_FAILURE_SETUP__",
		);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Failure Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		await terminal.waitForScreen((frame) => frame.some(
			(line) => line.includes("→") && line.includes("PTY Failure Worker"),
		));
		terminal.write("\r");
		await writeFile(setup.initializationReleasePath, "release\n");
		await terminal.waitFor("__PTY_AGENT_VIEW_FAILURE_RESTORED__initialization");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner failure baseline remains mounted")) &&
			frame.some((line) => line.includes(setup.ownerEditorText))
		);
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

test("real fullscreen PTY keeps a terminally failed selected Run in its Agent view", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture(FAILURE_FIXTURE, {
		PTY_AGENT_VIEW_FAILURE: "run",
	});
	try {
		const setup = await terminal.marker<{
			childAgentId: string;
			ownerEditorText: string;
		}>("__PTY_AGENT_VIEW_FAILURE_SETUP__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Failure Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		await terminal.waitForScreen((frame) => frame.some(
			(line) => line.includes("→") && line.includes("PTY Failure Worker"),
		));
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Failure PTY child is ready."))
		);
		terminal.write("trigger selected Run failure");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("trigger selected Run failure"))
		);
		terminal.write("\r");
		await terminal.waitFor("__PTY_SELECTED_RUN_FAILED__");
		await openDormantAgentSelector(terminal, "PTY Failure Worker");
		terminal.write("o");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner failure baseline remains mounted."))
		);
		terminal.write("Owner input confirms selected Run closure");
		await terminal.waitFor("__PTY_AGENT_VIEW_FAILURE_RESTORED__run");
		await terminal.closed();
		assert.match(terminal.output(), /Owner failure baseline remains mounted/);
		assert.match(terminal.output(), new RegExp(setup.ownerEditorText));
	} finally {
		terminal.kill();
	}
});

test("real fullscreen PTY disposes an unviewed child mode exactly once", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture(FAILURE_FIXTURE, {
		PTY_AGENT_VIEW_FAILURE: "noninteractive",
	});
	try {
		await terminal.waitFor("__PTY_NONINTERACTIVE_DISPOSAL_COMPLETE__");
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

test("real fullscreen PTY command returns as soon as physical child attachment is ready", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const returnedDirectory = await mkdtemp(join(tmpdir(), "pi-agent-view-returned-"));
	const returnedPath = join(returnedDirectory, "returned");
	const releasePath = join(returnedDirectory, "release");
	const terminal = launchFixture(FIXTURE, {
		PTY_FIRST_VIEW_COMMAND_RETURNED_PATH: returnedPath,
		PTY_FIRST_VIEW_COMMAND_RELEASE_PATH: releasePath,
	});
	try {
		await terminal.marker("__PTY_AGENT_VIEW_SETUP__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Viewed Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 59")) &&
			!frame.some((line) => line.includes("Tab views"))
		);
		await waitForFile(returnedPath);

		terminal.write(DIRECT_AGENT_INPUT);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes(DIRECT_AGENT_INPUT))
		);
		terminal.write("\r");
		await terminal.waitFor("__PTY_CHILD_INPUT_SETTLED__");
		await returnPtyAgentViewToOwner(terminal);
		await writeFile(releasePath, "release\n");
		await terminal.closed();
		assert.match(terminal.output(), /__PTY_AGENT_VIEW_CLOSED__/);
	} finally {
		terminal.kill();
		await import("node:fs/promises").then(({ rm }) =>
			rm(returnedDirectory, { recursive: true, force: true })
		);
	}
});

test("real fullscreen PTY can return to Owner and attach the same Agent again", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const repeatDirectory = await mkdtemp(join(tmpdir(), "pi-agent-view-repeat-"));
	const readyPath = join(repeatDirectory, "ready");
	const releasePath = join(repeatDirectory, "release");
	const terminal = launchFixture(FIXTURE, {
		PTY_REPEAT_VIEW_READY_PATH: readyPath,
		PTY_REPEAT_VIEW_RELEASE_PATH: releasePath,
	});
	try {
		await terminal.marker("__PTY_AGENT_VIEW_SETUP__");
		terminal.write("/agents\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Viewed Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 59")) &&
			!frame.some((line) => line.includes("Tab views"))
		);
		terminal.write(DIRECT_AGENT_INPUT);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes(DIRECT_AGENT_INPUT))
		);
		terminal.write("\r");
		await terminal.waitFor("__PTY_CHILD_INPUT_SETTLED__");
		await returnPtyAgentViewToOwner(terminal);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner baseline response remains mounted")) &&
			!frame.some((line) => line.includes("Tab views"))
		);
		await waitForFile(readyPath);
		terminal.write("/agents\r");
		await terminal.waitForScreen((frame) => frame.some((line) => line.includes("Tab views")));
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Streaming child update 39")) &&
			!frame.some((line) => line.includes("Tab views"))
		);
		terminal.write("second attachment remains interactive\r");
		await terminal.waitFor("Second attachment accepted direct input.");
		terminal.write("/agents");
		await terminal.waitForScreen((frame) => frame.some((line) => line.includes("/agents")));
		terminal.write("\r");
		await terminal.waitForScreen((frame) => frame.some((line) => line.includes("Tab views")));
		terminal.write("o");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner baseline response remains mounted")) &&
			!frame.some((line) => line.includes("Tab views"))
		);
		await writeFile(releasePath, "release\n");
		await terminal.waitFor("__PTY_AGENT_VIEW_CLOSED__");
		await terminal.closed();
	} finally {
		terminal.kill();
		await import("node:fs/promises").then(({ rm }) =>
			rm(repeatDirectory, { recursive: true, force: true })
		);
	}
});

test("real fullscreen PTY switches one mounted view between two Agent modes", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture();
	try {
		const setup = await terminal.marker<{
			childAgentId: string;
			secondChildAgentId: string;
			ownerEditorText: string;
		}>("__PTY_AGENT_VIEW_SETUP__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Viewed Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		await terminal.waitForScreen((frame) => frame.some((line) =>
			line.includes("→") && line.includes("PTY Viewed Worker")
		));
		terminal.write("\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 59")) &&
			!frame.some((line) => line.includes("Tab views"))
		);
		terminal.write(DIRECT_AGENT_INPUT);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes(DIRECT_AGENT_INPUT))
		);
		terminal.write("\r");
		await terminal.waitFor("__PTY_CHILD_INPUT_SETTLED__");

		terminal.write("/agents");
		await terminal.waitForScreen(
			(frame) => frame.some((line) => line.includes("/agents")),
			"child /agents command input",
		);
		terminal.write("\r");
		await terminal.waitForScreen(
			(frame) => frame.some((line) => line.includes("Tab views")),
			"child-local selector",
		);
		terminal.write("j");
		await terminal.waitForScreen((frame) => frame.some((line) =>
			line.includes("→") && line.includes("PTY Second Worker")
		), "second child selector focus");
		terminal.write("\r");
		const leafFrame = await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("Second PTY child remains independently interactive")
			) && !frame.some((line) => line.includes("Tab views"))
		);
		assert.equal(leafFrame.some((line) =>
			line.includes("PTY Second Worker") &&
			line.includes(setup.secondChildAgentId.slice(-8)) &&
			line.includes("idle")
		), true);
		assert.equal(leafFrame.some((line) => line.trim() === "Agents"), false);

		terminal.write("/agents");
		await terminal.waitForScreen(
			(frame) => frame.some((line) => line.includes("/agents")),
			"second child /agents command input",
		);
		terminal.write("\r");
		await terminal.waitForScreen(
			(frame) => frame.some((line) => line.includes("Tab views")),
			"second child-local selector",
		);
		terminal.write("o");
		await terminal.waitFor("__PTY_AGENT_VIEW_CLOSED__");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner baseline response remains mounted")) &&
			frame.some((line) => line.includes(setup.ownerEditorText)) &&
			!frame.some((line) => line.includes("Second PTY child remains independently interactive"))
		);
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

test("real fullscreen PTY reflows the complete Agent view at 100x30", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const terminal = launchFixture(FIXTURE, {
		PTY_TEST_COLUMNS: "100",
		PTY_TEST_ROWS: "30",
	});
	try {
		const setup = await terminal.marker<{
			childAgentId: string;
			ownerEditorText: string;
			terminalColumns: number;
			terminalRows: number;
		}>("__PTY_AGENT_VIEW_SETUP__");
		assert.deepEqual(
			{ columns: setup.terminalColumns, rows: setup.terminalRows },
			{ columns: 100, rows: 30 },
		);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("PTY Viewed Worker")) &&
			frame.some((line) => line.includes("Tab views"))
		);
		await terminal.waitForScreen((frame) => frame.some((line) =>
			line.includes("→") && line.includes("PTY Viewed Worker")
		));
		terminal.write("\r");
		const agentFrame = await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Viewed child transcript line 59")) &&
			!frame.some((line) => line.includes("Tab views"))
		);
		assert.equal(agentFrame.length, 30);
		terminal.write(DIRECT_AGENT_INPUT);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes(DIRECT_AGENT_INPUT))
		);
		terminal.write("\r");
		await terminal.waitFor("__PTY_CHILD_INPUT_SETTLED__");
		terminal.write("/agents");
		await terminal.waitForScreen(
			(frame) => frame.some((line) => line.includes("/agents")),
			"resized child /agents command input",
		);
		terminal.write("\r");
		await terminal.waitForScreen(
			(frame) => frame.some((line) => line.includes("Tab views")),
			"resized child-local selector",
		);
		terminal.write("o");
		await terminal.waitFor("__PTY_AGENT_VIEW_CLOSED__");
		const ownerFrame = await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Owner baseline response remains mounted")) &&
			frame.some((line) => line.includes(setup.ownerEditorText))
		);
		assert.equal(ownerFrame.length, 30);
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

test("real Pi CLI can return to Owner and attach the same Agent again", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-cli-repeat-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const broker = await createProcessModelBroker({
		responseOverride: routeCliRepeatResponse,
		tokensPerSecond: 20_000,
	});
	const terminal = launchPiCli({
		agentDir,
		sessionDir,
		additionalExtensionPaths: [broker.extensionPath],
		provider: broker.providerId,
		model: broker.modelId,
	});
	try {
		await waitForPiCliReady(agentDir);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("deterministic-owner"))
		);
		terminal.write("Create one Agent with agent_spawn. Use label CLI Repeat Worker and request: Remain available for repeated CLI Agent view attachment.\r");
		await terminal.waitForScreen((frame) =>
			normalizedFrameText(frame).includes(
				"CLI worker is ready for repeated attachment.",
			)
		);

		await attachCliRepeatWorker(terminal, "CLI child first attachment input", false);
		await returnPtyAgentViewToOwner(terminal);
		await terminal.waitForScreen((frame) =>
			!frame.some((line) => line.includes("Tab views")) &&
			frame.some((line) => line.includes("deterministic-owner"))
		);
		await attachCliRepeatWorker(terminal, "CLI child second attachment input", true);
		await returnPtyAgentViewToOwner(terminal);
		await terminal.waitForScreen((frame) =>
			!frame.some((line) => line.includes("Tab views")) &&
			frame.some((line) => line.includes("deterministic-owner"))
		);
		terminal.write("/quit\r");
		await terminal.closed();
	} finally {
		terminal.kill();
		await broker.close();
		await import("node:fs/promises").then(({ rm }) =>
			rm(root, { recursive: true, force: true })
		);
	}
});

test("native quit in the selected child closes the real Pi Workflow", {
	skip: !existsSync(SCRIPT),
	timeout: PTY_WAIT_TIMEOUT_MS,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-selected-quit-"));
	const agentDir = join(root, "agent");
	const broker = await createProcessModelBroker({
		responseOverride: routeCliRepeatResponse,
		tokensPerSecond: 20_000,
	});
	const terminal = launchPiCli({
		agentDir,
		sessionDir: join(root, "sessions"),
		additionalExtensionPaths: [broker.extensionPath],
		provider: broker.providerId,
		model: broker.modelId,
	});
	try {
		await waitForPiCliReady(agentDir);
		terminal.write("Create one CLI Repeat Worker.\r");
		await terminal.waitForScreen((frame) =>
			normalizedFrameText(frame).includes("CLI worker is ready for repeated attachment.")
		);
		await attachCliRepeatWorker(terminal, "CLI child before quit", false);
		terminal.write("/quit\r");
		await terminal.closed();
	} finally {
		terminal.kill();
		await broker.close();
	}
});

test("interactive /reload keeps a selected process child alive after inherited extension changes", {
	skip: !existsSync(SCRIPT),
	timeout: 2 * PTY_WAIT_TIMEOUT_MS,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-child-reload-"));
	let broker: Awaited<ReturnType<typeof createProcessModelBroker>> | undefined;
	let terminal: PtyFixture | undefined;
	try {
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		broker = await createProcessModelBroker({
			responseOverride: routeCliRepeatResponse,
			tokensPerSecond: 20_000,
		});
		const inputPreflightExtension = join(root, "child-input-preflight.mjs");
		const childLifecycleEvidence = join(root, "child-lifecycle.jsonl");
		await writeFile(inputPreflightExtension, [
			"import { appendFileSync } from 'node:fs';",
			`const evidencePath = ${JSON.stringify(childLifecycleEvidence)};`,
			"const isChild = process.env.PI_DURABLE_SUBAGENTS_BOOTSTRAP !== undefined;",
			"const record = (event) => appendFileSync(evidencePath, `${JSON.stringify({ ...event, pid: process.pid })}\\n`);",
			"export default function childInputPreflight(pi) {",
			"  if (isChild) {",
			"    pi.on('session_start', (event) => record({ kind: 'session_start', reason: event.reason }));",
			"    pi.on('session_shutdown', (event) => record({ kind: 'session_shutdown', reason: event.reason }));",
			"  }",
			"  pi.on('input', (event) => {",
			"    if (event.text === 'CLI child before reload') {",
			"      return { action: 'transform', text: 'CLI child transformed before reload' };",
			"    }",
			"    if (event.text === 'CLI child after reload') {",
			"      return { action: 'transform', text: 'CLI child transformed after reload' };",
			"    }",
			"  });",
			"}",
		].join("\n"));
		const activeBroker = broker;
		terminal = launchPiCli({
			agentDir,
			sessionDir,
			additionalExtensionPaths: [activeBroker.extensionPath, inputPreflightExtension],
			provider: activeBroker.providerId,
			model: activeBroker.modelId,
		});
		await waitForPiCliReady(agentDir);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("deterministic-owner"))
		);
		terminal.write("Create one Agent with agent_spawn. Use label CLI Repeat Worker and request: Remain available for repeated CLI Agent view attachment.\r");
		await terminal.waitForScreen((frame) =>
			normalizedFrameText(frame).includes(
				"CLI worker is ready for repeated attachment.",
			)
		);
		await attachCliRepeatWorker(
			terminal,
			"CLI child before reload",
			false,
			"CLI child transformed before reload",
		);

		terminal.write("\x15");
		await appendFile(activeBroker.extensionPath, "\n// Selected-child reload regression generation.\n");
		terminal.write("/reload\r");
		await terminal.waitFor("Reloaded keybindings, extensions, skills, prompts, themes, and context files");
		const reloadedChild = await waitForChildLifecycleEvidence(
			childLifecycleEvidence,
			(entries) => entries.find((entry) =>
				entry.kind === "session_start" && entry.reason === "reload"
			),
		);
		terminal.write("CLI child after reload\r");
		const postReloadInput = await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				line.includes("acknowledged: CLI child transformed after reload") ||
				line.includes("acknowledged: CLI child after reload") ||
				line.includes("Agent input failed") ||
				line.includes("Human Answer was not submitted")
			)
		);
		// Return as soon as the child response is visible. The retained projection
		// must already be input-idle after its post-reload submit.
		const returningToOwner = returnPtyAgentViewToOwner(terminal);
		assert.equal(
			postReloadInput.some((line) =>
				line.includes("acknowledged: CLI child transformed after reload")
			),
			true,
		);
		await returningToOwner;
		await terminal.waitForScreen((frame) =>
			!frame.some((line) => line.includes("Tab views")) &&
			frame.some((line) => line.includes("deterministic-owner"))
		);
		await waitForChildLifecycleEvidence(
			childLifecycleEvidence,
			(entries) => entries.find((entry) =>
				entry.kind === "session_shutdown" && entry.reason === "quit" &&
				entry.pid === reloadedChild.pid
			),
		);
		await waitForProcessExit(reloadedChild.pid);
		terminal.write("/quit\r");
		await terminal.closed();
	} finally {
		terminal?.kill();
		try {
			await broker?.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("interactive /resume retains the compact historical agent_spawn renderer", {
	skip: !existsSync(SCRIPT),
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-durable-subagents-resume-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const target = SessionManager.create(process.cwd(), sessionDir);
	const toolCallId = "resumed-agent-spawn";
	const expandedMarker = "EXPANDED_ONLY_RESUMED_AGENT_SPAWN";
	const input = {
		title: "Fixture request",
		request: "Verify historical Agent Spawn rendering after interactive resume.",
		label: "Resumed Spawn Widget",
	};
	const receipt = {
		spawnStatus: "created" as const,
		agentId: "resumed-spawn-agent",
		requestMessageId: "resumed-spawn-request",
		messageStatus: "sent" as const,
		effectiveConfiguration: {
			cwd: process.cwd(),
			model: { provider: "openai", modelId: "gpt-4o-mini" },
			thinking: "off" as const,
			tools: ["read", "agent_message"],
			skills: [],
			extensions: [],
			systemPrompt: { mode: "append" as const, body: expandedMarker },
			loadContextFiles: true,
		},
	};
	target.appendSessionInfo("Resumed Spawn Widget Session");
	target.appendMessage({
		...fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		provider: "openai",
		model: "gpt-4o-mini",
	});
	target.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_spawn",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});

	const terminal = launchPiCli({ agentDir, sessionDir });
	try {
		await waitForPiCliReady(agentDir);
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("pi-durable-subagents")) &&
			frame.some((line) => line.includes("gpt-4o-mini"))
		);
		terminal.write("/resume\r");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Resumed Spawn Widget Session"))
		);
		for (const character of "Resumed Spawn Widget Session") {
			terminal.write(character);
		}
		terminal.write("\r");

		const collapsed = await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("spawn Resumed Spawn Widget")) &&
			frame.some((line) => line.includes("created") && line.includes("sent")) &&
			!frame.some((line) => line.includes(expandedMarker))
		);
		assert.equal(collapsed.some((line) => line.includes(expandedMarker)), false);

		terminal.write("\x0f");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes(expandedMarker))
		);
		terminal.write("\x0f");
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("spawn Resumed Spawn Widget")) &&
			!frame.some((line) => line.includes(expandedMarker))
		);

		terminal.write("/quit\r");
		await terminal.closed();
	} finally {
		terminal.kill();
	}
});

async function attachCliRepeatWorker(
	terminal: PtyFixture,
	input: string,
	expectDormantStartupSpinner: boolean,
	expectedInput = input,
): Promise<void> {
	const deadline = Date.now() + PTY_WAIT_TIMEOUT_MS;
	let selector: readonly string[] | undefined;
	while (Date.now() < deadline) {
		terminal.write("/agents\r");
		selector = await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Tab views"))
		);
		if (
			!expectDormantStartupSpinner &&
			selector.some(isCliRepeatWorkerRow)
		) break;
		terminal.write("\t");
		// The selector renders a Live/Dormant/Reports tab strip over one pinned
		// roster; the separate "Dormant Agents" heading was removed. The active tab
		// is only distinguishable by its background colour, which a colour-stripped
		// frame cannot show, so wait for the roster row the Dormant tab must list.
		await terminal.waitForScreen((frame) =>
			frame.some((line) => line.includes("Tab views")) && frame.some(isCliRepeatWorkerRow)
		);
		selector = await terminal.screen();
		if (selector.some(isCliRepeatWorkerRow)) break;
		terminal.write("\x1b");
		await terminal.waitForScreen((frame) =>
			!frame.some((line) => line.includes("Tab views"))
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	if (!selector?.some(isCliRepeatWorkerRow)) {
		throw new Error("CLI Repeat Worker did not become selectable");
	}
	for (let step = 0; step < 3; step += 1) {
		const selector = await terminal.screen();
		if (selector.some((line) => line.includes("→ CLI Repeat Worker"))) break;
		terminal.write("j");
		await new Promise<void>((resolve) => setTimeout(resolve, SCREEN_POLL_INTERVAL_MS));
	}
	await terminal.waitForScreen((frame) =>
		frame.some((line) => line.includes("→ CLI Repeat Worker"))
	);
	terminal.write("\r");
	if (expectDormantStartupSpinner) {
		await terminal.waitForScreen((frame) =>
			frame.some((line) =>
				/→ CLI Repeat Worker\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] loading/.test(line)
			) && frame.some((line) => line.includes("Tab views"))
		);
	}
	await terminal.waitForScreen((frame) =>
		frame.some((line) => line.includes("CLI worker is ready for repeated attachment.")) &&
		!frame.some((line) => line.includes("Tab views"))
	);
	terminal.write(`${input}\r`);
	await terminal.waitForScreen((frame) =>
		frame.some((line) => line.includes(`acknowledged: ${expectedInput}`))
	);
}

function normalizedFrameText(frame: readonly string[]): string {
	return frame.join(" ").replace(/\s+/g, " ");
}

function isCliRepeatWorkerRow(line: string): boolean {
	return line.includes("→ CLI Repeat Worker");
}

function routeCliRepeatResponse(context: Context): AssistantMessage {
	const transcript = JSON.stringify(context.messages);
	const latestUserText = [...context.messages].reverse().find(
		(message) => message.role === "user",
	);
	const text = latestUserText?.role === "user"
		? typeof latestUserText.content === "string"
			? latestUserText.content
			: latestUserText.content.find((content) => content.type === "text")?.text
		: undefined;
	if (text?.startsWith("CLI child ")) {
		return fauxAssistantMessage(`acknowledged: ${text}`);
	}
	if (transcript.includes('"toolCallId":"cli-repeat-answer"')) {
		return fauxAssistantMessage("CLI worker is ready for repeated attachment.");
	}
	if (transcript.includes('"toolCallId":"cli-repeat-spawn"')) {
		return fauxAssistantMessage("CLI worker completed its Creation Request.");
	}
	const requestId = findCreationRequestId(context.messages);
	if (requestId) {
		return fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
				answer: "CLI worker is ready for repeated attachment.",
			}, { id: "cli-repeat-answer" }),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(
		fauxToolCall("agent_spawn", {
			title: "Fixture request",
			request: "Remain available for repeated CLI Agent view attachment.",
			label: "CLI Repeat Worker",
		}, { id: "cli-repeat-spawn" }),
		{ stopReason: "toolUse" },
	);
}

function findCreationRequestId(value: unknown): string | undefined {
	if (typeof value === "string") {
		try {
			return findCreationRequestId(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const requestId = findCreationRequestId(item);
			if (requestId) return requestId;
		}
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.kind === "request" &&
		typeof record.requestMessageId === "string"
	) {
		return record.requestMessageId;
	}
	for (const nested of Object.values(record)) {
		const requestId = findCreationRequestId(nested);
		if (requestId) return requestId;
	}
	return undefined;
}

function launchPiCli(options: {
	agentDir: string;
	sessionDir: string;
	additionalExtensionPaths?: readonly string[];
	provider?: string;
	model?: string;
}): PtyFixture {
	const command = [
		process.execPath,
		PI_CLI,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--extension",
		COORDINATION_EXTENSION,
		...(options.additionalExtensionPaths ?? []).flatMap((path) => ["--extension", path]),
		"--extension",
		PI_CLI_READY_EXTENSION,
		"--approve",
		"--tui-mode",
		"fullscreen",
		"--session-dir",
		options.sessionDir,
		"--provider",
		options.provider ?? "openai",
		"--model",
		options.model ?? "gpt-4o-mini",
	].map(quoteShell).join(" ");
	const child = spawn(
		SCRIPT,
		["-q", "-e", "-f", "-c", command, "/dev/null"],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				OPENAI_API_KEY: "test",
				PI_CODING_AGENT_DIR: options.agentDir,
				[PI_CLI_READY_EVIDENCE_ENV]: join(
					options.agentDir,
					PI_CLI_READY_EVIDENCE_FILE,
				),
				PI_OFFLINE: "1",
				TERM: "xterm-256color",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	return new PtyFixture(child, 80, 24);
}

async function waitForPiCliReady(agentDir: string): Promise<void> {
	// The readiness extension records resources_discover, Pi's public lifecycle
	// event immediately after session_start has completed.
	await waitForFile(join(agentDir, PI_CLI_READY_EVIDENCE_FILE));
}

function launchFixture(
	fixture = FIXTURE,
	environment: Readonly<Record<string, string>> = {},
) {
	const command = `${quoteShell(process.execPath)} ${quoteShell(fixture)}`;
	const child = spawn(
		SCRIPT,
		["-q", "-e", "-f", "-c", command, "/dev/null"],
		{
			env: {
				...process.env,
				PI_OFFLINE: "1",
				TERM: "xterm-256color",
				...environment,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	return new PtyFixture(
		child,
		Number(environment.PTY_TEST_COLUMNS) || 80,
		Number(environment.PTY_TEST_ROWS) || 24,
	);
}

async function returnPtyAgentViewToOwner(terminal: PtyFixture): Promise<void> {
	terminal.write("/agents");
	await terminal.waitForScreen((frame) => frame.some((line) => line.includes("/agents")));
	terminal.write("\r");
	await terminal.waitForScreen((frame) =>
		frame.some((line) => line.includes("Tab views"))
	);
	terminal.write("o");
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + PTY_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, SCREEN_POLL_INTERVAL_MS));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

type ChildLifecycleEvidence = Readonly<{
	kind: "session_start" | "session_shutdown";
	reason: string;
	pid: number;
}>;

async function waitForChildLifecycleEvidence(
	path: string,
	select: (entries: readonly ChildLifecycleEvidence[]) => ChildLifecycleEvidence | undefined,
): Promise<ChildLifecycleEvidence> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const entries = await readFile(path, "utf8").then(
			(contents) => contents.split("\n").filter(Boolean).map(
				(line) => JSON.parse(line) as ChildLifecycleEvidence,
			),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error),
		);
		const selected = select(entries);
		if (selected) return selected;
		await new Promise<void>((resolve) => setTimeout(resolve, SCREEN_POLL_INTERVAL_MS));
	}
	throw new Error("Timed out waiting for child lifecycle evidence");
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, SCREEN_POLL_INTERVAL_MS));
	}
	throw new Error(`Timed out waiting for child process ${pid} to exit`);
}

async function openDormantAgentSelector(
	terminal: PtyFixture,
	agentLabel: string,
): Promise<void> {
	const deadline = Date.now() + PTY_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		terminal.write("/agents");
		await terminal.waitForScreen(
			(frame) => frame.some((line) => line.includes("/agents")),
			`failed ${agentLabel} /agents command input`,
		);
		terminal.write("\r");
		const selector = await terminal.waitForScreen(
			(frame) => frame.some((line) => line.includes("Tab views")),
			`selector opened from failed ${agentLabel}`,
		);
		if (selector.some((line) => line.includes(agentLabel))) return;
		terminal.write("\t");
		const dormantSelector = await terminal.waitForScreen(
			(frame) => frame.some((line) => line.includes(agentLabel)),
			`Dormant selector containing ${agentLabel}`,
		);
		if (dormantSelector.some((line) => line.includes(agentLabel))) return;
		terminal.write("\x1b");
		await terminal.waitForScreen((frame) =>
			!frame.some((line) => line.includes("Tab views")) &&
			frame.some((line) => line.includes(agentLabel) && line.includes("failed"))
		);
	}
	throw new Error(`Agent ${agentLabel} did not enter the Dormant selector`);
}

class PtyFixture {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #columns: number;
	readonly #rows: number;
	#output = "";
	readonly #closed: Promise<void>;

	constructor(child: ChildProcessWithoutNullStreams, columns: number, rows: number) {
		this.#child = child;
		this.#columns = columns;
		this.#rows = rows;
		child.stdout.on("data", (chunk) => {
			this.#output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			this.#output += chunk.toString();
		});
		this.#closed = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) resolve();
				else reject(new Error(
					`PTY fixture exited with ${code ?? signal ?? "unknown status"}\n${this.#output}`,
				));
			});
		});
		void this.#closed.catch(() => undefined);
	}

	write(value: string): void {
		this.#child.stdin.write(value);
	}

	output(): string {
		return this.#output;
	}

	async screen(): Promise<string[]> {
		const terminal = new xtermHeadless.Terminal({
			allowProposedApi: true,
			cols: this.#columns,
			rows: this.#rows,
			scrollback: 1_000,
		});
		await new Promise<void>((resolve) => terminal.write(this.#output, resolve));
		const buffer = terminal.buffer.active;
		return Array.from({ length: this.#rows }, (_value, index) =>
			buffer.getLine(buffer.viewportY + index)?.translateToString(true).trim() ?? ""
		);
	}

	closed(): Promise<void> {
		return this.#closed;
	}

	async marker<T>(prefix: string): Promise<T> {
		await this.waitFor(prefix);
		const match = new RegExp(`${prefix}(\\{[^\\r\\n]+\\})`).exec(this.#output);
		if (!match) throw new Error(`PTY marker ${prefix} has no JSON payload`);
		return JSON.parse(match[1]!) as T;
	}

	async waitForScreen(
		predicate: (frame: readonly string[]) => boolean,
		description = "matching PTY screen",
	): Promise<string[]> {
		const initialFrame = await this.screen();
		if (predicate(initialFrame)) return initialFrame;
		return new Promise<string[]>((resolve, reject) => {
			let checking = false;
			let poll: ReturnType<typeof setInterval> | undefined;
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for ${description}\n${this.#output}`));
			}, PTY_WAIT_TIMEOUT_MS);
			const inspect = () => {
				if (checking) return;
				checking = true;
				void this.screen().then((frame) => {
					checking = false;
					if (!predicate(frame)) return;
					cleanup();
					resolve(frame);
				}).catch((error: unknown) => {
					checking = false;
					cleanup();
					reject(error);
				});
			};
			const closed = () => {
				void this.screen().then((frame) => {
					cleanup();
					if (predicate(frame)) resolve(frame);
					else reject(new Error(
						`PTY fixture closed before ${description} appeared\nFinal frame: ${JSON.stringify(frame)}\n${this.#output}`,
					));
				}).catch((error: unknown) => {
					cleanup();
					reject(error);
				});
			};
			const cleanup = () => {
				if (poll !== undefined) clearInterval(poll);
				clearTimeout(timeout);
				this.#child.stdout.off("data", inspect);
				this.#child.stderr.off("data", inspect);
				this.#child.off("close", closed);
			};
			this.#child.stdout.on("data", inspect);
			this.#child.stderr.on("data", inspect);
			this.#child.once("close", closed);
			poll = setInterval(inspect, SCREEN_POLL_INTERVAL_MS);
			inspect();
		});
	}

	async waitFor(value: string): Promise<void> {
		const matches = () => this.#output.includes(value);
		if (matches()) return;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for ${JSON.stringify(value)}\n${this.#output}`));
			}, PTY_WAIT_TIMEOUT_MS);
			const inspect = () => {
				if (!matches()) return;
				cleanup();
				resolve();
			};
			const closed = () => {
				cleanup();
				reject(new Error(
					`PTY fixture closed before ${JSON.stringify(value)} appeared\n${this.#output}`,
				));
			};
			const cleanup = () => {
				clearTimeout(timeout);
				this.#child.stdout.off("data", inspect);
				this.#child.stderr.off("data", inspect);
				this.#child.off("close", closed);
			};
			this.#child.stdout.on("data", inspect);
			this.#child.stderr.on("data", inspect);
			this.#child.once("close", closed);
		});
	}

	kill(): void {
		if (this.#child.exitCode === null && this.#child.signalCode === null) {
			this.#child.kill("SIGTERM");
		}
	}
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
