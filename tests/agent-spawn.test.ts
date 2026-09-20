import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Context,
} from "@earendil-works/pi-ai";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	WorkflowCoordinator,
	type AgentSpawnInput,
	type AgentSpawnReceipt,
	type MessageBoundaryHooks,
	type SpawnBoundaryHooks,
} from "../src/coordination/workflow-coordinator.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import piAgentCoordination from "../src/index.ts";
import { readWorkflowPolicy } from "../src/policy/workflow-policy.ts";
import {
	deriveMessageIdentity,
	ProtocolInvariantError,
} from "../src/protocol/identities.ts";
import { transcriptFromSessionFile } from "../src/pi-integration/session-manager-transcript.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestCleanupRegistrar,
} from "./support/pi-host.ts";
import {
	executeAndCommitRegisteredTool as executeRegisteredTool,
} from "./support/agent-session.ts";
import { capturedSessionManager } from "./support/captured-session-managers.ts";

const MAX_CONDITION_POLL_ATTEMPTS = 5_000;

test("another Agent spawns and delivers a Creation Request before an invalid Message receives its native error result", { timeout: 5_000 }, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	const invalidCallId = "invalid-message-before-native-result";
	const request = "Creation Request during native validation";
	const parentRequest = "Delegate a leaf to verify concurrent validation.";
	const leafSpawnCallId = "spawn-leaf-during-validation";
	const respond = (context: Context) => {
		const receivedParentRequest = context.messages.some((message) =>
			message.role === "user" && JSON.stringify(message.content).includes(parentRequest)
		);
		const spawnedLeaf = context.messages.some((message) =>
			message.role === "toolResult" && message.toolCallId === leafSpawnCallId
		);
		if (receivedParentRequest && !spawnedLeaf) {
			return fauxAssistantMessage(fauxToolCall("agent_spawn", { request }, {
				id: leafSpawnCallId,
			}), { stopReason: "toolUse" });
		}
		const receivedRequest = context.messages.some((message) =>
			message.role === "user" && JSON.stringify(message.content).includes(request)
		);
		const answerCallId = receivedParentRequest ? "answer-parent-validation" : "answer-during-validation";
		const answered = context.messages.some((message) =>
			message.role === "toolResult" && message.toolCallId === answerCallId
		);
		return (receivedRequest || receivedParentRequest) && !answered
			? fauxAssistantMessage(fauxToolCall("agent_message", {
				operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "The initial Request arrived.",
			}, { id: answerCallId }), { stopReason: "toolUse" })
			: fauxAssistantMessage("Finished.");
	};
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_message", {
			operation: "status", agentId: host.session.sessionId,
		}, { id: invalidCallId }), { stopReason: "toolUse" }),
		respond, respond, respond, respond, respond, respond, respond,
	]);
	let childId: string | undefined;
	let parentId: string | undefined;
	const unsubscribe = host.session.agent.subscribe(async (event) => {
		if (event.type !== "tool_execution_start" || event.toolCallId !== invalidCallId) return;
		// Pi awaits this public event after committing the call and before native
		// validation commits its error, making the reported race deterministic.
		assert.equal(host.session.sessionManager.getEntries().some((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === invalidCallId
		), false);
		const result = await executeRegisteredTool(host.session, "agent_spawn", "spawn-during-validation", { request: parentRequest });
		const receipt = result.details as AgentSpawnReceipt;
		assert.ok(receipt.spawnStatus === "created" && receipt.messageStatus === "sent");
		parentId = receipt.agentId;
		// The fresh parent uses its own native agent_spawn tool while the Owner's
		// malformed call still has no result, exercising cross-Agent inspection.
		const leafReceipt = await waitForAgentToolResult(host, parentId, leafSpawnCallId) as AgentSpawnReceipt;
		assert.ok(leafReceipt.spawnStatus === "created" && leafReceipt.messageStatus === "sent");
		childId = leafReceipt.agentId;
		await waitForAgentTranscriptText(host, childId, request);
		await waitForAgentToolResult(host, childId, "answer-during-validation");
		await waitForAgentToolResult(host, parentId, "answer-parent-validation");
	});
	try {
		await host.session.prompt("Attempt an invalid Message operation.");
		await host.session.waitForIdle();
	} finally {
		unsubscribe();
	}
	assert.ok(childId);
	const validationResult = host.session.sessionManager.getEntries().find((entry) =>
		entry.type === "message" && entry.message.role === "toolResult" &&
		entry.message.toolCallId === invalidCallId
	);
	assert.ok(validationResult?.type === "message" && validationResult.message.role === "toolResult");
	assert.equal(validationResult.message.isError, true);
	const entries = await agentTranscriptEntries(host, childId, 0);
	const identity = entries?.find((entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity");
	assert.ok(identity?.type === "custom");
	assert.equal((identity.data as { directSpawnerAgentId: string }).directSpawnerAgentId, parentId);
	assert.notEqual(parentId, host.session.sessionId);
	assert.equal(entries?.filter((entry) =>
		entry.type === "custom_message" && entry.customType === "agent-coordination.message-delivery" &&
		JSON.stringify(entry.content).includes(request)
	).length, 1);
});

test("an authenticated ordinary Agent creates a durable isolated child and admits its Creation Request", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{
					title: "Fixture request",
					request: "Inspect the coordination boundary and report what is observable.",
					description: "Inspects one coordination boundary",
				},
				{ id: "spawn-default-child" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The child has been created."),
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
					answer: "The isolated coordination boundary was observed.",
				},
				{ id: "answer-default-creation-request" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Creation Request Answer was committed."),
		fauxAssistantMessage("The child Answer reached the Owner."),
	]);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	const schema = spawn.parameters as { properties: Record<string, unknown> };
	assert.deepEqual(Object.keys(schema.properties).sort(), ["config", "description", "label", "request", "template", "title"]);

	await host.session.prompt("Delegate this inspection to a fresh child.");
	await host.session.waitForIdle();

	const spawnResult = host.session.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "agent_spawn",
		);
	assert.ok(spawnResult && spawnResult.type === "message");
	assert.equal(spawnResult.message.role, "toolResult");
	assert.equal(spawnResult.message.isError, false);
	assert.equal((spawnResult.message.details as { messageStatus: string }).messageStatus, "sent", JSON.stringify(spawnResult.message.details));
	assert.deepEqual(
		Object.keys(spawnResult.message.details as Record<string, unknown>).sort(),
		[
			"agentId",
			"effectiveConfiguration",
			"messageStatus",
			"requestMessageId",
			"spawnStatus",
		],
	);
	assert.equal(
		(spawnResult.message.details as { spawnStatus: string }).spawnStatus,
		"created",
	);
	const effectiveConfiguration = (
		spawnResult.message.details as Extract<
			AgentSpawnReceipt,
			{ spawnStatus: "created"; messageStatus: "sent" }
		>
	).effectiveConfiguration;
	assert.equal(effectiveConfiguration.extensions.length, 1);
	assert.match(effectiveConfiguration.extensions[0]!, /process-model-broker-extension\.mjs$/);
	const processExtensions = effectiveConfiguration.extensions;
	assert.deepEqual(
		effectiveConfiguration,
		{
			cwd: host.cwd,
			model: { provider: "coordination-test", modelId: "deterministic-owner" },
			thinking: "off",
			// Nothing is inherited from the parent surface: the child owns its own
			// runtime default and only carries the exclusion filter.
			excludeTools: [],
			excludeSkills: [],
			skills: [],
			extensions: processExtensions,
			loadContextFiles: true,
		},
	);

	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const childrenResult = await observe.execute(
		"observe-children",
		{ operation: "search", scope: "direct_children" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const children = (childrenResult.details as { matches: Array<Record<string, unknown>> })
		.matches;
	assert.equal(children.length, 1);
	assert.deepEqual(
		{
			agentId: children[0]?.agentId,
			workflowId: children[0]?.workflowId,
			label: children[0]?.label,
			description: children[0]?.description,
			directSpawnerAgentId: children[0]?.directSpawnerAgentId,
		},
		{
			agentId: (spawnResult.message.details as { agentId: string }).agentId,
			workflowId: host.session.sessionId,
			label: "agent",
			description: "Inspects one coordination boundary",
			directSpawnerAgentId: host.session.sessionId,
		},
	);

	const sourceEntry = host.session.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) => part.type === "toolCall" && part.id === "spawn-default-child",
				),
		);
	assert.ok(sourceEntry);
	const spawnSource = {
		agentId: host.session.sessionId,
		entryId: sourceEntry.id,
		toolCallId: "spawn-default-child",
	};
	const expectedRequestId = createHash("sha256")
		.update(
			[
				"agent-coordination",
				"message",
				spawnSource.agentId,
				spawnSource.entryId,
				spawnSource.toolCallId,
			].join("\0"),
			"utf8",
		)
		.digest("base64url");
	assert.equal(
		(spawnResult.message.details as { requestMessageId: string }).requestMessageId,
		expectedRequestId,
	);

	const workflowDirectory = join(
		host.session.sessionManager.getSessionDir(),
		"pi-durable-subagents",
		host.session.sessionId,
	);
	const childSessionFile = await waitForChildSessionFile(
		host.cwd,
		workflowDirectory,
		(spawnResult.message.details as { agentId: string }).agentId,
	);
	const childTranscript = SessionManager.open(childSessionFile);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) => entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery",
	);
	const childIdentity = childEntries.find(
		(entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity",
	);
	assert.ok(childIdentity && childIdentity.type === "custom");
	assert.equal(childIdentity.parentId, null);
	assert.deepEqual(childIdentity.data, {
		agentId: childTranscript.getSessionId(),
		workflowId: host.session.sessionId,
		directSpawnerAgentId: host.session.sessionId,
		spawnSource,
		creationPreset: null,
		metadata: {
			label: "agent",
			description: "Inspects one coordination boundary",
		},
	});
	const delivery = childEntries.find(
		(entry) => entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery",
	);
	assert.ok(delivery && delivery.type === "custom_message");
	assert.deepEqual(delivery.details, { messages: [spawnSource] });
	assert.deepEqual(JSON.parse(delivery.content as string), {
		messages: [
			{
				title: "Fixture request",
				kind: "request",
				requestMessageId: expectedRequestId,
				fromAgentId: host.session.sessionId,
				question: "Inspect the coordination boundary and report what is observable.",
			},
		],
	});
	assert.equal(
		childEntries.some(
			(entry) => entry.type === "message" && entry.message.role === "user",
		),
		false,
	);

	await host.runtime.dispose();
});

