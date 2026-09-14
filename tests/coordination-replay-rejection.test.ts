import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { findAuthoredAgentMessageSources } from "../src/protocol/request-resolution.ts";
import { inspectMessageDeliveries, createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { inspectCoordinationRejections } from "../src/protocol/replay-rejection.ts";
import { obligationStack } from "../src/protocol/obligation-focus.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";

function fixture() {
 const manager = SessionManager.inMemory(process.cwd(), { id: "reader" });
 manager.appendCustomEntry("agent-coordination.identity", { agentId: "reader" });
 return {manager, inspect: () => transcriptFromSessionManager(manager).inspect()};
}

test("rejected calls cannot poison valid suffixes or gain authority from old success receipts", () => {
 const {manager, inspect} = fixture();
 const entryId = manager.appendMessage(fauxAssistantMessage([
  fauxToolCall("agent_message", {operation:"request",targetAgent:"other",question:"old missing title"}, {id:"invalid"}),
  fauxToolCall("agent_message", {operation:"request",targetAgent:"other",title:"Valid",question:"work"}, {id:"valid"}),
 ]));
 manager.appendMessage({role:"toolResult",toolName:"agent_message",toolCallId:"invalid",content:[],isError:false,timestamp:1,
  details:{requestMessageId:deriveMessageIdentity({agentId:"reader",entryId,toolCallId:"invalid"}),targetAgentId:"other",messageStatus:"sent"}});
 const raw = JSON.stringify(inspect().entries);
 assert.deepEqual(findAuthoredAgentMessageSources({authorAgentId:"reader",transcript:inspect()}).map(x=>x.source.toolCallId), ["valid"]);
 const rejected = inspectCoordinationRejections(inspect(), "reader");
 assert.equal(rejected.length, 1);
 assert.deepEqual(rejected[0]?.source, {agentId:"reader",entryId,toolCallId:"invalid"});
 assert.equal(rejected[0]?.reason,"invalid");
 assert.match(rejected[0]!.diagnostic,/title/);
 manager.branch(entryId);
 assert.equal(inspectCoordinationRejections(inspect(),"reader").length,1);
 assert.equal(JSON.stringify(inspect().entries),raw);
});

test("malformed Delivery batches are rejected atomically without discarding later valid Deliveries", () => {
 const {manager, inspect} = fixture();
 const source={agentId:"sender",entryId:"request",toolCallId:"q"};
 const valid={kind:"request" as const,requestMessageId:deriveMessageIdentity(source),fromAgentId:"sender",title:"Keep",question:"Work"};
 manager.appendCustomMessageEntry("agent-coordination.message-delivery",JSON.stringify({messages:[valid,{kind:"request"}]}),true,{messages:[source,{...source,toolCallId:"broken"}]});
 const delivery=createMessageDelivery([{source,projection:valid}]);
 manager.appendCustomMessageEntry(delivery.customType,delivery.content,delivery.display,delivery.details);
 assert.equal(inspectMessageDeliveries({recipientAgentId:"reader",transcript:inspect()}).length,1);
 assert.deepEqual(obligationStack(inspect(),"reader").map(f=>f.requestId),[valid.requestMessageId]);
 assert.equal(inspectCoordinationRejections(inspect(),"reader").length,1);
});

test("a rejected Answer and an old success receipt do not discharge a delivered obligation", () => {
 const {manager,inspect}=fixture();
 const source={agentId:"sender",entryId:"request",toolCallId:"q"};
 const requestId=deriveMessageIdentity(source);
 const delivery=createMessageDelivery([{source,projection:{kind:"request",requestMessageId:requestId,fromAgentId:"sender",title:"Keep",question:"Work"}}]);
 manager.appendCustomMessageEntry(delivery.customType,delivery.content,delivery.display,delivery.details);
 const entryId=manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",{operation:"answer",requestId,answer:""},{id:"invalid-answer"})));
 manager.appendMessage({role:"toolResult",toolName:"agent_message",toolCallId:"invalid-answer",content:[],isError:false,timestamp:1,
 details:{messageId:deriveMessageIdentity({agentId:"reader",entryId,toolCallId:"invalid-answer"}),requestMessageId:requestId,requestTitle:"Keep",messageStatus:"sent"}});
 assert.deepEqual(obligationStack(inspect(),"reader").map(f=>f.requestId),[requestId]);
 assert.equal(findAuthoredAgentMessageSources({authorAgentId:"reader",transcript:inspect()}).length,0);
});

test("malformed Answer results and later focus snapshots have no discharge effect", () => {
 const {manager,inspect}=fixture();
 const source={agentId:"sender",entryId:"request",toolCallId:"q"}; const requestId=deriveMessageIdentity(source);
 const delivery=createMessageDelivery([{source,projection:{kind:"request",requestMessageId:requestId,fromAgentId:"sender",title:"Keep",question:"Work"}}]);
 manager.appendCustomMessageEntry(delivery.customType,delivery.content,true,delivery.details);
 manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",{operation:"answer",requestId,answer:"Done"},{id:"answer"})));
 manager.appendMessage({role:"toolResult",toolName:"agent_message",toolCallId:"answer",content:[],isError:false,timestamp:1,
 details:{messageId:"old-result",requestMessageId:requestId,messageStatus:"sent"}});
 manager.appendCustomEntry("agent-coordination.obligation-focus",{frames:[]});
 assert.deepEqual(obligationStack(inspect(),"reader").map(f=>f.requestId),[requestId]);
 assert.equal(inspectCoordinationRejections(inspect(),"reader").length,1);
});

test("valid local Answer commitment closes an orphan obligation and stays closed on replay", () => {
 const {manager,inspect}=fixture();
 const source={agentId:"sender",entryId:"request",toolCallId:"q"}; const requestId=deriveMessageIdentity(source);
 const delivery=createMessageDelivery([{source,projection:{kind:"request",requestMessageId:requestId,fromAgentId:"sender",title:"Keep",question:"Work"}}]);
 manager.appendCustomMessageEntry(delivery.customType,delivery.content,true,delivery.details);
 const entryId=manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",{operation:"answer",requestId,answer:"Done"},{id:"answer"})));
 manager.appendMessage({role:"toolResult",toolName:"agent_message",toolCallId:"answer",content:[],isError:false,timestamp:1,
 details:{messageId:deriveMessageIdentity({agentId:"reader",entryId,toolCallId:"answer"}),requestMessageId:requestId,requestTitle:"Keep",disposition:"committed",delivery:"omitted",reason:"request_source_unavailable"}});
 assert.deepEqual(obligationStack(inspect(),"reader"),[]);
 const snapshot=inspect();
 assert.deepEqual(obligationStack({...snapshot,entries:structuredClone(snapshot.entries)},"reader"),[]);
 assert.deepEqual(inspectCoordinationRejections(inspect(),"reader"),[]);
});

test("Wait and retrieval history with a rejected Request source cannot restore authority", async () => {
 const {inspectCommittedAgentWaitResult}=await import("../src/protocol/agent-wait.ts");
 const {inspectAnswerRetrievals}=await import("../src/protocol/message.ts");
 const {manager,inspect}=fixture();
 const entryId=manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",{operation:"request",targetAgent:"other",question:"No title"},{id:"q"})));
 const requestId=deriveMessageIdentity({agentId:"reader",entryId,toolCallId:"q"});
 manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_wait",{requestMessageIds:[requestId]},{id:"wait"})));
 const answerSource={agentId:"other",entryId:"a",toolCallId:"a"};
 const answer={disposition:"answer_delivered",requestMessageId:requestId,requestTitle:"Old title",answerId:deriveMessageIdentity(answerSource),fromAgentId:"other",answer:"Done",answerSource};
 const result={answers:[answer]};
 manager.appendMessage({role:"toolResult",toolName:"agent_wait",toolCallId:"wait",content:[{type:"text",text:JSON.stringify(result)}],details:result,isError:false,timestamp:1});
 assert.equal(inspectCommittedAgentWaitResult({agentId:"reader",transcript:inspect(),toolCallId:"wait"}).state,"pending");
 assert.deepEqual(inspectAnswerRetrievals({requesterAgentId:"reader",transcript:inspect()}),[]);
});

test("secondary reminder and recovery readers share record rejection without suppressing valid suffixes", async () => {
 const {inspectObligationReminder,createModelVisibleObligationReminder}=await import("../src/protocol/obligation-reminder.ts");
 const {manager,inspect}=fixture();
 manager.appendCustomMessageEntry("agent-coordination.obligation-reminder","not JSON",true);
 const reminder=createModelVisibleObligationReminder({requestMessageId:"q",requestTitle:"Keep"});
 const entryId=manager.appendCustomMessageEntry(reminder.customType,reminder.content,true);
 assert.deepEqual(inspectObligationReminder({recipientAgentId:"reader",transcript:inspect(),requestMessageId:"q",requestTitle:"Keep"}),{agentId:"reader",entryId});
 assert.equal(inspectCoordinationRejections(inspect(),"reader").length,1);
});

test("off-branch rejection survives compaction and a fresh all-branch replay", () => {
	const { manager, inspect } = fixture();
	const identity = manager.getLeafEntry()!.id;
	const rejectedEntry = manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: "other", question: "Old schema accepted this",
	}, { id: "off-branch" })));
	manager.branch(identity);
	const validEntry = manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: "other", title: "Current", question: "Independent work",
	}, { id: "current" })));
	manager.appendCompaction("The old history is informational", validEntry, 100);
	const snapshot = inspect();
	assert.ok(!snapshot.activeBranch.some(entry => entry.id === rejectedEntry));
	for (const transcript of [snapshot, { ...snapshot, entries: structuredClone(snapshot.entries) }]) {
		assert.deepEqual(findAuthoredAgentMessageSources({ authorAgentId: "reader", transcript }).map(source => source.source.toolCallId), ["current"]);
		assert.deepEqual(inspectCoordinationRejections(transcript, "reader").map(record => record.source.entryId), [rejectedEntry]);
	}
});

