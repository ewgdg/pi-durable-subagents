import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { validateAgentMessageInput, sameAgentMessageInput } from "../src/protocol/agent-message-input.ts";
import { validateAgentSpawnInput } from "../src/protocol/agent-spawn-input.ts";
import { resolveCommittedMessage, resolveCommittedAnswer, createMessageDeliveryItem, inspectCanonicalMessage, inspectMessageDelivery, retrievalsForRequest } from "../src/protocol/message.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import { validateAgentWaitResult, inspectCommittedAgentWaitResult } from "../src/protocol/agent-wait.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { obligationStack } from "../src/protocol/obligation-focus.ts";
import { resolveCreationRequest } from "../src/protocol/creation-request.ts";
import { createModelVisibleObligationReminder, inspectObligationReminder, OBLIGATION_REMINDER_GUIDANCE } from "../src/protocol/obligation-reminder.ts";

test("obligation reminders use the exact Request title, not a body excerpt", () => {
	const requestTitle = "Confirm checkpoint constants";
	const reminder = createModelVisibleObligationReminder({ requestMessageId: "request", requestTitle });
	assert.deepEqual(JSON.parse(reminder.content), { requestMessageId: "request", requestTitle, guidance: OBLIGATION_REMINDER_GUIDANCE });
	assert.throws(() => createModelVisibleObligationReminder({ requestMessageId: "request", requestTitle: " " }), /title/);
	const recipient = SessionManager.inMemory(process.cwd(), { id: "recipient" });
	recipient.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: "recipient" });
	recipient.appendCustomMessageEntry(reminder.customType, reminder.content, reminder.display);
	const inspect = (title: string) => inspectObligationReminder({ recipientAgentId: "recipient", transcript: transcriptFromSessionManager(recipient).inspect(), requestMessageId: "request", requestTitle: title });
	assert.ok(inspect(requestTitle));
	assert.throws(() => inspect("A different request"), /contradicts/);
});

test("Wait Answers require the originating title for both body and proof-only results", () => {
	const source = { agentId: "worker", entryId: "entry", toolCallId: "answer-call" };
	const body = { disposition: "answer_delivered", requestMessageId: "request", requestTitle: "Confirm constants", answerId: deriveMessageIdentity(source), fromAgentId: "worker", answer: "Confirmed", answerSource: source };
	const proof = { disposition: "answer_already_delivered", requestMessageId: "request", requestTitle: "Confirm constants", answerId: deriveMessageIdentity(source), deliveryEvidence: { agentId: "author", entryId: "delivery" } };
	for (const answer of [body, proof]) {
		assert.deepEqual(validateAgentWaitResult({ answers: [answer] }), { answers: [answer] });
		assert.throws(() => validateAgentWaitResult({ answers: [{ ...answer, requestTitle: " " }] }));
	}
});

test("ordinary and Creation Requests require an exact nonblank sender title", () => {
	const request = { operation: "request" as const, targetAgent: "worker", title: "Confirm checkpoint constants", question: "Please confirm the two exported constants." };
	assert.deepEqual(validateAgentMessageInput(request), request);
	assert.deepEqual(validateAgentSpawnInput({ title: request.title, request: request.question }), { title: request.title, request: request.question });
	for (const title of [undefined, "", " \n ", 42]) {
		assert.throws(() => validateAgentMessageInput({ ...request, title }));
		assert.throws(() => validateAgentSpawnInput({ title, request: request.question }));
	}
	assert.equal(sameAgentMessageInput(request, { ...request, title: "Another task" }), false);
	assert.throws(() => validateAgentMessageInput({ operation: "answer", requestId: "request", answer: "Done", requestTitle: "Invented" }));
});

