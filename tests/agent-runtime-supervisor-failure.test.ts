import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedAgentRuntime, HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

test("startup failure before runtime binding ends the exact admitted Run with original error", async () => {
	const original = new Error("model missing before child transcript exists");
	let startingHandle: unknown;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "startup-failure",
		startSession: async () => {
			startingHandle = host.currentHandle();
			throw original;
		},
	});
	const ended: unknown[][] = [];
	host.addEndedHandler((...args) => ended.push(args));
	await assert.rejects(host.lane.run(() => host.startInLane()), (error) => error === original);
	assert.ok(startingHandle);
	assert.deepEqual(ended, [[startingHandle, "failure", {
		stage: "startup", error: original.message, provenance: "agent-runtime-supervisor",
	}]]);
	assert.equal(host.currentHandle(), undefined);
});

test("passive preparation failure does not invent an admitted Run", async () => {
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "preparation-failure",
		startSession: async () => { throw new Error("preparation failed"); },
	});
	let ended = 0;
	host.addEndedHandler(() => { ended += 1; });
	await assert.rejects(host.lane.run(() => host.prepareInLane()), /preparation failed/);
	assert.equal(ended, 0);
});

for (const willRetry of [false, true]) test(`terminal metadata excludes retry=${willRetry}`, async () => {
	let emit!: (event: HostedRuntimeEvent) => void;
	const runtime = {
		projection: undefined,
		subscribe(handler: typeof emit) { emit = handler; return () => undefined; },
		workState: () => "settled",
		clearQueue: async () => ({ steering: [], followUp: [] }),
		abort: async () => undefined,
		waitForIdle: async () => undefined,
		dispose: async () => undefined,
	} as unknown as HostedAgentRuntime;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "terminal-metadata", startSession: async () => ({ runtime }),
	});
	const handle = await host.lane.run(() => host.startInLane());
	const failure = { stage: "model", error: "original provider failure", provenance: "test" };
	const ended: unknown[][] = [];
	host.addEndedHandler((...args) => ended.push(args));
	emit({ type: "agent_end", outcome: "error", willRetry, failure });
	assert.equal(host.currentRunFailed(), !willRetry);
	await host.lane.run(() => host.discardAndEndInLane(willRetry ? "termination" : "failure"));
	assert.deepEqual(ended, [[handle, willRetry ? "termination" : "failure", willRetry ? undefined : failure]]);
});
