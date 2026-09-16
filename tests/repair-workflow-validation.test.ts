import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { validateRepairProposal } from "../src/repair/workflow-validation.ts";

const ownerPath = "/frozen/owner.jsonl";
const childPath = "/frozen/child.jsonl";
function fixture() {
	const owner = SessionManager.inMemory("/frozen", { id: "owner" });
	owner.appendCustomEntry("agent-coordination.identity", {
		agentId: "owner", workflowId: "owner", directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" },
	});
	const spawnEntry = owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn",
		{ title: "Initial duty", request: "Initial work", label: "Child" }, { id: "spawn" })));
	const child = SessionManager.inMemory("/frozen", { id: "child" });
	child.appendCustomEntry("agent-coordination.identity", {
		agentId: "child", workflowId: "owner", directSpawnerAgentId: "owner", creationPreset: null,
		spawnSource: { agentId: "owner", entryId: spawnEntry, toolCallId: "spawn" }, metadata: { label: "Child" },
	});
	return { owner, child, files: () => [file(ownerPath, owner), file(childPath, child)] };
}
function file(path: string, manager: SessionManager) {
	return { path, contents: [manager.getHeader(), ...manager.getEntries()].map(value => JSON.stringify(value)).join("\n") + "\n" };
}
const validate = (before: ReturnType<ReturnType<typeof fixture>["files"]>, after = before) =>
	validateRepairProposal({ ownerPath, workflowId: "owner", before, after });

test("unchanged complete Workflow validates without opening native sessions", async () => {
	const f = fixture();
	const files = f.files();
	const report = await validate(files);
	assert.equal(report.valid, true, JSON.stringify(report.errors));
	assert.deepEqual(report.changes, []);
	assert.equal(report.protocolEffects.beforeStatus, "known");
	assert.deepEqual(report.protocolEffects.changes, []);
	assert.deepEqual(f.files(), files);
});

test("correcting a rejected Request exposes newly deliverable external work", async () => {
	const f = fixture();
	const entryId = f.owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",
		{ operation: "request", targetAgent: "child", question: "Publish the release" }, { id: "publish" })));
	const requestId = deriveMessageIdentity({ agentId: "owner", entryId, toolCallId: "publish" });
	f.owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "publish",
		content: [], isError: false, timestamp: 1,
		details: { requestMessageId: requestId, targetAgentId: "child", messageStatus: "sent" } });
	const before = f.files();
	const after = before.map(value => ({ ...value, contents: value.contents.replace('"question":"Publish the release"',
		'"question":"Publish the release","title":"Publish release"') }));
	const report = await validate(before, after);
	assert.equal(report.valid, true, JSON.stringify(report.errors));
	assert.equal(report.protocolEffects.beforeStatus, "known");
	assert.ok(report.protocolEffects.changes.some(change => change.category === "pending_delivery" && change.after?.messageId === requestId));
	assert.ok(report.protocolEffects.changes.some(change => change.category === "record" && change.before?.status === "rejected" && change.after?.status === "accepted"));
});

test("certification rejects rejected records, omitted candidates and unknown native structure", async () => {
	const f = fixture();
	const before = f.files();
	assert.equal((await validate(before, before.slice(0, 1))).valid, false);
	f.child.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request" }, { id: "bad" })));
	assert.equal((await validate(before, f.files())).valid, false);
	const broken = before.map(value => ({ ...value, contents: value.contents + '{"type":"message"}\n' }));
	assert.equal((await validate(before, broken)).valid, false);
});

test("unprojectable original is unknown, not an empty set of effects", async () => {
	const f = fixture();
	const after = f.files();
	const before = after.map(value => ({ ...value, contents: value.contents + '{broken}\n' }));
	const report = await validate(before, after);
	assert.equal(report.protocolEffects.beforeStatus, "unknown");
	assert.ok(report.protocolEffects.beforeErrors.length > 0);
});

test("candidate cannot discard a valid delivered duty", async () => {
	const f = fixture();
	const entryId = f.owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",
		{ operation: "request", targetAgent: "child", title: "Keep", question: "Do not lose this duty" }, { id: "keep" })));
	const source = { agentId: "owner", entryId, toolCallId: "keep" };
	const requestId = deriveMessageIdentity(source);
	f.owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "keep", content: [], isError: false,
		timestamp: 1, details: { requestMessageId: requestId, targetAgentId: "child", messageStatus: "sent" } });
	const withoutDelivery = f.files();
	const delivery = createMessageDelivery([{ source, projection: { kind: "request", requestMessageId: requestId,
		fromAgentId: "owner", title: "Keep", question: "Do not lose this duty" } }]);
	f.child.appendCustomMessageEntry(delivery.customType, delivery.content, true, delivery.details);
	const report = await validate(f.files(), withoutDelivery);
	assert.equal(report.valid, false);
	assert.ok(report.errors.some(error => error.code === "duty_removed" || error.code === "accepted_evidence_changed"));
});

