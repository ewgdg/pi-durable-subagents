import assert from "node:assert/strict";
import test from "node:test";
import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { participant, requestHistory } from "./support/request-history.ts";

for (const attention of ["agent_wait", "none"] as const) {
	test(`Deferred Requests from another branch become eligible when ${attention === "agent_wait" ? "waiting" : "settled"}`, () => {
		const h = requestHistory();
		h.request();
		h.request();
		const otherBranch = participant("other-branch");
		h.agents.set(otherBranch.record.identity.agentId, otherBranch.record);
		h.request(otherBranch, h.responder, false);
		h.responder.record.host.observe = () => ({ phase: "live", work: "settled", attention, retentionReasons: [] });
		const evidence = new RequestEvidence(h.agents);
		assert.equal(evidence.obligationFrames(h.responder.record).length, 2);
		assert.equal(new MessageDeliveryScheduler({ workflowPolicy: new WorkflowPolicyStore() }).isRequestBlocked(h.responder.record, "deferred"), false);
	});
}

test("an active recipient does not admit Deferred Requests even without an incoming foreground", () => {
	const h = requestHistory();
	h.request(h.requester, h.responder, false);
	h.responder.record.host.observe = () => ({ phase: "live", work: "active", attention: "none", retentionReasons: [] });
	const evidence = new RequestEvidence(h.agents);
	assert.deepEqual(evidence.obligationFrames(h.responder.record), []);
	assert.equal(new MessageDeliveryScheduler({ workflowPolicy: new WorkflowPolicyStore() }).isRequestBlocked(h.responder.record, "deferred"), true);
});
