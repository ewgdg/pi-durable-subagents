import assert from "node:assert/strict";
import test from "node:test";

import type { ControlRequest } from "../src/control/agent-control-channel.ts";
import { agentControlProtocol } from "../src/control/agent-control-protocol.ts";
import {
	createControlBackedChildParticipantHandlers,
	createControlBackedChildPresentationHandlers,
	dispatchParticipantRequestToOwner,
	type ChildParticipantControlRequester,
	type OwnerParticipantRequestHandlers,
} from "../src/process-runtime/remote-participant-control.ts";

const status = {
	agentId: "observed-agent",
	workflowId: "workflow",
	label: "Observed",
	directSpawnerAgentId: "remote-agent",
	primaryEvidence: {
		transcriptPath: "/sessions/observed.jsonl",
		inspectedThrough: { agentId: "observed-agent", entryId: "entry-observed" },
	},
	run: { phase: "dormant", retentionReasons: [] },
} as const;

test("Control-backed participant proxies preserve exact lifecycle and tool intentions", async () => {
	const calls: unknown[] = [];
	const waitUpdates: unknown[] = [];
	let waitProgressHandler: ((progress: {
		waitingFor: readonly { requestMessageId: string; requestTitle: string; responderAgentId: string }[];
	}) => void) | undefined;
	let waitProgressRemoved = false;
	const waitProgress = {
		waitingFor: [{ requestTitle: "Fixture request", requestMessageId: "request-1", responderAgentId: "target" }],
	} as const;
	const cancellation = new AbortController();
	const request = (async (
		method: string,
		payload: unknown,
		signal?: AbortSignal,
	) => {
		calls.push([method, payload, signal]);
		switch (method) {
			case "runtime.humanInput": return { disposition: "submitted" };
			case "runtime.humanInputMode": return { mode: "answer" };
			case "runtime.guardToolResult": return { result: null };
			case "coordination.observe":
				return (payload as { operation: string }).operation === "search"
					? { matches: [status], hasMore: false }
					: status;
			case "coordination.message": return {
				messageId: "message-1",
				targetAgentId: "target",
				messageStatus: "sent",
			};
			case "coordination.wait":
				waitProgressHandler?.(waitProgress);
				return { disposition: "preempted" };
			case "coordination.control": return { agentId: "target", disposition: "held" };
			case "coordination.spawn": return {
				spawnStatus: "not_created",
				failedStage: "identity_commit",
				reason: "Test child was not created",
			};
			case "coordination.askHuman": return { requestId: "human-1", answer: "Proceed." };
			default: return {};
		}
	}) as ChildParticipantControlRequester;
	const proxies = createControlBackedChildParticipantHandlers(
		"ordinary",
		request,
		{ current: () => 7, take: () => undefined },
		{
			subscribe(toolCallId, handler) {
				assert.equal(toolCallId, "wait-call");
				waitProgressHandler = handler;
				return () => {
					waitProgressRemoved = true;
					waitProgressHandler = undefined;
				};
			},
		},
	);

	await proxies.lifecycle.executionStarted();
	assert.equal(
		await proxies.lifecycle.humanInputSubmitted({ text: "resume", images: undefined }),
		"submitted",
	);
	await proxies.lifecycle.primaryInputQueued();
	assert.equal(await proxies.lifecycle.humanInputMode(), "answer");
	assert.equal(await proxies.lifecycle.toolResultCommitting({
		message: { role: "user", content: "candidate", timestamp: 1 },
	}), undefined);
	await proxies.lifecycle.toolExecutionStarted({ toolCallId: "tool-1", toolName: "read" });
	await proxies.lifecycle.safeBoundaryReached();
	await proxies.lifecycle.executionEnded();
	assert.equal(await proxies.coordination.observe({ operation: "status" }), status);
	assert.deepEqual(
		await proxies.coordination.observe({
			operation: "search",
			scope: "direct_children",
			query: "observed",
			limit: 20,
		}),
		{ matches: [status], hasMore: false },
	);
	assert.deepEqual(
		await proxies.coordination.message("message-call", {
			operation: "send",
			targetAgent: "target",
			content: "hello",
		}),
		{ messageId: "message-1", targetAgentId: "target", messageStatus: "sent" },
	);
	assert.deepEqual(
		await proxies.coordination.wait(
			"wait-call",
			{},
			cancellation.signal,
			(progress) => waitUpdates.push(progress),
		),
		{ disposition: "preempted" },
	);
	assert.deepEqual(waitUpdates, [waitProgress]);
	assert.equal(waitProgressRemoved, true);
	assert.deepEqual(
		await proxies.coordination.askUser(
			"human-call",
			{ question: "Proceed?" },
			cancellation.signal,
		),
		{ requestId: "human-1", answer: "Proceed." },
	);

	assert.deepEqual(calls, [
		["runtime.executionBegin", {}, undefined],
		["runtime.humanInput", { text: "resume", submissionSequence: 7 }, undefined],
		["runtime.primaryInputQueued", {}, undefined],
		["runtime.humanInputMode", {}, undefined],
		["runtime.guardToolResult", {
			message: { role: "user", content: "candidate", timestamp: 1 },
		}, undefined],
		["runtime.toolExecutionStart", { toolCallId: "tool-1", toolName: "read" }, undefined],
		["runtime.safeBoundary", {}, undefined],
		["runtime.executionEnd", {}, undefined],
		["coordination.observe", { operation: "status" }, undefined],
		["coordination.observe", {
			operation: "search",
			scope: "direct_children",
			query: "observed",
			limit: 20,
		}, undefined],
		["coordination.message", {
			toolCallId: "message-call",
			input: { operation: "send", targetAgent: "target", content: "hello" },
		}, undefined],
		["coordination.wait", {
			toolCallId: "wait-call",
			input: {},
		}, cancellation.signal],
		["coordination.askHuman", {
			toolCallId: "human-call",
			input: { question: "Proceed?" },
		}, cancellation.signal],
	]);
});

