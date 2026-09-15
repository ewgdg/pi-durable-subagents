import { EvidenceUnavailableError } from "../src/coordination/agent-record.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MessageCoordinator, type AgentMessageInput, type MessageBoundaryHooks } from "../src/coordination/messages.ts";
import { AgentWaitCoordinator } from "../src/coordination/agent-waits.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type { AgentRuntimeHost, AgentRunHandle, AgentRunEndCause, AgentRuntimeDelivery } from "../src/runtime/agent-runtime-host.ts";
import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import type { PiChildProcessLaunch, PiChildProcessRuntime, PiChildRuntimeEvent } from "../src/process-runtime/pi-child-process-runtime.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { participant } from "./support/request-history.ts";

const CUSTOM_TYPE = "agent-coordination.delivery-failure";

for (const operation of ["send", "request"] as const) test(`${operation}: admitted asynchronous failure notifies author without polling and preserves identity on retry`, { timeout: 5_000 }, async t => {
	const h = harness(t);
	const receipt = await h.send(operation);
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "sent");
	const id = "requestMessageId" in receipt ? receipt.requestMessageId : "messageId" in receipt ? receipt.messageId : assert.fail();
	h.recipient.fail(new Error("process transport lost"));
	await flush();
	const [notice] = h.notices();
	assert.equal(notice.messageId, id);
	assert.equal(notice.recipientAgentId, "recipient");
	assert.equal(notice.messageKind, operation === "send" ? "message" : "request");
	assert.deepEqual(notice.failure, { reason: "process transport lost", outcome: "uncertain" });
	assert.equal(notice.delivery.disposition, "not_observed");
	assert.equal(notice.delivery.inspectedThrough.agentId, "recipient");
	assert.match(notice.guidance, /poll.*retry.*cancel.*escalate/);
	assert.equal(h.recipient.dispatches.length, 1, "notification does not retry");
	assert.equal(h.messages.outstandingRequestIdsFor(h.author.record).length, operation === "request" ? 1 : 0);
	h.recipient.end("failure");
	await flush();
	assert.equal(h.notices().length, 1, "completion and Run failure are one attempt");
	const poll = await h.message("poll", { operation: "poll", messageId: id });
	assert.equal("disposition" in poll && poll.disposition, "not_observed");
	h.recipient.commitOnDispatch = true;
	await h.message("retry", { operation: "retry", messageId: id });
	await flush();
	const again = await h.message("retry-again", { operation: "retry", messageId: id });
	assert.equal("disposition" in again && again.disposition, operation === "request" ? "request_delivered" : "delivered");
	assert.equal(h.recipient.dispatches.length, 2, "retry after proof never duplicates Delivery");
});

test("a new failure after explicit retry remains observable", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const receipt = await h.send("send");
	assert.ok("messageId" in receipt);
	h.recipient.fail(new Error("first loss"));
	await flush();
	h.recipient.end("failure");
	h.author.settle();
	await flush();
	await h.message("retry", { operation: "retry", messageId: receipt.messageId });
	h.recipient.fail(new Error("second loss"));
	await flush();
	assert.deepEqual(h.notices().map(n => n.failure.reason), ["first loss", "second loss"]);
	assert.notEqual(h.notices()[0].notificationId, h.notices()[1].notificationId);
});

for (const lateProof of [false, true]) test(`held author queues notification and rechecks ${lateProof ? "late proof" : "failure"} before dispatch`, { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.author.blocked = true;
	await h.send("send");
	h.recipient.fail(new Error("transport loss"));
	await flush();
	assert.deepEqual(h.notices(), []);
	if (lateProof) h.recipient.commitLast();
	h.author.blocked = false;
	await h.messages.deliveryEligibilityChanged(h.author.record);
	await flush();
	assert.equal(h.notices().length, lateProof ? 0 : 1);
});

