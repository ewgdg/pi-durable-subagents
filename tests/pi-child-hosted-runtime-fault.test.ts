import assert from "node:assert/strict";
import test from "node:test";

import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import type {
	PiChildProcessLaunch,
	PiChildProcessRuntime,
	PiChildRuntimeEvent,
} from "../src/process-runtime/pi-child-process-runtime.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

test("child Control preserves normalized quota evidence without changing retry semantics", async () => {
	for (const willRetry of [true, false]) {
		const { runtime, emit } = createFakeRuntime();
		const events: HostedRuntimeEvent[] = [];
		runtime.subscribe(event => events.push(event));
		await runtime.ready;
		const quota = { diagnostic: "Codex error: The usage limit has been reached", provider: "openai-codex", model: "gpt-5", resetAt: "2030-01-01T00:00:00.000Z" };
		emit(controlEvent("agent.start", { runId: "quota", queuedInputCount: 0 }));
		emit(controlEvent("agent.end", { runId: "quota", outcome: "failed", willRetry, queuedInputCount: 0, error: quota.diagnostic, quota }));
		const event = events.find(event => event.type === "agent_end");
		assert.equal(event?.type, "agent_end");
		if (event?.type !== "agent_end") throw new Error("missing end");
		assert.deepEqual(event.quota, quota);
		assert.equal(event.willRetry, willRetry);
		await runtime.dispose();
	}
});

test("an authenticated native child lifecycle adopts its transport identity without a dispatched cycle", async () => {
	const { runtime, emit } = createFakeRuntime();
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	await runtime.ready;

	emit(controlEvent("agent.start", {
		runId: "native-run-1",
		queuedInputCount: 0,
	}));
	assert.equal(runtime.workState(), "active");
	emit(controlEvent("agent.end", {
		runId: "native-run-1",
		outcome: "completed",
		willRetry: false,
		queuedInputCount: 0,
	}));
	emit(controlEvent("agent.settled", {
		runId: "native-run-1",
		outcome: "completed",
		queuedInputCount: 0,
	}));

	assert.equal(runtime.workState(), "settled");
	assert.deepEqual(hostedEvents, [
		{ type: "state_changed" },
		{ type: "agent_end", outcome: "completed", willRetry: false },
		{ type: "state_changed" },
		{ type: "agent_settled" },
	]);
	await runtime.dispose();
});

test("child model errors preserve the original provider text", async () => {
	const { runtime, emit } = createFakeRuntime();
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => events.push(event));
	await runtime.ready;
	emit(controlEvent("agent.start", { runId: "model-failure", queuedInputCount: 0 }));
	emit(controlEvent("agent.end", {
		runId: "model-failure", outcome: "failed", willRetry: false, queuedInputCount: 0,
		error: "provider rejected model identifier",
	}));
	assert.deepEqual(events.find((event) => event.type === "agent_end"), {
		type: "agent_end", outcome: "error", willRetry: false,
		failure: { stage: "model", error: "provider rejected model identifier", provenance: "pi-child-hosted-runtime" },
	});
	await runtime.dispose();
});

test("a post-admission child Runtime fault terminally fences its hosted Run once", async () => {
	const { runtime, emit } = createFakeRuntime();
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	await runtime.ready;
	const completion = runtime.deliver({ kind: "user", content: "Start the Run." }).completion;
	emit(controlEvent("agent.start", {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	}));
	emit(controlEvent("runtime.fault", {
		code: "participant_lifecycle_failed",
		message: "Owner rejected the awaited boundary",
	}));

	assert.equal(runtime.workState(), "unavailable");
	assert.equal(runtime.cancellationSignal().aborted, true);
	await assert.rejects(completion, /participant_lifecycle_failed.*Owner rejected/);
	assert.deepEqual(hostedEvents.slice(-3), [
		{ type: "agent_end", outcome: "error", willRetry: false, failure: {
			stage: "runtime", provenance: "pi-child-hosted-runtime",
			error: "child_runtime_fault: participant_lifecycle_failed: Owner rejected the awaited boundary",
		} },
		{ type: "state_changed" },
		{ type: "agent_settled" },
	]);

	emit(controlEvent("runtime.fault", {
		code: "duplicate_fault",
		message: "must not settle twice",
	}));
	assert.equal(
		hostedEvents.filter((event) => event.type === "agent_settled").length,
		1,
	);
	await runtime.dispose();
});

