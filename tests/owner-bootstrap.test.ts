import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type JsonObject,
	type JsonValue,
} from "@earendil-works/pi-ai";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { readWorkflowPolicy } from "../src/policy/workflow-policy.ts";

import { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import piAgentCoordination from "../src/index.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
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

	assertBlockedAdmission(host, /current Pi session is a Moderator/);
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

test("cold Owner admission skips off-branch invalid coordination and retains independent recipient obligations", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const ownerId = host.session.sessionId;
	const ownerFile = host.session.sessionManager.getSessionFile()!;
	const spawnCallId = "cold-evidence-child";
	const spawnEntryId = host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", {
		title: "Evidence child", request: "Preserve this child's identity without starting work.", label: "Evidence child",
	}, { id: spawnCallId }), { stopReason: "toolUse" }));
	const directory = join(host.session.sessionManager.getSessionDir(), "pi-durable-subagents", ownerId);
	await host.runtime.dispose();
	// A child Identity commits its Creation Request atomically. Cold admission
	// must verify this native evidence without starting a child model process.
	const child = SessionManager.create(host.cwd, directory);
	const childId = child.getSessionId();
	const identityEntry = child.appendCustomEntry("agent-coordination.identity", {
		agentId: childId, workflowId: ownerId, directSpawnerAgentId: ownerId,
		spawnSource: { agentId: ownerId, entryId: spawnEntryId, toolCallId: spawnCallId },
		creationPreset: null, metadata: { label: "Evidence child" },
	});
	const toolCallId = "off-branch-request-missing-title";
	const entryId = child.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: ownerId, question: "Previously accepted without a title",
	}, { id: toolCallId }), { stopReason: "toolUse" }));
	const source = { agentId: childId, entryId, toolCallId };
	const requestMessageId = deriveMessageIdentity(source);
	child.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId,
		content: [{ type: "text", text: "Original receipt" }], isError: false, timestamp: Date.now(),
		details: { requestMessageId, targetAgentId: ownerId, messageStatus: "sent" },
	});
	child.branch(identityEntry);
	child.appendCustomEntry("selected-leaf", { note: "Invalid coordination remains on another physical branch." });
	assert.equal(child.getBranch().some(entry => entry.id === entryId), false);
	const owner = SessionManager.open(ownerFile);
	const delivered = createMessageDelivery([{ source, projection: {
		kind: "request", requestMessageId, fromAgentId: childId, title: "Preserved recipient work", question: "Use these independent delivered instructions.",
	} }]);
	owner.appendCustomMessageEntry(delivered.customType, delivered.content, delivered.display, delivered.details);
	const originalChildEvidence = await readFile(child.getSessionFile()!, "utf8");
	const reopened = await createUnboundTestOwnerHost(t, piAgentCoordination, { cwd: host.cwd, agentDir: host.services.agentDir, sessionFile: ownerFile });
	await bindTestOwnerHost(reopened, "tui");
	for (const phase of ["startup", "reload"]) {
		if (phase === "reload") await reopened.session.reload();
		assert.ok(reopened.session.getActiveToolNames().includes("agent_message"), phase);
		assert.equal(reopened.ui.widgets.has("agent-coordination.blockage"), false, phase);
		assert.deepEqual(reopened.services.diagnostics.filter(item => item.type === "error"), [], phase);
		assert.equal(reopened.ui.notifications.some(({ message }) => /unavailable|blocked|quarantined|admission.*fail/i.test(message)), false, phase);
		const observe = reopened.session.getToolDefinition("agent_observe")!;
		const obligations = await observe.execute(`obligations-${phase}`, { operation: "obligations" }, undefined, undefined, reopened.session.extensionRunner.createContext());
		assert.deepEqual(obligations.details, { requests: [{ requestMessageId, requesterAgentId: childId, title: "Preserved recipient work" }] });
		const status = await observe.execute(`child-${phase}`, { operation: "status", agentId: childId }, undefined, undefined, reopened.session.extensionRunner.createContext());
		assert.equal((status.details as { run: { phase: string } }).run.phase, "dormant");
		assert.equal(await readFile(child.getSessionFile()!, "utf8"), originalChildEvidence);
	}
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
		promptBeforeReload = getCurrentSystemPrompt(context.messages);
		return fauxAssistantMessage("Used the retained snapshot.");
	}]);
	await host.session.prompt("Inspect the prepared Agent Templates.");

	assert.match(promptBeforeReload, /first-delegate/);
	assert.doesNotMatch(promptBeforeReload, /second-delegate/);

	await host.session.reload();
	let promptAfterReload = "";
	host.model.setResponses([(context) => {
		promptAfterReload = getCurrentSystemPrompt(context.messages);
		return fauxAssistantMessage("Used the refreshed snapshot.");
	}]);
	await host.session.prompt("Inspect the refreshed Agent Templates.");

	assert.match(promptAfterReload, /second-delegate/);
	assert.doesNotMatch(promptAfterReload, /first-delegate/);
});

