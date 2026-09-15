import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { disposeSessionStartup, registerSessionStartup } from "../src/pi-integration/session-startup.ts";
import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";

const source = { agentId: "wrapper-author", entryId: "wrapper-entry", toolCallId: "wrapper-call" };
const message = createMessageDelivery([{ source, projection: {
	kind: "message", messageId: deriveMessageIdentity(source), fromAgentId: source.agentId,
	content: "Process the wrapped delivery.",
} }]);

test("a custom-message wrapper installed after startup binding observes idle delivery once", { timeout: 5000 }, async t => {
	const host = await createTestOwnerHost(t, registerSessionStartup);
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	const original = host.session.sendCustomMessage;
	const observed: unknown[] = [];
	host.session.sendCustomMessage = async (input, options) => {
		await Promise.resolve();
		observed.push(input);
		return original.call(host.session, input, options);
	};
	host.model.setResponses([fauxAssistantMessage("Received.")]);
	await runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion;
	assert.deepEqual(observed, [message]);
	assert.equal(host.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === message.customType).length, 1);
});

test("a post-bind custom wrapper can forward a cloned message across reload", { timeout: 5000 }, async t => {
	const host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		pi.on("session_shutdown", () => disposeSessionStartup(host.session));
	});
	let runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	const original = host.session.sendCustomMessage;
	let forwards = 0;
	host.session.sendCustomMessage = async (input, options) => {
		await Promise.resolve();
		forwards++;
		return original.call(host.session, { ...input }, options);
	};
	let modelCalls = 0;
	host.model.setResponses([0, 1].map(() => () => { modelCalls++; return fauxAssistantMessage("Cloned delivery processed."); }));
	for (let generation = 0; generation < 2; generation++) {
		if (generation) {
			await host.session.reload();
			runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
		}
		await runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion;
		assert.equal(forwards, generation + 1);
		assert.equal(modelCalls, generation + 1);
		const entries = host.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message")
			.filter(entry => entry.customType === message.customType);
		assert.equal(entries.length, generation + 1);
		assert.ok(entries.every(entry => entry.content === message.content && entry.display === message.display));
		assert.deepEqual(entries.map(entry => entry.details), entries.map(() => message.details));
	}
});

test("an asynchronous native-prompt wrapper preserves successful committed startup", { timeout: 5000 }, async t => {
	const host = await createTestOwnerHost(t, registerSessionStartup);
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	const original = host.session.agent.prompt;
	host.session.agent.prompt = async function (...args) {
		await Promise.resolve();
		return Reflect.apply(original, this, args);
	};
	let calls = 0;
	host.model.setResponses([() => { calls++; return fauxAssistantMessage("Processed."); }]);
	const dispatched = runtime.deliver({ kind: "custom", message, triggerTurn: true });
	const outcome = await dispatched.completion.then(() => "success", error => error.message);
	assert.equal(calls, 1);
	assert.equal(host.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === message.customType).length, 1);
	assert.equal(outcome, "success", "actual native processing must not be reported as failed startup");
});

test("a native wrapper that handles its call without forwarding does not claim startup", { timeout: 5000 }, async t => {
	const host = await createTestOwnerHost(t, registerSessionStartup);
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	host.session.agent.prompt = async () => {};
	await assert.rejects(runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion, /custom_startup_not_started/);
	assert.equal(host.session.messages.length, 0);
});

test("abort during an asynchronous native wrapper prevents Delivery and remains cancellable startup", { timeout: 5000 }, async t => {
	const host = await createTestOwnerHost(t, registerSessionStartup);
	let entered!: () => void;
	const waiting = new Promise<void>(resolve => { entered = resolve; });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.after(release);
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	const original = host.session.agent.prompt;
	let forwards = 0;
	host.session.agent.prompt = async function (...args) {
		if (++forwards === 1) { entered(); await gate; }
		return Reflect.apply(original, this, args);
	};
	let modelCalls = 0;
	host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Explicit retry."); }]);
	const rejected = assert.rejects(runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion, /startup_admission_cancelled/);
	await waiting;
	const aborted = host.session.abort();
	release();
	await aborted;
	await rejected;
	assert.equal(modelCalls, 0);
	assert.equal(host.session.sessionManager.getEntries().some(entry => entry.type === "custom_message"), false);
	await runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion;
	assert.equal(modelCalls, 1);
	assert.equal(forwards, 2);
});

