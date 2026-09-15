import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import {
	participantCoordinatorHandlers,
	registerOrdinaryAgentSurfaces,
} from "../src/tools/owner-surfaces.ts";
import {
	participantCoordinationToolSchemas,
	registerParticipantCoordinationTools,
	type ParticipantCoordinationRole,
	type ParticipantCoordinationToolHandlers,
} from "../src/tools/participant-coordination-tools.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import {
	renderAgentTemplatePromptGuide,
} from "../src/tools/agent-template-prompt-guide.ts";
import {
	createTestOwnerHost,
	type TestCleanupRegistrar,
	type TestOwnerHost,
} from "./support/pi-host.ts";

import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
import { inspectAgentMessageAuthorResult } from "../src/protocol/message.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";

test("registered Answer results remain canonical with and without other obligations", { timeout: 5_000 }, async (t) => {
	for (const remaining of [null, "remaining-request"]) {
		await t.test(remaining ?? "no remaining Request", async (t) => {
			const requestSource = { agentId: "requester", entryId: "request", toolCallId: "request" };
			const requestId = deriveMessageIdentity(requestSource);
			let receipt: { messageId: string; requestMessageId: string; requestTitle: string; messageStatus: "sent" };
			const host = await createRegistrarHost(t, "ordinary", {
				...handlers,
				async message() { return receipt; },
			});
			const manager = host.session.sessionManager;
			const agentId = manager.getSessionId();
			manager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId });
			const requestSources = [...(remaining ? [{ ...requestSource, toolCallId: remaining }] : []), requestSource];
			const delivery = createMessageDelivery(requestSources.map(source => ({ source, projection: {
				kind: "request", requestMessageId: deriveMessageIdentity(source), fromAgentId: source.agentId,
				title: "Fixture request", question: "Finish the Request.",
			} })));
			manager.appendCustomMessageEntry(delivery.customType, delivery.content, true, delivery.details);
			const input = { operation: "answer" as const, requestId, answer: "Done." };
			const toolCallId = "answer-result-roundtrip";
			const entryId = manager.appendMessage(fauxAssistantMessage(
				fauxToolCall("agent_message", input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			));
			const source = { agentId, entryId, toolCallId };
			receipt = { requestTitle: "Fixture request", messageId: deriveMessageIdentity(source), requestMessageId: requestId, messageStatus: "sent" };
			const result = await executeTool(host, "agent_message", toolCallId, input);
			assert.equal(result.terminate, true);
			assert.deepEqual(result.details, receipt, "Answer uses the unmodified standard messaging receipt");
			manager.appendMessage({
				role: "toolResult", toolName: "agent_message", toolCallId,
				content: result.content, details: result.details, isError: false, timestamp: Date.now(),
			});
			assert.equal(inspectAgentMessageAuthorResult({
				authorAgentId: agentId, transcript: transcriptFromSessionManager(manager).inspect(),
				source, input, requestId, requestTitle: "Fixture request",
			}), "canonical");
		});
	}
});

const roleToolNames = {
	ordinary: [
		"agent_control",
		"agent_message",
		"agent_observe",
		"agent_wait",
		"agent_spawn",
		"ask_user",
	],
	moderator: [
		"agent_control",
		"agent_message",
		"agent_observe",
		"agent_wait",
		"ask_user",
		"moderator_control",
		"report_to_user",
	],
	owner: [
		"workflow_resume",
		"agent_control",
		"agent_message",
		"agent_observe",
		"agent_wait",
		"agent_spawn",
	],
} as const;

const agentStatus = {
	agentId: "child-agent",
	workflowId: "workflow",
	label: "Child",
	directSpawnerAgentId: "owner",
	primaryEvidence: {
		transcriptPath: null,
		inspectedThrough: { agentId: "child-agent", entryId: "entry-1" },
	},
	run: { phase: "dormant", retentionReasons: [] },
} as const;

