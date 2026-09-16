import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery, inspectMessageDeliveries, type MessageDeliveryItem } from "../src/protocol/message-delivery.ts";
import { parseRepairTranscript } from "../src/repair/native-transcript.ts";
import { prepareDuplicateDeliveryRepair, validateRepairProposal } from "../src/repair/workflow-validation.ts";

const ownerPath = "/frozen/owner.jsonl";
function appendRequest(owner: SessionManager, id: string, title?: string) {
	const entryId = owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: "owner", ...(title ? { title } : {}), question: `Work for ${id}`,
	}, { id })));
	const source = { agentId: "owner", entryId, toolCallId: id };
	const requestMessageId = deriveMessageIdentity(source);
	owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: id, content: [], isError: false,
		timestamp: 1, details: { requestMessageId, targetAgentId: "owner", messageStatus: "sent" } });
	return { source, requestMessageId };
}
function fixture(options: { stale?: boolean; batch?: boolean } = {}) {
	const owner = SessionManager.inMemory("/frozen", { id: "owner" });
	owner.appendCustomEntry("agent-coordination.identity", { agentId: "owner", workflowId: "owner",
		directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } });
	const stale = options.stale ? appendRequest(owner, "stale") : undefined;
	const entryId = owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: "owner", title: "Existing duty", question: "Do existing work",
	}, { id: "request" })));
	const source = { agentId: "owner", entryId, toolCallId: "request" };
	const requestMessageId = deriveMessageIdentity(source);
	owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "request", content: [],
		isError: false, timestamp: 1, details: { requestMessageId, targetAgentId: "owner", messageStatus: "sent" } });
	const items: MessageDeliveryItem[] = [{ source, projection: { kind: "request", requestMessageId,
		fromAgentId: "owner", title: "Existing duty", question: "Do existing work" } }];
	if (options.batch) {
		const second = appendRequest(owner, "second", "Second duty");
		items.push({ source: second.source, projection: { kind: "request", requestMessageId: second.requestMessageId,
			fromAgentId: "owner", title: "Second duty", question: "Work for second" } });
	}
	const delivery = createMessageDelivery(items);
	const retainedId = owner.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	const removedId = owner.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	return { owner, source, delivery, requestMessageId, retainedId, removedId, stale,
		files: () => [{ path: ownerPath, contents: [owner.getHeader(), ...owner.getEntries()].map(value => JSON.stringify(value)).join("\n") + "\n" }] };
}
function collapse(files: ReturnType<ReturnType<typeof fixture>["files"]>, removedId: string) {
	return files.map(file => {
		const entries = file.contents.trim().split("\n").map(line => JSON.parse(line));
		const removed = entries.find(entry => entry.id === removedId);
		return { ...file, contents: entries.filter(entry => entry.id !== removedId).map(entry => JSON.stringify(
			entry.parentId === removedId ? { ...entry, parentId: removed.parentId } : entry)).join("\n") + "\n" };
	});
}
const validate = (before: ReturnType<ReturnType<typeof fixture>["files"]>, after = before) =>
	validateRepairProposal({ ownerPath, workflowId: "owner", before, after });
const prepare = (files: ReturnType<ReturnType<typeof fixture>["files"]>) =>
	prepareDuplicateDeliveryRepair({ ownerPath, workflowId: "owner", files });
