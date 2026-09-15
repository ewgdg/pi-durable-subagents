import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import type { PiChildProcessLaunch, PiChildProcessRuntime, PiChildRuntimeEvent } from "../src/process-runtime/pi-child-process-runtime.ts";
import { createChildRuntimeBinding } from "../src/process-runtime/child-runtime-bridge.ts";
import { registerSessionStartup } from "../src/pi-integration/session-startup.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { NativeInputSubmissionIdentity } from "../src/process-runtime/native-input-submission-identity.ts";
import { TerminalInputSubmissionAcknowledger } from "../src/process-runtime/terminal-input-submission-acknowledger.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

test("pending Delivery does not reserve a native execution identity; queued completion waits for settlement", { timeout: 5000 }, async t => {
	let context!: ExtensionContext;
	const host = await createTestOwnerHost(t, pi => {
		pi.on("session_start", (_event, ctx) => { context = ctx; });
	});
	const session = host.session;
	let releaseTransmission!: () => void;
	const transmission = new Promise<void>(resolve => { releaseTransmission = resolve; });
	let releaseModel!: () => void;
	const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
	let modelStarted!: () => void;
	const started = new Promise<void>(resolve => { modelStarted = resolve; });
	t.after(() => { releaseTransmission(); releaseModel(); });
	host.model.setResponses([async () => { modelStarted(); await modelGate; return fauxAssistantMessage("Native done."); }, fauxAssistantMessage("Delivery done.")]);
	const { parent, binding, events } = await attachRuntime(host, context, async method => { if (method === "message.deliver") await transmission; });
	t.after(async () => { binding.dispose(); await parent.dispose(); });
	const delivered = parent.deliver({ kind: "user", content: "Pending delivery.", deliverAs: "steer" });
	let completed = false;
	const completion = delivered.completion.then(() => { completed = true; });
	void completion.catch(() => {});
	const native = session.prompt("Native work.");
	await started;
	assert.equal(parent.workState(), "active");
	releaseTransmission();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(session.pendingMessageCount, 1, "Delivery has reached the real native queue");
	assert.equal(completed, false);
	assert.equal(parent.workState(), "active");
	releaseModel();
	await native;
	await completion;
	assert.equal(parent.workState(), "settled");
	assert.deepEqual(events.filter(event => event.event === "runtime.fault"), []);
});

async function attachRuntime(host: Awaited<ReturnType<typeof createTestOwnerHost>>, context: ExtensionContext, beforeRequest: (method: string) => Promise<void> = async () => {}) {
	const session = host.session;
	type ControlState = Parameters<typeof createChildRuntimeBinding>[0];
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	const events: Array<{ event: string; payload: unknown }> = [];
	// Keep transport outside this focused binding test; Pi and bridge lifecycle are real.
	const channel = {
		async sendEvent(event: string, payload: unknown) {
			events.push({ event, payload });
			for (const handler of eventHandlers) handler({ event, payload } as PiChildRuntimeEvent);
		},
	} as unknown as ControlState["channel"];
	const inputSubmissionAcknowledger = new TerminalInputSubmissionAcknowledger(() => {});
	const state: ControlState = {
		channel,
		waitProgressHandlers: new Map(),
		currentRunOutcome: "completed",
		nativeRunSequence: 0,
		queueIntentionTail: Promise.resolve(),
		shutdownStarted: false,
		inputSubmissionAcknowledger,
		nativeInputIdentity: new NativeInputSubmissionIdentity(),
	};
	const binding = createChildRuntimeBinding(
		state, host.runtime, context, () => {}, "recipient",
		inputSubmissionAcknowledger.bind(), () => {}, () => {},
	);
	state.currentBinding = binding;
	const parent = new PiChildHostedRuntime({
		exited: new Promise(() => {}),
		addChangeHandler: () => () => {},
		addFailureHandler: () => () => {},
		ready: async () => ({
			snapshot: {
				cwd: context.cwd, model: { provider: "test", modelId: "test" }, thinking: "off",
				tools: [], skills: [], skillSources: [], extensions: [], toolExecutionModes: [],
				projectTrusted: true, sessionId: session.sessionId, sessionPath: null,
				systemPrompt: null, loadContextFiles: true,
			},
			channel: {
				onClose: () => () => {},
				request: async (method: string, payload: unknown) => {
					await beforeRequest(method);
					return binding.handleOwnerRequest({
						method, payload, signal: new AbortController().signal,
					} as Parameters<typeof binding.handleOwnerRequest>[0]);
				},
			},
		} as unknown as PiChildProcessRuntime),
		onEvent: (handler: (event: PiChildRuntimeEvent) => void) => {
			eventHandlers.add(handler);
			return () => { eventHandlers.delete(handler); };
		},
		dispose: async () => {},
	} as unknown as PiChildProcessLaunch);
	await parent.ready;


	return { parent, binding, events, state };
}

