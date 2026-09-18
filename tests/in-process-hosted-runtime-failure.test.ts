import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

test("terminal native quota fences queued text before publishing and returns it once", async () => {
	let emit!: (event: unknown) => void;
	let queue = { steering: ["steer later"], followUp: ["follow later"] };
	const runtime = new InProcessHostedRuntime({
		session: {
			subscribe(handler: typeof emit) { emit = handler; return () => undefined; },
			clearQueue() { const captured = queue; queue = { steering: [], followUp: [] }; return captured; },
		} as unknown as AgentSession,
		projection: undefined, inspectSnapshot: () => { throw new Error("not used"); },
	});
	runtime.subscribe(event => {
		if (event.type === "agent_end" && !event.willRetry) assert.deepEqual(queue, { steering: [], followUp: [] });
	});
	const messages = [{ role: "assistant", stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" }];
	emit({ type: "agent_end", willRetry: true, messages });
	assert.deepEqual(queue, { steering: ["steer later"], followUp: ["follow later"] }, "configured retry keeps native queue");
	emit({ type: "agent_end", willRetry: false, messages });
	assert.deepEqual(await runtime.clearQueue(), { steering: ["steer later"], followUp: ["follow later"] });
	assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: [] });
});

test("native quota evidence distinguishes exhausted quota from temporary throttling", () => {
	let emit!: (event: unknown) => void;
	const runtime = new InProcessHostedRuntime({
		session: { clearQueue: () => ({ steering: [], followUp: [] }), subscribe(handler: typeof emit) { emit = handler; return () => undefined; } } as unknown as AgentSession,
		projection: undefined, inspectSnapshot: () => { throw new Error("not used"); },
	});
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe(event => events.push(event));
	for (const [diagnostic, exhausted] of [
		["Codex error: The usage limit has been reached", true],
		["Codex error: usage_limit_reached", true],
		["Codex error: insufficient_quota", true],
		["Codex error: rate_limit_exceeded", false],
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

test("native quota evidence recognizes retained OpenAI formatter bodies, not arbitrary prefixes", () => {
	let emit!: (event: unknown) => void;
	const runtime = new InProcessHostedRuntime({
		session: { clearQueue: () => ({ steering: [], followUp: [] }), subscribe(handler: typeof emit) { emit = handler; return () => undefined; } } as unknown as AgentSession,
		projection: undefined, inspectSnapshot: () => { throw new Error("not used"); },
	});
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe(event => events.push(event));
	for (const prefix of ["OpenAI API error", "Azure OpenAI API error", "unrelated API error"]) {
		for (const code of ["usage_limit_reached", "insufficient_quota", "rate_limit_exceeded"]) {
			const error = Object.assign(new Error("Request rejected"), { status: 429, error: { code, resets_at: 1893456000 } });
			const diagnostic = formatProviderError(normalizeProviderError(error), prefix);
			emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: diagnostic }] });
			const event = events.at(-1)!;
			if (event.type !== "agent_end") throw new Error("missing end");
			assert.deepEqual(event.quota, prefix !== "unrelated API error" && code !== "rate_limit_exceeded"
				? { diagnostic, resetAt: "2030-01-01T00:00:00.000Z" } : undefined);
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
		session: { clearQueue: () => ({ steering: [], followUp: [] }), subscribe(handler: typeof emit) { emit = handler; return () => undefined; } } as unknown as AgentSession,
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

test("a cancelled Run publishes cancellation instead of its cancelled request setup as failure", () => {
	let emit!: (event: unknown) => void;
	const cancellation = new AbortController();
	const runtime = new InProcessHostedRuntime({
		session: {
			subscribe(handler: typeof emit) { emit = handler; return () => undefined; },
			agent: { signal: cancellation.signal },
		} as unknown as AgentSession,
		projection: undefined, inspectSnapshot: () => { throw new Error("not used"); },
	});
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe(event => events.push(event));
	emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" }] });
	assert.deepEqual(events.at(-1), {
		type: "agent_end", outcome: "error", willRetry: false,
		failure: { stage: "model", error: "This operation was aborted", provenance: "in-process-hosted-runtime" },
	}, "an uncancelled Run keeps reporting its unexpected model failure");
	// Pi reports a request setup abandoned by the Run's own abort signal as a model
	// error message whose text is that abort reason. Cancellation owns that stop.
	cancellation.abort();
	emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" }] });
	assert.deepEqual(events.at(-1), { type: "agent_end", outcome: "aborted", willRetry: false });
});

test("a Run with a live cancellation signal keeps reporting an unexpected model failure", () => {
	let emit!: (event: unknown) => void;
	const runtime = new InProcessHostedRuntime({
		session: {
			subscribe(handler: typeof emit) { emit = handler; return () => undefined; },
			agent: { signal: new AbortController().signal },
		} as unknown as AgentSession,
		projection: undefined, inspectSnapshot: () => { throw new Error("not used"); },
	});
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe(event => events.push(event));
	emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: "upstream provider exploded" }] });
	assert.deepEqual(events.at(-1), {
		type: "agent_end", outcome: "error", willRetry: false,
		failure: { stage: "model", error: "upstream provider exploded", provenance: "in-process-hosted-runtime" },
	});
});
