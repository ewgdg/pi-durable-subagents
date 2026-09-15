import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import {
	FramedAgentControlChannel,
	type AgentControlIdentity,
	type AgentControlProtocol,
} from "../src/control/agent-control-channel.ts";
import type { ControlTransport } from "../src/control/control-transport.ts";
import { createInMemoryControlTransportPair } from "../src/control/in-memory-control-transport.ts";

const protocol = {
	methods: {
		"test.echo": {
			request: Type.Object({ value: Type.String() }, { additionalProperties: false }),
			response: Type.Object({ echoed: Type.String() }, { additionalProperties: false }),
		},
		"test.wait": {
			request: Type.Object({}, { additionalProperties: false }),
			response: Type.Object({ completed: Type.Boolean() }, { additionalProperties: false }),
		},
	},
	events: {
		"test.changed": {
			payload: Type.Object({ value: Type.String() }, { additionalProperties: false }),
		},
	},
} as const satisfies AgentControlProtocol;

const identity: AgentControlIdentity = {
	protocolVersion: 8,
	workflowId: "workflow-control-channel",
	agentId: "agent-control-channel",
};

function createChannels(options: {
	fragmentSizes?: readonly number[];
	maximumFrameBytes?: number;
} = {}) {
	const [ownerTransport, childTransport] = createInMemoryControlTransportPair({
		fragmentSizes: options.fragmentSizes,
	});
	const owner = new FramedAgentControlChannel({
		identity,
		protocol,
		transport: ownerTransport,
		maximumFrameBytes: options.maximumFrameBytes,
	});
	const child = new FramedAgentControlChannel({
		identity,
		protocol,
		transport: childTransport,
		maximumFrameBytes: options.maximumFrameBytes,
	});
	return { owner, child, ownerTransport, childTransport };
}

async function closesWith(
	channel: FramedAgentControlChannel<typeof protocol>,
	pattern: RegExp,
): Promise<void> {
	await assert.rejects(new Promise<never>((_resolve, reject) => {
		channel.onClose(reject);
	}), pattern);
}

test("Control Channel correlates validated requests fragmented at every UTF-8 boundary", async (t) => {
	const { owner, child } = createChannels({ fragmentSizes: [1] });
	t.after(async () => Promise.all([owner.close(), child.close()]));
	child.onRequest(({ method, payload }) => {
		assert.equal(method, "test.echo");
		return { echoed: payload.value };
	});

	assert.deepEqual(await owner.request("test.echo", { value: "界🙂process" }), {
		echoed: "界🙂process",
	});
});

test("Control Channel accepts coalesced frames and preserves event order through async handlers", async (t) => {
	const { owner, childTransport } = createChannels();
	t.after(() => owner.close());
	const observed: string[] = [];
	owner.onEvent(async ({ event, payload, sequence }) => {
		assert.equal(event, "test.changed");
		if (sequence === 1) await new Promise((resolve) => setTimeout(resolve, 5));
		observed.push(payload.value);
	});
	const frames = ["first", "second"].map((value, index) => JSON.stringify({
		...identity,
		type: "event",
		sequence: index + 1,
		event: "test.changed",
		payload: { value },
	})).join("\n") + "\n";

	await childTransport.write(new TextEncoder().encode(frames));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(observed, ["first", "second"]);
});

test("Control Channel serializes writes while the transport applies backpressure", async () => {
	const transport = new BackpressuredTransport();
	const channel = new FramedAgentControlChannel({ identity, protocol, transport });
	const first = channel.sendEvent("test.changed", { value: "first" });
	const second = channel.sendEvent("test.changed", { value: "second" });

	await transport.waitForWrites(1);
	assert.equal(transport.writes.length, 1);
	transport.releaseNext();
	await first;
	await transport.waitForWrites(2);
	assert.equal(transport.writes.length, 2);
	transport.releaseNext();
	await second;
	assert.deepEqual(transport.writes.map(readEventValue), ["first", "second"]);
	await channel.close();
});