test("an invalid initial Workflow Policy admits the Owner with the default policy and a warning", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	const policyPath = join(
		host.services.agentDir,
		"config",
		"pi-durable-subagents.json",
	);
	await mkdir(join(host.services.agentDir, "config"), { recursive: true });
	await writeFile(policyPath, '{"maxConcurrentAgentRuns": 0}', "utf8");

	await bindTestOwnerHost(host, "tui");

	const reason = "Workflow Policy maxConcurrentAgentRuns must be a positive safe integer";
	assert.ok(host.session.getActiveToolNames().includes("agent_spawn"));
	assert.equal(host.ui.widgets.has("agent-coordination.blockage"), false);
	assert.deepEqual(host.services.diagnostics, [{ type: "error", message: reason }]);
	assert.ok(host.ui.notifications.some(({ message, type }) =>
		type === "warning" && message === `${reason}. Using the default Workflow Policy.`));
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
	assertBlockedAdmission(host, /cannot bind the Owner Agent extension/);
	extensions.pop();
	await host.runtime.dispose();
});

test("Owner reload publishes one prospective policy or preserves the prior snapshot", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	const policyDirectory = join(host.services.agentDir, "config");
	const policyPath = join(policyDirectory, "pi-durable-subagents.json");
	await mkdir(policyDirectory, { recursive: true });
	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 1}', "utf8");
	await bindTestOwnerHost(host, "tui");
	const heldModel = createVoidDeferred();
	t.after(() => heldModel.resolve());
	host.model.setResponses(Array.from({ length: 2 }, () => async () => {
		await heldModel.promise;
		return fauxAssistantMessage("Held for policy checks.");
	}));

	const transcriptBeforeReload = structuredClone(host.session.sessionManager.getEntries());
	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 2}', "utf8");
	await host.session.reload();
	assert.deepEqual(host.session.sessionManager.getEntries(), transcriptBeforeReload);
	assert.ok(host.session.getActiveToolNames().includes("workflow_resume"));

	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 0}', "utf8");
	await host.session.reload();
	assert.equal(
		host.services.diagnostics.at(-1)?.message,
		"Workflow Policy maxPendingDeliveriesPerAgent must be a positive safe integer",
	);
	// Reload ends Runs rather than retaining volatile scheduling. Test the retained
	// policy against a newly held participant, independent of delivery progress.
	const fresh = await executeOwnerTool(host, "agent_spawn", "spawn-after-policy-reload", {
		title: "Policy check", request: "Stay available for capacity checks.",
	}) as { agentId: string };
	await executeOwnerTool(host, "agent_control", "hold-after-policy-reload", {
		operation: "interrupt", agentId: fresh.agentId,
	});
	for (let slot = 0; slot < 2; slot++) {
		const admitted = await executeOwnerTool(host, "agent_message", `retained-policy-slot-${slot}`, {
			operation: "send", targetAgent: fresh.agentId, content: `Occupy slot ${slot}`,
		}) as { messageStatus: string };
		assert.equal(admitted.messageStatus, "sent");
	}
	const rejectedAfterInvalidReload = await executeOwnerTool(
		host,
		"agent_message",
		"rejected-after-invalid-policy-reload",
		{
			operation: "send",
			targetAgent: fresh.agentId,
			content: "The preserved two-slot snapshot remains exhausted.",
		},
	);
	assert.equal(
		(rejectedAfterInvalidReload as { reason: string }).reason,
		"capacity_exhausted",
	);

	await host.runtime.dispose();
});

