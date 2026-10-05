import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import {
	createChildControlLoopback,
	loopbackOwnerHandlers,
	type ChildControlLoopback,
} from "./support/child-control-loopback.ts";
import { oversizedPngImage } from "./support/test-images.ts";

test("pending Delivery does not reserve a native execution identity; queued completion waits for settlement", { timeout: 5000 }, async t => {
	let releaseTransmission!: () => void;
	const transmission = new Promise<void>(resolve => { releaseTransmission = resolve; });
	let releaseModel!: () => void;
	const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
	let modelStarted!: () => void;
	const started = new Promise<void>(resolve => { modelStarted = resolve; });
	t.after(() => { releaseTransmission(); releaseModel(); });
	const loopback = await createChildControlLoopback(t, {
		beforeOwnerRequest: async method => { if (method === "message.deliver") await transmission; },
	});
	const { proxy, host } = loopback;
	host.model.setResponses([async () => { modelStarted(); await modelGate; return fauxAssistantMessage("Native done."); }, fauxAssistantMessage("Delivery done.")]);
	const delivered = proxy.deliver({ kind: "user", content: "Pending delivery.", deliverAs: "steer" });
	let completed = false;
	const completion = delivered.completion.then(() => { completed = true; });
	void completion.catch(() => {});
	const native = loopback.submitNativeInput("Native work.");
	await started;
	assert.equal(proxy.workState(), "active");
	releaseTransmission();
	await waitUntil(() => host.session.pendingMessageCount === 1);
	assert.equal(completed, false);
	assert.equal(proxy.workState(), "active");
	releaseModel();
	await native;
	await completion;
	assert.equal(proxy.workState(), "settled");
	assertNoFaults(loopback);
});

test("human input carrying an image Pi resizes proves its commit through the child path", { timeout: 5000 }, async t => {
	const { proxy, host } = await createChildControlLoopback(t);
	host.model.setResponses([fauxAssistantMessage("Image received.")]);
	const image = oversizedPngImage();
	const delivery = proxy.deliver(
		{ kind: "user", content: [{ type: "text", text: "Look at this screenshot." }, image] },
		{ inspectCommit: () => true },
	);
	assert.equal(await delivery.transcriptCommit, true);
	await delivery.completion;
	const [committed] = host.session.messages.filter(message => message.role === "user");
	assert.ok(committed && Array.isArray(committed.content));
	const [text, persistedImage] = committed.content;
	assert.ok(text?.type === "text" && text.text.startsWith("Look at this screenshot.\n\n"), "Pi appends its resize hint");
	assert.ok(persistedImage?.type === "image" && persistedImage.data !== image.data, "Pi persists the resized image");
});

test("interrupt cancels pending preflight without reserving an execution cycle", { timeout: 5000 }, async t => {
	let entered!: () => void;
	const preflight = new Promise<void>(resolve => { entered = resolve; });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.after(() => release());
	const loopback = await createChildControlLoopback(t, {
		configure: pi => pi.on("input", async () => { entered(); await gate; return { action: "continue" }; }),
	});
	const { proxy, host } = loopback;
	host.model.setResponses([fauxAssistantMessage("Should not execute.")]);
	const delivery = proxy.deliver({ kind: "user", content: "Cancelled preflight." });
	const rejected = assert.rejects(delivery.completion, /child_turn_admission_cancelled/);
	await preflight;
	assert.equal(proxy.workState(), "settled");
	await proxy.abort();
	release();
	await rejected;
	assert.equal(loopback.events.some(event => event.event === "agent.start"), false);
	assert.equal(host.session.sessionManager.getEntries().some(entry => entry.type === "message" && JSON.stringify(entry.message).includes("Cancelled preflight.")), false);
});

