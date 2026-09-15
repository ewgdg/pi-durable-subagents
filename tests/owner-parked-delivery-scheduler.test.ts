import assert from "node:assert/strict";
import test from "node:test";

import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type {
	AgentRunHandle,
	AgentRuntimeHost,
} from "../src/runtime/agent-runtime-host.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { ControllableOperationReviewClock } from "./support/controllable-operation-review-clock.ts";

test("park entry does not await the idle Deferred prompt Promise after Delivery proof commits", async () => {
	const handle: AgentRunHandle = Object.freeze({ sequence: 1 });
	let workState: "active" | "settled" = "settled";
	let proof: { agentId: string; entryId: string } | undefined;
	let resolvePrompt!: () => void;
	const promptCompletion = new Promise<void>((resolve) => {
		resolvePrompt = resolve;
	});
	const lane = new SerialLane();
	const host = {
		lane,
		currentHandle: () => handle,
		isCurrent: (candidate: AgentRunHandle) => candidate === handle,
		addSettledHandler: () => () => undefined,
		addEndedHandler: () => () => undefined,
		addRetentionReason: () => undefined,
		removeRetentionReason: () => undefined,
		blocksOrdinaryDelivery: () => false,
		hasRetentionReason: () => false,
		currentWorkState: () => workState,
		observe: () => ({
			phase: "live" as const,
			work: workState,
			attention: "none" as const,
			retentionReasons: [],
		}),
		deliverInLane: () => ({ completion: promptCompletion }),
	} as unknown as AgentRuntimeHost;
	const record = {
		identity: { agentId: "owner" },
		host,
	} as unknown as AgentRecord;
	const scheduler = new MessageDeliveryScheduler({
		workflowPolicy: new WorkflowPolicyStore(),
	});
	scheduler.integrate(record);
	assert.equal(await scheduler.admitCustom(record, {
		messageId: "idle-deferred-owner-delivery",
		deliveryMode: "deferred",
		customMessage: {
			customType: "owner-idle-delivery",
			content: "This Delivery starts an idle Owner prompt.",
			display: false,
		} as never,
		inspectProof: () => proof,
	}), "pending");
	assert.equal(scheduler.hasAutonomousProgress(), true, "uncommitted dispatch is an autonomous handoff");

	workState = "active";
	assert.equal(await withTimeout(
		lane.run(() => scheduler.beginParkingInLane(record, handle)),
		100,
	), false);
	proof = { agentId: "owner", entryId: "delivery-proof" };
	assert.equal(scheduler.hasAutonomousProgress(), false, "native prompt duration after proof is not delivery progress");
	await scheduler.reachSafeBoundary(record);
	assert.equal(scheduler.hasProgress(record), false, "a committed custom Delivery retained through a native prompt is not pending delivery work");
	assert.equal(await withTimeout(
		lane.run(() => scheduler.beginParkingInLane(record, handle)),
		100,
	), true);

	resolvePrompt();
	scheduler.endParkingInLane(record, handle);
});

test("queued Delivery counts only while it can advance autonomously and before its progress deadline", async () => {
	const handle: AgentRunHandle = { sequence: 1 };
	let attention: "none" | "agent_wait" | "input_required" = "none";
	let work: "active" | "settled" = "active";
	let held = false;
	let proof: { agentId: string; entryId: string } | undefined;
	const clock = new ControllableOperationReviewClock();
	const record = {
		identity: { agentId: "recipient" },
		host: {
			lane: new SerialLane(), currentHandle: () => handle,
			isCurrent: (candidate: AgentRunHandle) => candidate === handle,
			addSettledHandler: () => () => undefined, addEndedHandler: () => () => undefined,
			addRetentionReason: () => undefined, removeRetentionReason: () => undefined,
			hasRetentionReason: () => false, blocksOrdinaryDelivery: () => held,
			currentWorkState: () => work,
			observe: () => ({ phase: "live", work, attention, retentionReasons: [] }),
		} as unknown as AgentRuntimeHost,
	} as AgentRecord;
	const policy = new WorkflowPolicyStore();
	const scheduler = new MessageDeliveryScheduler({ workflowPolicy: policy, deliveryProgressClock: clock });
	await scheduler.admitCustom(record, {
		messageId: "ordinary-queued-work", deliveryMode: "deferred",
		customMessage: { customType: "test", content: "Work", display: false } as never,
		inspectProof: () => proof,
	});
	assert.equal(scheduler.hasAutonomousProgress(), true);
	attention = "agent_wait";
	assert.equal(scheduler.hasAutonomousProgress(), false, "ordinary input cannot preempt a dependency Wait");
	attention = "input_required";
	assert.equal(scheduler.hasAutonomousProgress(), false);
	attention = "none";
	held = true;
	assert.equal(scheduler.hasAutonomousProgress(), false);
	held = false;
	work = "settled";
	assert.equal(scheduler.hasAutonomousProgress(), true);
	clock.advanceBy(policy.current().deliveryProgressIntervalMs);
	assert.equal(scheduler.hasAutonomousProgress(), false, "lost eligible scheduling is not indefinite progress");
	proof = { agentId: "recipient", entryId: "proof" };
	assert.equal(scheduler.hasAutonomousProgress(), false);
	scheduler.shutdownProgress();
});

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Lane callback awaited native settlement")),
					milliseconds,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

