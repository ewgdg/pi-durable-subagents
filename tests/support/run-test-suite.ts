import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import "./pi-test-environment.ts";
import { runTestProcess } from "./test-process-supervisor.ts";

const FAST_TEST_CONCURRENCY = 4;
const PROCESS_TEST_CONCURRENCY = 1;
const FAST_TEST_TIMEOUT_MS = 5_000;
// Process files contain many serial PTY/process cases; the Node test runner applies
// this timeout to the file's top-level suite, so it must cover cumulative setup.
const PROCESS_TEST_TIMEOUT_MS = 120_000;

// These files launch real Pi processes, PTYs, sockets, or process-visible model
// brokers. Keeping the boundary explicit prevents machine CPU count from turning
// integration tests into a resource-contention lottery.
const PROCESS_TEST_FILES = new Set([
	"repair-helper-process.test.ts",
	"idle-custom-process-startup.test.ts",
	"child-launch-contract.test.ts",
	"child-launch-contract-containment.test.ts",
	"background-delivery-process.test.ts",
	"causal-request-preemption.test.ts",
	"child-runtime-settlement-continuation.test.ts",
	"agent-request.test.ts",
	"agent-spawn.test.ts",
	"agent-view.test.ts",
	"cold-host-recovery.test.ts",
	"coordinated-workflow-pty.test.ts",
	"deferred-request-after-answer.test.ts",
	"detached-child-ui-pty.test.ts",
	"execution-scheduler.test.ts",
	"human-request-pty.test.ts",
	"human-request.test.ts",
	"interactive-host-conformance.test.ts",
	"message.test.ts",
	"named-pipe-control-transport.test.ts",
	"operational-incidents.test.ts",
	"moderator-report-integration.test.ts",
	"moderator-startup-progress.test.ts",
	"owner-bootstrap.test.ts",
	"owner-fork.test.ts",
	"owner-settlement-parking.test.ts",
	"parked-owner-deferred-request.test.ts",
	"owner-workflow.test.ts",
	"participant-lifecycle-native.test.ts",
	"pi-child-hosted-runtime.test.ts",
	"pi-child-moderator-reminder.test.ts",
	"pi-child-process-launch.test.ts",
	"pi-child-process-runtime.test.ts",
	"process-child-session-factory.test.ts",
	"process-model-broker.test.ts",
	"process-visible-owner-model.test.ts",
	"pty-terminal-projection.test.ts",
	"request-inspection-process.test.ts",
	"run-supervision.test.ts",
	"quota-lifecycle-integration.test.ts",
	"quota-cold-recovery.test.ts",
	"run-test-suite.test.ts",
	"steer-request-preemption.test.ts",
	"unix-control-transport.test.ts",
	"windows-process-control-transport.test.ts",
]);

const CONFORMANCE_TEST_FILES = new Set([
	"host-shape.test.ts",
	"host-module-world.test.ts",
	"pi-host-behavior-conformance.test.ts",
	"interactive-host-conformance.test.ts",
	"extension-conformance.test.ts",
	"agent-selector-surface.test.ts",
	"human-request.test.ts",
	"human-request-pty.test.ts",
	"owner-workflow.test.ts",
	"coordinated-workflow-pty.test.ts",
]);
// Allow runner startup in addition to one file-timeout budget per concurrency wave.
const SUITE_STARTUP_ALLOWANCE_MS = 5_000;

const suite = process.argv[2];
if (suite !== "fast" && suite !== "process" && suite !== "conformance") {
	throw new Error('Test suite must be "fast", "process", or "conformance"');
}

const testsDirectory = fileURLToPath(new URL("..", import.meta.url));
const allTestFiles = readdirSync(testsDirectory)
	.filter((file) => file.endsWith(".test.ts"))
	.sort();
const missingProcessFiles = [...PROCESS_TEST_FILES]
	.filter((file) => !allTestFiles.includes(file));
if (missingProcessFiles.length > 0) {
	throw new Error(`Configured process tests do not exist: ${missingProcessFiles.join(", ")}`);
}

const suiteFiles = allTestFiles
	.filter((file) => suite === "conformance"
		? CONFORMANCE_TEST_FILES.has(file)
		: PROCESS_TEST_FILES.has(file) === (suite === "process"));
const fileSelectors = process.argv.slice(3)
	.filter((argument) => argument.startsWith("--file="));
if (fileSelectors.length > 1) throw new Error("Select at most one test file");
const selectedFile = fileSelectors[0]?.slice("--file=".length);
if (selectedFile && !suiteFiles.includes(selectedFile)) {
	throw new Error(`Test file is not in the ${suite} suite: ${selectedFile}`);
}
const selectedFiles = (selectedFile ? [selectedFile] : suiteFiles)
	.map((file) => join(testsDirectory, file));
const deadlineArguments = process.argv.slice(3)
	.filter((argument) => argument.startsWith("--deadline-ms="));
if (deadlineArguments.length > 1) throw new Error("Select at most one supervisor deadline");
const deadlineOverride = deadlineArguments[0]?.slice("--deadline-ms=".length);
if (deadlineOverride !== undefined && (
	!/^\d+$/.test(deadlineOverride) || Number(deadlineOverride) < 1
	|| Number(deadlineOverride) > 2_147_483_647
)) throw new Error("Supervisor deadline must be an integer between 1 and 2147483647 milliseconds");
const forwardedArguments = process.argv.slice(3)
	.filter((argument) => !argument.startsWith("--file=") && !argument.startsWith("--deadline-ms="));
if (forwardedArguments.includes("--list")) {
	for (const file of selectedFiles) console.log(basename(file));
	process.exit(0);
}

const concurrency = suite === "fast"
	? FAST_TEST_CONCURRENCY
	: PROCESS_TEST_CONCURRENCY;
const timeoutMs = suite === "fast"
	? FAST_TEST_TIMEOUT_MS
	: PROCESS_TEST_TIMEOUT_MS;
process.exitCode = await runTestProcess([
	"--test",
	`--test-concurrency=${concurrency}`,
	`--test-timeout=${timeoutMs}`,
	"--test-reporter=dot",
	...forwardedArguments,
	...selectedFiles,
], deadlineOverride === undefined
	? Math.ceil(selectedFiles.length / concurrency) * timeoutMs + SUITE_STARTUP_ALLOWANCE_MS
	: Number(deadlineOverride));
