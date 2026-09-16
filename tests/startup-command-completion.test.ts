import assert from "node:assert/strict";
import test from "node:test";
import { bindSessionStartup, disposeSessionStartup, registerSessionStartup } from "../src/pi-integration/session-startup.ts";
import { createTestOwnerHost, type TestOwnerHost } from "./support/pi-host.ts";

test("an exact registered command can retire its session without failing completed preflight", { timeout: 5000 }, async t => {
	let host!: TestOwnerHost;
	let argumentsReceived: string | undefined;
	host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		pi.registerCommand("replace-test", { handler: async args => {
			argumentsReceived = args;
			await host.session.abort();
			disposeSessionStartup(host.session);
		} });
	});
	bindSessionStartup(host.session);
	let starts = 0;
	const unsubscribe = host.session.subscribe(event => { if (event.type === "agent_start") starts++; });
	t.after(unsubscribe);
	const preflights: boolean[] = [];
	const before = host.session.sessionManager.getEntries();
	await assert.doesNotReject(host.session.prompt("/replace-test exact args", { preflightResult: success => preflights.push(success) }));
	assert.equal(argumentsReceived, "exact args");
	assert.deepEqual(preflights, [true]);
	assert.equal(starts, 0);
	assert.deepEqual(host.session.sessionManager.getEntries(), before);
});

test("command completion does not authorize native model startup from its cancelled invocation", { timeout: 5000 }, async t => {
	let host!: TestOwnerHost;
	let nativeAttempt: Promise<void> | undefined;
	host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		pi.registerCommand("cancel-then-model", { handler: async () => {
			await host.session.abort();
			disposeSessionStartup(host.session);
			nativeAttempt = host.session.agent.prompt("Must not start");
			// Pi catches command-handler errors, so assert the outcome outside it.
			await nativeAttempt.catch(() => undefined);
		} });
	});
	bindSessionStartup(host.session);
	let starts = 0;
	const unsubscribe = host.session.subscribe(event => { if (event.type === "agent_start") starts++; });
	t.after(unsubscribe);
	await assert.doesNotReject(host.session.prompt("/cancel-then-model"));
	assert.ok(nativeAttempt);
	await assert.rejects(nativeAttempt, /startup_admission_cancelled/);
	assert.equal(starts, 0);
	assert.equal(host.session.messages.length, 0);
});

for (const { text, expandPromptTemplates } of [
	{ text: "ordinary human prompt", expandPromptTemplates: true },
	{ text: "/unknown-command", expandPromptTemplates: true },
	{ text: "/replace-test", expandPromptTemplates: false },
	{ text: "/replace-test\targs", expandPromptTemplates: true },
]) test(`cancelled model preflight remains fenced: ${JSON.stringify(text)}, expansion ${expandPromptTemplates}`, { timeout: 5000 }, async t => {
	let host!: TestOwnerHost;
	let commandCalls = 0;
	const preparing = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		pi.registerCommand("replace-test", { handler: async () => { commandCalls++; } });
		pi.on("input", async () => { preparing.resolve(); await release.promise; });
	});
	bindSessionStartup(host.session);
	let starts = 0;
	const unsubscribe = host.session.subscribe(event => { if (event.type === "agent_start") starts++; });
	t.after(unsubscribe);
	const rejected = assert.rejects(host.session.prompt(text, { expandPromptTemplates }), /startup_admission_cancelled/);
	await preparing.promise;
	await host.session.abort();
	disposeSessionStartup(host.session);
	release.resolve();
	await rejected;
	assert.equal(commandCalls, 0);
	assert.equal(starts, 0);
	assert.equal(host.session.messages.length, 0);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
