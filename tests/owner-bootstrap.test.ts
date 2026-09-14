import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

test("Owner tool renderers are registered before session_start", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);

	for (const toolName of [
		"agent_spawn",
		"agent_message",
		"agent_observe",
		"agent_control",
	] as const) {
		const tool = host.session.getToolDefinition(toolName);
		assert.ok(tool, toolName);
		assert.equal(typeof tool.renderCall, "function", toolName);
		assert.equal(typeof tool.renderResult, "function", toolName);
	}
	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity",
			),
		false,
	);
	await host.runtime.dispose();
});

test("Owner bootstrap leaves native Runtime disposal under Pi ownership", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	const nativeDispose = host.runtime.dispose;

	await bindTestOwnerHost(host, "tui");

	assert.equal(host.runtime.dispose, nativeDispose);
	await host.runtime.dispose();
});

test("a fresh Owner Identity records its role description", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	await bindTestOwnerHost(host, "tui");

	const identity = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "custom" && entry.customType === "agent-coordination.identity",
	);
	assert.ok(identity?.type === "custom");
	assert.deepEqual((identity.data as { metadata: unknown }).metadata, {
		label: "Owner",
		description: "Workflow Owner",
	});
	await host.runtime.dispose();
});

test("startup-triggered Owner work waits for coordination admission", async (t) => {
	const startupBlock = createVoidDeferred();
	const startupBlockEntered = createVoidDeferred();
	const promptReachedStartBoundary = createVoidDeferred();
	const agentStarted = createVoidDeferred();
	let identityPresentAtAgentStart = false;
	let agentStartedBeforeOwnerAdmission = false;
	let ownerAdmissionReleased = false;
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		additionalExtensionFactories: [
			{
				name: "startup-user-message",
				hidden: true,
				factory(pi) {
					pi.on("session_start", () => {
						pi.sendUserMessage("Start work after every extension is ready.");
					});
					pi.on("session_start", async () => {
						startupBlockEntered.resolve();
						await startupBlock.promise;
					});
					pi.on("before_agent_start", () => {
						promptReachedStartBoundary.resolve();
					});
					pi.on("agent_start", (_event, ctx) => {
						agentStartedBeforeOwnerAdmission = !ownerAdmissionReleased;
						identityPresentAtAgentStart = ctx.sessionManager
							.getEntries()
							.some(
								(entry) =>
									entry.type === "custom" &&
									entry.customType === "agent-coordination.identity",
							);
						agentStarted.resolve();
					});
				},
			},
		],
	});

	const binding = bindTestOwnerHost(host, "tui");
	await startupBlockEntered.promise;
	await promptReachedStartBoundary.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	ownerAdmissionReleased = true;
	startupBlock.resolve();
	await binding;
	await agentStarted.promise;
	await host.session.waitForIdle();

	assert.equal(agentStartedBeforeOwnerAdmission, false);
	assert.equal(identityPresentAtAgentStart, true);
	await host.runtime.dispose();
});

test("an existing Owner Identity without a description is canonicalized without duplication", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	host.session.sessionManager.appendCustomEntry(
		"agent-coordination.identity",
		ownerIdentityFor(host),
	);

	await bindTestOwnerHost(host, "tui");

	const identityEntries = host.session.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom" && entry.customType === "agent-coordination.identity",
		);
	assert.equal(identityEntries.length, 1);
	assert.deepEqual(identityEntries[0]?.type === "custom" ? identityEntries[0].data : undefined, {
		...ownerIdentityFor(host),
		metadata: { label: "Owner" },
	});
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		"observe-canonical-owner-metadata",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.equal((status.details as { description?: string }).description, "Workflow Owner");
	assert.ok(host.session.getToolDefinition("agent_observe"));
	assert.ok(host.session.getToolDefinition("agent_control"));
	assert.equal(host.session.getToolDefinition("ask_user"), undefined);
	const ordinaryAgentExtensions = host.services.resourceLoader
		.getExtensions()
		.extensions.filter((extension) => extension.tools.has("agent_spawn"));
	assert.equal(ordinaryAgentExtensions.length, 1);
	assert.equal(ordinaryAgentExtensions[0]?.hidden, true);
	await host.runtime.dispose();
});