test("child exit after Run admission but before model activity preserves failure", async () => {
	const { runtime, settleExit } = createFakeRuntime();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "idle-admitted-child", startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	await host.lane.run(() => host.startInLane());
	settleExit({ exitCode: 1, signal: 0 });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(host.currentRunFailed(), true);
	await host.lane.run(() => host.discardAndEndInLane("failure"));
});

test("child exit fences the hosted Run before its projection reports failure", async () => {
	const { runtime, settleExit } = createFakeRuntime();
	const ordering: string[] = [];
	runtime.subscribe((event) => {
		if (event.type === "agent_end") ordering.push("runtime fenced");
	});
	runtime.projection.addFailureHandler(() => ordering.push("projection failed"));
	await runtime.ready;
	const completion = runtime.deliver({ kind: "user", content: "Observe exit order." }).completion;
	void completion.catch(() => undefined);

	settleExit({ exitCode: 1, signal: 0 });
	await assert.rejects(completion, /child_runtime_unexpected_exit/);
	assert.deepEqual(ordering.slice(0, 2), ["runtime fenced", "projection failed"]);
	await runtime.dispose();
});

test("failed process Runtime cleanup does not repeat intentions over dead Control", async () => {
	const { runtime, emit, requestedMethods } = createFakeRuntime();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "failed-process-runtime",
		startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	await host.lane.run(() => host.startInLane());
	const delivery = host.deliverInLane({ kind: "user", content: "Fail this Run." });
	emit(controlEvent("agent.start", {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	}));
	emit(controlEvent("runtime.fault", {
		code: "dead_control",
		message: "Control is already unavailable",
	}));
	await assert.rejects(delivery.completion, /dead_control/);

	await host.lane.run(() => host.discardAndEndInLane("failure"));
	assert.equal(host.observe().phase, "dormant");
	assert.deepEqual(requestedMethods, ["message.deliver"]);
});

test("cleanup does not duplicate a Runtime fault that wins an in-flight intention", async () => {
	const harness = createFakeRuntime({ holdQueueClear: true });
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "failing-cleanup-runtime",
		startSession: async () => ({ runtime: harness.runtime, ready: harness.runtime.ready }),
	});
	await host.lane.run(() => host.startInLane());
	const delivery = host.deliverInLane({ kind: "user", content: "Race cleanup with failure." });
	void delivery.completion.catch(() => undefined);
	harness.emit(controlEvent("agent.start", {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	}));

	const cleanup = host.lane.run(() => host.discardAndEndInLane("shutdown"));
	await harness.queueClearStarted;
	harness.emit(controlEvent("runtime.fault", {
		code: "control_lost_during_cleanup",
		message: "The Runtime fault owns this terminal transition",
	}));
	harness.rejectQueueClear(new Error("control_channel_closed: channel closed"));

	await cleanup;
	assert.equal(host.observe().phase, "dormant");
	assert.deepEqual(harness.requestedMethods, ["message.deliver", "queue.clear"]);
});

test("a stale child lifecycle event terminally fences the exact hosted Run once", async () => {
	const { runtime, emit } = createFakeRuntime();
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	await runtime.ready;
	const completion = runtime.deliver({ kind: "user", content: "Start the exact Run." }).completion;
	emit(controlEvent("agent.start", {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	}));
	emit(controlEvent("agent.end", {
		runId: "stale-hosted-run",
		outcome: "completed",
		willRetry: false,
		queuedInputCount: 0,
	}));

	assert.equal(runtime.workState(), "unavailable");
	await assert.rejects(completion, /stale_run.*stale-hosted-run.*hosted-run-1/);
	assert.equal(
		hostedEvents.filter((event) => event.type === "agent_settled").length,
		1,
	);
	await runtime.dispose();
});

