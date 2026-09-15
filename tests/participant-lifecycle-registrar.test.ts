import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

import {
	createAgentBoundExtension,
	createModeratorBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import type {
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../src/coordination/workflow-coordinator.ts";
import {
	registerParticipantInputLifecycle,
	registerParticipantLifecycle,
	type ParticipantLifecycleHandlers,
} from "../src/pi-integration/participant-lifecycle.ts";

import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import { createMessageDelivery, inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { obligationStack, type ObligationFrame } from "../src/protocol/obligation-focus.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";

test("context hook marks invalid coordination without starting a turn or rewriting native evidence", async () => {
	const context = createExtensionContext();
	const manager = context.sessionManager;
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: "recipient", question: "Historical work without a title",
	}, { id: "invalid-history" })));
	manager.appendMessage({ role: "toolResult", toolCallId: "invalid-history", toolName: "agent_message",
		content: [{ type: "text", text: "Historical result" }], isError: false, timestamp: 1 });
	const original = JSON.stringify(manager.getEntries());
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, lifecycleHandlers({}));
	const projected = await pi.emit("context", { type: "context", messages: manager.buildSessionContext().messages }, context);
	assert.match(JSON.stringify(projected), /! /);
	assert.match(JSON.stringify(projected), /Historical work without a title/);
	assert.match(JSON.stringify(projected), /Historical result/);
	assert.equal(pi.messages.length, 0);
	assert.equal(context.notifications.length, 0);
	assert.equal(JSON.stringify(manager.getEntries()), original);
});

test("Owner context keeps inherited attention informational and newly delivered Requests owed on old branches", async () => {
	const context = createExtensionContext();
	const manager = SessionManager.inMemory();
	Object.assign(context, { sessionManager: manager });
	manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: "source-owner" });
	const oldLeaf = manager.appendCustomMessageEntry("agent-coordination.request-attention", "Source Request reminder", true);
	manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: manager.getSessionId(), workflowId: manager.getSessionId(), directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" },
	});
	manager.branch(oldLeaf);
	const current = appendRequestDelivery(manager, { requesterAgentId: "current-requester", title: "Current Request", question: "Current work" });
	const currentLeaf = manager.getLeafId()!;
	const original = JSON.stringify(manager.getEntries());
	for (const leaf of [currentLeaf, oldLeaf, currentLeaf]) {
		manager.branch(leaf);
		// A new registrar also exercises rebuilding projection after reload.
		const pi = new CapturedExtensionApi();
		registerParticipantLifecycle(pi.api, lifecycleHandlers({}));
		const projected = await pi.emit("context", { type: "context", messages: manager.buildSessionContext().messages }, context);
		assert.match(JSON.stringify(projected), /\^ .*Source Request reminder/);
		assert.match(JSON.stringify(projected), /Outstanding Requests/);
		assert.match(JSON.stringify(projected), new RegExp(current.requestId));
		assert.deepEqual(obligationStack(transcriptFromSessionManager(manager).inspect(), manager.getSessionId()), [current]);
		assert.equal(pi.messages.length, 0);
		assert.equal(JSON.stringify(manager.getEntries()), original);
	}
});

test("one Owner context pass separates inherited and invalid exact-duplicate native records", async () => {
	const context = createExtensionContext();
	const manager = SessionManager.inMemory();
	Object.assign(context, { sessionManager: manager });
	manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: "source-owner" });
	const call = { ...fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request", question: "Missing title" }, { id: "same-native-id" })), timestamp: 1 };
	const result = { role: "toolResult" as const, toolCallId: "same-native-id", toolName: "agent_message", content: [{ type: "text" as const, text: "Same native result" }], isError: false, timestamp: 2 };
	manager.appendMessage(call);
	manager.appendMessage(result);
	manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: manager.getSessionId(), workflowId: manager.getSessionId(), directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" },
	});
	manager.appendMessage(structuredClone(call));
	manager.appendMessage(structuredClone(result));
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, lifecycleHandlers({}));
	const projected = await pi.emit("context", { type: "context", messages: structuredClone(manager.buildSessionContext().messages) }, context);
	const text = JSON.stringify(projected);
	assert.equal(text.split("^ ").length - 1, 1);
	assert.equal(text.split("! ").length - 1, 1);
	assert.equal(pi.messages.length, 0);
});