test("aborting a tool call cancels its askHuman Control request", async () => {
	let receivedSignal: AbortSignal | undefined;
	const request = (async (method: string, _payload: unknown, signal?: AbortSignal) => {
		assert.equal(method, "coordination.askHuman");
		receivedSignal = signal;
		return await new Promise((_resolve, reject) => {
			signal?.addEventListener("abort", () =>
				reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
		});
	}) as ChildParticipantControlRequester;
	const proxies = createControlBackedChildParticipantHandlers("ordinary", request);
	const cancellation = new AbortController();
	const pending = proxies.coordination.askUser(
		"cancelled-human-call",
		{ question: "Wait?" },
		cancellation.signal,
	);
	cancellation.abort();

	await assert.rejects(pending, (error: unknown) =>
		error instanceof Error && error.name === "AbortError"
	);
	assert.equal(receivedSignal, cancellation.signal);
	assert.equal(receivedSignal?.aborted, true);
});

test("Control-backed child presentation requests preserve exact selector snapshot and action", async () => {
	const calls: unknown[] = [];
	const snapshot = {
		live: [],
		dormant: [],
		selectedAgentId: "remote-agent",
		humanAttention: [],
		operationalAttention: [], reports: [],
	};
	const cancellation = new AbortController();
	const request = (async (method: string, payload: unknown, signal?: AbortSignal) => {
		calls.push([method, payload, signal]);
		return method === "presentation.agents.snapshot" ? snapshot : { kind: "selected" };
	}) as ChildParticipantControlRequester;
	const presentation = createControlBackedChildPresentationHandlers(request);

	assert.equal(await presentation.snapshot(), snapshot);
	assert.deepEqual(
		await presentation.select(
			{ kind: "select_agent", agentId: "owner" },
			cancellation.signal,
		),
		{ kind: "selected" },
	);
	assert.deepEqual(calls, [
		["presentation.agents.snapshot", {}, undefined],
		["presentation.agents.select", { kind: "select_agent", agentId: "owner" }, cancellation.signal],
	]);
});

test("Owner dispatch invokes scoped process-neutral handlers and returns exact receipts", async () => {
	const calls: unknown[] = [];
	const handlers: OwnerParticipantRequestHandlers<"moderator"> = {
		presentation: {
			async setReportRead() {},
			async snapshot() {
				return {
					live: [], dormant: [], selectedAgentId: "remote-agent",
					humanAttention: [], operationalAttention: [], reports: [],
				};
			},
			async select(action, signal) {
				calls.push(["select", action, signal]);
				return { kind: "selected" };
			},
		},
		lifecycle: {
			async executionStarted() { calls.push(["begin"]); return []; },
			async humanInputSubmitted(input) { calls.push(["input", input]); return "submitted"; },
			async primaryInputQueued() { calls.push(["input-queued"]); },
			async humanInputMode() { calls.push(["mode"]); return "agent"; },
			async toolResultCommitting(input) { calls.push(["guard", input]); return undefined; },
			async toolExecutionStarted(input) { calls.push(["tool", input]); },
			async safeBoundaryReached() { calls.push(["boundary"]); },
			async executionEnded() { calls.push(["end"]); },
		},
		coordination: {
			async observe(input) {
				calls.push(["observe", input]);
				return { matches: [status], hasMore: false };
			},
			async message(toolCallId, input) {
				calls.push(["message", toolCallId, input]);
				return {
					messageId: "message-owner",
					targetAgentId: "owner-target",
					messageStatus: "sent",
				};
			},
			async wait() { return { answers: [] }; },
			async control(toolCallId, input) {
				calls.push(["control", toolCallId, input]);
				return { agentId: input.agentId, disposition: "not_running" };
			},
			async askUser(toolCallId, input, signal) {
				calls.push(["ask", toolCallId, input, signal]);
				return { requestId: "human-owner", answer: "Yes" };
			},
			async reportToUser() { return { reportId: "report", createdAt: "2026-01-01T00:00:00.000Z" }; },
			async moderatorControl(toolCallId, input) {
				calls.push(["moderator", toolCallId, input]);
				return { disposition: "resolved" };
			},
		},
	};
	const signal = new AbortController().signal;
	const request = {
		method: "coordination.message",
		payload: {
			toolCallId: "owner-call",
			input: { operation: "poll", messageId: "message-0" },
		},
		signal,
	} as ControlRequest<typeof agentControlProtocol>;

	assert.deepEqual(await dispatchParticipantRequestToOwner(handlers, request), {
		messageId: "message-owner",
		targetAgentId: "owner-target",
		messageStatus: "sent",
	});
	assert.deepEqual(calls, [[
		"message",
		"owner-call",
		{ operation: "poll", messageId: "message-0" },
	]]);
});

test("Owner dispatch publishes the admitted Agent Wait snapshot", async () => {
	const progress = {
		waitingFor: [{
			requestTitle: "Fixture request",
			requestMessageId: "remote-wait-request",
			responderAgentId: "responder-agent",
		}],
	} as const;
	const published: unknown[] = [];
	const handlers = {
		coordination: {
			async wait(_toolCallId: string, _input: unknown, _signal: AbortSignal, onProgress: (value: typeof progress) => void) {
				onProgress(progress);
				return { disposition: "preempted" };
			},
		},
	} as unknown as OwnerParticipantRequestHandlers<"ordinary">;
	const signal = new AbortController().signal;
	const result = await dispatchParticipantRequestToOwner(
		handlers,
		{
			method: "coordination.wait",
			payload: { toolCallId: "remote-wait-call", input: {} },
			signal,
		},
		{
			waitProgress: (toolCallId, update) => published.push([toolCallId, update]),
		},
	);

	assert.deepEqual(result, { disposition: "preempted" });
	assert.deepEqual(published, [["remote-wait-call", progress]]);
});

test("Owner dispatch awaits the authenticated child's presentation selection with cancellation", async () => {
	const cancellation = new AbortController();
	let receivedSignal: AbortSignal | undefined;
	const handlers = {
		presentation: {
			snapshot: () => ({
				live: [], dormant: [], selectedAgentId: "remote-agent",
				humanAttention: [], operationalAttention: [], reports: [],
			}),
			select: async (_action: unknown, signal: AbortSignal) => {
				receivedSignal = signal;
				await new Promise<void>((_resolve, reject) => signal.addEventListener(
					"abort",
					() => reject(new DOMException("cancelled", "AbortError")),
					{ once: true },
				));
			},
		},
		lifecycle: {},
		coordination: {},
	} as unknown as OwnerParticipantRequestHandlers<"ordinary">;
	const pending = dispatchParticipantRequestToOwner(handlers, {
		method: "presentation.agents.select",
		payload: { kind: "select_agent", agentId: "owner" },
		signal: cancellation.signal,
	});
	cancellation.abort();

	await assert.rejects(pending, (error: unknown) =>
		error instanceof Error && error.name === "AbortError"
	);
	assert.equal(receivedSignal, cancellation.signal);
});

test("Moderator report transport is nonblocking and ordinary participants cannot publish", async () => {
	const input = {
		symptom: "Delivery stopped", suspectedDefect: "No continuation after dispatch",
		uncertainty: "Cause not proven", recoveryActions: "Retried the message",
		recoveryOutcome: "Still pending", evidence: ["agent/entry/call"],
	};
	const receipt = { reportId: "report-1", createdAt: "2026-01-01T00:00:00.000Z" };
	const calls: unknown[] = [];
	const request = (async (method: string, payload: unknown, signal?: AbortSignal) => {
		calls.push([method, payload, signal]);
		return receipt;
	}) as ChildParticipantControlRequester;
	const moderator = createControlBackedChildParticipantHandlers("moderator", request);
	assert.deepEqual(await moderator.coordination.reportToUser("report-call", input), receipt);
	assert.deepEqual(calls, [["coordination.reportToUser", { toolCallId: "report-call", input }, undefined]]);
	const ordinary = createControlBackedChildParticipantHandlers("ordinary", request);
	assert.equal("reportToUser" in ordinary.coordination, false);
	await assert.rejects(dispatchParticipantRequestToOwner({
		coordination: ordinary.coordination,
		lifecycle: ordinary.lifecycle,
		presentation: {} as OwnerParticipantRequestHandlers<"ordinary">["presentation"],
	}, {
		method: "coordination.reportToUser", payload: { toolCallId: "report-call", input },
		signal: new AbortController().signal,
	} as ControlRequest<typeof agentControlProtocol>), /child_runtime_owner_request_forbidden/);
});

test("explicit report read and unread states cross the control boundary", async () => {
	const calls: unknown[] = [];
	const presentation = createControlBackedChildPresentationHandlers((async (method, payload) => {
		calls.push([method, payload]);
		return {};
	}) as ChildParticipantControlRequester);
	await presentation.setReportRead("retained-report", true);
	await presentation.setReportRead("retained-report", false);
	assert.deepEqual(calls, [["presentation.reports.setRead", { reportId: "retained-report", read: true }], ["presentation.reports.setRead", { reportId: "retained-report", read: false }]]);
});

test("Owner dispatch forwards the explicit desired report read state", async () => {
	const calls: unknown[] = [];
	const handlers = {
		presentation: { async setReportRead(reportId: string, read: boolean) { calls.push([reportId, read]); } },
	} as unknown as OwnerParticipantRequestHandlers<"ordinary">;
	for (const read of [true, false]) {
		assert.deepEqual(await dispatchParticipantRequestToOwner(handlers, {
			method: "presentation.reports.setRead", payload: { reportId: "report", read },
			signal: new AbortController().signal,
		} as ControlRequest<typeof agentControlProtocol>), {});
	}
	assert.deepEqual(calls, [["report", true], ["report", false]]);
});
