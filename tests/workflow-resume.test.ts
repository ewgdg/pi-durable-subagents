import { RunSupervisor } from "../src/coordination/run-supervision.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { AgentTranscript } from "../src/transcript/agent-transcript.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, type JsonObject, type JsonValue } from "@earendil-works/pi-ai";
import { MessageCoordinator, type MessageBoundaryHooks, type AgentMessageInput } from "../src/coordination/messages.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import type { AgentRuntimeHost, AgentRunHandle, AgentRuntimeDelivery, AgentRunEndCause } from "../src/runtime/agent-runtime-host.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { participant } from "./support/request-history.ts";


import { resumeWorkflow } from "../src/coordination/workflow-resume.ts";
import type { WorkflowResumeActivation } from "../src/coordination/workflow-recovery-outcomes.ts";

test("recovery schedules original Requests and Messages once, preserving context preparation", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "request", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Original", contextPreparation: { workScale: "medium", contextDependence: "high" } });
	const message = await h.message(h.requester, "message", { operation: "send", targetAgent: "responder", content: "Original message" });
	await h.recover();
	h.responder.blocked = false;
	const receipt = await h.resume();
	await flush();
	assert.equal(receipt.outstandingRequests[0]?.status, "delivery_scheduled");
	h.responder.settle();
	await flush();
	assert.equal(h.deliveries(h.responder).length, 2);
	assert.deepEqual(h.responder.dispatches[0]?.kind === "custom" && h.responder.dispatches[0].workingZonePreparation?.intent, { workScale: "medium", contextDependence: "high" });
	await h.resume();
	assert.equal(h.deliveries(h.responder).length, 2);
	assert.ok("requestMessageId" in request && "messageId" in message);
	assert.deepEqual(h.deliveries(h.responder).map(item => item.source.toolCallId), ["request", "message"]);
});

test("recovery sends a committed Answer to its original requester and does not activate completed work", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const request = await h.message(h.requester, "request", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Original" });
	assert.ok("requestMessageId" in request);
	h.requester.blocked = true;
	const answer = await h.message(h.responder, "answer", { operation: "answer", requestId: request.requestMessageId, answer: "Completed" });
	h.responder.stop();
	await h.recover();
	h.requester.blocked = false;
	const receipt = await h.resume();
	await flush();
	assert.deepEqual(receipt.outstandingRequests, []);
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.deepEqual(h.deliveries(h.requester).map(item => item.projection.kind), ["answer"]);
	assert.ok("messageId" in answer);
	assert.equal(h.deliveries(h.requester)[0]?.source.toolCallId, "answer");
});

test("recovery coalesces held scheduling and suppresses cancelled Requests before dispatch", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "request", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Original" });
	assert.ok("requestMessageId" in request);
	const receipt = await h.resume();
	assert.equal(receipt.outstandingRequests[0]?.status, "delivery_scheduled");
	assert.equal(h.deliveries(h.responder).length, 0);
	await h.message(h.requester, "cancel", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "No longer needed" });
	await h.recover();
	h.responder.blocked = false;
	const cancelled = await h.resume();
	assert.deepEqual(cancelled.outstandingRequests, []);
	assert.equal(h.deliveries(h.responder).filter(item => item.projection.kind === "request").length, 0);
});

test("snapshot excludes work authored during recovery admission and does not infer ordinary Message continuations", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "initial", { operation: "send", targetAgent: "responder", content: "Initial" });
	await h.recover();
	let admissions = 0;
	const original = h.messages.resumeMessage.bind(h.messages);
	h.messages.resumeMessage = async message => {
		admissions++;
		const result = await original(message);
		await h.message(h.requester, "later", { operation: "send", targetAgent: "responder", content: "Later" });
		return result;
	};
	const receipt = await h.resume();
	assert.equal(admissions, 1);
	assert.deepEqual(receipt.outstandingRequests, []);
});

test("unrelated unavailable evidence does not pollute the Owner view or prevent independent recovery", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "initial", { operation: "send", targetAgent: "responder", content: "Initial" });
	await h.recover();
	const receipt = await h.resume(new Set(["missing-agent"]));
	assert.deepEqual(receipt, { workflowId: "requester", outstandingRequests: [] });
	h.responder.blocked = false;
	await h.resume();
	await flush();
	assert.equal(h.deliveries(h.responder).length, 1);
});