test("Control Channel explicitly cancels the exact remote request and ignores its late completion", async (t) => {
	const { owner, child } = createChannels({ fragmentSizes: [2, 1, 4] });
	t.after(async () => Promise.all([owner.close(), child.close()]));
	let remoteSignal: AbortSignal | undefined;
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	child.onRequest(async ({ signal }) => {
		remoteSignal = signal;
		await held;
		return { completed: true };
	});
	const abort = new AbortController();
	const result = owner.request("test.wait", {}, abort.signal);
	await waitUntil(() => remoteSignal !== undefined);
	abort.abort();
	await assert.rejects(result, (error: Error) => error.name === "AbortError");
	await waitUntil(() => remoteSignal?.aborted === true);
	release();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(remoteSignal?.aborted, true);
});

test("Control Channel rejects already-aborted requests without writing a frame", async () => {
	const transport = new RecordingTransport();
	const channel = new FramedAgentControlChannel({ identity, protocol, transport });
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(
		channel.request("test.wait", {}, abort.signal),
		(error: Error) => error.name === "AbortError",
	);
	assert.equal(transport.writes.length, 0);
	await channel.close();
});

test("Control Channel sends and validates monotonically sequenced events", async (t) => {
	const { owner, child } = createChannels({ fragmentSizes: [3] });
	t.after(async () => Promise.all([owner.close(), child.close()]));
	const received: Array<{ sequence: number; value: string }> = [];
	child.onEvent(({ sequence, payload }) => {
		received.push({ sequence, value: payload.value });
	});
	await Promise.all([
		owner.sendEvent("test.changed", { value: "one" }),
		owner.sendEvent("test.changed", { value: "two" }),
	]);
	await waitUntil(() => received.length === 2);
	assert.deepEqual(received, [
		{ sequence: 1, value: "one" },
		{ sequence: 2, value: "two" },
	]);
});

test("Control Channel fail-closes on a skipped event sequence", async (t) => {
	const { owner, childTransport } = createChannels();
	t.after(() => owner.close());
	const closed = closesWith(owner, /control_channel_event_sequence: expected 1, received 2/);
	await childTransport.write(new TextEncoder().encode(`${JSON.stringify({
		...identity,
		type: "event",
		sequence: 2,
		event: "test.changed",
		payload: { value: "late" },
	})}\n`));
	await closed;
});

