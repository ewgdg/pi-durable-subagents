import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import {
	FramedAgentControlChannel,
	type AgentControlProtocol,
} from "../src/control/agent-control-channel.ts";
import { AgentControlAdmissionBroker } from "../src/control/agent-control-admission.ts";
import {
	admitControlTransportPlatform,
	connectControlTransport,
	createPlatformControlListener,
} from "../src/control/control-platform.ts";
import {
	assertUnixSocketPath,
	connectUnixControlTransport,
	createUnixControlListener,
	listenUnixControlEndpoint,
	MAXIMUM_UNIX_SOCKET_PATH_BYTES,
} from "../src/control/unix-socket-control-transport.ts";

const unixOnly = process.platform === "win32" ? test.skip : test;
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
const identity = { protocolVersion: 8 as const, workflowId: "unix-workflow", agentId: "unix-agent" };

unixOnly("Unix listener allocates a short private endpoint and removes it on close", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-test-"));
	const listener = await createUnixControlListener({ workflowId: "a-workflow-id-that-can-be-long", runtimeDirectory: root });
	const directory = dirname(listener.endpoint.address);
	assert.ok(Buffer.byteLength(listener.endpoint.address) <= MAXIMUM_UNIX_SOCKET_PATH_BYTES);
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	assert.equal((await stat(listener.endpoint.address)).mode & 0o777, 0o600);
	await listener.close();
	await assert.rejects(lstat(listener.endpoint.address), hasFsCode("ENOENT"));
	await assert.rejects(lstat(directory), hasFsCode("ENOENT"));
	await rmdir(root);
});

unixOnly("Control Channel contract runs unchanged over connected Unix socket Adapters", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-contract-"));
	const listener = await createPlatformControlListener({ workflowId: "contract", runtimeDirectory: root });
	const accepted = listener.accept();
	const ownerTransport = await connectControlTransport(listener.endpoint);
	const childTransport = await accepted;
	const owner = new FramedAgentControlChannel({ identity, protocol, transport: ownerTransport });
	const child = new FramedAgentControlChannel({ identity, protocol, transport: childTransport });
	const events: string[] = [];
	child.onRequest(({ payload }) => ({ value: payload.value }));
	child.onEvent(({ payload }) => { events.push(payload.value); });

	assert.deepEqual(await owner.request("test.echo", { value: "socket🙂" }), { value: "socket🙂" });
	await Promise.all([
		owner.sendEvent("test.changed", { value: "one" }),
		owner.sendEvent("test.changed", { value: "two" }),
	]);
	await waitUntil(() => events.length === 2);
	assert.deepEqual(events, ["one", "two"]);
	await owner.close();
	await child.close();
	await listener.close();
	await rmdir(root);
});

unixOnly("admission broker routes out-of-order children by one-time validated Hello tokens", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-admission-"));
	const listener = await createPlatformControlListener({ workflowId: identity.workflowId, runtimeDirectory: root });
	const broker = new AgentControlAdmissionBroker({
		listener,
		protocol,
		workflowId: identity.workflowId,
	});
	const firstAdmission = broker.admit({
		agentId: "first-agent",
		connectionToken: "first-token",
		expectedSessionId: "first-session",
	}, (channel) => {
		channel.onRequest(({ payload }) => ({ value: `first:${payload.value}` }));
	});
	const secondAdmission = broker.admit({
		agentId: "second-agent",
		connectionToken: "second-token",
		expectedSessionId: "second-session",
	}, (channel) => {
		channel.onRequest(({ payload }) => ({ value: `second:${payload.value}` }));
	});
	const secondIdentity = { ...identity, agentId: "second-agent" };
	const secondChild = new FramedAgentControlChannel({
		identity: secondIdentity,
		protocol,
		transport: await connectControlTransport(listener.endpoint),
	});
	await secondChild.sendHello({ connectionToken: "second-token", expectedSessionId: "second-session" });
	const firstIdentity = { ...identity, agentId: "first-agent" };
	const firstChild = new FramedAgentControlChannel({
		identity: firstIdentity,
		protocol,
		transport: await connectControlTransport(listener.endpoint),
	});
	await firstChild.sendHello({ connectionToken: "first-token", expectedSessionId: "first-session" });
	await Promise.all([firstAdmission, secondAdmission]);
	assert.deepEqual(await firstChild.request("test.echo", { value: "bound" }), { value: "first:bound" });
	assert.deepEqual(await secondChild.request("test.echo", { value: "bound" }), { value: "second:bound" });

	const duplicate = new FramedAgentControlChannel({
		identity: firstIdentity,
		protocol,
		transport: await connectControlTransport(listener.endpoint),
	});
	const duplicateClosed = new Promise<Error>((resolve) => duplicate.onClose(resolve));
	await duplicate.sendHello({ connectionToken: "first-token", expectedSessionId: "first-session" });
	assert.match((await duplicateClosed).message, /control_channel_closed/);

	await Promise.all([firstChild.close(), secondChild.close(), duplicate.close()]);
	await broker.close();
	await rmdir(root);
});