test("nested recovery preserves attention and Agent-owned outbound dependencies", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const first = await h.message(h.requester, "first", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Outer work" });
	const reverse = await h.message(h.responder, "reverse", { title: "Fixture request", operation: "request", targetAgent: "requester", question: "Need a decision" });
	h.responder.settle();
	h.requester.settle();
	await flush();
	const nested = await h.message(h.requester, "nested", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Clarify before decision" });
	assert.ok("requestMessageId" in first && "requestMessageId" in reverse && "requestMessageId" in nested);
	h.responder.stop();
	await h.recover();
	const receipt = await h.resume();
	assert.deepEqual(receipt.outstandingRequests.map(item => item.requestMessageId), [first.requestMessageId, nested.requestMessageId]);
	assert.deepEqual(
		h.messages.obligationFrames("responder").map(frame => frame.requestId),
		[first.requestMessageId, nested.requestMessageId],
	);
	assert.equal(h.messages.foregroundRequestId(h.responder.record), nested.requestMessageId);
	assert.equal(h.messages.foregroundRequestId(h.requester.record), reverse.requestMessageId);
	// Attention foreground does not hide dependencies authored under an earlier obligation.
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.responder.record), [reverse.requestMessageId]);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), [first.requestMessageId, nested.requestMessageId]);
	assert.deepEqual(
		h.deliveries(h.responder).map(delivery => delivery.source.toolCallId),
		["first", "nested"],
	);
});


test("concurrent resume calls coalesce admission and report pending capacity explicitly", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "first", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "First" });
	await h.message(h.requester, "second", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Second" });
	await h.recover();
	h.policy.publish(Object.freeze({ ...h.policy.current(), maxPendingDeliveriesPerAgent: 1 }));
	const receipts = await Promise.all([h.resume(), h.resume()]);
	assert.ok(receipts.every(item => item.outstandingRequests.filter(request => request.status === "delivery_scheduled").length === 1));
	assert.ok(receipts.every(item => item.outstandingRequests.some(request => request.status === "blocked" && request.reason === "capacity_exhausted")));
	assert.equal(h.deliveries(h.responder).length, 0);
});


test("cancellation committed after the snapshot suppresses stale delivery admission", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "request", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Original" });
	assert.ok("requestMessageId" in request);
	await h.recover();
	const original = h.messages.resumeMessage.bind(h.messages);
	h.messages.resumeMessage = async message => {
		await h.message(h.requester, "cancel-during-resume", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Cancellation won" });
		return original(message);
	};
	const receipt = await h.resume();
	assert.deepEqual(receipt.outstandingRequests, []);
	assert.equal(h.deliveries(h.responder).length, 0);
});

test("recovery skips a withdrawn undelivered Request and its pointless Cancellation", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "request", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Original" });
	assert.ok("requestMessageId" in request);
	const cancellation = await h.message(h.requester, "cancel", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "No longer needed" });
	assert.ok("messageId" in cancellation);
	await h.recover();
	const requestMessage = h.messages.recoveryMessage("requester", request.requestMessageId);
	assert.ok(requestMessage);
	assert.equal(h.messages.inspectRecoveryMessage(requestMessage)?.reason, "request_resolved");
	const cancellationMessage = h.messages.recoveryMessage("requester", cancellation.messageId);
	assert.ok(cancellationMessage);
	assert.deepEqual(h.messages.inspectRecoveryMessage(cancellationMessage), {
		messageId: cancellation.messageId, targetAgentId: "responder", kind: "request_cancellation",
		disposition: "skipped", reason: "request_not_delivered",
	});
	const activated: string[] = [];
	const receipt = await h.resume(new Set(), agentId => activated.push(agentId));
	assert.deepEqual(receipt.outstandingRequests, []);
	assert.deepEqual(activated, [], "a withdrawn Request activates no responder");
	h.responder.blocked = false;
	h.responder.settle(); await flush();
	assert.equal(h.deliveries(h.responder).length, 0, "neither the withdrawn Request nor its Cancellation is re-admitted");
});

test("recovery still schedules a Cancellation whose Request reached the responder", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const request = await h.message(h.requester, "request", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Original" });
	assert.ok("requestMessageId" in request);
	h.responder.settle(); await flush();
	assert.equal(h.deliveries(h.responder).filter(delivery => delivery.projection.kind === "request").length, 1);
	h.responder.blocked = true;
	const cancellation = await h.message(h.requester, "cancel", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "No longer needed" });
	assert.ok("messageId" in cancellation);
	await h.recover();
	const requestMessage = h.messages.recoveryMessage("requester", request.requestMessageId);
	assert.ok(requestMessage);
	assert.equal(h.messages.inspectRecoveryMessage(requestMessage)?.reason, "request_resolved");
	const cancellationMessage = h.messages.recoveryMessage("requester", cancellation.messageId);
	assert.ok(cancellationMessage);
	assert.equal(h.messages.inspectRecoveryMessage(cancellationMessage), undefined);
	h.responder.blocked = false;
	const receipt = await h.resume();
	assert.deepEqual(receipt.outstandingRequests, []);
	h.responder.settle(); await flush();
	assert.equal(
		h.deliveries(h.responder).filter(delivery => delivery.projection.kind === "request_cancellation").length,
		1,
		"a Request the responder received still announces its withdrawal after recovery",
	);
});


