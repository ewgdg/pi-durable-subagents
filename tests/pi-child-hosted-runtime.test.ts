import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { QUOTA_DIAGNOSTICS } from "./fixtures/quota-evidence-extension.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

import { attachNativeChildDisplay, nativeChildDisplayText } from "./support/native-child-display.ts";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import {
	PiChildProcessRuntime,
	type PiChildProcessLaunch,
	type PiChildRuntimeEvent,
} from "../src/process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../src/process-runtime/remote-participant-control.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import {
	PROCESS_RUNTIME_TEST_AGENT_DIR,
	PROCESS_RUNTIME_TEST_ALTERNATE_MODEL,
	PROCESS_RUNTIME_TEST_MODEL,
	PROCESS_RUNTIME_TEST_PROVIDER,
} from "./fixtures/process-runtime-child-extension.ts";

const TEST_TIMEOUT_MS = 30_000;
const CHILD_EXTENSION = fileURLToPath(
	new URL("./fixtures/process-runtime-child-extension.ts", import.meta.url),
);

for (const scenario of ["evidence", "terminal-queue", "native-retry"]) {
test(`real child bridge quota handling: ${scenario}`, {
	timeout: TEST_TIMEOUT_MS, skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "quota-evidence-child-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: scenario === "native-retry", maxRetries: 1, baseDelayMs: 1 } }));
	const sessionPath = join(root, "child.jsonl");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000137";
	await writeFile(sessionPath, JSON.stringify({ type: "session", version: 3, id: expectedSessionId, timestamp: new Date().toISOString(), cwd }) + "\n");
	const launch = await PiChildProcessRuntime.launch({
		workflowId: "quota-evidence", agentId: "quota-evidence-child", role: "ordinary", expectedSessionId,
		sessionPath, agentDir, runtimeDirectory: root, skillPaths: [], projectTrusted: true,
		configuration: { cwd, model: { provider: "openai-codex", modelId: "quota-fixture" }, thinking: "off", tools: [], skills: [],
			extensions: [fileURLToPath(new URL("./fixtures/quota-evidence-extension.ts", import.meta.url))], loadContextFiles: false },
		ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1", QUOTA_FIXTURE_SCENARIO: scenario },
	});
	const runtime = new PiChildHostedRuntime(launch);
	const ends: Extract<HostedRuntimeEvent, { type: "agent_end" }>[] = [];
	let settlements = 0;
	runtime.subscribe(event => {
		if (event.type === "agent_end") ends.push(event);
		if (event.type === "agent_settled") settlements++;
	});
	try {
		await runtime.ready;
		if (scenario !== "evidence") {
			await runtime.deliver({ kind: "user", content: "Exercise native quota continuation." }).completion;
			await waitUntil(() => settlements === 1);
			if (scenario === "native-retry") {
				assert.equal(ends.length, 2, "configured Pi retry must complete before suspension");
				assert.equal(ends[0]!.willRetry, true);
				assert.ok(ends[0]!.quota);
				assert.equal(ends[1]!.outcome, "completed");
			} else {
				assert.equal(ends.length, 1, "terminal quota must not start queued follow-up generation");
				assert.ok(ends[0]!.quota);
				assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: ["Retain this follow-up until explicit resume."] });
				assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: [] });
			}
			return;
		}
		for (const [index, diagnostic] of QUOTA_DIAGNOSTICS.entries()) {
			await runtime.deliver({ kind: "user", content: `Failure case ${index}` }).completion;
			await waitUntil(() => settlements === index + 1);
			assert.equal(ends.length, index + 1);
			const event = ends[index]!;
			assert.equal(event.willRetry, false);
			assert.equal(event.failure?.error, diagnostic);
			assert.deepEqual(event.quota, index < 3 ? {
				diagnostic, provider: "openai-codex", model: "quota-fixture",
				...(index === 1 ? { resetAt: "2030-01-01T00:00:00.000Z" } : {}),
			} : undefined);
		}
	} finally { await runtime.dispose(); }
});
}