function editEntries(files: ReturnType<ReturnType<typeof fixture>["files"]>, edit: (entry: any) => void) {
	return files.map(file => ({ ...file, contents: file.contents.trim().split("\n").map(line => {
		const entry = JSON.parse(line); edit(entry); return JSON.stringify(entry);
	}).join("\n") + "\n" }));
}
function withChild(f: ReturnType<typeof fixture>) {
	const spawnEntry = f.owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn",
		{ title: "Child work", request: "Work", label: "Child" }, { id: "spawn" })));
	const child = SessionManager.inMemory("/frozen", { id: "child" });
	child.appendCustomEntry("agent-coordination.identity", { agentId: "child", workflowId: "owner", directSpawnerAgentId: "owner",
		creationPreset: null, spawnSource: { agentId: "owner", entryId: spawnEntry, toolCallId: "spawn" }, metadata: { label: "Child" } });
	return [...f.files(), { path: "/frozen/child.jsonl",
		contents: [child.getHeader(), ...child.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n" }];
}

test("exact duplicate Delivery collapse certifies a real strict-reader admission failure", async () => {
	const f = fixture();
	f.owner.appendMessage({ role: "user", content: "Conversation after the duplicate", timestamp: 2 });
	const before = f.files();
	const original = parseRepairTranscript(before[0]!.contents, ownerPath, { projectCoordination: false });
	assert.throws(() => inspectMessageDeliveries({ recipientAgentId: "owner", transcript: original }), /duplicate Deliveries/);
	const after = collapse(before, f.removedId);
	const preparation = await prepare(before);
	assert.equal(preparation.eligible, true, JSON.stringify(preparation.errors));
	assert.deepEqual(preparation.files, after);
	assert.deepEqual(f.files(), before);
	const report = await validate(before, after);
	assert.equal(report.valid, true, JSON.stringify(report.errors));
	assert.equal(report.protocolEffects.beforeStatus, "unknown");
	assert.equal(report.protocolEffects.comparisonBasis, "certified_duplicate_reference");
	assert.deepEqual(report.protocolEffects.changes, []);
	assert.deepEqual(report.certificate?.removedEntries, [{ path: ownerPath, agentId: "owner",
		removedEntryId: f.removedId, retainedEntryId: f.retainedId }]);
	assert.equal(report.certificate?.parentRewrites[0]?.before, f.removedId);
	assert.equal(report.certificate?.parentRewrites[0]?.after, f.retainedId);
	const repaired = parseRepairTranscript(after[0]!.contents, ownerPath);
	const deliveries = inspectMessageDeliveries({ recipientAgentId: "owner", transcript: repaired });
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0]!.deliveryEvidence.entryId, f.retainedId);
	assert.equal((await validate(before)).valid, false);
});

test("removing a physical-tail duplicate cannot reopen an abandoned branch", async () => {
	const f = fixture();
	f.owner.appendMessage({ role: "user", content: "Abandoned conversation", timestamp: 2 });
	const files = f.files().map(file => {
		const entries = file.contents.trim().split("\n").map(line => JSON.parse(line));
		const duplicate = entries.find(entry => entry.id === f.removedId);
		const rest = entries.filter(entry => entry.id !== f.removedId);
		rest.at(-1)!.parentId = f.retainedId;
		return { ...file, contents: [...rest, duplicate].map(entry => JSON.stringify(entry)).join("\n") + "\n" };
	});
	const result = await prepare(files);
	assert.equal(result.eligible, false);
	assert.match(result.errors[0]!.message, /leaf|branch/);
	assert.deepEqual(result.files, files);
});

test("a stale rejected Request stays unchanged and inert behind newer accepted work", async () => {
	const f = fixture({ stale: true });
	const newer = appendRequest(f.owner, "newer", "New work");
	const before = f.files();
	const after = collapse(before, f.removedId);
	const report = await validate(before, after);
	assert.equal(report.valid, true, JSON.stringify(report.errors));
	const reference = report.protocolEffects.certifiedReference!;
	assert.ok(reference.rejections.some(rejection => rejection.source.toolCallId === "stale"));
	const pending = reference.facts.filter(fact => fact.category === "pending_delivery");
	assert.deepEqual(pending.map(fact => fact.key), [newer.requestMessageId]);
	const staleEntry = JSON.parse(before[0]!.contents.split("\n").find(line => line.includes('"id":"stale"'))!);
	assert.ok(after[0]!.contents.includes(JSON.stringify(staleEntry)));
	assert.deepEqual(report.protocolEffects.changes, []);

	const resurrected = editEntries(after, entry => {
		if (entry.id === f.stale!.source.entryId) entry.message.content[0].arguments.title = "Revive old work";
	});
	const invalid = await validate(before, resurrected);
	assert.equal(invalid.valid, false);
	assert.ok(invalid.errors.some(error => error.code === "not_lossless_duplicate_repair"));
	assert.ok(invalid.protocolEffects.changes.some(change => change.category === "pending_delivery" && change.key === f.stale!.requestMessageId));
});

