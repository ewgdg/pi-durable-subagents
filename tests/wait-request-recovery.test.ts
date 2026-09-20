import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, type JsonObject, type JsonValue } from "@earendil-works/pi-ai";
import { MessageCoordinator, type AgentMessageInput, type MessageBoundaryHooks } from "../src/coordination/messages.ts";
import { AgentWaitCoordinator, type AgentWaitBoundaryHooks } from "../src/coordination/agent-waits.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery, inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import type { AgentRuntimeHost, AgentRunHandle, AgentRuntimeDelivery, AgentRunEndCause } from "../src/runtime/agent-runtime-host.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { participant } from "./support/request-history.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { resumeWorkflow } from "../src/coordination/workflow-resume.ts";

for (const sourcePresent of [false, true]) test(`a delivered Request with ${sourcePresent ? "rejected" : "absent"} source can be answered locally across replay without Delivery`, { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const requestId = appendOrphanRequest(h, sourcePresent);
	await h.recover(true);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), [requestId]);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), []);
	assert.deepEqual(h.messages.recoveryRequestIds(h.responder.record), [requestId]);
	assert.deepEqual(h.messages.inspectRequest("responder", requestId), {
		requestMessageId: requestId, requesterAgentId: "requester", responderAgentId: "responder",
		title: "Preserved work", question: "Use the delivered instructions.",
	});
	const blocked = await h.message(h.responder, "orphan-send", { operation: "send", targetAgent: "requester", content: "Premature update" });
	assert.deepEqual(blocked, { disposition: "rejected", reason: "answer_required", requestMessageId: requestId });
	const input = { operation: "answer" as const, requestId: requestId.slice(-12), answer: "Completed work." };
	const receipt = await h.message(h.responder, "orphan-answer", input);
	assert.ok("disposition" in receipt && receipt.disposition === "committed");
	assert.equal("delivery" in receipt && receipt.delivery, "omitted");
	assert.equal("reason" in receipt && receipt.reason, "request_source_unavailable");
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), []);
	assert.deepEqual(h.deliveries(h.requester), []);
	assert.deepEqual(h.requester.dispatches, []);
	await h.recover(true);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), []);
	assert.deepEqual(h.messages.recoveryRequestIds(h.responder.record), []);
	assert.equal(h.messages.recoveryMessage("responder", "messageId" in receipt ? receipt.messageId : ""), undefined);
	const recovery = await resumeWorkflow({ workflowId: "requester", ownerAgentId: "requester",
		agents: new Map([h.requester, h.responder].map(p => [p.record.identity.agentId, p.record])),
		quarantinedAgentIds: new Set(), messages: h.messages,
		async activate() { throw new Error("Resolved local work must not activate again"); },
	});
	assert.deepEqual(recovery.outstandingRequests, []);
	const repeated = await h.messages.execute("responder", "orphan-answer", input);
	assert.equal("disposition" in repeated && repeated.disposition, "already_answered");
	await assert.rejects(h.message(h.responder, "duplicate-orphan-answer", { ...input, requestId }), /already answered/);
	assert.ok("messageId" in receipt);
	await assert.rejects(h.message(h.responder, "retry-local-answer", { operation: "retry", messageId: receipt.messageId }), /unknown_identity/);
	assert.deepEqual(h.deliveries(h.requester), []);
});

test("missing-source retry cancellation and Wait stay local while independent work remains usable", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const requestId = appendOrphanRequest(h);
	await h.recover(true);
	for (const operation of ["poll", "retry", "cancel"] as const) {
		const input = operation === "cancel"
			? { operation, requestMessageId: requestId, reason: "Cannot withdraw absent authorship" }
			: { operation, messageId: requestId };
		await assert.rejects(h.message(h.requester, `orphan-${operation}`, input), /unknown_identity/);
	}
	await assert.rejects(h.wait("orphan-selected-wait", { requestMessageIds: [requestId] }), /unknown_identity/);
	await assert.rejects(h.wait("orphan-unselected-wait"), /requires at least one outstanding/);
	await h.recover(true);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), [requestId]);
	assert.deepEqual(h.deliveries(h.requester), []);
	const continued: string[] = [];
	const recovery = await resumeWorkflow({ workflowId: "requester", ownerAgentId: "requester",
		agents: new Map([h.requester, h.responder].map(p => [p.record.identity.agentId, p.record])),
		quarantinedAgentIds: new Set(), messages: h.messages,
		async activate(record, requestIds) {
			continued.push(...requestIds);
			return { agentId: record.identity.agentId, requestIds, disposition: "skipped", reason: "already_running" };
		},
	});
	assert.deepEqual(recovery.outstandingRequests, []);
	assert.deepEqual(continued, [requestId], "continuation retains the duty without redelivering its source");
	assert.equal(h.deliveries(h.responder).length, 1);
	const valid = await h.message(h.requester, "independent-request", { operation: "request", title: "Independent", targetAgent: "responder", question: "Still usable", deliveryMode: "steer" });
	assert.ok("requestMessageId" in valid);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), [valid.requestMessageId]);
	const waiting = h.wait("independent-only-wait");
	await flush();
	await h.message(h.responder, "independent-answer", { operation: "answer", requestId: valid.requestMessageId, answer: "Independent work completed." });
	await h.tick();
	const joined = await waiting;
	assert.ok("answers" in joined);
	assert.deepEqual(joined.answers.map(answer => answer.requestMessageId), [valid.requestMessageId]);
	h.commitWait("independent-only-wait", joined);
});

for (const rejectedPart of ["call", "result"] as const) test(`a rejected Answer ${rejectedPart} cannot discharge a preserved recipient obligation`, { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const requestId = appendOrphanRequest(h, false);
	const toolCallId = "rejected-answer";
	const entryId = h.responder.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "answer", requestId, answer: rejectedPart === "call" ? "" : "Previously accepted work",
	}, { id: toolCallId })));
	commit(h.responder, toolCallId, "agent_message", {
		messageId: deriveMessageIdentity({ agentId: "responder", entryId, toolCallId }),
		requestMessageId: requestId, requestTitle: "Preserved work",
		messageStatus: rejectedPart === "result" ? "invalid-status" : "sent",
	});
	await h.recover(true);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), [requestId]);
	assert.deepEqual(h.messages.openIncomingRequests("responder").requests.map(request => request.requestMessageId), [requestId]);
	const receipt = await h.message(h.responder, "valid-answer-after-rejection", { operation: "answer", requestId, answer: "Reused the historical work and verified it." });
	assert.equal("disposition" in receipt && receipt.disposition, "committed");
	await h.recover(true);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), []);
	assert.deepEqual(h.deliveries(h.requester), []);
});

test("independent Cancellation Delivery closes an obligation whose Request source is absent", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const requestId = appendOrphanRequest(h, false);
	const source = { agentId: "requester", entryId: "cancel-entry", toolCallId: "cancel-call" };
	const delivery = createMessageDelivery([{ source, projection: {
		kind: "request_cancellation", cancellationId: deriveMessageIdentity(source), requestMessageId: requestId,
		fromAgentId: "requester", reason: "This work is no longer required.",
	} }]);
	h.responder.manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	await h.recover(true);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), []);
	await assert.rejects(h.message(h.responder, "answer-after-orphan-cancel", { operation: "answer", requestId, answer: "Too late" }), /was cancelled/);
});

function appendOrphanRequest(h: ReturnType<typeof harness>, sourcePresent = true): string {
	const toolCallId = "rejected-request-source";
	const entryId = sourcePresent ? h.requester.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: "responder", question: "Missing mandatory title",
	}, { id: toolCallId }))) : "absent-source-entry";
	const source = { agentId: "requester", entryId, toolCallId };
	const requestMessageId = deriveMessageIdentity(source);
	if (sourcePresent) commit(h.requester, toolCallId, "agent_message", { requestMessageId, targetAgentId: "responder", messageStatus: "sent" });
	const delivery = createMessageDelivery([{ source, projection: {
		kind: "request", requestMessageId, fromAgentId: "requester", title: "Preserved work", question: "Use the delivered instructions.",
	} }]);
	h.responder.manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	return requestMessageId;
}