test("removed conversation mode creates neither child nor Creation Request", { timeout: 5_000 }, async (t) => {
	const harness = await createCoordinatorHarness(t, {});
	try {
		const input = { title: "Removed mode", request: "Do not create a child.", conversation: "fork" };
		await assert.rejects(() => harness.spawn("removed-conversation-mode", input), /conversation.*no longer supported/);
		assert.deepEqual(harness.view.children(), []);
		assert.equal(harness.view.status().run.retentionReasons.some(({ reason }) => reason === "awaiting_answer"), false);
	} finally {
		await harness.shutdown();
	}
});

test(`a successor Runtime retains its creation preset while resolving current project resources (isolated)`, async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const templateRoot = join(host.cwd, "template-root");
	const effectiveCwd = join(host.cwd, "subproject");
	await mkdir(templateRoot, { recursive: true });
	await mkdir(join(effectiveCwd, ".agents", "agents"), { recursive: true });
	new ProjectTrustStore(host.services.agentDir).set(effectiveCwd, true);
	await writeFile(
		join(templateRoot, "research.md"),
		"---\nname: research-agent\nuseWhen: Use for research.\nmodels:\n  - id: coordination-test/deterministic-owner\n    thinking: off\nexcludeTools: read\n---\nTemplate context",
	);
	await writeFile(join(effectiveCwd, "AGENTS.md"), "Native effective-cwd context");
	await writeFile(
		join(effectiveCwd, ".agents", "agents", "research.md"),
		"---\nname: research-agent\nuseWhen: Use for research.\nmodels:\n  - id: coordination-test/deterministic-owner\n    thinking: low\n---\nWrong discovery root",
	);

	let observedSystemPrompt = "";
	let observedTools: string[] = [];
	host.model.setResponses([
		(context) => {
			observedSystemPrompt = getCurrentSystemPrompt(context.messages);
			observedTools = getCurrentTools(context.messages).map(({ name }) => name) ?? [];
			return fauxAssistantMessage("Configured child Run observed.");
		},
	]);
	let coordinator: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		packageRoot: host.cwd,
		templateRoots: (parentCwd, projectTrusted) => {
			assert.equal(projectTrusted, true);
			if (parentCwd === host.cwd) {
				return [{ scope: "trusted-project", path: templateRoot }];
			}
			assert.equal(parentCwd, effectiveCwd);
			return [{
				scope: "trusted-project",
				path: join(effectiveCwd, ".agents", "agents"),
			}];
		},
	});
	const view = coordinator.forAgent(identity.agentId);
	const spawnInput = {
		title: "Fixture request",
		request: "Inspect the configured child Run.",
		template: "research-agent",
		description: "  Research specialist  ",
		config: {
			cwd: "subproject",
			excludeTools: ["grep"],
			systemPrompt: "Spawn context",
			systemPromptMode: "append" as const,
		},
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: "spawn-configured-child" }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.spawn("spawn-configured-child", spawnInput);
	if (receipt.spawnStatus !== "created" || receipt.messageStatus !== "sent") {
		throw new Error(`Configured child was not created: ${JSON.stringify(receipt)}`);
	}
	assert.equal(receipt.effectiveConfiguration.extensions.length, 1);
	assert.match(
		receipt.effectiveConfiguration.extensions[0]!,
		/process-model-broker-extension\.mjs$/,
	);
	const processExtensions = receipt.effectiveConfiguration.extensions;
	assert.deepEqual(receipt.effectiveConfiguration, {
		cwd: effectiveCwd,
		model: { provider: "coordination-test", modelId: "deterministic-owner" },
		thinking: "off",
		// Template rules plus Spawn exclusions accumulate; the child still owns the
		// baseline it filters.
		excludeTools: ["read", "grep"],
		excludeSkills: [],
		skills: [],
		extensions: processExtensions,
		systemPrompt: {
			mode: "append",
			body: "Template context\n\nSpawn context",
		},
		loadContextFiles: true,
	});
	assert.deepEqual(
		view.children().map(({ label, description }) => ({ label, description })),
		[{ label: "research-agent", description: "Research specialist" }],
	);
	await waitForCondition(() => observedSystemPrompt.length > 0);
	assert.match(observedSystemPrompt, /Native effective-cwd context/);
	assert.match(observedSystemPrompt, /Template context/);
	assert.match(observedSystemPrompt, /Spawn context/);
	assert.doesNotMatch(observedSystemPrompt, /Wrong discovery root/);
	for (const toolName of receipt.effectiveConfiguration.excludeTools) {
		assert.equal(observedTools.includes(toolName), false, `excluded tool stayed model-visible: ${toolName}`);
	}
	// Participation never depends on the filter: the role tools stay active.
	for (const toolName of [
		"agent_message",
		"agent_wait",
		"agent_spawn",
		"agent_observe",
		"agent_control",
		"ask_user",
	]) {
		assert.ok(observedTools.includes(toolName), `missing role coordination tool ${toolName}`);
	}

	const workflowDirectory = join(
		host.session.sessionManager.getSessionDir(),
		"pi-durable-subagents",
		host.session.sessionId,
	);
	const childSessionFile = await waitForChildSessionFile(
		effectiveCwd,
		workflowDirectory,
		receipt.agentId,
	);
	const configuredChildTranscript = SessionManager.open(childSessionFile);
	const configuredChildEntries = configuredChildTranscript.getEntries();
	const childIdentity = configuredChildEntries.findLast(
		(entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity",
	);
	assert.ok(childIdentity && childIdentity.type === "custom");
	assert.deepEqual(
		(childIdentity.data as { metadata: object }).metadata,
		{
			label: "research-agent",
			description: "Research specialist",
		},
	);
	assert.deepEqual(
		configuredChildEntries.flatMap(
			(entry) => entry.type === "custom" ? [entry.customType] : [],
		),
		["agent-coordination.identity"],
	);

	const agentId = receipt.agentId;
	await waitForCondition(() => {
		const run = view.status(agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	const terminationInput = { operation: "terminate" as const, agentId };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", terminationInput, {
				id: "terminate-configured-child-v1",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const termination = await view.control(
		"terminate-configured-child-v1",
		terminationInput,
	);
	assert.ok("disposition" in termination);
	assert.equal(termination.disposition, "terminated");
	await writeFile(
		join(templateRoot, "research.md"),
		"---\nname: research-agent\nuseWhen: Use for research.\nmodels:\n  - id: coordination-test/deterministic-owner\n    thinking: off\nexcludeTools: read\n---\nChanged Template context",
	);
	await writeFile(join(effectiveCwd, "AGENTS.md"), "Changed effective-cwd context");
	let successorSystemPrompt = "";
	host.model.setResponses([
		(context) => {
			successorSystemPrompt = getCurrentSystemPrompt(context.messages);
			return fauxAssistantMessage("Dynamically prepared successor observed.");
		},
	]);
	const successorInput = {
		operation: "send" as const,
		targetAgent: agentId,
		content: "Start a successor from current configuration and resources.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", successorInput, { id: "start-configured-child-v2" }),
			{ stopReason: "toolUse" },
		),
	);
	const successorReceipt = await view.message(
		"start-configured-child-v2",
		successorInput,
	);
	assert.ok("messageStatus" in successorReceipt);
	assert.equal(successorReceipt.messageStatus, "sent");
	await waitForCondition(() => successorSystemPrompt.length > 0);
	assert.match(successorSystemPrompt, /Changed effective-cwd context/);
	assert.match(successorSystemPrompt, /Template context/);
	assert.doesNotMatch(successorSystemPrompt, /Changed Template context/);
	assert.match(successorSystemPrompt, /Spawn context/);
	assert.doesNotMatch(successorSystemPrompt, /Native effective-cwd context/);
	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("a catalogued model under an unconfigured provider fails before Agent Identity", async (t) => {
	const harness = await createCoordinatorHarness(t, {});
	const provider = "openai-codex";
	const cataloguedModel = harness.host.services.modelRuntime.getModels(provider)[0];
	assert.ok(cataloguedModel, "expected an OpenAI Codex model in Pi's catalogue");
	assert.equal(harness.host.services.modelRuntime.hasConfiguredAuth(provider), false);
	const configuredModelId = `${provider}/${cataloguedModel.id}`;

	const receipt = await harness.spawn("spawn-unconfigured-provider", {
		title: "Fixture request",
		request: "This request must never acquire a child.",
		config: {
			model: { id: configuredModelId, thinking: "off" },
		},
	});

	assert.deepEqual(receipt, {
		spawnStatus: "not_created",
		failedStage: "configuration",
		reason: `Configured Agent model is unavailable: ${configuredModelId}`,
	});
	assert.deepEqual(harness.view.children(), []);

	await harness.shutdown();
});

test("Owner-authored model exclusions refuse an explicit spawn model", async (t) => {
	const harness = await createCoordinatorHarness(t, {});
	const available = harness.host.services.modelRuntime.getAvailableSnapshot()[0];
	assert.ok(available, "expected an available model in the test catalogue");
	await harness.view.setModelExclusions([`${available.provider}/*`]);

	const receipt = await harness.spawn("spawn-policy-excluded", {
		title: "Fixture request",
		request: "This request must never acquire a child.",
		config: {
			model: { id: `${available.provider}/${available.id}`, thinking: "off" },
		},
	});
	assert.deepEqual(receipt, {
		spawnStatus: "not_created",
		failedStage: "configuration",
		reason: `Configured Agent model is excluded by model policy: ${available.provider}/${available.id}`,
	});
	assert.deepEqual(harness.view.children(), []);

	// The exclusion list is durable user policy, not Workflow session state.
	const policy = await readWorkflowPolicy(harness.host.services.agentDir);
	assert.equal(policy.ok, true);
	if (!policy.ok) throw new Error("Expected the written policy to load");
	assert.deepEqual(policy.snapshot.excludedModels, [`${available.provider}/*`]);

	await harness.shutdown();
});

test("invalid default-child metadata fails before Agent Identity", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{
					title: "Fixture request",
					request: "This request must never acquire a child.",
					description: "\n",
				},
				{ id: "spawn-invalid-metadata" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The child was not created."),
	]);

	await host.session.prompt("Try an invalid child description.");
	await host.session.waitForIdle();

	assert.deepEqual(findSpawnReceipt(host.session.sessionManager), {
		spawnStatus: "not_created",
		failedStage: "configuration",
		reason: "invalid_input: Agent description must not be empty",
	});
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const result = await observe.execute(
		"observe-no-children",
		{ operation: "search", scope: "direct_children" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(result.details, { matches: [], hasMore: false });

	await host.runtime.dispose();
});

test("a skill name colliding across the child's own roots is discovered once and admitted", async (t) => {
	const harness = await createCoordinatorHarness(t, {});
	const piSkillDirectory = join(harness.host.cwd, ".pi", "skills", "pi-copy");
	const agentsSkillDirectory = join(harness.host.cwd, ".agents", "skills", "agents-copy");
	await mkdir(piSkillDirectory, { recursive: true });
	await mkdir(agentsSkillDirectory, { recursive: true });
	const skill = [
		"---",
		"name: colliding-skill",
		"description: Deliberate collision fixture",
		"---",
		"Exercise the child-owned resource discovery boundary.",
	].join("\n");
	await writeFile(join(piSkillDirectory, "SKILL.md"), skill);
	await writeFile(join(agentsSkillDirectory, "SKILL.md"), skill);
	const receipt = await harness.spawn("spawn-colliding-skill", {
		title: "Fixture request",
		request: "Discover the colliding skill name from the child's own roots.",
	});
	if (receipt.spawnStatus !== "created" || receipt.messageStatus !== "sent") {
		throw new Error(`Colliding-skill child was not admitted: ${JSON.stringify(receipt)}`);
	}
	// The parent no longer resolves a skill selection, so a name available from two
	// of the child's own roots is not a configuration failure: the child's discovery
	// yields one entry and the Run is admitted.
	assert.equal(
		receipt.effectiveConfiguration.skills.filter((name) => name === "colliding-skill").length,
		1,
	);

	await harness.shutdown();
});

test("an untrusted effective cwd cannot contribute its project skills", async (t) => {
	const harness = await createCoordinatorHarness(t, {});
	const effectiveCwd = join(harness.host.cwd, "untrusted-project");
	const skillDirectory = join(effectiveCwd, ".agents", "skills", "untrusted-skill");
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(
		join(skillDirectory, "SKILL.md"),
		[
			"---",
			"name: untrusted-skill",
			"description: Must remain unavailable",
			"---",
			"This project resource requires trust.",
		].join("\n"),
	);
	new ProjectTrustStore(harness.host.services.agentDir).set(effectiveCwd, false);

	const receipt = await harness.spawn("spawn-untrusted-project-resource", {
		title: "Fixture request",
		request: "Discover skills in the cwd this Workflow does not trust.",
		config: {
			cwd: "untrusted-project",
		},
	});

	if (receipt.spawnStatus !== "created" || receipt.messageStatus !== "sent") {
		throw new Error(`Untrusted-cwd child was not created: ${JSON.stringify(receipt)}`);
	}
	// The child discovers skills for its own cwd and Pi withholds untrusted project
	// resources, so a name discovery never returns is simply absent from the filter's input.
	assert.equal(receipt.effectiveConfiguration.skills.includes("untrusted-skill"), false);

	await harness.shutdown();
});

test("effective cwd honors Pi's default project-trust policy", async (t) => {
	const harness = await createCoordinatorHarness(t, {});
	await mkdir(harness.host.services.agentDir, { recursive: true });
	await writeFile(
		join(harness.host.services.agentDir, "settings.json"),
		`${JSON.stringify({ defaultProjectTrust: "always" }, null, 2)}\n`,
	);
	const effectiveCwd = join(harness.host.cwd, "default-trusted-project");
	const skillDirectory = join(effectiveCwd, ".agents", "skills", "trusted-skill");
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(
		join(skillDirectory, "SKILL.md"),
		[
			"---",
			"name: trusted-skill",
			"description: Available under the global trust policy",
			"---",
			"This project resource is trusted by policy.",
		].join("\n"),
	);

	const receipt = await harness.spawn("spawn-default-trusted-project", {
		title: "Fixture request",
		request: "Use the policy-trusted skill.",
		config: {
			cwd: "default-trusted-project",
		},
	});

	if (receipt.spawnStatus !== "created" || receipt.messageStatus !== "sent") {
		throw new Error(`Trusted child was not created: ${JSON.stringify(receipt)}`);
	}
	assert.deepEqual(receipt.effectiveConfiguration.skills, ["trusted-skill"]);
	assert.ok(receipt.agentId);

	await harness.shutdown();
});

test("an excluded tool name the child never had is a no-op whose Run is admitted", async (t) => {
	const ownerOnlyTool: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "owner_only_probe",
			label: "Owner-only probe",
			description: "A test resource available only on the parent surface.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute() {
				return { content: [{ type: "text", text: "probe" }], details: undefined };
			},
		});
	};
	const harness = await createCoordinatorHarness(t, {}, ownerOnlyTool);
	const receipt = await harness.spawn("spawn-excluded-absent-tool", {
		title: "Fixture request",
		request: "Filter a tool name the child never had.",
		config: { excludeTools: ["owner_only_probe"] },
	});

	if (receipt.spawnStatus !== "created" || receipt.messageStatus !== "sent") {
		throw new Error(`Excluded-name child was not admitted: ${JSON.stringify(receipt)}`);
	}
	// A name the child never had changes nothing, because the parent's surface is not
	// inherited and the filter ignores names it cannot find.
	assert.deepEqual(receipt.effectiveConfiguration.excludeTools, ["owner_only_probe"]);
	assert.equal(harness.view.children()[0]?.run.phase, "live");

	await harness.shutdown();
});