test("local orphan Answer commitment is distinct from absent Answer Delivery", async () => {
	const f = fixture();
	const before = f.files();
	const source = { agentId: "owner", entryId: "unavailable", toolCallId: "orphan" };
	const requestId = deriveMessageIdentity(source);
	const delivery = createMessageDelivery([{ source, projection: { kind: "request", requestMessageId: requestId,
		fromAgentId: "owner", title: "Retained request", question: "Retained duty" } }]);
	f.child.appendCustomMessageEntry(delivery.customType, delivery.content, true, delivery.details);
	const answerEntryId = f.child.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",
		{ operation: "answer", requestId, answer: "Already completed" }, { id: "answer" })));
	const answerId = deriveMessageIdentity({ agentId: "child", entryId: answerEntryId, toolCallId: "answer" });
	f.child.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "answer", timestamp: 1,
		content: [], isError: false, details: { messageId: answerId, requestMessageId: requestId,
			requestTitle: "Retained request", disposition: "committed", delivery: "omitted", reason: "request_source_unavailable" } });
	const after = f.files();
	const unchanged = await validate(after);
	assert.equal(unchanged.valid, true, JSON.stringify(unchanged.errors));
	// An audit can describe newly supplied evidence while certification refuses inventing its history.
	const report = await validate(before, after);
	assert.equal(report.valid, false);
	assert.ok(report.protocolEffects.changes.some(change => change.category === "answer_commitment" && change.after?.messageId === answerId));
	assert.ok(!report.protocolEffects.changes.some(change => change.category === "pending_delivery" && change.after?.messageId === answerId));
	assert.ok(!report.protocolEffects.changes.some(change => change.category === "delivery" && change.after?.messageId === answerId));
});

test("all pending message kinds and retained continuations use durable recovery evidence", async () => {
	const f = fixture();
	const before = f.files();
	const requestEntry = f.owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",
		{ operation: "request", targetAgent: "child", title: "Request", question: "Work" }, { id: "request" })));
	const requestSource = { agentId: "owner", entryId: requestEntry, toolCallId: "request" };
	const requestId = deriveMessageIdentity(requestSource);
	f.owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "request", content: [], isError: false,
		timestamp: 1, details: { requestMessageId: requestId, targetAgentId: "child", messageStatus: "sent" } });
	let report = await validate(before, f.files());
	assert.ok(report.protocolEffects.changes.some(change => change.category === "pending_delivery" && change.after?.kind === "request"));
	const delivery = createMessageDelivery([{ source: requestSource, projection: { kind: "request", requestMessageId: requestId,
		fromAgentId: "owner", title: "Request", question: "Work" } }]);
	f.child.appendCustomMessageEntry(delivery.customType, delivery.content, true, delivery.details);
	report = await validate(before, f.files());
	assert.ok(report.protocolEffects.changes.some(change => change.category === "continuation" && change.after?.requestId === requestId));
	for (const [operation, author, arguments_] of [
		["send", f.owner, { targetAgent: "child", content: "Hello" }],
		["answer", f.child, { requestId, answer: "Done" }],
		["cancel", f.owner, { requestMessageId: requestId, reason: "Withdraw" }],
	] as const) {
		const entryId = author.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", { operation, ...arguments_ }, { id: operation })));
		const messageId = deriveMessageIdentity({ agentId: author.getSessionId(), entryId, toolCallId: operation });
		author.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: operation, content: [], isError: false, timestamp: 1,
			details: operation === "send" ? { messageId, targetAgentId: "child", messageStatus: "sent" }
				: operation === "answer" ? { messageId, requestMessageId: requestId, requestTitle: "Request", messageStatus: "sent" }
					: { messageId, targetAgentId: "child", messageStatus: "sent" } });
		report = await validate(before, f.files());
		assert.ok(report.protocolEffects.changes.some(change => change.category === "pending_delivery" && change.after?.messageId === messageId), JSON.stringify(report.errors));
	}
});

test("membership quarantine, duplicate claims and missing referenced participants refuse certification", async () => {
	const f = fixture();
	const good = f.files();
	const quarantined = good.map(value => ({ ...value, contents: value.contents.replace('"creationPreset":null', '"creationPreset":{}') }));
	assert.ok((await validate(quarantined)).errors.some(error => error.code === "workflow_unverifiable"));
	const duplicate = [...good, { ...good[1]!, path: "/frozen/duplicate.jsonl" }];
	assert.ok((await validate(duplicate)).errors.some(error => error.code === "native_invalid"));
	const source = { agentId: "missing", entryId: "request", toolCallId: "q" };
	const delivery = createMessageDelivery([{ source, projection: { kind: "request", requestMessageId: deriveMessageIdentity(source),
		fromAgentId: "missing", title: "Orphan", question: "Unknown participant" } }]);
	f.child.appendCustomMessageEntry(delivery.customType, delivery.content, true, delivery.details);
	assert.equal((await validate(f.files())).valid, false);
});

