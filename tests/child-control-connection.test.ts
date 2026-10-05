import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { createChildControlLoopback } from "./support/child-control-loopback.ts";

test("a reload keeps run identity: a Run the first generation reported is interruptible after the second binds", { timeout: 5_000 }, async t => {
	let releaseModel!: () => void;
	const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
	let modelStarted!: () => void;
	const started = new Promise<void>(resolve => { modelStarted = resolve; });
	t.after(() => releaseModel());
	const loopback = await createChildControlLoopback(t);
	loopback.host.model.setResponses([async () => {
		// The faux model ignores abort; interruption releases it like a real provider.
		loopback.host.session.agent.signal?.addEventListener("abort", releaseModel, { once: true });
		modelStarted();
		await modelGate;
		return fauxAssistantMessage("Interrupted work.");
	}]);
	const delivery = loopback.proxy.deliver({ kind: "user", content: "Long work." });
	const completion = delivery.completion.catch(() => undefined);
	await started;
	const reported = loopback.events.find(event => event.event === "agent.start");
	assert.ok(reported, "the first generation reports its Run");
	const { runId } = reported.payload as { runId: string };

	await loopback.reload();

	assert.deepEqual(await loopback.ownerChannel.request("run.interrupt", { runId }), { accepted: true });
	await completion;
	assert.deepEqual(loopback.events.filter(event => event.event === "runtime.fault"), []);
});

test("an Owner request that arrives between generations is rejected, never served by a disposed binding", { timeout: 5_000 }, async t => {
	const loopback = await createChildControlLoopback(t);
	await loopback.endGeneration("reload");
	await assert.rejects(
		loopback.ownerChannel.request("runtime.snapshot", {}),
		/child_runtime_control_unavailable/,
	);
	await loopback.bindGeneration();
	assert.equal((await loopback.ownerChannel.request("runtime.snapshot", {})).sessionId, loopback.host.session.sessionId);
});

test("an Owner event that arrives between generations keeps Control open for the next generation", { timeout: 5_000 }, async t => {
	const loopback = await createChildControlLoopback(t);
	const selector = {
		live: [],
		dormant: [],
		selectedAgentId: "child",
		humanAttention: [],
		operationalAttention: [],
		reports: [],
	};
	await loopback.endGeneration("reload");
	// The Owner publishes selector changes whenever its roster moves, including while
	// the child's Pi /reload has no generation bound.
	await loopback.ownerChannel.sendEvent("presentation.agents.changed", selector);
	const binding = await loopback.bindGeneration();

	assert.equal((await loopback.ownerChannel.request("runtime.snapshot", {})).sessionId, loopback.host.session.sessionId);
	assert.equal(loopback.hostShell.shutdowns, 0);
	await loopback.ownerChannel.sendEvent("presentation.agents.changed", selector);
	await loopback.ownerChannel.request("runtime.snapshot", {});
	assert.deepEqual(binding.activity.selectorSnapshot(), selector);
});

test("a closed Control channel reaches the host shell's shutdown port", { timeout: 5_000 }, async t => {
	const loopback = await createChildControlLoopback(t);
	assert.equal(loopback.hostShell.shutdowns, 0);
	await loopback.closeTransport();
	assert.equal(loopback.hostShell.shutdowns, 1);
	assert.deepEqual(await loopback.exited, { exitCode: 0, signal: 0 });
});