test("confirmed post-Identity Run startup failure keeps a visible dormant child", async (t) => {
	const harness = await createCoordinatorHarness(t, {
		beforeRunStart: () => "confirmed_failure",
	});
	const receipt = await harness.spawn("spawn-run-start-failure");

	assert.equal(receipt.spawnStatus, "created");
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "not_sent");
	assert.ok("failedStage" in receipt);
	assert.equal(receipt.failedStage, "run_start");
	assert.ok("reason" in receipt);
	assert.equal(receipt.reason, "Confirmed Run startup failure");
	assert.deepEqual(harness.view.children()[0]?.run, {
		phase: "dormant",
		retentionReasons: [],
	});

	await harness.shutdown();
});

test("shutdown after Agent Identity keeps the durable child dormant", async (t) => {
	let shutdownPromise: Promise<void> | undefined;
	let harness!: Awaited<ReturnType<typeof createCoordinatorHarness>>;
	harness = await createCoordinatorHarness(t, {
		beforeRunStart: () => {
			shutdownPromise ??= harness.shutdown();
		},
	});

	const receipt = await harness.spawn("spawn-identity-before-shutdown");
	await shutdownPromise;

	assert.equal(receipt.spawnStatus, "created");
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "not_sent");
	assert.ok("failedStage" in receipt);
	assert.equal(receipt.failedStage, "run_start");
	assert.ok("reason" in receipt);
	assert.equal(receipt.reason, "host_shutting_down: Workflow is shutting down");
	assert.deepEqual(harness.view.children()[0]?.run, {
		phase: "dormant",
		retentionReasons: [],
	});
});