test("invalid cross-Agent Answer and contradictory Delivery are not repaired by local shape validity", async () => {
	const f = fixture();
	const entryId = f.owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",
		{ operation: "request", targetAgent: "child", title: "Request", question: "Original" }, { id: "q" })));
	const source = { agentId: "owner", entryId, toolCallId: "q" }, requestId = deriveMessageIdentity(source);
	f.owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "q", content: [], isError: false,
		timestamp: 1, details: { requestMessageId: requestId, targetAgentId: "child", messageStatus: "sent" } });
	const delivery = createMessageDelivery([{ source, projection: { kind: "request", requestMessageId: requestId,
		fromAgentId: "owner", title: "Request", question: "Contradiction" } }]);
	f.child.appendCustomMessageEntry(delivery.customType, delivery.content, true, delivery.details);
	assert.equal((await validate(f.files())).valid, false);
	const answerEntry = f.owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",
		{ operation: "answer", requestId, answer: "Wrong responder" }, { id: "a" })));
	f.owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "a", content: [], isError: false,
		timestamp: 1, details: { messageId: deriveMessageIdentity({ agentId: "owner", entryId: answerEntry, toolCallId: "a" }),
			requestMessageId: requestId, requestTitle: "Request", messageStatus: "sent" } });
	assert.equal((await validate(f.files())).valid, false);
});

test("off-branch native errors, identity edits and duplicate manifest paths fail closed", async () => {
	const f = fixture(), before = f.files();
	const childIdentity = f.child.getEntries()[0]!.id;
	f.child.appendMessage({ role: "user", content: "Off branch", timestamp: 1 });
	f.child.branch(childIdentity);
	f.child.appendMessage({ role: "user", content: "Active", timestamp: 1 });
	const malformed = f.files().map(value => ({ ...value, contents: value.contents.replace('"content":"Off branch"', '"content":17') }));
	assert.ok((await validate(malformed)).errors.some(error => error.code === "native_invalid"));
	const changedIdentity = before.map(value => ({ ...value, contents: value.contents.replace('"agentId":"child"', '"agentId":"other"') }));
	assert.equal((await validate(before, changedIdentity)).valid, false);
	assert.ok((await validate([...before, before[0]!])).errors.some(error => error.code === "invalid_manifest"));
});

test("Answer retrieval is audited as Delivery and suppresses later pending Answer dispatch", async () => {
	const f = fixture(), before = f.files();
	const requestEntryId = f.owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",
		{ operation: "request", targetAgent: "child", title: "Retrieve", question: "Work" }, { id: "q" })));
	const requestSource = { agentId: "owner", entryId: requestEntryId, toolCallId: "q" }, requestId = deriveMessageIdentity(requestSource);
	f.owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "q", content: [], isError: false,
		timestamp: 1, details: { requestMessageId: requestId, targetAgentId: "child", messageStatus: "sent" } });
	const delivery = createMessageDelivery([{ source: requestSource, projection: { kind: "request", requestMessageId: requestId,
		fromAgentId: "owner", title: "Retrieve", question: "Work" } }]);
	f.child.appendCustomMessageEntry(delivery.customType, delivery.content, true, delivery.details);
	const answerEntryId = f.child.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",
		{ operation: "answer", requestId, answer: "Completed" }, { id: "a" })));
	const answerSource = { agentId: "child", entryId: answerEntryId, toolCallId: "a" }, answerId = deriveMessageIdentity(answerSource);
	f.child.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "a", content: [], isError: false,
		timestamp: 1, details: { messageId: answerId, requestMessageId: requestId, requestTitle: "Retrieve", messageStatus: "sent" } });
	f.owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_wait", { requestMessageIds: [requestId] }, { id: "wait" })));
	const result = { answers: [{ disposition: "answer_delivered", requestMessageId: requestId, requestTitle: "Retrieve",
		answerId, fromAgentId: "child", answer: "Completed", answerSource }] };
	f.owner.appendMessage({ role: "toolResult", toolName: "agent_wait", toolCallId: "wait", isError: false, timestamp: 1,
		content: [{ type: "text", text: JSON.stringify(result) }], details: result });
	const files = f.files();
	const unchanged = await validate(files);
	assert.equal(unchanged.valid, true, JSON.stringify(unchanged.errors));
	const report = await validate(before, files);
	assert.ok(report.protocolEffects.changes.some(change => change.category === "delivery" && change.after?.messageId === answerId && change.after?.method === "retrieval"));
	assert.ok(!report.protocolEffects.changes.some(change => change.category === "pending_delivery" && change.after?.messageId === answerId));
});

test("a successful Spawn receipt cannot hide a missing participant behind zero quarantine", async () => {
	const f = fixture();
	const entryId = f.owner.getEntries().at(-1)!.id;
	f.owner.appendMessage({ role: "toolResult", toolName: "agent_spawn", toolCallId: "spawn", content: [], isError: false,
		timestamp: 1, details: { spawnStatus: "created", agentId: "child", messageStatus: "sent",
			requestMessageId: deriveMessageIdentity({ agentId: "owner", entryId, toolCallId: "spawn" }) } });
	const ownerOnly = [f.files()[0]!];
	assert.equal((await validate(ownerOnly)).valid, false);
});
