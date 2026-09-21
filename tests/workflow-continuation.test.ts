import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import type { MessageCoordinator } from "../src/coordination/messages.ts";
import type { ScheduledCustomDelivery } from "../src/coordination/message-delivery-scheduler.ts";
import { RunSupervisor } from "../src/coordination/run-supervision.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";

function harness() {
	let handle: { sequence: number } | undefined;
	let held = false;
	let hasInput = false;
	let requests = ["request"];
	let starts = 0;
	let afterStart = () => {};
	const deliveries: ScheduledCustomDelivery[] = [];
	const record = {
		identity: { agentId: "child" },
		transcript: { inspect: () => ({ entries: [] }) },
		host: {
			lane: new SerialLane(),
			observe: () => ({ phase: handle ? "live" : "dormant" }),
			currentHandle: () => handle,
			currentRunHasInput: () => hasInput,
			blocksOrdinaryDelivery: () => held,
			isCurrent: (candidate: unknown) => candidate === handle,
			async startInLane() { starts++; handle = { sequence: starts }; afterStart(); return handle; },
			removeRetentionReason() {},
			async releaseIfEligibleInLane() {},
		},
	} as unknown as AgentRecord;
	const supervisor = new RunSupervisor({
		agents: new Map([["child", record]]),
		ownerAgentId: "owner",
		messages: {
			async admitCustomDeliveryInLane(_record: AgentRecord, delivery: ScheduledCustomDelivery) {
				deliveries.push(delivery);
				return "pending";
			},
		} as unknown as MessageCoordinator,
	});
	return {
		activate: () => supervisor.continueDormantResponder(record, {
			requestMessageIds: ["request"],
			recovery: { isReady: () => true, view: () => ({ outstandingRequests: [] }) },
			recheckRequestMessageIds: () => requests,
		}),
		deliveries,
		get starts() { return starts; },
		setHeld: () => { held = true; },
		setRunning: () => { handle = { sequence: 99 }; hasInput = true; },
		resolve: () => { requests = []; },
		afterStart: (callback: () => void) => { afterStart = callback; },
	};
}

test("dormant continuation coalesces concurrent activation and uses runtime custom scheduling", async () => {
	const h = harness();
	assert.deepEqual(await Promise.all([h.activate(), h.activate()]), ["activated", "already_running"]);
	assert.equal(h.starts, 1);
	assert.equal(h.deliveries.length, 1);
	const delivery = h.deliveries[0]!;
	assert.equal(delivery.customMessage.customType, "agent-coordination.workflow-continuation");
	assert.match(delivery.customMessage.content, /Owner explicitly requested/);
	assert.match(delivery.customMessage.content, /side effects/);
	assert.equal("deliveryItem" in delivery, false);
	assert.equal(delivery.isSuppressed!(), false);
	h.resolve();
	assert.equal(delivery.isSuppressed!(), true);
});

test("running and held agents receive no continuation", async () => {
	for (const state of ["running", "held"] as const) {
		const h = harness();
		if (state === "running") h.setRunning(); else h.setHeld();
		assert.equal(await h.activate(), state === "running" ? "already_running" : "held");
		assert.equal(h.starts, 0);
		assert.equal(h.deliveries.length, 0);
	}
});

test("resolved evidence before or during startup suppresses continuation", async () => {
	for (const duringStartup of [false, true]) {
		const h = harness();
		if (duringStartup) h.afterStart(h.resolve); else h.resolve();
		assert.equal(await h.activate(), "resolved");
		assert.equal(h.deliveries.length, 0);
	}
});

test("activation is fenced when startup loses its exact Run", async () => {
	const h = harness();
	// Replace the handle after startup returns, before its await continuation.
	h.afterStart(() => queueMicrotask(h.setRunning));
	assert.equal(await h.activate(), "fenced");
	assert.equal(h.deliveries.length, 0);
});

test("scheduler suppression follows exact Run replacement", async () => {
	const h = harness();
	await h.activate();
	h.setRunning();
	assert.equal(h.deliveries[0]!.isSuppressed!(), true);
});

test("continuation crosses runtime transport and proves a custom entry, never an Agent Message", async () => {
	const { Check } = await import("typebox/value");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { agentControlMethods } = await import("../src/control/agent-control-protocol.ts");
	const { createWorkflowContinuation, inspectWorkflowContinuation } = await import("../src/protocol/workflow-continuation.ts");
	const { inspectMessageDeliveries } = await import("../src/protocol/message-delivery.ts");
	const { transcriptFromSessionManager } = await import("../src/pi-integration/session-manager-transcript.ts");
	const message = createWorkflowContinuation({ activationId: randomUUID(), agentId: "child", runSequence: 1, outstandingRequests: [] });
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		deliveryId: "continuation-delivery", delivery: { kind: "custom", message, triggerTurn: true },
	}), true);
	const session = SessionManager.inMemory(process.cwd(), { id: "child" });
	session.appendCustomEntry("agent-coordination.identity", { agentId: "child" });
	session.appendCustomMessageEntry(message.customType, message.content, message.display);
	const transcript = transcriptFromSessionManager(session).inspect();
	assert.ok(inspectWorkflowContinuation("child", transcript, message));
	assert.deepEqual(inspectMessageDeliveries({ recipientAgentId: "child", transcript }), []);
});

test("a cold successor activation does not reuse prior continuation proof at the same Run sequence", async () => {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { createWorkflowContinuation, inspectWorkflowContinuation } = await import("../src/protocol/workflow-continuation.ts");
	const { transcriptFromSessionManager } = await import("../src/pi-integration/session-manager-transcript.ts");
	const options = { agentId: "child", runSequence: 1, outstandingRequests: [] };
	const previous = createWorkflowContinuation({ ...options, activationId: randomUUID() });
	const session = SessionManager.inMemory(process.cwd(), { id: "child" });
	session.appendCustomEntry("agent-coordination.identity", { agentId: "child" });
	session.appendCustomMessageEntry(previous.customType, previous.content, previous.display);
	const transcript = transcriptFromSessionManager(session).inspect();
	const successor = createWorkflowContinuation({ ...options, activationId: randomUUID() });
	assert.ok(inspectWorkflowContinuation("child", transcript, previous));
	assert.equal(inspectWorkflowContinuation("child", transcript, successor), undefined);
	assert.notEqual(JSON.parse(previous.content).activationId, JSON.parse(successor.content).activationId);
	session.appendCustomMessageEntry(successor.customType, successor.content, successor.display);
	assert.ok(inspectWorkflowContinuation("child", transcriptFromSessionManager(session).inspect(), successor));
});

test("fresh host activations at the same Run sequence use different scheduling identities", async () => {
	const firstHost = harness();
	const secondHost = harness();
	await firstHost.activate();
	await secondHost.activate();
	const first = firstHost.deliveries[0]!;
	const second = secondHost.deliveries[0]!;
	assert.equal(JSON.parse(first.customMessage.content).runSequence, JSON.parse(second.customMessage.content).runSequence);
	assert.notEqual(first.messageId, second.messageId);
	assert.notEqual(first.customMessage.content, second.customMessage.content);
});