test("the common Runtime Host supervises one real Control-backed Pi child Runtime", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-hosted-runtime-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000201";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });

	const launchTools = ["read"] as const;
	const launch = await PiChildProcessRuntime.launch({
		workflowId: "hosted-runtime-test-workflow",
		agentId: "hosted-runtime-test-agent",
		role: "ordinary",
		expectedSessionId,
		sessionPath,
		agentDir: PROCESS_RUNTIME_TEST_AGENT_DIR,
		configuration: {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: launchTools,
			skills: [],
			extensions: [CHILD_EXTENSION],
			loadContextFiles: true,
		},
		skillPaths: [],
		projectTrusted: true,
		ownerEnvironment: {
			...process.env,
			PI_SKIP_VERSION_CHECK: "1",
			PROCESS_RUNTIME_RESPONSE_DELAY_MS: "300",
		},
		runtimeDirectory: root,
		columns: 80,
		rows: 24,
		ownerRequestHandlers: ordinaryOwnerHandlers("hosted-runtime-test-agent"),
	});
	const pid = launch.pid;
	const bootstrapPath = launch.bootstrapPath;
	const runtime = new PiChildHostedRuntime(launch);
	const host = AgentRuntimeSupervisor.createChild({
		agentId: expectedSessionId,
		startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	const settlements: string[] = [];
	host.addSettledHandler((_handle, settlement) => settlements.push(settlement));

	try {
		const handle = await host.lane.run(() => host.startInLane());
		assert.deepEqual(host.effectiveRuntimeSnapshot(), {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: ["read"],
			skills: [],
			skillSources: [],
			fileExtensionPaths: [CHILD_EXTENSION],
			projectTrusted: true,
			sessionId: expectedSessionId,
		});
		assert.equal(host.currentProjection(), runtime.projection);
		assert.equal(host.currentWorkState(), "settled");
		assert.equal(host.classifyToolBatch(["read"]), "asynchronous");
		await attachNativeChildDisplay(launch);
		launch.writeInput("/runtime-state\r");
		await waitUntil(() => nativeChildDisplayText(launch).includes("PROCESS_RUNTIME_STATE_CHANGED"));
		// Pi's model_select event updates Owner presentation state without waiting
		// for a later descendant pull; the complete event snapshot also carries tools.
		assert.equal(
			host.effectiveRuntimeSnapshot()?.model.modelId,
			PROCESS_RUNTIME_TEST_ALTERNATE_MODEL,
		);
		assert.deepEqual(host.effectiveRuntimeSnapshot()?.tools, []);
		assert.throws(
			() => host.classifyToolBatch(["read"]),
			/invariant_violation: tool definition read is unavailable/,
		);
		assert.deepEqual(host.effectiveRuntimeSnapshot()?.tools, []);
		assert.equal(
			host.effectiveRuntimeSnapshot()?.model.modelId,
			PROCESS_RUNTIME_TEST_ALTERNATE_MODEL,
		);
		assert.throws(
			() => host.classifyToolBatch(["missing-tool"]),
			/invariant_violation: tool definition missing-tool is unavailable/,
		);

		const handled = host.deliverInLane(
			{ kind: "user", content: "PROCESS_RUNTIME_HANDLED_INPUT" },
			{ inspectCommit: () => false },
		);
		assert.equal(await handled.transcriptCommit, false);
		assert.equal(await Promise.race([
			handled.completion.then(() => "completed" as const),
			new Promise<"timed_out">((resolve) =>
				setTimeout(() => resolve("timed_out"), 1_000)
			),
		]), "completed");
		assert.equal(host.currentWorkState(), "settled");
		assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: [] });
		await runtime.abort();

		const customMessage = createMessageDelivery([{
			source: {
				agentId: "hosted-runtime-sender",
				entryId: "hosted-runtime-source-entry",
				toolCallId: "hosted-runtime-source-call",
			},
			projection: {
				kind: "message",
				messageId: "hosted-runtime-source-call",
				fromAgentId: "hosted-runtime-sender",
				content: "Commit this custom Delivery before settlement.",
			},
		}]);
		const delivery = host.deliverInLane(
			{ kind: "custom", message: customMessage, triggerTurn: true },
			{
				inspectCommit: () => {
					const tail = SessionManager.open(sessionPath).getEntries().at(-1);
					return tail?.type === "custom_message" &&
						tail.customType === customMessage.customType &&
						tail.content === customMessage.content;
				},
			},
		);
		let deliveryCompleted = false;
		void delivery.completion.then(() => deliveryCompleted = true);
		assert.equal(await delivery.transcriptCommit, true);
		assert.equal(deliveryCompleted, false);
		assert.equal(host.currentWorkState(), "active");
		const cancellation = host.exactRunCancellationSignal(handle);
		assert.equal(cancellation.aborted, false);
		await delivery.completion;
		assert.equal(cancellation.aborted, false);

		const activeContent = [{ type: "text" as const, text: "Interrupt this model cycle." }];
		const activeDelivery = host.deliverInLane(
			{ kind: "user", content: activeContent },
			{
				inspectCommit: () => {
					const tail = SessionManager.open(sessionPath).getEntries().at(-1);
					return tail?.type === "message" &&
						tail.message.role === "user" &&
						JSON.stringify(tail.message.content) === JSON.stringify(activeContent);
				},
			},
		);
		assert.equal(await activeDelivery.transcriptCommit, true);
		assert.equal(host.exactRunCancellationSignal(handle), cancellation);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const queued = host.deliverInLane({
			kind: "user",
			content: "Preserve this queued direction across the Hold.",
			deliverAs: "steer",
		});
		assert.equal(
			await host.lane.run(() => host.interruptCurrentRunInLane()),
			"held",
		);
		await Promise.all([activeDelivery.completion, queued.completion]);
		assert.equal(cancellation.aborted, true);
		assert.equal(host.currentWorkState(), "settled");
		assert.equal(host.queuedInputCount(), 1);
		assert.deepEqual(settlements, ["settled", "settled"]);
		assert.deepEqual(host.observe(), {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [{ reason: "interruption_hold", count: 1 }],
		});

		await host.lane.run(() => host.discardAndEndInLane("termination"));
		assert.equal(host.observe().phase, "dormant");
		assert.throws(() => process.kill(pid, 0), hasCode("ESRCH"));
		await assert.rejects(lstat(bootstrapPath), hasCode("ENOENT"));
	} finally {
		await launch.dispose();
	}
});