test("healthy and rejected-only histories are never repair eligible", async () => {
	for (const stale of [false, true]) {
		const f = fixture({ stale });
		const healthy = collapse(f.files(), f.removedId);
		assert.equal((await prepare(healthy)).eligible, false);
		assert.equal((await validate(healthy)).valid, false);
	}
});

test("a child's duplicate evidence alone cannot authorize repair of a healthy Owner", async () => {
	const f = fixture();
	const files = collapse(withChild(f), f.removedId);
	const spawn = f.owner.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant" &&
		entry.message.content.some(part => part.type === "toolCall" && part.id === "spawn"))!;
	const source = { agentId: "owner", entryId: spawn.id, toolCallId: "spawn" };
	const delivery = createMessageDelivery([{ source, projection: { kind: "request", requestMessageId: deriveMessageIdentity(source),
		fromAgentId: "owner", title: "Child work", question: "Work" } }]);
	let parentId = JSON.parse(files[1]!.contents.trim().split("\n").at(-1)!).id;
	for (const id of ["child-first", "child-duplicate"]) {
		files[1]!.contents += JSON.stringify({ type: "custom_message", id, parentId, timestamp: "2025-01-01T00:00:00.000Z", ...delivery }) + "\n";
		parentId = id;
	}
	const result = await prepare(files);
	assert.equal(result.eligible, false);
	assert.match(result.errors[0]!.message, /Owner/);
});

test("only identical full ordered Delivery envelopes can collapse", async () => {
	const f = fixture({ batch: true });
	const before = f.files();
	assert.equal((await prepare(before)).eligible, true);
	const prepared = await prepare(before);
	assert.equal(inspectMessageDeliveries({ recipientAgentId: "owner",
		transcript: parseRepairTranscript(prepared.files[0]!.contents, ownerPath) }).length, 2);
	for (const change of [
		(entry: any) => { entry.content = entry.content.replace("Do existing work", "Conflicting body"); },
		(entry: any) => { entry.content = JSON.stringify({ messages: JSON.parse(entry.content).messages.slice(0, 1) }); entry.details.messages.pop(); },
		(entry: any) => { entry.content = JSON.stringify({ messages: JSON.parse(entry.content).messages.reverse() }); entry.details.messages.reverse(); },
		(entry: any) => { entry.content = ` ${entry.content}`; },
	]) {
		const conflicting = editEntries(before, entry => { if (entry.id === f.removedId) change(entry); });
		const result = await prepare(conflicting);
		assert.equal(result.eligible, false);
		assert.match(result.errors[0]!.message, /conflicting|overlapping/);
	}
});

test("non-parent native and opaque references to removed evidence are not guessed or remapped", async () => {
	for (const referencingEntry of [
		(id: string) => ({ type: "label", targetId: id, label: "Keep reference" }),
		(id: string) => ({ type: "branch_summary", fromId: id, summary: "Prior branch" }),
		(id: string) => ({ type: "compaction", firstKeptEntryId: id, summary: "Compact", tokensBefore: 10 }),
		(id: string) => ({ type: "custom", customType: "extension.pointer", data: { inspectedThrough: { agentId: "owner", entryId: id } } }),
		(id: string) => ({ type: "message", message: { role: "toolResult", toolName: "agent_wait", toolCallId: "wait", content: [],
			isError: false, timestamp: 3, details: { answers: [{ disposition: "answer_already_delivered", deliveryEvidence: { agentId: "owner", entryId: id } }] } } }),
	]) {
		const f = fixture();
		const before = f.files();
		before[0]!.contents += JSON.stringify({ ...referencingEntry(f.removedId), id: "dependent", parentId: f.removedId,
			timestamp: "2025-01-01T00:00:00.000Z" }) + "\n";
		const result = await prepare(before);
		assert.equal(result.eligible, false);
		assert.match(result.errors[0]!.message, /depends on a removed Delivery/);
	}
});

test("references in another participant also prevent duplicate removal", async () => {
	const f = fixture();
	const files = withChild(f);
	const childIdentity = JSON.parse(files[1]!.contents.trim().split("\n").at(-1)!);
	files[1]!.contents += JSON.stringify({ type: "custom", id: "foreign-ref", parentId: childIdentity.id,
		timestamp: "2025-01-01T00:00:00.000Z", customType: "extension.evidence", data: { source: { agentId: "owner", entryId: f.removedId } } }) + "\n";
	const result = await prepare(files);
	assert.equal(result.eligible, false);
	assert.match(result.errors[0]!.message, /depends on a removed Delivery/);
});