test("interrupt cancels pending preflight without reserving an execution cycle", { timeout: 5000 }, async t => {
	let context!: ExtensionContext;
	let entered!: () => void;
	const preflight = new Promise<void>(resolve => { entered = resolve; });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.after(() => release());
	const host = await createTestOwnerHost(t, pi => {
		pi.on("session_start", (_event, ctx) => { context = ctx; });
		pi.on("input", async () => { entered(); await gate; return { action: "continue" }; });
	});
	host.model.setResponses([fauxAssistantMessage("Should not execute.")]);
	const { parent, binding, events } = await attachRuntime(host, context);
	t.after(async () => { binding.dispose(); await parent.dispose(); });
	const delivery = parent.deliver({ kind: "user", content: "Cancelled preflight." });
	const rejected = assert.rejects(delivery.completion, /child_turn_admission_cancelled/);
	await preflight;
	assert.equal(parent.workState(), "settled");
	await parent.abort();
	release();
	await rejected;
	assert.equal(events.some(event => event.event === "agent.start"), false);
	assert.equal(host.session.sessionManager.getEntries().some(entry => entry.type === "message" && JSON.stringify(entry.message).includes("Cancelled preflight.")), false);
});

for (const method of ["queue.clear", "run.interrupt"] as const) {
	test(`delayed ${method} revalidates its cycle at the mutation boundary`, { timeout: 5000 }, async t => {
		let context!: ExtensionContext;
		const host = await createTestOwnerHost(t, pi => { pi.on("session_start", (_event, ctx) => { context = ctx; }); });
		const { parent, binding, state } = await attachRuntime(host, context);
		t.after(async () => { binding.dispose(); await parent.dispose(); });
		state.currentRunId = state.latestRunId = "cycle-one";
		let release!: () => void;
		state.queueIntentionTail = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release());
		let mutations = 0;
		host.session.clearQueue = () => { mutations++; return { steering: [], followUp: [] }; };
		host.session.abort = async () => { mutations++; };
		const control = binding.handleOwnerRequest({ method, payload: { runId: "cycle-one" }, signal: new AbortController().signal });
		const rejected = assert.rejects(control, /stale_run/);
		await new Promise<void>(resolve => setImmediate(resolve));
		state.currentRunId = state.latestRunId = "cycle-two";
		release();
		await rejected;
		assert.equal(mutations, 0);
	});
}

for (const wrappedPrompt of [false, true]) {
	test(`late dispatch rejection cannot fault a real native successor${wrappedPrompt ? " with a post-bind async native prompt wrapper" : ""}`, { timeout: 5000 }, async t => {
		let context!: ExtensionContext;
		const host = await createTestOwnerHost(t, pi => { pi.on("session_start", (_event, ctx) => { context = ctx; }); });
		let releaseSuccessor!: () => void;
		const successorGate = new Promise<void>(resolve => { releaseSuccessor = resolve; });
		let started!: () => void;
		const successorStarted = new Promise<void>(resolve => { started = resolve; });
		let rejectEarlier!: (error: Error) => void;
		const earlierResult = new Promise<void>((_resolve, reject) => { rejectEarlier = reject; });
		void earlierResult.catch(() => {});
		t.after(() => { releaseSuccessor(); rejectEarlier(new Error("Cleanup")); });
		host.model.setResponses([fauxAssistantMessage("Earlier done."), async () => {
			started();
			await successorGate;
			return fauxAssistantMessage("Successor done.");
		}]);
		const { parent, binding, events } = await attachRuntime(host, context);
		if (wrappedPrompt) installAsyncNativePromptWrapper(host);
		const prompt = host.session.prompt.bind(host.session);
		host.session.prompt = async (text, options) => {
			await prompt(text, options);
			if (text === "Earlier delivery.") await earlierResult;
		};
		t.after(async () => { binding.dispose(); await parent.dispose(); });
		const delivery = parent.deliver({ kind: "user", content: "Earlier delivery." }, { inspectCommit: () => true });
		const rejected = assert.rejects(delivery.completion, /Late dispatch rejection/);
		assert.equal(await delivery.transcriptCommit, true);
		await host.session.waitForIdle();
		const successor = host.session.prompt("Native successor.");
		await successorStarted;
		const successorSignal = host.session.agent.signal;
		assert.ok(successorSignal);
		assert.deepEqual(await binding.handleOwnerRequest({
			method: "message.cancel", payload: { deliveryId: "delivery-1" }, signal: new AbortController().signal,
		}), { accepted: true });
		assert.equal(successorSignal.aborted, false, "an earlier dispatch cannot cancel its successor");
		rejectEarlier(new Error("Late dispatch rejection"));
		await rejected;
		assert.equal(parent.workState(), "active");
		assert.deepEqual(events.filter(event => event.event === "runtime.fault"), []);
		releaseSuccessor();
		await successor;
		assert.equal(parent.workState(), "settled");
	});
}

