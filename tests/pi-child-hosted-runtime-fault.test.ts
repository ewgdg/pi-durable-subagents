import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";
import { createChildControlLoopback } from "./support/child-control-loopback.ts";
import { createScriptedChildControlLink, createScriptedTerminalProjection } from "./support/scripted-child-control-link.ts";

test("an authenticated native child lifecycle adopts its transport identity without a dispatched cycle", { timeout: 5_000 }, async (t) => {
	const loopback = await createChildControlLoopback(t);
	const runtime = loopback.proxy;
	loopback.host.model.setResponses([fauxAssistantMessage("Native work done.")]);
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	const settled = new Promise<void>((resolve) => runtime.subscribe((event) => { if (event.type === "agent_settled") resolve(); }));

	await loopback.submitNativeInput("Native work.");
	await settled;

	assert.equal(runtime.workState(), "settled");
	assert.deepEqual(hostedEvents.filter((event) => event.type !== "state_changed"), [
		{ type: "agent_end", outcome: "completed", willRetry: false },
		{ type: "agent_settled" },
	]);
	assert.deepEqual(loopback.events.flatMap((event) => event.event.startsWith("agent.") ? [event.event] : []), [
		"agent.start", "agent.end", "agent.settled",
	]);
});

test("a post-admission child Runtime fault terminally fences its hosted Run once", { timeout: 5_000 }, async (t) => {
	const { loopback, held } = await createHeldDeliveryLoopback(t);
	const runtime = loopback.proxy;
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	const completion = runtime.deliver({ kind: "user", content: "Start the Run." }).completion;
	await held;
	await loopback.emitFault("participant_lifecycle_failed", "Owner rejected the awaited boundary");

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

	await loopback.emitFault("duplicate_fault", "must not settle twice");
	assert.equal(
		hostedEvents.filter((event) => event.type === "agent_settled").length,
		1,
	);
});

test("child exit after Run admission but before model activity preserves failure", { timeout: 5_000 }, async (t) => {
	const loopback = await createChildControlLoopback(t);
	const runtime = loopback.proxy;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "idle-admitted-child", startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	await host.lane.run(() => host.startInLane());
	await loopback.exit({ exitCode: 1, signal: 0 });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(host.currentRunFailed(), true);
	await host.lane.run(() => host.discardAndEndInLane("failure"));
});