test("canonical Request and Answer projections retain the authored Request title", () => {
	const author = SessionManager.inMemory(process.cwd(), { id: "author" });
	const responder = SessionManager.inMemory(process.cwd(), { id: "worker" });
	author.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: "author" });
	responder.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: "worker" });
	const input = { operation: "request" as const, targetAgent: "worker", title: "Confirm checkpoint constants", question: "The full instructions remain here." };
	author.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", input, { id: "request-call" }), { stopReason: "toolUse" }));
	const request = resolveCommittedMessage({ fromAgentId: "author", workflowId: "workflow", transcript: transcriptFromSessionManager(author).inspect(), toolCallId: "request-call", providedInput: input, resolvedTargetAgentId: "worker" });
	assert.equal(request.kind, "request");
	if (request.kind !== "request") throw new Error("Expected Request");
	assert.equal(request.title, input.title);
	assert.deepEqual(createMessageDeliveryItem(request).projection, { kind: "request", requestMessageId: request.messageId, fromAgentId: "author", title: input.title, question: input.question });
	const incoming = createMessageDelivery([createMessageDeliveryItem(request)]);
	responder.appendCustomMessageEntry(incoming.customType, incoming.content, incoming.display, incoming.details);
	assert.deepEqual(obligationStack(transcriptFromSessionManager(responder).inspect(), "worker"), [{ requestId: request.messageId, requesterAgentId: "author", title: input.title, question: input.question }]);
	assert.throws(() => resolveCommittedMessage({ fromAgentId: "author", workflowId: "workflow", transcript: transcriptFromSessionManager(author).inspect(), toolCallId: "request-call", providedInput: { ...input, title: "Tampered" }, resolvedTargetAgentId: "worker" }), /differs/);
	const answerInput = { operation: "answer" as const, requestId: request.messageId, answer: "Confirmed." };
	responder.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", answerInput, { id: "answer-call" }), { stopReason: "toolUse" }));
	const answer = resolveCommittedAnswer({ responderAgentId: "worker", transcript: transcriptFromSessionManager(responder).inspect(), toolCallId: "answer-call", providedInput: answerInput, request });
	assert.equal(answer.requestTitle, input.title);
	assert.deepEqual(createMessageDeliveryItem(answer).projection, { kind: "answer", answerId: answer.messageId, requestMessageId: request.messageId, requestTitle: input.title, fromAgentId: "worker", answer: "Confirmed." });
	const receipt = { messageId: answer.messageId, requestMessageId: request.messageId, requestTitle: input.title, messageStatus: "sent" };
	responder.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "answer-call", content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt, isError: false, timestamp: Date.now() });
	assert.equal(inspectCanonicalMessage({ message: answer, authorTranscript: transcriptFromSessionManager(responder).inspect() }).state, "canonical");
	assert.deepEqual(obligationStack(transcriptFromSessionManager(responder).inspect(), "worker"), [], "Answer commitment clears the obligation before requester Delivery");
	assert.throws(() => inspectCanonicalMessage({ message: { ...answer, requestTitle: "Wrong title" }, authorTranscript: transcriptFromSessionManager(responder).inspect() }), /wrong Request title/);
	assert.throws(() => inspectMessageDelivery({ recipientAgentId: "worker", transcript: transcriptFromSessionManager(responder).inspect(), message: { ...request, title: "Wrong title" } }), /title differs/);
});

test("Creation Request title identifies work independently of the Agent label", () => {
	const request = resolveCreationRequest({ childIdentity: { agentId: "worker", workflowId: "workflow", directSpawnerAgentId: "author", spawnSource: { agentId: "author", entryId: "spawn", toolCallId: "spawn-call" }, creationPreset: null, metadata: { label: "storage-worker" } }, creationInput: { title: "Implement atomic checkpoint files", request: "Full implementation instructions." } });
	assert.equal(request.title, "Implement atomic checkpoint files");
	assert.equal(createMessageDeliveryItem(request).projection.kind, "request");
});

for (const toolName of ["agent_wait", "agent_message"] as const) test(`${toolName} retrieval binds the title to its canonical authored Request`, () => {
	for (const title of ["Original title", "Forged title"]) {
		const author = SessionManager.inMemory(process.cwd(), { id: "author" });
		author.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: "author" });
		const entryId = author.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request", targetAgent: "worker", title: "Original title", question: "Full question" }, { id: "request-call" }), { stopReason: "toolUse" }));
		const requestMessageId = deriveMessageIdentity({ agentId: "author", entryId, toolCallId: "request-call" });
		author.appendMessage(fauxAssistantMessage(fauxToolCall(toolName, toolName === "agent_wait" ? { requestMessageIds: [requestMessageId] } : { operation: "retry", messageId: requestMessageId }, { id: "retrieve" }), { stopReason: "toolUse" }));
		const answerSource = { agentId: "worker", entryId: "answer-entry", toolCallId: "answer-call" };
		const answer = { disposition: "answer_delivered", requestMessageId, requestTitle: title, answerId: deriveMessageIdentity(answerSource), fromAgentId: "worker", answer: "Done", answerSource };
		const details = toolName === "agent_wait" ? { answers: [answer] } : answer;
		author.appendMessage({ role: "toolResult", toolName, toolCallId: "retrieve", content: [{ type: "text", text: JSON.stringify(details) }], details, isError: false, timestamp: Date.now() });
		const inspect = () => toolName === "agent_wait" ? inspectCommittedAgentWaitResult({ agentId: "author", transcript: transcriptFromSessionManager(author).inspect(), toolCallId: "retrieve" }) : retrievalsForRequest({ requesterAgentId: "author", transcript: transcriptFromSessionManager(author).inspect(), requestId: requestMessageId });
		if (title === "Original title") assert.doesNotThrow(inspect);
		else assert.throws(inspect, /title differs|Retrieval evidence is invalid/);
	}
});