test("an Owner Identity repairs a stale id with a current bootstrap", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	const malformedIdentity = {
		...ownerIdentityFor(host),
		agentId: "stale-owner-id",
		workflowId: "stale-workflow-id",
		metadata: {
			label: "owner",
			description: "workflow owner",
			extra: "obsolete metadata",
		},
		configuration: { label: "owner" },
	};
	host.session.sessionManager.appendCustomEntry(
		"agent-coordination.identity",
		malformedIdentity,
	);

	await bindTestOwnerHost(host, "tui");

	assert.equal(host.ui.notifications.some(({ type }) => type === "error"), false);
	const identityEntries = host.session.sessionManager.getEntries().filter(
		(entry) =>
			entry.type === "custom" && entry.customType === "agent-coordination.identity",
	);
	assert.equal(identityEntries.length, 2);
	assert.deepEqual(
		identityEntries[0]?.type === "custom" ? identityEntries[0].data : undefined,
		malformedIdentity,
	);
	assert.deepEqual(
		identityEntries[1]?.type === "custom" ? identityEntries[1].data : undefined,
		{
			agentId: host.session.sessionId,
			workflowId: host.session.sessionId,
			directSpawnerAgentId: null,
			metadata: { label: "Owner", description: "Workflow Owner" },
		},
	);
	assert.ok(host.session.getActiveToolNames().includes("agent_observe"));

	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		"observe-repaired-owner-metadata",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.equal((status.details as { description: string }).description, "Workflow Owner");
	await host.runtime.dispose();
});

test("an Owner Identity repairs contradictory role metadata", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	host.session.sessionManager.appendCustomEntry("agent-coordination.identity", {
		...ownerIdentityFor(host),
		workflowId: "stale-workflow-id",
		metadata: {
			label: "unrelated role",
			description: "unrelated description",
		},
	});

	await bindTestOwnerHost(host, "tui");

	assert.equal(host.ui.notifications.some(({ type }) => type === "error"), false);
	assert.ok(host.session.getActiveToolNames().includes("agent_observe"));
	await host.runtime.dispose();
});

test("a Moderator bootstrap can recover through native /new", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	const failedSessionId = host.session.sessionId;
	host.session.sessionManager.appendCustomMessageEntry(
		"agent-coordination.moderator-input",
		"{}",
		true,
		{
			agentId: host.session.sessionId,
			workflowId: "workflow-owner",
			creationPreset: null,
			metadata: {
				label: "Moderator",
				description: "run failure",
			},
		},
	);

	await bindTestOwnerHost(host, "tui");

	assert.equal(
		host.ui.notifications.some(
			({ message, type }) =>
				type === "error" && message.includes("current Pi session is a Moderator"),
		),
		true,
	);
	assertOwnerToolsRegisteredButInactive(host);

	const replacement = await host.runtime.newSession();
	assert.deepEqual(replacement, { cancelled: false });
	assert.notEqual(host.runtime.session.sessionId, failedSessionId);
	assert.ok(host.runtime.session.getToolDefinition("agent_observe"));
	assert.ok(host.runtime.session.getActiveToolNames().includes("agent_observe"));

	await host.runtime.dispose();
});

test("a resumed Owner admits coordination evidence after its Identity cutoff", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("The self-addressed Message is available after restart."),
	]);
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "send",
					targetAgent: host.session.sessionId,
					content: "Persist legitimate current-scope coordination evidence.",
				},
				{ id: "owner-self-message-before-reopen" },
			),
			{ stopReason: "toolUse" },
		),
	);
	const message = host.session.getToolDefinition("agent_message");
	assert.ok(message);
	await message.execute(
		"owner-self-message-before-reopen",
		{
			operation: "send",
			targetAgent: host.session.sessionId,
			content: "Persist legitimate current-scope coordination evidence.",
		},
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	await host.session.waitForIdle();
	const sessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(sessionFile);
	await host.runtime.dispose();

	const reopened = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		cwd: host.cwd,
		agentDir: host.services.agentDir,
		sessionFile,
	});
	await bindTestOwnerHost(reopened, "tui");

	assert.ok(reopened.session.getToolDefinition("agent_observe"));
	assert.equal(
		reopened.ui.notifications.some(({ type }) => type === "error"),
		false,
	);
	await reopened.runtime.dispose();
});

test("resource reload rebinds the hidden Owner Agent extension", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	await bindTestOwnerHost(host, "tui");

	await host.session.reload();

	assert.ok(host.session.getToolDefinition("agent_spawn"));
	const ordinaryAgentExtensions = host.services.resourceLoader
		.getExtensions()
		.extensions.filter((extension) => extension.tools.has("agent_spawn"));
	assert.equal(ordinaryAgentExtensions.length, 1);
	assert.equal(ordinaryAgentExtensions[0]?.hidden, true);
	await host.runtime.dispose();
});