test("fresh Wait restores a lost original Request after passive coordinator recovery and completes with Answer proof", async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const receipt = await h.message(h.requester, "original", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Need the decision before proceeding.",
		contextPreparation: { workScale: "medium", contextDependence: "high" },
	});
	assert.ok("requestMessageId" in receipt);
	const requestId = receipt.requestMessageId;
	await h.recover();
	h.responder.blocked = false;
	assert.deepEqual(h.deliveries(h.responder), [], "cold relationship recovery is passive");
	const waiting = h.wait("after-recovery");
	await flush();
	assert.deepEqual(h.deliveries(h.responder).map(item => item.projection), [{
		title: "Fixture request",
		kind: "request", requestMessageId: requestId, fromAgentId: "requester",
		question: "Need the decision before proceeding.",
	}]);
	assert.deepEqual(h.responder.dispatches[0]?.kind === "custom" &&
		h.responder.dispatches[0].workingZonePreparation?.intent,
		{ workScale: "medium", contextDependence: "high" });
	await h.message(h.responder, "answer", { operation: "answer", requestId, answer: "Proceed." });
	await h.tick();
	const result = await waiting;
	assert.ok("answers" in result);
	assert.equal(result.answers.length, 1);
	assert.equal(result.answers[0]?.requestMessageId, requestId);
	h.commitWait("after-recovery", result);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), []);
	assert.equal(h.deliveries(h.responder).length, 1);
});

test("Wait coalesces a held queue, repairs loss in the same Run, and delivers only its captured Request", async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const receipt = await h.message(h.requester, "held-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Captured work.",
	});
	assert.ok("requestMessageId" in receipt);
	h.wait("held-wait");
	await flush();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 0, "Wait respects the Hold");
	await h.responder.record.host.lane.run(() => h.messages.discardSchedulingInLane(h.responder.record));
	// Later canonical sources are deliberately not scheduled and cannot enter the fixed snapshot.
	call(h.requester, "later-request", "agent_message", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Later unrelated work.",
	});
	h.responder.blocked = false;
	await h.tick();
	await h.tick();
	assert.deepEqual(h.deliveries(h.responder).map(d => d.projection.kind === "request" && d.projection.requestMessageId),
		[receipt.requestMessageId]);
});

test("fresh Wait may start a Dormant recipient, but a parked Wait cannot undo later termination", async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "lost-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Renewed work.",
	});
	h.responder.stop();
	await h.recover();
	h.wait("fresh-dormant-wait");
	await flush();
	assert.equal(h.responder.record.host.observe().phase, "live");
	assert.equal(h.deliveries(h.responder).length, 0);
	await h.responder.record.host.lane.run(() => {
		h.responder.stop();
		h.messages.discardSchedulingInLane(h.responder.record);
	});
	h.responder.blocked = false;
	await h.tick();
	await h.tick();
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.equal(h.deliveries(h.responder).length, 0);
});

for (const selected of [false, true]) test(`${selected ? "selected" : "all-Requests"} cancellation during Wait suppresses lost Request scheduling and ends the join`, { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const receipt = await h.message(h.requester, "cancelled-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Work no longer needed.",
	});
	assert.ok("requestMessageId" in receipt);
	const waiting = assert.rejects(h.wait("cancelled-wait", selected ? { requestMessageIds: [receipt.requestMessageId] } : {}), /was cancelled/);
	await flush();
	await h.responder.record.host.lane.run(() => h.messages.discardSchedulingInLane(h.responder.record));
	await h.message(h.requester, "cancel", {
		operation: "cancel", requestMessageId: receipt.requestMessageId, reason: "Stop waiting for this work.",
	});
	h.responder.blocked = false;
	await h.tick();
	await waiting;
	assert.equal(h.deliveries(h.responder).length, 0);
});

test("delivered Requests are never replayed and committed Answers remain retrievable from a Dormant responder", async (t) => {
	const h = harness(t);
	const receipt = await h.message(h.requester, "delivered-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Work already received.",
	});
	assert.ok("requestMessageId" in receipt);
	h.requester.blocked = true;
	await h.message(h.responder, "committed-answer", {
		operation: "answer", requestId: receipt.requestMessageId, answer: "Completed.",
	});
	h.responder.stop();
	await h.recover();
	const result = await h.wait("retrieve-answer");
	h.commitWait("retrieve-answer", result);
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.equal(h.deliveries(h.responder).length, 1);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), []);
});

test("a delivered Request does not consume fresh Wait admission for its undelivered sibling on a Dormant responder", async (t) => {
	const h = harness(t);
	const first = await h.message(h.requester, "delivered-before-stop", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "First obligation was delivered.",
	});
	// Simulate active work so the later Deferred Request must survive recovery.
	h.responder.blocked = true;
	const sibling = await h.message(h.requester, "queued-before-stop", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Sibling still needs delivery.",
	});
	assert.ok("requestMessageId" in first && "requestMessageId" in sibling);
	assert.equal(h.deliveries(h.responder).length, 1);
	h.responder.stop();
	await h.recover();
	h.responder.blocked = false;
	const waiting = h.wait("renew-mixed-delivery-snapshot");
	await flush();
	assert.equal(h.responder.record.host.observe().phase, "live",
		"inspecting delivered work must leave dormant admission available for its sibling");
	assert.deepEqual(h.deliveries(h.responder).map(delivery =>
		delivery.projection.kind === "request" && delivery.projection.requestMessageId),
		[first.requestMessageId, sibling.requestMessageId], "renewed Deferred work enters at settlement while the earlier obligation remains open");
	await h.message(h.responder, "first-answer-after-stop", {
		operation: "answer", requestId: first.requestMessageId, answer: "First obligation completed.",
	});
	await h.tick();
	assert.deepEqual(h.deliveries(h.responder).map(delivery =>
		delivery.projection.kind === "request" && delivery.projection.requestMessageId),
		[first.requestMessageId, sibling.requestMessageId]);
	await h.message(h.responder, "sibling-answer-after-stop", {
		operation: "answer", requestId: sibling.requestMessageId, answer: "Sibling completed.",
	});
	await h.tick();
	h.commitWait("renew-mixed-delivery-snapshot", await waiting);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), []);
});

test("a delivered unanswered Request stays awaited without starting a Dormant responder", async (t) => {
	const h = harness(t);
	await h.message(h.requester, "received-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Work already received.",
	});
	h.responder.stop();
	await h.recover();
	let finished = false;
	h.wait("await-received").then(() => { finished = true; }, () => undefined);
	await flush();
	await h.tick();
	assert.equal(finished, false);
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.equal(h.deliveries(h.responder).length, 1);
});

test("Wait leaves a frozen original Steer Request reserved exactly once", async (t) => {
	let release: (() => Promise<void>) | undefined;
	const h = harness(t, { afterSteerFreeze(context) { release = context.release; return "defer"; } });
	await h.message(h.requester, "frozen-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Reserved work.", deliveryMode: "steer",
	});
	assert.ok(release);
	h.wait("frozen-wait");
	await flush();
	await h.tick();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 0);
	await release();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 1);
});

