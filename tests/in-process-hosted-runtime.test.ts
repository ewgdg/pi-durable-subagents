import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

const snapshot = {
	cwd: "/runtime/project",
	model: { provider: "test", modelId: "model" },
	thinking: "high" as const,
	tools: ["read"],
	skills: ["skill"],
	skillSources: [{ name: "skill", filePath: "/runtime/skill/SKILL.md" }],
	fileExtensionPaths: ["/runtime/extension.ts"],
	projectTrusted: true,
	sessionId: "runtime-session",
};

test("InProcessHostedRuntime translates Pi lifecycle and owns Pi intentions", async () => {
	const listeners = new Set<(event: unknown) => void>();
	const cancellation = new AbortController();
	const calls: string[] = [];
	const session = {
		isIdle: true,
		pendingMessageCount: 2,
		agent: { signal: cancellation.signal },
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		clearQueue() {
			calls.push("clear");
			return { steering: ["steer"], followUp: ["follow-up"] };
		},
		async abort() {
			calls.push("abort");
		},
		async waitForIdle() {
			calls.push("wait");
		},
		dispose() {
			calls.push("dispose");
		},
		sendUserMessage: async () => undefined,
		sendCustomMessage: async () => undefined,
	} as unknown as AgentSession;
	const projection = {
		sessionId: snapshot.sessionId,
		presentation: { render: () => [], invalidate() {} },
		physicalTerminal: {
			async beginAttachment() { return () => undefined; },
			async endAttachment() {},
			pauseOutput() {},
			resumeOutput() {},
		},
		resize() {},
		dispatchInput() {},
		focusEditor() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler: () => () => undefined,
		addExitRequestHandler: () => () => undefined,
		isProcessingInput: () => false,
		fenceInputSubmissions() {},
		inputSubmissionIsFenced: () => false,
		whenInputIdle: async () => undefined,
		ready: async () => undefined,
		cancelInitialization: () => undefined,
		dispose: async () => undefined,
	};
	const runtime = new InProcessHostedRuntime({
		session,
		projection,
		inspectSnapshot: () => snapshot,
	});
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => events.push(event));

	for (const listener of listeners) {
		listener({ type: "agent_start" });
		listener({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "error" }],
			willRetry: false,
		});
		listener({ type: "agent_settled" });
	}

	assert.deepEqual(events, [
		{ type: "state_changed" },
		{ type: "agent_end", outcome: "error", willRetry: false },
		{ type: "agent_settled" },
	]);
	assert.deepEqual(runtime.snapshot(), snapshot);
	assert.equal(runtime.workState(), "settled");
	assert.equal(runtime.queuedInputCount(), 2);
	assert.equal(runtime.cancellationSignal(), cancellation.signal);
	assert.deepEqual(await runtime.clearQueue(), {
		steering: ["steer"],
		followUp: ["follow-up"],
	});
	await runtime.abort();
	await runtime.waitForIdle();
	await runtime.dispose();
	assert.deepEqual(calls, ["clear", "abort", "wait", "dispose"]);
});

test("compaction end clears presentation before Pi releases its native controller", () => {
 let nativeCompacting = false;
 let emit!: (event: unknown) => void;
 const session = {
  get isCompacting() { return nativeCompacting; },
  subscribe(listener: (event: unknown) => void) { emit = listener; return () => undefined; },
 } as unknown as AgentSession;
 const runtime = new InProcessHostedRuntime({ session, projection: undefined, inspectSnapshot: () => snapshot });
 const states: boolean[] = [];
 runtime.subscribe(event => { if (event.type === "state_changed") states.push(runtime.isCompacting()); });
 for (const outcome of [{ aborted: false }, { aborted: true }, { aborted: false, errorMessage: "failed" }]) {
  nativeCompacting = true;
  emit({ type: "compaction_start", reason: "threshold" });
  assert.equal(runtime.isCompacting(), true);
  emit({ type: "compaction_end", reason: "threshold", ...outcome });
  assert.equal(runtime.isCompacting(), false);
  nativeCompacting = false;
 }
 assert.deepEqual(states, [true, false, true, false, true, false]);
});
