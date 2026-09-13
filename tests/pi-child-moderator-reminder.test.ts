import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { attachNativeChildDisplay, nativeChildDisplayText } from "./support/native-child-display.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import { PiChildProcessRuntime, type PiChildProcessLaunch } from "../src/process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../src/process-runtime/remote-participant-control.ts";
import { MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { PROCESS_RUNTIME_TEST_AGENT_DIR, PROCESS_RUNTIME_TEST_MODEL, PROCESS_RUNTIME_TEST_PROVIDER } from "./fixtures/process-runtime-child-extension.ts";

// Real Pi process startup loads extensions and the PTY; operation waits remain bounded.
test("real child reminder admission defers active work and serializes clear versus commit", {
	timeout: 30_000, skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-reminder-child-"));
	const cwd = join(root, "work");
	await mkdir(cwd);
	const sessionPath = join(root, "child.jsonl");
	const contextPath = join(root, "contexts.jsonl");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000211";
	await writeFile(sessionPath, JSON.stringify({
		type: "session", version: 3, id: expectedSessionId,
		timestamp: new Date().toISOString(), cwd,
	}) + "\n");
	const launch = await PiChildProcessRuntime.launch({
		workflowId: "hosted-runtime-test-workflow", agentId: expectedSessionId,
		role: "ordinary", expectedSessionId, sessionPath,
		agentDir: PROCESS_RUNTIME_TEST_AGENT_DIR,
		configuration: {
			cwd, model: { provider: PROCESS_RUNTIME_TEST_PROVIDER, modelId: PROCESS_RUNTIME_TEST_MODEL },
			thinking: "off", allowedTools: [], skills: [], loadContextFiles: false,
			extensions: ["process-runtime-child-extension.ts", "moderator-reminder-child-extension.ts"]
				.map((name) => fileURLToPath(new URL("./fixtures/" + name, import.meta.url))),
		},
		skillPaths: [], projectTrusted: true,
		ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PROCESS_RUNTIME_RESPONSE_DELAY_MS: "0",
			MODERATOR_REMINDER_CONTEXT_PATH: contextPath },
		runtimeDirectory: root, columns: 100, rows: 30,
		ownerRequestHandlers: ordinaryOwnerHandlers(expectedSessionId),
	});
	const runtime = new PiChildHostedRuntime(launch, []);
	const reminders = () => SessionManager.open(sessionPath).getEntries().filter(
		(entry) => entry.type === "custom_message" && entry.customType === MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE,
	);
	try {
		await runtime.ready;
		await attachNativeChildDisplay(launch);
		launch.writeInput("Hold a native model cycle.\r");
		await frameContains(launch, "REMINDER_CONTEXT_HELD");
		let callbackCalls = 0;
		assert.equal(await bounded(runtime.deliverModeratorReminder(async (commit) => {
			callbackCalls++;
			return commit();
		})), "busy");
		assert.equal(callbackCalls, 0, "active native work must not reserve or invoke reconciliation");
		assert.equal(reminders().length, 0);
		assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: [] });
		const nativeSettled = nextSettlement(runtime);
		launch.writeInput("/release-reminder-context\r");
		await nativeSettled;

		const lane = new SerialLane();
		let handling = true;
		const clearEntered = signal();
		const allowClear = signal();
		const clear = lane.run(async () => {
			clearEntered.resolve();
			await allowClear.promise;
			handling = false;
		});
		await clearEntered.promise;
		const prepared = signal();
		const suppressed = runtime.deliverModeratorReminder((commit) => {
			prepared.resolve();
			return lane.run(async () => handling ? commit() : "suppressed");
		});
		await bounded(prepared.promise);
		allowClear.resolve();
		await clear;
		assert.equal(await bounded(suppressed), "suppressed");
		assert.equal(reminders().length, 0);

		// Both normal delivery kinds must survive release of the suppressed reservation.
		for (const kind of ["message", "request"] as const) {
			const content = "ordinary-" + kind + "-after-suppression";
			const message = createMessageDelivery([{
				source: { agentId: "sender", entryId: kind + "-entry", toolCallId: kind + "-call" },
				projection: kind === "message"
					? { kind, messageId: kind + "-call", fromAgentId: "sender", content }
					: { title: "Fixture request", kind, requestMessageId: kind + "-call", fromAgentId: "sender", question: content },
			}]);
			const delivery = runtime.deliver({ kind: "custom", message, triggerTurn: true }, {
				inspectCommit: () => SessionManager.open(sessionPath).getEntries().some(
					(entry) => entry.type === "custom_message" && entry.content === message.content,
				),
			});
			assert.equal(await bounded(delivery.transcriptCommit!), true);
			await bounded(delivery.completion);
			assert.ok((await readFile(contextPath, "utf8")).includes(content));
		}
		assert.equal(reminders().length, 0);
		assert.ok(!(await readFile(contextPath, "utf8")).includes(MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE));

		handling = true;
		const committedInsideLane = signal();
		const releaseLane = signal();
		const reminderSettled = nextSettlement(runtime);
		const committed = runtime.deliverModeratorReminder((commit) => lane.run(async () => {
			assert.equal(handling, true);
			const outcome = await commit();
			assert.equal(outcome, "committed");
			assert.equal(reminders().length, 1, "commit must include durable child proof before releasing the Owner lane");
			committedInsideLane.resolve();
			await releaseLane.promise;
			return outcome;
		}));
		await bounded(committedInsideLane.promise);
		let clearRan = false;
		const laterClear = lane.run(() => { handling = false; clearRan = true; });
		assert.equal(clearRan, false);
		releaseLane.resolve();
		assert.equal(await bounded(committed), "committed");
		await bounded(laterClear);
		await reminderSettled;
		assert.equal(handling, false);
		assert.equal(reminders().length, 1);
		assert.ok((await readFile(contextPath, "utf8")).includes(MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE));
		assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: [] });
	} finally {
		await runtime.dispose();
	}
});