for (const scenario of ["safe boundary", "replaced reservation", "replaced reservation failure", "replaced Run", "failed settlement", "failed completion", "failed settlement after success"] as const) {
	test(`replacement settlement tracks completion outside the lane: ${scenario}`, { timeout: 5_000 }, async () => {
		let handle: AgentRunHandle = Object.freeze({ sequence: 1 });
		let settled!: (handle: AgentRunHandle, outcome: "settled" | "failed") => void;
		let proof: { agentId: string; entryId: string } | undefined;
		let resolvePrompt!: () => void;
		let rejectPrompt!: (error: Error) => void;
		const promptCompletion = new Promise<void>((resolve, reject) => {
			resolvePrompt = resolve; rejectPrompt = reject;
		});
		let nextCompletion = promptCompletion;
		const lane = new SerialLane();
		const failures: string[] = [];
		const committed: string[] = [];
		const host = {
			lane,
			currentHandle: () => handle,
			isCurrent: (candidate: AgentRunHandle) => candidate === handle,
			addSettledHandler: (handler: typeof settled) => { settled = handler; return () => {}; },
			addEndedHandler: () => () => {},
			addRetentionReason() {},
			removeRetentionReason() {},
			blocksOrdinaryDelivery: () => false,
			currentWorkState: () => "settled",
			observe: () => ({ phase: "live", work: "settled", attention: "none", retentionReasons: [] }),
			deliverInLane: () => ({ completion: nextCompletion }),
			finishIsolatedResumptionInLane() {},
			discardAndEndInLane: async (cause: string) => { failures.push(cause); },
			releaseIfEligibleInLane() {},
		} as unknown as AgentRuntimeHost;
		const record = { identity: { agentId: "recipient" }, host } as unknown as AgentRecord;
		const scheduler = new MessageDeliveryScheduler({ workflowPolicy: new WorkflowPolicyStore() });
		scheduler.integrate(record);
		const delivery = (messageId: string) => ({
			messageId,
			deliveryMode: "deferred" as const,
			customMessage: { customType: "test", content: messageId, display: false } as never,
			inspectProof: () => proof,
			afterCommit: () => { committed.push(messageId); },
		});
		await scheduler.admitCustom(record, delivery("first"));
		settled(handle, scenario === "failed settlement" ? "failed" : "settled");
		if (scenario === "failed settlement after success") settled(handle, "failed");
		await new Promise<void>((resolve) => setImmediate(resolve));

		// Real Pi turn_end awaits this callback before native prompt completion.
		await withTimeout(scheduler.reachSafeBoundary(record), 100);
		if (scenario.startsWith("replaced")) {
			await lane.run(() => scheduler.discardInLane(record));
			if (scenario === "replaced Run") handle = Object.freeze({ sequence: 2 });
			nextCompletion = new Promise(() => {});
			await scheduler.admitCustom(record, delivery("second"));
		}
		proof = { agentId: "recipient", entryId: "proof" };
		if (scenario === "failed completion" || scenario === "replaced reservation failure") rejectPrompt(new Error("dispatch failed"));
		else resolvePrompt();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await lane.run(() => {});
		assert.deepEqual(failures, scenario.startsWith("failed") ? ["failure"] : []);
		if (scenario.startsWith("replaced")) {
			assert.equal(scheduler.hasDispatchReservation("recipient", "second"), true);
			assert.deepEqual(committed, []);
		} else if (scenario === "safe boundary") {
			assert.equal(scheduler.hasDispatchReservation("recipient", "first"), false);
			assert.deepEqual(committed, ["first"]);
		}
	});
}


