import assert from "node:assert/strict";
import test from "node:test";

import {
	FramedAgentControlChannel,
	type ControlEvent,
} from "../src/control/agent-control-channel.ts";
import {
	agentControlProtocol,
	type OwnerToChildControl,
} from "../src/control/agent-control-protocol.ts";
import { AGENT_CONTROL_PROTOCOL_VERSION } from "../src/control/control-protocol-schemas.ts";
import { createInMemoryControlTransportPair } from "../src/control/in-memory-control-transport.ts";
import {
	createControlBackedChildParticipantHandlers,
	createControlBackedChildPresentationHandlers,
	serveOwnerParticipant,
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
	await proxies.lifecycle.rootToolExecutionStarted({ toolCallId: "tool-1", toolName: "read" });
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
		["runtime.rootToolExecutionStart", { toolCallId: "tool-1", toolName: "read" }, undefined],
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


test("Moderator report transport is nonblocking", async () => {
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

test("Owner serving invokes scoped process-neutral handlers and returns exact receipts", async (t) => {
	const calls: unknown[] = [];
	const { child } = serveOwner(t, moderatorHandlers({
		async message(toolCallId, input) {
			calls.push(["message", toolCallId, input]);
			return { messageId: "message-owner", targetAgentId: "owner-target", messageStatus: "sent" };
		},
		async moderatorControl(toolCallId, input) {
			calls.push(["moderator", toolCallId, input]);
			return { disposition: "resolved" };
		},
	}));

	assert.deepEqual(await child.request("coordination.message", {
		toolCallId: "owner-call",
		input: { operation: "poll", messageId: "message-0" },
	}), { messageId: "message-owner", targetAgentId: "owner-target", messageStatus: "sent" });
	assert.deepEqual(await child.request("coordination.moderatorControl", {
		toolCallId: "moderator-call",
		input: { operation: "resolve", summary: "Cleared", rationale: "Predicates clear" },
	}), { disposition: "resolved" });
	assert.deepEqual(await child.request("runtime.guardToolResult", {
		message: { role: "user", content: "candidate", timestamp: 1 },
	}), { result: null });
	assert.deepEqual(calls, [
		["message", "owner-call", { operation: "poll", messageId: "message-0" }],
		["moderator", "moderator-call", { operation: "resolve", summary: "Cleared", rationale: "Predicates clear" }],
	]);
});

test("Owner serving refuses a coordination method the child's role has no handler for", async (t) => {
	let reports = 0;
	const { child } = serveOwner(t, ordinaryHandlers());
	const input = {
		symptom: "Delivery stopped", suspectedDefect: "No continuation after dispatch",
		uncertainty: "Cause not proven", recoveryActions: "Retried the message",
		recoveryOutcome: "Still pending", evidence: ["agent/entry/call"],
	};

	await assert.rejects(
		child.request("coordination.reportToUser", { toolCallId: "report-call", input }),
		/request_failed: child_runtime_owner_request_forbidden: coordination.reportToUser/,
	);
	await assert.rejects(
		child.request("coordination.moderatorControl", { toolCallId: "moderator-call", input: { operation: "resolve", summary: "Cleared", rationale: "Predicates clear" } }),
		/request_failed: child_runtime_owner_request_forbidden: coordination.moderatorControl/,
	);
	const moderator = serveOwner(t, moderatorHandlers({
		async reportToUser() { reports++; return { reportId: "report", createdAt: "2026-01-01T00:00:00.000Z" }; },
	}));
	await assert.rejects(
		moderator.child.request("coordination.spawn", {
			toolCallId: "spawn-call",
			input: { title: "Work", request: "Do it", label: "worker" },
		}),
		/request_failed: child_runtime_owner_request_forbidden: coordination.spawn/,
	);
	assert.equal(reports, 0);
});

test("Owner serving publishes the admitted Agent Wait snapshot to the waiting child", async (t) => {
	const progress = {
		waitingFor: [{
			requestTitle: "Fixture request",
			requestMessageId: "remote-wait-request",
			responderAgentId: "responder-agent",
		}],
	};
	const { child, events } = serveOwner(t, ordinaryHandlers({
		async wait(_toolCallId, _input, _signal, onProgress) {
			onProgress?.(progress);
			return { disposition: "preempted" };
		},
	}));

	assert.deepEqual(
		await child.request("coordination.wait", { toolCallId: "remote-wait-call", input: {} }),
		{ disposition: "preempted" },
	);
	assert.deepEqual(events.map(({ event, payload }) => [event, payload]), [
		["coordination.wait.progress", { toolCallId: "remote-wait-call", progress }],
	]);
});

test("Owner serving cancels the authenticated child's presentation selection", async (t) => {
	let receivedSignal: AbortSignal | undefined;
	const { child } = serveOwner(t, ordinaryHandlers({}, {
		select: async (_action, signal) => {
			receivedSignal = signal;
			return await new Promise((_resolve, reject) => signal.addEventListener(
				"abort",
				() => reject(new DOMException("cancelled", "AbortError")),
				{ once: true },
			));
		},
	}));
	const cancellation = new AbortController();
	const pending = child.request(
		"presentation.agents.select",
		{ kind: "select_agent", agentId: "owner" },
		cancellation.signal,
	);
	await waitUntil(() => receivedSignal !== undefined);
	cancellation.abort();

	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
	await waitUntil(() => receivedSignal?.aborted === true);
});

test("Owner serving forwards the explicit desired report read state", async (t) => {
	const calls: unknown[] = [];
	const { child } = serveOwner(t, ordinaryHandlers({}, {
		async setReportRead(reportId, read) { calls.push([reportId, read]); },
	}));
	for (const read of [true, false]) {
		assert.deepEqual(await child.request("presentation.reports.setRead", { reportId: "report", read }), {});
	}
	assert.deepEqual(calls, [["report", true], ["report", false]]);
});

type OrdinaryCoordination = OwnerParticipantRequestHandlers<"ordinary">["coordination"];
type ModeratorCoordination = OwnerParticipantRequestHandlers<"moderator">["coordination"];
type Presentation = OwnerParticipantRequestHandlers<"ordinary">["presentation"];

const unscripted = (name: string) => () => Promise.reject(new Error(`unscripted: ${name}`));

function lifecycleHandlers(): OwnerParticipantRequestHandlers<"ordinary">["lifecycle"] {
	return {
		executionStarted: async () => [],
		humanInputSubmitted: async () => "continue",
		primaryInputQueued: async () => undefined,
		humanInputMode: async () => "agent",
		toolResultCommitting: async () => undefined,
		rootToolExecutionStarted: async () => undefined,
		safeBoundaryReached: async () => undefined,
		executionEnded: async () => undefined,
	};
}

function presentationHandlers(overrides: Partial<Presentation>): Presentation {
	return {
		snapshot: unscripted("snapshot"),
		setReportRead: unscripted("setReportRead"),
		select: unscripted("select"),
		addChangeHandler: () => () => undefined,
		...overrides,
	};
}

function ordinaryHandlers(
	coordination: Partial<OrdinaryCoordination> = {},
	presentation: Partial<Presentation> = {},
): OwnerParticipantRequestHandlers<"ordinary"> {
	return {
		lifecycle: lifecycleHandlers(),
		coordination: {
			agentTemplateSnapshot: unscripted("agentTemplateSnapshot"),
			observe: unscripted("observe"),
			message: unscripted("message"),
			wait: unscripted("wait"),
			control: unscripted("control"),
			spawn: unscripted("spawn"),
			askUser: unscripted("askUser"),
			...coordination,
		},
		presentation: presentationHandlers(presentation),
	};
}

function moderatorHandlers(coordination: Partial<ModeratorCoordination> = {}): OwnerParticipantRequestHandlers<"moderator"> {
	return {
		lifecycle: lifecycleHandlers(),
		coordination: {
			observe: unscripted("observe"),
			message: unscripted("message"),
			wait: unscripted("wait"),
			control: unscripted("control"),
			askUser: unscripted("askUser"),
			reportToUser: unscripted("reportToUser"),
			moderatorControl: unscripted("moderatorControl"),
			...coordination,
		},
		presentation: presentationHandlers({}),
	};
}

/** Owner serving on one end of an in-memory Control channel; the child end requests. */
function serveOwner(
	t: { after(fn: () => Promise<unknown>): void },
	handlers: OwnerParticipantRequestHandlers<"ordinary"> | OwnerParticipantRequestHandlers<"moderator">,
) {
	const identity = { protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION, workflowId: "workflow", agentId: "remote-agent" };
	const [ownerTransport, childTransport] = createInMemoryControlTransportPair();
	const owner = new FramedAgentControlChannel({ identity, protocol: agentControlProtocol, side: "owner", transport: ownerTransport });
	const child = new FramedAgentControlChannel({ identity, protocol: agentControlProtocol, side: "child", transport: childTransport });
	const events: ControlEvent<OwnerToChildControl>[] = [];
	child.onEvent((event) => { events.push(event); });
	serveOwnerParticipant(owner, handlers, new Set());
	t.after(() => Promise.all([owner.close(), child.close()]));
	return { child, events };
}

async function waitUntil(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 100; attempts += 1) {
		if (condition()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error("condition was not reached");
}