unixOnly("admission rejects incompatible protocol versions before configuring a channel", { timeout: 5_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-version-"));
	const listener = await createPlatformControlListener({ workflowId: identity.workflowId, runtimeDirectory: root });
	const broker = new AgentControlAdmissionBroker({ listener, protocol, workflowId: identity.workflowId });
	t.after(async () => {
		await broker.close();
		await rmdir(root);
	});
	for (const protocolVersion of [identity.protocolVersion - 1, identity.protocolVersion + 1]) {
		let configured = false;
		const abort = new AbortController();
		const connectionToken = `version-${protocolVersion}`;
		const admitted = broker.admit({
			agentId: identity.agentId,
			connectionToken,
			expectedSessionId: "session",
		}, () => { configured = true; }, abort.signal).then(() => true, () => false);
		const child = await connectControlTransport(listener.endpoint);
		t.after(() => child.close());
		const closed = new Promise<void>((resolve) => child.onClose(() => resolve()));
		await child.write(new TextEncoder().encode(`${JSON.stringify({
			...identity, protocolVersion, type: "hello", connectionToken, expectedSessionId: "session",
		})}\n`));
		await closed;
		assert.equal(configured, false);
		// Invalid frames are closed before a pending admission can claim their token.
		abort.abort();
		assert.equal(await admitted, false);
	}
});

unixOnly("admission broker binds handlers before releasing a coalesced post-Hello request", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-handoff-"));
	const listener = await createPlatformControlListener({ workflowId: identity.workflowId, runtimeDirectory: root });
	const broker = new AgentControlAdmissionBroker({ listener, protocol, workflowId: identity.workflowId });
	const admission = broker.admit({
		agentId: identity.agentId,
		connectionToken: "handoff-token",
		expectedSessionId: "handoff-session",
	}, (channel) => {
		channel.onRequest(({ payload }) => ({ value: `handled:${payload.value}` }));
	});
	const child = await connectControlTransport(listener.endpoint);
	let responseBytes = "";
	const responseReceived = new Promise<void>((resolve) => child.onData((bytes) => {
		responseBytes += new TextDecoder().decode(bytes);
		if (responseBytes.includes("\n")) resolve();
	}));
	const hello = { ...identity, type: "hello", connectionToken: "handoff-token", expectedSessionId: "handoff-session" };
	const request = {
		...identity,
		type: "request",
		requestId: `${identity.agentId}:1`,
		method: "test.echo",
		payload: { value: "coalesced" },
	};
	await child.write(new TextEncoder().encode(`${JSON.stringify(hello)}\n${JSON.stringify(request)}\n`));
	await admission;
	await responseReceived;
	assert.deepEqual(JSON.parse(responseBytes.trim()), {
		...identity,
		type: "response",
		requestId: `${identity.agentId}:1`,
		ok: true,
		result: { value: "handled:coalesced" },
	});

	await child.close();
	await broker.close();
	await rmdir(root);
});