const handlers: ParticipantCoordinationToolHandlers<"ordinary"> &
	ParticipantCoordinationToolHandlers<"moderator"> &
	ParticipantCoordinationToolHandlers<"owner"> = {
	async resumeWorkflow() { return { workflowId: "workflow", outstandingRequests: [] }; },
	async message() {
		return {
			messageId: "message-1",
			targetAgentId: "child-agent",
			messageStatus: "sent",
		};
	},
	async wait() {
		return { answers: [] };
	},
	async spawn() {
		return {
			spawnStatus: "not_created",
			failedStage: "identity_commit",
			reason: "Test child was not created",
		};
	},
	async agentTemplateSnapshot() {
		return {
			templates: [],
		};
	},
	async observe() {
		return agentStatus;
	},
	async control() {
		return { agentId: "child-agent", disposition: "not_running" };
	},
	async askUser() {
		return { requestId: "request-1", answer: "Answer" };
	},
	async reportToUser() { return { reportId: "report-1", createdAt: "2026-01-01T00:00:00.000Z" }; },
	async moderatorControl() {
		return { disposition: "resolved" };
	},
};

test("participant registrar exposes the exact closed sequential role tool sets", async (t) => {
	for (const role of ["ordinary", "moderator", "owner"] as const) {
		await t.test(role, async (t) => {
			const host = await createRegistrarHost(t, role, handlers);
			assert.deepEqual(
				host.session.getActiveToolNames().sort(),
				[...roleToolNames[role]].sort(),
			);
			for (const toolName of roleToolNames[role]) {
				const tool = host.session.getToolDefinition(toolName);
				assert.ok(tool, toolName);
				assert.equal(tool.executionMode, "sequential", toolName);
				assert.equal(tool.parameters, participantCoordinationToolSchemas[toolName]);
				assertClosedTypeBoxObjects(tool.parameters, toolName);
				assert.equal(typeof tool.renderCall, "function", toolName);
				assert.equal(typeof tool.renderResult, "function", toolName);
			}
			assert.equal(host.session.extensionRunner.getCommand("agents"), undefined);
			await host.runtime.dispose();
		});
	}
});

test("Workflow resume accepts only the current Workflow's parameterless Owner operation", () => {
	const schema = participantCoordinationToolSchemas.workflow_resume;
	assert.equal(Value.Check(schema, {}), true);
	assert.equal(Value.Check(schema, { workflowId: "other" }), false);
	assert.equal(Value.Check(schema, { agentId: "child" }), false);
});

test("Agent Message schema requires explicit Answer and Cancellation targets", () => {
	const variants = (participantCoordinationToolSchemas.agent_message as {
		anyOf: Array<{ properties: Record<string, { const?: string }> }>;
	}).anyOf;
	const answer = variants.find(({ properties }) =>
		properties.operation?.const === "answer"
	);
	assert.ok(answer);
	assert.deepEqual(Object.keys(answer.properties).sort(), ["answer", "operation", "requestId"]);

	const cancellation = variants.find(({ properties }) =>
		properties.operation?.const === "cancel"
	);
	assert.ok(cancellation);
	assert.equal("requestMessageId" in cancellation.properties, true);
	assert.equal("requestId" in cancellation.properties, false);

	for (const operation of ["send", "request"]) {
		const targetVariant = variants.find(({ properties }) =>
			properties.operation?.const === operation
		);
		assert.ok(targetVariant);
		assert.equal("targetAgent" in targetVariant.properties, true);
		assert.equal("targetAgentId" in targetVariant.properties, false);
	}
});

test("Agent Wait accepts all outbound Requests or a non-empty Request selection", () => {
	const schema = participantCoordinationToolSchemas.agent_wait;
	assert.equal(Value.Check(schema, {}), true);
	assert.equal(Value.Check(schema, {
		requestMessageIds: ["request-a"],
	}), true);
	for (const input of [{ requestMessageIds: [] }, { requestMessageIds: [""] },
		{ requestMessageIds: "request-a" }, { requestMessageIds: [7] }, { unknown: true }]) {
		assert.equal(Value.Check(schema, input), false);
	}
});