test("Owner prompts retain their prepared Template snapshot until resource reload", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	const templateDirectory = join(host.services.agentDir, "agents");
	const templatePath = join(templateDirectory, "delegate.md");
	await mkdir(templateDirectory, { recursive: true });
	await writeFile(templatePath, [
		"---",
		"name: first-delegate",
		"useWhen: Use the prepared first snapshot.",
		"---",
		"First context.",
	].join("\n"), "utf8");
	await bindTestOwnerHost(host, "tui");

	await writeFile(templatePath, [
		"---",
		"name: second-delegate",
		"useWhen: Use only after resource reload.",
		"---",
		"Second context.",
	].join("\n"), "utf8");
	let promptBeforeReload = "";
	host.model.setResponses([(context) => {
		promptBeforeReload = context.systemPrompt ?? "";
		return fauxAssistantMessage("Used the retained snapshot.");
	}]);
	await host.session.prompt("Inspect the prepared Agent Templates.");

	assert.match(promptBeforeReload, /first-delegate/);
	assert.doesNotMatch(promptBeforeReload, /second-delegate/);

	await host.session.reload();
	let promptAfterReload = "";
	host.model.setResponses([(context) => {
		promptAfterReload = context.systemPrompt ?? "";
		return fauxAssistantMessage("Used the refreshed snapshot.");
	}]);
	await host.session.prompt("Inspect the refreshed Agent Templates.");

	assert.match(promptAfterReload, /second-delegate/);
	assert.doesNotMatch(promptAfterReload, /first-delegate/);
});

test("an invalid initial Workflow Policy prevents coordination runtime creation", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	const policyPath = join(
		host.services.agentDir,
		"config",
		"pi-agent-coordination.json",
	);
	await mkdir(join(host.services.agentDir, "config"), { recursive: true });
	await writeFile(policyPath, '{"maxConcurrentAgentRuns": 0}', "utf8");

	await bindTestOwnerHost(host, "tui");

	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity",
			),
		false,
	);
	assertOwnerToolsRegisteredButInactive(host);
	assert.deepEqual(host.services.diagnostics, [
		{
			type: "error",
			message:
				"Workflow Policy maxConcurrentAgentRuns must be a positive safe integer",
		},
	]);
	await host.runtime.dispose();
});

test("an ambiguous public Owner extension fails before Identity commitment", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	const extensions = host.services.resourceLoader.getExtensions().extensions;
	const publicOwnerExtension = extensions.find((extension) =>
		extension.handlers.get("session_start")?.some(() => true),
	);
	assert.ok(publicOwnerExtension);
	extensions.push(publicOwnerExtension);

	await bindTestOwnerHost(host, "tui");

	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity",
			),
		false,
	);
	assertOwnerToolsRegisteredButInactive(host);
	assert.equal(
		host.ui.notifications.some(
			({ message, type }) =>
				type === "error" &&
				message.includes("cannot bind the Owner Agent extension"),
		),
		true,
	);
	extensions.pop();
	await host.runtime.dispose();
});