test("wrong recipient and malformed original native data refuse preparation", async () => {
	const f = fixture();
	const files = withChild(f);
	const wrongRecipient = editEntries(files, entry => {
		if (entry.id === f.source.entryId) entry.message.content[0].arguments.targetAgent = "child";
		if (entry.message?.role === "toolResult" && entry.message.toolCallId === "request") entry.message.details.targetAgentId = "child";
	});
	const result = await prepare(wrongRecipient);
	assert.equal(result.eligible, false);
	assert.ok(result.errors.some(error => error.message.includes("wrong_delivery_recipient")));
	files[0]!.contents += '{"broken":';
	assert.equal((await prepare(files)).eligible, false);
});

test("repair certificate refuses accepted call reordering, membership and conversation edits", async () => {
	const f = fixture();
	const calls = ["first", "second"].map(id => fauxToolCall("agent_message",
		{ operation: "send", targetAgent: "owner", content: id }, { id }));
	const entryId = f.owner.appendMessage(fauxAssistantMessage(calls));
	for (const id of ["first", "second"]) f.owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: id,
		content: [], isError: false, timestamp: 1, details: { messageId: deriveMessageIdentity({ agentId: "owner", entryId, toolCallId: id }),
			targetAgentId: "owner", messageStatus: "sent" } });
	const userId = f.owner.appendMessage({ role: "user", content: "Keep conversation", timestamp: 2 });
	const before = withChild(f);
	const after = collapse(before, f.removedId);
	assert.equal((await validate(before, after)).valid, true);
	for (const mutation of [
		(entry: any) => { if (entry.id === entryId) entry.message.content.reverse(); },
		(entry: any) => { if (entry.id === userId) entry.message.content = "Unrequested cleanup"; },
		(entry: any) => { if (entry.type === "session") entry.cwd = "/different"; },
	]) {
		const report = await validate(before, editEntries(after, mutation));
		assert.equal(report.valid, false);
		assert.ok(report.errors.some(error => error.code === "not_lossless_duplicate_repair"));
	}
	assert.equal((await validate(before, after.slice(0, 1))).valid, false);
});