unixOnly("admission broker fail-closes non-Hello, unknown-token, and mismatched identities", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-reject-"));
	const listener = await createPlatformControlListener({ workflowId: identity.workflowId, runtimeDirectory: root });
	const broker = new AgentControlAdmissionBroker({ listener, protocol, workflowId: identity.workflowId });

	const nonHello = await connectControlTransport(listener.endpoint);
	const nonHelloClosed = new Promise<void>((resolve) => nonHello.onClose(() => resolve()));
	await nonHello.write(new TextEncoder().encode(`${JSON.stringify({
		...identity,
		type: "event",
		sequence: 1,
		event: "test.changed",
		payload: { value: "early" },
	})}\n`));
	await nonHelloClosed;

	const unknown = new FramedAgentControlChannel({
		identity,
		protocol,
		transport: await connectControlTransport(listener.endpoint),
	});
	const unknownClosed = new Promise<Error>((resolve) => unknown.onClose(resolve));
	await unknown.sendHello({ connectionToken: "unknown", expectedSessionId: "session" });
	await unknownClosed;

	for (const [name, alteredIdentity, expectedSessionId] of [
		["workflow", { ...identity, workflowId: "other-workflow" }, "session"],
		["agent", { ...identity, agentId: "other-agent" }, "session"],
		["session", identity, "other-session"],
	] as const) {
		const connectionToken = `${name}-token`;
		const admission = broker.admit({
			agentId: identity.agentId,
			connectionToken,
			expectedSessionId: "session",
		}, () => undefined);
		const child = new FramedAgentControlChannel({
			identity: alteredIdentity,
			protocol,
			transport: await connectControlTransport(listener.endpoint),
		});
		await child.sendHello({ connectionToken, expectedSessionId });
		await assert.rejects(admission, /control_admission_identity_mismatch/);
		await child.close();
	}

	await Promise.all([nonHello.close(), unknown.close()]);
	await broker.close();
	await rmdir(root);
});

unixOnly("Unix listener shutdown closes accepted sockets before closing the server", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-shutdown-"));
	const listener = await createUnixControlListener({ workflowId: "shutdown", runtimeDirectory: root });
	const accepted = listener.accept();
	const client = await connectUnixControlTransport(listener.endpoint);
	const serverSide = await accepted;
	const clientClosed = new Promise<void>((resolve) => client.onClose(() => resolve()));
	await listener.close();
	await clientClosed;
	await Promise.all([client.close(), serverSide.close()]);
	await rmdir(root);
});

unixOnly("Unix listener skips queued sockets that close before acceptance", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-queued-close-"));
	const listener = await createUnixControlListener({ workflowId: "queued-close", runtimeDirectory: root });
	const transports: Array<{ close(): Promise<void> }> = [];
	t.after(async () => {
		await Promise.allSettled(transports.map((transport) => transport.close()));
		await listener.close().catch(() => undefined);
		await rmdir(root).catch(() => undefined);
	});
	const exited = await connectUnixControlTransport(listener.endpoint);
	transports.push(exited);
	await exited.close();
	// Allow the listener side to observe the peer FIN and remove its queued Adapter.
	await new Promise((resolve) => setTimeout(resolve, 20));

	const accepted = listener.accept();
	const liveClient = await connectUnixControlTransport(listener.endpoint);
	transports.push(liveClient);
	const liveServer = await accepted;
	transports.push(liveServer);
	const received = new Promise<string>((resolve) => liveClient.onData((bytes) => resolve(new TextDecoder().decode(bytes))));
	await liveServer.write(new TextEncoder().encode("live"));
	assert.equal(await received, "live");

	await Promise.all([liveClient.close(), liveServer.close(), listener.close()]);
	await rmdir(root);
});

unixOnly("Unix transport isolates throwing close observers", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-observers-"));
	const listener = await createUnixControlListener({ workflowId: "observers", runtimeDirectory: root });
	t.after(async () => {
		await listener.close().catch(() => undefined);
		await rmdir(root).catch(() => undefined);
	});
	const accepted = listener.accept();
	const client = await connectUnixControlTransport(listener.endpoint);
	const serverSide = await accepted;
	let remainingObserverCalled = false;
	serverSide.onClose(() => { throw new Error("observer failed"); });
	serverSide.onClose(() => { remainingObserverCalled = true; });

	await serverSide.close();
	await waitUntil(() => remainingObserverCalled);
	await Promise.all([serverSide.close(), listener.close()]);
	await rmdir(root);
});