test("Workflow Policy model exclusions refuse an explicit spawn model before Identity", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	const policyDirectory = join(host.services.agentDir, "config");
	await mkdir(policyDirectory, { recursive: true });
	await writeFile(
		join(policyDirectory, "pi-durable-subagents.json"),
		'{"excludedModels": ["coordination-test/*"]}',
		"utf8",
	);
	await bindTestOwnerHost(host, "tui");

	const receipt = await executeOwnerTool(host, "agent_spawn", "spawn-excluded-model", {
		title: "Fixture request",
		request: "This request must never acquire a child.",
		config: { model: { id: "coordination-test/deterministic-owner", thinking: "off" } },
	});
	assert.deepEqual(receipt, {
		spawnStatus: "not_created",
		failedStage: "configuration",
		reason: "Configured Agent model is excluded by model policy: coordination-test/deterministic-owner",
	});

	await host.runtime.dispose();
});

test("/agents models toggles durable model exclusions from the Owner session", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const command = host.session.extensionRunner.getCommand("agents");
	assert.ok(command);
	const handled = command.handler(
		"models",
		host.session.extensionRunner.createContext() as Parameters<typeof command.handler>[1],
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const surface = host.ui.customSurfaces.at(-1);
	assert.ok(surface);
	const rendered = () => surface.render(100).map(stripTerminalSequences);
	assert.match(rendered().join("\n"), /Agent spawn model policy/);
	assert.match(rendered().join("\n"), /Banned models cannot be used/);
	assert.match(rendered().find((line) => line.includes("coordination-test/*")) ?? "", /✓/);

	// The first row is the provider entry for the only authenticated provider.
	surface.handleInput?.("\r");
	const exclusions = async () => {
		const policy = await readWorkflowPolicy(host.services.agentDir);
		if (!policy.ok) throw new Error("Expected the written policy to load");
		return policy.snapshot.excludedModels;
	};
	for (let attempt = 0; attempt < 200 && (await exclusions()).length === 0; attempt += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual(await exclusions(), ["coordination-test/*"]);
	assert.doesNotMatch(
		rendered().find((line) => line.includes("coordination-test/*")) ?? "",
		/✓/,
	);
	assert.doesNotMatch(
		rendered().find((line) => line.includes("deterministic-owner")) ?? "",
		/✓/,
	);

	surface.handleInput?.("\x1b");
	await handled;
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
	assertBlockedAdmission(host, /current Pi session is a child Agent/);
	assertOwnerToolsRegisteredButInactive(host);
	assert.ok(host.session.extensionRunner.getCommand("agents"), "diagnostics stays reachable");
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
	assertBlockedAdmission(host, /current Pi session is a Moderator/);
	assertOwnerToolsRegisteredButInactive(host);
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

/** Every failed admission shows its reason in the blockage widget instead of a raw handler error. */
function assertBlockedAdmission(host: TestOwnerHost, reason: RegExp): void {
	assert.deepEqual(host.ui.notifications.filter(({ type }) => type === "error"), []);
	const widget = host.ui.widgets.get("agent-coordination.blockage");
	assert.ok(widget);
	const widgetText = (widget as { render(width: number): string[] }).render(200).join("\n");
	assert.match(widgetText, /Subagent coordination blocked/);
	assert.match(widgetText, reason);
	assert.doesNotMatch(widgetText, /Saved coordination data is invalid/);
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
			fauxToolCall(toolName, input as JsonObject, { id: toolCallId }),
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
	host.session.sessionManager.appendMessage({
		role: "toolResult", toolName, toolCallId, content: result.content,
		details: result.details as JsonValue, isError: false, timestamp: Date.now(),
	});
	return result.details;
}

test("rejected Request and Answer history leaves navigation and diagnostics usable without continuing work", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	for (const operation of ["request", "answer"]) {
		host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
			operation,
		}, { id: `rejected-${operation}` }), { stopReason: "toolUse" }));
	}
	await bindTestOwnerHost(host, "tui");
	try {
		assert.equal(host.ui.widgets.has("agent-coordination.blockage"), false);
		const command = host.session.extensionRunner.getCommand("agents")!;
		const ctx = host.session.extensionRunner.createContext() as Parameters<typeof command.handler>[1];
		await command.handler("owner", ctx);
		for (const argument of ["", "diagnostics"]) {
			const count = host.ui.customSurfaces.length;
			const opened = command.handler(argument, ctx);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(host.ui.customSurfaces.length, count + 1);
			const panel = host.ui.customSurfaces.at(-1)!;
			const rendered = panel.render(120).join("\n");
			assert.match(rendered, argument ? /diagnostics/i : /Owner/);
			panel.handleInput?.(argument ? "q" : "\u001b");
			await opened;
		}
		assert.equal(host.session.isStreaming, false);
		assert.deepEqual(host.ui.notifications.filter(({ type }) => type === "error"), []);
	} finally {
		await host.runtime.dispose();
	}
});