test("verified startup reconciliation excludes already-proven Answers without durable snapshot authority", async () => {
	const context = createExtensionContext();
	const old = appendRequestDelivery(context.sessionManager, { requesterAgentId: "requester", title: "Previously answered", question: "Old work" });
	const original = JSON.stringify(context.sessionManager.getEntries());
	// The coordinator has independently verified recipient-side Answer proof;
	// the responder's author result is absent after the delivery-before-result crash.
	for (let restart = 0; restart < 2; restart++) {
		const pi = new CapturedExtensionApi();
		pi.api.appendEntry = (type, data) => { context.sessionManager.appendCustomEntry(type, data); };
		registerParticipantLifecycle(pi.api, lifecycleHandlers({ async executionStarted() { return []; } }));
		await pi.emit("agent_start", { type: "agent_start" }, context);
		assert.equal(JSON.stringify(context.sessionManager.getEntries()), original, "startup reconciliation is not a durable obligation snapshot");
		const projected = await pi.emit("context", { type: "context", messages: [] }, context);
		assert.doesNotMatch(JSON.stringify(projected), new RegExp(old.requestId));
		assert.equal(pi.messages.length, 0);
	}
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, lifecycleHandlers({ async executionStarted() { return []; } }));
	await pi.emit("agent_start", { type: "agent_start" }, context);
	const next = appendRequestDelivery(context.sessionManager, { requesterAgentId: "requester", title: "Newly delivered", question: "New work" });
	const projected = await pi.emit("context", { type: "context", messages: [] }, context);
	assert.match(JSON.stringify(projected), new RegExp(next.requestId));
	assert.doesNotMatch(JSON.stringify(projected), new RegExp(old.requestId));
});

test("a Request delivered during startup reconciliation is not hidden by an earlier coordinator snapshot", async () => {
	const context = createExtensionContext();
	const pi = new CapturedExtensionApi();
	let release!: (frames: readonly ObligationFrame[]) => void;
	const started = new Promise<readonly ObligationFrame[]>(resolve => { release = resolve; });
	registerParticipantLifecycle(pi.api, lifecycleHandlers({ async executionStarted() { return started; } }));
	const startup = pi.emit("agent_start", { type: "agent_start" }, context);
	const next = appendRequestDelivery(context.sessionManager, { requesterAgentId: "requester", title: "Delivered during startup", question: "New work" });
	release([]);
	await startup;
	const projected = await pi.emit("context", { type: "context", messages: [] }, context);
	assert.match(JSON.stringify(projected), new RegExp(next.requestId));
	assert.equal(pi.messages.length, 0);
});

test("locally committed omitted-Delivery Answer offers remaining work once", async () => {
	const context = createExtensionContext();
	appendRequestDelivery(context.sessionManager, { requesterAgentId: "requester", title: "Remaining work", question: "Keep going" });
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, lifecycleHandlers());
	await pi.emit("turn_end", { type: "turn_end", toolResults: [{ ...toolResultMessage,
		toolName: "agent_message", details: { messageId: "answer", requestMessageId: "finished",
			disposition: "committed", delivery: "omitted", reason: "request_source_unavailable" },
	}] }, context);
	await pi.emit("agent_end", { type: "agent_end", messages: [] }, context);
	assert.equal(pi.messages.length, 1);
	assert.match(String(pi.messages[0]!.message.content), /Remaining work/);
	await pi.emit("agent_end", { type: "agent_end", messages: [] }, context);
	assert.equal(pi.messages.length, 1);
});