test("a dormant Agent with only delivered ordinary Messages is not proactively restarted", { timeout: 5_000 }, async t => {
	const h = harness(t);
	await h.message(h.requester, "ordinary", { operation: "send", targetAgent: "responder", content: "Historical ordinary Message" });
	h.responder.stop();
	await h.recover();
	const receipt = await h.resume();
	assert.deepEqual(receipt.outstandingRequests, []);
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.equal(h.deliveries(h.responder).length, 1);
});


test("a failed durable transcript read is indeterminate rather than guessed as undelivered work", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "unavailable", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Need verified proof" });
	await h.recover();
	h.responder.record.transcript = new AgentTranscript({ read() { throw new Error("evidence_unavailable: unreadable transcript"); } });
	const receipt = await h.resume();
	assert.equal(receipt.outstandingRequests[0]?.status, "indeterminate");
	assert.match(receipt.outstandingRequests[0]?.reason ?? "", /unreadable transcript/);
	assert.equal(h.responder.dispatches.length, 0);
});


test("blocked sibling successors continue the old foreground once, before or during recovery", { timeout: 5_000 }, async t => {
	for (const timing of ["before", "during"] as const) {
		const h = harness(t);
		const old = await h.message(h.requester, "old", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Old work" });
		assert.ok("requestMessageId" in old);
		h.responder.stop();
		await h.recover();
		const agents = new Map([h.requester, h.responder].map(p => [p.record.identity.agentId, p.record]));
		const supervisor = new RunSupervisor({ agents, ownerAgentId: "requester", messages: h.messages });
		let siblingAdmitted = false;
		const sibling = async () => {
			if (siblingAdmitted) return;
			siblingAdmitted = true;
			await h.message(h.requester, "sibling", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Sibling work" });
		};
		if (timing === "before") await sibling();
		const resume = () => resumeWorkflow({
			workflowId: "requester", ownerAgentId: "requester", agents, messages: h.messages, quarantinedAgentIds: new Set(),
			activate: async (record, requestIds, recovery) => {
				await sibling();
				const result = await supervisor.continueDormantResponder(record, {
					requestMessageIds: requestIds,
					recovery,
					recheckRequestMessageIds: () => h.messages.recoveryRequestIds(record),
				});
				return { agentId: record.identity.agentId, requestIds, disposition: result === "activated" ? "admitted" : "skipped", reason: result };
			},
		});
		const first = await resume();
		await Promise.all([resume(), resume()]);
		await flush();
		assert.equal(first.outstandingRequests[0]?.status, "continuation_admitted", timing);
		assert.equal(h.responder.dispatches.filter(d => d.kind === "custom" && d.message.customType === "agent-coordination.workflow-continuation").length, 1);
		assert.deepEqual(h.deliveries(h.responder).map(d => d.source.toolCallId), ["old"]);
		await h.message(h.responder, "answer-old", { operation: "answer", requestId: old.requestMessageId, answer: "Done" });
		h.responder.settle();
		await flush();
		assert.deepEqual(h.deliveries(h.responder).map(d => d.source.toolCallId), ["old", "sibling"]);
	}
});

test("recovery reconstructs committed supervisory resume as original ordinary Steer", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const input = { operation: "resume", agentId: "responder", content: "Important supervisor direction" };
	call(h.requester, "supervisory", "agent_control", input);
	const entry = h.requester.manager.getEntries().at(-1)!;
	const messageId = deriveMessageIdentity({ agentId: "requester", entryId: entry.id, toolCallId: "supervisory" });
	commit(h.requester, "supervisory", "agent_control", { agentId: "responder", messageId, messageStatus: "sent" });
	const receipt = await h.resume();
	await flush();
	assert.deepEqual(receipt.outstandingRequests, []);
	assert.equal(h.deliveries(h.responder).length, 1);
	assert.equal(h.deliveries(h.responder)[0]?.source.toolCallId, "supervisory");
	assert.deepEqual(h.deliveries(h.responder)[0]?.projection, {
		kind: "message", messageId, fromAgentId: "requester", content: input.content,
	});
	assert.equal(h.responder.dispatches[0]?.kind === "custom" && h.responder.dispatches[0].deliverAs, "steer");
	await h.resume();
	assert.equal(h.deliveries(h.responder).length, 1);
});


test("supervisory recovery does not resurrect rejected, errored, or uncommitted sources", { timeout: 5_000 }, async t => {
	const h = harness(t);
	for (const state of ["not_held", "resume_slot_occupied", "target_unavailable", "error", "unfinished"] as const) {
		call(h.requester, state, "agent_control", { operation: "resume", agentId: "responder", content: state });
		const entry = h.requester.manager.getEntries().at(-1)!;
		const messageId = deriveMessageIdentity({ agentId: "requester", entryId: entry.id, toolCallId: state });
		if (state === "error") {
			h.requester.manager.appendMessage({ role: "toolResult", toolCallId: state, toolName: "agent_control", content: [], isError: true, timestamp: Date.now() });
		} else if (state !== "unfinished") {
			commit(h.requester, state, "agent_control", { agentId: "responder", messageId, delivery: "rejected", rejectionReason: state });
		}
	}
	await assert.rejects(h.resume(), /may already be admitted or dispatched.*inspection_incomplete/);
	assert.equal(h.responder.dispatches.length, 0);
});

test("recovery coalesces live resume reservations outside ordinary capacity", { timeout: 5_000 }, async t => {
	const h = harness(t, { afterResumeReservation: () => "defer" });
	const hold = h.responder.hold();
	h.policy.publish(Object.freeze({ ...h.policy.current(), maxPendingDeliveriesPerAgent: 1 }));
	await h.message(h.requester, "ordinary", { operation: "send", targetAgent: "responder", content: "Fill ordinary capacity" });
	const input = { operation: "resume" as const, agentId: "responder", content: "Reserved direction" };
	call(h.requester, "supervisory", "agent_control", input);
	const supervisor = new RunSupervisor({
		agents: new Map([h.requester, h.responder].map(p => [p.record.identity.agentId, p.record])),
		ownerAgentId: "requester", messages: h.messages,
	});
	const sent = await supervisor.execute("requester", "supervisory", input);
	assert.ok("messageStatus" in sent && sent.messageStatus === "sent");
	commit(h.requester, "supervisory", "agent_control", sent);
	for (const receipt of await Promise.all([h.resume(), h.resume()])) {
		assert.deepEqual(receipt.outstandingRequests, []);
	}
	assert.equal(h.responder.record.host.currentInterruptionHold(), hold);
	assert.equal(h.responder.dispatches.length, 0);

	// Losing the process-local reservation does not authorize clearing a later Hold.
	await h.recover();
	h.responder.clearHold();
	const newerHold = h.responder.hold();
	await assert.rejects(h.resume(), /may already be admitted or dispatched.*capacity_exhausted/);
	h.policy.publish(Object.freeze({ ...h.policy.current(), maxPendingDeliveriesPerAgent: 2 }));
	await h.resume();
	assert.equal(h.responder.record.host.currentInterruptionHold(), newerHold);
	assert.equal(h.responder.dispatches.length, 0);
	h.responder.clearHold();
	await h.resume();
	await flush();
	assert.equal(h.deliveries(h.responder).filter(d => d.source.toolCallId === "supervisory").length, 1);
	assert.equal(h.responder.record.host.currentInterruptionHold(), undefined);
});

function harness(t: { after(fn: () => void | Promise<void>): void }, boundaryHooks?: MessageBoundaryHooks) {
	const requester = runtimeParticipant("requester");
	const responder = runtimeParticipant("responder");
	const worker = runtimeParticipant("worker");
	const participants = [requester, responder, worker];
	const agents = new Map(participants.map(p => [p.record.identity.agentId, p.record]));
	const options = { agents, boundaryHooks, workflowPolicy: new WorkflowPolicyStore(), isShuttingDown: () => false };
	let messages = new MessageCoordinator(options);
	for (const p of participants) messages.integrate(p.record);
	t.after(() => messages.shutdownDeliveryProgress());
	return {
		requester, responder, worker, agents, policy: options.workflowPolicy,
		get messages() { return messages; },
		async recover() {
			for (const p of participants) messages.discardSchedulingInLane(p.record);
			messages.shutdownDeliveryProgress();
			messages = new MessageCoordinator(options);
			for (const p of participants) messages.integrate(p.record);
			await messages.refreshTranscriptFacts();
		},
		async message(p: ReturnType<typeof runtimeParticipant>, id: string, input: AgentMessageInput) {
			call(p, id, "agent_message", input);
			const result = await messages.execute(p.record.identity.agentId, id, input);
			commit(p, id, "agent_message", result);
			await flush();
			return result;
		},
		resume(
			quarantinedAgentIds = new Set<string>(),
			onActivate?: (agentId: string, requestIds: readonly string[]) => void,
		) {
			return resumeWorkflow({
				workflowId: "requester", ownerAgentId: "requester", agents, messages, quarantinedAgentIds,
				activate: async (record, requestIds): Promise<WorkflowResumeActivation> => {
					onActivate?.(record.identity.agentId, requestIds);
					return { agentId: record.identity.agentId, requestIds, disposition: "skipped", reason: "already_running" };
				},
			});
		},
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
	let hasInput = true;
	let hold: import("../src/runtime/agent-runtime-host.ts").RunResumptionHandle | undefined;
	let holdSequence = 0;
	let attention: "none" | "agent_wait" = "none";
	const ended = new Set<(handle: AgentRunHandle, cause: AgentRunEndCause) => void>();
	const proofCommits: (() => void)[] = [];
	const settled = new Set<(handle: AgentRunHandle, state: "settled") => void>();
	const runtime = {
		...p, blocked: false, deferProof: false, ending: false, failed: false,
		hold() { runtime.blocked = true; hold = { run: handle!, sequence: ++holdSequence }; return hold; },
		clearHold() { runtime.blocked = false; hold = undefined; },
		commitPending() { for (const commit of proofCommits.splice(0)) commit(); },
		settle() { if (handle) for (const handler of settled) handler(handle, "settled"); },
		dispatches: [] as AgentRuntimeDelivery[],
		stop(cause: AgentRunEndCause = "termination") {
			const previous = handle;
			handle = undefined;
			if (previous) for (const handler of ended) handler(previous, cause);
		},
	};
	p.record.host = {
		lane: new SerialLane(),
		residualRequestCounts: () => ({ incoming: 0, outgoing: 0 }),
		currentInterruptionHold: () => hold,
		currentResumptionHold: () => hold,
		currentQuotaSuspension: () => undefined,
		prepareQuotaResumptionInLane: async () => undefined,
		isCurrentResumptionHold: (candidate: unknown) => candidate === hold,
		currentRunHasInput: () => hasInput,
		currentHandle: () => handle, latestStartedRunSequence: () => sequence,
		isCurrent: (candidate: AgentRunHandle) => candidate === handle,
		startInLane: async () => {
			runtime.ending = false;
			runtime.failed = false;
			hasInput = false;
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
		addRetentionReason: () => undefined, removeRetentionReason: () => undefined,
		hasRetentionReason: () => false,
		blocksOrdinaryDelivery: () => runtime.blocked,
		currentWorkState: () => attention === "agent_wait" ? "active" : "settled",
		observe: () => handle ? { phase: runtime.ending ? "ending" : "live", work: attention === "agent_wait" ? "active" : "settled", attention, retentionReasons: [] } : { phase: "dormant", retentionReasons: [] },
		beginAgentWait: () => { attention = "agent_wait"; },
		endAgentWait: () => { attention = "none"; },
		currentRunFailed: () => handle !== undefined && runtime.failed,
		deliverInLane: (input: AgentRuntimeDelivery) => {
			hasInput = true;
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

test("Owner recovery reports only its outbound Requests with target recovery status", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const request = await h.message(h.requester, "scoped", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Work" });
	assert.ok("requestMessageId" in request);
	const receipt = await h.resume();
	assert.deepEqual(receipt.outstandingRequests, [{
		requestMessageId: request.requestMessageId, targetAgentId: "responder", status: "already_running",
	}]);
});

function continuationViews(p: ReturnType<typeof runtimeParticipant>) {
	return p.dispatches.flatMap(delivery => delivery.kind === "custom" &&
		delivery.message.customType === "agent-coordination.workflow-continuation"
		? [JSON.parse(delivery.message.content)] : []);
}

test("nested cyclic recovery finalizes recipient-relative views before dispatch without holding lanes", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const outer = await h.message(h.requester, "outer-view", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Outer" });
	const inner = await h.message(h.responder, "inner-view", { title: "Fixture request", operation: "request", targetAgent: "worker", question: "Inner" });
	h.responder.settle();
	await flush();
	const reverse = await h.message(h.worker, "reverse-view", { title: "Fixture request", operation: "request", targetAgent: "responder", deliveryMode: "steer", question: "Decision" });
	assert.ok("requestMessageId" in outer && "requestMessageId" in inner && "requestMessageId" in reverse);
	h.responder.stop(); h.worker.stop();
	await h.recover();
	const supervisor = new RunSupervisor({ agents: h.agents, ownerAgentId: "requester", messages: h.messages });
	let admissions = 0;
	const receipt = await resumeWorkflow({
		workflowId: "requester", ownerAgentId: "requester", agents: h.agents, messages: h.messages, quarantinedAgentIds: new Set(),
		activate: async (record, requestIds, recovery) => {
			const result = await supervisor.continueDormantResponder(record, {
				requestMessageIds: requestIds, recovery, recheckRequestMessageIds: () => h.messages.recoveryRequestIds(record),
			});
			admissions++;
			assert.equal(continuationViews(h.responder).length + continuationViews(h.worker).length, 0, "no notification before all admissions");
			// An admission never keeps this lane waiting for another recipient.
			await record.host.lane.run(() => {});
			return { agentId: record.identity.agentId, requestIds, disposition: result === "activated" ? "admitted" : "skipped", reason: result };
		},
	});
	assert.equal(admissions, 2);
	await flush();
	const expected = (requestMessageId: string, targetAgentId: string) => [{ requestMessageId, targetAgentId, status: "continuation_admitted" }];
	assert.deepEqual(receipt.outstandingRequests, expected(outer.requestMessageId, "responder"));
	assert.deepEqual(continuationViews(h.responder)[0].outstandingRequests, expected(inner.requestMessageId, "worker"));
	assert.deepEqual(continuationViews(h.worker)[0].outstandingRequests, expected(reverse.requestMessageId, "responder"));
	assert.equal("requestMessageIds" in continuationViews(h.responder)[0], false);
});

test("scoped recovery reports held and failed admissions without claiming continuation", { timeout: 5_000 }, async t => {
	for (const failure of ["held", "unavailable"] as const) {
		const h = harness(t);
		const request = await h.message(h.requester, "failure-view", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Work" });
		assert.ok("requestMessageId" in request);
		h.responder.stop(); await h.recover();
		if (failure === "held") h.responder.blocked = true;
		else h.responder.record.host.startInLane = async () => { throw new Error("runtime unavailable"); };
		const supervisor = new RunSupervisor({ agents: h.agents, ownerAgentId: "requester", messages: h.messages });
		const receipt = await resumeWorkflow({
			workflowId: "requester", ownerAgentId: "requester", agents: h.agents, messages: h.messages, quarantinedAgentIds: new Set(),
			activate: async (record, requestIds, recovery) => {
				const outcome = await supervisor.continueDormantResponder(record, { requestMessageIds: requestIds, recovery, recheckRequestMessageIds: () => h.messages.recoveryRequestIds(record) });
				return { agentId: record.identity.agentId, requestIds, disposition: outcome === "activated" ? "admitted" : "blocked", reason: outcome };
			},
		});
		assert.deepEqual(receipt.outstandingRequests, [{
			requestMessageId: request.requestMessageId, targetAgentId: "responder",
			status: failure === "held" ? "blocked" : "indeterminate",
			reason: failure === "held" ? "held" : "runtime unavailable",
		}]);
		assert.equal(continuationViews(h.responder).length, 0);
	}
});

test("a later activation failure still releases earlier continuations with truthful dependent status", { timeout: 5_000 }, async t => {
	const h = harness(t);
	await h.message(h.requester, "release-outer", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Outer" });
	const inner = await h.message(h.responder, "release-inner", { title: "Fixture request", operation: "request", targetAgent: "worker", question: "Inner" });
	assert.ok("requestMessageId" in inner);
	h.responder.stop(); h.worker.stop(); await h.recover();
	const supervisor = new RunSupervisor({ agents: h.agents, ownerAgentId: "requester", messages: h.messages });
	const receipt = await resumeWorkflow({
		workflowId: "requester", ownerAgentId: "requester", agents: h.agents, messages: h.messages, quarantinedAgentIds: new Set(),
		activate: async (record, requestIds, recovery) => {
			if (record.identity.agentId === "worker") throw new Error("host_shutting_down");
			const result = await supervisor.continueDormantResponder(record, { requestMessageIds: requestIds, recovery, recheckRequestMessageIds: () => h.messages.recoveryRequestIds(record) });
			return { agentId: record.identity.agentId, requestIds, disposition: result === "activated" ? "admitted" : "skipped", reason: result };
		},
	});
	assert.equal(receipt.outstandingRequests[0]?.status, "continuation_admitted");
	assert.deepEqual(continuationViews(h.responder)[0].outstandingRequests, [{
		requestMessageId: inner.requestMessageId, targetAgentId: "worker", status: "indeterminate", reason: "host_shutting_down",
	}]);
	assert.equal(continuationViews(h.worker).length, 0);
});

test("cancellation while continuation is gated suppresses stale runtime input", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const request = await h.message(h.requester, "gated-cancel", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Work" });
	assert.ok("requestMessageId" in request);
	h.responder.stop(); await h.recover();
	const supervisor = new RunSupervisor({ agents: h.agents, ownerAgentId: "requester", messages: h.messages });
	await resumeWorkflow({
		workflowId: "requester", ownerAgentId: "requester", agents: h.agents, messages: h.messages, quarantinedAgentIds: new Set(),
		activate: async (record, requestIds, recovery) => {
			const result = await supervisor.continueDormantResponder(record, { requestMessageIds: requestIds, recovery, recheckRequestMessageIds: () => h.messages.recoveryRequestIds(record) });
			await h.message(h.requester, "cancel-admitted", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "No longer needed" });
			return { agentId: record.identity.agentId, requestIds, disposition: result === "activated" ? "admitted" : "skipped", reason: result };
		},
	});
	assert.equal(continuationViews(h.responder).length, 0);
});

test("unavailable outbound targets do not erase verified responder recovery", { timeout: 5_000 }, async t => {
	for (const mode of ["running", "dormant"] as const) {
		const h = harness(t);
		const outer = await h.message(h.requester, "unrelated-outer", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Outer" });
		const inner = await h.message(h.responder, "unrelated-inner", { title: "Fixture request", operation: "request", targetAgent: "worker", question: "Inner" });
		assert.ok("requestMessageId" in outer && "requestMessageId" in inner);
		if (mode === "dormant") {
			await h.message(h.responder, "unrelated-reverse", { title: "Fixture request", operation: "request", targetAgent: "requester", question: "Decision" });
			h.requester.stop(); h.responder.stop();
		}
		await h.recover();
		h.worker.record.transcript.refresh = async () => { throw new Error("worker transcript unreadable"); };
		const supervisor = new RunSupervisor({ agents: h.agents, ownerAgentId: "requester", messages: h.messages });
		const receipt = await resumeWorkflow({
			workflowId: "requester", ownerAgentId: "requester", agents: h.agents, messages: h.messages, quarantinedAgentIds: new Set(),
			activate: async (record, requestIds, recovery) => {
				const outcome = await supervisor.continueDormantResponder(record, { requestMessageIds: requestIds, recovery, recheckRequestMessageIds: () => h.messages.recoveryRequestIds(record) });
				return { agentId: record.identity.agentId, requestIds, disposition: outcome === "activated" ? "admitted" : "skipped", reason: outcome };
			},
		});
		const expected = [{ requestMessageId: outer.requestMessageId, targetAgentId: "responder", status: mode === "running" ? "already_running" : "continuation_admitted" }];
		assert.deepEqual(receipt.outstandingRequests, expected);
		if (mode === "dormant") {
			assert.deepEqual(continuationViews(h.requester)[0].outstandingRequests, expected);
			assert.deepEqual(continuationViews(h.responder)[0].outstandingRequests.find((item: { requestMessageId: string }) => item.requestMessageId === inner.requestMessageId), {
				requestMessageId: inner.requestMessageId, targetAgentId: "worker", status: "indeterminate", reason: "worker transcript unreadable",
			});
		}
	}
});

test("Owner recovery returns only its recipient-relative view", { timeout: 5_000 }, async t => {
	const h = harness(t);
	assert.deepEqual(await h.resume(), { workflowId: "requester", outstandingRequests: [] });
});

test("recovery releases every admitted recipient before reporting partial dispatch failure", { timeout: 5_000 }, async t => {
	const h = harness(t);
	await h.message(h.requester, "release-failure-outer", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Outer" });
	await h.message(h.responder, "release-failure-inner", { title: "Fixture request", operation: "request", targetAgent: "worker", question: "Inner" });
	h.responder.stop(); h.worker.stop(); await h.recover();
	const supervisor = new RunSupervisor({ agents: h.agents, ownerAgentId: "requester", messages: h.messages });
	const released: string[] = [];
	const release = h.messages.deliveryEligibilityChanged.bind(h.messages);
	h.messages.deliveryEligibilityChanged = record => {
		released.push(record.identity.agentId);
		if (record.identity.agentId === "responder") throw new Error("dispatch failed");
		return release(record);
	};
	await assert.rejects(resumeWorkflow({
		workflowId: "requester", ownerAgentId: "requester", agents: h.agents, messages: h.messages, quarantinedAgentIds: new Set(),
		activate: async (record, requestIds, recovery) => {
			const outcome = await supervisor.continueDormantResponder(record, { requestMessageIds: requestIds, recovery, recheckRequestMessageIds: () => h.messages.recoveryRequestIds(record) });
			return { agentId: record.identity.agentId, requestIds, disposition: outcome === "activated" ? "admitted" : "skipped", reason: outcome };
		},
	}), /may already be admitted or dispatched.*dispatch failed/);
	assert.deepEqual(released.sort(), ["responder", "worker"]);
	assert.equal(continuationViews(h.worker).length, 1);
});

test("non-Request recovery failures surface after admitted responders are released", { timeout: 5_000 }, async t => {
	for (const [kind, stage] of [["message", "admission"], ["answer", "admission"], ["message", "inspection"], ["message", "enumeration"]] as const) {
		const h = harness(t);
		await h.message(h.requester, "non-request-outer", { title: "Fixture request", operation: "request", targetAgent: "responder", question: "Work" });
		if (kind === "answer") {
			const request = await h.message(h.requester, "non-request-answered", { title: "Fixture request", operation: "request", targetAgent: "worker", question: "Answer this" });
			assert.ok("requestMessageId" in request);
			h.requester.blocked = true;
			await h.message(h.worker, "non-request-answer", { operation: "answer", requestId: request.requestMessageId, answer: "Completed work" });
			h.requester.blocked = false;
		} else {
			h.worker.blocked = true;
			await h.message(h.requester, "non-request-message", { operation: "send", targetAgent: "worker", content: "Pending instruction" });
		}
		h.responder.stop(); await h.recover();
		const supervisor = new RunSupervisor({ agents: h.agents, ownerAgentId: "requester", messages: h.messages });
		if (stage === "admission") {
			const resume = h.messages.resumeMessage.bind(h.messages);
			h.messages.resumeMessage = async message => {
				if (message.kind !== "request") throw new Error(`${kind} admission failed`);
				return resume(message);
			};
		} else if (stage === "inspection") {
			const inspect = h.messages.inspectRecoveryMessage.bind(h.messages);
			h.messages.inspectRecoveryMessage = message => {
				if (message.kind !== "request") throw new Error("message inspection failed");
				return inspect(message);
			};
		} else {
			const candidates = h.messages.recoveryMessageCandidates.bind(h.messages);
			h.messages.recoveryMessageCandidates = record => {
				if (record.identity.agentId === "requester") throw new Error("message enumeration failed");
				return candidates(record);
			};
		}
		await assert.rejects(resumeWorkflow({
			workflowId: "requester", ownerAgentId: "requester", agents: h.agents, messages: h.messages, quarantinedAgentIds: new Set(),
			activate: async (record, requestIds, recovery) => {
				const outcome = await supervisor.continueDormantResponder(record, { requestMessageIds: requestIds, recovery, recheckRequestMessageIds: () => h.messages.recoveryRequestIds(record) });
				return { agentId: record.identity.agentId, requestIds, disposition: outcome === "activated" ? "admitted" : "skipped", reason: outcome };
			},
		}), new RegExp(`may already be admitted or dispatched.*${kind} ${stage} failed`));
		assert.equal(continuationViews(h.responder).length, 1);
	}
});

test("unreadable Owner snapshot is an error rather than an empty outbound view", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.requester.record.transcript.refresh = async () => { throw new Error("Owner snapshot unreadable"); };
	await assert.rejects(h.resume(), /may already be admitted or dispatched.*Owner snapshot unreadable/);
});

for (const operation of ["send", "request"] as const) {
	test(`recovery omits ${operation} rejected for an ambiguous target without weakening caller lookup`, { timeout: 5_000 }, async t => {
		const h = harness(t);
		const input: AgentMessageInput = operation === "send"
			? { operation, targetAgent: "Owner", content: "Not created" }
			: { title: "Fixture request", operation, targetAgent: "Owner", question: "Not created" };
		const id = `ambiguous-${operation}`;
		call(h.requester, id, "agent_message", input);
		await assert.rejects(h.messages.execute("requester", id, input), /ambiguous_target/);
		h.requester.manager.appendMessage({
			role: "toolResult", toolCallId: id, toolName: "agent_message",
			content: [{ type: "text", text: "ambiguous_target: Agent label Owner matches multiple Agents" }],
			isError: true, timestamp: Date.now(),
		});
		await h.recover();
		const candidate = h.messages.recoveryMessageCandidates(h.requester.record)[0]!;
		call(h.requester, "poll-failed", "agent_message", { operation: "poll", messageId: candidate.messageId });
		await assert.rejects(h.messages.execute("requester", "poll-failed", {
			operation: "poll", messageId: candidate.messageId,
		}), /unknown_identity/);
		assert.deepEqual(await h.resume(), { workflowId: "requester", outstandingRequests: [] });
		assert.equal(h.deliveries(h.responder).length, 0);
		assert.equal(h.deliveries(h.worker).length, 0);
	});
}

test("recovery preserves failed-authoring contradictions and quarantined uncertainty", { timeout: 5_000 }, async t => {
	for (const evidence of ["delivery", "quarantined"] as const) {
		const h = harness(t);
		const id = `failed-with-${evidence}`;
		const input: AgentMessageInput = { operation: "send", targetAgent: "responder", content: "Inspect all proof" };
		call(h.requester, id, "agent_message", input);
		if (evidence === "delivery") {
			await h.messages.execute("requester", id, input);
			await flush();
			assert.equal(h.deliveries(h.responder).length, 1);
		}
		h.requester.manager.appendMessage({
			role: "toolResult", toolCallId: id, toolName: "agent_message",
			content: [{ type: "text", text: "Authoring failed" }], isError: true, timestamp: Date.now(),
		});
		const messages = new MessageCoordinator({
			agents: h.agents, workflowPolicy: h.policy, isShuttingDown: () => false,
			quarantinedWorkflowAgentIds: new Set(evidence === "quarantined" ? ["unreadable-peer"] : []),
		});
		t.after(() => messages.shutdownDeliveryProgress());
		await assert.rejects(resumeWorkflow({
			workflowId: "requester", ownerAgentId: "requester", agents: h.agents, messages,
			quarantinedAgentIds: new Set(),
			activate: async (record, requestIds) => ({
				agentId: record.identity.agentId, requestIds, disposition: "skipped", reason: "already_running",
			}),
		}), evidence === "delivery" ? /error result and Delivery/ : /evidence_unavailable.*quarantined Agent proof/);
	}
});
