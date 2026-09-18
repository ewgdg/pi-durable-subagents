import assert from "node:assert/strict";
import test from "node:test";

import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedAgentRuntime } from "../src/runtime/hosted-agent-runtime.ts";

const snapshot = {
	cwd: "/runtime/project",
	model: { provider: "test", modelId: "model" },
	thinking: "off" as const,
	tools: [],
	skills: [],
	skillSources: [],
	fileExtensionPaths: [],
	projectTrusted: true,
	sessionId: "async-clear-runtime",
};

test("the common Runtime Host awaits remote queue clearing before aborting", async () => {
	const calls: string[] = [];
	let workState: "active" | "settled" = "active";
	const runtime = {
		projection: undefined,
		snapshot: () => snapshot,
		workState: () => workState,
		queuedInputCount: () => 1,
		cancellationSignal: () => new AbortController().signal,
		deliver: () => ({ completion: Promise.resolve() }),
		subscribe: () => () => undefined,
		async clearQueue() {
			calls.push("clear:start");
			await new Promise((resolve) => setImmediate(resolve));
			calls.push("clear:end");
			return { steering: ["queued direction"], followUp: [] };
		},
		async abort() {
			calls.push("abort");
			workState = "settled";
		},
		waitForIdle: async () => undefined,
		dispose: async () => undefined,
	} as unknown as HostedAgentRuntime;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "async-queue-test-agent",
		startSession: async () => ({ runtime }),
	});
	await host.lane.run(() => host.startInLane());

	assert.equal(await host.lane.run(() => host.interruptCurrentRunInLane()), "held");
	assert.deepEqual(calls, ["clear:start", "clear:end", "abort"]);
	assert.equal(host.queuedInputCount(), 2);
});