test("conflicting valid Owner Deliveries retain admission-failure diagnostics after startup and reload", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	appendConflictingOwnerDelivery(host.session.sessionManager);
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
		assert.match(summary, /duplicate Deliveries/);
		assert.match(summary, /Recovery/);
		assert.match(summary, /unavailable/);
		assert.doesNotMatch(summary, /at authoredFacts/);
		assert.doesNotMatch(summary, /cleanup also failed/);
		panel.handleInput?.("t");
		const technical = panel.render(200).join("\n");
		assert.match(technical, /duplicate Deliveries/);
		assert.match(technical, /Transcript:/);
		panel.handleInput?.("q");
		await opened;
	}
	await host.runtime.dispose();
});

function appendConflictingOwnerDelivery(sessionManager: SessionManager) {
	const agentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry("agent-coordination.identity", { agentId, workflowId: agentId, directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } });
	const callId = "duplicate-valid-delivery-source";
	const entryId = sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: agentId, title: "Conflicting valid delivery", question: "One source cannot have two recipient Deliveries.",
	}, { id: callId }), { stopReason: "toolUse" }));
	const source = { agentId, entryId, toolCallId: callId };
	const messageId = deriveMessageIdentity(source);
	sessionManager.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: callId,
		content: [{ type: "text", text: "sent" }], details: { requestMessageId: messageId, targetAgentId: agentId, messageStatus: "sent" },
		isError: false, timestamp: Date.now(),
	});
	const delivery = createMessageDelivery([{ source, projection: {
		kind: "request", requestMessageId: messageId, fromAgentId: agentId,
		title: "Conflicting valid delivery", question: "One source cannot have two recipient Deliveries.",
	} }]);
	// Both records pass schema validation; their contradiction must still fail admission.
	for (let copy = 0; copy < 2; copy++) sessionManager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
}

