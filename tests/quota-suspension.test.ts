import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedAgentRuntime, HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

const evidence = { provider: "openai-codex", diagnostic: "Quota exhausted" };

function fixture() {
	let emit!: (event: HostedRuntimeEvent) => void;
	let starts = 0;
	const delivered: unknown[] = [];
	const runtime = {
		projection: undefined,
		subscribe(handler: typeof emit) { emit = handler; return () => undefined; },
		workState: () => "settled",
		hasPendingActivity: () => false,
		queuedInputCount: () => 0,
		clearQueue: async () => ({ steering: [], followUp: [] }),
		abort: async () => undefined,
		waitForIdle: async () => undefined,
		dispose: async () => undefined,
		deliver(input: unknown) { delivered.push(input); return { completion: Promise.resolve() }; },
	} as unknown as HostedAgentRuntime;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "quota-test", startSession: async () => { starts++; return { runtime }; },
	});
	return { host, delivered, starts: () => starts, emit: (event: HostedRuntimeEvent) => emit(event) };
}

test("configured native retry retains its opportunity before terminal quota suspension", async () => {
	const { host, emit } = fixture();
	await host.startInLane();
	emit({ type: "agent_end", outcome: "error", willRetry: true, quota: evidence });
	assert.equal(host.currentQuotaSuspension(), undefined);
	assert.equal(host.currentRunFailed(), false);
});

test("quota suspension precedes Run failure, preserves identity and obligations, and gates input", async () => {
	const { host, emit, delivered } = fixture();
	const handle = await host.startInLane();
	host.addRetentionReason("answer_owed", "incoming");
	host.addRetentionReason("awaiting_answer", "outgoing");
	emit({ type: "agent_end", outcome: "error", willRetry: false, quota: evidence });
	emit({ type: "agent_settled" });
	assert.equal(host.currentRunFailed(), false);
	assert.equal(host.currentHandle(), handle);
	assert.equal(host.currentInterruptionHold(), undefined);
	assert.equal(host.currentQuotaSuspension()?.reason, "provider_quota");
	assert.equal(host.blocksOrdinaryDelivery(), true);
	assert.deepEqual(host.residualRequestCounts(), { incoming: 1, outgoing: 1 });
	assert.equal(await host.releaseIfEligibleInLane(handle), "retained");
	assert.throws(() => host.deliverInLane({ kind: "user", content: "editor input" }), /quota_suspended/);
	assert.equal(delivered.length, 0);
	const hold = host.currentResumptionHold()!;
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "explicit control resume" });
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.equal(host.currentQuotaSuspension(), undefined);
	assert.equal(host.currentHandle(), handle);
});

test("cold restored suspension does not launch a Runtime; explicit resume retains exact Run", async () => {
	const { host, starts } = fixture();
	host.restoreQuotaSuspension({ reason: "provider_quota", evidence }, 9);
	const handle = host.currentHandle()!;
	host.addRetentionReason("answer_owed", "incoming");
	assert.equal(host.observe().phase, "live");
	assert.equal(starts(), 0);
	await assert.rejects(host.startInLane(), /quota_suspended/);
	await host.prepareQuotaResumptionInLane();
	assert.equal(starts(), 1);
	assert.equal(host.currentHandle(), handle);
	assert.equal(host.latestStartedRunSequence(), 9);
});

test("termination clears a cold suspension, but relationship cancellation alone does not", async () => {
	const { host, starts } = fixture();
	host.restoreQuotaSuspension({ reason: "provider_quota", evidence }, 4);
	host.addRetentionReason("answer_owed", "incoming");
	host.removeRetentionReason("answer_owed", "incoming");
	assert.ok(host.currentQuotaSuspension());
	const ended: unknown[] = [];
	host.addEndedHandler((...args) => ended.push(args));
	await host.discardAndEndInLane("termination");
	assert.equal(host.currentQuotaSuspension(), undefined);
	assert.equal(host.observe().phase, "dormant");
	assert.equal(starts(), 0);
	assert.equal(ended.length, 1);
});