test("Agent Observe schema describes omitted status identity as self-observation", () => {
	const variants = (participantCoordinationToolSchemas.agent_observe as {
		anyOf: Array<{
			properties: Record<string, { const?: string; description?: string }>;
		}>;
	}).anyOf;
	const status = variants.find(({ properties }) =>
		properties.operation?.const === "status"
	);
	assert.ok(status);
	assert.equal(
		status.properties.agentId?.description,
		"Agent to observe. Omit to observe the calling Agent.",
	);
});

test("Agent Observe request schema documents full inspection including closed Requests", () => {
	const variants = (participantCoordinationToolSchemas.agent_observe as {
		anyOf: Array<{
			properties: Record<string, { const?: string; description?: string }>;
		}>;
	}).anyOf;
	const request = variants.find(({ properties }) =>
		properties.operation?.const === "request"
	);
	assert.ok(request);
	assert.equal(
		request.properties.requestId?.description,
		"Full Request ID or unique suffix among Requests you authored or received, including closed Requests. Returns the complete Request body.",
	);
});

test("Agent Observe schema composes authorized and direct-child search filters", () => {
	const schema = participantCoordinationToolSchemas.agent_observe;
	assert.equal(Value.Check(schema, { operation: "status" }), true);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "direct_children",
	}), true);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: { directSpawnerAgentId: "parent-agent" },
		query: "review",
		agentIdSuffix: "a1b2c3d4",
		phase: "dormant",
		limit: 50,
	}), true);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "authorized",
		phase: "live",
	}), true);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "authorized",
	}), false);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "authorized",
		query: " ",
	}), false);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: { directSpawnerAgentId: " " },
	}), false);
	assert.equal(Value.Check(schema, {
		operation: "children",
	}), false);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "direct_children",
		limit: 51,
	}), false);
});

test("Agent Spawn schema accepts isolated children and rejects extension path arrays", () => {
	const schema = participantCoordinationToolSchemas.agent_spawn;
	assert.equal(schema.type, "object");
	assert.equal("anyOf" in schema, false);
	assert.equal("allOf" in schema, false);
	assert.deepEqual(schema.required, ["title", "request"]);
	assert.equal("conversation" in schema.properties, false);
	assert.equal(Reflect.get(schema.properties.description, "description"),
		"Brief scope summary for display and Agent search; not task instructions.");
	// Isolated children support independent Template/configuration selection.
	for (const configuration of [
		{},
		{ template: "reviewer" },
		{ config: { allowedTools: ["read"] } },
		{ template: "reviewer", config: { allowedTools: ["read"] } },
	]) {
		assert.equal(Value.Check(schema, {
			title: "Fixture request",
			request: "Continue the completed conversation.",
			...configuration,
		}), true);
	}
	assert.equal(Value.Check(schema, {
		title: "Fixture request",
		request: "Do not accept unknown conversation modes.",
		conversation: "fork",
	}), false);
	assert.equal(Value.Check(schema, {
		title: "Fixture request",
		request: "Inspect the child Runtime.",
		config: { extensions: "inherit" },
	}), true);
	assert.equal(Value.Check(schema, {
		title: "Fixture request",
		request: "Inspect the child Runtime.",
		config: { extensions: ["/extensions/arbitrary.ts"] },
	}), false);
});