test("Cancellation requester validation uses Delivery evidence, not mutable attention snapshots", () => {
	const { manager, inspect } = fixture();
	const requestSource = { agentId: "requester", entryId: "request", toolCallId: "q" };
	const requestId = deriveMessageIdentity(requestSource);
	const request = createMessageDelivery([{ source: requestSource, projection: {
		kind: "request", requestMessageId: requestId, fromAgentId: "requester", title: "Keep", question: "Work",
	} }]);
	manager.appendCustomMessageEntry(request.customType, request.content, true, request.details);
	manager.appendCustomEntry("agent-coordination.obligation-focus", { frames: [{
		requestId, requesterAgentId: "impostor", title: "Keep", question: "Work",
	}] });
	const cancellationSource = { agentId: "impostor", entryId: "cancel", toolCallId: "c" };
	const cancellation = createMessageDelivery([{ source: cancellationSource, projection: {
		kind: "request_cancellation", requestMessageId: requestId, fromAgentId: "impostor",
		cancellationId: deriveMessageIdentity(cancellationSource), reason: "Withdraw",
	} }]);
	manager.appendCustomMessageEntry(cancellation.customType, cancellation.content, true, cancellation.details);
	assert.throws(() => obligationStack(inspect(), "reader"), /another requester/);
});