test("a Cancellation suppresses a frozen Request before its Steer hand-off", { timeout: 5_000 }, async (t) => {
	let release: (() => Promise<void>) | undefined;
	const h = harness(t, { afterSteerFreeze(context) {
		// Defer only the Request's own batch; a later Cancellation batch must be
		// able to dispatch so a regression would actually deliver it.
		if (release) return;
		release = context.release;
		return "defer";
	} });
	const request = await h.message(h.requester, "frozen-suppression-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Reserved work.", deliveryMode: "steer",
	});
	assert.ok("requestMessageId" in request);
	assert.ok(release, "the Steer batch freezes before hand-off");
	assert.equal(h.responder.dispatches.length, 0, "nothing was handed to the responder Runtime");
	await h.message(h.requester, "frozen-suppression-cancel", {
		operation: "cancel", requestMessageId: request.requestMessageId, reason: "Withdrawn",
	});
	await release();
	// A suppressed Cancellation is never scheduled; settle to give an
	// over-announcing regression a chance to dispatch it.
	h.responder.settle();
	await flush();
	// Suppression must still stop a queued Request before hand-off: the frozen
	// batch is not yet an in-flight dispatch, so neither message reaches the
	// responder.
	assert.equal(h.responder.dispatches.length, 0, "the withdrawn Request is dropped before hand-off");
	assert.deepEqual(h.deliveries(h.responder), [], "neither the Request nor a pointless Cancellation is delivered");
});

test("Wait preserves a dispatched Request while recipient proof is in flight", async (t) => {
	const h = harness(t);
	h.responder.deferProof = true;
	await h.message(h.requester, "inflight-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Dispatched work.",
	});
	h.wait("inflight-wait");
	await flush();
	await h.tick();
	await h.tick();
	assert.equal(h.responder.dispatches.length, 1);
	assert.equal(h.deliveries(h.responder).length, 0);
	h.responder.commitPending();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 1);
	assert.equal(h.responder.dispatches.length, 1);
});

test("Wait fails explicitly when authoritative recipient inspection is unavailable", async (t) => {
	const h = harness(t, { beforeRecipientInspection: () => "inspection_incomplete" });
	h.responder.blocked = true;
	const receipt = await h.message(h.requester, "uninspectable-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Cannot safely inspect.",
	});
	assert.ok("requestMessageId" in receipt);
	await h.recover();
	h.responder.blocked = false;
	await assert.rejects(h.wait("uninspectable-wait"), error =>
		error instanceof Error && error.message.includes(receipt.requestMessageId) &&
		error.message.includes("evidence_unavailable"));
	assert.equal(h.deliveries(h.responder).length, 0);
});

test("Wait admits a sibling Request while the earlier obligation remains open", async (t) => {
	const h = harness(t);
	const foreground = await h.message(h.requester, "foreground-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "First obligation.",
	});
	assert.ok("requestMessageId" in foreground);
	const sibling = await h.message(h.requester, "sibling-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Second obligation.",
	});
	assert.ok("requestMessageId" in sibling);
	h.responder.settle();
	h.wait("sibling-wait");
	await flush();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 2, "open obligations do not block later Deferred work at settlement");
	await h.message(h.responder, "foreground-answer", {
		operation: "answer", requestId: foreground.requestMessageId, answer: "First done.",
	});
	await h.tick();
	assert.deepEqual(h.deliveries(h.responder).map(d => d.projection.kind === "request" && d.projection.requestMessageId),
		[foreground.requestMessageId, sibling.requestMessageId]);
});

test("Answer notification completes Wait even while delivery reconciliation is queued behind a busy recipient lane", async (t) => {
	const h = harness(t);
	const request = await h.message(h.requester, "busy-recipient-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Commit the Answer independently.",
	});
	assert.ok("requestMessageId" in request);
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	t.after(release);
	void h.responder.record.host.lane.run(() => held);
	let result: unknown;
	const waiting = h.wait("busy-lane-wait").then(value => { result = value; });
	await flush();
	// A remote Runtime's transcript append is independent of the host lane.
	const toolCallId = "remote-answer";
	const entryId = h.responder.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "answer", requestId: request.requestMessageId, answer: "Committed remotely.",
	}, { id: toolCallId }), { stopReason: "toolUse" }));
	commit(h.responder, toolCallId, "agent_message", {
		requestTitle: "Fixture request",
		messageId: deriveMessageIdentity({ agentId: "responder", entryId, toolCallId }),
		requestMessageId: request.requestMessageId, messageStatus: "sent",
	});
	h.notify();
	await flush();
	assert.ok(result, "recipient scheduling must not block committed Answer retrieval");
	release();
	await waiting;
});

test("fresh Wait restores a canonical Creation Request under its Spawn identity", async (t) => {
	const h = harness(t);
	const toolCallId = "original-spawn";
	const input = { title: "Fixture request", request: "Original creation work." };
	const entryId = h.requester.manager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_spawn", input, { id: toolCallId }), { stopReason: "toolUse" },
	));
	const source = { agentId: "requester", entryId, toolCallId };
	const requestId = deriveMessageIdentity(source);
	h.responder.record.identity = {
		agentId: "responder", workflowId: "requester", directSpawnerAgentId: "requester",
		spawnSource: source, creationPreset: null, metadata: { label: "worker" },
	};
	h.responder.record.creationInput = input;
	h.responder.stop();
	await h.recover();
	const waiting = h.wait("creation-wait", { requestMessageIds: [requestId.slice(-12)] });
	await flush();
	assert.deepEqual(h.deliveries(h.responder).map(d => d.projection), [{
		title: "Fixture request",
		kind: "request", requestMessageId: requestId, fromAgentId: "requester", question: input.request,
	}]);
	await h.message(h.responder, "creation-answer", { operation: "answer", requestId, answer: "Creation work done." });
	await h.tick();
	h.commitWait("creation-wait", await waiting);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), []);
});

test("a queued reconciliation cannot admit delivery after its caller Run is fenced", async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "fenced-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Do not revive fenced intent.",
	});
	await h.recover();
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	t.after(release);
	void h.responder.record.host.lane.run(() => held);
	const waiting = assert.rejects(h.wait("fenced-wait"), /no longer available/);
	await flush();
	h.requester.stop();
	h.responder.blocked = false;
	release();
	await waiting;
	await flush();
	assert.equal(h.deliveries(h.responder).length, 0);
});

test("one busy recipient lane does not prevent Wait from scheduling another captured Request", async (t) => {
	const h = harness(t);
	const other = h.addRecipient("other");
	h.responder.blocked = true;
	other.blocked = true;
	await h.message(h.requester, "first-recipient", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "First recipient.",
	});
	await h.message(h.requester, "other-recipient", {
		title: "Fixture request",
		operation: "request", targetAgent: "other", question: "Other recipient.",
	});
	await h.recover();
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	t.after(release);
	void h.responder.record.host.lane.run(() => held);
	other.blocked = false;
	h.wait("multiple-recipient-wait");
	await flush();
	assert.equal(h.deliveries(other).length, 1);
	release();
});

for (const busyAtEntry of [true, false]) {
	test(`Wait keeps recovering other recipients while a lane is busy ${busyAtEntry ? "from entry" : "from a later timer pass"}`, async (t) => {
		const h = harness(t);
		const other = h.addRecipient("other");
		h.responder.blocked = true;
		other.blocked = true;
		await h.message(h.requester, "busy-request", {
			title: "Fixture request",
			operation: "request", targetAgent: "responder", question: "Busy recipient.",
		});
		const first = await h.message(h.requester, "other-first", {
			title: "Fixture request",
			operation: "request", targetAgent: "other", question: "Other recipient's first work.",
		});
		const sibling = await h.message(h.requester, "other-sibling", {
			title: "Fixture request",
			operation: "request", targetAgent: "other", question: "Other recipient's sibling.",
		});
		assert.ok("requestMessageId" in first && "requestMessageId" in sibling);
		await h.recover();
		let release!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		t.after(release);
		const holdLane = () => { void h.responder.record.host.lane.run(() => held); };
		if (busyAtEntry) holdLane();
		h.wait("recurring-recovery-wait");
		await flush();
		if (!busyAtEntry) holdLane();
		await other.record.host.lane.run(() => h.messages.discardSchedulingInLane(other.record));
		other.blocked = false;
		await h.tick();
		assert.deepEqual(h.deliveries(other).map(delivery =>
			delivery.projection.kind === "request" && delivery.projection.requestMessageId),
			[first.requestMessageId], "a busy recipient cannot suppress another recipient's recovery pass");

		// The busy lane also cannot stop later timer passes after a second loss.
		await other.record.host.lane.run(() => h.messages.discardSchedulingInLane(other.record));
		await h.message(other, "other-first-answer", {
			operation: "answer", requestId: first.requestMessageId, answer: "First work completed.",
		});
		await h.tick();
		assert.deepEqual(h.deliveries(other).map(delivery =>
			delivery.projection.kind === "request" && delivery.projection.requestMessageId),
			[first.requestMessageId, sibling.requestMessageId]);
		assert.equal(h.deliveries(h.responder).length, 0);
		release();
	});
}