test("lifecycle Request presentation preserves recovery without becoming Delivery evidence", { timeout: 5_000 }, async () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const agentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId });
	const frame = appendRequestDelivery(sessionManager, { requesterAgentId: "requester", title: "Finish current work", question: "Finish this Request." });
	const pi = new CapturedExtensionApi();
	pi.api.appendEntry = (customType, data) => { sessionManager.appendCustomEntry(customType, data); };
	pi.api.sendMessage = (message) => {
		sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
	};
	registerParticipantLifecycle(pi.api, lifecycleHandlers({
		async executionStarted() { return [frame]; },
	}));
	const context = { ...createExtensionContext(), sessionManager };
	await pi.emit("agent_start", { type: "agent_start" }, context);
	// Continuation remains the durable presentation producer; startup context is projected.
	await pi.emit("turn_end", { type: "turn_end", toolResults: [{ ...toolResultMessage,
		toolName: "agent_message", details: { messageId: "answer", requestMessageId: "finished", messageStatus: "sent" },
	}] }, context);
	await pi.emit("agent_end", { type: "agent_end", messages: [] }, context);
	const presentation = sessionManager.getLeafEntry();
	assert.equal(presentation?.type, "custom_message");
	assert.ok(presentation?.type === "custom_message" && presentation.display);
	// Re-read the producer's committed records, rather than duplicating its custom type in a fixture.
	const transcript = transcriptFromSessionManager(sessionManager).inspect();
	assert.equal(inspectMessageDeliveries({ recipientAgentId: agentId, transcript }).length, 1);
	assert.deepEqual(obligationStack(transcript, agentId), [frame]);
	await pi.emit("agent_start", { type: "agent_start" }, context);
});

const lifecycleEventNames = [
	"agent_end",
	"agent_start",
	"context",
	"input",
	"message_end",
	"session_before_compact",
	"session_before_tree",
	"tool_execution_start",
	"turn_end",
] as const;

const toolResultMessage: MessageEndEvent["message"] = {
	role: "toolResult",
	toolCallId: "human-tool-call",
	toolName: "ask_user",
	content: [{ type: "text", text: "Answer" }],
	isError: false,
	timestamp: 1,
};

test("participant lifecycle registrar routes the exact current Pi boundaries in order", async () => {
	const calls: unknown[] = [];
	const images = [{ type: "image", mimeType: "image/png", data: "image-data" }] as const;
	const handlers = lifecycleHandlers({
		async executionStarted() {
			calls.push("execution-started");
			return [];
		},
		async humanInputSubmitted(input) {
			calls.push(["human-input", input]);
			return "continue";
		},
		async toolResultCommitting(input) {
			calls.push(["human-result", input]);
		},
		async toolExecutionStarted(input) {
			calls.push(["tool-started", input]);
		},
		async safeBoundaryReached() {
			calls.push("safe-boundary");
		},
		async executionEnded() {
			calls.push("execution-ended");
		},
	});
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, handlers);
	const context = createExtensionContext();

	assert.deepEqual([...pi.handlers.keys()].sort(), [...lifecycleEventNames].sort());
	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "extension delivery",
			source: "extension",
		}, context),
		{ action: "continue" },
	);
	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "queued continuation",
			source: "interactive",
			streamingBehavior: "followUp",
		}, context),
		{ action: "continue" },
	);
	assert.deepEqual(calls, []);

	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "human input",
			images: [...images],
			source: "interactive",
		}, context),
		{ action: "continue" },
	);
	await pi.emit("agent_start", { type: "agent_start" }, context);
	assert.equal(
		await pi.emit("message_end", {
			type: "message_end",
			message: toolResultMessage,
		}, context),
		undefined,
	);
	await pi.emit("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId: "tool-call-1",
		toolName: "read",
		args: { path: "README.md" },
	}, context);
	await pi.emit("turn_end", {
		type: "turn_end",
		turnIndex: 0,
		message: toolResultMessage,
		toolResults: [toolResultMessage],
	}, context);
	await pi.emit("agent_end", {
		type: "agent_end",
		messages: [toolResultMessage],
	}, context);

	assert.deepEqual(calls, [
		["human-input", { text: "human input", images: [...images] }],
		"execution-started",
		["human-result", { message: toolResultMessage }],
		["tool-started", { toolCallId: "tool-call-1", toolName: "read" }],
		"safe-boundary",
		"execution-ended",
	]);
});