test("Control Channel fail-closes identity mismatches and unknown response or cancellation IDs", async () => {
	for (const frame of [
		{ ...identity, workflowId: "other", type: "cancel", requestId: "missing" },
		{ ...identity, type: "response", requestId: "missing", ok: true, result: {} },
		{ ...identity, type: "cancel", requestId: "missing" },
	]) {
		const { owner, childTransport } = createChannels();
		const closed = new Promise<Error>((resolve) => owner.onClose(resolve));
		await childTransport.write(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
		assert.match((await closed).message, /control_channel_(identity_mismatch|unknown_response|unknown_cancellation)/);
		await owner.close();
	}
});

test("Control Channel idempotently ignores cancellation after the exact request is terminal", async (t) => {
	const { owner, child, ownerTransport } = createChannels();
	t.after(async () => Promise.all([owner.close(), child.close()]));
	child.onRequest(({ method, payload }) => {
		if (method !== "test.echo") throw new Error("unexpected method");
		return { echoed: payload.value };
	});
	assert.deepEqual(await owner.request("test.echo", { value: "first" }), { echoed: "first" });
	await ownerTransport.write(new TextEncoder().encode(`${JSON.stringify({
		...identity,
		type: "cancel",
		requestId: `${identity.agentId}:1`,
	})}\n`));
	assert.deepEqual(await owner.request("test.echo", { value: "second" }), { echoed: "second" });
});

test("Control Channel fail-closes malformed, unknown, invalid UTF-8, and non-closed frames", async (t) => {
	for (const bytes of [
		new TextEncoder().encode("not-json\n"),
		new TextEncoder().encode(`${JSON.stringify({ ...identity, type: "mystery" })}\n`),
		Uint8Array.from([0xc3, 0x28, 0x0a]),
		new TextEncoder().encode(`${JSON.stringify({
			...identity,
			type: "cancel",
			requestId: "missing",
			extra: true,
		})}\n`),
	]) {
		const { owner, childTransport } = createChannels();
		const closed = new Promise<Error>((resolve) => owner.onClose(resolve));
		await childTransport.write(bytes);
		assert.match((await closed).message, /control_channel_(malformed|unknown)/);
		await owner.close();
	}
});

test("Control Channel enforces the byte limit per frame without rejecting coalesced small frames", async (t) => {
	const { owner, childTransport } = createChannels({ maximumFrameBytes: 220 });
	t.after(() => owner.close());
	owner.onEvent(() => undefined);
	const small = (sequence: number) => JSON.stringify({
		...identity,
		type: "event",
		sequence,
		event: "test.changed",
		payload: { value: "x" },
	});
	const coalesced = `${small(1)}\n${small(2)}\n`;
	assert.ok(Buffer.byteLength(coalesced) > 220);
	await childTransport.write(new TextEncoder().encode(coalesced));

	const closed = closesWith(owner, /control_channel_frame_too_large/);
	await childTransport.write(new TextEncoder().encode("x".repeat(221)));
	await closed;
});

test("Control Channel rejects an oversized line before dispatching a valid coalesced suffix", async (t) => {
	const { owner, childTransport } = createChannels({ maximumFrameBytes: 220 });
	t.after(() => owner.close());
	let dispatched = false;
	owner.onEvent(() => { dispatched = true; });
	const suffix = JSON.stringify({
		...identity,
		type: "event",
		sequence: 1,
		event: "test.changed",
		payload: { value: "must-not-dispatch" },
	});
	const closed = closesWith(owner, /control_channel_frame_too_large/);
	await childTransport.write(new TextEncoder().encode(`${"x".repeat(221)}\n${suffix}\n`));
	await closed;
	assert.equal(dispatched, false);
});

test("Control Channel rejects an oversized outgoing frame without poisoning later delivery", async (t) => {
	const { owner, child } = createChannels({ maximumFrameBytes: 220 });
	t.after(async () => Promise.all([owner.close(), child.close()]));
	const received: Array<{ sequence: number; value: string }> = [];
	child.onEvent(({ sequence, payload }) => {
		received.push({ sequence, value: payload.value });
	});
	child.onRequest(({ method, payload }) => {
		if (method !== "test.echo") throw new Error("unexpected method");
		return { echoed: payload.value };
	});
	await assert.rejects(
		owner.sendEvent("test.changed", { value: "x".repeat(500) }),
		/control_channel_frame_too_large/,
	);
	await owner.sendEvent("test.changed", { value: "small" });
	await waitUntil(() => received.length === 1);
	assert.deepEqual(received, [{ sequence: 1, value: "small" }]);
	assert.deepEqual(await owner.request("test.echo", { value: "healthy" }), { echoed: "healthy" });
});

test("Control Channel keeps ancient terminal response and cancellation frames idempotent with bounded state", async (t) => {
	const { owner, child, ownerTransport, childTransport } = createChannels();
	t.after(async () => Promise.all([owner.close(), child.close()]));
	child.onRequest(({ method, payload }) => {
		if (method !== "test.echo") throw new Error("unexpected method");
		return { echoed: payload.value };
	});
	for (let index = 0; index < 1_100; index += 1) {
		assert.deepEqual(await owner.request("test.echo", { value: String(index) }), { echoed: String(index) });
	}
	const ancientRequestId = `${identity.agentId}:1`;
	await childTransport.write(new TextEncoder().encode(`${JSON.stringify({
		...identity,
		type: "response",
		requestId: ancientRequestId,
		ok: true,
		result: { echoed: "late" },
	})}\n`));
	await ownerTransport.write(new TextEncoder().encode(`${JSON.stringify({
		...identity,
		type: "cancel",
		requestId: ancientRequestId,
	})}\n`));
	assert.deepEqual(await owner.request("test.echo", { value: "healthy" }), { echoed: "healthy" });
});

test("Control Channel isolates throwing close observers and still closes its transport", async () => {
	const transport = new RecordingTransport();
	const channel = new FramedAgentControlChannel({ identity, protocol, transport });
	let remainingObserverCalled = false;
	channel.onClose(() => { throw new Error("observer failed"); });
	channel.onClose(() => { remainingObserverCalled = true; });

	await channel.close();

	assert.equal(remainingObserverCalled, true);
	assert.equal(transport.closed, true);
});

test("Control Channel deterministically rejects outstanding requests on local and peer close", async () => {
	for (const closePeer of [false, true]) {
		const { owner, child } = createChannels();
		child.onRequest(() => new Promise(() => undefined));
		const pending = owner.request("test.wait", {});
		await new Promise((resolve) => setImmediate(resolve));
		await (closePeer ? child.close() : owner.close());
		await assert.rejects(pending, /control_channel_closed/);
		await Promise.all([owner.close(), child.close()]);
	}
});

test("Control Channel returns synchronous and asynchronous handler failures without an unhandled rejection", async (t) => {
	const { owner, child } = createChannels();
	t.after(async () => Promise.all([owner.close(), child.close()]));
	child.onRequest(({ method, payload }) => {
		if (method !== "test.echo") throw new Error("unexpected method");
		if (payload.value === "sync") throw new Error("synchronous failure");
		if (payload.value === "async") return Promise.reject(new Error("asynchronous failure"));
		return { echoed: payload.value };
	});
	await assert.rejects(owner.request("test.echo", { value: "sync" }), /request_failed: synchronous failure/);
	await assert.rejects(owner.request("test.echo", { value: "async" }), /request_failed: asynchronous failure/);
	assert.deepEqual(await owner.request("test.echo", { value: "healthy" }), { echoed: "healthy" });
});

test("Control Channel validates local payloads, JSON safety, and remote results", async (t) => {
	const { owner, child } = createChannels();
	t.after(async () => Promise.all([owner.close(), child.close()]));
	await assert.rejects(
		owner.request("test.echo", { value: 1 } as never),
		/control_channel_invalid_request/,
	);
	await assert.rejects(
		owner.request("test.wait", { hidden: undefined } as never),
		/control_channel_invalid_request|control_channel_malformed_frame/,
	);
	child.onRequest(() => ({ wrong: true }));
	await assert.rejects(owner.request("test.echo", { value: "x" }), /control_channel_invalid_response/);
});

class RecordingTransport implements ControlTransport {
	readonly writes: Uint8Array[] = [];
	closed = false;
	#closeHandlers = new Set<(cause?: Error) => void>();

	async write(data: Uint8Array): Promise<void> { this.writes.push(data.slice()); }
	onData(): () => void { return () => undefined; }
	onClose(handler: (cause?: Error) => void): () => void {
		this.#closeHandlers.add(handler);
		return () => this.#closeHandlers.delete(handler);
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const handler of this.#closeHandlers) handler();
	}
}

class BackpressuredTransport extends RecordingTransport {
	#releases: Array<() => void> = [];
	#writeWaiters: Array<() => void> = [];

	override async write(data: Uint8Array): Promise<void> {
		this.writes.push(data.slice());
		for (const resolve of this.#writeWaiters.splice(0)) resolve();
		await new Promise<void>((resolve) => this.#releases.push(resolve));
	}

	async waitForWrites(count: number): Promise<void> {
		if (this.writes.length >= count) return;
		await new Promise<void>((resolve) => this.#writeWaiters.push(resolve));
	}

	releaseNext(): void { this.#releases.shift()?.(); }
}

function readEventValue(bytes: Uint8Array): string {
	return JSON.parse(new TextDecoder().decode(bytes)).payload.value;
}

async function waitUntil(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 100; attempts += 1) {
		if (condition()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error("condition was not reached");
}