for (const transition of ["ending", "failure", "replacement"] as const) {
	test(`ongoing Wait respects recipient ${transition}; only a fresh Wait renews delivery intent`, async (t) => {
		const h = harness(t);
		h.responder.blocked = true;
		const receipt = await h.message(h.requester, "request-before-lifecycle-change", {
			title: "Fixture request",
			operation: "request", targetAgent: "responder", question: "Keep the original delivery identity.",
		});
		assert.ok("requestMessageId" in receipt);
		const waiting = h.wait("wait-before-lifecycle-change");
		await flush();
		await h.responder.record.host.lane.run(async () => {
			h.messages.discardSchedulingInLane(h.responder.record);
			if (transition === "ending") h.responder.ending = true;
			if (transition === "failure") h.responder.failed = true;
			if (transition === "replacement") {
				h.responder.stop();
				await h.responder.record.host.startInLane();
			}
		});
		h.responder.blocked = false;
		await h.tick();
		await h.tick();
		assert.equal(h.deliveries(h.responder).length, 0);
		if (transition !== "replacement") {
			h.responder.stop(transition === "failure" ? "failure" : "termination");
			await h.tick();
			assert.equal(h.responder.record.host.observe().phase, "dormant");
			assert.equal(h.deliveries(h.responder).length, 0);
		}
		await h.preempt();
		h.commitWait("wait-before-lifecycle-change", await waiting);
		h.wait("fresh-wait-after-lifecycle-change");
		await flush();
		assert.equal(h.responder.record.host.observe().phase, "live");
		assert.deepEqual(h.deliveries(h.responder).map(delivery =>
			delivery.projection.kind === "request" && delivery.projection.requestMessageId),
			[receipt.requestMessageId]);
	});
}

test("late delivery-maintenance failure cannot replace a preempted Wait result", async (t) => {
	let h!: ReturnType<typeof harness>;
	h = harness(t, { afterDeliveryAdmission({ operation }) {
		if (operation !== "retry") return;
		void h.preempt();
		return "confirmation_lost";
	} });
	h.responder.blocked = true;
	await h.message(h.requester, "preempted-request", {
		title: "Fixture request",
		operation: "request", targetAgent: "responder", question: "Work before redirection.",
	});
	await h.recover();
	const result = await h.wait("preempted-maintenance-wait");
	await flush();
	assert.deepEqual(result, { disposition: "preempted" });
	h.commitWait("preempted-maintenance-wait", result);
	const committed = h.requester.manager.getLeafEntry();
	assert.ok(committed?.type === "message" && committed.message.role === "toolResult");
	assert.equal(committed.message.isError, false);
	assert.deepEqual(committed.message.details, { disposition: "preempted" });
});

for (const answerLatestFirst of [false, true]) test(`delivered Requests can be answered ${answerLatestFirst ? "latest" : "earlier"} first`, { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const first = await h.message(h.requester, "first", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "First" });
	h.responder.settle();
	await flush();
	const second = await h.message(h.requester, "second", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Second", deliveryMode: "steer" });
	h.responder.settle(); await flush();
	assert.ok("requestMessageId" in first && "requestMessageId" in second);
	await h.tick();
	assert.deepEqual(h.deliveries(h.responder).map(d => d.projection.kind === "request" && d.projection.requestMessageId), [first.requestMessageId, second.requestMessageId]);
	const [answered, remaining] = answerLatestFirst ? [second.requestMessageId, first.requestMessageId] : [first.requestMessageId, second.requestMessageId];
	const input = { operation: "answer" as const, requestId: answered, answer: "First done" };
	const receipt = await h.message(h.responder, "answer-first", input);
	assert.ok("messageStatus" in receipt);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), [remaining]);
	const replay = await h.messages.execute("responder", "answer-first", input);
	assert.ok("disposition" in replay && replay.disposition === "already_answered");
	await assert.rejects(h.message(h.responder, "fresh-stale-answer", input), /already answered/);
	await h.message(h.responder, "answer-second", { operation: "answer", requestId: remaining, answer: "Second done" });
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), []);
});

test("explicit Wait selects suffixes, deduplicates in source order and leaves unselected Requests outstanding", { timeout: 5_000 }, async (t) => {
	const h = harness(t, { beforeDeliveryAdmission: ({ operation }) => operation === "answer" ? "confirmed_failure" : undefined });
	const ids: string[] = [];
	for (const id of ["one", "two", "three"]) {
		const receipt = await h.message(h.requester, id, { title: "Fixture request", operation: "request", targetAgent: "responder", question: id, deliveryMode: "steer" });
		assert.ok("requestMessageId" in receipt);
		ids.push(receipt.requestMessageId);
	}
	await h.message(h.responder, "answer-three", { operation: "answer", requestId: ids[2]!, answer: "Three" });
	await h.message(h.responder, "answer-one", { operation: "answer", requestId: ids[0]!, answer: "One" });
	const result = await h.wait("selected", { requestMessageIds: [ids[2]!.slice(-12), ids[0]!, ids[2]!] });
	assert.ok("answers" in result);
	assert.deepEqual(result.answers.map(a => a.requestMessageId), [ids[0], ids[2]]);
	h.commitWait("selected", result);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), [ids[1]]);
	await assert.rejects(h.wait("consumed", { requestMessageIds: [ids[0]!] }), /not outstanding/);
});

test("explicit Wait rejects all invalid selections before renewing any Request delivery", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "lost", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Lost" });
	assert.ok("requestMessageId" in request);
	for (const input of [{ requestMessageIds: [] }, { requestMessageIds: [" "] }, { requestMessageIds: [request.requestMessageId, "unknown-suffix"] }]) {
		await assert.rejects(h.wait("invalid-" + JSON.stringify(input), input), /invalid_input|unknown_identity/);
		assert.deepEqual(h.deliveries(h.responder), []);
	}
	const ordinary = await h.message(h.requester, "ordinary", { operation: "send", targetAgent: "responder", content: "Hello" });
	assert.ok("messageId" in ordinary);
	await assert.rejects(h.wait("wrong-kind", { requestMessageIds: [ordinary.messageId] }), /wrong_message_kind/);
	const foreign = await h.message(h.responder, "foreign", { title: "Fixture request", operation: "request", targetAgent: "requester", question: "Foreign" });
	assert.ok("requestMessageId" in foreign);
	await assert.rejects(h.wait("foreign-selection", { requestMessageIds: [foreign.requestMessageId] }), /wrong_participant/);
	await h.message(h.requester, "cancel-lost", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Withdraw" });
	await assert.rejects(h.wait("cancelled-selection", { requestMessageIds: [request.requestMessageId] }), /not outstanding/);
});