test("failed cold resume preparation preserves the durable stop and exact Run", async () => {
	const host = AgentRuntimeSupervisor.createChild({ agentId: "cold-failure", startSession: async () => { throw new Error("launch unavailable"); } });
	host.restoreQuotaSuspension({ reason: "provider_quota", evidence }, 8);
	const handle = host.currentHandle();
	let ended = 0;
	host.addEndedHandler(() => ended++);
	await assert.rejects(host.prepareQuotaResumptionInLane(), /launch unavailable/);
	assert.equal(host.currentHandle(), handle);
	assert.ok(host.currentQuotaSuspension());
	assert.equal(ended, 0);
});

test("cold native queued input waits for the isolated explicit resume turn", async () => {
	const { host, emit, delivered } = fixture();
	host.restoreQuotaSuspension({ reason: "provider_quota", evidence }, 12, { steering: ["queued steer"], followUp: ["queued followup"] });
	assert.equal(host.queuedInputCount(), 2);
	await host.prepareQuotaResumptionInLane();
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
	emit({ type: "agent_end", outcome: "error", willRetry: false, quota: evidence });
	await host.prepareQuotaResumptionInLane();
	const hold = host.currentResumptionHold()!;
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "explicit resume" });
	const renewed = { diagnostic: "Quota is still exhausted", provider: "openai-codex" };
	emit({ type: "agent_end", outcome: "error", willRetry: false, quota: renewed });
	assert.equal(host.quotaSuspensionBlocksExecution(), true);
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.deepEqual(host.currentQuotaSuspension()?.evidence, renewed);
	assert.notEqual(host.currentResumptionHold(), hold);
	assert.equal(host.currentRunFailed(), false);
	assert.equal(host.blocksOrdinaryDelivery(), true);
});

test("successful resume before confirmation releases held input once after confirmation", async () => {
	const { host, emit, delivered } = fixture();
	host.restoreQuotaSuspension({ reason: "provider_quota", evidence }, 20, { steering: ["held steer"], followUp: ["held followup"] });
	await host.prepareQuotaResumptionInLane();
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

test("ordinary terminal error before resume confirmation remains a failed settlement", async () => {
	const { host, emit } = fixture();
	host.restoreQuotaSuspension({ reason: "provider_quota", evidence }, 21);
	await host.prepareQuotaResumptionInLane();
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
	assert.equal(host.currentRunFailed(), true);
	assert.equal(host.currentQuotaSuspension(), undefined);
	assert.deepEqual(settlements, ["failed"]);
	await host.discardAndEndInLane("failure");
	assert.deepEqual(ended, [[hold.run, "failure", failure]]);
});

test("aborted resume before confirmation retains the original quota stop and queued input", async () => {
	const { host, emit, delivered } = fixture();
	host.restoreQuotaSuspension({ reason: "provider_quota", evidence }, 22, { steering: [], followUp: ["still held"] });
	await host.prepareQuotaResumptionInLane();
	const hold = host.currentResumptionHold()!;
	const suspension = host.currentQuotaSuspension();
	let persistedTransitions = 0;
	host.setQuotaSuspensionHandler(() => persistedTransitions++);
	assert.equal(host.beginIsolatedResumptionInLane(hold), true);
	host.deliverInLane({ kind: "user", content: "resume" });
	emit({ type: "agent_end", outcome: "aborted", willRetry: false });
	emit({ type: "agent_settled" });
	assert.equal(host.commitIsolatedResumptionInLane(hold), true);
	assert.equal(host.currentQuotaSuspension(), suspension);
	assert.equal(host.currentResumptionHold(), hold);
	assert.equal(host.currentInterruptionHold(), undefined);
	assert.equal(host.quotaSuspensionBlocksExecution(), true);
	assert.equal(host.currentRunFailed(), false);
	assert.equal(host.queuedInputCount(), 1);
	assert.equal(delivered.length, 1);
	assert.equal(persistedTransitions, 0, "same continuous suspension does not create a new notice");
	assert.equal(host.beginIsolatedResumptionInLane(hold), true, "a later explicit retry remains possible");
});