test("each execution presents titled open Requests without repeating bodies or selecting the next task", async () => {
	const context = createExtensionContext();
	const frames = [
		appendRequestDelivery(context.sessionManager, { requesterAgentId: "author-a", title: "Complete storage", question: "Finish A" }),
		appendRequestDelivery(context.sessionManager, { requesterAgentId: "author-b", title: "Review integration", question: "Consider B" }),
	];
	const pi = new CapturedExtensionApi();
	pi.api.appendEntry = (type, data) => { context.sessionManager.appendCustomEntry(type, data); };
	registerParticipantLifecycle(pi.api, lifecycleHandlers({ async executionStarted() { return frames; } }));
	await pi.emit("agent_start", { type: "agent_start" }, context);
	const projected = await pi.emit("context", { type: "context", messages: [] }, context) as {
		messages: Array<{ content: string; details: unknown }>;
	};
	assert.equal(pi.messages.length, 0, "context presentation does not queue another turn");
	assert.equal(projected.messages.length, 1);
	const presentation = projected.messages[0]!;
	assert.deepEqual(presentation.details, { requests: frames.map(({ requestId, requesterAgentId, title }) => ({
		requestMessageId: requestId, requesterAgentId, title,
	})) });
	assert.match(presentation.content, /Choose/);
	assert.match(presentation.content, /Complete storage/);
	assert.match(presentation.content, /Review integration/);
	assert.doesNotMatch(presentation.content, /Finish A|Consider B/);
});

for (const pending of [false, true]) test(`Answer offers one neutral continuation only when needed (pending input: ${pending})`, async () => {
	const pi = new CapturedExtensionApi();
	const context = createExtensionContext();
	context.hasPendingMessages = () => pending;
	appendRequestDelivery(context.sessionManager, { requesterAgentId: "author-a", title: "Complete remaining work", question: "Remaining A" });
	registerParticipantLifecycle(pi.api, lifecycleHandlers());
	const answer = { ...toolResultMessage, toolName: "agent_message", details: {
		messageId: "answer-b", requestMessageId: "request-b", messageStatus: "sent",
	} };
	await pi.emit("turn_end", { type: "turn_end", toolResults: [answer] }, context);
	await pi.emit("agent_end", { type: "agent_end", messages: [answer] }, context);
	assert.equal(pi.messages.length, pending ? 0 : 1);
	if (!pending) {
		assert.equal(pi.messages[0]!.options?.triggerTurn, true);
		assert.match(String(pi.messages[0]!.message.content), /Choose/);
	}
	await pi.emit("agent_end", { type: "agent_end", messages: [] }, context);
	assert.equal(pi.messages.length, pending ? 0 : 1, "settling with outstanding work must not spin");
});

test("the final Answer does not manufacture a summary continuation", async () => {
	const pi = new CapturedExtensionApi();
	const context = createExtensionContext();
	registerParticipantLifecycle(pi.api, lifecycleHandlers());
	const answer = { ...toolResultMessage, toolName: "agent_message", details: {
		messageId: "last-answer", requestMessageId: "last-request", messageStatus: "sent",
	} };
	await pi.emit("turn_end", { type: "turn_end", toolResults: [answer] }, context);
	await pi.emit("agent_end", { type: "agent_end", messages: [answer] }, context);
	assert.deepEqual(pi.messages, []);
});

test("ordinary and Moderator extensions preserve local lifecycle operation order", async (t) => {
	for (const role of ["ordinary", "moderator"] as const) {
		await t.test(role, async () => {
			const calls: unknown[] = [];
			const view = localLifecycleView(calls);
			const extension = role === "ordinary"
				? createAgentBoundExtension(
					() => view as unknown as OrdinaryAgentCoordinatorView,
				)
				: createModeratorBoundExtension(
					() => view as unknown as ModeratorAgentCoordinatorView,
				);
			const pi = new CapturedExtensionApi();
			await runExtension(extension, pi.api);
			const context = createExtensionContext();

			assert.deepEqual(
				await pi.emit("input", {
					type: "input",
					text: "resume locally",
					source: "interactive",
				}, context),
				{ action: "continue" },
			);
			await pi.emit("agent_start", { type: "agent_start" }, context);
			await pi.emit("message_end", {
				type: "message_end",
				message: toolResultMessage,
			}, context);
			await pi.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "tool-call-2",
				toolName: "bash",
				args: { command: "true" },
			}, context);
			await pi.emit("turn_end", {
				type: "turn_end",
				turnIndex: 0,
				message: toolResultMessage,
				toolResults: [toolResultMessage],
			}, context);
			await pi.emit("agent_end", {
				type: "agent_end",
				messages: [toolResultMessage],
			}, context);

			assert.deepEqual(calls, [
				["resume-human", "resume locally", undefined],
				"begin-execution",
				["guard-human-result", toolResultMessage],
				"reconcile-human-results",
				"reconcile-committed-results",
				"ensure-execution",
				["begin-tool", "tool-call-2", "bash"],
				"reconcile-human-results",
				"reconcile-committed-results",
				"ensure-execution",
				"reach-safe-boundary",
				"reconcile-committed-results",
				"end-execution",
				"reconcile-human-results",
			]);
		});
	}
});