test("queued Steer Requests form an admission-ordered batch past a blocked Deferred head", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	await h.message(h.requester, "initial", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Initial", deliveryMode: "steer" });
	h.responder.blocked = true;
	const deferred = await h.message(h.requester, "deferred-head", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Deferred" });
	const ids: string[] = [];
	for (const id of ["steer-one", "steer-two"]) {
		const receipt = await h.message(h.requester, id, { title: "Fixture request", operation: "request", targetAgent: "responder", question: id, deliveryMode: "steer" });
		assert.ok("requestMessageId" in receipt);
		ids.push(receipt.requestMessageId);
	}
	h.responder.blocked = false;
	h.responder.settle();
	await flush();
	const lastDispatch = h.responder.dispatches.at(-1);
	assert.ok(lastDispatch?.kind === "custom" && typeof lastDispatch.message.content === "string");
	assert.deepEqual(JSON.parse(lastDispatch.message.content).messages.map((message: { requestMessageId: string }) => message.requestMessageId), ids);
	assert.ok("requestMessageId" in deferred);
	assert.equal(h.deliveries(h.responder).filter(d => d.projection.kind === "request" && d.projection.requestMessageId === deferred.requestMessageId).length, 0);
	h.responder.settle();
	await flush();
	assert.equal(h.deliveries(h.responder).length, 4, "Deferred work follows the Steer batch at the next boundary");
	const deferredDelivery = h.deliveries(h.responder).at(-1)?.projection;
	assert.ok(deferredDelivery?.kind === "request");
	assert.equal(deferredDelivery.requestMessageId, deferred.requestMessageId);
	h.responder.settle();
	await flush();
	assert.equal(h.deliveries(h.responder).length, 4, "later settlement must not redeliver either mode");
});

test("Answer rejects unknown, undelivered, cancelled and wrong-responder Requests", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "undelivered", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Pending" });
	assert.ok("requestMessageId" in request);
	await assert.rejects(h.message(h.responder, "answer-undelivered", { operation: "answer", requestId: request.requestMessageId, answer: "Invalid" }), /has not been delivered/);
	await assert.rejects(h.message(h.requester, "answer-wrong-responder", { operation: "answer", requestId: request.requestMessageId, answer: "Invalid" }), /wrong_participant/);
	await assert.rejects(h.message(h.responder, "answer-unknown", { operation: "answer", requestId: "a".repeat(43), answer: "Invalid" }), /unknown_identity/);
	h.responder.blocked = false;
	h.responder.settle();
	await flush();
	await h.message(h.requester, "cancel-delivered", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Withdraw" });
	h.responder.settle();
	await flush();
	assert.ok(h.deliveries(h.responder).some(d => d.projection.kind === "request_cancellation"));
	await assert.rejects(h.message(h.responder, "answer-cancelled", { operation: "answer", requestId: request.requestMessageId, answer: "Invalid" }), /was cancelled/);
});


for (const resolution of ["answer", "cancel"] as const) test(`parked selected Wait requires both selected Answers despite unselected ${resolution}`, { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const ids: string[] = [];
	for (const name of ["A", "B", "C"]) {
		const receipt = await h.message(h.requester, name, {
			title: "Fixture request",
			operation: "request", targetAgent: "responder", question: name, deliveryMode: "steer",
		});
		assert.ok("requestMessageId" in receipt);
		ids.push(receipt.requestMessageId);
	}
	let settled = false;
	const waiting = h.wait("selected-pending", { requestMessageIds: [ids[1]!, ids[0]!] });
	void waiting.then(() => { settled = true; }, () => { settled = true; });
	await flush();
	const run = h.requester.record.host.observe();
	assert.ok("attention" in run && run.attention === "agent_wait");
	if (resolution === "answer") {
		await h.message(h.responder, "resolve-C", { operation: "answer", requestId: ids[2]!, answer: "C done" });
	} else {
		await h.message(h.requester, "resolve-C", { operation: "cancel", requestMessageId: ids[2]!, reason: "C withdrawn" });
	}
	await h.tick();
	assert.equal(settled, false, "unselected resolution must neither complete nor fail the parked join");
	await h.message(h.responder, "answer-B", { operation: "answer", requestId: ids[1]!, answer: "B done" });
	await h.tick();
	assert.equal(settled, false, "one selected Answer is insufficient");
	await h.message(h.responder, "answer-A", { operation: "answer", requestId: ids[0]!, answer: "A done" });
	await h.tick();
	const result = await waiting;
	assert.ok("answers" in result);
	assert.deepEqual(result.answers.map(answer => answer.requestMessageId), ids.slice(0, 2));
	h.commitWait("selected-pending", result);
});

test("parked Wait reserves one mixed Steer batch, excluding later arrivals and duplicate re-Wait delivery", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const author = h.addRecipient("author");
	const dependency = await h.message(h.requester, "dependency", { title: "Dependency", operation: "request", targetAgent: "responder", question: "Await this Answer" });
	assert.ok("requestMessageId" in dependency);
	h.requester.blocked = true;
	await h.message(author, "deferred", { title: "Deferred", operation: "request", targetAgent: "requester", question: "Deferred stays queued" });
	const first = await h.message(author, "first", { title: "First", operation: "request", targetAgent: "requester", question: "First Steer", deliveryMode: "steer" });
	const note = await h.message(author, "note", { operation: "send", targetAgent: "requester", content: "Steer context", deliveryMode: "steer" });
	const second = await h.message(author, "second", { title: "Second", operation: "request", targetAgent: "requester", question: "Second Steer", deliveryMode: "steer" });
	assert.ok("requestMessageId" in first && "messageId" in note && "requestMessageId" in second);
	const ids = [first.requestMessageId, note.messageId, second.requestMessageId];
	const waiting = h.wait("preempted-join", { requestMessageIds: [dependency.requestMessageId] });
	await flush();
	h.requester.deferProof = true;
	h.requester.blocked = false;
	h.requester.settle();
	const result = await waiting;
	assert.deepEqual(result, { disposition: "preempted" });
	const batches = () => h.requester.dispatches.map(dispatch => {
		assert.ok(dispatch.kind === "custom" && typeof dispatch.message.content === "string");
		return JSON.parse(dispatch.message.content).messages.map((message: { requestMessageId?: string; messageId?: string }) => message.messageId ?? message.requestMessageId);
	});
	assert.deepEqual(batches(), [ids], "Requests and ordinary Messages share a single Wait-preemption dispatch");
	h.commitWait("preempted-join", result);
	await h.message(author, "late", { title: "Late", operation: "request", targetAgent: "requester", question: "After freeze", deliveryMode: "steer" });
	await h.tick();
	assert.deepEqual(batches(), [ids], "later arrivals cannot modify or duplicate the reserved batch");
	h.requester.commitPending();
	h.requester.deferProof = false;
	// Re-enter Wait before settlement: proof must release the entire reservation.
	const next = h.wait("next-join", { requestMessageIds: [dependency.requestMessageId] });
	assert.deepEqual(await next, { disposition: "preempted" });
	h.commitWait("next-join", { disposition: "preempted" });
	assert.equal(batches().length, 2);
	assert.equal(batches()[1].length, 1, "only the late Request belongs to the next batch");
	assert.deepEqual(batches()[0], ids);
	const provenIds = h.deliveries(h.requester).map(delivery => delivery.projection.kind === "message" ? delivery.projection.messageId : delivery.projection.kind === "request" ? delivery.projection.requestMessageId : "other");
	assert.deepEqual(provenIds, batches().flat());
	assert.equal(new Set(provenIds).size, provenIds.length);
});

