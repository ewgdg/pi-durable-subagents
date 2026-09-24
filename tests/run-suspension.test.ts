import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedAgentRuntime, HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

const evidence = { provider: "openai-codex", diagnostic: "Quota exhausted" };

function fixture(options: {
	queued?: { steering: string[]; followUp: string[] };
	runtimeUnavailable?: boolean;
	onAbort?: () => void;
} = {}) {
	let emit!: (event: HostedRuntimeEvent) => void;
	let starts = 0;
	const delivered: unknown[] = [];
	const runtime = {
		projection: undefined,
		subscribe(handler: typeof emit) { emit = handler; return () => undefined; },
		workState: () => options.runtimeUnavailable ? "unavailable" : "settled",
		hasPendingActivity: () => false,
		queuedInputCount: () => 0,
		clearQueue: async () => options.queued ?? { steering: [], followUp: [] },
		abort: async () => options.onAbort?.(),
		waitForIdle: async () => undefined,
		dispose: async () => undefined,
		deliver(input: unknown) { delivered.push(input); return { completion: Promise.resolve() }; },
	} as unknown as HostedAgentRuntime;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "quota-test", startSession: async () => { starts++; return { runtime }; },
	});
	return { host, delivered, starts: () => starts, emit: (event: HostedRuntimeEvent) => emit(event) };
}

/** Terminal quota evidence for whatever Run the fixture started last. */
function suspend(host: AgentRuntimeSupervisor, emit: (event: HostedRuntimeEvent) => void) {
	emit({ type: "agent_end", outcome: "error", willRetry: false, quota: evidence });
}

const terminalFailure = { stage: "model", error: "400 unrelated terminal failure", provenance: "test" };

test("a terminal error from a live Runtime retains the exact Run as a resumable stop", async () => {
	const { host, emit, delivered } = fixture();
	const handle = await host.startInLane();
	host.addRetentionReason("answer_owed", "incoming");
	emit({ type: "agent_end", outcome: "error", willRetry: false, failure: terminalFailure });
	emit({ type: "agent_settled" });
	assert.equal(host.currentRunFailed(), false);
	assert.equal(host.currentHandle(), handle);
	assert.deepEqual(host.currentRunSuspension(), { reason: "runtime_error", evidence: terminalFailure });
	assert.deepEqual(host.observe().suspension, { reason: "runtime_error", evidence: terminalFailure });
	assert.equal(host.blocksOrdinaryDelivery(), true);
	assert.deepEqual(host.residualRequestCounts(), { incoming: 1, outgoing: 0 });
	assert.equal(await host.releaseIfEligibleInLane(handle), "retained");
	assert.throws(() => host.deliverInLane({ kind: "user", content: "ordinary work" }), /run_suspended/);
	assert.equal(delivered.length, 0);
	const hold = host.currentResumptionHold()!;
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "explicit resume" });
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.equal(host.currentRunSuspension(), undefined);
	assert.equal(host.currentHandle(), handle);
	assert.equal(delivered.length, 1);
});

test("a terminal error whose Runtime is already gone keeps the terminal Run Failure path", async () => {
	const { host, emit } = fixture({ runtimeUnavailable: true });
	const handle = await host.startInLane();
	const failure = { stage: "runtime", error: "child_runtime_fault: transport lost", provenance: "pi-child-hosted-runtime" };
	const ended: unknown[][] = [];
	host.addEndedHandler((...args) => ended.push(args));
	emit({ type: "agent_end", outcome: "error", willRetry: false, failure });
	emit({ type: "agent_settled" });
	assert.equal(host.currentRunSuspension(), undefined);
	assert.equal(host.currentRunFailed(), true);
	await host.lane.run(() => host.discardAndEndInLane("failure"));
	assert.deepEqual(ended, [[handle, "failure", failure]]);
});

test("configured native retry retains its opportunity before terminal quota suspension", async () => {
	const { host, emit } = fixture();
	await host.startInLane();
	emit({ type: "agent_end", outcome: "error", willRetry: true, quota: evidence });
	assert.equal(host.currentRunSuspension(), undefined);
	assert.equal(host.currentRunFailed(), false);
});