for (const state of ["dormant", "waiting", "settled"] as const) test(`notification activates ${state} author`, { timeout: 5_000 }, async t => {
	const h = harness(t);
	await h.send("request");
	let waiting: Promise<unknown> | undefined;
	if (state === "dormant") h.author.end("clean");
	if (state === "waiting") {
		h.author.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: "wait" }), { stopReason: "toolUse" }));
		waiting = h.waits.wait("author", "wait", {}, new AbortController().signal);
		await flush();
	}
	h.recipient.fail(new Error("lost"));
	await flush();
	assert.equal(h.notices().length, 1);
	assert.equal(h.author.record.host.observe().phase, "live");
	if (waiting) assert.deepEqual(await waiting, { disposition: "preempted" });
});

for (const when of ["before failure", "notice queued"] as const) test(`shutdown ${when} suppresses notification and author startup`, { timeout: 5_000 }, async t => {
	const h = harness(t);
	await h.send("send");
	if (when === "before failure") { h.shutdown = true; h.author.end("clean"); }
	else h.author.blocked = true;
	h.recipient.fail(new Error("shutdown loss"));
	await flush();
	h.shutdown = true;
	h.author.blocked = false;
	await h.messages.deliveryEligibilityChanged(h.author.record);
	await flush();
	assert.deepEqual(h.notices(), []);
	if (when === "before failure") assert.equal(h.author.record.host.observe().phase, "dormant");
});

test("committed Delivery followed by transport loss emits no failure notice", { timeout: 5_000 }, async t => {
	const h = harness(t);
	await h.send("send");
	h.recipient.commitLast();
	h.recipient.fail(new Error("lost after commitment"));
	await flush();
	assert.deepEqual(h.notices(), []);
});

test("initial non-admission is returned synchronously, not notified", { timeout: 5_000 }, async t => {
	const h = harness(t, { beforeDeliveryAdmission: () => "confirmed_failure" });
	const receipt = await h.send("send");
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "not_sent");
	await flush();
	assert.deepEqual(h.notices(), []);
});


test("admitted dispatch rejection notifies once and allows explicit retry without a settlement event", { timeout: 5_000 }, async t => {
	let dispatch!: () => void;
	const h = harness(t, { scheduleDeliveryDispatch: (context, release) => {
		if (context.recipientAgentId === "recipient") dispatch = release;
		else release();
	} });
	const receipt = await h.send("send");
	assert.ok("messageId" in receipt);
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "sent");
	h.recipient.rejectDispatch = true;
	dispatch();
	await flush();
	assert.equal(h.notices().length, 1);
	assert.match(h.notices()[0].failure.reason, /dispatch rejected/);
	h.recipient.rejectDispatch = false;
	h.recipient.commitOnDispatch = true;
	await h.message("retry", { operation: "retry", messageId: receipt.messageId });
	dispatch();
	await flush();
	assert.equal(h.recipient.dispatches.length, 1);
	assert.equal((await h.message("poll", { operation: "poll", messageId: receipt.messageId }) as { disposition: string }).disposition, "delivered");
});

test("recipient termination before dispatch confirms non-Delivery of this attempt", { timeout: 5_000 }, async t => {
	const h = harness(t, { scheduleDeliveryDispatch: (context, release) => {
		if (context.recipientAgentId !== "recipient") release();
	} });
	await h.send("send");
	h.recipient.end("termination");
	await flush();
	assert.equal(h.notices()[0].failure.outcome, "confirmed_not_delivered");
	assert.equal(h.recipient.dispatches.length, 0);
});