for (const deliveryMode of ["steer", "deferred", "background"] as const) test(
	`ordinary ${deliveryMode} Message ${deliveryMode === "steer" ? "preempts" : "does not preempt"} Wait`, { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const author = h.addRecipient("author");
	await h.message(h.requester, "dependency", { title: "Dependency", operation: "request", targetAgent: "responder", question: "Wait for this" });
	let settled = false;
	const waiting = h.wait("wait-for-message");
	void waiting.then(() => { settled = true; }, () => { settled = true; });
	await flush();
	const note = await h.message(author, "note", { operation: "send", targetAgent: "requester", content: "Context for next turn", deliveryMode });
	assert.ok("messageId" in note);
	await h.tick();
	assert.equal(settled, deliveryMode === "steer");
	if (deliveryMode !== "steer") {
		assert.deepEqual(h.deliveries(h.requester), []);
		return;
	}
	assert.deepEqual(await waiting, { disposition: "preempted" });
	h.commitWait("wait-for-message", { disposition: "preempted" });
	assert.deepEqual(h.deliveries(h.requester).map(delivery => delivery.projection.kind), ["message"]);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.requester.record), [], "ordinary input creates no Answer obligation");
	let rewaitSettled = false;
	void h.wait("wait-again").then(() => { rewaitSettled = true; }, () => { rewaitSettled = true; });
	await h.tick();
	assert.equal(rewaitSettled, false, "the delivered Message cannot preempt another Wait");
	assert.equal(h.requester.dispatches.length, 1, "one delivery without duplicates");
});

test("ordinary Steer Messages queued before Wait admission preempt in one FIFO batch", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const author = h.addRecipient("author");
	await h.message(h.requester, "dependency", { title: "Dependency", operation: "request", targetAgent: "responder", question: "Await this" });
	h.requester.blocked = true;
	for (const content of ["First correction", "Second correction"]) {
		await h.message(author, content, { operation: "send", targetAgent: "requester", content, deliveryMode: "steer" });
	}
	const waiting = h.wait("ordinary-batch");
	await flush();
	h.requester.blocked = false;
	h.requester.settle();
	assert.deepEqual(await waiting, { disposition: "preempted" });
	h.commitWait("ordinary-batch", { disposition: "preempted" });
	assert.equal(h.requester.dispatches.length, 1);
	assert.deepEqual(h.deliveries(h.requester).map(delivery =>
		delivery.projection.kind === "message" && delivery.projection.content), ["First correction", "Second correction"]);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.requester.record), []);
});

test("a Cancellation whose Request never reached the responder is not announced", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const author = h.addRecipient("author");
	await h.message(h.requester, "dependency", { title: "Dependency", operation: "request", targetAgent: "responder", question: "Await this" });
	h.requester.blocked = true;
	const cancelled = await h.message(author, "cancelled", { title: "Cancelled", operation: "request", targetAgent: "requester", question: "Must never enter", deliveryMode: "steer" });
	assert.ok("requestMessageId" in cancelled);
	await h.message(author, "note", { operation: "send", targetAgent: "requester", content: "Useful context", deliveryMode: "steer" });
	await h.message(author, "cancel", { operation: "cancel", requestMessageId: cancelled.requestMessageId, reason: "Withdrawn before Delivery" });
	const waiting = h.wait("cancel-batch");
	await flush();
	h.requester.blocked = false;
	h.requester.settle();
	assert.deepEqual(await waiting, { disposition: "preempted" });
	h.commitWait("cancel-batch", { disposition: "preempted" });
	await h.tick();
	assert.deepEqual(h.deliveries(h.requester).map(delivery => delivery.projection.kind), ["message"]);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.requester.record), []);
	h.requester.settle(); await flush();
	assert.equal(h.deliveries(h.requester).length, 1, "the withdrawn Request and its pointless Cancellation are both suppressed");
});

test("a Cancellation is notified when its Request reached the responder", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const request = await h.message(h.requester, "delivered", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Delivered work" });
	assert.ok("requestMessageId" in request);
	h.responder.settle(); await flush();
	assert.equal(h.deliveries(h.responder).filter(delivery => delivery.projection.kind === "request").length, 1);
	await h.message(h.requester, "cancel", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Withdrawn" });
	h.responder.settle(); await flush();
	assert.equal(
		h.deliveries(h.responder).filter(delivery => delivery.projection.kind === "request_cancellation").length,
		1,
		"a Request the responder received still announces its withdrawal",
	);
});

test("a Cancellation whose Request never reached the responder starts no Run", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "undelivered", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Never delivered" });
	assert.ok("requestMessageId" in request);
	h.responder.blocked = false;
	h.responder.stop();
	const startedBefore = h.responder.record.host.latestStartedRunSequence();
	await h.message(h.requester, "cancel", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Withdrawn" });
	assert.equal(
		h.responder.record.host.latestStartedRunSequence(),
		startedBefore,
		"no Run starts for a Cancellation whose Request was never delivered",
	);
	assert.equal(h.deliveries(h.responder).filter(delivery => delivery.projection.kind === "request_cancellation").length, 0);
});

test("an in-flight Request Delivery announces its Cancellation without re-adding answer_owed", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	h.responder.deferProof = true;
	const request = await h.message(h.requester, "deferred", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Proof pending" });
	assert.ok("requestMessageId" in request);
	await flush();
	assert.equal(h.responder.dispatches.length, 1, "the Request was handed to the responder Runtime");
	// Hold the responder so the Cancellation is scheduled but not handed over until
	// the in-flight Request proof commits.
	h.responder.blocked = true;
	await h.message(h.requester, "cancel", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Withdrawn" });
	h.responder.blocked = false;
	h.responder.commitPending();
	// Only the withdrawn Request proof was deferred; the Cancellation commits normally.
	h.responder.deferProof = false;
	h.responder.settle(); await flush();
	assert.equal(
		h.responder.retentionReasons.has(`answer_owed:${request.requestMessageId}`),
		false,
		"the requester's committed Cancellation prevents re-adding the responder duty",
	);
	assert.deepEqual(
		h.deliveries(h.responder).map(delivery => delivery.projection.kind),
		["request", "request_cancellation"],
		"a Request whose Delivery is already in flight still announces its Cancellation",
	);
});

test("ordinary Steer Message preemption excludes incomplete Answers from the batch", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const author = h.addRecipient("author");
	const ids: string[] = [];
	for (const name of ["first", "second"]) {
		const dependency = await h.message(h.requester, name, { title: name, operation: "request", targetAgent: "responder", question: name });
		assert.ok("requestMessageId" in dependency);
		ids.push(dependency.requestMessageId);
		h.responder.settle(); await flush();
	}
	const waiting = h.wait("incomplete-aggregate");
	await flush();
	await h.message(h.responder, "first-answer", { operation: "answer", requestId: ids[0], answer: "First complete" });
	await h.message(author, "note", { operation: "send", targetAgent: "requester", content: "Queued context", deliveryMode: "steer" });
	assert.deepEqual(await waiting, { disposition: "preempted" });
	assert.deepEqual(h.deliveries(h.requester).map(delivery => delivery.projection.kind), ["message"],
		"preemption creates no requester-side Answer Delivery proof");
	h.commitWait("incomplete-aggregate", { disposition: "preempted" });
	const next = h.wait("rewait-aggregate", { requestMessageIds: ids });
	await flush();
	await h.message(h.responder, "second-answer", { operation: "answer", requestId: ids[1], answer: "Second complete" });
	await h.tick();
	const result = await next;
	assert.ok("answers" in result);
	assert.deepEqual(result.answers.map(answer => answer.requestMessageId), ids);
	h.commitWait("rewait-aggregate", result);
});

test("the complete Answer aggregate wins before a mixed Steer batch reserves delivery", { timeout: 5_000 }, async (t) => {
	let commitAnswer = () => {};
	const h = harness(t, undefined, { beforePreemptionDecision: () => commitAnswer() });
	const author = h.addRecipient("author");
	const dependency = await h.message(h.requester, "dependency", { title: "Dependency", operation: "request", targetAgent: "responder", question: "Await this" });
	assert.ok("requestMessageId" in dependency);
	const waiting = h.wait("complete-before-batch");
	await flush();
	h.requester.blocked = true;
	await h.message(author, "note", { operation: "send", targetAgent: "requester", content: "Queued context", deliveryMode: "steer" });
	await h.message(author, "trigger", { title: "Trigger", operation: "request", targetAgent: "requester", question: "New work", deliveryMode: "steer" });
	commitAnswer = () => {
		commitAnswer = () => {};
		const toolCallId = "answer-at-boundary";
		call(h.responder, toolCallId, "agent_message", { operation: "answer", requestId: dependency.requestMessageId, answer: "Completed aggregate" });
		const entryId = h.responder.manager.getLeafEntry()!.id;
		commit(h.responder, toolCallId, "agent_message", { messageId: deriveMessageIdentity({ agentId: "responder", entryId, toolCallId }),
			requestMessageId: dependency.requestMessageId, requestTitle: "Dependency", messageStatus: "sent" });
	};
	h.requester.blocked = false;
	h.requester.settle();
	const result = await waiting;
	assert.ok("answers" in result);
	assert.equal(result.answers[0].requestMessageId, dependency.requestMessageId);
	assert.equal(h.requester.dispatches.length, 0, "no preemption batch reserves before the complete Answer result");
	h.commitWait("complete-before-batch", result);
});

for (const resolution of ["answer", "cancel"] as const) test(`Background Messages and Requests wait for every obligation to ${resolution}`, { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const author = h.addRecipient("background-author");
	const first = await h.message(h.requester, "first-duty", { operation: "request", targetAgent: "responder", title: "First duty", question: "Do this first" });
	h.responder.settle(); await flush();
	const second = await h.message(h.requester, "second-duty", { operation: "request", targetAgent: "responder", title: "Second duty", question: "Also do this" });
	h.responder.settle(); await flush();
	assert.ok("requestMessageId" in first && "requestMessageId" in second);
	const note = await h.message(author, "background-note", { operation: "send", targetAgent: "responder", content: "Optional note", deliveryMode: "background" });
	const work = await h.message(author, "background-work", { operation: "request", targetAgent: "responder", title: "Optional work", question: "Do this later", deliveryMode: "background" });
	assert.ok("messageId" in note && "requestMessageId" in work);
	assert.equal(h.deliveries(h.responder).length, 2);
	for (const [index, requestId] of [first.requestMessageId, second.requestMessageId].entries()) {
		if (resolution === "answer") await h.message(h.responder, `resolve-${index}`, { operation: "answer", requestId, answer: "Done" });
		else await h.message(h.requester, `resolve-${index}`, { operation: "cancel", requestMessageId: requestId, reason: "Withdrawn" });
		h.responder.settle();
		await h.messages.refreshTranscriptFacts();
		await flush();
		const projections = h.deliveries(h.responder).map(item => item.projection);
		if (index === 0) assert.ok(!projections.some(item => item.kind === "message" && item.messageId === note.messageId));
	}
	h.responder.settle(); await flush();
	const background = h.deliveries(h.responder).map(item => item.projection).filter(item => item.kind === "message" || item.kind === "request" && item.requestMessageId === work.requestMessageId);
	assert.deepEqual(background.map(item => item.kind), ["message", "request"]);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), [work.requestMessageId]);
	h.responder.settle(); await flush();
	assert.equal(h.deliveries(h.responder).filter(item => item.projection.kind === "request" && item.projection.requestMessageId === work.requestMessageId).length, 1);
});