test("Run startup invariant failures are not downgraded to availability receipts", async (t) => {
	const harness = await createCoordinatorHarness(t, {
		beforeRunStart: () => {
			throw new ProtocolInvariantError("started child Run contradicts its protocol binding");
		},
	});

	await assert.rejects(
		() => harness.spawn("spawn-run-start-invariant-violation"),
		/started child Run contradicts its protocol binding/,
	);

	await harness.shutdown();
});

test("confirmed post-Identity Delivery admission failure keeps the child and Request but releases its Run", async (t) => {
	const harness = await createCoordinatorHarness(t, {
		beforeDeliveryAdmission: () => "confirmed_failure",
	});
	const receipt = await harness.spawn("spawn-delivery-admission-failure");

	assert.equal(receipt.spawnStatus, "created");
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "not_sent");
	assert.ok("failedStage" in receipt);
	assert.equal(receipt.failedStage, "delivery_admission");
	assert.ok("reason" in receipt);
	assert.equal(receipt.reason, "Confirmed Delivery admission failure");
	assert.deepEqual(harness.view.children()[0]?.run, {
		phase: "dormant",
		retentionReasons: [],
	});

	await harness.shutdown();
});

test("a pre-dispatch invariant failure releases the child and its Creation Request remains retryable", { timeout: 5_000 }, async (t) => {
	let failDispatch = true;
	const harness = await createCoordinatorHarness(t, {}, undefined, {
		scheduleDeliveryDispatch: (_context, dispatch) => {
			if (failDispatch) throw new ProtocolInvariantError("Delivery admission could not inspect Request evidence");
			dispatch();
		},
	});
	const spawnCallId = "spawn-before-dispatch-failure";
	await assert.rejects(harness.spawn(spawnCallId), /could not inspect Request evidence/);
	const child = harness.view.children()[0];
	assert.ok(child);
	assert.deepEqual(child.run, { phase: "dormant", retentionReasons: [] });
	const sourceEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(sourceEntry);
	const source = { agentId: harness.host.session.sessionId, entryId: sourceEntry.id, toolCallId: spawnCallId };
	const requestId = deriveMessageIdentity(source);
	const path = child.primaryEvidence.transcriptPath;
	assert.ok(path);
	assert.equal(transcriptFromSessionFile(path).inspect().entries.some((entry) =>
		entry.type === "custom_message" && entry.customType === "agent-coordination.message-delivery"
	), false);

	failDispatch = false;
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(fauxToolCall("agent_message", {
			operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "The retried Creation Request arrived.",
		}, { id: "answer-retried-creation" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Finished."),
	]);
	const retryCallId = "retry-failed-creation";
	const retry = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", retry, { id: retryCallId }), { stopReason: "toolUse" },
	));
	const receipt = await harness.view.message(retryCallId, retry);
	assert.ok("messageStatus" in receipt && receipt.messageStatus === "sent");
	const entries = await waitForEntry(path, (entry) =>
		entry.type === "custom_message" && entry.customType === "agent-coordination.message-delivery"
	);
	assert.equal(entries.filter((entry) =>
		entry.type === "custom_message" && entry.customType === "agent-coordination.message-delivery" &&
		JSON.stringify(entry.details) === JSON.stringify({ messages: [source] })
	).length, 1);
	await harness.shutdown();
});