test("Owner reload publishes one prospective policy or preserves the prior snapshot", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	const policyDirectory = join(host.services.agentDir, "config");
	const policyPath = join(policyDirectory, "pi-agent-coordination.json");
	await mkdir(policyDirectory, { recursive: true });
	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 1}', "utf8");
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("Remain held so Workflow Policy reload can be observed."),
	]);

	const spawned = await executeOwnerTool(host, "agent_spawn", "spawn-policy-child", {
		title: "Fixture request",
		request: "Remain available for prospective delivery-capacity checks.",
	});
	const childAgentId = (spawned as { agentId: string }).agentId;
	await executeOwnerTool(host, "agent_control", "hold-policy-child", {
		operation: "interrupt",
		agentId: childAgentId,
	});
	const first = await executeOwnerTool(host, "agent_message", "first-policy-message", {
		operation: "send",
		targetAgent: childAgentId,
		content: "Occupy the initial policy capacity.",
	});
	assert.equal((first as { messageStatus: string }).messageStatus, "sent");
	const initiallyRejected = await executeOwnerTool(
		host,
		"agent_message",
		"initially-rejected-policy-message",
		{
			operation: "send",
			targetAgent: childAgentId,
			content: "Remain canonical after initial capacity rejection.",
		},
	);
	assert.equal(
		(initiallyRejected as { reason: string }).reason,
		"capacity_exhausted",
	);

	const transcriptBeforeReload = structuredClone(host.session.sessionManager.getEntries());
	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 2}', "utf8");
	await host.session.reload();
	assert.deepEqual(host.session.sessionManager.getEntries(), transcriptBeforeReload);
	const admittedAfterRaise = await executeOwnerTool(
		host,
		"agent_message",
		"admitted-after-policy-raise",
		{
			operation: "send",
			targetAgent: childAgentId,
			content: "Use the newly published second slot.",
		},
	);
	assert.equal((admittedAfterRaise as { messageStatus: string }).messageStatus, "sent");

	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 0}', "utf8");
	await host.session.reload();
	assert.equal(
		host.services.diagnostics.at(-1)?.message,
		"Workflow Policy maxPendingDeliveriesPerAgent must be a positive safe integer",
	);
	const rejectedAfterInvalidReload = await executeOwnerTool(
		host,
		"agent_message",
		"rejected-after-invalid-policy-reload",
		{
			operation: "send",
			targetAgent: childAgentId,
			content: "The preserved two-slot snapshot remains exhausted.",
		},
	);
	assert.equal(
		(rejectedAfterInvalidReload as { reason: string }).reason,
		"capacity_exhausted",
	);

	await host.runtime.dispose();
});

test("a valid child Identity is not reclassified as Workflow Owner", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	host.session.sessionManager.appendCustomEntry("agent-coordination.identity", {
		...ownerIdentityFor(host),
		workflowId: "workflow-owner",
		directSpawnerAgentId: "direct-spawner",
		creationPreset: null,
		spawnSource: {
			agentId: "direct-spawner",
			entryId: "assistant-entry",
			toolCallId: "spawn-call",
		},
	});

	await bindTestOwnerHost(host, "tui");
	assert.equal(
		host.ui.notifications.some(
			({ message, type }) =>
				type === "error" && message.includes("current Pi session is a child Agent"),
		),
		true,
	);
	assertOwnerToolsRegisteredButInactive(host);
	assert.equal(host.session.extensionRunner.getCommand("agents"), undefined);
	host.model.setResponses([fauxAssistantMessage("Child prompt completed.")]);
	await host.session.prompt("Continue as the existing child Agent.");
	assert.equal(
		host.ui.notifications.some(({ message }) =>
			message.includes("Owner Workflow is not admitted")
		),
		false,
	);
	await host.runtime.dispose();
});

test("a Moderator bootstrap cannot be reclassified as Workflow Owner", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	host.session.sessionManager.appendCustomMessageEntry(
		"agent-coordination.moderator-input",
		"{}",
		true,
		{
			agentId: host.session.sessionId,
			workflowId: "workflow-owner",
			creationPreset: null,
			metadata: {
				label: "Moderator",
				description: "run failure",
			},
		},
	);

	await bindTestOwnerHost(host, "tui");
	assert.equal(
		host.ui.notifications.some(
			({ message, type }) =>
				type === "error" && message.includes("current Pi session is a Moderator"),
		),
		true,
	);
	assertOwnerToolsRegisteredButInactive(host);
	assert.equal(host.session.extensionRunner.getCommand("agents"), undefined);
	await host.runtime.dispose();
});

