import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedAgentRuntime } from "../src/runtime/hosted-agent-runtime.ts";

/**
 * A native turn whose settlement waits for its safe boundary to return, as Pi's
 * agent_before_settle hook does: abort and idle waits resolve only after it.
 */
async function startHostAwaitingSafeBoundary() {
	let settle!: () => void;
	const settled = new Promise<void>((resolve) => { settle = resolve; });
	const runtime = {
		projection: undefined,
		subscribe: () => () => undefined,
		workState: () => "settled",
		hasPendingActivity: () => false,
		queuedInputCount: () => 0,
		clearQueue: async () => ({ steering: [], followUp: [] }),
		abort: () => settled,
		waitForIdle: () => settled,
		dispose: async () => undefined,
	} as unknown as HostedAgentRuntime;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "safe-boundary", startSession: async () => ({ runtime }),
	});
	await host.lane.run(() => host.startInLane());
	return { host, settle };
}

for (const stop of ["abort", "interrupt"] as const) {
	test(`a safe boundary queued behind a lane-holding ${stop} returns so the turn can settle`, {
		timeout: 2_000,
	}, async () => {
		const { host, settle } = await startHostAwaitingSafeBoundary();
		let releaseLane!: () => void;
		const laneGate = new Promise<void>((resolve) => { releaseLane = resolve; });
		void host.lane.run(() => laneGate);
		const stopped = host.lane.run(async () => {
			if (stop === "abort") await host.discardAndEndInLane("abort");
			else await host.interruptCurrentRunInLane();
		});
		// The turn ends while the stop is still queued, so the boundary sees a live
		// Run and queues behind the stop, which then holds the lane until settlement.
		let boundaryWorkRan = false;
		void host.runAtSafeBoundary(() => { boundaryWorkRan = true; }).then(settle);
		releaseLane();
		await stopped;
		await host.lane.run(() => undefined);
		assert.equal(boundaryWorkRan, false, "a stopped Run's boundary work must not run after the stop");
	});
}

test("a safe boundary of a live Run runs its work in the Agent lane", { timeout: 2_000 }, async () => {
	const { host } = await startHostAwaitingSafeBoundary();
	let releaseLane!: () => void;
	const order: string[] = [];
	const laneGate = new Promise<void>((resolve) => { releaseLane = resolve; });
	void host.lane.run(async () => {
		await laneGate;
		order.push("earlier lane work");
	});
	const boundary = host.runAtSafeBoundary(() => { order.push("boundary"); });
	releaseLane();
	await boundary;
	assert.deepEqual(order, ["earlier lane work", "boundary"]);
});