test("a hosted child atomically refreshes its effective snapshot and tool modes", async () => {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	const initialSnapshot = fakeRuntimeSnapshot({
		modelId: "initial-model",
		thinking: "off",
		toolExecutionModes: [{ name: "parallel-tool", executionMode: "parallel" }],
	});
	let currentSnapshot = initialSnapshot;
	let requestSnapshot = async () => currentSnapshot;
	const admitted = {
		snapshot: initialSnapshot,
		channel: {
			onClose: () => () => undefined,
			async request(method: string) {
				if (method === "runtime.snapshot") return await requestSnapshot();
				throw new Error(`unexpected request: ${method}`);
			},
		},
	} as unknown as PiChildProcessRuntime;
	const runtime = new PiChildHostedRuntime(fakeLaunch(admitted, eventHandlers));
	await runtime.ready;
	assert.equal(runtime.snapshot().model.modelId, "initial-model");
	assert.equal(runtime.classifyToolBatch(["parallel-tool"]), "asynchronous");

	currentSnapshot = fakeRuntimeSnapshot({
		modelId: "current-model",
		thinking: "high",
		toolExecutionModes: [{ name: "sequential-tool", executionMode: "sequential" }],
	});
	for (const handler of eventHandlers) {
		handler(controlEvent("runtime.snapshot.changed", currentSnapshot));
	}
	assert.equal(runtime.snapshot().model.modelId, "current-model");
	assert.equal(runtime.classifyToolBatch(["sequential-tool"]), "blocking");
	await runtime.synchronizeState();
	assert.deepEqual(runtime.snapshot(), {
		cwd: "/runtime",
		model: { provider: "test", modelId: "current-model" },
		thinking: "high",
		tools: ["sequential-tool"],
		skills: [],
		skillSources: [],
		fileExtensionPaths: [],
		projectTrusted: true,
		sessionId: "dynamic-runtime",
	});
	assert.equal(runtime.classifyToolBatch(["sequential-tool"]), "blocking");
	assert.throws(
		() => runtime.classifyToolBatch(["parallel-tool"]),
		/invariant_violation: tool definition parallel-tool is unavailable/,
	);

	let releaseStaleSnapshot!: () => void;
	const staleSnapshotReleased = new Promise<void>((resolve) => {
		releaseStaleSnapshot = resolve;
	});
	let markSnapshotRequested!: () => void;
	const snapshotRequested = new Promise<void>((resolve) => {
		markSnapshotRequested = resolve;
	});
	requestSnapshot = async () => {
		markSnapshotRequested();
		await staleSnapshotReleased;
		return currentSnapshot;
	};
	const synchronization = runtime.synchronizeState();
	await snapshotRequested;
	const newerSnapshot = fakeRuntimeSnapshot({
		modelId: "newer-model",
		thinking: "off",
		toolExecutionModes: [{ name: "newer-tool", executionMode: "parallel" }],
	});
	for (const handler of eventHandlers) {
		handler(controlEvent("runtime.snapshot.changed", newerSnapshot));
	}
	releaseStaleSnapshot();
	await synchronization;
	assert.equal(runtime.snapshot().model.modelId, "newer-model");
	assert.equal(runtime.classifyToolBatch(["newer-tool"]), "asynchronous");
	await runtime.dispose();
});

test("a prepared hosted child has no Run queue or abort intention", async () => {
	const requestedMethods: string[] = [];
	const snapshot = fakeRuntimeSnapshot({
		modelId: "prepared-model",
		thinking: "off",
		toolExecutionModes: [],
	});
	const admitted = {
		snapshot,
		channel: {
			onClose: () => () => undefined,
			async request(method: string) {
				requestedMethods.push(method);
				throw new Error(`unexpected request: ${method}`);
			},
		},
	} as unknown as PiChildProcessRuntime;
	const runtime = new PiChildHostedRuntime(fakeLaunch(admitted, new Set()));
	await runtime.ready;
	assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: [] });
	await runtime.abort();
	assert.deepEqual(requestedMethods, []);
	await runtime.dispose();
});

