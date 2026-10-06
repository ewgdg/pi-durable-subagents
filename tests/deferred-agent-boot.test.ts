import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { DEFAULT_WORKFLOW_POLICY, WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type {
	AgentRunHandle,
	AgentRunState,
	AgentRuntimeHost,
} from "../src/runtime/agent-runtime-host.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";

type FakeAgent = {
	record: AgentRecord;
	run: AgentRunState;
	held: boolean;
	starts: number;
	deliveries: number;
	/** Request ids this Agent still owes an Answer for. */
	answersOwed: string[];
	/** Resolves a boot that the test holds open; undefined while no boot is pending. */
	finishStart?: () => void;
	/** Ends the current Run the way a Run Failure does: the Agent becomes dormant. */
	failRun: () => void;
};

/**
 * A Runtime host reduced to the Run facts the concurrency bound reads. A boot
 * leaves the Agent live and settled; a dispatched Delivery makes its work active.
 */
function fakeAgent(agentId: string, options: {
	directSpawnerAgentId?: string | null;
	run?: AgentRunState;
	holdStart?: boolean;
	failStart?: boolean;
} = {}): FakeAgent {
	let handle: AgentRunHandle | undefined = options.run && options.run.phase !== "dormant"
		? Object.freeze({ sequence: 1 })
		: undefined;
	const agent = {
		run: options.run ?? { phase: "dormant", retentionReasons: [] },
		held: false,
		starts: 0,
		deliveries: 0,
		answersOwed: [] as string[],
		failRun: () => {
			handle = undefined;
			agent.run = { phase: "dormant", retentionReasons: [] };
		},
	} as FakeAgent;
	const workState = () => agent.run.phase === "dormant" ? "unavailable" : agent.run.work ?? "settled";
	const host = {
		lane: new SerialLane(),
		currentHandle: () => handle,
		isCurrent: (candidate: AgentRunHandle) => candidate === handle,
		observe: () => agent.run,
		currentWorkState: workState,
		hasRetentionReason: (reason: string) => reason === "interruption_hold" && agent.held,
		requestRelationshipIds: (reason: string) => reason === "answer_owed" ? agent.answersOwed : [],
		blocksOrdinaryDelivery: () => agent.held,
		addSettledHandler: () => () => undefined,
		addEndedHandler: () => () => undefined,
		addRetentionReason: () => undefined,
		removeRetentionReason: () => undefined,
		startInLane: async () => {
			agent.starts += 1;
			if (options.failStart) throw new Error("Confirmed Run startup failure");
			if (options.holdStart) {
				await new Promise<void>((resolve) => {
					agent.finishStart = resolve;
				});
			}
			handle = Object.freeze({ sequence: agent.starts });
			agent.run = { phase: "live", work: "settled", attention: "none", retentionReasons: [] };
			return handle;
		},
		deliverInLane: () => {
			agent.deliveries += 1;
			agent.run = { phase: "live", work: "active", attention: "none", retentionReasons: [] };
			return { completion: new Promise<void>(() => undefined) };
		},
	} as unknown as AgentRuntimeHost;
	agent.record = {
		identity: {
			agentId,
			workflowId: "workflow",
			directSpawnerAgentId: options.directSpawnerAgentId === undefined ? "owner" : options.directSpawnerAgentId,
		},
		host,
		children: [],
	} as unknown as AgentRecord;
	return agent;
}

const WORKING: AgentRunState = { phase: "live", work: "active", attention: "none", retentionReasons: [] };

function schedulerFor(agents: readonly FakeAgent[], maxConcurrentAgentRuns: number, isShuttingDown = () => false) {
	return new MessageDeliveryScheduler({
		agents: new Map(agents.map(({ record }) => [record.identity.agentId, record])),
		isShuttingDown,
		workflowPolicy: new WorkflowPolicyStore(Object.freeze({
			...DEFAULT_WORKFLOW_POLICY,
			maxConcurrentAgentRuns,
		})),
	});
}

function admitWork(scheduler: MessageDeliveryScheduler, agent: FakeAgent, messageId = `work-for-${agent.record.identity.agentId}`) {
	return scheduler.admitCustom(agent.record, {
		messageId,
		deliveryMode: "deferred",
		customMessage: { customType: "test", content: "Work", display: false } as never,
		inspectProof: () => undefined,
	});
}

test("a child's boot waits for capacity, counts as progress meanwhile, and starts once a working Run parks in Agent Wait", async () => {
	const worker = fakeAgent("worker", { run: WORKING });
	const child = fakeAgent("child");
	const scheduler = schedulerFor([worker, child], 1);

	assert.equal(await admitWork(scheduler, child), "pending", "deferral is not a rejection");
	assert.equal(child.starts, 0, "the bound defers the boot");
	assert.equal(scheduler.isBootDeferred(child.record), true, "observation reports the child as queued");
	assert.equal(scheduler.hasProgress(child.record), true, "a parent waiting on a deferred child is not stalled");
	assert.equal(scheduler.hasAutonomousProgress(), true, "the Owner may park behind a deferred boot");
	assert.deepEqual(scheduler.blockedDeliveries(), [], "waiting for capacity is not a Delivery Stall");

	await scheduler.startDeferredBoots();
	assert.equal(child.starts, 0, "an unchanged count keeps the boot deferred");

	worker.run = { phase: "live", work: "settled", attention: "agent_wait", retentionReasons: [] };
	await scheduler.startDeferredBoots();
	assert.equal(child.starts, 1);
	assert.equal(child.deliveries, 1, "the deferred Delivery dispatches after the boot");
	assert.equal(scheduler.isBootDeferred(child.record), false);
	scheduler.shutdownProgress();
});

for (const [name, run, held] of [
	["parked in Agent Wait", { phase: "live", work: "settled", attention: "agent_wait", retentionReasons: [] }, false],
	["waiting for human input", { phase: "live", work: "active", attention: "input_required", retentionReasons: [] }, false],
	["settled but retained", { phase: "live", work: "settled", attention: "none", retentionReasons: [] }, false],
	["suspended", {
		phase: "live", work: "settled", attention: "none", retentionReasons: [],
		suspension: { reason: "runtime_error", evidence: { stage: "turn", error: "quota", provenance: "test" } },
	}, false],
	["under an Interruption Hold", { phase: "live", work: "active", attention: "none", retentionReasons: [] }, true],
] as const satisfies readonly (readonly [string, AgentRunState, boolean])[]) {
	test(`a Run ${name} does not hold a concurrency slot`, async () => {
		const other = fakeAgent("other", { run });
		other.held = held;
		const child = fakeAgent("child");
		const scheduler = schedulerFor([other, child], 1);
		assert.equal(await admitWork(scheduler, child), "pending");
		assert.equal(child.starts, 1);
		scheduler.shutdownProgress();
	});
}

test("a starting Run holds a concurrency slot", async () => {
	const starting = fakeAgent("starting", { run: { phase: "starting", attention: "none", retentionReasons: [] } });
	const child = fakeAgent("child");
	const scheduler = schedulerFor([starting, child], 1);
	assert.equal(await admitWork(scheduler, child), "pending");
	assert.equal(child.starts, 0);
	scheduler.shutdownProgress();
});

test("a Run settled while it still owes an Answer holds its slot until it answers", async () => {
	// Settling without an Answer is followed by an Obligation Reminder that restarts
	// the work; a boot in that gap would push concurrent child work past the bound.
	const obligor = fakeAgent("obligor", { run: { phase: "live", work: "settled", attention: "none", retentionReasons: [] } });
	obligor.answersOwed = ["request"];
	const child = fakeAgent("child");
	const scheduler = schedulerFor([obligor, child], 1);
	assert.equal(await admitWork(scheduler, child), "pending");
	assert.equal(child.starts, 0);

	obligor.answersOwed = [];
	await scheduler.startDeferredBoots();
	assert.equal(child.starts, 1, "answering frees the slot");
	scheduler.shutdownProgress();
});

test("a Run that owes an Answer but parks in Agent Wait does not hold a concurrency slot", async () => {
	// It may be waiting on the very child the bound would otherwise queue.
	const obligor = fakeAgent("obligor", { run: { phase: "live", work: "settled", attention: "agent_wait", retentionReasons: [] } });
	obligor.answersOwed = ["request"];
	const child = fakeAgent("child");
	const scheduler = schedulerFor([obligor, child], 1);
	assert.equal(await admitWork(scheduler, child), "pending");
	assert.equal(child.starts, 1);
	scheduler.shutdownProgress();
});

test("Owner and Moderator boots are never deferred, and their work holds no slot", async () => {
	const owner = fakeAgent("owner", { directSpawnerAgentId: null, run: WORKING });
	const moderator = fakeAgent("moderator", { directSpawnerAgentId: null });
	const child = fakeAgent("child");
	const scheduler = schedulerFor([owner, moderator, child], 1);
	assert.equal(await admitWork(scheduler, moderator), "pending");
	assert.equal(moderator.starts, 1, "only spawned children are deferred");
	assert.deepEqual(moderator.run, WORKING, "the Moderator is working");

	assert.equal(await admitWork(scheduler, child), "pending");
	assert.equal(child.starts, 1, "the bound caps concurrent child work only");
	scheduler.shutdownProgress();
});

test("one capacity check starts no more boots than free slots, counting boots still in flight", async () => {
	const worker = fakeAgent("worker", { run: WORKING });
	const first = fakeAgent("first", { holdStart: true });
	const second = fakeAgent("second");
	const scheduler = schedulerFor([worker, first, second], 1);
	await admitWork(scheduler, first);
	await admitWork(scheduler, second);

	worker.run = { phase: "live", work: "settled", attention: "none", retentionReasons: [] };
	const firstCheck = scheduler.startDeferredBoots();
	await scheduler.startDeferredBoots();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(first.starts, 1, "one free slot starts one deferred boot");
	assert.equal(second.starts, 0, "a boot in flight holds its slot before the Run reports starting");

	first.finishStart!();
	await firstCheck;
	assert.equal(first.deliveries, 1);
	await scheduler.startDeferredBoots();
	assert.equal(second.starts, 0, "the booted child's work now holds the slot");
	scheduler.shutdownProgress();
});

test("deferred boots start in deferral order, and a later boot queues behind them even when a slot is free", async () => {
	const worker = fakeAgent("worker", { run: WORKING });
	const earlier = fakeAgent("earlier");
	const later = fakeAgent("later");
	const scheduler = schedulerFor([worker, earlier, later], 1);
	assert.equal(await admitWork(scheduler, earlier), "pending");

	worker.run = { phase: "live", work: "settled", attention: "none", retentionReasons: [] };
	assert.equal(scheduler.mayBootNow(), false, "spawn must not boot past the queue");
	assert.equal(await admitWork(scheduler, later), "pending");
	assert.equal(later.starts, 0, "a free slot belongs to the oldest deferred boot");

	await scheduler.startDeferredBoots();
	assert.equal(earlier.starts, 1);
	assert.equal(later.starts, 0);
	scheduler.shutdownProgress();
});

test("a failed Run's leftover Delivery is not reported as a queued boot", async () => {
	const child = fakeAgent("child", { run: WORKING });
	const scheduler = schedulerFor([child], 1);
	assert.equal(await admitWork(scheduler, child), "pending", "work waits for the active turn to settle");
	child.failRun();
	assert.equal(scheduler.isBootDeferred(child.record), false, "only the boot queue makes a child queued");
	assert.equal(scheduler.hasProgress(child.record), false, "a Run Failure must stay visible");
	scheduler.shutdownProgress();
});

test("a deferred boot that fails hands its slot to the next queued child", async () => {
	const worker = fakeAgent("worker", { run: WORKING });
	const failing = fakeAgent("failing", { failStart: true });
	const next = fakeAgent("next");
	const scheduler = schedulerFor([worker, failing, next], 1);
	await admitWork(scheduler, failing);
	await admitWork(scheduler, next);

	worker.run = { phase: "live", work: "settled", attention: "none", retentionReasons: [] };
	await scheduler.startDeferredBoots();
	assert.equal(failing.starts, 1);
	assert.equal(next.starts, 1, "no further activity is needed to use the freed slot");
	scheduler.shutdownProgress();
});

test("no deferred boot starts once the Workflow is shutting down", async () => {
	const worker = fakeAgent("worker", { run: WORKING });
	const child = fakeAgent("child");
	let shuttingDown = false;
	const scheduler = schedulerFor([worker, child], 1, () => shuttingDown);
	await admitWork(scheduler, child);

	worker.run = { phase: "live", work: "settled", attention: "none", retentionReasons: [] };
	shuttingDown = true;
	await scheduler.startDeferredBoots();
	assert.equal(child.starts, 0);
	scheduler.shutdownProgress();
});