for (const evidenceUnavailable of [false, true]) test(
	"asynchronous dispatch failure releases its reservation without native settlement" + (evidenceUnavailable ? " while evidence is unavailable" : ""),
	{ timeout: 5_000 }, async t => {
	const h = harness(t);
	const receipt = await h.send("send");
	assert.ok("messageId" in receipt);
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "sent");
	const transcript = h.recipient.record.transcript;
	const inspect = transcript.inspect.bind(transcript);
	if (evidenceUnavailable) transcript.inspect = () => { throw new EvidenceUnavailableError("recipient evidence temporarily unavailable"); };
	h.recipient.fail(new Error("remote dispatch rejected"));
	await flush();
	assert.equal(h.recipient.record.host.observe().phase, "dormant", "failed dispatch must not strand a live reservation");
	assert.equal(h.notices()[0].failure.outcome, "uncertain");
	if (evidenceUnavailable) assert.deepEqual(h.notices()[0].delivery, { disposition: "indeterminate", reason: "inspection_incomplete" });
	transcript.inspect = inspect;
	h.recipient.commitOnDispatch = true;
	await h.message("retry", { operation: "retry", messageId: receipt.messageId });
	await flush();
	assert.equal(h.recipient.dispatches.length, 2);
	const repeated = await h.message("retry-again", { operation: "retry", messageId: receipt.messageId });
	assert.equal("disposition" in repeated && repeated.disposition, "delivered");
	assert.equal(h.recipient.dispatches.length, 2, "restored proof prevents duplicate retry Delivery");
});

function harness(t: { after(fn: () => void): void }, boundaryHooks?: MessageBoundaryHooks) {
	const author = runtimeParticipant("author", true);
	const recipient = runtimeParticipant("recipient", false);
	const agents = new Map([author, recipient].map(p => [p.record.identity.agentId, p.record]));
	const state = { shutdown: false };
	const messages = new MessageCoordinator({ agents, workflowPolicy: new WorkflowPolicyStore(), boundaryHooks,
		isShuttingDown: () => state.shutdown,
		preemptAgentWait: (record, reserve) => waits.preemptForInboundRequest(record, reserve),
	});
	const waits = new AgentWaitCoordinator({ agents, messages, suspendExecution: () => undefined, resumeExecution: async () => undefined });
	for (const p of [author, recipient]) messages.integrate(p.record);
	const originalEnd = recipient.end;
	recipient.end = cause => { messages.discardSchedulingInLane(recipient.record); originalEnd(cause); };
	t.after(() => { state.shutdown = true; waits.shutdown(); messages.shutdownDeliveryProgress(); });
	const message = async (id: string, input: AgentMessageInput) => {
		author.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", input, { id }), { stopReason: "toolUse" }));
		const result = await messages.execute("author", id, input);
		author.manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "agent_message", content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: false, timestamp: Date.now() });
		return result;
	};
	return { author, recipient, messages, waits, message,
		get shutdown() { return state.shutdown; }, set shutdown(value: boolean) { state.shutdown = value; },
		send: (operation: "send" | "request") => message("original", operation === "send"
			? { operation, targetAgent: "recipient", content: "Work" }
			: { title: "Fixture request", operation, targetAgent: "recipient", question: "Work?" }),
		notices: () => author.manager.getEntries().flatMap(entry => entry.type === "custom_message" && entry.customType === CUSTOM_TYPE ? [JSON.parse(entry.content as string)] : []),
	};
}