for (const method of ["queue.clear", "run.interrupt"] as const) {
	test(`${method} naming a Run the child never reported is rejected before any mutation`, { timeout: 5000 }, async t => {
		let releaseModel!: () => void;
		const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
		let modelStarted!: () => void;
		const started = new Promise<void>(resolve => { modelStarted = resolve; });
		t.after(() => releaseModel());
		const loopback = await createChildControlLoopback(t);
		const { proxy, host, ownerChannel } = loopback;
		host.model.setResponses([async () => { modelStarted(); await modelGate; return fauxAssistantMessage("Done."); }]);
		const completion = proxy.deliver({ kind: "user", content: "Keep running." }).completion;
		await started;
		const steer = proxy.deliver({ kind: "user", content: "Queued steer.", deliverAs: "steer" }).completion;
		await waitUntil(() => host.session.pendingMessageCount === 1);
		const signal = host.session.agent.signal;
		await assert.rejects(ownerChannel.request(method, { runId: "native-run-2" }), /stale_run/);
		assert.equal(signal?.aborted, false);
		assert.equal(host.session.pendingMessageCount, 1);
		releaseModel();
		await Promise.all([completion, steer]);
		assertNoFaults(loopback);
	});
}

for (const wrappedPrompt of [false, true]) {
	test(`late dispatch rejection cannot fault a real native successor${wrappedPrompt ? " with a post-bind async native prompt wrapper" : ""}`, { timeout: 5000 }, async t => {
		let releaseSuccessor!: () => void;
		const successorGate = new Promise<void>(resolve => { releaseSuccessor = resolve; });
		let started!: () => void;
		const successorStarted = new Promise<void>(resolve => { started = resolve; });
		let rejectEarlier!: (error: Error) => void;
		const earlierResult = new Promise<void>((_resolve, reject) => { rejectEarlier = reject; });
		void earlierResult.catch(() => {});
		t.after(() => { releaseSuccessor(); rejectEarlier(new Error("Cleanup")); });
		const loopback = await createChildControlLoopback(t);
		const { proxy, host } = loopback;
		host.model.setResponses([fauxAssistantMessage("Earlier done."), async () => {
			started();
			await successorGate;
			return fauxAssistantMessage("Successor done.");
		}]);
		if (wrappedPrompt) installAsyncNativePromptWrapper(loopback);
		const prompt = host.session.prompt.bind(host.session);
		host.session.prompt = async (text, options) => {
			await prompt(text, options);
			if (text === "Earlier delivery.") await earlierResult;
		};
		const delivery = proxy.deliver({ kind: "user", content: "Earlier delivery." }, { inspectCommit: () => true });
		const rejected = assert.rejects(delivery.completion, /Late dispatch rejection/);
		assert.equal(await delivery.transcriptCommit, true);
		await host.session.waitForIdle();
		const successor = loopback.submitNativeInput("Native successor.");
		await successorStarted;
		const successorSignal = host.session.agent.signal;
		assert.ok(successorSignal);
		assert.deepEqual(await loopback.ownerChannel.request("message.cancel", { deliveryId: "delivery-1" }), { accepted: true });
		assert.equal(successorSignal.aborted, false, "an earlier dispatch cannot cancel its successor");
		rejectEarlier(new Error("Late dispatch rejection"));
		await rejected;
		assert.equal(proxy.workState(), "active");
		assertNoFaults(loopback);
		releaseSuccessor();
		await successor;
		await waitUntil(() => proxy.workState() === "settled");
	});
}

for (const wrappedPrompt of [false, true]) {
	test(`interrupt during awaited agent_start fences the admitted Delivery before model execution${wrappedPrompt ? " with a post-bind async native prompt wrapper" : ""}`, { timeout: 5000 }, async t => {
		let entered!: () => void;
		const startEntered = new Promise<void>(resolve => { entered = resolve; });
		let startSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release());
		let modelCalls = 0;
		const loopback: ChildControlLoopback = await createChildControlLoopback(t, {
			configure: pi => pi.on("agent_start", async () => {
				startSignal = loopback.host.session.agent.signal;
				startSignal?.addEventListener("abort", release, { once: true });
				entered();
				await gate;
			}),
		});
		const { proxy, host } = loopback;
		host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Must not execute."); }]);
		if (wrappedPrompt) installAsyncNativePromptWrapper(loopback);
		const delivery = proxy.deliver({ kind: "user", content: "Interrupt before model execution." });
		const completion = delivery.completion.catch(error => {
			assert.match(String(error), /(?:child_turn|startup)_admission_cancelled/);
		});
		await startEntered;
		const interrupted = proxy.abort();
		// Cancellation must release a hook that itself waits for abort. Snapshot
		// before the cleanup release so a missed signal fails without hanging.
		await new Promise<void>(resolve => setImmediate(resolve));
		const abortedDuringHook = startSignal?.aborted;
		release();
		await Promise.all([interrupted, completion]);
		assert.equal(abortedDuringHook, true, "cancellation must abort before the awaited start hook returns");
		assert.equal(modelCalls, 0, "interruption must survive the admission-to-start transition");
	});
}