function signal(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function bounded<T>(operation: Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Child operation did not finish within 5s")), 5_000);
		operation.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

function nextSettlement(runtime: PiChildHostedRuntime): Promise<void> {
	return bounded(new Promise((resolve) => {
		const remove = runtime.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			remove();
			resolve();
		});
	}));
}

async function frameContains(launch: PiChildProcessLaunch, marker: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!nativeChildDisplayText(launch).includes(marker)) {
		if (Date.now() > deadline) throw new Error("native child display did not show " + marker);
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

function ordinaryOwnerHandlers(agentId: string): OwnerParticipantRequestHandlers<"ordinary"> {
	const status = {
		agentId,
		workflowId: "hosted-runtime-test-workflow",
		label: "Hosted Child",
		directSpawnerAgentId: "hosted-runtime-test-workflow",
		primaryEvidence: {
			transcriptPath: `/sessions/${agentId}.jsonl`,
			inspectedThrough: { agentId, entryId: `${agentId}-entry` },
		},
		run: {
			phase: "live" as const,
			work: "settled" as const,
			attention: "none" as const,
			retentionReasons: [{ reason: "interactive_selection" as const, count: 1 }],
		},
		model: { provider: PROCESS_RUNTIME_TEST_PROVIDER, modelId: PROCESS_RUNTIME_TEST_MODEL },
		thinking: "off" as const,
		compacting: false,
		queuedInputCount: 0,
	};
	return {
		presentation: {
			setReportRead: async () => {},
			snapshot: async () => ({
				live: [status], dormant: [], selectedAgentId: agentId,
				humanAttention: [], operationalAttention: [], reports: [],
			}),
			async select() { return { kind: "selected" }; },
		},
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
		coordination: {
			async agentTemplateSnapshot() {
				return {
					templates: [],
				};
			},
			async observe() { return { matches: [], hasMore: false }; },
			async message() {
				return {
					messageId: "unused-message",
					targetAgentId: "unused-target",
					messageStatus: "sent",
				};
			},
			async wait() { return { answers: [] }; },
			async control(_toolCallId, input) {
				return { agentId: input.agentId, disposition: "not_running" };
			},
			async spawn() {
				return {
					spawnStatus: "not_created",
					failedStage: "identity_commit",
					reason: "Test child was not created",
				};
			},
			async askUser() { return { requestId: "unused-human", answer: "unused" }; },
		},
	};
}