test("primary steering defers coordination until after its input handler returns", async () => {
	const calls: string[] = [];
	const handlers = lifecycleHandlers({
		async humanInputSubmitted() {
			calls.push("input-checked");
			return "continue";
		},
		async primaryInputQueued() {
			calls.push("queue-notified");
		},
	});
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, handlers);

	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "redirect the waiting agent",
			source: "interactive",
			streamingBehavior: "steer",
		}, createExtensionContext()),
		{ action: "continue" },
	);
	calls.push("native-input-can-queue");
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.deepEqual(calls, [
		"input-checked",
		"native-input-can-queue",
		"queue-notified",
	]);
});

test("participant input registration can follow inherited extension preflights", async () => {
	let submitted = 0;
	const handlers = lifecycleHandlers({
		async humanInputSubmitted() {
			submitted += 1;
			return "continue";
		},
	});
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, handlers, { registerInput: false });
	assert.equal(pi.handlers.has("input"), false);

	registerParticipantInputLifecycle(pi.api, handlers);
	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "submitted after inherited preflight",
			source: "interactive",
		}, createExtensionContext()),
		{ action: "continue" },
	);
	assert.equal(submitted, 1);
});

test("participant lifecycle registrar preserves native Human Answer recovery", async () => {
	const failure = new Error("human submission failed");
	const handlers = lifecycleHandlers({
		async humanInputSubmitted() {
			throw failure;
		},
		async humanInputMode() {
			return "answer";
		},
		async toolResultCommitting() {
			return {
				rejectedAnswer: "Rejected answer",
				reason: "the exact request ended",
			};
		},
	});
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, handlers);
	const context = createExtensionContext("newer draft");

	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "Submitted answer",
			source: "interactive",
		}, context),
		{ action: "handled" },
	);
	assert.equal(context.ui.getEditorText(), "Submitted answer");
	assert.deepEqual(context.notifications, [{
		message: "Human Answer was not submitted: human submission failed",
		type: "error",
	}]);

	assert.equal(
		await pi.emit("message_end", {
			type: "message_end",
			message: toolResultMessage,
		}, context),
		undefined,
	);
	assert.equal(
		context.ui.getEditorText(),
		"Rejected answer\nSubmitted answer",
	);
	assert.deepEqual(context.notifications.at(-1), {
		message: "Human Answer was not committed: the exact request ended",
		type: "error",
	});
});

test("participant lifecycle registrar preserves fail-fast handler errors", async (t) => {
	const cases = [
		["agent_start", "executionStarted", { type: "agent_start" }],
		[
			"message_end",
			"toolResultCommitting",
			{ type: "message_end", message: toolResultMessage },
		],
		[
			"tool_execution_start",
			"toolExecutionStarted",
			{
				type: "tool_execution_start",
				toolCallId: "tool-call-failure",
				toolName: "read",
				args: {},
			},
		],
		[
			"turn_end",
			"safeBoundaryReached",
			{
				type: "turn_end",
				turnIndex: 0,
				message: toolResultMessage,
				toolResults: [toolResultMessage],
			},
		],
		[
			"agent_end",
			"executionEnded",
			{ type: "agent_end", messages: [toolResultMessage] },
		],
	] as const;
	for (const [eventName, handlerName, event] of cases) {
		await t.test(eventName, async () => {
			const failure = new Error(`exact ${handlerName} failure`);
			const pi = new CapturedExtensionApi();
			registerParticipantLifecycle(
				pi.api,
				lifecycleHandlers({
					[handlerName]: async () => {
						throw failure;
					},
				}),
			);
			await assert.rejects(
				pi.emit(eventName, event, createExtensionContext()),
				(error) => error === failure,
			);
		});
	}

	await t.test("human input mode lookup", async () => {
		const submissionFailure = new Error("submission failed");
		const modeFailure = new Error("exact mode lookup failure");
		const pi = new CapturedExtensionApi();
		registerParticipantLifecycle(pi.api, lifecycleHandlers({
			async humanInputSubmitted() {
				throw submissionFailure;
			},
			async humanInputMode() {
				throw modeFailure;
			},
		}));
		await assert.rejects(
			pi.emit("input", {
				type: "input",
				text: "answer",
				source: "interactive",
			}, createExtensionContext()),
			(error) => error === modeFailure,
		);
	});
});

