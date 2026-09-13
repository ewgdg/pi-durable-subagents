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
	const scheduler = new MessageDeliveryScheduler({ workflowPolicy: new WorkflowPolicyStore() });
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