test("quota suspension precedes Run failure, preserves identity and obligations, and gates input", async () => {
	const { host, emit, delivered } = fixture();
	const handle = await host.startInLane();
	host.addRetentionReason("answer_owed", "incoming");
	host.addRetentionReason("awaiting_answer", "outgoing");
	suspend(host, emit);
	emit({ type: "agent_settled" });
	assert.equal(host.currentRunFailed(), false);
	assert.equal(host.currentHandle(), handle);
	assert.equal(host.currentInterruptionHold(), undefined);
	assert.equal(host.currentRunSuspension()?.reason, "provider_quota");
	assert.equal(host.blocksOrdinaryDelivery(), true);
	assert.deepEqual(host.residualRequestCounts(), { incoming: 1, outgoing: 1 });
	assert.equal(await host.releaseIfEligibleInLane(handle), "retained");
	assert.throws(() => host.deliverInLane({ kind: "user", content: "editor input" }), /run_suspended/);
	assert.equal(delivered.length, 0);
	const hold = host.currentResumptionHold()!;
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "explicit control resume" });
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.equal(host.currentRunSuspension(), undefined);
	assert.equal(host.currentHandle(), handle);
});

test("only the exact Run and its resumption hold can clear a quota stop", async () => {
	const { host, emit } = fixture();
	const handle = await host.startInLane();
	suspend(host, emit);
	emit({ type: "agent_settled" });
	const hold = host.currentResumptionHold()!;
	// Clearing is bound to this exact stop: a foreign handle or hold is ignored rather
	// than treated as its own release, so a successor Run cannot adopt the stop.
	for (const foreign of [
		{ run: handle, sequence: hold.sequence + 1 },
		{ run: Object.freeze({ sequence: handle.sequence + 1 }), sequence: hold.sequence },
	]) {
		assert.equal(host.commitIsolatedResumptionInLane(foreign), false);
		assert.ok(host.currentRunSuspension(), "a mismatched hold must not release the stop");
	}
	assert.equal(await host.releaseIfEligibleInLane({ sequence: handle.sequence + 1 }), "stale");
	assert.deepEqual(host.currentRunSuspension(), { reason: "provider_quota", evidence });
	assert.equal(await host.releaseIfEligibleInLane(handle), "retained");
	assert.ok(host.currentRunSuspension());
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "explicit resume" });
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.equal(host.currentRunSuspension(), undefined);
});

test("termination clears the live quota stop, but relationship cancellation alone does not", async () => {
	const { host, emit, starts } = fixture();
	await host.startInLane();
	host.addRetentionReason("answer_owed", "incoming");
	suspend(host, emit);
	host.addRetentionReason("awaiting_answer", "outgoing");
	host.removeRetentionReason("awaiting_answer", "outgoing");
	assert.ok(host.currentRunSuspension());
	const ended: unknown[] = [];
	host.addEndedHandler((...args) => ended.push(args));
	await host.discardAndEndInLane("termination");
	assert.equal(host.currentRunSuspension(), undefined);
	assert.equal(host.observe().phase, "dormant");
	assert.equal(starts(), 1);
	assert.equal(ended.length, 1);
});

test("terminating a suspended Run observes it as ending while the Runtime aborts", async () => {
	let phaseDuringAbort: string | undefined;
	let observe!: () => string;
	const { host, emit } = fixture({ onAbort: () => { phaseDuringAbort = observe(); } });
	observe = () => host.observe().phase;
	await host.startInLane();
	emit({ type: "agent_end", outcome: "error", willRetry: false, failure: terminalFailure });
	assert.equal(host.currentRunSuspension()?.reason, "runtime_error");
	// Abort lets the child settle, and its settlement boundary re-enters the Owner.
	// It must see "ending" to stay off the lane termination already holds.
	await host.lane.run(() => host.discardAndEndInLane("termination"));
	assert.equal(phaseDuringAbort, "ending");
	assert.equal(host.observe().phase, "dormant");
});

test("native queued input waits for the isolated explicit resume turn", async () => {
	const { host, emit, delivered } = fixture({ queued: { steering: ["queued steer"], followUp: ["queued followup"] } });
	await host.startInLane();
	suspend(host, emit);
	await host.prepareSuspensionResumptionInLane();
	assert.equal(host.queuedInputCount(), 2);
	assert.equal(delivered.length, 0);
	const hold = host.currentResumptionHold()!;
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "explicit resume" });
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.equal(delivered.length, 1);
	emit({ type: "agent_end", outcome: "completed", willRetry: false });
	assert.equal(delivered.length, 3);
	assert.equal(host.queuedInputCount(), 0);
});