function runtimeParticipant(agentId: string, commitOnDispatch: boolean) {
	const p = participant(agentId);
	let handle: AgentRunHandle | undefined = { sequence: 1 };
	let sequence = 1;
	let attention: "none" | "agent_wait" = "none";
	const settled = new Set<(handle: AgentRunHandle, outcome: "settled") => void>();
	const ended = new Set<(handle: AgentRunHandle, cause: AgentRunEndCause) => void>();
	let reject!: (error: Error) => void;
	const runtime = { ...p, blocked: false, active: false, commitOnDispatch, rejectDispatch: false, dispatchOverride: undefined as ((input: AgentRuntimeDelivery) => { completion: Promise<void> }) | undefined, dispatches: [] as AgentRuntimeDelivery[],
		fail(error: Error) { reject(error); },
		settle() { if (handle) for (const handler of settled) handler(handle, "settled"); },
		commitLast() {
			const d = runtime.dispatches.at(-1);
			assert.ok(d?.kind === "custom");
			const m = d.message;
			p.manager.appendCustomMessageEntry(m.customType, m.content, m.display, "details" in m ? m.details : undefined);
		},
		end(cause: AgentRunEndCause) { const old = handle; handle = undefined; if (old) for (const handler of ended) handler(old, cause); },
	};
	p.record.host = {
		lane: new SerialLane(), currentHandle: () => handle, latestStartedRunSequence: () => sequence,
		isCurrent: (candidate: AgentRunHandle) => candidate === handle,
		startInLane: async () => (handle = { sequence: ++sequence }),
		addSettledHandler: (handler: (handle: AgentRunHandle, outcome: "settled") => void) => { settled.add(handler); return () => settled.delete(handler); }, setRunStartInitializer() {},
		discardAndEndInLane: async (cause: AgentRunEndCause) => runtime.end(cause),
		addEndedHandler: (handler: (handle: AgentRunHandle, cause: AgentRunEndCause) => void) => { ended.add(handler); return () => ended.delete(handler); },
		addRetentionReason() {}, removeRetentionReason() {}, hasRetentionReason: () => false,
		finishIsolatedResumptionInLane() {}, releaseIfEligibleInLane: () => "retained",
		blocksOrdinaryDelivery: () => runtime.blocked,
		currentWorkState: () => attention === "agent_wait" || runtime.active ? "active" : "settled",
		observe: () => handle ? { phase: "live", work: attention === "agent_wait" || runtime.active ? "active" : "settled", attention, retentionReasons: [] } : { phase: "dormant", retentionReasons: [] },
		beginAgentWait: () => { attention = "agent_wait"; }, endAgentWait: () => { attention = "none"; },
		currentRunFailed: () => false,
		deliverInLane: (input: AgentRuntimeDelivery) => {
			if (runtime.rejectDispatch) throw new Error("dispatch rejected before acceptance");
			runtime.dispatches.push(input);
			if (runtime.dispatchOverride) return runtime.dispatchOverride(input);
			if (runtime.commitOnDispatch) { runtime.commitLast(); return { completion: Promise.resolve() }; }
			return { completion: new Promise<void>((_resolve, fail) => { reject = fail; }) };
		},
	} as unknown as AgentRuntimeHost;
	return runtime;
}
async function flush() { for (let i = 0; i < 8; i++) await setImmediate(); }

for (const outcome of ["dispatch_rejected", "channel_loss", "process_exit", "committed_then_lost"] as const) test(
	`Control-backed child ${outcome} reaches author failure notification with truthful evidence`, { timeout: 5_000 }, async t => {
	const h = harness(t);
	let close!: (error?: unknown) => void;
	let resolveExit!: (exit: { exitCode: number; signal: number }) => void;
	let rejectResponse!: (error: Error) => void;
	const admitted = {
		snapshot: { cwd: "/runtime", model: { provider: "test", modelId: "test" }, thinking: "off", tools: [], skills: [], skillSources: [], extensions: [], toolExecutionModes: [], projectTrusted: true, sessionId: "recipient", sessionPath: "/sessions/recipient.jsonl", systemPrompt: null, loadContextFiles: true },
		channel: {
			onClose: (handler: typeof close) => { close = handler; return () => {}; },
			request: () => new Promise((_resolve, reject) => { rejectResponse = reject; }),
		},
	} as unknown as PiChildProcessRuntime;
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	const launch = {
		exited: new Promise(resolve => { resolveExit = resolve; }), ready: async () => admitted,
		cancelInitialization() {}, frame: () => ({ columns: 80, rows: 24, lines: [], cursor: { row: 0, column: 0, visible: false, style: "block", blink: false } }),
		writeInput() {}, resize() {}, addChangeHandler: () => () => {}, addFailureHandler: () => () => {},
		onEvent: (handler: (event: PiChildRuntimeEvent) => void) => { eventHandlers.add(handler); return () => eventHandlers.delete(handler); },
		dispose: async () => {},
	} as unknown as PiChildProcessLaunch;
	const runtime = new PiChildHostedRuntime(launch);
	await runtime.ready;
	t.after(() => { void runtime.dispose(); });
	h.recipient.dispatchOverride = input => runtime.deliver(input);
	const receipt = await h.send("request");
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "sent");
	await flush();
	if (outcome === "committed_then_lost") h.recipient.commitLast();
	if (outcome === "dispatch_rejected") rejectResponse(new Error("remote preflight rejected"));
	else if (outcome === "process_exit") resolveExit({ exitCode: 1, signal: 9 });
	else close(new Error("Control transport lost"));
	await flush();
	assert.equal(h.notices().length, outcome === "committed_then_lost" ? 0 : 1);
	if (outcome !== "committed_then_lost") {
		assert.equal(h.notices()[0].failure.outcome, "uncertain", "a transport error or remote exception is not non-Delivery proof");
		assert.equal(h.notices()[0].delivery.disposition, "not_observed");
	}
});