for (const scenario of ["rejected-delivery", "metadata-spoof", "resolved-request"] as const) {
	test(`focus snapshots have no obligation authority: ${scenario}`, () => {
		const { manager, inspect } = fixture();
		const source = { agentId: "requester", entryId: "request", toolCallId: "q" };
		const requestId = deriveMessageIdentity(source);
		const original = { requestId, requesterAgentId: "requester", title: "Original title", question: "Original work" };
		const delivery = createMessageDelivery([{ source, projection: {
			kind: "request", requestMessageId: requestId, fromAgentId: original.requesterAgentId,
			title: original.title, question: original.question,
		} }]);
		manager.appendCustomMessageEntry(delivery.customType,
			scenario === "rejected-delivery" ? JSON.stringify({ messages: [{ kind: "request" }] }) : delivery.content,
			true, delivery.details);
		if (scenario === "resolved-request") {
			const entryId = manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
				operation: "answer", requestId, answer: "Completed",
			}, { id: "completed" })));
			manager.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "completed",
				content: [], isError: false, timestamp: 1, details: {
					messageId: deriveMessageIdentity({ agentId: "reader", entryId, toolCallId: "completed" }),
					requestMessageId: requestId, requestTitle: original.title, disposition: "committed",
					delivery: "omitted", reason: "request_source_unavailable",
				},
			});
		}
		manager.appendCustomEntry("agent-coordination.obligation-focus", { frames: [{
			...original, requesterAgentId: "spoofed", title: "Rewritten title", question: "Different work",
		}] });
		const snapshot = inspect();
		for (const transcript of [snapshot, { ...snapshot, entries: structuredClone(snapshot.entries) }]) {
			assert.deepEqual(obligationStack(transcript, "reader"), scenario === "metadata-spoof" ? [original] : []);
		}
	});
}