unixOnly("Unix listener continues endpoint cleanup when owned-directory removal fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-cleanup-"));
	const listener = await createUnixControlListener({ workflowId: "cleanup", runtimeDirectory: root });
	const directory = dirname(listener.endpoint.address);
	const retained = join(directory, "retained");
	await writeFile(retained, "force ENOTEMPTY");

	await assert.rejects(listener.close(), /ENOTEMPTY/);
	await assert.rejects(lstat(listener.endpoint.address), hasFsCode("ENOENT"));

	await unlink(retained);
	await rmdir(directory);
	await rmdir(root);
});

unixOnly("Unix listener cleans a stale socket but refuses an active or non-socket endpoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-stale-"));
	const staleAddress = join(root, "stale.sock");
	await leaveStaleSocket(staleAddress);
	assert.equal((await lstat(staleAddress)).isSocket(), true);
	const staleListener = await listenUnixControlEndpoint({ transport: "unix", address: staleAddress });
	assert.equal((await lstat(staleAddress)).isSocket(), true);

	await assert.rejects(
		listenUnixControlEndpoint({ transport: "unix", address: staleAddress }),
		/control_endpoint_in_use/,
	);
	await staleListener.close();

	const occupiedAddress = join(root, "occupied.sock");
	await writeFile(occupiedAddress, "not a socket");
	await assert.rejects(
		listenUnixControlEndpoint({ transport: "unix", address: occupiedAddress }),
		/control_endpoint_occupied/,
	);
	await unlink(occupiedAddress);
	await rmdir(root);
});

unixOnly("Unix connector fails clearly for path length and missing listeners", async () => {
	const tooLong = `/${"x".repeat(MAXIMUM_UNIX_SOCKET_PATH_BYTES)}`;
	assert.throws(() => assertUnixSocketPath(tooLong), /control_endpoint_path_too_long/);
	await assert.rejects(
		connectUnixControlTransport({ transport: "unix", address: join(tmpdir(), "definitely-missing-pi-control.sock") }),
		/ENOENT/,
	);
});

test("platform admission selects its internal IPC Adapter and fails before unsupported allocation", async () => {
	assert.equal(
		admitControlTransportPlatform(),
		process.platform === "win32" ? "named-pipe" : "unix",
	);
	assert.equal(admitControlTransportPlatform("win32"), "named-pipe");
	assert.throws(
		() => admitControlTransportPlatform("android"),
		/control_transport_unsupported_platform: android/,
	);
	const neverCreated = join(tmpdir(), `pi-control-unsupported-${process.pid}-${Date.now()}`);
	await assert.rejects(
		createPlatformControlListener({
			workflowId: "unsupported",
			runtimeDirectory: neverCreated,
			platform: "android",
		}),
		/control_transport_unsupported_platform/,
	);
	await assert.rejects(lstat(neverCreated), hasFsCode("ENOENT"));
	await assert.rejects(
		connectControlTransport(
			{ transport: "named-pipe", address: "\\\\.\\pipe\\pi-ac-mismatch" },
			{ platform: "linux" },
		),
		/control_endpoint_transport_mismatch/,
	);
});

async function leaveStaleSocket(address: string): Promise<void> {
	const script = [
		'import net from "node:net";',
		`const server = net.createServer();`,
		`server.listen(${JSON.stringify(address)}, () => process.stdout.write("ready\\n"));`,
		`setInterval(() => undefined, 1000);`,
	].join("\n");
	const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.stdout.once("data", () => resolve());
	});
	child.kill("SIGKILL");
	await once(child, "exit");
}

function hasFsCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

async function waitUntil(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 100; attempts += 1) {
		if (condition()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error("condition was not reached");
}