test("terminating a held author's queued notice does not restart it", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.author.blocked = true;
	await h.send("send");
	h.recipient.fail(new Error("lost"));
	await flush();
	h.messages.discardSchedulingInLane(h.author.record);
	h.author.end("termination");
	h.author.blocked = false;
	await h.messages.deliveryEligibilityChanged(h.author.record);
	await flush();
	assert.equal(h.author.record.host.observe().phase, "dormant");
	assert.deepEqual(h.notices(), []);
});

test("an active author gets the notice at its next settled boundary", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.author.active = true;
	await h.send("send");
	h.recipient.fail(new Error("lost"));
	await flush();
	assert.deepEqual(h.notices(), []);
	h.author.active = false;
	h.author.settle();
	await flush();
	assert.equal(h.notices().length, 1);
});

test("missing recipient transcript evidence produces uncertainty, not false non-Delivery", { timeout: 5_000 }, async t => {
	const h = harness(t, { scheduleDeliveryDispatch: (context, dispatch) => {
		if (context.recipientAgentId !== "recipient") dispatch();
	} });
	await h.send("send");
	const transcript = h.recipient.record.transcript;
	const inspect = transcript.inspect.bind(transcript);
	transcript.inspect = () => { throw new EvidenceUnavailableError("recipient evidence unavailable"); };
	h.recipient.end("termination");
	await flush();
	transcript.inspect = inspect;
	assert.equal(h.notices()[0].failure.outcome, "uncertain");
	assert.deepEqual(h.notices()[0].delivery, { disposition: "indeterminate", reason: "inspection_incomplete" });
});

test("rejected-dispatch cleanup errors remain operational diagnostics without repeated notices", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const receipt = await h.send("send");
	assert.ok("messageId" in receipt);
	h.recipient.record.host.discardAndEndInLane = async () => { throw new Error("runtime disposal failed"); };
	h.recipient.fail(new Error("dispatch rejected"));
	await flush();
	assert.equal(h.notices().length, 1);
	const failure = h.messages.blockedDeliveries().find(item => item.messageId === receipt.messageId);
	assert.equal(failure?.reason.kind, "scheduling_failure");
	assert.match(failure?.reason.kind === "scheduling_failure" ? failure.reason.diagnostic : "", /Delivery failure cleanup failed: runtime disposal failed/);
});

test("restored original Delivery proof prevents retry after unreadable-evidence cleanup", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const receipt = await h.send("send");
	assert.ok("messageId" in receipt);
	const transcript = h.recipient.record.transcript;
	const inspect = transcript.inspect.bind(transcript);
	transcript.inspect = () => { throw new EvidenceUnavailableError("recipient evidence temporarily unavailable"); };
	h.recipient.commitLast();
	h.recipient.fail(new Error("transport lost after possible commitment"));
	await flush();
	assert.equal(h.recipient.record.host.observe().phase, "dormant");
	assert.equal(h.notices()[0].failure.outcome, "uncertain");
	transcript.inspect = inspect;
	const retry = await h.message("retry", { operation: "retry", messageId: receipt.messageId });
	assert.equal("disposition" in retry && retry.disposition, "delivered");
	assert.equal(h.recipient.dispatches.length, 1);
});
