import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

test("native model failure preserves provider error text and retry classification", () => {
	let emit!: (event: unknown) => void;
	const runtime = new InProcessHostedRuntime({
		session: { isCompacting: false, subscribe(handler: typeof emit) { emit = handler; return () => undefined; } } as unknown as AgentSession,
		projection: undefined,
		inspectSnapshot: () => { throw new Error("not used"); },
	});
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => events.push(event));
	for (const willRetry of [true, false]) {
		emit({ type: "agent_end", willRetry, messages: [{ role: "assistant", stopReason: "error", errorMessage: "original native provider failure" }] });
		assert.deepEqual(events.at(-1), {
			type: "agent_end", outcome: "error", willRetry,
			failure: { stage: "model", error: "original native provider failure", provenance: "in-process-hosted-runtime" },
		});
	}
});