/** A loopback child whose first model call holds until its Run is aborted. */
async function createHeldDeliveryLoopback(t: Parameters<typeof createChildControlLoopback>[0]) {
	let markHeld!: () => void;
	const held = new Promise<void>((resolve) => { markHeld = resolve; });
	const loopback = await createChildControlLoopback(t);
	loopback.host.model.setResponses([async () => {
		const signal = loopback.host.session.agent.signal;
		markHeld();
		await new Promise<void>((resolve) => {
			if (signal?.aborted) resolve();
			signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return fauxAssistantMessage("Aborted.");
	}]);
	return { loopback, held };
}

// The cases below stay on the scripted link: they cover projection and process
// cleanup ordering, or inject event orderings a real child cannot produce on demand.
test("child exit fences the hosted Run before its projection reports failure", async () => {
	const { runtime, settleExit } = createFakeRuntime({ projection: true });
	const ordering: string[] = [];
	runtime.subscribe((event) => {
		if (event.type === "agent_end") ordering.push("runtime fenced");
	});
	assert.ok(runtime.projection);
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
	emit({ event: "agent.start", payload: {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	} });
	emit({ event: "runtime.fault", payload: {
		code: "dead_control",
		message: "Control is already unavailable",
	} });
	await assert.rejects(delivery.completion, /dead_control/);

	await host.lane.run(() => host.discardAndEndInLane("failure"));
	assert.equal(host.observe().phase, "dormant");
	assert.deepEqual(requestedMethods(), ["message.deliver"]);
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
	harness.emit({ event: "agent.start", payload: {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	} });

	const cleanup = host.lane.run(() => host.discardAndEndInLane("shutdown"));
	await harness.queueClearStarted;
	harness.emit({ event: "runtime.fault", payload: {
		code: "control_lost_during_cleanup",
		message: "The Runtime fault owns this terminal transition",
	} });
	harness.rejectQueueClear(new Error("control_channel_closed: channel closed"));

	await cleanup;
	assert.equal(host.observe().phase, "dormant");
	assert.deepEqual(harness.requestedMethods(), ["message.deliver", "queue.clear"]);
});

test("a stale child lifecycle event terminally fences the exact hosted Run once", async () => {
	const { runtime, emit } = createFakeRuntime();
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	await runtime.ready;
	const completion = runtime.deliver({ kind: "user", content: "Start the exact Run." }).completion;
	emit({ event: "agent.start", payload: {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	} });
	emit({ event: "agent.end", payload: {
		runId: "stale-hosted-run",
		outcome: "completed",
		willRetry: false,
		queuedInputCount: 0,
	} });

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
	projection?: boolean;
}> = {}) {
	const requestedDeliveryIds: string[] = [];
	let markQueueClearStarted!: () => void;
	const queueClearStarted = new Promise<void>((resolve) => {
		markQueueClearStarted = resolve;
	});
	let rejectQueueClear!: (error: unknown) => void;
	const queueClear = new Promise<never>((_resolve, reject) => {
		rejectQueueClear = reject;
	});
	void queueClear.catch(() => undefined);
	const scripted = createScriptedChildControlLink({
		snapshot: { sessionId: "fault-runtime" },
		respond: {
			"message.deliver": ({ deliveryId }) => {
				requestedDeliveryIds.push(deliveryId);
				return { accepted: true, transcriptCommitted: true, modelCycleStarted: true, queuedInputCount: 0 };
			},
			"queue.clear": async () => {
				if (!options.holdQueueClear) return { steering: [], followUp: [], queuedInputCount: 0 };
				markQueueClearStarted();
				return await queueClear;
			},
			"run.interrupt": () => ({ accepted: true }),
			"message.cancel": () => ({ accepted: true }),
		},
	});
	return {
		runtime: new PiChildHostedRuntime({
			link: scripted.link,
			...(options.projection ? { createProjection: () => createScriptedTerminalProjection(scripted.link) } : {}),
		}),
		requestedMethods: () => scripted.requests.map(({ method }) => method),
		requestedDeliveryIds,
		queueClearStarted,
		rejectQueueClear,
		emit: scripted.emit,
		settleExit: scripted.exit,
	};
}

test("compaction is observable, refreshes on both edges, and clears on disposal and fault", async () => {
 for (const terminal of ["complete", "dispose", "fault"] as const) {
  const { runtime, emit } = createFakeRuntime();
  await runtime.ready;
  const states: boolean[] = [];
  runtime.subscribe(event => { if (event.type === "state_changed") states.push(runtime.isCompacting()); });
  emit({ event: "runtime.compaction.started", payload: {} });
  assert.equal(runtime.isCompacting(), true);
  assert.equal(runtime.workState(), "settled");
  if (terminal === "complete") emit({ event: "runtime.compaction.completed", payload: {} });
  if (terminal === "fault") emit({ event: "runtime.fault", payload: { code: "failed", message: "failed" } });
  if (terminal === "dispose") await runtime.dispose();
  assert.equal(runtime.isCompacting(), false);
  assert.deepEqual(states, [true, false]);
  await runtime.dispose();
 }
});

test("host presentation observes compaction changes without changing Run state and clears on abort", async () => {
 const { runtime, emit } = createFakeRuntime();
 const host = AgentRuntimeSupervisor.createChild({
  agentId: "compaction-presentation",
  startSession: async () => ({ runtime, ready: runtime.ready }),
 });
 await host.lane.run(() => host.startInLane());
 const before = host.observe();
 const states: boolean[] = [];
 host.addStateChangeHandler(() => states.push(host.isCompacting()));
 emit({ event: "runtime.compaction.started", payload: {} });
 assert.equal(host.isCompacting(), true);
 assert.deepEqual(host.observe(), before);
 emit({ event: "runtime.compaction.completed", payload: {} });
 assert.equal(host.isCompacting(), false);
 assert.deepEqual(host.observe(), before);
 assert.deepEqual(states, [true, false]);
 emit({ event: "runtime.compaction.started", payload: {} });
 await host.lane.run(() => host.discardAndEndInLane("shutdown"));
 assert.equal(host.isCompacting(), false);
 assert.equal(host.observe().phase, "dormant");
});

for (const dispatchFinishesFirst of [true, false]) {
	test(`Delivery completion follows its child-correlated completion independently of lifecycle ordering: dispatch first=${dispatchFinishesFirst}`, { timeout: 5_000 }, async () => {
		const { runtime, emit, requestedDeliveryIds } = createFakeRuntime();
		await runtime.ready;
		emit({ event: "agent.start", payload: { runId: "native-run-1", queuedInputCount: 0 } });
		const first = runtime.deliver({ kind: "user", content: "First queued input.", deliverAs: "steer" });
		const second = runtime.deliver({ kind: "user", content: "Second queued input.", deliverAs: "steer" });
		let firstCompleted = false;
		let secondCompleted = false;
		void first.completion.then(() => { firstCompleted = true; });
		void second.completion.then(() => { secondCompleted = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const settle = () => emit({ event: "agent.settled", payload: {
			runId: "native-run-1", queuedInputCount: 0,
		} });
		const dispatch = () => emit({ event: "message.dispatch.completed", payload: { deliveryId: requestedDeliveryIds[0] } });
		if (dispatchFinishesFirst) dispatch(); else settle();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(firstCompleted, dispatchFinishesFirst);
		assert.equal(secondCompleted, false);
		if (dispatchFinishesFirst) settle(); else dispatch();
		await first.completion;
		assert.equal(secondCompleted, false, "one dispatch completion cannot resolve another Delivery");
		emit({ event: "message.dispatch.completed", payload: { deliveryId: requestedDeliveryIds[1] } });
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
	emit({ event: "message.dispatch.completed", payload: { deliveryId: requestedDeliveryIds[0], error: "dispatch rejected" } });
	await rejected;
	assert.deepEqual(events, []);
	await runtime.dispose();
});

// A settled Run whose delivery completion is still pending needs scripted timing.
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
	emit({ event: "agent.start", payload: { runId: "hosted-run-1", queuedInputCount: 0 } });
	emit({ event: "agent.settled", payload: {
		runId: "hosted-run-1", queuedInputCount: 0,
	} });
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