test("retry and normal agent-end boundaries do not falsely cancel the exact hosted Run", async () => {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	const admitted = {
		snapshot: {
			cwd: "/runtime",
			model: { provider: "test", modelId: "model" },
			thinking: "off",
			tools: ["parallel-tool", "sequential-tool"],
			skills: [],
			skillSources: [],
			extensions: [],
			toolExecutionModes: [
				{ name: "parallel-tool", executionMode: "parallel" },
				{ name: "sequential-tool", executionMode: "sequential" },
			],
			projectTrusted: true,
			sessionId: "retry-runtime",
			sessionPath: "/sessions/retry-runtime.jsonl",
			systemPrompt: null,
			loadContextFiles: true,
		},
		channel: {
			onClose: () => () => undefined,
			async request() {
				return {
					accepted: true,
					transcriptCommitted: true,
					modelCycleStarted: true,
					queuedInputCount: 0,
				};
			},
		},
	} as unknown as PiChildProcessRuntime;
	const launch = {
		exited: new Promise<never>(() => undefined),
		ready: async () => admitted,
		cancelInitialization: () => undefined,
		frame: () => ({
			columns: 80,
			rows: 24,
			lines: [],
			cursor: { row: 0, column: 0, visible: false, style: "block", blink: false },
		}),
		writeInput() {},
		resize() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler: () => () => undefined,
		onEvent(handler: (event: PiChildRuntimeEvent) => void) {
			eventHandlers.add(handler);
			return () => eventHandlers.delete(handler);
		},
		dispose: async () => undefined,
	} as unknown as PiChildProcessLaunch;
	const runtime = new PiChildHostedRuntime(
		launch,
	);
	await runtime.ready;
	assert.equal(runtime.classifyToolBatch(["parallel-tool"]), "asynchronous");
	assert.equal(
		runtime.classifyToolBatch(["parallel-tool", "sequential-tool"]),
		"blocking",
	);
	assert.throws(
		() => runtime.classifyToolBatch(["missing-tool"]),
		/invariant_violation: tool definition missing-tool is unavailable/,
	);
	const completion = runtime.deliver({ kind: "user", content: "Retry this Run." }).completion;
	const emit = (event: PiChildRuntimeEvent) => {
		for (const handler of eventHandlers) handler(event);
	};

	emit(controlEvent("agent.start", { runId: "hosted-run-1", queuedInputCount: 0 }));
	const cancellation = runtime.cancellationSignal();
	emit(controlEvent("agent.end", {
		runId: "hosted-run-1",
		outcome: "failed",
		willRetry: true,
		queuedInputCount: 0,
		error: "retryable",
	}));
	assert.equal(cancellation.aborted, false);
	emit(controlEvent("agent.start", { runId: "hosted-run-1", queuedInputCount: 0 }));
	assert.equal(runtime.cancellationSignal(), cancellation);
	emit(controlEvent("agent.end", {
		runId: "hosted-run-1",
		outcome: "completed",
		willRetry: false,
		queuedInputCount: 0,
	}));
	assert.equal(cancellation.aborted, false);
	emit(controlEvent("message.dispatch.completed", { deliveryId: "delivery-1" }));
	emit(controlEvent("agent.settled", {
		runId: "hosted-run-1",
		outcome: "completed",
		queuedInputCount: 0,
	}));
	await completion;
	await runtime.dispose();
});

for (const failure of ["channel_loss", "process_kill"] as const) {
	test(`an unexpected real child ${failure} terminally fails the common hosted Run`, {
		timeout: TEST_TIMEOUT_MS,
		skip: process.platform === "win32",
	}, async () => {
		const harness = await createFailureHarness(failure);
		const settlements: string[] = [];
		harness.host.addSettledHandler((_handle, settlement) => settlements.push(settlement));
		try {
			const delivery = harness.host.deliverInLane(
				{ kind: "user", content: `Fail during ${failure}.` },
				{
					inspectCommit: () => SessionManager.open(harness.sessionPath)
						.getEntries()
						.some((entry) =>
							entry.type === "message" &&
							entry.message.role === "user"
						),
				},
			);
			assert.equal(await delivery.transcriptCommit, true);
			const cancellation = harness.host.exactRunCancellationSignal(harness.handle);
			if (failure === "channel_loss") {
				await (await harness.launch.ready()).channel.close();
			} else {
				process.kill(harness.launch.pid, "SIGKILL");
			}
			await waitUntil(() => settlements.length === 1);
			await assert.rejects(delivery.completion);
			assert.deepEqual(settlements, ["failed"]);
			assert.equal(cancellation.aborted, true);
			assert.equal(harness.host.currentRunFailed(), true);
			assert.equal(harness.host.currentWorkState(), "unavailable");
			const failedRunState = harness.host.observe();
			assert.equal("work" in failedRunState && failedRunState.work, "settled");
			await harness.launch.exited;
			await waitUntil(async () => {
				try {
					await lstat(harness.systemPromptArtifactPath);
					return false;
				} catch (error) {
					return hasCode("ENOENT")(error);
				}
			});
			await harness.host.lane.run(() =>
				harness.host.discardAndEndInLane("failure")
			).catch(() => undefined);
			assert.equal(harness.host.observe().phase, "dormant");
			assert.throws(() => process.kill(harness.launch.pid, 0), hasCode("ESRCH"));
		} finally {
			await harness.launch.dispose();
		}
	});
}