test("accepted calls in different native entries cannot be reordered alongside a valid correction", async () => {
	const f = fixture();
	const first = appendRequest(f.owner, "first", "First accepted");
	const second = appendRequest(f.owner, "second", "Second accepted");
	const before = f.files();
	const after = collapse(before, f.removedId).map(file => {
		const [header, ...entries] = file.contents.trim().split("\n").map(line => JSON.parse(line));
		const firstIndex = entries.findIndex(entry => entry.id === first.source.entryId);
		const secondIndex = entries.findIndex(entry => entry.id === second.source.entryId);
		[entries[firstIndex], entries[secondIndex]] = [entries[secondIndex], entries[firstIndex]];
		entries.forEach((entry, index) => { entry.parentId = entries[index - 1]?.id ?? null; });
		return { ...file, contents: [header, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n" };
	});
	const report = await validate(before, after);
	assert.equal(report.valid, false);
	assert.ok(report.errors.some(error => error.code === "not_lossless_duplicate_repair"));
	assert.ok(report.protocolEffects.changes.some(change => change.category === "pending_delivery_order"));
});

test("parent splicing retains intervening conversation instead of jumping to first Delivery", async () => {
	const f = fixture();
	const conversationId = f.owner.appendMessage({ role: "user", content: "Keep between copies", timestamp: 2 });
	const nextId = f.owner.appendMessage({ role: "user", content: "Keep after copies", timestamp: 3 });
	const before = f.files().map(file => {
		const entries = file.contents.trim().split("\n").map(line => JSON.parse(line));
		const duplicate = entries.find(entry => entry.id === f.removedId);
		const ordered = entries.filter(entry => entry.id !== f.removedId);
		const index = ordered.findIndex(entry => entry.id === conversationId);
		ordered[index]!.parentId = f.retainedId;
		duplicate.parentId = conversationId;
		ordered.splice(index + 1, 0, duplicate);
		ordered.find(entry => entry.id === nextId)!.parentId = f.removedId;
		return { ...file, contents: ordered.map(entry => JSON.stringify(entry)).join("\n") + "\n" };
	});
	const result = await prepare(before);
	assert.equal(result.eligible, true, JSON.stringify(result.errors));
	assert.deepEqual(result.certificate?.parentRewrites, [{ path: ownerPath, entryId: nextId, before: f.removedId, after: conversationId }]);
	assert.equal((await validate(before, [...result.files])).valid, true);
});

test("an Answer between duplicate envelopes remains committed and the duty stays resolved", async () => {
	const f = fixture();
	const answerEntry = f.owner.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message",
		{ operation: "answer", requestId: f.requestMessageId, answer: "Completed before repair" }, { id: "answer" })));
	const answerId = deriveMessageIdentity({ agentId: "owner", entryId: answerEntry, toolCallId: "answer" });
	const receiptId = f.owner.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "answer", content: [],
		isError: false, timestamp: 3, details: { messageId: answerId, requestMessageId: f.requestMessageId,
			requestTitle: "Existing duty", messageStatus: "sent" } });
	const before = f.files().map(file => {
		const entries = file.contents.trim().split("\n").map(line => JSON.parse(line));
		const duplicate = entries.find(entry => entry.id === f.removedId);
		const ordered = entries.filter(entry => entry.id !== f.removedId);
		ordered.find(entry => entry.id === answerEntry)!.parentId = f.retainedId;
		duplicate.parentId = receiptId;
		return { ...file, contents: [...ordered, duplicate].map(entry => JSON.stringify(entry)).join("\n") + "\n" };
	});
	const result = await prepare(before);
	assert.equal(result.eligible, true, JSON.stringify(result.errors));
	const report = await validate(before, [...result.files]);
	assert.equal(report.valid, true, JSON.stringify(report.errors));
	const facts = report.protocolEffects.certifiedReference!.facts;
	assert.ok(facts.some(fact => fact.category === "answer_commitment" && fact.key === answerId));
	assert.ok(!facts.some(fact => ["answer_duty", "continuation"].includes(fact.category) && fact.value.requestId === f.requestMessageId));
});

test("valid retained Delivery from a rejected author keeps its existing duty without resurrecting the author", async () => {
	const f = fixture();
	const before = editEntries(f.files(), entry => {
		if (entry.id === f.source.entryId) delete entry.message.content[0].arguments.title;
	});
	const result = await prepare(before);
	assert.equal(result.eligible, true, JSON.stringify(result.errors));
	const report = await validate(before, [...result.files]);
	assert.equal(report.valid, true, JSON.stringify(report.errors));
	const reference = report.protocolEffects.certifiedReference!;
	assert.ok(reference.rejections.some(item => item.source.toolCallId === "request"));
	assert.ok(reference.facts.some(fact => fact.category === "answer_duty" && fact.value.requestId === f.requestMessageId));
	assert.ok(!reference.facts.some(fact => ["pending_delivery", "authored_message"].includes(fact.category) && fact.key === f.requestMessageId));
});

test("cross-cutoff repeats and rejected in-envelope repetition are not admission blockers", async () => {
	const f = fixture();
	const crossCutoff = collapse(f.files(), f.removedId);
	const identity = f.owner.getEntries()[0]!;
	crossCutoff[0]!.contents += JSON.stringify({ ...identity, id: "fresh-cutoff", parentId: f.retainedId }) + "\n";
	const duplicate = JSON.parse(f.files()[0]!.contents.trim().split("\n").at(-1)!);
	crossCutoff[0]!.contents += JSON.stringify({ ...duplicate, parentId: "fresh-cutoff" }) + "\n";
	assert.equal((await prepare(crossCutoff)).eligible, false);
	const rejected = editEntries(collapse(f.files(), f.removedId), entry => {
		if (entry.id !== f.retainedId) return;
		entry.details.messages.push(entry.details.messages[0]);
		const contents = JSON.parse(entry.content);
		contents.messages.push(contents.messages[0]);
		entry.content = JSON.stringify(contents);
	});
	assert.equal((await prepare(rejected)).eligible, false);
});