test("Template catalogue shows available Template configuration without Runtime guidance", () => {
	const catalogue = renderAgentTemplatePromptGuide({
		templates: [
		{
			name: "integration-researcher",
			useWhen: "Use for integration research requiring primary sources.",
			models: [
				{
					model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
					thinking: "high",
				},
				{
					model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
					thinking: "medium",
				},
			],
			allowedTools: ["read", "bash"],
			skills: ["research"],
			extensions: "none",
			systemPromptMode: "replace",
			loadContextFiles: false,
		},
		{
			name: "plain-agent",
			systemPromptMode: "append",
			loadContextFiles: true,
		},
		],
	});

	assert.match(catalogue ?? "", /integration-researcher/);
	assert.match(catalogue ?? "", /Use for integration research requiring primary sources\./);
	assert.match(catalogue ?? "", /^## Available Agent Templates Snapshot/);
	assert.match(catalogue ?? "", /  model: anthropic\/claude-sonnet-4-5\n  thinking: high/);
	assert.doesNotMatch(catalogue ?? "", /deepseek\/deepseek-v4-flash/);
	assert.doesNotMatch(catalogue ?? "", /models:|snapshot:/);
	assert.doesNotMatch(catalogue ?? "", /explains when to choose/);
	assert.match(catalogue ?? "", /systemPromptMode: replace/);
	assert.match(catalogue ?? "", /- name: plain-agent\n  systemPromptMode: append/);
	assert.doesNotMatch(catalogue, /Current Agent Runtime/);
	assert.doesNotMatch(catalogue, /current\/model/);
	assert.doesNotMatch(catalogue, /use `inherit`/);
});

test("Message guidance keeps obligations separate from deliveryMode parameter rules", async (t) => {
	const host = await createRegistrarHost(t, "ordinary", handlers);
	const message = host.session.getToolDefinition("agent_message");
	assert.ok(message);
	const guidance = message.promptGuidelines?.join("\n") ?? "";
	assert.match(guidance, /creates one Answer obligation/);
	assert.match(guidance, /attention, not execution order/);
	const legend = "History marks: `!` invalid, `^` inherited. Both are informational; neither cancels an existing obligation.";
	assert.equal(guidance.split(legend).length - 1, 1);
	assert.match(guidance, /committed.*omitted/);
	assert.doesNotMatch(guidance, /FIFO|may starve|Background Messages and Requests|Deferred Requests enter/);
});

test("Agent Spawn prompt guideline exposes the prepared Runtime Template catalogue", async (t) => {
	let observedSystemPrompt = "";
	const templateSnapshot = {
		templates: [{
			name: "integration-researcher",
			useWhen: "Use for integration research.",
			models: [{
				model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				thinking: "high" as const,
			}],
			systemPromptMode: "append" as const,
			loadContextFiles: true,
		}],
	};
	const host = await createTestOwnerHost(t, (pi) => {
		registerParticipantCoordinationTools(
			pi,
			"owner",
			handlers,
			undefined,
			templateSnapshot,
		);
	});
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	assert.equal(
		spawn.promptGuidelines?.some((guideline) =>
			guideline.includes("integration-researcher")
		),
		true,
	);
	host.model.setResponses([(context) => {
		observedSystemPrompt = context.systemPrompt ?? "";
		return fauxAssistantMessage("Done.");
	}]);

	await host.session.prompt("Choose an Agent Template if appropriate.");
	assert.match(observedSystemPrompt, /## Available Agent Templates Snapshot/);
	assert.match(observedSystemPrompt, /integration-researcher/);
	assert.match(observedSystemPrompt, /  model: anthropic\/claude-sonnet-4-5\n  thinking: high/);
	await host.runtime.dispose();
});

test("participant registrar contributes each prompt guide once", async (t) => {
	let observedSystemPrompt = "";
	const host = await createRegistrarHost(t, "ordinary", handlers);

	host.model.setResponses([(context) => {
		observedSystemPrompt = context.systemPrompt ?? "";
		return fauxAssistantMessage("Done.");
	}]);

	await host.session.prompt("Inspect the Agent tool guidance.");
	for (const tag of [
		"agent_message",
		"agent_delegation",
		"agent_wait",
		"agent_spawn",
		"agent_observe",
		"agent_control",
	]) {
		const blocks = observedSystemPrompt.match(
			new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"),
		);
		assert.equal(blocks?.length, 1, tag);
	}
	await host.runtime.dispose();
});

test("participant registrar preserves role-specific tool presentation metadata", async (t) => {
	const ordinary = await createRegistrarHost(t, "ordinary", handlers);
	const moderator = await createRegistrarHost(t, "moderator", handlers);
	const owner = await createRegistrarHost(t, "owner", handlers);

	assert.deepEqual(toolMetadata(ordinary, "agent_message"), {
		label: "Message Agent",
		description:
			"Send one immutable Message or correlated Request to a known Agent in this Workflow.",
		promptSnippet: "Send, request, answer, cancel, poll, or retry direct Agent communication.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_wait"), {
		label: "Wait for Answers",
		description:
			"Join all or selected outstanding outbound Requests' Answers. Renew missing Request delivery scheduling without duplicates; primary human input or eligible inbound delivery may preempt.",
		promptSnippet:
			"Wait for all your outstanding outbound Requests, or select requestMessageIds by full ID or unique suffix.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_spawn"), {
		label: "Spawn Agent",
		description:
			"Create one fresh durable child Agent with isolated context, then deliver its initial Creation Request.",
		promptSnippet:
			"Create a fresh child Agent with isolated context.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_observe"), {
		label: "Observe Agent",
		description: "Passively observe authorized Agents, search their metadata, or inspect your Request obligations.",
		promptSnippet: "Observe Agent status/search and inspect Request obligations.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(moderator, "agent_observe"), {
		label: "Observe Agent",
		description:
			"Passively observe Workflow Agents, search authorized Agent scopes, or inspect your Request obligations.",
		promptSnippet:
			"Pull Agent status/search results and inspect Request obligations.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_control"), {
		label: "Control Agent Run",
		description:
			"Interrupt, explicitly resume, or terminate one authorized exact Agent Run.",
		promptSnippet:
			"Supervise an immediate child Run, or any non-Owner Run when acting as Workflow Owner.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(moderator, "agent_control"), {
		label: "Control Agent Run",
		description:
			"Interrupt, explicitly resume, or terminate one authorized exact Agent Run.",
		promptSnippet: "Supervise any current non-Owner Run needed to restore safe progress.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "ask_user"), {
		label: "Ask User",
		description:
			"Ask the human one nonblank free-form question and wait for one nonblank free-form Answer.",
		promptSnippet:
			"Block until the human supplies judgment through this Agent's native editor.",
		renderShell: "self",
	});
	assert.deepEqual(toolMetadata(moderator, "moderator_control"), {
		label: "Control Moderation",
		description:
			"Renew an exact Operation Review interval or resolve handling after every mechanically checkable predicate clears. A Run Failure clears as soon as a successor Run starts; any remaining Answer Obligation is ordinary Workflow work.",
		promptSnippet:
			"Renew an exact reviewed call deliberately, or resolve immediately when the original condition clears.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(owner, "agent_observe"), toolMetadata(ordinary, "agent_observe"));

	await Promise.all([
		ordinary.runtime.dispose(),
		moderator.runtime.dispose(),
		owner.runtime.dispose(),
	]);
});

test("participant registrar routes intents and returns exact handler receipts", async (t) => {
	const calls: unknown[] = [];
	const updates: unknown[] = [];
	const waitProgress = {
		waitingFor: [{
			requestTitle: "Fixture request",
			requestMessageId: "request-waiting",
			responderAgentId: "child-agent",
		}],
	} as const;
	const messageReceipt = {
		messageId: "message-2",
		targetAgentId: "child-agent",
		messageStatus: "sent",
	} as const;
	const waitReceipt = { answers: [] } as const;
	const spawnReceipt = {
		spawnStatus: "not_created",
		failedStage: "identity_commit",
		reason: "Test child was not created",
	} as const;
	const observeReceipt = { matches: [agentStatus], hasMore: false } as const;
	const controlReceipt = { agentId: "child-agent", disposition: "held" } as const;
	const humanReceipt = { requestId: "human-1", answer: "Proceed." } as const;
	const signal = new AbortController().signal;
	const routedHandlers: ParticipantCoordinationToolHandlers<"ordinary"> = {
		async message(toolCallId, input) {
			calls.push(["message", toolCallId, input]);
			return messageReceipt;
		},
		async wait(toolCallId, input, receivedSignal, onProgress) {
			calls.push(["wait", toolCallId, input, receivedSignal]);
			onProgress?.(waitProgress);
			return waitReceipt;
		},
		async spawn(toolCallId, input) {
			calls.push(["spawn", toolCallId, input]);
			return spawnReceipt;
		},
		async agentTemplateSnapshot() {
			return handlers.agentTemplateSnapshot();
		},
		async observe(input) {
			calls.push(["observe", input]);
			return observeReceipt;
		},
		async control(toolCallId, input) {
			calls.push(["control", toolCallId, input]);
			return controlReceipt;
		},
		async askUser(toolCallId, input, receivedSignal) {
			calls.push(["ask", toolCallId, input, receivedSignal]);
			return humanReceipt;
		},
	};
	const host = await createRegistrarHost(t, "ordinary", routedHandlers);
	const samples = [
		["agent_message", "call-message", { operation: "poll", messageId: "message-1" }, messageReceipt],
		["agent_wait", "call-wait", {}, waitReceipt],
		["agent_spawn", "call-spawn", { title: "Fixture request", request: "Investigate." }, spawnReceipt],
		[
			"agent_observe",
			"call-observe",
			{ operation: "search", scope: "direct_children" },
			observeReceipt,
		],
		["agent_control", "call-control", { operation: "interrupt", agentId: "child-agent" }, controlReceipt],
		["ask_user", "call-human", { question: "Proceed?" }, humanReceipt],
	] as const;
	for (const [toolName, toolCallId, input, receipt] of samples) {
		const result = await executeTool(
			host,
			toolName,
			toolCallId,
			input,
			signal,
			toolName === "agent_wait" ? (update) => updates.push(update) : undefined,
		);
		assert.equal(result.details, receipt, toolName);
		assert.deepEqual(result.content, [
			{ type: "text", text: JSON.stringify(receipt) },
		], toolName);
	}
	assert.deepEqual(updates, [{
		content: [{ type: "text", text: "Waiting for 1 Agent Answer." }],
		details: waitProgress,
	}]);
	assert.deepEqual(calls, [
		["message", "call-message", samples[0][2]],
		["wait", "call-wait", samples[1][2], signal],
		["spawn", "call-spawn", samples[2][2]],
		["observe", samples[3][2]],
		["control", "call-control", samples[4][2]],
		["ask", "call-human", samples[5][2], signal],
	]);
	await host.runtime.dispose();
});

test("participant registrar preserves handler errors and Moderator control routing", async (t) => {
	const failure = new Error("exact coordinator rejection");
	const moderatorReceipt = { disposition: "resolved" } as const;
	let moderatorCall: unknown;
	const moderatorHandlers: ParticipantCoordinationToolHandlers<"moderator"> = {
		...handlers,
		async control() {
			throw failure;
		},
		async moderatorControl(toolCallId, input) {
			moderatorCall = [toolCallId, input];
			return moderatorReceipt;
		},
	};
	const host = await createRegistrarHost(t, "moderator", moderatorHandlers);
	await assert.rejects(
		executeTool(
			host,
			"agent_control",
			"call-failure",
			{ operation: "terminate", agentId: "child-agent" },
		),
		(error) => error === failure,
	);
	const input = {
		operation: "resolve",
		summary: "Progress restored.",
		rationale: "The exact predicate cleared.",
	} as const;
	const result = await executeTool(host, "moderator_control", "call-moderator", input);
	assert.deepEqual(moderatorCall, ["call-moderator", input]);
	assert.equal(result.details, moderatorReceipt);
	assert.deepEqual(result.content, [
		{ type: "text", text: JSON.stringify(moderatorReceipt) },
	]);
	await host.runtime.dispose();
});

test("ordinary participant snapshot requests refresh the retained Runtime snapshot", async () => {
	const preparedSnapshot = { templates: [] };
	const refreshedSnapshot = {
		templates: [{
			name: "reloaded-template",
			systemPromptMode: "append" as const,
			loadContextFiles: true,
		}],
	};
	let refreshCount = 0;
	const view = {
		agentTemplateSnapshot: () => preparedSnapshot,
		async refreshAgentTemplateSnapshot() {
			refreshCount += 1;
			return refreshedSnapshot;
		},
	} as unknown as OrdinaryAgentCoordinatorView;
	const routed = participantCoordinatorHandlers("ordinary", () => view);

	assert.equal(await routed.agentTemplateSnapshot(true), refreshedSnapshot);
	assert.equal(refreshCount, 1);
});

test("ordinary surface composes its prepared Template snapshot and /agents with the participant registrar", async (t) => {
	const direct = await createRegistrarHost(t, "ordinary", handlers);
	const preparedView = () => ({
		agentTemplateSnapshot: () => ({
			templates: [],
		}),
	}) as unknown as OrdinaryAgentCoordinatorView;
	const composed = await createTestOwnerHost(t, (pi) => {
		registerOrdinaryAgentSurfaces(pi, preparedView);
	});

	assert.ok(composed.session.extensionRunner.getCommand("agents"));
	assert.deepEqual(
		composed.session.getActiveToolNames().sort(),
		[...roleToolNames.ordinary].sort(),
	);
	for (const toolName of roleToolNames.ordinary) {
		const directTool = direct.session.getToolDefinition(toolName);
		const composedTool = composed.session.getToolDefinition(toolName);
		assert.ok(directTool, toolName);
		assert.ok(composedTool, toolName);
		assert.equal(composedTool.parameters, directTool.parameters, toolName);
		assert.equal(typeof composedTool.renderCall, typeof directTool.renderCall, toolName);
		assert.equal(typeof composedTool.renderResult, typeof directTool.renderResult, toolName);
	}

	await Promise.all([direct.runtime.dispose(), composed.runtime.dispose()]);
});

async function createRegistrarHost<Role extends ParticipantCoordinationRole>(
	t: TestCleanupRegistrar,
	role: Role,
	roleHandlers: ParticipantCoordinationToolHandlers<Role>,
): Promise<TestOwnerHost> {
	return createTestOwnerHost(t, (pi: ExtensionAPI) => {
		registerParticipantCoordinationTools(pi, role, roleHandlers);
	});
}

async function executeTool(
	host: TestOwnerHost,
	toolName: string,
	toolCallId: string,
	input: unknown,
	signal?: AbortSignal,
	onUpdate?: (update: unknown) => void,
) {
	const tool = host.session.getToolDefinition(toolName);
	assert.ok(tool, toolName);
	return tool.execute(
		toolCallId,
		input,
		signal,
		onUpdate,
		host.session.extensionRunner.createContext(),
	);
}

function toolMetadata(host: TestOwnerHost, toolName: string) {
	const tool = host.session.getToolDefinition(toolName);
	assert.ok(tool, toolName);
	return {
		label: tool.label,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		renderShell: tool.renderShell,
	};
}

function assertClosedTypeBoxObjects(schema: unknown, path: string): void {
	if (typeof schema !== "object" || schema === null) return;
	const node = schema as {
		type?: unknown;
		additionalProperties?: unknown;
		anyOf?: unknown[];
		properties?: Record<string, unknown>;
		items?: unknown;
	};
	if (node.type === "object") {
		assert.equal(node.type, "object", path);
		if (!node.anyOf) assert.equal(node.additionalProperties, false, path);
	}
	for (const [index, variant] of (node.anyOf ?? []).entries()) {
		assertClosedTypeBoxObjects(variant, `${path}.anyOf[${index}]`);
	}
	for (const [property, child] of Object.entries(node.properties ?? {})) {
		assertClosedTypeBoxObjects(child, `${path}.${property}`);
	}
	if (node.items) assertClosedTypeBoxObjects(node.items, `${path}.items`);
}