test("resuming an Owner with conflicting valid Deliveries keeps diagnostics and native conversation usable", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const target = SessionManager.create(host.cwd, join(host.cwd, "invalid-owner-session"));
	appendConflictingOwnerDelivery(target);
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
	appendConflictingOwnerDelivery(host.session.sessionManager);
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

test("healthy Owner gaining conflicting valid Deliveries is blocked on its first reload", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	appendConflictingOwnerDelivery(host.session.sessionManager);
	await host.session.reload();
	assertOwnerToolsRegisteredButInactive(host);
	assert.ok(host.ui.widgets.get("agent-coordination.blockage"));
	const command = host.session.extensionRunner.getCommand("agents");
	assert.ok(command);
	const opened = command.handler("diagnostics", host.session.extensionRunner.createContext() as Parameters<typeof command.handler>[1]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const panel = host.ui.customSurfaces.at(-1);
	assert.ok(panel);
	assert.match(panel.render(120).join("\n"), /duplicate Deliveries/);
	panel.handleInput?.("q");
	await opened;
	await host.runtime.dispose();
});

for (const invalidate of [false, true]) {
	test(`reload quiesces a running child before ${invalidate ? "skipping a rejected historical Request" : "restoring admission"}`, { timeout: 5_000 }, async (t) => {
		const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
		await bindTestOwnerHost(host, "tui");
		const entered = createVoidDeferred();
		const release = createVoidDeferred();
		t.after(() => release.resolve());
		let modelCalls = 0;
		host.model.setResponses([async () => {
			modelCalls++;
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage("Completed after reload.");
		}]);
		const spawned = await executeOwnerTool(host, "agent_spawn", "reload-active-child", {
			title: "Active reload", request: "Keep working while the Owner reloads.",
		}) as { agentId: string; requestMessageId: string };
		await entered.promise;
		const observe = host.session.getToolDefinition("agent_observe")!;
		const before = await observe.execute("before-reload", { operation: "status", agentId: spawned.agentId }, undefined, undefined, host.session.extensionRunner.createContext());
		const path = (before.details as { primaryEvidence: { transcriptPath: string } }).primaryEvidence.transcriptPath;
		const staleMessage = host.session.getToolDefinition("agent_message")!;
		if (invalidate) {
			// Simulate evidence accepted by an older protocol while preserving the
			// entry references/count seen by its cached transcript projections.
			await executeOwnerTool(host, "agent_message", "reload-cached-request", {
				operation: "request", targetAgent: spawned.agentId, title: "Previously valid", question: "A saved Request",
			});
			await observe.execute("prime-validation", { operation: "status" }, undefined, undefined, host.session.extensionRunner.createContext());
			const source = host.session.sessionManager.getEntries().find((entry) =>
				entry.type === "message" && entry.message.role === "assistant" &&
				entry.message.content.some((part) => part.type === "toolCall" && part.id === "reload-cached-request"));
			assert.ok(source?.type === "message" && source.message.role === "assistant");
			const call = source.message.content.find((part) => part.type === "toolCall");
			assert.ok(call?.type === "toolCall");
			delete call.arguments.title;
		}
		await host.session.reload();
		const settledEntries = SessionManager.open(path).getEntries();
		release.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(SessionManager.open(path).getEntries(), settledEntries);
		assert.equal(modelCalls, 1, "reload must not restart or replay child work");
		await assert.rejects(() => staleMessage.execute("stale-send", {
			operation: "send", targetAgent: spawned.agentId, content: "A stale callback",
		}, undefined, undefined, host.session.extensionRunner.createContext()), /shutting_down/);
		assert.equal(host.ui.widgets.has("agent-coordination.blockage"), false);
		assert.ok(host.session.getActiveToolNames().includes("workflow_resume"));
		assert.equal(host.ui.notifications.some(({ message }) => message.includes("Workflow revalidated")), false);
		const freshObserve = host.session.getToolDefinition("agent_observe")!;
		const after = await freshObserve.execute("after-reload", { operation: "status", agentId: spawned.agentId }, undefined, undefined, host.session.extensionRunner.createContext());
		assert.equal((after.details as { run: { phase: string } }).run.phase, "dormant");
		const request = await freshObserve.execute("request-after-reload", { operation: "request", requestId: spawned.requestMessageId }, undefined, undefined, host.session.extensionRunner.createContext());
		assert.match(JSON.stringify(request.details), /Keep working while the Owner reloads/);
		await host.runtime.dispose();
	});
}


test("reload joins admitted spawn preparation before declaring its snapshot safe", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	await bindTestOwnerHost(host, "tui");
	const entered = createVoidDeferred();
	const release = createVoidDeferred();
	t.after(() => release.resolve());
	const prepare = ProcessChildSessionFactory.prototype.prepareOrdinaryRun;
	t.mock.method(ProcessChildSessionFactory.prototype, "prepareOrdinaryRun", async function (this: ProcessChildSessionFactory, ...args: Parameters<typeof prepare>) {
		entered.resolve();
		await release.promise;
		return prepare.apply(this, args);
	});
	const spawning = executeOwnerTool(host, "agent_spawn", "spawn-during-reload", {
		title: "Preparing", request: "Do not start after reload fencing.",
	});
	await entered.promise;
	let reloaded = false;
	const reload = host.session.reload().then(() => { reloaded = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(reloaded, false, "shutdown must join host-side writers, not just kill child processes");
	release.resolve();
	const receipt = await spawning as { spawnStatus: string };
	await reload;
	assert.equal(receipt.spawnStatus, "not_created");
	assert.ok(host.session.getActiveToolNames().includes("agent_spawn"));
	await host.runtime.dispose();
});
