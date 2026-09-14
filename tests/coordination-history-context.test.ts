import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { projectCoordinationHistory } from "../src/pi-integration/coordination-history-context.ts";

test("rejected call/result group is informational once, retaining valid sibling pairing and source content", () => {
	const session = SessionManager.inMemory(process.cwd());
	const mixed = fauxAssistantMessage([
		{ type: "text", text: "Keep this explanation." },
		fauxToolCall("agent_message", { operation: "request", question: "Original question" }, { id: "invalid-call" }),
		fauxToolCall("bash", { command: "echo valid" }, { id: "valid-call" }),
	]);
	const entryId = session.appendMessage(mixed);
	const rejectedResult = result("invalid-call", "agent_message", "Original result");
	const validResult = result("valid-call", "bash", "valid");
	session.appendMessage(rejectedResult);
	session.appendMessage(validResult);
	const messages = [mixed, rejectedResult, validResult];
	const original = structuredClone(messages);
	const transcript = transcriptFromSessionManager(session).inspect();
	const beforeEntries = JSON.stringify(transcript.entries);
	const projected = projectCoordinationHistory({ messages, transcript, marks: [{
		reason: "invalid", record: { agentId: session.getSessionId(), entryId,
			kind: "tool-call", toolCallId: "invalid-call" }, diagnostic: "Request title missing",
	}] });
	assert.deepEqual(messages, original);
	assert.equal(JSON.stringify(transcript.entries), beforeEntries);
	assert.deepEqual(projected.filter(message => message.role === "toolResult"), [validResult]);
	const assistant = projected[0];
	assert.equal(assistant.role, "assistant");
	if (assistant.role !== "assistant") return;
	assert.deepEqual(assistant.content.filter(part => part.type === "toolCall").map(part => part.id), ["valid-call"]);
	const text = projected.map(message => !("content" in message) ? "" : typeof message.content === "string" ? message.content
		: message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
	assert.match(text, /Keep this explanation/);
	assert.match(text, /Original question/);
	assert.match(text, /Original result/);
	assert.match(text, /Request title missing/);
	assert.ok(text.includes(session.getSessionId()) && text.includes(entryId));
	assert.equal(text.split("! ").length - 1, 1);
	assert.doesNotMatch(text, /History marks|neither cancels/);
});

test("a rejected result surviving compaction is information, not a dangling native result or lost content", () => {
	const session = SessionManager.inMemory(process.cwd());
	const assistant = fauxAssistantMessage(fauxToolCall("agent_message", { operation: "answer", requestId: "q", answer: "Done" }, { id: "answer-call" }));
	session.appendMessage(assistant);
	const receipt = result("answer-call", "agent_message", "Old receipt");
	const entryId = session.appendMessage(receipt);
	const projected = projectCoordinationHistory({ messages: [receipt],
		transcript: transcriptFromSessionManager(session).inspect(), marks: [{ reason: "invalid",
			record: { agentId: session.getSessionId(), entryId, kind: "tool-result", toolCallId: "answer-call" },
			diagnostic: "Malformed Answer receipt",
		}] });
	assert.equal(projected.length, 1);
	assert.equal(projected[0].role, "custom");
	assert.match(JSON.stringify(projected), /Old receipt/);
	assert.match(JSON.stringify(projected), /Malformed Answer receipt/);
	assert.match(JSON.stringify(projected), /! /);
});

test("a malformed custom Delivery is marked once without altering valid or unrelated custom messages", () => {
	const session = SessionManager.inMemory(process.cwd());
	const entryId = session.appendCustomMessageEntry("agent-coordination.message-delivery", "bad envelope", true, { bad: true });
	session.appendCustomMessageEntry("another-extension", "unchanged", true);
	const transcript = transcriptFromSessionManager(session).inspect();
	const messages = transcript.context.messages;
	const projected = projectCoordinationHistory({ messages, transcript, marks: [{ reason: "invalid",
		record: { agentId: session.getSessionId(), entryId, kind: "custom" }, diagnostic: "Invalid Delivery",
	}] });
	assert.notDeepEqual(projected[0], messages[0]);
	assert.deepEqual(projected[1], messages[1]);
	assert.match(JSON.stringify(projected[0]), /! /);
	assert.match(JSON.stringify(projected[0]), /bad envelope/);
	assert.match(JSON.stringify(projected[0]), /Invalid Delivery/);
	assert.deepEqual(projectCoordinationHistory({ messages: projected, transcript, marks: [{ reason: "invalid",
		record: { agentId: session.getSessionId(), entryId, kind: "custom" }, diagnostic: "Invalid Delivery",
	}] }), projected, "repeated context preparation must not duplicate marking");
});

test("invalid current-scope marking does not relabel a different inherited call sharing its native ID", () => {
	const session = SessionManager.inMemory(process.cwd());
	const inherited = { ...fauxAssistantMessage(fauxToolCall("agent_message", { operation: "send", targetAgent: "peer", content: "Valid parent work" }, { id: "reused-call" })), timestamp: 1 };
	session.appendMessage(inherited);
	const current = { ...fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request", question: "Invalid current work" }, { id: "reused-call" })), timestamp: 2 };
	const entryId = session.appendMessage(current);
	const projected = projectCoordinationHistory({ messages: [inherited, current],
		transcript: transcriptFromSessionManager(session).inspect(), marks: [{ reason: "invalid",
			record: { agentId: session.getSessionId(), entryId, kind: "tool-call", toolCallId: "reused-call" },
			diagnostic: "Missing title",
		}] });
	assert.deepEqual(projected[0], inherited);
	assert.match(JSON.stringify(projected[1]), /! /);
});

test("a compacted rejected call's result cannot attach to an inherited call with the same native ID", () => {
	const session = SessionManager.inMemory(process.cwd());
	const inherited = { ...fauxAssistantMessage(fauxToolCall("agent_message", { operation: "send", content: "Valid parent work", targetAgent: "peer" }, { id: "shared" })), timestamp: 1 };
	session.appendMessage(inherited);
	const inheritedResult = { ...result("shared", "agent_message", "Parent result"), timestamp: 2 };
	session.appendMessage(inheritedResult);
	const current = { ...fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request", question: "Rejected current work" }, { id: "shared" })), timestamp: 3 };
	const entryId = session.appendMessage(current);
	const currentResult = { ...result("shared", "agent_message", "Current result"), timestamp: 4 };
	session.appendMessage(currentResult);
	const projected = projectCoordinationHistory({ messages: [inherited, inheritedResult, currentResult],
		transcript: transcriptFromSessionManager(session).inspect(), marks: [{ reason: "invalid",
			record: { agentId: session.getSessionId(), entryId, kind: "tool-call", toolCallId: "shared" }, diagnostic: "Missing title",
		}] });
	assert.deepEqual(projected.slice(0, 2), [inherited, inheritedResult]);
	assert.equal(projected[2].role, "custom");
	assert.match(JSON.stringify(projected[2]), /! /);
	assert.match(JSON.stringify(projected[2]), /Current result/);
});

test("informational tool and custom groups preserve images as image blocks, not base64 text", () => {
	const picture = { type: "image" as const, mimeType: "image/png", data: "image-payload" };
	for (const kind of ["tool", "custom"] as const) {
		const session = SessionManager.inMemory(process.cwd());
		let entryId: string;
		if (kind === "tool") {
			entryId = session.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request", question: "Old work" }, { id: "image-call" })));
			session.appendMessage({ ...result("image-call", "agent_message", "Visual result"), content: [{ type: "text", text: "Visual result" }, picture] });
		} else {
			entryId = session.appendCustomMessageEntry("agent-coordination.message-delivery", [{ type: "text", text: "Invalid delivery" }, picture], true);
		}
		const transcript = transcriptFromSessionManager(session).inspect();
		const projected = projectCoordinationHistory({ messages: transcript.context.messages, transcript, marks: [{ reason: "invalid",
			record: { agentId: session.getSessionId(), entryId, kind: kind === "tool" ? "tool-call" : "custom", ...(kind === "tool" ? { toolCallId: "image-call" } : {}) },
			diagnostic: "Bad record",
		}] });
		const blocks = projected.flatMap(message => message.role === "custom" && Array.isArray(message.content) ? message.content : []);
		assert.deepEqual(blocks.filter(block => block.type === "image"), [picture]);
		assert.equal(blocks.filter(block => block.type === "text").map(block => block.text).join("\n").includes(picture.data), false);
	}
});

test("removing rejected calls preserves signed thinking as information rather than a thinking-only assistant", () => {
	const session = SessionManager.inMemory(process.cwd());
	const assistant = fauxAssistantMessage([
		{ type: "thinking", thinking: "Historical reasoning", thinkingSignature: "native-signature" },
		fauxToolCall("agent_message", { operation: "request", question: "Missing title" }, { id: "thinking-call" }),
	]);
	const entryId = session.appendMessage(assistant);
	session.appendMessage(result("thinking-call", "agent_message", "Old result"));
	const transcript = transcriptFromSessionManager(session).inspect();
	const projected = projectCoordinationHistory({ messages: transcript.context.messages, transcript, marks: [{ reason: "invalid",
		record: { agentId: session.getSessionId(), entryId, kind: "tool-call", toolCallId: "thinking-call" }, diagnostic: "Missing title",
	}] });
	assert.equal(projected.some(message => message.role === "assistant" && message.content.every(part => part.type === "thinking")), false);
	assert.match(JSON.stringify(projected), /Historical reasoning/);
	assert.match(JSON.stringify(projected), /native-signature/);
});

test("shared marking represents inherited material distinctly without classifying it as invalid", () => {
	const session = SessionManager.inMemory(process.cwd());
	const assistant = fauxAssistantMessage(fauxToolCall("agent_message", { operation: "send", content: "Parent work", targetAgent: "peer" }, { id: "parent-call" }));
	const entryId = session.appendMessage(assistant);
	const projected = projectCoordinationHistory({ messages: [assistant],
		transcript: transcriptFromSessionManager(session).inspect(), marks: [{ reason: "inherited",
			record: { agentId: "parent-agent", entryId, kind: "tool-call", toolCallId: "parent-call" },
			diagnostic: "Parent scope",
		}] });
	assert.match(JSON.stringify(projected), /\^ /);
	assert.doesNotMatch(JSON.stringify(projected), /! |invalid/);
	assert.match(JSON.stringify(projected), /parent-agent/);
});

function result(toolCallId: string, toolName: string, text: string): AgentMessage & { role: "toolResult" } {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 1 };
}