test("retry advances an undispatched Creation Request without duplicating a late dispatch callback", { timeout: 5_000 }, async (t) => {
	let canDispatch = false;
	let delayedDispatch: (() => void) | undefined;
	const harness = await createCoordinatorHarness(t, {}, undefined, {
		scheduleDeliveryDispatch: (_context, dispatch) => {
			if (canDispatch) dispatch();
			else delayedDispatch = dispatch;
		},
	});
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(fauxToolCall("agent_message", {
			operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "The pending Creation Request arrived once.",
		}, { id: "answer-pending-creation" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Finished."),
	]);
	const spawn = await harness.spawn("spawn-delayed-creation");
	assert.ok(spawn.spawnStatus === "created" && spawn.messageStatus === "sent");
	assert.ok(delayedDispatch);
	const child = harness.view.status(spawn.agentId);
	const path = child.primaryEvidence.transcriptPath;
	assert.ok(path);
	canDispatch = true;
	const retryCallId = "retry-pending-creation";
	const retry = { operation: "retry" as const, messageId: spawn.requestMessageId };
	harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", retry, { id: retryCallId }), { stopReason: "toolUse" },
	));
	const receipt = await harness.view.message(retryCallId, retry);
	assert.ok("messageStatus" in receipt && receipt.messageStatus === "sent");
	await waitForEntry(path, (entry) =>
		entry.type === "custom_message" && entry.customType === "agent-coordination.message-delivery"
	);
	delayedDispatch();
	await harness.coordinator.forAgent(spawn.agentId).reachSafeBoundary();
	assert.equal(transcriptFromSessionFile(path).inspect().entries.filter((entry) =>
		entry.type === "custom_message" && entry.customType === "agent-coordination.message-delivery"
	).length, 1);
	await harness.shutdown();
});