for (const wrappedPrompt of [false, true]) {
	test(`Delivery cancellation remains correlated after transcript commit until dispatch settles${wrappedPrompt ? " with a post-bind async native prompt wrapper" : ""}`, { timeout: 5000 }, async t => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release());
		const loopback = await createChildControlLoopback(t);
		const { proxy, host } = loopback;
		host.model.setResponses([async () => { await gate; return fauxAssistantMessage("Done."); }]);
		if (wrappedPrompt) installAsyncNativePromptWrapper(loopback);
		const delivery = proxy.deliver({ kind: "user", content: "Cancel committed active delivery." }, { inspectCommit: () => true });
		assert.equal(await delivery.transcriptCommit, true);
		const signal = host.session.agent.signal;
		assert.ok(signal);
		const cancellation = loopback.ownerChannel.request("message.cancel", { deliveryId: "delivery-1" });
		await waitUntil(() => signal.aborted);
		release();
		assert.deepEqual(await cancellation, { accepted: true });
		await delivery.completion;
	});
}

for (const kind of ["custom", "user"] as const) {
	test(`cancelling ${kind} Delivery in a post-bind native wrapper prevents awaited native startup`, { timeout: 5000 }, async t => {
		let enteredWrapper!: () => void;
		const wrapperEntered = new Promise<void>(resolve => { enteredWrapper = resolve; });
		let releaseWrapper!: () => void;
		const wrapperGate = new Promise<void>(resolve => { releaseWrapper = resolve; });
		let releaseStart!: () => void;
		const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
		t.after(() => { releaseWrapper(); releaseStart(); });
		let nativeStarts = 0;
		let modelCalls = 0;
		const loopback: ChildControlLoopback = await createChildControlLoopback(t, {
			configure: pi => pi.on("agent_start", async () => {
				nativeStarts++;
				loopback.host.session.agent.signal?.addEventListener("abort", releaseStart, { once: true });
				await startGate;
			}),
		});
		const { proxy, host } = loopback;
		host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Must not execute."); }]);
		installAsyncNativePromptWrapper(loopback, async () => { enteredWrapper(); await wrapperGate; });
		const content = `Cancel ${kind} before native startup.`;
		const source = { agentId: "cancel-author", entryId: "cancel-entry", toolCallId: "cancel-call" };
		const message = createMessageDelivery([{ source, projection: {
			kind: "message", messageId: deriveMessageIdentity(source), fromAgentId: source.agentId, content,
		} }]);
		const delivery = proxy.deliver(kind === "custom"
			? { kind, message, triggerTurn: true }
			: { kind, content });
		const completion = delivery.completion.then(
			() => ({ error: undefined }),
			error => ({ error }),
		);
		await wrapperEntered;
		// The in-memory transport delivers synchronously; a real Owner's cancel arrives
		// in a later I/O turn, after Pi's accepted preflight has settled its continuation.
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(await loopback.ownerChannel.request("message.cancel", { deliveryId: "delivery-1" }), { accepted: true });
		releaseWrapper();
		// A regressed startup hook must not leave the test waiting for cancellation.
		await new Promise<void>(resolve => setImmediate(resolve));
		releaseStart();
		const result = await completion;
		assert.equal(nativeStarts, 0, "cancelled dispatch must stop before native agent_start hooks");
		assert.match(String(result.error), /child_turn_admission_cancelled/);
		assert.equal(modelCalls, 0);
		assert.equal(loopback.events.some(event => event.event === "agent.start"), false);
		assert.equal(host.session.sessionManager.getEntries().some(entry =>
			(entry.type === "message" || entry.type === "custom_message") && JSON.stringify(entry).includes(content)), false);
	});
}

