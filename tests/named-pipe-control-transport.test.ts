import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import { Type } from "typebox";

import { AgentControlAdmissionBroker } from "../src/control/agent-control-admission.ts";
import {
	FramedAgentControlChannel,
	type AgentControlProtocol,
} from "../src/control/agent-control-channel.ts";
import {
	admitControlTransportPlatform,
	connectControlTransport,
	createPlatformControlListener,
} from "../src/control/control-platform.ts";
import {
	assertNamedPipeAddress,
	connectNamedPipeControlTransport,
	createNamedPipeAddress,
	listenNamedPipeControlEndpoint,
	MAXIMUM_NAMED_PIPE_ADDRESS_LENGTH,
} from "../src/control/named-pipe-control-transport.ts";

const windowsOnly = process.platform === "win32" ? test : test.skip;
const protocol = {
	methods: {
		"test.echo": {
			request: Type.Object({ value: Type.String() }, { additionalProperties: false }),
			response: Type.Object({ value: Type.String() }, { additionalProperties: false }),
		},
	},
	events: {
		"test.changed": {
			payload: Type.Object({ value: Type.String() }, { additionalProperties: false }),
		},
	},
} as const satisfies AgentControlProtocol;
const identity = {
	protocolVersion: 8 as const,
	workflowId: "named-pipe-workflow",
	agentId: "named-pipe-agent",
};

test("win32 selects bounded private named-pipe endpoints without filesystem input", () => {
	assert.equal(admitControlTransportPlatform("win32"), "named-pipe");
	const first = createNamedPipeAddress("a-workflow-id-that-can-be-long");
	const second = createNamedPipeAddress("a-workflow-id-that-can-be-long");
	assert.match(first, /^\\\\\.\\pipe\\pi-ac-[a-f0-9]+-[a-f0-9]+$/);
	assert.notEqual(first, second);
	assert.ok(first.length <= MAXIMUM_NAMED_PIPE_ADDRESS_LENGTH);
	assert.doesNotThrow(() => assertNamedPipeAddress(first));
});

test("named-pipe endpoints fail closed before reaching node:net", async () => {
	for (const address of [
		"pipe-name",
		"\\\\?\\pipe\\pi-ac-other-prefix",
		"\\\\.\\pipe\\nested\\name",
		"\\\\.\\pipe\\name\0suffix",
		`\\\\.\\pipe\\${"x".repeat(MAXIMUM_NAMED_PIPE_ADDRESS_LENGTH)}`,
	]) {
		assert.throws(() => assertNamedPipeAddress(address), /control_endpoint_invalid|control_endpoint_path_too_long/);
	}
	assert.throws(() => createNamedPipeAddress(""), /workflowId is required/);
	await assert.rejects(
		connectControlTransport(
			{ transport: "named-pipe", address: "pipe-name" },
			{ platform: "win32" },
		),
		/control_endpoint_invalid/,
	);
	await assert.rejects(
		connectControlTransport(
			{ transport: "tcp", address: "127.0.0.1" } as never,
			{ platform: "win32" },
		),
		/control_endpoint_invalid/,
	);
	await assert.rejects(
		connectControlTransport(
			{ transport: "named-pipe", address: "\\\\.\\pipe\\pi-ac-mismatch" },
			{ platform: "linux" },
		),
		/control_endpoint_transport_mismatch/,
	);
});

windowsOnly("Control Channel contract runs unchanged over connected named-pipe Adapters", async (t) => {
	const listener = await createPlatformControlListener({
		workflowId: "named-pipe-contract",
		platform: "win32",
	});
	t.after(async () => listener.close().catch(() => undefined));
	assert.equal(listener.endpoint.transport, "named-pipe");
	const accepted = listener.accept();
	const ownerTransport = await connectControlTransport(listener.endpoint, { platform: "win32" });
	const childTransport = await accepted;
	const owner = new FramedAgentControlChannel({ identity, protocol, transport: ownerTransport });
	const child = new FramedAgentControlChannel({ identity, protocol, transport: childTransport });
	t.after(async () => Promise.allSettled([owner.close(), child.close()]));
	const events: string[] = [];
	child.onRequest(({ payload }) => ({ value: payload.value }));
	child.onEvent(({ payload }) => { events.push(payload.value); });

	assert.deepEqual(await owner.request("test.echo", { value: "pipe🙂" }), { value: "pipe🙂" });
	await Promise.all([
		owner.sendEvent("test.changed", { value: "one" }),
		owner.sendEvent("test.changed", { value: "two" }),
	]);
	await waitUntil(() => events.length === 2);
	assert.deepEqual(events, ["one", "two"]);

	await owner.close();
	await child.close();
	await listener.close();
	await assert.rejects(connectNamedPipeControlTransport(listener.endpoint));
});