test("lost Run-start confirmation stays indeterminate after confirmed Identity", async (t) => {
	const harness = await createCoordinatorHarness(t, {
		afterRunStart: (context) => {
			assert.deepEqual(Object.keys(context).sort(), ["handle", "identity"]);
			assert.equal(context.handle.sequence > 0, true);
			return "confirmation_lost";
		},
	});
	try {
		const receipt = await harness.spawn("spawn-run-start-confirmation-lost");

		assert.equal(receipt.spawnStatus, "unknown");
		assert.ok(receipt.spawnStatus === "unknown");
		assert.equal(receipt.lastConfirmedStage, "identity");
		assert.equal(typeof receipt.candidateAgentId, "string");
		assert.equal(typeof receipt.candidateRequestMessageId, "string");
		assert.equal(harness.view.children()[0]?.run.phase, "live");
	} finally {
		await shutdownAfterLostRunStart(harness);
	}
});

test("lost Identity confirmation stays indeterminate with a canonical dormant child", async (t) => {
	const harness = await createCoordinatorHarness(t, {
		afterIdentityCommit: () => "confirmation_lost",
	});
	const receipt = await harness.spawn("spawn-identity-confirmation-lost");

	assert.equal(receipt.spawnStatus, "unknown");
	assert.ok(receipt.spawnStatus === "unknown");
	assert.equal("lastConfirmedStage" in receipt, false);
	assert.equal(typeof receipt.candidateAgentId, "string");
	assert.equal(typeof receipt.candidateRequestMessageId, "string");
	assert.deepEqual(harness.view.children()[0]?.run, {
		phase: "dormant",
		retentionReasons: [],
	});

	await harness.shutdown();
});

test("lost Delivery confirmation stays indeterminate after confirmed Run start", async (t) => {
	const harness = await createCoordinatorHarness(t, {
		afterDeliveryAdmission: () => "confirmation_lost",
	});
	const receipt = await harness.spawn("spawn-delivery-confirmation-lost");

	assert.equal(receipt.spawnStatus, "unknown");
	assert.ok(receipt.spawnStatus === "unknown");
	assert.equal(receipt.lastConfirmedStage, "run_start");
	assert.equal(typeof receipt.candidateAgentId, "string");
	assert.equal(typeof receipt.candidateRequestMessageId, "string");
	assert.equal(harness.view.children()[0]?.run.phase, "live");

	await harness.shutdown();
});

test("contradictory child Identity evidence is an invariant violation", async (t) => {
	const harness = await createCoordinatorHarness(t, {
		afterIdentityCommit: ({ identity }) => {
			openDurableCapturedSession(identity.agentId).appendCustomEntry(
				"agent-coordination.identity",
				{
				...identity,
					spawnSource: { ...identity.spawnSource, toolCallId: "contradictory-source" },
				},
			);
		},
	});
	try {
		await assert.rejects(
			() => harness.spawn("spawn-contradictory-identity"),
			/invariant_violation: child transcript contains 2 ordinary Identity entries/,
		);
	} finally {
		await harness.shutdown();
	}
});

test("forged Creation Request Delivery evidence is an invariant violation", async (t) => {
	const harness = await createCoordinatorHarness(t, {
		afterIdentityCommit: ({ identity }) => {
			openDurableCapturedSession(identity.agentId).appendCustomMessageEntry(
				"agent-coordination.message-delivery",
				JSON.stringify({
					messages: [
						{
							title: "Fixture request",
							kind: "request",
							requestMessageId: "wrong-request",
							fromAgentId: identity.directSpawnerAgentId,
							question: "This projection does not match its source.",
						},
					],
				}),
				true,
				{ messages: [identity.spawnSource] },
			);
		},
	});
	try {
		await assert.rejects(
			() => harness.spawn("spawn-with-forged-creation-request-delivery"),
			/Creation Request .* Delivery differs from its source/,
		);
	} finally {
		await harness.shutdown();
	}
});