for (const scenario of [
	"safe boundary", "cancelled reservation", "cancelled reservation failure", "replaced Run",
	"failed settlement", "failed settlement after cancellation", "queued drop", "frozen before dispatch",
] as const) {
	test(`Steer settlement revalidates dispatch tracking: ${scenario}`, { timeout: 5_000 }, async () => {
		let handle: AgentRunHandle = Object.freeze({ sequence: 1 });
		let settled!: (handle: AgentRunHandle, outcome: "settled" | "failed") => void;
		let proof: { agentId: string; entryId: string } | undefined;
		let resolvePrompt!: () => void;
		let rejectPrompt!: (error: Error) => void;
		const completion = new Promise<void>((resolve, reject) => {
			resolvePrompt = resolve; rejectPrompt = reject;
		});
		let nextCompletion = completion;
		const lane = new SerialLane();
		const failures: string[] = [];
		const committed: string[] = [];
		const record = {
			identity: { agentId: "recipient" },
			host: {
				lane,
				currentHandle: () => handle,
				isCurrent: (candidate: AgentRunHandle) => candidate === handle,
				addSettledHandler: (handler: typeof settled) => { settled = handler; return () => {}; },
				addEndedHandler: () => () => {},
				addRetentionReason() {},
				removeRetentionReason() {},
				blocksOrdinaryDelivery: () => false,
				currentWorkState: () => "settled",
				observe: () => ({ phase: "live", work: "settled", attention: "none", retentionReasons: [] }),
				deliverInLane: () => ({ completion: nextCompletion }),
				finishIsolatedResumptionInLane() {},
				discardAndEndInLane: async (cause: string) => { failures.push(cause); },
				releaseIfEligibleInLane() {},
			} as unknown as AgentRuntimeHost,
		} as unknown as AgentRecord;
		const scheduler = new MessageDeliveryScheduler({
			workflowPolicy: new WorkflowPolicyStore(),
			...(scenario === "frozen before dispatch" ? { afterSteerFreeze: () => "defer" as const } : {}),
		});
		scheduler.integrate(record);
		const delivery = (messageId: string) => ({
			messageId, deliveryMode: "steer" as const,
			deliveryItem: {
				source: { agentId: "sender", entryId: messageId, toolCallId: "call" },
				projection: { kind: "message" as const, messageId, fromAgentId: "sender", content: messageId },
			},
			inspectProof: () => proof,
			afterCommit: () => { committed.push(messageId); },
		});
		await scheduler.admit(record, delivery("first"));
		// Queued-active dispatch may finish on acceptance, before native settlement.
		if (scenario === "queued drop") resolvePrompt();
		settled(handle, scenario.startsWith("failed settlement") ? "failed" : "settled");
		await new Promise<void>((resolve) => setImmediate(resolve));
		await withTimeout(scheduler.reachSafeBoundary(record), 100);
		if (scenario === "queued drop" || scenario === "frozen before dispatch") {
			assert.deepEqual(failures, ["failure"], "unproven terminal input must still fail");
			return;
		}
		assert.deepEqual(failures, [], "preparation settlement must await actual dispatch");
		const replaced = scenario.startsWith("cancelled") || scenario === "replaced Run" ||
			scenario === "failed settlement after cancellation";
		if (replaced) {
			await lane.run(() => scheduler.prepareInterruptionInLane(record));
			await lane.run(() => scheduler.discardInLane(record));
			if (scenario === "replaced Run") handle = Object.freeze({ sequence: 2 });
			nextCompletion = new Promise(() => {});
			await scheduler.admit(record, delivery("second"));
		}
		proof = { agentId: "recipient", entryId: "proof" };
		if (scenario === "cancelled reservation failure") rejectPrompt(new Error("cancelled dispatch"));
		else resolvePrompt();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await lane.run(() => {});
		assert.deepEqual(failures, scenario.startsWith("failed settlement") ? ["failure"] : []);
		if (replaced && !scenario.startsWith("failed settlement")) {
			assert.equal(scheduler.hasDispatchReservation("recipient", "second"), true);
			assert.deepEqual(committed, []);
		} else if (scenario === "safe boundary") {
			assert.equal(scheduler.hasDispatchReservation("recipient", "first"), false);
			assert.deepEqual(committed, ["first"]);
		}
	});
}