for (const wrappedPrompt of [false, true]) {
	test(`interrupt during awaited agent_start fences the admitted Delivery before model execution${wrappedPrompt ? " with a post-bind async native prompt wrapper" : ""}`, { timeout: 5000 }, async t => {
		let context!: ExtensionContext;
		let entered!: () => void;
		const startEntered = new Promise<void>(resolve => { entered = resolve; });
		let startSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release());
		let modelCalls = 0;
		const host = await createTestOwnerHost(t, pi => {
			pi.on("session_start", (_event, ctx) => { context = ctx; });
			pi.on("agent_start", async () => {
				startSignal = host.session.agent.signal;
				startSignal?.addEventListener("abort", release, { once: true });
				entered();
				await gate;
			});
		});
		host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Must not execute."); }]);
		const { parent, binding } = await attachRuntime(host, context);
		if (wrappedPrompt) installAsyncNativePromptWrapper(host);
		t.after(async () => { binding.dispose(); await parent.dispose(); });
		const delivery = parent.deliver({ kind: "user", content: "Interrupt before model execution." });
		const completion = delivery.completion.catch(error => {
			assert.match(String(error), /(?:child_turn|startup)_admission_cancelled/);
		});
		await startEntered;
		const interrupted = parent.abort();
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
		let context!: ExtensionContext;
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		t.after(() => release());
		const host = await createTestOwnerHost(t, pi => { pi.on("session_start", (_event, ctx) => { context = ctx; }); });
		host.model.setResponses([async () => { await gate; return fauxAssistantMessage("Done."); }]);
		const { parent, binding } = await attachRuntime(host, context);
		if (wrappedPrompt) installAsyncNativePromptWrapper(host);
		t.after(async () => { binding.dispose(); await parent.dispose(); });
		const delivery = parent.deliver({ kind: "user", content: "Cancel committed active delivery." }, { inspectCommit: () => true });
		assert.equal(await delivery.transcriptCommit, true);
		const signal = host.session.agent.signal;
		assert.ok(signal);
		const cancellation = binding.handleOwnerRequest({
			method: "message.cancel", payload: { deliveryId: "delivery-1" }, signal: new AbortController().signal,
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		const aborted = signal.aborted;
		release();
		assert.deepEqual(await cancellation, { accepted: true });
		await delivery.completion;
		assert.equal(aborted, true, "cancellation targets the actual native execution after transcript acknowledgment");
	});
}

function installAsyncNativePromptWrapper(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	beforeForward: () => Promise<void> = () => Promise.resolve(),
): void {
	const agent = host.session.agent;
	const prompt = agent.prompt;
	agent.prompt = async function (...args) {
		await beforeForward();
		return Reflect.apply(prompt, this, args);
	};
}

for (const kind of ["custom", "user"] as const) {
	test(`cancelling ${kind} Delivery in a post-bind native wrapper prevents awaited native startup`, { timeout: 5000 }, async t => {
		let context!: ExtensionContext;
		let enteredWrapper!: () => void;
		const wrapperEntered = new Promise<void>(resolve => { enteredWrapper = resolve; });
		let releaseWrapper!: () => void;
		const wrapperGate = new Promise<void>(resolve => { releaseWrapper = resolve; });
		let releaseStart!: () => void;
		const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
		t.after(() => { releaseWrapper(); releaseStart(); });
		let nativeStarts = 0;
		let modelCalls = 0;
		const host = await createTestOwnerHost(t, pi => {
			registerSessionStartup(pi);
			pi.on("session_start", (_event, ctx) => { context = ctx; });
			pi.on("agent_start", async () => {
				nativeStarts++;
				host.session.agent.signal?.addEventListener("abort", releaseStart, { once: true });
				await startGate;
			});
		});
		host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Must not execute."); }]);
		const { parent, binding, events } = await attachRuntime(host, context);
		t.after(async () => { binding.dispose(); await parent.dispose(); });
		installAsyncNativePromptWrapper(host, async () => { enteredWrapper(); await wrapperGate; });
		const content = `Cancel ${kind} before native startup.`;
		const source = { agentId: "cancel-author", entryId: "cancel-entry", toolCallId: "cancel-call" };
		const message = createMessageDelivery([{ source, projection: {
			kind: "message", messageId: deriveMessageIdentity(source), fromAgentId: source.agentId, content,
		} }]);
		const delivery = parent.deliver(kind === "custom"
			? { kind, message, triggerTurn: true }
			: { kind, content });
		const completion = delivery.completion.then(
			() => ({ error: undefined }),
			error => ({ error }),
		);
		await wrapperEntered;
		assert.deepEqual(await binding.handleOwnerRequest({
			method: "message.cancel", payload: { deliveryId: "delivery-1" }, signal: new AbortController().signal,
		}), { accepted: true });
		releaseWrapper();
		// A regressed startup hook must not leave the test waiting for cancellation.
		await new Promise<void>(resolve => setImmediate(resolve));
		releaseStart();
		const result = await completion;
		assert.equal(nativeStarts, 0, "cancelled dispatch must stop before native agent_start hooks");
		assert.match(String(result.error), /child_turn_admission_cancelled/);
		assert.equal(modelCalls, 0);
		assert.equal(events.some(event => event.event === "agent.start"), false);
		assert.equal(host.session.sessionManager.getEntries().some(entry =>
			(entry.type === "message" || entry.type === "custom_message") && JSON.stringify(entry).includes(content)), false);
	});
}

test("post-bind async native prompt wrapper completes a custom Delivery and releases startup for its successor", { timeout: 5000 }, async t => {
	let context!: ExtensionContext;
	const host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		pi.on("session_start", (_event, ctx) => { context = ctx; });
	});
	host.model.setResponses([fauxAssistantMessage("Custom processed."), fauxAssistantMessage("Successor processed.")]);
	const { parent, binding, events } = await attachRuntime(host, context);
	installAsyncNativePromptWrapper(host);
	t.after(async () => { binding.dispose(); await parent.dispose(); });
	const source = { agentId: "wrapper-author", entryId: "wrapper-entry", toolCallId: "wrapper-call" };
	const message = createMessageDelivery([{ source, projection: {
		kind: "message", messageId: deriveMessageIdentity(source), fromAgentId: source.agentId,
		content: "Custom work.",
	} }]);
	const delivery = parent.deliver({
		kind: "custom",
		message,
		triggerTurn: true,
	}, { inspectCommit: () => true });
	assert.equal(await delivery.transcriptCommit, true);
	await delivery.completion;
	await host.session.prompt("Native successor.");
	assert.equal(host.session.messages.filter(entry => entry.role === "custom" && entry.customType === message.customType).length, 1);
	assert.deepEqual(host.session.messages.filter(message => message.role === "assistant").map(message => message.content), [
		[{ type: "text", text: "Custom processed." }],
		[{ type: "text", text: "Successor processed." }],
	]);
	assert.deepEqual(events.filter(event => event.event === "runtime.fault"), []);
});