test("direct children remain in physical Agent Spawn call order", async (t) => {
	const harness = await createCoordinatorHarness(t, {});
	const receipts = await harness.spawnMany([
		"spawn-first-ordered-child",
		"spawn-second-ordered-child",
	]);

	assert.deepEqual(
		harness.view.children().map(({ agentId }) => agentId),
		receipts,
	);

	await harness.shutdown();
});

test("Agent observation status resolves labels and unique ID suffixes without broadening authority", { timeout: 15_000 }, async (t) => {
	const harness = await createCoordinatorHarness(t, {
		beforeRunStart: () => "confirmed_failure",
	});
	const reviewer = await harness.spawn("status-reviewer", {
		title: "Fixture request", request: "Review the contract.", label: "Reviewer",
	});
	const builder = await harness.spawn("status-builder", {
		title: "Fixture request", request: "Build the contract.", label: "Builder",
	});
	assert.ok("agentId" in reviewer);
	assert.ok("agentId" in builder);
	const expected = harness.view.status(reviewer.agentId);
	assert.deepEqual(harness.view.status("Reviewer"), expected);
	assert.deepEqual(harness.view.status(`  ${reviewer.agentId.slice(-8)}  `), expected);
	assert.equal(harness.view.status("Owner").agentId, harness.view.status().agentId);
	assert.equal(harness.view.status("Reviewer").run.phase, "dormant");
	assert.throws(() => harness.view.status("Missing"), /unknown_identity/);
	assert.throws(() => harness.view.status("   "), /invalid_input/);

	const reviewerView = harness.coordinator.forAgent(reviewer.agentId);
	assert.equal(reviewerView.status("Reviewer").agentId, reviewer.agentId);
	assert.throws(() => reviewerView.status("Builder"), /unknown_identity/);
	assert.throws(() => reviewerView.status(builder.agentId.slice(-8)), /unauthorized/);
	assert.throws(() => reviewerView.status(builder.agentId), /unauthorized/);

	await harness.spawn("status-duplicate-reviewer", {
		title: "Fixture request", request: "Review another contract.", label: "Reviewer",
	});
	assert.throws(() => harness.view.status("Reviewer"), /ambiguous_target/);
	assert.equal(harness.view.status(reviewer.agentId).agentId, reviewer.agentId);
	// An unrelated duplicate label cannot make self-observation ambiguous.
	assert.equal(reviewerView.status("Reviewer").agentId, reviewer.agentId);
	await harness.shutdown();
});

test("Agent observation status respects Workflow-scoped quarantine and identity precedence", { timeout: 15_000 }, async (t) => {
	for (const scenario of ["foreign", "same-workflow", "label-collision", "suffix-collision"] as const) {
		await t.test(scenario, async (t) => {
			const host = await createUnboundTestOwnerHost(t, () => undefined, { persistent: true });
			await bindTestOwnerHost(host, "tui");
			const identity = adoptOrValidateOwnerIdentity(host.runtime);
			const suffix = identity.agentId.slice(-8);
			const quarantinedId = scenario === "label-collision" ? "Owner"
				: scenario === "same-workflow" ? "quarantined-agent"
				: `other-${identity.agentId}`;
			const coordinator = await createTestWorkflowCoordinator(host, identity, {
				entryModulePath: "<inline:pi-durable-subagents>",
				recoveredWorkflow: {
					agents: [], transcriptPathByAgentId: new Map(), agentIdBySpawnSource: new Map(),
					quarantinedAgentIds: new Set([quarantinedId]),
					quarantinedWorkflowAgentIds: new Set(scenario === "foreign" ? [] : [quarantinedId]),
					quarantinedCandidateCount: 1,
				},
			});
			const view = coordinator.forAgent(identity.agentId);
			assert.equal(view.status(identity.agentId).agentId, identity.agentId);
			assert.throws(() => view.status(quarantinedId), /evidence_unavailable/);
			if (scenario === "foreign") {
				assert.equal(view.status("Owner").agentId, identity.agentId);
			} else {
				assert.throws(() => view.status("Owner"), /evidence_unavailable/);
			}
			if (scenario === "suffix-collision") {
				assert.throws(() => view.status(suffix), /ambiguous_target/);
			} else {
				assert.equal(view.status(suffix).agentId, identity.agentId);
			}
		});
	}
});

test("Agent observation search composes metadata, phase, identity, scope, and bounds", async (t) => {
	const harness = await createCoordinatorHarness(t, {
		beforeRunStart: () => "confirmed_failure",
	});
	const reviewerReceipt = await harness.spawn("search-dormant-reviewer", {
		title: "Fixture request",
		request: "Review the API contract.",
		label: "Dormant Reviewer",
		description: "Reviews API contracts",
	});
	const builderReceipt = await harness.spawn("search-dormant-builder", {
		title: "Fixture request",
		request: "Build the API contract.",
		label: "Dormant Builder",
		description: "Builds API contracts",
	});
	const apiBuilderReceipt = await harness.spawn("search-dormant-api-builder", {
		title: "Fixture request",
		request: "Build the API contract.",
		label: "API Builder",
		description: "Builds API contracts",
	});
	assert.ok("agentId" in reviewerReceipt);
	assert.ok("agentId" in builderReceipt);
	assert.ok("agentId" in apiBuilderReceipt);
	const reviewer = reviewerReceipt.agentId;
	const builder = builderReceipt.agentId;
	const apiBuilder = apiBuilderReceipt.agentId;

	const directChildren = harness.view.search({
		operation: "search",
		scope: "direct_children",
		limit: 50,
	});
	assert.deepEqual(
		directChildren.matches.map(({ agentId }) => agentId),
		[reviewer, builder, apiBuilder],
	);
	assert.equal(directChildren.hasMore, false);

	const compactIdentity = reviewer.slice(-8);
	const reviewMatches = harness.view.search({
		operation: "search",
		scope: "authorized",
		query: "review",
		agentIdSuffix: compactIdentity,
		phase: "dormant",
		limit: 20,
	});
	assert.deepEqual(reviewMatches.matches.map(({ agentId }) => agentId), [reviewer]);
	assert.equal(reviewMatches.matches[0]?.directSpawnerAgentId, harness.view.status().agentId);
	assert.equal(reviewMatches.hasMore, false);

	const namedSpawnerMatches = harness.view.search({
		operation: "search",
		scope: { directSpawnerAgentId: harness.view.status().agentId },
		query: "api",
		limit: 50,
	});
	assert.deepEqual(
		namedSpawnerMatches.matches.map(({ agentId }) => agentId),
		[apiBuilder, reviewer, builder],
	);

	const ordinarySearch = harness.coordinator.forAgent(reviewer).search({
		operation: "search",
		scope: "authorized",
		query: "owner",
		limit: 20,
	});
	assert.deepEqual(ordinarySearch, { matches: [], hasMore: false });
	const unauthorizedParentSearch = harness.coordinator.forAgent(reviewer).search({
		operation: "search",
		scope: { directSpawnerAgentId: harness.view.status().agentId },
		query: "api",
		limit: 20,
	});
	assert.deepEqual(unauthorizedParentSearch, { matches: [], hasMore: false });
	const unknownParentSearch = harness.view.search({
		operation: "search",
		scope: { directSpawnerAgentId: "unknown-parent" },
		query: "api",
		limit: 20,
	});
	assert.deepEqual(unknownParentSearch, { matches: [], hasMore: false });

	const bounded = harness.view.search({
		operation: "search",
		scope: "direct_children",
		phase: "dormant",
		limit: 1,
	});
	assert.equal(bounded.matches.length, 1);
	assert.equal(bounded.hasMore, true);
	assert.throws(
		() => harness.view.search({ operation: "search", scope: "authorized" }),
		/Authorized Agent search requires a query, ID suffix, or phase/,
	);
	assert.throws(
		() => harness.view.search({ operation: "search", scope: "direct_children", query: "   " }),
		/Agent search query must not be empty/,
	);
	assert.throws(
		() => harness.view.search({ operation: "search", scope: "direct_children", limit: 51 }),
		/Agent search limit must be between 1 and 50/,
	);

	await harness.shutdown();
});