test("reload invalidates delayed native forwarding before it can commit Delivery", { timeout: 5000 }, async t => {
	const host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		pi.on("session_shutdown", () => disposeSessionStartup(host.session));
	});
	let entered!: () => void;
	const waiting = new Promise<void>(resolve => { entered = resolve; });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.after(release);
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	const original = host.session.agent.prompt;
	let forwards = 0;
	host.session.agent.prompt = async function (...args) {
		if (++forwards === 1) { entered(); await gate; }
		return Reflect.apply(original, this, args);
	};
	const rejected = assert.rejects(runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion, /startup_admission_cancelled/);
	await waiting;
	await host.session.reload();
	// Pi can re-evaluate the extension module while a wrapper retains an old call.
	const reloadedStartup = await import(new URL("../src/pi-integration/session-startup.ts?reload-generation", import.meta.url).href);
	reloadedStartup.bindSessionStartup(host.session);
	const replacement = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	release();
	await rejected;
	assert.equal(host.session.sessionManager.getEntries().some(entry => entry.type === "custom_message"), false);
	host.model.setResponses([fauxAssistantMessage("Retry after reload.")]);
	await replacement.deliver({ kind: "custom", message, triggerTurn: true }).completion;
	assert.equal(forwards, 2, "reload must retain the outer wrapper above the stable guard");
	assert.equal(host.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === message.customType).length, 1);
});

test("reload preserves an actual native Run while its start hook awaits behind an async wrapper", { timeout: 5000 }, async t => {
	let entered!: () => void;
	const waiting = new Promise<void>(resolve => { entered = resolve; });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.after(release);
	const host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		pi.on("agent_start", async () => { entered(); await gate; });
		pi.on("session_shutdown", () => disposeSessionStartup(host.session));
	});
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	const original = host.session.agent.prompt;
	host.session.agent.prompt = async function (...args) { await Promise.resolve(); return Reflect.apply(original, this, args); };
	let calls = 0;
	host.model.setResponses([() => { calls++; return fauxAssistantMessage("Accepted Run survived reload."); }]);
	const delivery = runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion;
	void delivery.catch(() => {});
	await waiting;
	const actualSignal = host.session.agent.signal;
	assert.ok(actualSignal);
	await host.session.reload();
	release();
	await delivery;
	assert.equal(calls, 1);
	assert.equal(actualSignal.aborted, false);
	assert.equal(host.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === message.customType).length, 1);
});

test("cancellation before wrapper forwarding prevents native startup before an abort-waiting hook", { timeout: 5000 }, async t => {
	let wrapperEntered!: () => void;
	const wrapperWaiting = new Promise<void>(resolve => { wrapperEntered = resolve; });
	let forward!: () => void;
	const wrapperGate = new Promise<void>(resolve => { forward = resolve; });
	let startEntered!: () => void;
	const startWaiting = new Promise<void>(resolve => { startEntered = resolve; });
	let releaseHook!: () => void;
	const host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		pi.on("agent_start", async () => {
			const signal = host.session.agent.signal!;
			const hookGate = new Promise<void>(resolve => { releaseHook = resolve; });
			signal.addEventListener("abort", releaseHook, { once: true });
			if (signal.aborted) releaseHook();
			startEntered();
			await hookGate;
		});
	});
	t.after(() => { forward(); releaseHook?.(); });
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	const original = host.session.agent.prompt;
	host.session.agent.prompt = async function (...args) { wrapperEntered(); await wrapperGate; return Reflect.apply(original, this, args); };
	let modelCalls = 0;
	host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Unexpected startup."); }]);
	const outcome = runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion.then(() => undefined, error => error);
	await wrapperWaiting;
	const cancellation = host.session.abort();
	forward();
	const nativeEntered = await Promise.race([startWaiting.then(() => true), outcome.then(() => false)]);
	// Unwind a broken implementation before asserting, so the regression cannot hang.
	releaseHook?.();
	await cancellation;
	assert.equal(nativeEntered, false, "cancelled forwarding must reject before native Run allocation");
	assert.match(String(await outcome), /startup_admission_cancelled/);
	assert.equal(modelCalls, 0);
	assert.equal(host.session.sessionManager.getEntries().some(entry => entry.type === "custom_message"), false);
});

for (const interruption of ["abort", "reload"] as const) {
	test(`${interruption} invalidates a delayed custom wrapper while fresh dispatch still traverses it`, { timeout: 5000 }, async t => {
		const host = await createTestOwnerHost(t, pi => {
			registerSessionStartup(pi);
			pi.on("session_shutdown", () => disposeSessionStartup(host.session));
		});
		let runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
		let entered!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		t.after(release);
		const original = host.session.sendCustomMessage;
		let forwards = 0;
		host.session.sendCustomMessage = async (input, options) => {
			if (++forwards === 1) { entered(); await gate; }
			return original.call(host.session, input, options);
		};
		const outcome = runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion.then(() => undefined, error => error);
		await waiting;
		if (interruption === "abort") await host.session.abort();
		else {
			await host.session.reload();
			runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
		}
		release();
		assert.match(String(await outcome), /startup_admission_cancelled/);
		assert.equal(host.session.messages.length, 0);
		host.model.setResponses([fauxAssistantMessage("Fresh delivery.")]);
		await runtime.deliver({ kind: "custom", message, triggerTurn: true }).completion;
		assert.equal(forwards, 2);
		assert.equal(host.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === message.customType).length, 1);
	});
}
