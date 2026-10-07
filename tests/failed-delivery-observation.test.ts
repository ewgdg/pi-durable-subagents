import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type { AgentRunState, AgentRuntimeHost } from "../src/runtime/agent-runtime-host.ts";

test("a failed Request remains blocked throughout unrelated recipient activity", () => {
	let run: AgentRunState = { phase: "dormant", retentionReasons: [] };
	let selected = false;
	let proof: { agentId: string; entryId: string } | undefined;
	const record = {
		identity: { agentId: "recipient" },
		host: {
			observe: () => run,
			hasRetentionReason: () => selected,
			blocksOrdinaryDelivery: () => false,
			currentWorkState: () => run.phase === "live" ? run.work : "settled",
		} as unknown as AgentRuntimeHost,
	} as AgentRecord;
	const scheduler = new MessageDeliveryScheduler({ agents: new Map(), workflowPolicy: new WorkflowPolicyStore() });
	scheduler.recordAdmissionFailure(record, {
		messageId: "request",
		deliveryMode: "deferred",
		isIncomingRequest: true,
		deliveryItem: {
			source: { agentId: "requester", entryId: "source", toolCallId: "call" },
			projection: { title: "Fixture request", kind: "request", requestMessageId: "request", fromAgentId: "requester", question: "Work" },
		},
		inspectProof: () => proof,
	}, new Error("Recipient Run ended before Delivery proof"));
	const blocked = scheduler.blockedDeliveries();
	assert.equal(blocked.length, 1);
	assert.equal(scheduler.hasAutonomousProgress(), false);
	run = { phase: "live", work: "active", attention: "none", retentionReasons: [] };
	assert.deepEqual(scheduler.blockedDeliveries(), blocked, "a nudge cannot restore failed scheduling");
	assert.equal(scheduler.hasAutonomousProgress(), false, "unrelated execution cannot restore failed Delivery progress");
	run = { phase: "live", work: "settled", attention: "none", retentionReasons: [] };
	assert.deepEqual(scheduler.blockedDeliveries(), blocked);
	selected = true;
	assert.deepEqual(scheduler.blockedDeliveries(), [], "explicit Human attendance still suspends moderation");
	selected = false;
	assert.deepEqual(scheduler.blockedDeliveries(), blocked);
	proof = { agentId: "recipient", entryId: "delivery" };
	assert.deepEqual(scheduler.blockedDeliveries(), [], "Delivery proof clears the condition");
	scheduler.shutdownProgress();
});

test("a suppression check that observes blocked deliveries does not recurse", () => {
	const run: AgentRunState = { phase: "live", work: "settled", attention: "none", retentionReasons: [] };
	const recordFor = (agentId: string) => ({
		identity: { agentId },
		host: {
			observe: () => run,
			hasRetentionReason: () => false,
			blocksOrdinaryDelivery: () => false,
			currentWorkState: () => "settled",
		} as unknown as AgentRuntimeHost,
	} as AgentRecord);
	const scheduler = new MessageDeliveryScheduler({ agents: new Map(), workflowPolicy: new WorkflowPolicyStore() });
	const deliveryFor = (messageId: string) => ({
		messageId,
		deliveryMode: "deferred" as const,
		deliveryItem: {
			source: { agentId: "sender", entryId: messageId, toolCallId: messageId },
			projection: { kind: "message" as const, messageId, fromAgentId: "sender", content: "Work" },
		},
	});
	let stalledProof: { agentId: string; entryId: string } | undefined;
	scheduler.recordAdmissionFailure(recordFor("recipient"), {
		...deliveryFor("stalled"),
		inspectProof: () => stalledProof,
	}, new Error("Recipient Run ended before Delivery proof"));
	// A Moderator reminder stays relevant only while the Delivery Stall it reports remains.
	scheduler.recordAdmissionFailure(recordFor("moderator"), {
		...deliveryFor("reminder"),
		inspectProof: () => undefined,
		isSuppressed: () => !scheduler.blockedDeliveries().some(({ messageId }) => messageId === "stalled"),
	}, new Error("Recipient Run ended before Delivery proof"));

	assert.deepEqual(scheduler.blockedDeliveries().map(({ messageId }) => messageId), ["stalled", "reminder"]);
	stalledProof = { agentId: "recipient", entryId: "delivery" };
	assert.deepEqual(scheduler.blockedDeliveries(), [], "proof of the stalled Delivery suppresses its reminder");
	scheduler.shutdownProgress();
});

test("a nested blocked-delivery read still honours suppression of deliveries tracked later", () => {
	const run: AgentRunState = { phase: "live", work: "settled", attention: "none", retentionReasons: [] };
	const recordFor = (agentId: string) => ({
		identity: { agentId },
		host: {
			observe: () => run,
			hasRetentionReason: () => false,
			blocksOrdinaryDelivery: () => false,
			currentWorkState: () => "settled",
		} as unknown as AgentRuntimeHost,
	} as AgentRecord);
	const scheduler = new MessageDeliveryScheduler({ agents: new Map(), workflowPolicy: new WorkflowPolicyStore() });
	const deliveryFor = (messageId: string) => ({
		messageId,
		deliveryMode: "deferred" as const,
		deliveryItem: {
			source: { agentId: "sender", entryId: messageId, toolCallId: messageId },
			projection: { kind: "message" as const, messageId, fromAgentId: "sender", content: "Work" },
		},
		inspectProof: () => undefined,
	});
	let stalledWithdrawn = false;
	let stalledChecks = 0;
	// The reminder is tracked first, so its check runs before the sweep reaches the stalled Delivery.
	scheduler.recordAdmissionFailure(recordFor("moderator"), {
		...deliveryFor("reminder"),
		isSuppressed: () => !scheduler.blockedDeliveries().some(({ messageId }) => messageId === "stalled"),
	}, new Error("Recipient Run ended before Delivery proof"));
	scheduler.recordAdmissionFailure(recordFor("recipient"), {
		...deliveryFor("stalled"),
		isSuppressed: () => {
			stalledChecks += 1;
			return stalledWithdrawn;
		},
	}, new Error("Recipient Run ended before Delivery proof"));

	assert.deepEqual(scheduler.blockedDeliveries().map(({ messageId }) => messageId), ["reminder", "stalled"]);
	stalledWithdrawn = true;
	stalledChecks = 0;
	assert.deepEqual(scheduler.blockedDeliveries(), [], "the withdrawn stall suppresses its reminder in the same sweep");
	assert.equal(stalledChecks, 1, "one sweep evaluates each suppression predicate once");
	scheduler.shutdownProgress();
});