for (const matchesSubmission of [false, true]) {
	test(`forwarded native input ${matchesSubmission ? "transfers its exact preparation once" : "cannot take another submission's preparation"}`, { timeout: 5_000 }, async t => {
		let context!: ExtensionContext;
		let attached!: Awaited<ReturnType<typeof attachRuntime>>;
		let modelCalls = 0;
		const inputErrors: unknown[] = [];
		const host = await createTestOwnerHost(t, pi => {
			registerSessionStartup(pi);
			pi.on("session_start", (_event, ctx) => { context = ctx; });
			pi.on("input", event => event.text === "native original"
				? { action: "transform", text: "transformed native original" }
				: undefined);
			pi.on("input", async event => {
				if (event.source !== "interactive" || event.text !== "transformed native original") return;
				const { parent, binding } = attached;
				try {
					const transfer = binding.startupAdmission.captureInputHandoff();
					assert.ok(transfer);
					const handoff = { submissionSequence: 7, transfer, transferred: false };
					binding.nativeInputHandoff = handoff;
					const forwarded = parent.deliver({
						kind: "user", content: event.text,
						forwardedInput: { submissionSequence: matchesSubmission ? 7 : 8 },
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
					assert.equal(handoff.transferred, matchesSubmission);
				} catch (error) { inputErrors.push(error); }
				finally { binding.nativeInputHandoff = undefined; }
				return { action: "handled" };
			});
		});
		attached = await attachRuntime(host, context);
		t.after(async () => { attached.binding.dispose(); await attached.parent.dispose(); });
		host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Forwarded input processed."); }]);
		await host.session.prompt("native original");
		assert.deepEqual(inputErrors, [], "Pi reports hook exceptions, so assert handoff failures outside the hook");
		assert.equal(modelCalls, matchesSubmission ? 1 : 0);
		const inputs = host.session.messages.filter(message => message.role === "user");
		assert.equal(inputs.length, matchesSubmission ? 1 : 0);
		if (matchesSubmission) assert.deepEqual(inputs[0]!.content, [{ type: "text", text: "transformed native original" }]);
		assert.equal(host.session.pendingMessageCount, 0);
		assert.deepEqual(attached.events.filter(event => event.event === "runtime.fault"), []);
	});
}