function lifecycleHandlers(
	overrides: Partial<ParticipantLifecycleHandlers> = {},
): ParticipantLifecycleHandlers {
	return {
		async executionStarted() { return []; },
		async humanInputSubmitted() {
			return "continue";
		},
		async humanInputMode() {
			return "agent";
		},
		async primaryInputQueued() {},
		async toolResultCommitting() {},
		async toolExecutionStarted() {},
		async safeBoundaryReached() {},
		async executionEnded() {},
		...overrides,
	};
}

function localLifecycleView(calls: unknown[]) {
	return {
		async resumeFromHuman(text: string, images: readonly unknown[] | undefined) {
			calls.push(["resume-human", text, images]);
			return "continue" as const;
		},
		agentActivity() {
			return { answerMode: false };
		},
		obligationFrames() { return []; },
		async refreshTranscriptFacts() {},
		async beginExecution() {
			calls.push("begin-execution");
		},
		guardToolResult(message: MessageEndEvent["message"]) {
			calls.push(["guard-human-result", message]);
		},
		reconcileHumanToolResults() {
			calls.push("reconcile-human-results");
		},
		reconcileCommittedToolResults() {
			calls.push("reconcile-committed-results");
		},
		async ensureExecution() {
			calls.push("ensure-execution");
		},
		beginToolExecution(toolCallId: string, toolName: string) {
			calls.push(["begin-tool", toolCallId, toolName]);
		},
		async reachSafeBoundary() {
			calls.push("reach-safe-boundary");
		},
		endExecution() {
			calls.push("end-execution");
		},
	};
}

type CapturedHandler = (event: never, context: ExtensionContext) => unknown;

class CapturedExtensionApi {
	readonly handlers = new Map<string, CapturedHandler[]>();
	readonly messages: Array<{ message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }> = [];
	readonly api = {
		on: (eventName: string, handler: CapturedHandler) => {
			const handlers = this.handlers.get(eventName) ?? [];
			handlers.push(handler);
			this.handlers.set(eventName, handlers);
		},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
			this.messages.push({ message, options });
		},
	} as unknown as ExtensionAPI;

	async emit(
		eventName: string,
		event: unknown,
		context: ExtensionContext,
	): Promise<unknown> {
		const handlers = this.handlers.get(eventName) ?? [];
		assert.equal(handlers.length, 1, eventName);
		return handlers[0]!(event as never, context);
	}
}

function appendRequestDelivery(manager: SessionManager, frame: Omit<ObligationFrame, "requestId">): ObligationFrame {
	const source = { agentId: frame.requesterAgentId, entryId: frame.title, toolCallId: frame.title };
	const requestId = deriveMessageIdentity(source);
	const delivery = createMessageDelivery([{ source, projection: { kind: "request", requestMessageId: requestId,
		fromAgentId: frame.requesterAgentId, title: frame.title, question: frame.question } }]);
	manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	return { ...frame, requestId };
}

function createExtensionContext(initialEditorText = "") {
	let editorText = initialEditorText;
	const notifications: Array<{
		message: string;
		type?: "info" | "warning" | "error";
	}> = [];
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry("agent-coordination.identity", { agentId: sessionManager.getSessionId() });
	const ui = {
		setEditorText(text: string) {
			editorText = text;
		},
		getEditorText() {
			return editorText;
		},
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
	};
	return Object.assign(
		{ ui, sessionManager, hasPendingMessages: () => false },
		{ notifications },
	) as unknown as ExtensionContext & { sessionManager: SessionManager; notifications: typeof notifications };
}

async function runExtension(extension: ExtensionFactory, pi: ExtensionAPI): Promise<void> {
	await extension(pi);
}