for (const scenario of [
	"selected_quit", "unselected_quit", "reload", "unannounced_exit", "signal_exit", "host_disposal",
] as const) {
	test(`hosted child shutdown classification: ${scenario}`, { timeout: 5_000 }, async () => {
		const handlers = new Set<(event: PiChildRuntimeEvent) => void>();
		let resolveExit!: (exit: { exitCode: number; signal: number }) => void;
		const exited = new Promise<{ exitCode: number; signal: number }>((resolve) => {
			resolveExit = resolve;
		});
		let channelClosed: ((error?: unknown) => void) | undefined;
		const admitted = {
			snapshot: fakeRuntimeSnapshot({ modelId: "quit-test", thinking: "off", toolExecutionModes: [] }),
			channel: {
				onClose(handler: (error?: unknown) => void) {
					channelClosed = handler;
					return () => { channelClosed = undefined; };
				},
				async request() {
					return { accepted: true, transcriptCommitted: true, modelCycleStarted: true, queuedInputCount: 0 };
				},
			},
		} as unknown as PiChildProcessRuntime;
		const launch = Object.assign(fakeLaunch(admitted, handlers), { exited });
		const observed: string[] = [];
		const runtime = new PiChildHostedRuntime(launch, () => {
			observed.push("quit_requested");
			return scenario === "selected_quit";
		});
		await runtime.ready;
		runtime.subscribe((event) => {
			if (event.type === "agent_end") observed.push(`agent_end:${event.outcome}`);
		});
		runtime.projection.addExitRequestHandler(() => observed.push("presentation_exit"));
		const delivery = runtime.deliver({ kind: "user", content: "Keep work outstanding." });
		const completion = delivery.completion.then(() => "completed", () => "rejected");
		for (const handler of handlers) handler(controlEvent("agent.start", {
			runId: "hosted-run-1", queuedInputCount: 0,
		}));
		if (scenario === "selected_quit" || scenario === "unselected_quit" || scenario === "reload") {
			for (const handler of handlers) handler(controlEvent("session.shutdown", {
				reason: scenario === "reload" ? "reload" : "quit",
			}));
		}
		if (scenario === "selected_quit") {
			assert.deepEqual(observed, ["quit_requested"]);
			assert.equal(runtime.workState(), "unavailable");
			assert.equal(await completion, "rejected", "shutdown must release in-flight delivery");
			for (const handler of handlers) handler(controlEvent("agent.start", {
				runId: "late-child-cycle", queuedInputCount: 0,
			}));
			assert.equal(runtime.workState(), "unavailable", "late lifecycle cannot revive a quitting Runtime");
		}
		if (scenario === "reload") {
			assert.equal(runtime.workState(), "active");
			assert.deepEqual(observed, []);
		}
		if (scenario === "host_disposal") {
			// Settle work normally first; disposal owns the later transport exit.
			for (const handler of handlers) handler(controlEvent("message.dispatch.completed", { deliveryId: "delivery-1" }));
			for (const handler of handlers) handler(controlEvent("agent.settled", {
				runId: "hosted-run-1", queuedInputCount: 0, outcome: "completed",
			}));
			assert.equal(await completion, "completed");
			await runtime.projection.dispose();
		}
		resolveExit({ exitCode: 0, signal: scenario === "signal_exit" ? 9 : 0 });
		channelClosed?.(new Error("Control closed after process quit"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const expected = scenario === "selected_quit" || scenario === "host_disposal";
		assert.equal(observed.includes("agent_end:error"), !expected);
		if (scenario !== "host_disposal") assert.equal(observed.at(-1), "presentation_exit");
		if (!expected) assert.equal(await completion, "rejected");
		await runtime.dispose();
	});
}


test("hosted child reminder busy releases explicit reservation", { timeout: 5000 }, async () => {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	let reserved = false;
	let prepareCalls = 0;
	let callbackCalls = 0;
	const calls: Array<{ method: string; payload: unknown }> = [];
	const admitted = {
		snapshot: fakeRuntimeSnapshot({ modelId: "reminder-busy", thinking: "off", toolExecutionModes: [] }),
		channel: {
			onClose: () => () => undefined,
			async request(method: string, payload: unknown) {
				calls.push({ method, payload });
				if (method === "moderatorReminder.prepare") {
					assert.equal(reserved, false);
					reserved = true;
					prepareCalls++;
					return { prepared: prepareCalls > 1 };
				}
				if (method === "moderatorReminder.finish") {
					assert.equal((payload as { commit: boolean }).commit, false);
					reserved = false;
					return { outcome: "suppressed" };
				}
				throw new Error("unexpected request: " + method);
			},
		},
	} as unknown as PiChildProcessRuntime;
	const runtime = new PiChildHostedRuntime(fakeLaunch(admitted, eventHandlers));
	try {
		await runtime.ready;
		assert.equal(await runtime.deliverModeratorReminder(async () => {
			callbackCalls++;
			return "committed";
		}), "busy");
		assert.equal(callbackCalls, 0);
		assert.equal(reserved, false);
		assert.deepEqual(calls.map(({ method }) => method), [
			"moderatorReminder.prepare",
			"moderatorReminder.finish",
		]);

		assert.equal(await runtime.deliverModeratorReminder(async () => {
			callbackCalls++;
			return "suppressed";
		}), "suppressed");
		assert.equal(callbackCalls, 1);
		assert.equal(reserved, false, "a busy reservation must not block its successor");
	} finally {
		await runtime.dispose();
	}
});

test("hosted child reminder stale callback suppresses and releases reservation", { timeout: 5000 }, async () => {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	let reserved = false;
	const calls: Array<{ method: string; payload: unknown }> = [];
	const admitted = {
		snapshot: fakeRuntimeSnapshot({ modelId: "reminder-stale", thinking: "off", toolExecutionModes: [] }),
		channel: {
			onClose: () => () => undefined,
			async request(method: string, payload: unknown) {
				calls.push({ method, payload });
				if (method === "moderatorReminder.prepare") {
					assert.equal(reserved, false);
					reserved = true;
					return { prepared: true };
				}
				if (method === "moderatorReminder.finish") {
					const commit = (payload as { commit: boolean }).commit;
					assert.equal(commit, false, "a stale callback must release, never commit");
					reserved = false;
					return { outcome: "suppressed" };
				}
				throw new Error("unexpected request: " + method);
			},
		},
	} as unknown as PiChildProcessRuntime;
	const runtime = new PiChildHostedRuntime(fakeLaunch(admitted, eventHandlers));
	try {
		await runtime.ready;
		const outcome = await runtime.deliverModeratorReminder(async (commit) => {
			assert.equal(typeof commit, "function");
			return "suppressed";
		});
		assert.equal(outcome, "suppressed");
		assert.equal(reserved, false);
		assert.equal(calls.filter(({ method, payload }) =>
			method === "moderatorReminder.finish" && (payload as { commit: boolean }).commit
		).length, 0);
		assert.equal(await runtime.deliverModeratorReminder(async () => "suppressed"), "suppressed");
	} finally {
		await runtime.dispose();
	}
});

test("hosted child reminder throwing callback releases reservation", { timeout: 5000 }, async () => {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	let reserved = false;
	let prepareCalls = 0;
	const callbackError = new Error("reconciliation failed");
	const admitted = {
		snapshot: fakeRuntimeSnapshot({ modelId: "reminder-throw", thinking: "off", toolExecutionModes: [] }),
		channel: {
			onClose: () => () => undefined,
			async request(method: string, payload: unknown) {
				if (method === "moderatorReminder.prepare") {
					assert.equal(reserved, false);
					reserved = true;
					prepareCalls++;
					return { prepared: true };
				}
				if (method === "moderatorReminder.finish") {
					assert.equal((payload as { commit: boolean }).commit, false);
					reserved = false;
					return { outcome: "suppressed" };
				}
				throw new Error("unexpected request: " + method);
			},
		},
	} as unknown as PiChildProcessRuntime;
	const runtime = new PiChildHostedRuntime(fakeLaunch(admitted, eventHandlers));
	try {
		await runtime.ready;
		await assert.rejects(
			runtime.deliverModeratorReminder(async () => {
				throw callbackError;
			}),
			(error) => error === callbackError,
		);
		assert.equal(reserved, false);
		assert.equal(prepareCalls, 1);
		assert.equal(await runtime.deliverModeratorReminder(async () => "suppressed"), "suppressed");
		assert.equal(reserved, false);
	} finally {
		await runtime.dispose();
	}
});

test("hosted child reminder abort while callback waits releases promptly and late callback cannot commit", { timeout: 5000 }, async () => {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	let reserved = false;
	let finishRelease!: () => void;
	const releaseObserved = new Promise<void>((resolve) => { finishRelease = resolve; });
	let callbackStarted!: () => void;
	const callbackEntered = new Promise<void>((resolve) => { callbackStarted = resolve; });
	let allowLateCallback!: () => void;
	const lateCallbackAllowed = new Promise<void>((resolve) => { allowLateCallback = resolve; });
	let callbackFinished!: () => void;
	const callbackCompleted = new Promise<void>((resolve) => { callbackFinished = resolve; });
	let lateCommitRejected = false;
	let finishCommitCalls = 0;
	const admitted = {
		snapshot: fakeRuntimeSnapshot({ modelId: "reminder-abort", thinking: "off", toolExecutionModes: [] }),
		channel: {
			onClose: () => () => undefined,
			async request(method: string, payload: unknown) {
				if (method === "moderatorReminder.prepare") {
					assert.equal(reserved, false);
					reserved = true;
					return { prepared: true };
				}
				if (method === "moderatorReminder.finish") {
					const commit = (payload as { commit: boolean }).commit;
					if (commit) {
						finishCommitCalls++;
						throw new Error("late commit reached transport");
					}
					reserved = false;
					finishRelease();
					return { outcome: "suppressed" };
				}
				throw new Error("unexpected request: " + method);
			},
		},
	} as unknown as PiChildProcessRuntime;
	const runtime = new PiChildHostedRuntime(fakeLaunch(admitted, eventHandlers));
	try {
		await runtime.ready;
		const reminder = runtime.deliverModeratorReminder(async (commit) => {
			callbackStarted();
			await lateCallbackAllowed;
			try {
				await commit();
			} catch {
				lateCommitRejected = true;
			}
			callbackFinished();
			return "suppressed";
		});
		await callbackEntered;
		await runtime.abort();
		await assert.rejects(reminder);
		await releaseObserved;
		assert.equal(reserved, false);
		allowLateCallback();
		await callbackCompleted;
		assert.equal(lateCommitRejected, true);
		assert.equal(finishCommitCalls, 0, "an aborted callback cannot commit after release");
	} finally {
		allowLateCallback();
		await runtime.dispose();
	}
});

test("hosted child reminder transport rejection does not strand future admission", { timeout: 5000 }, async () => {
	const prepareError = new Error("prepare transport failed");
	{
		const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
		let prepareCalls = 0;
		let reserved = false;
		const admitted = {
			snapshot: fakeRuntimeSnapshot({ modelId: "reminder-prepare-fault", thinking: "off", toolExecutionModes: [] }),
			channel: {
				onClose: () => () => undefined,
				async request(method: string, payload: unknown) {
					if (method === "moderatorReminder.prepare") {
						prepareCalls++;
						if (prepareCalls === 1) throw prepareError;
						assert.equal(reserved, false);
						reserved = true;
						return { prepared: true };
					}
					if (method === "moderatorReminder.finish") {
						reserved = false;
						return { outcome: "suppressed" };
					}
					throw new Error("unexpected request: " + method);
				},
			},
		} as unknown as PiChildProcessRuntime;
		const runtime = new PiChildHostedRuntime(fakeLaunch(admitted, eventHandlers));
		try {
			await runtime.ready;
			await assert.rejects(runtime.deliverModeratorReminder(async () => "suppressed"), (error) => error === prepareError);
			assert.equal(await runtime.deliverModeratorReminder(async () => "suppressed"), "suppressed");
			assert.equal(reserved, false);
		} finally {
			await runtime.dispose();
		}
	}

	const finishError = new Error("finish transport failed");
	{
		const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
		let reserved = false;
		let finishCommitCalls = 0;
		const admitted = {
			snapshot: fakeRuntimeSnapshot({ modelId: "reminder-finish-fault", thinking: "off", toolExecutionModes: [] }),
			channel: {
				onClose: () => () => undefined,
				async request(method: string, payload: unknown) {
					if (method === "moderatorReminder.prepare") {
						assert.equal(reserved, false);
						reserved = true;
						return { prepared: true };
					}
					if (method === "moderatorReminder.finish") {
						const commit = (payload as { commit: boolean }).commit;
						if (commit && finishCommitCalls++ === 0) throw finishError;
						reserved = false;
						return { outcome: commit ? "committed" : "suppressed" };
					}
					throw new Error("unexpected request: " + method);
				},
			},
		} as unknown as PiChildProcessRuntime;
		const runtime = new PiChildHostedRuntime(fakeLaunch(admitted, eventHandlers));
		try {
			await runtime.ready;
			await assert.rejects(
				runtime.deliverModeratorReminder(async (commit) => commit()),
				(error) => error === finishError,
			);
			assert.equal(reserved, false, "a failed commit transport must release the reservation");
			assert.equal(await runtime.deliverModeratorReminder(async (commit) => commit()), "committed");
			assert.equal(reserved, false);
		} finally {
			await runtime.dispose();
		}
	}
});

test("hosted child reminder busy does not create speculative Run id", { timeout: 5000 }, async () => {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	let reserved = false;
	const admitted = {
		snapshot: fakeRuntimeSnapshot({ modelId: "reminder-no-run", thinking: "off", toolExecutionModes: [] }),
		channel: {
			onClose: () => () => undefined,
			async request(method: string, payload: unknown) {
				if (method === "moderatorReminder.prepare") {
					reserved = true;
					return { prepared: false };
				}
				if (method === "moderatorReminder.finish") {
					assert.equal((payload as { commit: boolean }).commit, false);
					reserved = false;
					return { outcome: "suppressed" };
				}
				throw new Error("unexpected request: " + method);
			},
		},
	} as unknown as PiChildProcessRuntime;
	const runtime = new PiChildHostedRuntime(fakeLaunch(admitted, eventHandlers));
	try {
		await runtime.ready;
		assert.equal(await runtime.deliverModeratorReminder(async () => "committed"), "busy");
		assert.equal(reserved, false);
		for (const handler of eventHandlers) {
			handler(controlEvent("agent.start", { runId: "native-after-busy", queuedInputCount: 0 }));
		}
		assert.equal(runtime.workState(), "active", "busy admission must not create a stale Run identity");
		for (const handler of eventHandlers) {
			handler(controlEvent("agent.settled", {
				runId: "native-after-busy",
				outcome: "completed",
				queuedInputCount: 0,
			}));
		}
		assert.equal(runtime.workState(), "settled");
	} finally {
		await runtime.dispose();
	}
});

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

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

async function createFailureHarness(name: "channel_loss" | "process_kill") {
	const root = await mkdtemp(join(tmpdir(), `pi-child-hosted-${name}-`));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = name === "channel_loss"
		? "019a6b4d-1b22-7000-8000-000000000202"
		: "019a6b4d-1b22-7000-8000-000000000203";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	const launch = await PiChildProcessRuntime.launch({
		workflowId: `hosted-${name}-workflow`,
		agentId: `hosted-${name}-agent`,
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
			systemPrompt: { mode: "append", body: `Hosted failure context for ${name}` },
			loadContextFiles: true,
		},
		skillPaths: [],
		projectTrusted: true,
		ownerEnvironment: {
			...process.env,
			PI_SKIP_VERSION_CHECK: "1",
			PROCESS_RUNTIME_RESPONSE_DELAY_MS: "5000",
		},
		runtimeDirectory: root,
		columns: 80,
		rows: 24,
		ownerRequestHandlers: ordinaryOwnerHandlers(`hosted-${name}-agent`),
	});
	const runtime = new PiChildHostedRuntime(launch);
	const host = AgentRuntimeSupervisor.createChild({
		agentId: expectedSessionId,
		startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	const handle = await host.lane.run(() => host.startInLane());
	const systemPromptArtifactPath = (await launch.ready()).snapshot.systemPrompt?.filePath;
	assert.ok(systemPromptArtifactPath);
	return { launch, host, handle, sessionPath, systemPromptArtifactPath };
}

async function waitUntil(condition: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for hosted Runtime state");
}

function fakeRuntimeSnapshot(options: Readonly<{
	modelId: string;
	thinking: "off" | "high";
	toolExecutionModes: readonly Readonly<{
		name: string;
		executionMode: "parallel" | "sequential";
	}>[];
}>): PiChildProcessRuntime["snapshot"] {
	return {
		cwd: "/runtime",
		model: { provider: "test", modelId: options.modelId },
		thinking: options.thinking,
		tools: options.toolExecutionModes.map(({ name }) => name),
		registeredTools: options.toolExecutionModes.map(({ name }) => name),
		skills: [],
		skillSources: [],
		extensions: [],
		toolExecutionModes: [...options.toolExecutionModes],
		projectTrusted: true,
		sessionId: "dynamic-runtime",
		sessionPath: "/sessions/dynamic-runtime.jsonl",
		systemPrompt: null,
		loadContextFiles: true,
	};
}

function fakeLaunch(
	admitted: PiChildProcessRuntime,
	eventHandlers: Set<(event: PiChildRuntimeEvent) => void>,
): PiChildProcessLaunch {
	return {
		exited: new Promise<never>(() => undefined),
		ready: async () => admitted,
		cancelInitialization: () => undefined,
		frame: () => ({
			columns: 80,
			rows: 24,
			lines: [],
			cursor: { row: 0, column: 0, visible: false, style: "block", blink: false },
		}),
		writeInput() {},
		resize() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler: () => () => undefined,
		onEvent(handler: (event: PiChildRuntimeEvent) => void) {
			eventHandlers.add(handler);
			return () => eventHandlers.delete(handler);
		},
		dispose: async () => undefined,
	} as unknown as PiChildProcessLaunch;
}

function controlEvent(
	event: PiChildRuntimeEvent["event"],
	payload: unknown,
): PiChildRuntimeEvent {
	return { event, payload } as PiChildRuntimeEvent;
}