test("Background never preempts Agent Wait; higher modes bypass its FIFO queue", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const upstream = h.addRecipient("upstream");
	const dependency = await h.message(h.requester, "dependency", { operation: "request", targetAgent: "responder", title: "Dependency", question: "Work" });
	assert.ok("requestMessageId" in dependency);
	const waiting = h.wait("parked-background", { requestMessageIds: [dependency.requestMessageId] });
	let completed = false; void waiting.then(() => { completed = true; }, () => undefined);
	await flush();
	const low = await h.message(upstream, "low", { operation: "request", targetAgent: "requester", title: "Optional", question: "Later", deliveryMode: "background" });
	await h.message(upstream, "low-note", { operation: "send", targetAgent: "requester", content: "Later note", deliveryMode: "background" });
	assert.ok("requestMessageId" in low);
	await h.tick();
	assert.equal(completed, false);
	assert.equal(h.deliveries(h.requester).length, 0);
	const normal = await h.message(upstream, "normal", { operation: "request", targetAgent: "requester", title: "Clarification", question: "Answer now" });
	assert.ok("requestMessageId" in normal);
	assert.deepEqual(await waiting, { disposition: "preempted" });
	h.commitWait("parked-background", { disposition: "preempted" });
	await flush();
	assert.deepEqual(h.deliveries(h.requester).map(item => item.projection.kind === "request" && item.projection.requestMessageId), [normal.requestMessageId]);
	await h.message(h.requester, "normal-answer", { operation: "answer", requestId: normal.requestMessageId, answer: "Confirmed" });
	h.requester.settle(); await h.messages.refreshTranscriptFacts(); await flush();
	assert.ok(h.deliveries(h.requester).some(item => item.projection.kind === "request" && item.projection.requestMessageId === low.requestMessageId));
	assert.ok(!h.deliveries(h.requester).some(item => item.projection.kind === "message"), "Background Request creates an obligation before the next Background Message");
});

test("Background yields to queued Steer and Deferred Messages and preserves FIFO across recovery", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const ids: string[] = [];
	for (const [index, deliveryMode] of ["background", "deferred", "background", "steer"].entries()) {
		const receipt = await h.message(h.requester, `queued-${index}`, { operation: "send", targetAgent: "responder", content: `Note ${index}`, deliveryMode: deliveryMode as "background" | "deferred" | "steer" });
		assert.ok("messageId" in receipt); ids.push(receipt.messageId);
	}
	await h.recover();
	for (const messageId of ids) await h.message(h.requester, `retry-${messageId}`, { operation: "retry", messageId });
	h.responder.blocked = false;
	for (const _ of ids) { h.responder.settle(); await flush(); }
	const delivered = h.deliveries(h.responder).map(item => item.projection.kind === "message" && item.projection.messageId);
	assert.deepEqual(delivered, [ids[3], ids[1], ids[0], ids[2]]);
	h.responder.settle(); await flush();
	assert.equal(h.deliveries(h.responder).length, 4);
});

test("Background Request recovery retains obligation gating and queued cancellation suppresses delivery", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const duty = await h.message(h.requester, "duty", { operation: "request", targetAgent: "responder", title: "Duty", question: "Finish first" });
	assert.ok("requestMessageId" in duty);
	h.responder.settle(); await flush();
	const cancelled = await h.message(h.requester, "cancelled-background", { operation: "request", targetAgent: "responder", title: "Unneeded", question: "Optional", deliveryMode: "background" });
	const kept = await h.message(h.requester, "kept-background", { operation: "request", targetAgent: "responder", title: "Later", question: "Optional retained", deliveryMode: "background" });
	assert.ok("requestMessageId" in cancelled && "requestMessageId" in kept);
	h.responder.stop();
	await h.recover();
	await h.message(h.requester, "renew-cancelled", { operation: "retry", messageId: cancelled.requestMessageId });
	await h.message(h.requester, "renew-kept", { operation: "retry", messageId: kept.requestMessageId });
	h.responder.settle(); await flush();
	assert.equal(h.deliveries(h.responder).length, 1, "reconstruction retains the earlier Answer obligation");
	await h.message(h.requester, "withdraw", { operation: "cancel", requestMessageId: cancelled.requestMessageId, reason: "Unneeded" });
	await h.message(h.responder, "finish-duty", { operation: "answer", requestId: duty.requestMessageId, answer: "Done" });
	h.responder.settle(); await h.messages.refreshTranscriptFacts(); await flush();
	const requests = h.deliveries(h.responder).filter(item => item.projection.kind === "request").map(item => item.projection.kind === "request" && item.projection.requestMessageId);
	assert.deepEqual(requests, [duty.requestMessageId, kept.requestMessageId]);
});

