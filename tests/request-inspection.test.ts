import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { createMessageDelivery, type MessageDeliveryItem } from "../src/protocol/message-delivery.ts";
import { deriveMessageIdentity, type ToolCallPointer } from "../src/protocol/identities.ts";
import { participant } from "./support/request-history.ts";

type Participant = ReturnType<typeof participant>;

function history() {
	const author = participant("author");
	const recipient = participant("recipient");
	const other = participant("other");
	const agents = new Map([author, recipient, other].map(agent => [agent.record.identity.agentId, agent.record]));
	const evidence = new RequestEvidence(agents);
	let sequence = 0;
	function call(agent: Participant, input: Record<string, unknown>, result: (source: ToolCallPointer) => object) {
		const toolCallId = `call-${++sequence}`;
		const entryId = agent.manager.appendMessage(fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }), { stopReason: "toolUse" },
		));
		const source = { agentId: agent.record.identity.agentId, entryId, toolCallId };
		const details = result(source);
		agent.manager.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId,
			content: [{ type: "text", text: JSON.stringify(details) }], details, isError: false, timestamp: Date.now() });
		return source;
	}
	function deliver(to: Participant, item: MessageDeliveryItem) {
		const message = createMessageDelivery([item]);
		to.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
	}
	function request(title: string, question: string, delivered = true, to = recipient) {
		const source = call(author, { operation: "request", title, question, targetAgent: to.record.identity.agentId },
			pointer => ({ requestMessageId: deriveMessageIdentity(pointer), targetAgentId: to.record.identity.agentId, messageStatus: "sent" }));
		const requestMessageId = deriveMessageIdentity(source);
		if (delivered) deliver(to, { source, projection: {
			kind: "request", requestMessageId, fromAgentId: author.record.identity.agentId, title, question,
		} });
		return { requestMessageId, title, question, source };
	}
	function answer(incoming: ReturnType<typeof request>) {
		call(recipient, { operation: "answer", requestId: incoming.requestMessageId, answer: "Confirmed." },
			source => ({ messageId: deriveMessageIdentity(source), requestMessageId: incoming.requestMessageId,
				requestTitle: incoming.title, messageStatus: "sent" }));
	}
	return { author, recipient, other, evidence, call, deliver, request, answer };
}

test("outstanding incoming Requests list delivered unanswered obligations without repeating bodies", () => {
	const h = history();
	const body = "Full instructions\n\nKeep the exact final constraint: 禁止改写。";
	const open = h.request("Check storage constants", body);
	h.request("Queued work", "Not delivered.", false);
	const answered = h.request("Already completed work", "Done instructions.");
	h.answer(answered);
	const before = h.recipient.manager.getEntries().length;
	assert.deepEqual(h.evidence.openIncomingRequests(h.recipient.record), { requests: [{
		requestMessageId: open.requestMessageId, requesterAgentId: "author", title: open.title,
	}] });
	assert.deepEqual(h.evidence.openIncomingRequests(h.author.record), { requests: [] });
	assert.equal(h.recipient.manager.getEntries().length, before, "listing is passive");
});

test("inspection retrieves exact full instructions for authored or received Requests, including closed work", () => {
	const h = history();
	const request = h.request("Check storage constants", "First line.\n\nDo not omit the final constraint.  ");
	h.answer(request);
	const expected = { requestMessageId: request.requestMessageId, requesterAgentId: "author",
		responderAgentId: "recipient", title: request.title, question: request.question };
	for (const caller of [h.author, h.recipient]) {
		const before = caller.manager.getEntries().length;
		assert.deepEqual(h.evidence.inspectRequest(caller.record, request.requestMessageId.slice(-12)), expected);
		assert.equal(caller.manager.getEntries().length, before, "inspection does not append Delivery evidence");
	}
	assert.throws(() => h.evidence.inspectRequest(h.other.record, request.requestMessageId), /unknown_identity/);
	assert.throws(() => h.evidence.inspectRequest(h.recipient.record, " "), /invalid_input/);
	const queued = h.request("Queued work", "Not yet received.", false);
	assert.throws(() => h.evidence.inspectRequest(h.recipient.record, queued.requestMessageId), /unknown_identity/);
	assert.equal(h.evidence.inspectRequest(h.author.record, queued.requestMessageId).question, queued.question);
});

test("inspection rejects incoming evidence for a different responder", () => {
	const h = history();
	const request = h.request("Recipient work", "Instructions for the recipient.");
	h.deliver(h.other, { source: request.source, projection: {
		kind: "request", requestMessageId: request.requestMessageId, fromAgentId: "author",
		title: request.title, question: request.question,
	} });
	assert.throws(() => h.evidence.inspectRequest(h.other.record, request.requestMessageId), /invariant_violation/);
});

test("Cancellation Delivery removes only its incoming obligation and keeps the Request inspectable", () => {
	const h = history();
	const request = h.request("Cancel this work", "Instructions that remain inspectable.");
	const source = h.call(h.author, { operation: "cancel", requestMessageId: request.requestMessageId, reason: "No longer needed." },
		pointer => ({ messageId: deriveMessageIdentity(pointer), targetAgentId: "recipient", messageStatus: "sent" }));
	assert.equal(h.evidence.openIncomingRequests(h.recipient.record).requests.length, 1,
		"requester Cancellation commitment alone is not recipient Delivery");
	h.deliver(h.recipient, { source, projection: { kind: "request_cancellation", cancellationId: deriveMessageIdentity(source),
		requestMessageId: request.requestMessageId, fromAgentId: "author", reason: "No longer needed." } });
	assert.deepEqual(h.evidence.openIncomingRequests(h.recipient.record), { requests: [] });
	assert.equal(h.evidence.inspectRequest(h.recipient.record, request.requestMessageId).question, request.question);
});

test("Request inspection rejects ambiguous suffixes rather than using titles to guess", () => {
	const h = history();
	const bySuffix = new Map<string, string>();
	// SHA-256 base64url IDs have only sixteen possible final characters.
	for (let index = 0; index < 17; index++) {
		const request = h.request("Same display title", `Distinct instructions ${index}`);
		const suffix = request.requestMessageId.slice(-1);
		if (bySuffix.has(suffix)) {
			assert.throws(() => h.evidence.inspectRequest(h.recipient.record, suffix), /ambiguous_target/);
			assert.equal(h.evidence.inspectRequest(h.recipient.record, request.requestMessageId).question, request.question);
			return;
		}
		bySuffix.set(suffix, request.requestMessageId);
	}
	assert.fail("Expected two Request identities sharing a final character");
});