function createFakeRuntime(options: Readonly<{
	holdQueueClear?: boolean;
}> = {}): Readonly<{
	runtime: PiChildHostedRuntime;
	requestedMethods: string[];
	requestedDeliveryIds: string[];
	queueClearStarted: Promise<void>;
	rejectQueueClear(error: unknown): void;
	emit(event: PiChildRuntimeEvent): void;
	settleExit(exit: Readonly<{ exitCode: number; signal: number }>): void;
}> {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	const requestedMethods: string[] = [];
	const requestedDeliveryIds: string[] = [];
	let settleExit!: (exit: Readonly<{ exitCode: number; signal: number }>) => void;
	const exited = new Promise<Readonly<{ exitCode: number; signal: number }>>((resolve) => {
		settleExit = resolve;
	});
	let markQueueClearStarted!: () => void;
	const queueClearStarted = new Promise<void>((resolve) => {
		markQueueClearStarted = resolve;
	});
	let rejectQueueClear!: (error: unknown) => void;
	const queueClear = new Promise<never>((_resolve, reject) => {
		rejectQueueClear = reject;
	});
	void queueClear.catch(() => undefined);
	const admitted = {
		snapshot: {
			cwd: "/runtime",
			model: { provider: "test", modelId: "model" },
			thinking: "off",
			tools: [],
			skills: [],
			skillSources: [],
			extensions: [],
			toolExecutionModes: [],
			projectTrusted: true,
			sessionId: "fault-runtime",
			sessionPath: "/sessions/fault-runtime.jsonl",
			systemPrompt: null,
			loadContextFiles: true,
		},
		channel: {
			onClose: () => () => undefined,
			async request(method: string, payload: { deliveryId?: string }) {
				requestedMethods.push(method);
				if (method === "message.deliver") requestedDeliveryIds.push(payload.deliveryId!);
				if (method === "queue.clear" && options.holdQueueClear) {
					markQueueClearStarted();
					return await queueClear;
				}
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
		exited,
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
	return {
		runtime: new PiChildHostedRuntime(launch),
		requestedMethods,
		requestedDeliveryIds,
		queueClearStarted,
		rejectQueueClear,
		emit(event) {
			for (const handler of eventHandlers) handler(event);
		},
		settleExit,
	};
}

function controlEvent(
	event: PiChildRuntimeEvent["event"],
	payload: unknown,
): PiChildRuntimeEvent {
	return { event, payload } as PiChildRuntimeEvent;
}

test("compaction is observable, refreshes on both edges, and clears on disposal and fault", async () => {
 for (const terminal of ["complete", "dispose", "fault"] as const) {
  const { runtime, emit } = createFakeRuntime();
  await runtime.ready;
  const states: boolean[] = [];
  runtime.subscribe(event => { if (event.type === "state_changed") states.push(runtime.isCompacting()); });
  emit(controlEvent("runtime.compaction.started", {}));
  assert.equal(runtime.isCompacting(), true);
  assert.equal(runtime.workState(), "settled");
  if (terminal === "complete") emit(controlEvent("runtime.compaction.completed", {}));
  if (terminal === "fault") emit(controlEvent("runtime.fault", { code: "failed", message: "failed" }));
  if (terminal === "dispose") await runtime.dispose();
  assert.equal(runtime.isCompacting(), false);
  assert.deepEqual(states, [true, false]);
  await runtime.dispose();
 }
});

test("host presentation observes compaction changes without changing Run state and clears on termination", async () => {
 const { runtime, emit } = createFakeRuntime();
 const host = AgentRuntimeSupervisor.createChild({
  agentId: "compaction-presentation",
  startSession: async () => ({ runtime, ready: runtime.ready }),
 });
 await host.lane.run(() => host.startInLane());
 const before = host.observe();
 const states: boolean[] = [];
 host.addStateChangeHandler(() => states.push(host.isCompacting()));
 emit(controlEvent("runtime.compaction.started", {}));
 assert.equal(host.isCompacting(), true);
 assert.deepEqual(host.observe(), before);
 emit(controlEvent("runtime.compaction.completed", {}));
 assert.equal(host.isCompacting(), false);
 assert.deepEqual(host.observe(), before);
 assert.deepEqual(states, [true, false]);
 emit(controlEvent("runtime.compaction.started", {}));
 await host.lane.run(() => host.discardAndEndInLane("shutdown"));
 assert.equal(host.isCompacting(), false);
 assert.equal(host.observe().phase, "dormant");
});

for (const dispatchFinishesFirst of [true, false]) {
	test(`Delivery completion follows its child-correlated completion independently of lifecycle ordering: dispatch first=${dispatchFinishesFirst}`, { timeout: 5_000 }, async () => {
		const { runtime, emit, requestedDeliveryIds } = createFakeRuntime();
		await runtime.ready;
		emit(controlEvent("agent.start", { runId: "native-run-1", queuedInputCount: 0 }));
		const first = runtime.deliver({ kind: "user", content: "First queued input.", deliverAs: "steer" });
		const second = runtime.deliver({ kind: "user", content: "Second queued input.", deliverAs: "steer" });
		let firstCompleted = false;
		let secondCompleted = false;
		void first.completion.then(() => { firstCompleted = true; });
		void second.completion.then(() => { secondCompleted = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const settle = () => emit(controlEvent("agent.settled", {
			runId: "native-run-1", queuedInputCount: 0, outcome: "completed",
		}));
		const dispatch = () => emit(controlEvent("message.dispatch.completed", { deliveryId: requestedDeliveryIds[0] }));
		if (dispatchFinishesFirst) dispatch(); else settle();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(firstCompleted, dispatchFinishesFirst);
		assert.equal(secondCompleted, false);
		if (dispatchFinishesFirst) settle(); else dispatch();
		await first.completion;
		assert.equal(secondCompleted, false, "one dispatch completion cannot resolve another Delivery");
		emit(controlEvent("message.dispatch.completed", { deliveryId: requestedDeliveryIds[1] }));
		await second.completion;
		await runtime.dispose();
	});
}

test("correlated dispatch rejection completes Delivery failure without inventing lifecycle", { timeout: 5_000 }, async () => {
	const { runtime, emit, requestedDeliveryIds } = createFakeRuntime();
	await runtime.ready;
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => events.push(event));
	const delivery = runtime.deliver({ kind: "user", content: "Dispatch rejected." });
	const rejected = assert.rejects(delivery.completion, /dispatch rejected/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	emit(controlEvent("message.dispatch.completed", { deliveryId: requestedDeliveryIds[0], error: "dispatch rejected" }));
	await rejected;
	assert.deepEqual(events, []);
	await runtime.dispose();
});


test("orderly disposal drains supervisor dispatch tracking without lifecycle", { timeout: 5_000 }, async () => {
	const { runtime, emit, settleExit } = createFakeRuntime();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "disposed-dispatch",
		startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	await host.lane.run(() => host.startInLane());
	const delivery = host.deliverInLane({ kind: "user", content: "Await actual dispatch." });
	const rejected = assert.rejects(delivery.completion, /child_runtime_disposed/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	emit(controlEvent("agent.start", { runId: "hosted-run-1", queuedInputCount: 0 }));
	emit(controlEvent("agent.settled", {
		runId: "hosted-run-1", queuedInputCount: 0, outcome: "completed",
	}));
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => events.push(event));
	await runtime.dispose();
	settleExit({ exitCode: 0, signal: 0 });
	// Real supervisor cleanup joins tracked operations, not just the adapter Promise.
	await host.lane.run(() => host.discardAndEndInLane("shutdown"));
	await rejected;
	assert.equal(host.observe().phase, "dormant");
	assert.deepEqual(events, [], "orderly disposal must not invent terminal lifecycle");
});