windowsOnly("named-pipe admission preserves one-shot authenticated Hello binding", async (t) => {
	const listener = await createPlatformControlListener({
		workflowId: identity.workflowId,
		platform: "win32",
	});
	const broker = new AgentControlAdmissionBroker({
		listener,
		protocol,
		workflowId: identity.workflowId,
	});
	t.after(async () => broker.close().catch(() => undefined));
	const admission = broker.admit({
		agentId: identity.agentId,
		connectionToken: "one-shot-token",
		expectedSessionId: "expected-session",
	}, (channel) => {
		channel.onRequest(({ payload }) => ({ value: `bound:${payload.value}` }));
	});
	const child = new FramedAgentControlChannel({
		identity,
		protocol,
		transport: await connectControlTransport(listener.endpoint, { platform: "win32" }),
	});
	t.after(async () => child.close().catch(() => undefined));
	await child.sendHello({
		connectionToken: "one-shot-token",
		expectedSessionId: "expected-session",
	});
	await admission;
	assert.deepEqual(await child.request("test.echo", { value: "hello" }), { value: "bound:hello" });

	const duplicate = new FramedAgentControlChannel({
		identity,
		protocol,
		transport: await connectControlTransport(listener.endpoint, { platform: "win32" }),
	});
	const duplicateClosed = new Promise<void>((resolve) => duplicate.onClose(() => resolve()));
	await duplicate.sendHello({
		connectionToken: "one-shot-token",
		expectedSessionId: "expected-session",
	});
	await duplicateClosed;
	await duplicate.close();
});

windowsOnly("named-pipe listener bounds cancellation, collisions, peer exit, and cleanup", {
	timeout: 4_000,
}, async (t) => {
	const endpoint = { transport: "named-pipe", address: createNamedPipeAddress("failure-paths") } as const;
	const listener = await listenNamedPipeControlEndpoint(endpoint);
	t.after(async () => listener.close().catch(() => undefined));

	const cancellation = new AbortController();
	const cancelledAcceptance = listener.accept(cancellation.signal);
	cancellation.abort();
	await assert.rejects(cancelledAcceptance, (error) => error instanceof DOMException && error.name === "AbortError");
	await assert.rejects(listenNamedPipeControlEndpoint(endpoint), /EADDRINUSE/);

	const exitedAcceptance = listener.accept();
	const exited = await connectNamedPipeControlTransport(endpoint);
	const exitedServer = await exitedAcceptance;
	const peerExitObserved = new Promise<void>((resolve) => exitedServer.onClose(() => resolve()));
	await exited.close();
	await peerExitObserved;
	await exitedServer.close();

	const accepted = listener.accept();
	const liveClient = await connectNamedPipeControlTransport(endpoint);
	const liveServer = await accepted;
	const received = new Promise<string>((resolve) => liveClient.onData((bytes) => {
		resolve(new TextDecoder().decode(bytes));
	}));
	await liveServer.write(new TextEncoder().encode("live"));
	assert.equal(await received, "live");
	await Promise.all([liveClient.close(), liveServer.close()]);

	await listener.close();
	await listener.close();
	const rebound = await listenNamedPipeControlEndpoint(endpoint);
	await rebound.close();
});

windowsOnly("named-pipe pending writes reject when the peer exits", { timeout: 4_000 }, async (t) => {
	const endpoint = { transport: "named-pipe", address: createNamedPipeAddress("pending-write") } as const;
	const listener = await listenNamedPipeControlEndpoint(endpoint);
	t.after(async () => listener.close().catch(() => undefined));
	const accepted = listener.accept();
	const peer = createConnection(endpoint.address);
	peer.pause();
	await new Promise<void>((resolve, reject) => {
		peer.once("connect", resolve);
		peer.once("error", reject);
	});
	const serverTransport = await accepted;
	const pendingWrite = serverTransport.write(new Uint8Array(8 * 1024 * 1024));
	await new Promise((resolve) => setImmediate(resolve));
	peer.destroy();
	await assert.rejects(pendingWrite);
	await serverTransport.close();
});

async function waitUntil(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 100; attempts += 1) {
		if (condition()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error("condition was not reached");
}
