import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

test("native quota evidence distinguishes exhausted quota from temporary throttling", () => {
	let emit!: (event: unknown) => void;
	const runtime = new InProcessHostedRuntime({
		session: { subscribe(handler: typeof emit) { emit = handler; return () => undefined; } } as unknown as AgentSession,
		projection: undefined, inspectSnapshot: () => { throw new Error("not used"); },
	});
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe(event => events.push(event));
	for (const [diagnostic, exhausted] of [
		["Codex error: The usage limit has been reached", true],
		['{"error":{"code":"usage_limit_reached"}}', true],
		['{"error":{"type":"insufficient_quota"}}', true],
		['429: {"code":"insufficient_quota"}', true],
		['429: {"code":"rate_limit_exceeded"}', false],
		['{"error":{"code":"rate_limit_exceeded","message":"Codex error: The usage limit has been reached"}}', false],
		["429 Too Many Requests", false], ["context limit exceeded", false], ["unrelated failure", false],
	] as const) {
		for (const willRetry of [true, false]) {
			emit({ type: "agent_end", willRetry, messages: [{ role: "assistant", stopReason: "error", provider: "openai-codex", model: "gpt-5", errorMessage: diagnostic }] });
			const event = events.at(-1)!;
			assert.equal(event.type, "agent_end");
			if (event.type !== "agent_end") throw new Error("missing end");
			assert.equal(event.willRetry, willRetry);
			assert.deepEqual(event.quota, exhausted ? { diagnostic, provider: "openai-codex", model: "gpt-5" } : undefined);
		}
	}
});

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

test("native quota evidence never invents identity or reset time or classifies cancellation", () => {
	let emit!: (event: unknown) => void;
	const runtime = new InProcessHostedRuntime({
		session: { subscribe(handler: typeof emit) { emit = handler; return () => undefined; } } as unknown as AgentSession,
		projection: undefined, inspectSnapshot: () => { throw new Error("not used"); },
	});
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe(event => events.push(event));
	for (const [assistant, expected] of [
		[{ errorMessage: '{"error":{"code":"usage_limit_reached","resets_at":"soon"}}' }, { diagnostic: '{"error":{"code":"usage_limit_reached","resets_at":"soon"}}' }],
		[{ errorMessage: "Codex error: The usage limit has been reached", provider: "unrelated-provider" }, undefined],
		[{ errorMessage: "You have hit your ChatGPT usage limit. Try again in ~5 min." }, undefined],
		[{ errorMessage: "Codex error: The usage limit has been reached", stopReason: "aborted" }, undefined],
	] as const) {
		emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", ...assistant }] });
		const event = events.at(-1)!;
		if (event.type !== "agent_end") throw new Error("missing end");
		assert.deepEqual(event.quota, expected);
	}
});