function harness(t: { after(fn: () => void | Promise<void>): void }, boundaryHooks?: MessageBoundaryHooks, waitBoundaryHooks?: AgentWaitBoundaryHooks) {
	const requester = runtimeParticipant("requester");
	const responder = runtimeParticipant("responder");
	const participants = [requester, responder];
	const agents = new Map(participants.map(p => [p.record.identity.agentId, p.record]));
	const options = { agents, boundaryHooks, workflowPolicy: new WorkflowPolicyStore(), isShuttingDown: () => false,
		preemptAgentWait: (record: Parameters<AgentWaitCoordinator["preemptForInboundRequest"]>[0], reserve: () => boolean) => waits.preemptForInboundRequest(record, reserve),
	};
	let messages = new MessageCoordinator(options);
	let timer: (() => void) | undefined;
	let waits: AgentWaitCoordinator;
	const abort = new AbortController();
	const pending: Promise<unknown>[] = [];
	function install() {
		for (const p of participants) messages.integrate(p.record);
		waits = new AgentWaitCoordinator({
			agents, messages, boundaryHooks: waitBoundaryHooks,
			clock: { schedule: (_delay, callback) => { timer = callback; return () => { timer = undefined; }; } },
			suspendExecution: () => undefined, resumeExecution: async () => undefined,
		});
	}
	install();
	t.after(async () => {
		abort.abort();
		waits.shutdown();
		await Promise.allSettled(pending);
		messages.shutdownDeliveryProgress();
	});
	return {
		requester, responder,
		addRecipient(agentId: string) {
			const p = runtimeParticipant(agentId);
			participants.push(p);
			agents.set(agentId, p.record);
			messages.integrate(p.record);
			return p;
		},
		get messages() { return messages; },
		async recover(freshTranscripts = false) {
			if (freshTranscripts) for (const p of participants) p.record.transcript = transcriptFromSessionManager(p.manager, { fresh: true });
			waits.shutdown();
			for (const p of participants) messages.discardSchedulingInLane(p.record);
			messages.shutdownDeliveryProgress();
			messages = new MessageCoordinator(options);
			install();
			await messages.refreshTranscriptFacts();
		},
		async message(p: ReturnType<typeof runtimeParticipant>, id: string, input: AgentMessageInput) {
			call(p, id, "agent_message", input);
			const result = await messages.execute(p.record.identity.agentId, id, input);
			commit(p, id, "agent_message", result);
			return result;
		},
		wait(id: string, input: import("../src/protocol/agent-wait.ts").AgentWaitInput = {}) {
			call(requester, id, "agent_wait", input);
			const result = waits.wait("requester", id, input, abort.signal);
			pending.push(result);
			return result;
		},
		commitWait(id: string, result: unknown) {
			const message = {
				role: "toolResult" as const, toolCallId: id, toolName: "agent_wait",
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result as JsonValue, isError: false, timestamp: Date.now(),
			};
			const committed = waits.guardResultCommit("requester", message)?.message ?? message;
			if (committed.role !== "toolResult") throw new Error("Expected a Wait tool result");
			requester.manager.appendMessage(committed);
			waits.reconcileCommittedResults("requester");
		},
		preempt() { return waits.preemptForHumanInput(requester.record); },
		async tick() { timer?.(); await flush(); },
		notify() { waits.reconcileCommittedAnswers(); },
		deliveries(p: ReturnType<typeof runtimeParticipant>) {
			return inspectMessageDeliveries({ recipientAgentId: p.record.identity.agentId, transcript: p.record.transcript.inspect() });
		},
	};
}

// Adapt only the Runtime Host: delivery appends real recipient transcript proof.
function runtimeParticipant(agentId: string) {
	const p = participant(agentId);
	let handle: AgentRunHandle | undefined = { sequence: 1 };
	let sequence = 1;
	let attention: "none" | "agent_wait" = "none";
	const ended = new Set<(handle: AgentRunHandle, cause: AgentRunEndCause) => void>();
	const proofCommits: (() => void)[] = [];
	const settled = new Set<(handle: AgentRunHandle, state: "settled") => void>();
	const runtime = {
		...p, blocked: false, deferProof: false, ending: false, failed: false,
		commitPending() { for (const commit of proofCommits.splice(0)) commit(); },
		settle() { if (handle) for (const handler of settled) handler(handle, "settled"); },
		dispatches: [] as AgentRuntimeDelivery[],
		retentionReasons: new Set<string>(),
		stop(cause: AgentRunEndCause = "termination") {
			const previous = handle;
			handle = undefined;
			if (previous) for (const handler of ended) handler(previous, cause);
		},
	};
	p.record.host = {
		lane: new SerialLane(),
		currentHandle: () => handle, latestStartedRunSequence: () => sequence,
		isCurrent: (candidate: AgentRunHandle) => candidate === handle,
		startInLane: async () => {
			runtime.ending = false;
			runtime.failed = false;
			handle = { sequence: ++sequence };
			return handle;
		},
		setRunStartInitializer: () => undefined,
		addSettledHandler: (handler: (handle: AgentRunHandle, state: "settled") => void) => {
			settled.add(handler); return () => { settled.delete(handler); };
		},
		finishIsolatedResumptionInLane: () => undefined,
		releaseIfEligibleInLane: () => "retained",
		addEndedHandler: (handler: (handle: AgentRunHandle, cause: AgentRunEndCause) => void) => {
			ended.add(handler); return () => { ended.delete(handler); };
		},
		addRetentionReason: (reason: string, requestId?: string) => {
			runtime.retentionReasons.add(requestId === undefined ? reason : `${reason}:${requestId}`);
		},
		removeRetentionReason: (reason: string, requestId?: string) => {
			runtime.retentionReasons.delete(requestId === undefined ? reason : `${reason}:${requestId}`);
		},
		hasRetentionReason: () => false,
		blocksOrdinaryDelivery: () => runtime.blocked,
		currentWorkState: () => attention === "agent_wait" ? "active" : "settled",
		observe: () => handle ? { phase: runtime.ending ? "ending" : "live", work: attention === "agent_wait" ? "active" : "settled", attention, retentionReasons: [] } : { phase: "dormant", retentionReasons: [] },
		beginAgentWait: () => { attention = "agent_wait"; },
		endAgentWait: () => { attention = "none"; },
		currentRunFailed: () => handle !== undefined && runtime.failed,
		deliverInLane: (input: AgentRuntimeDelivery) => {
			runtime.dispatches.push(input);
			if (input.kind !== "custom") throw new Error("Expected coordination Delivery");
			const m = input.message;
			const append = () => p.manager.appendCustomMessageEntry(m.customType, m.content, m.display, "details" in m ? m.details : undefined);
			if (runtime.deferProof) return { completion: new Promise<void>(resolve => {
				proofCommits.push(() => { append(); resolve(); });
			}) };
			append();
			return { completion: Promise.resolve() };
		},
	} as unknown as AgentRuntimeHost;
	return runtime;
}
function call(p: ReturnType<typeof participant>, id: string, name: string, input: Record<string, unknown>) {
	p.manager.appendMessage(fauxAssistantMessage(fauxToolCall(name, input as JsonObject, { id }), { stopReason: "toolUse" }));
}
function commit(p: ReturnType<typeof participant>, id: string, name: string, details: unknown) {
	p.manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: JSON.stringify(details) }], details: details as JsonValue, isError: false, timestamp: Date.now() });
}
async function flush() { for (let i = 0; i < 8; i++) await setImmediate(); }