test("post-bind async native prompt wrapper completes a custom Delivery and releases startup for its successor", { timeout: 5000 }, async t => {
	const loopback = await createChildControlLoopback(t);
	const { proxy, host } = loopback;
	host.model.setResponses([fauxAssistantMessage("Custom processed."), fauxAssistantMessage("Successor processed.")]);
	installAsyncNativePromptWrapper(loopback);
	const source = { agentId: "wrapper-author", entryId: "wrapper-entry", toolCallId: "wrapper-call" };
	const message = createMessageDelivery([{ source, projection: {
		kind: "message", messageId: deriveMessageIdentity(source), fromAgentId: source.agentId,
		content: "Custom work.",
	} }]);
	const delivery = proxy.deliver({
		kind: "custom",
		message,
		triggerTurn: true,
	}, { inspectCommit: () => true });
	assert.equal(await delivery.transcriptCommit, true);
	await delivery.completion;
	await loopback.submitNativeInput("Native successor.");
	assert.equal(host.session.messages.filter(entry => entry.role === "custom" && entry.customType === message.customType).length, 1);
	assert.deepEqual(host.session.messages.filter(message => message.role === "assistant").map(message => message.content), [
		[{ type: "text", text: "Custom processed." }],
		[{ type: "text", text: "Successor processed." }],
	]);
	assertNoFaults(loopback);
});

for (const matchesSubmission of [false, true]) {
	test(`forwarded native input ${matchesSubmission ? "transfers its exact preparation once" : "cannot take another submission's preparation"}`, { timeout: 5_000 }, async t => {
		let modelCalls = 0;
		const ownerErrors: unknown[] = [];
		const owner = loopbackOwnerHandlers();
		const loopback: ChildControlLoopback = await createChildControlLoopback(t, {
			configure: pi => pi.on("input", event => event.text === "native original"
				? { action: "transform", text: "transformed native original" }
				: undefined),
			// The Owner forwards native human input back to the child as a Delivery
			// naming the submission, exactly as Run supervision does.
			owner: { ...owner, lifecycle: { ...owner.lifecycle, async humanInputSubmitted({ text, submissionSequence }) {
				try {
					assert.ok(submissionSequence !== undefined);
					const forwarded = loopback.proxy.deliver({
						kind: "user", content: text,
						forwardedInput: { submissionSequence: matchesSubmission ? submissionSequence : submissionSequence + 1 },
					}, { inspectCommit: () => true });
					if (matchesSubmission) {
						assert.equal(await forwarded.transcriptCommit, true);
						await forwarded.completion;
					} else {
						await Promise.all([
							assert.rejects(forwarded.completion, /startup_preparation_busy/),
							assert.rejects(forwarded.transcriptCommit!, /startup_preparation_busy/),
						]);
					}
				} catch (error) { ownerErrors.push(error); }
				return "submitted";
			} } },
		});
		const { host } = loopback;
		host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Forwarded input processed."); }]);
		await loopback.submitNativeInput("native original");
		assert.deepEqual(ownerErrors, []);
		assert.equal(modelCalls, matchesSubmission ? 1 : 0);
		const inputs = host.session.messages.filter(message => message.role === "user");
		assert.equal(inputs.length, matchesSubmission ? 1 : 0);
		if (matchesSubmission) assert.deepEqual(inputs[0]!.content, [{ type: "text", text: "transformed native original" }]);
		assert.equal(host.session.pendingMessageCount, 0);
		assertNoFaults(loopback);
	});
}

function installAsyncNativePromptWrapper(
	{ host }: ChildControlLoopback,
	beforeForward: () => Promise<void> = () => Promise.resolve(),
): void {
	const agent = host.session.agent;
	const prompt = agent.prompt;
	agent.prompt = async function (...args) {
		await beforeForward();
		return Reflect.apply(prompt, this, args);
	};
}

function assertNoFaults({ events }: ChildControlLoopback): void {
	assert.deepEqual(events.filter(event => event.event === "runtime.fault"), []);
}

async function waitUntil(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the loopback child");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