function createVoidDeferred(): Readonly<{
	promise: Promise<void>;
	resolve(): void;
}> {
	let resolvePromise: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function assertOwnerToolsRegisteredButInactive(host: TestOwnerHost): void {
	for (const toolName of [
		"agent_spawn",
		"agent_message",
		"agent_observe",
		"agent_control",
	] as const) {
		assert.equal(typeof host.session.getToolDefinition(toolName)?.renderResult, "function");
		assert.equal(host.session.getActiveToolNames().includes(toolName), false);
	}
}

function ownerIdentityFor(host: TestOwnerHost) {
	return {
		agentId: host.session.sessionId,
		workflowId: host.session.sessionId,
		directSpawnerAgentId: null,
		metadata: { label: "Owner" },
	} as const;
}

async function executeOwnerTool(
	host: TestOwnerHost,
	toolName: "agent_spawn" | "agent_control" | "agent_message",
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(toolName, input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const tool = host.session.getToolDefinition(toolName);
	assert.ok(tool);
	const result = await tool.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return result.details;
}

test("invalid committed Owner Request is contained with persistent diagnostics after startup and reload", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	const { callId, entryId } = appendInvalidOwnerRequest(host.session.sessionManager);
	await bindTestOwnerHost(host, "tui");
	for (const phase of ["startup", "reload"]) {
		if (phase === "reload") await host.session.reload();
		assertOwnerToolsRegisteredButInactive(host);
		assert.deepEqual(host.ui.notifications.filter(({ type }) => type === "error"), [], phase);
		const widget = host.ui.widgets.get("agent-coordination.blockage");
		assert.ok(widget, phase);
		const widgetText = Array.isArray(widget) ? widget.join("\n") : (widget as { render(width: number): string[] }).render(100).join("\n");
		assert.match(widgetText, /Subagent coordination blocked/);
		assert.match(widgetText, /\/agents diagnostics/);
		assert.doesNotMatch(widgetText, /\/fork/);
		const command = host.session.extensionRunner.getCommand("agents");
		assert.ok(command);
		const opened = command.handler("diagnostics", host.session.extensionRunner.createContext() as Parameters<typeof command.handler>[1]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const panel = host.ui.customSurfaces.at(-1);
		assert.ok(panel);
		const summary = panel.render(120).join("\n");
		assert.match(summary, /Problem/);
		assert.match(summary, /title/);
		assert.match(summary, /Recovery/);
		assert.match(summary, /unavailable/);
		assert.doesNotMatch(summary, /at authoredFacts/);
		assert.doesNotMatch(summary, /cleanup also failed/);
		panel.handleInput?.("t");
		const technical = panel.render(200).join("\n");
		assert.match(technical, new RegExp(entryId));
		assert.match(technical, new RegExp(callId));
		assert.match(technical, /Transcript:/);
		panel.handleInput?.("q");
		await opened;
	}
	await host.runtime.dispose();
});

function appendInvalidOwnerRequest(sessionManager: SessionManager) {
	sessionManager.appendCustomEntry("agent-coordination.identity", { agentId: sessionManager.getSessionId(), workflowId: sessionManager.getSessionId(), directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } });
	const callId = "accepted-request-missing-title";
	const entryId = sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: "helper", question: "A previously accepted Request",
	}, { id: callId }), { stopReason: "toolUse" }));
	sessionManager.appendMessage({
		role: "toolResult", toolName: "agent_message", toolCallId: callId,
		content: [{ type: "text", text: "sent" }],
		details: { requestMessageId: "historical-request", targetAgentId: "helper", messageStatus: "sent" },
		isError: false, timestamp: Date.now(),
	});
	return { callId, entryId };
}

test("resuming an invalid Owner in-process keeps diagnostics and native conversation usable", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const target = SessionManager.create(host.cwd, join(host.cwd, "invalid-owner-session"));
	appendInvalidOwnerRequest(target);
	assert.deepEqual(await host.runtime.switchSession(target.getSessionFile()!), { cancelled: false });
	assert.deepEqual(host.ui.notifications.filter(({ type }) => type === "error"), []);
	assert.ok(host.ui.widgets.has("agent-coordination.blockage"));
	assert.ok(host.runtime.session.extensionRunner.getCommand("agents"));
	assert.equal(host.runtime.session.getActiveToolNames().includes("agent_message"), false);
	host.model.setResponses([fauxAssistantMessage("Native conversation still works.")]);
	await host.runtime.session.prompt("Continue ordinary conversation, not coordination.");
	assert.equal(host.runtime.session.isStreaming, false);
	assert.deepEqual(host.ui.notifications.filter(({ type }) => type === "error"), []);
	await host.runtime.dispose();
});

test("plain agents reports unavailability without implicitly opening diagnostics", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	appendInvalidOwnerRequest(host.session.sessionManager);
	await bindTestOwnerHost(host, "tui");
	const command = host.session.extensionRunner.getCommand("agents")!;
	const handled = command.handler("", host.session.extensionRunner.createContext() as Parameters<typeof command.handler>[1]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		assert.equal(host.ui.customSurfaces.length, 0);
		assert.deepEqual(host.ui.notifications.at(-1), {
			message: "Subagent coordination is unavailable. Use /agents diagnostics.", type: "warning",
		});
	} finally {
		host.ui.customSurfaces.at(-1)?.handleInput?.("q");
		await handled;
		await host.runtime.dispose();
	}
});