function openDurableCapturedSession(agentId: string): SessionManager {
	const sessionFile = capturedSessionManager(agentId).getSessionFile();
	assert.ok(sessionFile, `SessionManager ${agentId} has no durable session file`);
	return SessionManager.open(sessionFile);
}

async function waitForChildSessionFile(
	cwd: string,
	sessionDirectory: string,
	agentId: string,
): Promise<string> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const sessions = await SessionManager.list(cwd, sessionDirectory);
		const child = sessions.find((session) => session.id === agentId);
		if (child) return child.path;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`Child Pi session ${agentId} was not created`);
}

async function waitForEntry(
	sessionFile: string,
	predicate: (entry: ReturnType<SessionManager["getEntries"]>[number]) => boolean,
) {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const entries = SessionManager.open(sessionFile).getEntries();
		if (entries.some(predicate)) return entries;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected child transcript entry did not commit");
}

async function waitForAgentTranscriptText(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
	expected: string,
): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const entries = await agentTranscriptEntries(host, agentId, attempt);
		if (entries && JSON.stringify(entries).includes(expected)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`Agent ${agentId} transcript did not include ${expected}`);
}

async function waitForAgentToolResult(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
	toolCallId: string,
): Promise<unknown> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const entries = await agentTranscriptEntries(host, agentId, attempt);
		const result = entries?.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId,
		);
		if (result?.type === "message" && result.message.role === "toolResult") {
			return result.message.details;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`Agent ${agentId} did not commit tool result ${toolCallId}`);
}

async function agentTranscriptEntries(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
	attempt: number,
): Promise<ReturnType<SessionManager["getEntries"]> | undefined> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		`locate-agent-transcript-${agentId}-${attempt}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const transcriptPath = (status.details as {
		primaryEvidence: { transcriptPath: string | null };
	}).primaryEvidence.transcriptPath;
	return transcriptPath
		? SessionManager.open(transcriptPath).getEntries()
		: undefined;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected condition did not become true");
}

function findSpawnReceipt(sessionManager: SessionManager): AgentSpawnReceipt {
	const result = sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "agent_spawn",
		);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	return result.message.details as AgentSpawnReceipt;
}

async function shutdownAfterLostRunStart(
	harness: Awaited<ReturnType<typeof createCoordinatorHarness>>,
): Promise<void> {
	try {
		await harness.shutdown();
	} catch (error) {
		assert.ok(error instanceof AggregateError);
		assert.equal(error.message, "Workflow shutdown failed");
		assert.deepEqual(
			error.errors.map((failure) => String(failure)).sort(),
			[
				"Error: child_runtime_run_unavailable: no Run has been admitted",
				"Error: child_runtime_run_unavailable: no Run has been admitted",
			],
		);
	}
}

async function createCoordinatorHarness(
	t: TestCleanupRegistrar,
	hooks: SpawnBoundaryHooks,
	ownerExtension: ExtensionFactory = () => undefined,
	messageBoundaryHooks: MessageBoundaryHooks = {},
) {
	const host = await createUnboundTestOwnerHost(t, ownerExtension, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		spawnBoundaryHooks: hooks,
		messageBoundaryHooks,
	});
	const view = coordinator.forAgent(identity.agentId);

	return {
		host,
		view,
		coordinator,
		async spawn(
			toolCallId: string,
			input: AgentSpawnInput = { title: "Fixture request", request: `Creation Request for ${toolCallId}` },
		): Promise<AgentSpawnReceipt> {
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall(
						"agent_spawn",
						input,
						{ id: toolCallId },
					),
					{ stopReason: "toolUse" },
				),
			);
			return view.spawn(toolCallId, input);
		},
		async spawnMany(toolCallIds: string[]) {
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					toolCallIds.map((toolCallId) =>
						fauxToolCall(
							"agent_spawn",
							{ title: "Fixture request", request: `Creation Request for ${toolCallId}` },
							{ id: toolCallId },
						),
					),
					{ stopReason: "toolUse" },
				),
			);
			const agentIds: string[] = [];
			for (const toolCallId of toolCallIds) {
				const receipt = await view.spawn(toolCallId, {
					title: "Fixture request",
					request: `Creation Request for ${toolCallId}`,
				});
				assert.ok("agentId" in receipt && typeof receipt.agentId === "string");
				agentIds.push(receipt.agentId);
			}
			return agentIds;
		},
		shutdown: () => coordinator.shutdown(async () => host.runtime.dispose()),
	};
}