test("an immediate renewed quota before resume transcript confirmation cannot clear the new stop", async () => {
	const { host, emit } = fixture();
	await host.startInLane();
	suspend(host, emit);
	await host.prepareSuspensionResumptionInLane();
	const hold = host.currentResumptionHold()!;
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "explicit resume" });
	const renewed = { diagnostic: "Quota is still exhausted", provider: "openai-codex" };
	emit({ type: "agent_end", outcome: "error", willRetry: false, quota: renewed });
	assert.equal(host.runSuspensionBlocksExecution(), true);
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.deepEqual(host.currentRunSuspension()?.evidence, renewed);
	assert.notEqual(host.currentResumptionHold(), hold);
	assert.equal(host.currentRunFailed(), false);
	assert.equal(host.blocksOrdinaryDelivery(), true);
});

test("successful resume before confirmation releases held input once after confirmation", async () => {
	const { host, emit, delivered } = fixture({ queued: { steering: ["held steer"], followUp: ["held followup"] } });
	await host.startInLane();
	suspend(host, emit);
	await host.prepareSuspensionResumptionInLane();
	const hold = host.currentResumptionHold()!;
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "resume" });
	emit({ type: "agent_end", outcome: "completed", willRetry: false });
	emit({ type: "agent_settled" });
	assert.equal(delivered.length, 1, "queued input cannot overtake transcript confirmation");
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.equal(delivered.length, 3);
	host.finishIsolatedResumptionInLane(hold.run);
	emit({ type: "agent_end", outcome: "completed", willRetry: false });
	assert.equal(delivered.length, 3, "later success cannot duplicate queued input");
	assert.equal(host.queuedInputCount(), 0);
});

test("ordinary terminal error before resume confirmation replaces the stop with a Runtime error suspension", async () => {
	const { host, emit } = fixture();
	await host.startInLane();
	suspend(host, emit);
	await host.prepareSuspensionResumptionInLane();
	const hold = host.currentResumptionHold()!;
	const settlements: string[] = [];
	const ended: unknown[] = [];
	host.addSettledHandler((_handle, settlement) => settlements.push(settlement));
	host.addEndedHandler((...args) => ended.push(args));
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "resume" });
	const failure = { stage: "model", error: "invalid model", provenance: "test" };
	emit({ type: "agent_end", outcome: "error", willRetry: false, failure });
	emit({ type: "agent_settled" });
	assert.deepEqual(settlements, [], "terminal classification waits for resume commitment");
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	// The resumed attempt ended in a terminal error: the Run stops again on its own
	// retained evidence instead of failing or ending.
	assert.equal(host.currentRunFailed(), false);
	assert.deepEqual(host.currentRunSuspension(), { reason: "runtime_error", evidence: failure });
	assert.deepEqual(settlements, ["settled"]);
	assert.deepEqual(ended, []);
});

test("aborted resume before confirmation retains the original quota stop and queued input", async () => {
	const { host, emit, delivered } = fixture({ queued: { steering: [], followUp: ["still held"] } });
	await host.startInLane();
	suspend(host, emit);
	await host.prepareSuspensionResumptionInLane();
	const hold = host.currentResumptionHold()!;
	const suspension = host.currentRunSuspension();
	let suspensionTransitions = 0;
	host.setRunSuspensionHandler(() => suspensionTransitions++);
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "resume" });
	emit({ type: "agent_end", outcome: "aborted", willRetry: false });
	emit({ type: "agent_settled" });
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.equal(host.currentRunSuspension(), suspension);
	assert.equal(host.currentResumptionHold(), hold);
	assert.equal(host.currentInterruptionHold(), undefined);
	assert.equal(host.runSuspensionBlocksExecution(), true);
	assert.equal(host.currentRunFailed(), false);
	assert.equal(host.queuedInputCount(), 1);
	assert.equal(delivered.length, 1);
	assert.equal(suspensionTransitions, 0, "an aborted attempt emits no new suspension transition");
	assert.equal(host.beginIsolatedResumptionInLane(hold), true, "a later explicit retry remains possible");
});
