import { Check } from "typebox/value";
import { agentControlMethods } from "../src/control/agent-control-protocol.ts";
import { createAgentSelectorSnapshot } from "../src/process-runtime/remote-agent-selector.ts";
import { ModeratorReportStore } from "../src/coordination/moderator-reports.ts";
import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import { obligationStack } from "../src/protocol/obligation-focus.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { registerSessionStartup } from "../src/pi-integration/session-startup.ts";
import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type Context,
	type JsonValue,
} from "@earendil-works/pi-ai";
import {
	SessionManager,
	initTheme,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import piAgentCoordination from "../src/index.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import type { AgentRunState } from "../src/runtime/agent-runtime-host.ts";
import {
	WorkflowPolicyStore,
	parseWorkflowPolicy,
} from "../src/policy/workflow-policy.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestCleanupRegistrar,
} from "./support/pi-host.ts";
import {
	executeAndCommitRegisteredTool,
	openDormantAgentView,
	openLiveAgentView,
	returnAgentViewToOwner,
} from "./support/agent-session.ts";
import { ControllableOperationReviewClock } from "./support/controllable-operation-review-clock.ts";
import { waitForPhysicalDisplayContent } from "./support/physical-test-display.ts";
import {
	EXECUTION_GATE_RELEASE_PATH_VARIABLE,
	EXECUTION_GATE_STARTED_PATH_VARIABLE,
} from "./support/execution-gate-tool.ts";

const CONDITION_WAIT_TIMEOUT_MS = 5_000;
const CONDITION_POLL_INTERVAL_MS = 1;

test("a settled answer-obligated Agent is reminded once before one atomic Obligation Stall Moderator", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		implicitModeratorResponses: false,
	});
	let moderatorTools: string[] = [];
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ title: "Fixture request", request: "Answer this Creation Request after completing the work." },
				{ id: "spawn-stalled-agent" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The child is now responsible for the Request."),
		fauxAssistantMessage("I settled without discharging the Answer obligation."),
		fauxAssistantMessage("I settled again after the runtime reminder without answering."),
		(context) => {
			moderatorTools = getCurrentTools(context.messages).map(({ name }) => name).sort() ?? [];
			return fauxAssistantMessage("I will inspect the stalled obligation.");
		},
	]);

	const ownerPrompt = host.session.prompt(
		"Create an Agent that will demonstrate a Stall.",
	);

	const moderator = await waitForModerator(host);
	const spawnSourceEntry = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === "spawn-stalled-agent",
			),
	);
	assert.ok(spawnSourceEntry);
	const spawnSource = {
		agentId: host.session.sessionId,
		entryId: spawnSourceEntry.id,
		toolCallId: "spawn-stalled-agent",
	};
	const moderatorTranscript = SessionManager.open(moderator.path);
	const moderatorInput = moderatorTranscript.getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(moderatorInput && moderatorInput.type === "custom_message");
	assert.equal(moderatorInput.parentId, null);
	assert.equal(moderatorInput.display, true);
	const input = JSON.parse(moderatorInput.content as string) as {
		trigger: {
			kind: string;
			agentId: string;
			obligations: { total: number; sources: unknown[] };
		};
		inspectedThrough: Array<{ agentId: string; entryId: string }>;
	};
	assert.deepEqual(moderatorInput.details, {
		creationPreset: null,
		agentId: moderator.id,
		workflowId: host.session.sessionId,
		metadata: {
			label: "Moderator",
			description: "Incident: obligation stall",
		},
	});
	assert.equal(input.trigger.kind, "obligation_stall");
	assert.equal(input.trigger.obligations.total, 1);
	assert.deepEqual(input.trigger.obligations.sources, [spawnSource]);
	const affectedSessionPath = await sessionPathFor(host, input.trigger.agentId);
	const reminders = SessionManager.open(affectedSessionPath).getEntries().filter(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.obligation-reminder",
	);
	assert.equal(reminders.length, 1);
	assert.ok(reminders[0]?.type === "custom_message");
	assert.deepEqual(JSON.parse(reminders[0].content as string), {
		requestMessageId: deriveMessageIdentity(spawnSource),
		requestTitle: "Fixture request",
		guidance:
			"This Request still needs an Answer. Choose which outstanding Request to work on or answer; attention order does not prescribe execution order. Send each Answer as a standalone agent_message operation \"answer\" call, then end the turn without a summary.",
	});
	assert.deepEqual(input.inspectedThrough, [
		{
			agentId: input.trigger.agentId,
			entryId: await transcriptTailFor(host, input.trigger.agentId),
		},
	]);
	const routineStart = await waitForTranscriptEntry(
		moderator.path,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-routine-start",
	);
	assert.ok(routineStart?.type === "custom_message");
	const committedModeratorEntries = SessionManager.open(moderator.path).getEntries();
	const moderatorInputIndex = committedModeratorEntries.findIndex(
		({ id }) => id === moderatorInput.id,
	);
	const routineStartIndex = committedModeratorEntries.findIndex(
		({ id }) => id === routineStart.id,
	);
	assert.ok(moderatorInputIndex >= 0 && moderatorInputIndex < routineStartIndex);
	assert.equal(routineStart.content, "Begin moderation.");
	assert.equal(routineStart.display, false);
	await waitForCondition(() => moderatorTools.length > 0);
	assert.deepEqual(moderatorTools, [
		"agent_control",
		"agent_message",
		"agent_observe",
		"agent_wait",
		"ask_user",
		"bash",
		"edit",
		"moderator_control",
		"read",
		"report_to_user",
		"write",
	]);

	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const statusResult = await observe.execute(
		"observe-created-moderator",
		{ operation: "status", agentId: moderator.id },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(
		{
			agentId: (statusResult.details as { agentId: string }).agentId,
			label: (statusResult.details as { label: string }).label,
			directSpawnerAgentId: (statusResult.details as {
				directSpawnerAgentId: string | null;
			}).directSpawnerAgentId,
		},
		{ agentId: moderator.id, label: "Moderator", directSpawnerAgentId: null },
	);

	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal((await findModerators(host)).length, 1);
	const ownerSession = host.runtime.session;
	const liveView = await openLiveAgentView(host, moderator.id);
	// This host renders through a physical test display, whose xterm parses stdout
	// asynchronously: read the delivered frame only after that parse, or the
	// assertion observes the empty grid that preceded the write.
	const liveRendered = stripTerminalSequences(await waitForPhysicalDisplayContent(
		liveView.view,
		(rendered) =>
			rendered.includes("agent-coordination.moderator-input") &&
			// The status bar renders the bare model id; only a provider-qualified line
			// elsewhere would carry the provider prefix.
			rendered.includes("deterministic-owner"),
	));
	assert.match(liveRendered, /agent-coordination\.moderator-input/);
	assert.match(liveRendered, /deterministic-owner/);
	assert.equal(host.runtime.session, ownerSession);
	host.model.setResponses([
		fauxAssistantMessage("The Moderator received direct native editor input."),
	]);
	for (const character of "Inspect this Moderator directly from its view.") {
		liveView.view.handleInput?.(character);
	}
	liveView.view.handleInput?.("\r");
	await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "user" &&
			JSON.stringify(entry.message.content).includes(
				"Inspect this Moderator directly from its view.",
			),
	);
	await returnAgentViewToOwner(host, liveView);

	const termination = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-moderator-before-dormant-view",
		{ operation: "terminate", agentId: moderator.id },
	);
	assert.equal((termination.details as { disposition: string }).disposition, "terminated");
	const dormantView = await openDormantAgentView(host, moderator.id);
	// The dormant re-attachment replays the complete Moderator transcript, so a fresh
	// viewport shows its tail while the Moderator Input sits at the top. Pi's
	// fullscreen transcript viewport scrolls with Page Up/Page Down and Home/End
	// (docs/agent-selector.md:96), so return to the boundary this assertion names
	// instead of reading the tail the display happens to hold.
	await waitForPhysicalDisplayContent(
		dormantView.view,
		(rendered) => rendered.includes("Moderator"),
	);
	dormantView.view.handleInput?.("\x1b[H");
	const dormantRendered = stripTerminalSequences(await waitForPhysicalDisplayContent(
		dormantView.view,
		(rendered) => rendered.includes("agent-coordination.moderator-input"),
	));
	assert.match(dormantRendered, /agent-coordination\.moderator-input/);
	assert.equal((await observeStatus(host, moderator.id)).run.phase, "dormant");
	assert.equal(host.runtime.session, ownerSession);
	await returnAgentViewToOwner(host, dormantView);
	await host.session.abort();
	await ownerPrompt;
});

test("an Answer triggered by the runtime reminder avoids Obligation Stall moderation", async (t) => {
	const harness = await createIncidentBoundaryHarness(t);
	const routeReminderRecovery = (context: Context) => {
		if (JSON.stringify(context.messages).includes("requestTitle")) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
						answer: "The runtime reminder recovered the forgotten Answer.",
					},
					{ id: "answer-after-runtime-reminder" },
				),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("I initially settled without answering.");
	};
	harness.host.model.setResponses(
		Array.from({ length: 4 }, () => routeReminderRecovery),
	);
	const affected = await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-reminder-recovery-agent",
		"Return the requested result through the correlated Answer.",
	);

	const affectedSessionPath = await sessionPathFor(harness.host, affected.agentId);
	await waitForTranscriptEntry(
		affectedSessionPath,
		(entry) => entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === "answer-after-runtime-reminder",
	);
	await waitForCondition(() =>
		!harness.owner.status(affected.agentId).run.retentionReasons.some(
			({ reason }) => reason === "answer_owed",
		)
	);
	await harness.owner.reachSafeBoundary();
	assert.equal((await findModerators(harness.host)).length, 0);
	const entries = SessionManager.open(affectedSessionPath).getEntries();
	assert.equal(
		entries.filter(
			(entry) => entry.type === "custom_message" &&
				entry.customType === "agent-coordination.obligation-reminder",
		).length,
		1,
	);
	assert.equal(
		entries.some(
			(entry) => entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "answer-after-runtime-reminder",
		),
		true,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("deselecting a genuinely live settled obligation creates an Obligation Stall Moderator", async (t) => {
	let markChildStarted!: () => void;
	const childStarted = new Promise<void>((resolve) => {
		markChildStarted = resolve;
	});
	let releaseChild!: () => void;
	const childGate = new Promise<void>((resolve) => {
		releaseChild = resolve;
	});
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		implicitModeratorResponses: false,
	});
	try {
		host.model.setResponses([
			async () => {
				markChildStarted();
				await childGate;
				return fauxAssistantMessage(
					"I settled while selected without answering the Creation Request.",
				);
			},
			fauxAssistantMessage("I remained settled after the runtime reminder."),
			fauxAssistantMessage("I will inspect the stalled selected Agent."),
		]);
		const spawn = await executeAndCommitRegisteredTool(
			host.session,
			"agent_spawn",
			"spawn-selected-obligation-stall",
			{
				title: "Fixture request",
				request: "Settle while selected, then remain answer-obligated.",
				label: "Selected Obligation Worker",
			},
		);
		const agentId = (spawn.details as { agentId: string }).agentId;
		await childStarted;
		const opened = await openLiveAgentView(host, agentId);
		releaseChild();
		await waitForCondition(async () => {
			const status = await observeStatus(host, agentId);
			return status.run.phase === "live" && status.run.work === "settled";
		});
		assert.equal((await findModerators(host)).length, 0);

		await new Promise<void>((resolve) => setImmediate(resolve));
		await returnAgentViewToOwner(host, opened);
		const moderator = await waitForModeratorKind(host, "obligation_stall");
		assert.equal(moderatorAffectedAgentId(moderator.path), agentId);
	} finally {
		releaseChild();
		await host.runtime.dispose();
	}
});

test("an overdue root call starts a Moderator outside full child capacity", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-operation-review-"));
	const toolStartedPath = join(cwd, "execution-gate.started");
	const toolReleasePath = join(cwd, "execution-gate.released");
	const executionGateExtensionPath = join(cwd, "execution-gate-tool.mjs");
	await writeFile(
		executionGateExtensionPath,
		renderProcessExecutionGateExtension(toolStartedPath, toolReleasePath),
		"utf8",
	);
	const releaseTool = () => writeFile(toolReleasePath, "released", "utf8");
	t.after(releaseTool);
	let releaseModerator!: () => void;
	const moderatorGate = new Promise<void>((resolve) => {
		releaseModerator = resolve;
	});
	t.after(() => releaseModerator());
	const clock = new ControllableOperationReviewClock();
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
		cwd,
		additionalExtensionPaths: [
			executionGateExtensionPath,
		],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator!: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		workflowPolicy: new WorkflowPolicyStore(
			parseWorkflowPolicy(
				'{"maxConcurrentAgentRuns":1,"operationReviewIntervalMs":1000}',
			),
		),
		operationReviewClock: clock,
	});
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("execution_gate", {}, { id: "overdue-root-call" }),
			{ stopReason: "toolUse" },
		),
		async (context) => {
			const content = context.messages.flatMap((message) => {
				if (message.role !== "user") return [];
				if (typeof message.content === "string") return [message.content];
				return message.content.flatMap((part) =>
					part.type === "text" ? [part.text] : []
				);
			}).find((candidate) => candidate.includes('"kind":"operation_review"'));
			assert.ok(content);
			const trigger = (JSON.parse(content) as {
				trigger: {
					toolCall: { agentId: string; entryId: string; toolCallId: string };
				};
			}).trigger;
			await moderatorGate;
			return fauxAssistantMessage(
				fauxToolCall(
					"moderator_control",
					{
						operation: "renew_review_deadline",
						toolCall: trigger.toolCall,
						nextReviewInMs: 500,
						rationale: "The exact call remains safe to observe for another short interval.",
					},
					{ id: "renew-overdue-root-call" },
				),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("The exact review interval was renewed."),
		fauxAssistantMessage("The renewed interval expired and requires fresh review."),
	]);

	const child = await spawnFromView(
		host.session,
		owner,
		"spawn-operation-review-agent",
		"Keep the Creation Request open while one root call remains unresolved.",
	);
	await waitForCondition(async () => fileExists(toolStartedPath));
	clock.advanceBy(1_000);
	await coordinator.forAgent(child.agentId).reachSafeBoundary();

	const moderator = await waitForModeratorKind(host, "operation_review");
	assert.equal(await fileExists(toolReleasePath), false);
	const agentView = await owner.openAgentView(child.agentId);
	assert.ok(agentView);
	const childTranscriptPathBeforeReview = owner.status(child.agentId)
		.primaryEvidence.transcriptPath;
	assert.ok(childTranscriptPathBeforeReview);
	assert.match(
		JSON.stringify(SessionManager.open(childTranscriptPathBeforeReview).getEntries()),
		/Keep the Creation Request open/,
	);
	assert.equal(await owner.openAgentView(moderator.id), undefined);
	// A hidden child bypasses background parsing (docs/child-ui-context.md), and
	// parsing follows screen consumers since 9acb31e: a test that reads this
	// projection must hold the same observation the mounted view surface takes.
	await agentView.projection().screenView.begin();
	assert.match(
		stripTerminalSequences(
			agentView.projection().presentation.render(240).join("\n"),
		),
		/operation_review/,
	);
	releaseModerator();
	const inputEntry = SessionManager.open(moderator.path).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(inputEntry?.type === "custom_message" && typeof inputEntry.content === "string");
	const input = JSON.parse(inputEntry.content) as {
		trigger: {
			kind: string;
			toolCall: { agentId: string; entryId: string; toolCallId: string };
			reviewIntervalMs: number;
		};
	};
	assert.deepEqual(input.trigger, {
		kind: "operation_review",
		toolCall: {
			agentId: child.agentId,
			entryId: input.trigger.toolCall.entryId,
			toolCallId: "overdue-root-call",
		},
		reviewIntervalMs: 1_000,
	});
	const childTranscriptPath = owner.status(child.agentId).primaryEvidence.transcriptPath;
	assert.ok(childTranscriptPath);
	assert.equal(
		SessionManager.open(childTranscriptPath).getEntries().some(
			(entry) =>
				entry.id === input.trigger.toolCall.entryId &&
				entry.type === "message" &&
				entry.message.role === "assistant",
		),
		true,
	);
	const renewal = await waitForTranscriptEntry(
		moderator.path,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === "renew-overdue-root-call",
	);
	assert.ok(renewal.type === "message" && renewal.message.role === "toolResult");
	assert.deepEqual(renewal.message.details, {
		disposition: "renewed",
		toolCall: input.trigger.toolCall,
		nextReviewInMs: 500,
	});

	clock.advanceBy(499);
	await coordinator.forAgent(child.agentId).reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 1);
	clock.advanceBy(1);
	await coordinator.forAgent(child.agentId).reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 2);

	await releaseTool();
	await agentView.close();
	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("an unregistered tool name beside a parked parallel root call keeps that batch under review", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-operation-review-unknown-name-"));
	const toolStartedPath = join(cwd, "execution-gate.started");
	const toolReleasePath = join(cwd, "execution-gate.released");
	const executionGateExtensionPath = join(cwd, "execution-gate-tool.mjs");
	await writeFile(
		executionGateExtensionPath,
		renderProcessExecutionGateExtension(toolStartedPath, toolReleasePath, "parallel"),
		"utf8",
	);
	t.after(() => writeFile(toolReleasePath, "released", "utf8"));
	const clock = new ControllableOperationReviewClock();
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
		cwd,
		additionalExtensionPaths: [
			executionGateExtensionPath,
		],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		workflowPolicy: new WorkflowPolicyStore(
			parseWorkflowPolicy(
				'{"maxConcurrentAgentRuns":1,"operationReviewIntervalMs":1000}',
			),
		),
		operationReviewClock: clock,
	});
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		// One committed batch: an invented name ahead of a parallel call that parks.
		// The invented name names no tool and carries no execution mode, so it must
		// leave the call beside it under review; Pi holds the whole Run on the batch,
		// so a parallel parked call is still reviewed from execution admission
		// (docs/operational-incident-moderation.md:17).
		fauxAssistantMessage([
			fauxToolCall("code", { code: "text('invented tool name')" }, { id: "unknown-batch-call" }),
			fauxToolCall("execution_gate", {}, { id: "overdue-root-call" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("The parked call beside the invented name was reviewed."),
	]);

	const child = await spawnFromView(
		host.session,
		owner,
		"spawn-unknown-batch-name",
		"Keep the Creation Request open while one root call remains unresolved.",
	);
	await waitForCondition(async () => fileExists(toolStartedPath));
	clock.advanceBy(1_000);
	await coordinator.forAgent(child.agentId).reachSafeBoundary();

	const moderator = await waitForModeratorKind(host, "operation_review");
	assert.equal(await fileExists(toolReleasePath), false);
	assert.equal(moderatorTriggerKind(moderator.path), "operation_review");
	await writeFile(toolReleasePath, "released", "utf8");
	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("one failed provider request suspends an answer-obligated Run without regenerating it or withholding capacity", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-run-suspension-"));
	const agentDir = join(cwd, ".pi-agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ retry: { enabled: false, maxRetries: 0 } }),
		"utf8",
	);
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
		cwd,
		agentDir,
		settings: { retry: { enabled: false } },
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		workflowPolicy: new WorkflowPolicyStore(
			parseWorkflowPolicy('{"maxConcurrentAgentRuns":1}'),
		),
	});
	const owner = coordinator.forAgent(identity.agentId);
	let failedChildProviderRequests = 0;
	const routedResponses = Array.from(
		{ length: 6 },
		() => (context: Context) => {
			if (context.messages.some(
				(message) =>
					message.role === "user" &&
					JSON.stringify(message.content).includes(
						"Answer this Creation Request after the exact Run fails.",
					),
			)) {
				failedChildProviderRequests += 1;
				return fauxAssistantMessage("The exact child Run fails before answering.", {
					stopReason: "error",
					errorMessage:
						"400 invalid_request_error: deterministic answer-obligated generation failure",
				});
			}
			return fauxAssistantMessage("The unrelated Run made progress.");
		},
	);
	host.model.setResponses(routedResponses);

	try {
		const affected = await spawnFromView(
			host.session,
			owner,
			"spawn-run-failure-agent",
			"Answer this Creation Request after the exact Run fails.",
		);
		await waitForCondition(() =>
			runSuspension(owner.status(affected.agentId).run)?.reason === "runtime_error"
		);
		assert.deepEqual(runSuspension(owner.status(affected.agentId).run), {
			reason: "runtime_error",
			evidence: {
				stage: "model",
				error:
					"400 invalid_request_error: deterministic answer-obligated generation failure",
				provenance: "pi-child-hosted-runtime",
			},
		});
		assert.equal(
			failedChildProviderRequests,
			1,
			"a suspended Run is not regenerated automatically",
		);
		assert.deepEqual(owner.reportHistory(), []);
		assert.deepEqual(await findModerators(host), []);
		const retained = owner.status(affected.agentId).run;
		assert.equal(retained.phase, "live");
		assert.equal("work" in retained && retained.work, "settled");
		assert.ok(
			retained.retentionReasons.some(({ reason }) => reason === "answer_owed"),
		);
		assert.ok(coordinator.forAgent(affected.agentId).obligationFrames().length > 0);
		await assert.rejects(
			coordinator.forAgent(affected.agentId).beginExecution(),
			/run_suspended/,
		);

		// The stop releases the execution permit, so an unrelated Run is admitted
		// while the exact suspended Run stays retained.
		const unrelated = await spawnFromView(
			host.session,
			owner,
			"spawn-unrelated-run",
			"Make progress while another Run is suspended.",
		);
		await waitForCondition(async () => {
			const path = await sessionPathFor(host, unrelated.agentId).catch(
				() => undefined,
			);
			if (!path) return false;
			return JSON.stringify(SessionManager.open(path).getEntries()).includes(
				"The unrelated Run made progress.",
			);
		});
		assert.equal(
			runSuspension(owner.status(affected.agentId).run)?.reason,
			"runtime_error",
		);
		// Remove the unrelated Run before the cleanup queue so it cannot consume
		// another response.
		await controlFromView(host.session, owner, "terminate-unrelated-run", {
			operation: "terminate",
			agentId: unrelated.agentId,
		});
		await waitForCondition(() =>
			owner.status(unrelated.agentId).run.phase === "dormant"
		);

		// Cancelling the Request is the requester's own withdrawal, but a responder
		// learns of it only through Cancellation Delivery, and a suspended Run accepts
		// no ordinary Delivery. The stop therefore outlives the withdrawal.
		await cancelRequestFromView(
			host.session,
			owner,
			"cancel-suspended-obligation",
			affected.requestMessageId,
		);
		await owner.reachSafeBoundary();
		assert.equal(
			runSuspension(owner.status(affected.agentId).run)?.reason,
			"runtime_error",
			"cancelling the Request does not clear the Run stop",
		);
		assert.deepEqual(
			coordinator.forAgent(affected.agentId).obligationFrames().map(
				({ requestId }) => requestId,
			),
			[affected.requestMessageId],
			"the undelivered Cancellation leaves the suspended responder's obligation open",
		);
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});

test("an unexpectedly ended answer-obligated Owner Run suspends until explicit human resumption", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	let ownerRequestAuthored = false;
	const routeOwnerRequest = (context: Context) => {
		if (
			!ownerRequestAuthored &&
			JSON.stringify(context.messages).includes(
				"Ask the Owner one question, then wait for its Answer.",
			)
		) {
			ownerRequestAuthored = true;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						title: "Fixture request",
						operation: "request",
						targetAgent: host.session.sessionId,
						question: "What outcome should I preserve?",
					},
					{ id: "request-owner-outcome" },
				),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("I will wait for the Owner Answer.");
	};
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{
					title: "Fixture request",
					request: "Ask the Owner one question, then wait for its Answer.",
				},
				{ id: "spawn-owner-requester" },
			),
			{ stopReason: "toolUse" },
		),
		...Array.from({ length: 8 }, () => routeOwnerRequest),
	]);

	const ownerPrompt = host.session.prompt(
		"Create an Agent that will request Owner guidance.",
	);
	await waitForCondition(async () =>
		(await observeStatus(host, host.session.sessionId)).run.retentionReasons.some(
			({ reason }) => reason === "answer_owed",
		)
	);
	await waitForCondition(async () => {
		const run = (await observeStatus(host, host.session.sessionId)).run;
		return run.phase === "live" && run.work === "settled";
	});
	await ownerPrompt;

	host.model.setResponses(Array.from(
		{
			length: host.services.settingsManager.getRetrySettings().maxRetries + 4,
		},
		() =>
			fauxAssistantMessage("The Owner Run fails before answering.", {
				stopReason: "error",
				errorMessage: "deterministic answer-obligated Owner Run failure",
			}),
	));
	await host.session.prompt("Fail this Owner Run before answering the Request.");
	await host.session.waitForIdle();
	await waitForCondition(async () => {
		const run = (await observeStatus(host, host.session.sessionId)).run;
		return run.phase === "live" && run.suspension?.reason === "runtime_error";
	});

	const suspended = (await observeStatus(host, host.session.sessionId)).run;
	assert.deepEqual(suspended.suspension, {
		reason: "runtime_error",
		evidence: {
			stage: "model",
			error: "deterministic answer-obligated Owner Run failure",
			provenance: "in-process-hosted-runtime",
		},
	});
	assert.ok(
		suspended.retentionReasons.some(({ reason }) => reason === "answer_owed"),
	);
	assert.deepEqual(await findModerators(host), []);
	const reports = new ModeratorReportStore({
		transcript: transcriptFromSessionManager(host.session.sessionManager),
		appendCustomEntry: (type, data) =>
			host.session.sessionManager.appendCustomEntry(type, data),
	});
	assert.deepEqual(reports.history(), []);

	host.model.setResponses([
		fauxAssistantMessage("The Owner Run continued after explicit human resumption."),
		fauxAssistantMessage("The resumed Owner Run settled with its Request still open."),
	]);
	await host.session.prompt("Resume this Owner Run after the provider error.", {
		source: "interactive",
	});
	await waitForCondition(async () => {
		const run = (await observeStatus(host, host.session.sessionId)).run;
		return run.suspension === undefined;
	});
	assert.ok(
		host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(
					"Resume this Owner Run after the provider error.",
				),
		),
		"the human resume input is committed to the resumed Run",
	);
	assert.ok(
		(await observeStatus(host, host.session.sessionId)).run.retentionReasons.some(
			({ reason }) => reason === "answer_owed",
		),
		"the resumed Run still owes the Answer",
	);
	assert.deepEqual(await findModerators(host), []);
	assert.deepEqual(reports.history(), []);
});

test("Request Cancellation retains the suspended Run without starting a successor Incident", async (t) => {
	const harness = await createIncidentBoundaryHarness(t);
	harness.host.model.setResponses(Array.from(
		{
			length:
				harness.host.services.settingsManager.getRetrySettings().maxRetries + 4,
		},
		() =>
			fauxAssistantMessage("The exact Run fails before answering.", {
				stopReason: "error",
				errorMessage: "deterministic cancellable Run failure",
			}),
	));
	const affected = await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-suspended-cancellation",
		"Fail before answering this Creation Request.",
	);
	await waitForCondition(() =>
		runSuspension(harness.owner.status(affected.agentId).run)?.reason === "runtime_error"
	);
	await cancelRequestFromView(
		harness.host.session,
		harness.owner,
		"cancel-suspended-obligation",
		affected.requestMessageId,
	);
	await harness.owner.reachSafeBoundary();
	assert.equal(
		runSuspension(harness.owner.status(affected.agentId).run)?.reason,
		"runtime_error",
		"cancelling the Request does not clear the Run stop",
	);
	assert.deepEqual(harness.owner.operationalAttention(), []);
	assert.deepEqual(harness.owner.reportHistory(), []);
	assert.deepEqual(await findModerators(harness.host), []);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Moderator Resolution is blocked while the Obligation Stall remains", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ title: "Fixture request", request: "Leave this Answer obligation unresolved." },
				{ id: "spawn-resolution-blocker" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The unresolved Request is delegated."),
		fauxAssistantMessage("I settled without an Answer."),
		fauxAssistantMessage("I remained settled after the runtime reminder."),
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The Agent remains stalled.",
					rationale: "The qualifying Answer obligation is still unresolved.",
				},
				{ id: "resolve-active-stall" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Resolution remains blocked."),
	]);

	const ownerPrompt = host.session.prompt("Create a blocked moderation case.");
	t.after(async () => {
		await host.session.abort();
		await ownerPrompt;
	});
	const moderator = await waitForModerator(host);
	const result = await waitForTranscriptEntry(
		moderator.path,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-active-stall",
	);
	assert.ok(result.type === "message" && result.message.role === "toolResult");
	assert.equal(result.message.isError, false);
	assert.deepEqual(result.message.details, {
		disposition: "blocked",
		predicates: ["obligation_stall"],
	});
	assert.equal((await findModerators(host)).length, 1);

	await host.runtime.dispose();
});

test("a Moderator observes the Workflow and controls only non-Owner Runs", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ title: "Fixture request", request: "Settle with an Answer obligation for supervision." },
				{ id: "spawn-moderator-control-target" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The control target is delegated."),
		fauxAssistantMessage("I settled without answering."),
		fauxAssistantMessage("I remained settled after the runtime reminder."),
		(context) => {
			const input = context.messages.flatMap((message) => {
				if (message.role !== "user") return [];
				if (typeof message.content === "string") return [message.content];
				return message.content.flatMap((part) =>
					part.type === "text" ? [part.text] : []
				);
			}).find((content) => content.includes('"kind":"obligation_stall"'));
			assert.ok(input);
			const affectedAgentId = (JSON.parse(input) as {
				trigger: { agentId: string };
			}).trigger.agentId;
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"agent_observe",
						{ operation: "status", agentId: affectedAgentId },
						{ id: "moderator-observe-affected" },
					),
					fauxToolCall(
						"agent_control",
						{ operation: "interrupt", agentId: affectedAgentId },
						{ id: "moderator-interrupt-affected" },
					),
					fauxToolCall(
						"agent_control",
						{ operation: "interrupt", agentId: host.session.sessionId },
						{ id: "moderator-interrupt-owner" },
					),
				],
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The affected Run is held for safe diagnosis.",
					rationale: "The Hold restores an explicit progress boundary.",
				},
				{ id: "resolve-after-restoring-progress" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Moderation resolved after restoring progress."),
	]);

	const ownerPrompt = host.session.prompt("Create a Moderator supervision case.");
	t.after(async () => {
		await host.session.abort();
		await ownerPrompt;
	});
	const moderator = await waitForModerator(host);
	const observed = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "moderator-observe-affected",
	);
	assert.ok(observed.type === "message" && observed.message.role === "toolResult");
	assert.equal(observed.message.isError, false);
	const affectedAgentId = (observed.message.details as { agentId: string }).agentId;

	const controlled = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "moderator-interrupt-affected",
	);
	assert.ok(controlled.type === "message" && controlled.message.role === "toolResult");
	assert.equal(controlled.message.isError, false);
	assert.equal(
		(controlled.message.details as { disposition: string }).disposition,
		"held",
	);
	const affected = await observeStatus(host, affectedAgentId);
	assert.equal(
		affected.run.retentionReasons.some(({ reason }) => reason === "interruption_hold"),
		true,
	);

	const ownerControl = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "moderator-interrupt-owner",
	);
	assert.ok(ownerControl.type === "message" && ownerControl.message.role === "toolResult");
	assert.equal(ownerControl.message.isError, true);
	const resolution = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-after-restoring-progress",
	);
	assert.ok(resolution.type === "message" && resolution.message.role === "toolResult");
	assert.deepEqual(resolution.message.details, { disposition: "resolved" });
	assert.deepEqual(
		(await findModerators(host)).map(({ path }) => moderatorTriggerKind(path)),
		["obligation_stall"],
	);

	await host.runtime.dispose();
});

test("terminating the affected Run does not erase its durable Answer obligation", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ title: "Fixture request", request: "Leave this Answer obligation unresolved after termination." },
				{ id: "spawn-terminated-stall-agent" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The termination case is delegated."),
		fauxAssistantMessage("I settled without answering."),
		fauxAssistantMessage("I remained settled after the runtime reminder."),
		(context) => {
			const input = context.messages.flatMap((message) => {
				if (message.role !== "user") return [];
				return typeof message.content === "string"
					? [message.content]
					: message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
			}).find((content) => content.includes('"kind":"obligation_stall"'));
			assert.ok(input);
			const affectedAgentId = (JSON.parse(input) as {
				trigger: { agentId: string };
			}).trigger.agentId;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_control",
					{ operation: "terminate", agentId: affectedAgentId },
					{ id: "terminate-stalled-run" },
				),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The exact stalled Run was terminated.",
					rationale: "The durable obligation remains for a successor Run.",
				},
				{ id: "resolve-after-termination" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The terminated attempt is resolved."),
	]);

	const ownerPrompt = host.session.prompt("Create a terminated Obligation Stall.");
	t.after(async () => {
		await host.session.abort();
		await ownerPrompt;
	});
	const moderator = await waitForModerator(host);
	const termination = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "terminate-stalled-run",
	);
	assert.ok(termination.type === "message" && termination.message.role === "toolResult");
	assert.deepEqual(termination.message.details, {
		agentId: moderatorAffectedAgentId(moderator.path),
		disposition: "terminated",
		residualRequests: { incoming: 1, outgoing: 0 },
	});
	const resolution = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-after-termination",
	);
	assert.ok(resolution.type === "message" && resolution.message.role === "toolResult");
	assert.deepEqual(resolution.message.details, { disposition: "resolved" });

	await host.runtime.dispose();
});

test("a Moderator escalates through an ordinary Owner Request before Resolution", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ title: "Fixture request", request: "Leave an Answer obligation requiring Owner judgment." },
				{ id: "spawn-moderator-escalation-case" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The escalation case is delegated."),
		fauxAssistantMessage("I settled without resolving the Owner's intent."),
		fauxAssistantMessage("I remained settled after the runtime reminder."),
		fauxAssistantMessage(
			[
				fauxToolCall(
					"agent_message",
					{
						title: "Fixture request",
						operation: "request",
						targetAgent: host.session.sessionId,
						question: "Should restoring this work take priority over current Owner work?",
					},
					{ id: "moderator-request-owner-judgment" },
				),
				fauxToolCall(
					"moderator_control",
					{
						operation: "resolve",
						summary: "Owner judgment is still outstanding.",
						rationale: "Priority cannot be inferred mechanically.",
					},
					{ id: "resolve-before-owner-answer" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Owner Request is visible."),
		fauxAssistantMessage("I will wait for the Owner Answer."),
	]);

	const ownerPrompt = host.session.prompt("Create a moderation escalation case.");
	t.after(async () => {
		await host.session.abort();
		await ownerPrompt;
	});
	const moderator = await waitForModerator(host);
	const requestResult = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "moderator-request-owner-judgment",
	);
	assert.ok(requestResult.type === "message" && requestResult.message.role === "toolResult");
	assert.equal(requestResult.message.isError, false);
	const requestId = (
		requestResult.message.details as { requestMessageId: string }
	).requestMessageId;
	const requestSource = SessionManager.open(moderator.path).getEntries().find(
		(entry) => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" &&
					part.id === "moderator-request-owner-judgment",
			),
	);
	assert.ok(requestSource);
	assert.equal(
		requestId,
		deriveMessageIdentity({
			agentId: moderator.id,
			entryId: requestSource.id,
			toolCallId: "moderator-request-owner-judgment",
		}),
	);

	await waitForCondition(async () => {
		const owner = await observeStatus(host, host.session.sessionId);
		const moderatorStatus = await observeStatus(host, moderator.id);
		return owner.run.retentionReasons.some(
			({ reason }) => reason === "answer_owed",
		) && moderatorStatus.run.retentionReasons.some(
			({ reason }) => reason === "awaiting_answer",
		);
	});
	const blocked = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-before-owner-answer",
	);
	assert.ok(blocked.type === "message" && blocked.message.role === "toolResult");
	assert.deepEqual(blocked.message.details, {
		disposition: "blocked",
		predicates: ["outgoing_requests", "obligation_stall"],
	});

	assert.equal(SessionManager.open(moderator.path).getEntries().some((entry) =>
		entry.type === "custom_message" &&
		entry.customType === "agent-coordination.moderator-obligation-reminder"), false);
	host.model.setResponses([
		fauxAssistantMessage("The Owner Answer is now available to the Moderator."),
	]);
	await answerAsOwner(
		host,
		"Restore the obligated work before taking unrelated new work.",
		"answer-moderator-escalation",
	);
	await waitForCondition(async () => {
		const owner = await observeStatus(host, host.session.sessionId);
		const moderatorStatus = await observeStatus(host, moderator.id);
		return !owner.run.retentionReasons.some(
			({ reason }) => reason === "answer_owed",
		) && !moderatorStatus.run.retentionReasons.some(
			({ reason }) => reason === "awaiting_answer",
		);
	});

	await host.runtime.dispose();
});

test("external Answer clearance releases Moderator handling", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ title: "Fixture request", request: "Answer after the Owner sends one reminder." },
				{ id: "spawn-externally-cleared-agent" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The child may need a reminder."),
		fauxAssistantMessage("I settled before answering."),
		fauxAssistantMessage("I remained settled after the runtime reminder."),
		fauxAssistantMessage("I am inspecting while the obligation remains."),
	]);

	const ownerPrompt = host.session.prompt("Create an externally cleared Stall.");
	t.after(async () => {
		await host.session.abort();
		await ownerPrompt;
	});
	const moderator = await waitForModerator(host);
	await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "text" &&
					part.text === "I am inspecting while the obligation remains.",
			),
	);
	const moderatorInput = SessionManager.open(moderator.path).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(moderatorInput && moderatorInput.type === "custom_message");
	const parsedInput = JSON.parse(moderatorInput.content as string) as {
		trigger: {
			agentId: string;
			obligations: {
				sources: Array<{ agentId: string; entryId: string; toolCallId: string }>;
			};
		};
	};
	const requestSource = parsedInput.trigger.obligations.sources[0];
	assert.ok(requestSource);
	const requestId = deriveMessageIdentity(requestSource);

	const routePostReminderResponse = (context: Context) => {
		const transcript = JSON.stringify(context.messages);
		if (!getCurrentTools(context.messages).some(({ name }) => name === "ask_user")) {
			return fauxAssistantMessage("The Owner observed the externally committed Answer.");
		}
		if (transcript.includes("answer-after-reminder")) {
			return fauxAssistantMessage(
				fauxToolCall(
					"ask_user",
					{ question: "Keep this Run active after its Answer commits." },
					{ id: "wait-after-answer-clearance" },
				),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
					answer: "The reminder restored enough context to answer.",
				},
				{ id: "answer-after-reminder" },
			),
			{ stopReason: "toolUse" },
		);
	};
	// Live projections add real native rendering work to each event. Route this
	// concurrency-sensitive fixture by transcript instead of assuming which Run
	// reaches the shared faux model queue first.
	host.model.setResponses(Array.from({ length: 4 }, () => routePostReminderResponse));
	await sendOwnerMessage(
		host,
		parsedInput.trigger.agentId,
		"Please finish the Answer you still owe.",
		"remind-stalled-agent",
	);

	await waitForCondition(async () => {
		const child = await observeStatus(host, parsedInput.trigger.agentId);
		return !child.run.retentionReasons.some(
			({ reason }) => reason === "answer_owed",
		);
	});
	await sendOwnerMessage(host, parsedInput.trigger.agentId,
		"Continue the independent task after Answer clearance.", "continue-after-clearance");
	await waitForCondition(async () => {
		const child = await observeStatus(host, parsedInput.trigger.agentId);
		return child.run.phase === "live" &&
			"attention" in child.run && child.run.attention === "input_required";
	});
	assert.equal((await findModerators(host)).length, 1);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The original Answer obligation cleared independently.",
					rationale: "No mechanically qualifying obligation remains.",
				},
				{ id: "resolve-after-external-clearance" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The condition was already clear."),
	]);
	await sendOwnerMessage(
		host,
		moderator.id,
		"Record the disposition now that the obligation is clear.",
		"wake-moderator-after-clearance",
	);
	const clearedResolution = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-after-external-clearance",
	);
	assert.ok(
		clearedResolution.type === "message" &&
		clearedResolution.message.role === "toolResult",
	);
	assert.deepEqual(clearedResolution.message.details, {
		disposition: "already_cleared",
	});
	await waitForCondition(async () => {
		const status = await observeStatus(host, moderator.id);
		return status.run.phase === "live" &&
			!status.run.retentionReasons.some(
				({ reason }) => reason === "moderator_handling",
			);
	});

});

test("a cleared Stall can recur with the same obligations and receive a fresh Moderator", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ title: "Fixture request", request: "Keep this Answer obligation until after one supervised resume." },
				{ id: "spawn-recurring-stall-agent" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The recurring Stall case is delegated."),
		fauxAssistantMessage("I settled before answering."),
		fauxAssistantMessage("I remained settled after the runtime reminder."),
		fauxAssistantMessage("I am handling the first continuous Stall."),
	]);

	const ownerPrompt = host.session.prompt("Create a recurring Obligation Stall.");
	t.after(async () => {
		await host.session.abort();
		await ownerPrompt;
	});
	const firstModerator = await waitForModerator(host);
	await waitForTranscriptEntry(
		firstModerator.path,
		(entry) => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "text" &&
					part.text === "I am handling the first continuous Stall.",
			),
	);
	const affectedAgentId = moderatorAffectedAgentId(firstModerator.path);

	await controlAsOwner(host, "interrupt-recurring-stall", {
		operation: "interrupt",
		agentId: affectedAgentId,
	});
	await waitForCondition(async () => {
		const affected = await observeStatus(host, affectedAgentId);
		const moderator = await observeStatus(host, firstModerator.id);
		return affected.run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		) && !moderator.run.retentionReasons.some(
			({ reason }) => reason === "moderator_handling",
		);
	});

	host.model.setResponses([
		fauxAssistantMessage("I settled again without answering after the Hold cleared."),
		fauxAssistantMessage("I am handling the new continuous Stall."),
		// A fresh Moderator owns a fresh handling responsibility, so once it settles
		// without progress it receives its own bounded handling reminder
		// (docs/operational-incident-moderation.md, "Moderator handling reminders").
		// Script that turn here: this fixture shares one model script across every
		// child, so an unscripted reminder turn would claim the response this test
		// reserves for the cleared Moderator's Resolution.
		fauxAssistantMessage("I remain settled after the fresh handling reminder."),
	]);
	await controlAsOwner(host, "resume-recurring-stall", {
		operation: "resume",
		agentId: affectedAgentId,
		content: "Resume this exact Run, then settle without answering.",
	});
	await waitForCondition(async () => (await findModerators(host)).length === 2);
	const moderators = await findModerators(host);
	const secondModerator = moderators.find(({ id }) => id !== firstModerator.id);
	assert.ok(secondModerator);
	assert.equal(moderatorAffectedAgentId(secondModerator.path), affectedAgentId);
	const affectedEntries = SessionManager.open(
		await sessionPathFor(host, affectedAgentId),
	).getEntries();
	assert.equal(
		affectedEntries.filter(
			(entry) => entry.type === "custom_message" &&
				entry.customType === "agent-coordination.obligation-reminder",
		).length,
		1,
	);
	await waitForTranscriptEntry(
		secondModerator.path,
		(entry) => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "text" &&
					part.text === "I am handling the new continuous Stall.",
			),
	);
	await waitForTranscriptEntry(
		secondModerator.path,
		(entry) => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "text" &&
					part.text === "I remain settled after the fresh handling reminder.",
			),
	);

	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The first continuous Stall cleared under an exact Hold.",
					rationale: "The later recurrence belongs to the fresh Moderator.",
				},
				{ id: "resolve-first-continuous-stall" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The first handling attempt is resolved."),
	]);
	await sendOwnerMessage(
		host,
		firstModerator.id,
		"Resolve only your original continuous Stall.",
		"wake-first-moderator-after-recurrence",
	);
	const firstResolution = await waitForTranscriptEntry(
		firstModerator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-first-continuous-stall",
	);
	assert.ok(
		firstResolution.type === "message" && firstResolution.message.role === "toolResult",
	);
	assert.deepEqual(firstResolution.message.details, { disposition: "resolved" });

	await host.runtime.dispose();
});

test("an outgoing Request suppresses a Stall only while its responder can progress", async (t) => {
	const executionGate = await createProcessExecutionGate("external-progress");
	let targetReleased = false;
	let coordinator: WorkflowCoordinator | undefined;
	let host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>> | undefined;
	t.after(async () => {
		try {
			if (!targetReleased) await executionGate.release();
			if (coordinator && host) {
				await coordinator.shutdown(async () => host!.runtime.dispose());
			}
		} finally {
			executionGate.restoreEnvironment();
		}
	});

	host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
		additionalExtensionPaths: [
			fileURLToPath(new URL("./support/execution-gate-tool.ts", import.meta.url)),
		],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let rejectNextCreationDelivery = true;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		spawnBoundaryHooks: {
			beforeDeliveryAdmission() {
				if (!rejectNextCreationDelivery) return;
				rejectNextCreationDelivery = false;
				return "confirmed_failure";
			},
		},
	});
	const owner = coordinator.forAgent(identity.agentId);
	const target = await spawnFromView(
		host.session,
		owner,
		"spawn-progress-target",
		"Remain dormant until another Agent requests progress.",
	);
assert.equal(target.messageStatus, "not_sent");
	assert.equal(owner.status(target.agentId).run.phase, "dormant");

	const routeExternalProgress = (context: Context) => {
		const messages = JSON.stringify(context.messages);
		const latestUser = JSON.stringify(
			[...context.messages].reverse().find(({ role }) => role === "user"),
		);
		if (
			latestUser.includes("Delegate progress") &&
			!messages.includes('"id":"request-external-progress"')
		) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						title: "Fixture request",
						operation: "request",
						targetAgent: target.agentId,
						question: "Make progress while I remain obligated to the Owner.",
					},
					{ id: "request-external-progress" },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (
			latestUser.includes("Make progress while I remain obligated") &&
			!messages.includes('"id":"hold-external-progress"')
		) {
			return fauxAssistantMessage(
				fauxToolCall("execution_gate", {}, { id: "hold-external-progress" }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(
			latestUser.includes("Make progress while I remain obligated")
				? "I settled without answering the downstream Request."
				: "I am settled while the responder remains active.",
		);
	};
	host.model.setResponses(Array.from({ length: 12 }, () => routeExternalProgress));
	const affected = await spawnFromView(
		host.session,
		owner,
		"spawn-agent-with-external-progress",
		"Delegate progress, then settle without answering this Creation Request.",
	);
	assert.equal(affected.messageStatus, "sent");
	await executionGate.waitUntilStarted();
	await waitForCondition(() => {
		const run = owner.status(affected.agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	for (let attempt = 0; attempt < 50; attempt += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal((await findModerators(host!)).length, 0);

	targetReleased = true;
	await executionGate.release();
	await waitForCondition(() => {
		const run = owner.status(target.agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	await waitForModeratorForAgent(host!, affected.agentId);
});

test("a closed Request cycle is one normalized Deadlock Moderator only once no member can progress", async (t) => {
	const executionGate = await createProcessExecutionGate("active-cycle");
	let gateReleased = false;
	let coordinator: WorkflowCoordinator | undefined;
	let host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>> | undefined;
	t.after(async () => {
		try {
			if (!gateReleased) await executionGate.release();
			if (coordinator && host) {
				await coordinator.shutdown(async () => host!.runtime.dispose());
			}
		} finally {
			executionGate.restoreEnvironment();
		}
	});

	host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
		additionalExtensionPaths: [
			fileURLToPath(new URL("./support/execution-gate-tool.ts", import.meta.url)),
		],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let rejectedCreationDeliveries = 0;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		spawnBoundaryHooks: {
			beforeDeliveryAdmission() {
				if (rejectedCreationDeliveries >= 2) return;
				rejectedCreationDeliveries += 1;
				return "confirmed_failure";
			},
		},
	});
	const owner = coordinator.forAgent(identity.agentId);
	const first = await spawnFromView(
		host.session,
		owner,
		"spawn-first-active-cycle-agent",
		"Start the active-cycle probe.",
	);
	const second = await spawnFromView(
		host.session,
		owner,
		"spawn-second-active-cycle-agent",
		"Create the return dependency, then remain active.",
	);
	const rootsReady = new Set<string>();
	let releaseRoots!: () => void;
	const bothRoots = new Promise<void>(resolve => { releaseRoots = resolve; });
	t.after(releaseRoots);
	const routeActiveCycle = async (context: Context) => {
		if (getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("I will inspect the now-settled cycle.");
		}
		const messages = JSON.stringify(context.messages);
		const latestUser = JSON.stringify(
			[...context.messages].reverse().find(({ role }) => role === "user"),
		);
		if (latestUser.includes("Start the active-cycle probe.")) rootsReady.add("first");
		if (latestUser.includes("Create the return dependency, then remain active.")) rootsReady.add("second");
		if (rootsReady.size === 2) releaseRoots();
		await bothRoots;

		if (
			latestUser.includes("Start the active-cycle probe.") &&
			!messages.includes('"id":"request-first-active-cycle"')
		) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						title: "Fixture request",
						operation: "request",
						targetAgent: second.agentId,
						question: "Create the return dependency, then remain active.",
					},
					{ id: "request-first-active-cycle" },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (
			latestUser.includes("Create the return dependency, then remain active.") &&
			!messages.includes('"id":"request-second-active-cycle"')
		) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						title: "Fixture request",
						operation: "request",
						targetAgent: first.agentId,
						question: "Wait while my Run remains active.",
					},
					{ id: "request-second-active-cycle" },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (
			latestUser.includes("Create the return dependency, then remain active.") &&
			!messages.includes('"id":"gate-active-cycle"')
		) {
			return fauxAssistantMessage(
				fauxToolCall("execution_gate", {}, { id: "gate-active-cycle" }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("I settled while both cycle Requests remain unresolved.");
	};
	host.model.setResponses(Array.from({ length: 24 }, () => routeActiveCycle));
	await retryRequestFromView(host.session, owner, "deliver-first-root", first.requestMessageId);
		await retryRequestFromView(host.session, owner, "deliver-second-root", second.requestMessageId);
		await executionGate.waitUntilStarted();
	await waitForCondition(() => {
		const firstRun = owner.status(first.agentId).run;
		const secondRun = owner.status(second.agentId).run;
		return firstRun.phase === "live" && firstRun.work === "settled" &&
			secondRun.phase === "live" && secondRun.work === "active" &&
			firstRun.retentionReasons.some(({ reason }) => reason === "answer_owed") &&
			secondRun.retentionReasons.some(({ reason }) => reason === "awaiting_answer");
	});
	await owner.reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 0);

	gateReleased = true;
	await executionGate.release();
	const moderator = await waitForModeratorKind(host, "dependency_deadlock");
	await owner.reachSafeBoundary();
	// The closed component is one normalized condition: one Moderator for the whole
	// sorted Agent/Request identity set (docs/operational-incident-moderation.md:11,27,65).
	const expectedAgentIds = [first.agentId, second.agentId].sort();
	assert.deepEqual(
		(await findModerators(host)).map(({ path }) => moderatorTriggerKind(path)),
		["dependency_deadlock"],
	);
	const inputEntry = SessionManager.open(moderator.path).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(inputEntry?.type === "custom_message" && typeof inputEntry.content === "string");
	const input = JSON.parse(inputEntry.content) as {
		trigger: {
			kind: string;
			agentIds: string[];
			requests: { total: number; sources: unknown[] };
		};
		inspectedThrough: Array<{ agentId: string; entryId: string }>;
	};
	assert.equal(input.trigger.kind, "dependency_deadlock");
	assert.deepEqual(input.trigger.agentIds, expectedAgentIds);
	assert.equal(input.trigger.requests.total, 2);
	assert.equal(input.trigger.requests.sources.length, 2);
	assert.deepEqual(
		input.inspectedThrough.map(({ agentId }) => agentId),
		expectedAgentIds,
	);
	for (const agentId of expectedAgentIds) {
		const run = owner.status(agentId).run;
		assert.equal(run.phase, "live");
		assert.equal("work" in run && run.work, "settled");
		assert.equal(
			run.retentionReasons.every(
				({ reason }) => reason === "answer_owed" || reason === "awaiting_answer" || reason === "pending_delivery",
			),
			true,
		);
	}
});

test("input, Human attention, selection, and Hold prevent a blocked Request-cycle Deadlock", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator!: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		spawnBoundaryHooks: {
			beforeDeliveryAdmission: () => "confirmed_failure",
		},
	});
	const owner = coordinator.forAgent(identity.agentId);
	try {
		const participant = await spawnFromView(
			host.session,
			owner,
			"spawn-self-cycle-agent",
			"Start the self-cycle probe.",
		);
		assert.equal(participant.messageStatus, "not_sent");
		const partner = await spawnFromView(host.session, owner, "spawn-cycle-partner", "Return the unrelated cycle dependency.");
		const rootsReady = new Set<string>();
		let releaseRoots!: () => void;
		const bothRoots = new Promise<void>(resolve => { releaseRoots = resolve; });
		t.after(releaseRoots);

		const routeSelfCycle = async (context: Context) => {
			if (getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
				return fauxAssistantMessage("I will inspect the settled self-cycle.");
			}
			const messages = JSON.stringify(context.messages);
			const latestUser = JSON.stringify(
				[...context.messages].reverse().find(({ role }) => role === "user"),
			);
			const isPartner = latestUser.includes("Return the unrelated cycle dependency.");
			rootsReady.add(isPartner ? "partner" : "participant");
			if (rootsReady.size === 2) releaseRoots();
			await bothRoots;
			if (isPartner) return messages.includes('"id":"request-cycle-return"')
				? fauxAssistantMessage("The partner is settled with a blocked dependency.")
				: fauxAssistantMessage(fauxToolCall("agent_message", { title: "Fixture request", operation: "request", targetAgent: participant.agentId, question: "Return this unrelated dependency." }, { id: "request-cycle-return" }), { stopReason: "toolUse" });

			if (
				latestUser.includes("Start the self-cycle probe.") &&
				!messages.includes('"id":"request-self-cycle"')
			) {
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{
							title: "Fixture request",
							operation: "request",
							targetAgent: partner.agentId,
							question: "Wait for the other root to resolve this dependency.",
						},
						{ id: "request-self-cycle" },
					),
					{ stopReason: "toolUse" },
				);
			}
			if (
				messages.includes('"id":"request-self-cycle"') &&
				!messages.includes('"id":"pause-self-cycle"')
			) {
				return fauxAssistantMessage(
					fauxToolCall(
						"ask_user",
						{ question: "Provide input before this Run settles." },
						{ id: "pause-self-cycle" },
					),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("I am settled inside the unresolved self-cycle.");
		};
		host.model.setResponses(Array.from({ length: 16 }, () => routeSelfCycle));
		await retryRequestFromView(host.session, owner, "deliver-attention-root", participant.requestMessageId);
		await retryRequestFromView(host.session, owner, "deliver-partner-root", partner.requestMessageId);
		await waitForCondition(() => owner.humanAttention().length === 1);
		const paused = owner.status(participant.agentId).run;
		assert.equal(paused.phase, "live");
		assert.equal("attention" in paused && paused.attention, "input_required");
		await assertNoModeratorKindAtSafeBoundary(
			owner,
			host,
			"dependency_deadlock",
		);

		const selectedView = await owner.openAgentView(participant.agentId);
		assert.ok(selectedView);
		selectedView.projection().dispatchInput("Continue to settlement");
		selectedView.projection().dispatchInput("\r");
		await waitForCondition(() => {
			const run = owner.status(participant.agentId).run;
			return run.phase === "live" && run.work === "settled";
		});
		await assertNoModeratorKindAtSafeBoundary(
			owner,
			host,
			"dependency_deadlock",
		);
		await controlFromView(
			host.session,
			owner,
			"hold-settled-self-cycle",
			{ operation: "interrupt", agentId: participant.agentId },
		);
		await waitForCondition(() =>
			owner.status(participant.agentId).run.retentionReasons.some(
				({ reason }) => reason === "interruption_hold",
			)
		);
		await selectedView.close();
		await assertNoModeratorKindAtSafeBoundary(
			owner,
			host,
			"dependency_deadlock",
		);
		await controlFromView(
			host.session,
			owner,
			"resume-held-self-cycle",
			{
				operation: "resume",
				agentId: participant.agentId,
				content: "Settle again without resolving the self-cycle.",
			},
		);
		await waitForModeratorKind(host, "dependency_deadlock");
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});


test("a pre-commit Moderator bootstrap failure pauses staging until condition clearance and consumes no committed attempt", async (t) => {
	let bootstrapAttempts = 0;
	const harness = await createIncidentBoundaryHarness(t, {
		beforeModeratorBootstrapCommit: () => {
			bootstrapAttempts += 1;
			return bootstrapAttempts === 1 ? "confirmed_failure" : undefined;
		},
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
		fauxAssistantMessage("I remained settled after the obligation reminder."),
	]);
	const affected = await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-pre-commit-moderator-failure",
		"Settle with an Answer obligation.",
	);
	await waitForCondition(() => {
		const run = harness.owner.status(affected.agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	await waitForCondition(() =>
		harness.host.services.diagnostics.some(
			({ message }) => message.includes("Moderator bootstrap commit failure"),
		)
	);
	assert.equal((await findModerators(harness.host)).length, 0);

	for (let n = 0; n < 4; n++) await harness.owner.reachSafeBoundary();
	assert.equal(bootstrapAttempts, 1, "heartbeats do not retry a faulted staging attempt");
	assert.equal(harness.owner.operationalAttention().length, 1);
	const selected = await harness.owner.openAgentView(affected.agentId);
	assert.ok(selected);
	await harness.owner.reachSafeBoundary();
	assert.equal(harness.owner.operationalAttention().length, 0, JSON.stringify(harness.owner.operationalAttention()));
	harness.host.model.setResponses([
		fauxAssistantMessage("I am the first committed handling attempt for the recurring condition."),
	]);
	await selected.close();
	const moderator = await waitForModeratorForAgent(harness.host, affected.agentId);
	assert.equal(bootstrapAttempts, 2);
	const input = SessionManager.open(moderator.path).getEntries()[0];
	assert.ok(input?.type === "custom_message" && typeof input.content === "string");
	assert.equal(
		(JSON.parse(input.content) as { previousAttempt?: unknown }).previousAttempt,
		undefined,
	);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("shutdown before Moderator bootstrap prevents a post-snapshot Moderator admission", async (t) => {
	let shutdownPromise: Promise<void> | undefined;
	let harness!: Awaited<ReturnType<typeof createIncidentBoundaryHarness>>;
	harness = await createIncidentBoundaryHarness(t, {
		beforeModeratorBootstrapCommit: () => {
			shutdownPromise ??= harness.coordinator.shutdown(
				async () => harness.host.runtime.dispose(),
			);
		},
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
	]);
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-before-moderator-shutdown",
		"Settle with an Answer obligation while the host begins shutdown.",
	);
	await waitForCondition(() => shutdownPromise !== undefined);
	await shutdownPromise;

	assert.deepEqual(await findModerators(harness.host), []);
});

test("a post-commit Moderator startup failure creates one linked replacement", async (t) => {
	let startupAttempts = 0;
	const harness = await createIncidentBoundaryHarness(t, {
		beforeModeratorRunStart: () => {
			startupAttempts += 1;
			return startupAttempts === 1 ? "confirmed_failure" : undefined;
		},
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
		fauxAssistantMessage("I am the replacement Moderator."),
	]);
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-post-commit-moderator-failure",
		"Settle with an Answer obligation.",
	);
	await waitForCondition(async () => (await findModerators(harness.host)).length === 2);
	const moderators = await findModerators(harness.host);
	const first = moderators.find(({ path }) =>
		moderatorPreviousAttempt(path) === undefined
	);
	const replacement = moderators.find(({ path }) =>
		moderatorPreviousAttempt(path) !== undefined
	);
	assert.ok(first);
	assert.ok(replacement);
	assert.deepEqual(harness.owner.status(first.id).run, {
		phase: "dormant",
		retentionReasons: [],
	});
	const firstEntries = SessionManager.open(first.path).getEntries();
	assert.equal(firstEntries.length, 1);
	assert.equal(firstEntries[0]?.type, "custom_message");
	const replacementInput = SessionManager.open(replacement.path).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(
		replacementInput?.type === "custom_message" &&
			typeof replacementInput.content === "string",
	);
	assert.deepEqual(
		(JSON.parse(replacementInput.content) as {
			previousAttempt?: { agentId: string; entryId: string };
		}).previousAttempt,
		{ agentId: first.id, entryId: firstEntries.at(-1)!.id },
	);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a terminal Moderator Run error suspends the handling Moderator without a replacement", async (t) => {
	const harness = await createIncidentBoundaryHarness(t);
	const routeFailure = (context: Context) => {
		if (!getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("I settled without answering the Creation Request.");
		}
		return fauxAssistantMessage("The first Moderator Run fails terminally.", {
			stopReason: "error",
			errorMessage: "deterministic Moderator Run failure",
		});
	};
	harness.host.model.setResponses(Array.from(
		{
			length:
				harness.host.services.settingsManager.getRetrySettings().maxRetries + 6,
		},
		() => routeFailure,
	));
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-moderator-run-failure-agent",
		"Settle with an Answer obligation.",
	);
	await waitForCondition(async () => (await findModerators(harness.host)).length === 1);
	const [moderator] = await findModerators(harness.host);
	assert.ok(moderator);
	await waitForCondition(() => {
		const run = harness.owner.status(moderator.id).run;
		return run.phase === "live" && run.suspension?.reason === "runtime_error";
	});
	const suspended = harness.owner.status(moderator.id).run;
	assert.deepEqual(
		suspended.phase === "live" ? suspended.suspension : undefined,
		{
			reason: "runtime_error",
			evidence: {
				stage: "model",
				error: "deterministic Moderator Run failure",
				provenance: "pi-child-hosted-runtime",
			},
		},
	);
	assert.ok(
		suspended.phase === "live" &&
			suspended.retentionReasons.some(({ reason }) => reason === "moderator_handling"),
		"the incident stays retained by its suspended handling Moderator",
	);
	// A stop is not a failed attempt: no replacement is staged and no failure
	// evidence reaches Owner attention.
	for (let attempt = 0; attempt < 3; attempt++) {
		await harness.owner.reachSafeBoundary();
		await new Promise(resolve => setTimeout(resolve, 30));
	}
	assert.equal(
		(await findModerators(harness.host)).length,
		1,
		"a suspended Moderator is never replaced automatically",
	);
	assert.deepEqual(harness.owner.operationalAttention(), []);
	assert.deepEqual(harness.owner.reportHistory(), []);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});
test("an unopenable failed Dormant Moderator falls back to a read-only post-mortem view", async (t) => {
	initTheme("dark", false);
	// A Template is selected from current trusted discovery only at creation, and its
	// rules are captured atomically in the child Identity or Moderator Input
	// (docs/owner-workflow.md:84, cb47e58). Discovery is cached for the Workflow Owner
	// once its coordinator starts, so this Moderator can only capture the preset its
	// later Runtime preparation re-resolves while the Template already exists here.
	const agentDir = await mkdtemp(join(tmpdir(), "pi-moderator-post-mortem-"));
	const templateDirectory = join(agentDir, "agents");
	await mkdir(templateDirectory, { recursive: true });
	await writeFile(join(templateDirectory, "moderator.md"), [
		"---",
		"name: moderator",
		"models:",
		"  - id: coordination-test/deterministic-owner",
		"    thinking: low",
		"---",
		"Moderator context",
	].join("\n"));
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
		settings: { retry: { enabled: false } },
		agentDir,
	});
	const routeFailure = (context: Context) => {
		if (!getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("I settled without answering the Creation Request.");
		}
		const input = context.messages.find((message) =>
			message.role === "user" && JSON.stringify(message).includes('"trigger"')
		);
		if (JSON.stringify(input).includes('"previousAttempt"')) {
			return fauxAssistantMessage("I am the replacement Moderator.");
		}
		return fauxAssistantMessage("The first Moderator Run fails terminally.", {
			stopReason: "error",
			errorMessage: "deterministic Moderator Run failure",
		});
	};
	host.model.setResponses(Array.from({ length: 12 }, () => routeFailure));
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-failed-moderator-post-mortem-agent",
		{ title: "Fixture request", request: "Settle with an Answer obligation." },
	);
	await waitForCondition(async () => (await findModerators(host)).length === 2);
	const moderators = await findModerators(host);
	const replacement = moderators.find(({ path }) => moderatorPreviousAttempt(path));
	assert.ok(replacement);
	const failedModeratorId = moderatorPreviousAttempt(replacement.path)?.agentId;
	assert.ok(failedModeratorId);

	// A Template is selected from current trusted discovery only at creation and its
	// rules are captured atomically in the child Identity or Moderator Input
	// (docs/owner-workflow.md:84, cb47e58). Withdrawing the model this Moderator
	// captured therefore makes its later Runtime preparation unresolvable while the
	// Template it was created under stays untouched.
	host.services.modelRuntime.unregisterProvider("coordination-test");

	const ownerSession = host.runtime.session;
	const opened = await openDormantAgentView(host, failedModeratorId);
	const rendered = stripTerminalSequences(opened.view.render(80).join("\n"));
	assert.match(rendered, /Post-mortem · read-only/);
	assert.match(rendered, /Moderator/);
	assert.match(rendered, /Error:/);
	assert.match(rendered, /No configured Agent Template model is available/);
	assert.equal((await observeStatus(host, failedModeratorId)).run.phase, "dormant");
	assert.equal(host.runtime.session, ownerSession);

	opened.view.handleInput?.("a");
	await waitForCondition(() =>
		host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== opened.view
	);
	assert.match(
		stripTerminalSequences(host.ui.customSurfaces[0]!.render(80).join("\n")),
		/Tab views/,
	);
	host.ui.customSurfaces[0]!.handleInput?.("\x1b");
	await opened.command;
	assert.equal(host.ui.customSurfaces.length, 0);
	assert.equal(host.runtime.session, ownerSession);
});

test("two committed Moderator failures publish bounded Owner Attention until clearance", async (t) => {
	const harness = await createIncidentBoundaryHarness(t, {
		beforeModeratorRunStart: () => "confirmed_failure",
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
		fauxAssistantMessage("The cancellation cleared the original condition."),
	]);
	const affected = await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-exhausted-moderation-agent",
		"Settle with an Answer obligation.",
	);
	await waitForCondition(() => harness.owner.operationalAttention().length === 1);

	const moderators = await findModerators(harness.host);
	assert.equal(moderators.length, 2);
	const attention = harness.owner.operationalAttention()[0]!;
	const incidentReport = harness.owner.reportHistory()[0];
	assert.ok(incidentReport, "failed Moderator attempts produce one retained incident report");
	assert.equal(harness.owner.reportHistory().length, 1);
	assert.equal(incidentReport.findings?.filter(finding => finding.key.startsWith("moderator-failure:")).length, 2);
	harness.owner.setReportRead(incidentReport.report.reportId, true);
	assert.deepEqual(harness.owner.operationalAttention(), [attention], "reading does not clear unresolved handling");
	assert.equal(attention.trigger.kind, "obligation_stall");
	assert.deepEqual(attention.affectedAgents, [{
		agentId: affected.agentId,
		label: harness.owner.status(affected.agentId).label,
	}]);
	assert.equal(attention.diagnostics.length, 2);
	for (const pointer of attention.diagnostics) {
		const moderator = moderators.find(({ id }) => id === pointer.agentId);
		assert.ok(moderator);
		assert.equal(
			pointer.entryId,
			SessionManager.open(moderator.path).getEntries().at(-1)!.id,
		);
	}
	const replacement = moderators.find(({ id }) => id === attention.diagnostics[1]!.agentId);
	assert.ok(replacement);
	const replacementInput = SessionManager.open(replacement.path).getEntries()[0];
	assert.ok(
		replacementInput?.type === "custom_message" &&
			typeof replacementInput.content === "string",
	);
	assert.deepEqual(
		(JSON.parse(replacementInput.content) as {
			previousAttempt?: { agentId: string; entryId: string };
		}).previousAttempt,
		attention.diagnostics[0],
	);
	assert.deepEqual(
		harness.coordinator.forAgent(affected.agentId).operationalAttention(),
		[attention],
	);
	await harness.owner.reachSafeBoundary();
	assert.equal((await findModerators(harness.host)).length, 2);

	await cancelRequestFromView(
		harness.host.session,
		harness.owner,
		"clear-exhausted-moderation-condition",
		affected.requestMessageId,
	);
	await waitForCondition(() => harness.owner.operationalAttention().length === 0);
	assert.deepEqual(harness.owner.reportHistory()[0]?.report, incidentReport.report);
	assert.equal(harness.owner.reportHistory()[0]?.readAt, undefined, "clearance is new retained evidence");
	assert.ok(harness.owner.reportHistory()[0]?.findings?.some(finding => finding.key === "condition-cleared"));
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a same-obligation Stall recurrence publishes fresh attention after its prior report was read", async (t) => {
	const { host, owner } = await createIncidentBoundaryHarness(t, { beforeModeratorRunStart: () => "confirmed_failure" });
	host.model.setResponses([fauxAssistantMessage("Remain obligated."), fauxAssistantMessage("Still obligated after reminder.")]);
	const child = await spawnFromView(host.session, owner, "recurring-stall", "Remain obligated.");
	await waitForCondition(() => owner.operationalAttention().length === 1);
	const original = owner.reportHistory()[0]!;
	assert.match(original.report.symptom, /Moderator handling failed for original incident: obligation_stall/);
	owner.setReportRead(original.report.reportId, true);
	let release!: () => void;
	let started = false;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.after(() => release());
	host.model.setResponses([async () => { started = true; await gate; return fauxAssistantMessage("Still obligated after renewed activity."); }]);
	await sendMessageFromView(host.session, owner, "restart-recurring-stall", child.agentId, "Continue working, without answering yet.");
	await waitForCondition(() => started);
	await waitForCondition(() => owner.operationalAttention().length === 0);
	assert.equal(owner.reportHistory()[0]?.readAt, undefined, "condition clearance restores attention");
	owner.setReportRead(original.report.reportId, true);
	release();
	await waitForCondition(() => owner.operationalAttention().length === 1);
	assert.equal(owner.reportHistory().length, 2, "the same Request set can begin a distinct operational episode");
	assert.match(owner.reportHistory()[1]!.report.symptom, /Moderator handling failed for original incident: obligation_stall/);
	assert.equal(owner.reportHistory()[1]?.findings?.filter(finding => finding.key.startsWith("moderator-failure:")).length, 2);
	assert.ok(owner.reportHistory()[0]?.readAt);
	assert.equal(owner.reportHistory()[1]?.readAt, undefined);
	assert.deepEqual(owner.reportHistory()[0]?.report, original.report);
	const originalModeratorId = original.findings!.find(finding => finding.key.startsWith("moderator-failure:"))!.key.split(":")[1]!;
	const recurrenceFindings = owner.reportHistory()[1]!.findings;
	// A late unexpected stop in the original Moderator is a Run suspension, not a
	// failure: it publishes no finding and cannot reopen or contaminate either episode.
	host.model.setResponses([fauxAssistantMessage("The late original Run stops.", { stopReason: "error", errorMessage: "400 late original Moderator stop" })]);
	await sendMessageFromView(host.session, owner, "late-original-moderator-stop", originalModeratorId, "Inspect the original incident again.");
	await waitForCondition(() => {
		const run = owner.status(originalModeratorId).run;
		return run.phase === "live" && run.suspension?.reason === "runtime_error";
	});
	assert.equal(owner.reportHistory().length, 2, "a late stop publishes no report");
	assert.deepEqual(owner.reportHistory()[1]?.findings, recurrenceFindings, "a late stop cannot contaminate the recurrent episode");
	assert.ok(owner.reportHistory()[0]?.readAt, "a late stop publishes no evidence that could reopen its original report");
});

test("intentional child termination does not publish a Run failure report", async (t) => {
	const { host, owner, coordinator } = await createIncidentBoundaryHarness(t);
	host.model.setResponses([fauxAssistantMessage(fauxToolCall("ask_user", { question: "Wait for intentional termination." }, { id: "intentional-termination-wait" }), { stopReason: "toolUse" })]);
	const child = await spawnFromView(host.session, owner, "intentional-termination-report", "Wait for a human.");
	await waitForCondition(() => coordinator.forAgent(child.agentId).obligationFrames().length > 0);
	await controlFromView(host.session, owner, "terminate-without-failure-report", { operation: "terminate", agentId: child.agentId });
	await owner.reachSafeBoundary();
	assert.deepEqual(owner.reportHistory(), []);
	assert.deepEqual(await findModerators(host), []);
});

test("a native retry followed by success does not publish a Run failure report", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, { persistent: true, settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
	const owner = coordinator.forAgent(identity.agentId);
	const retries: boolean[] = [];
	host.session.subscribe(event => { if (event.type === "agent_end") retries.push(event.willRetry); });
	host.model.setResponses([
		fauxAssistantMessage("Transient", { stopReason: "error", errorMessage: "503 service unavailable" }),
		fauxAssistantMessage("Retry succeeded."),
	]);
	await host.session.prompt("Recover through native retry.");
	await owner.reachSafeBoundary();
	assert.deepEqual(retries, [true, false], "exercise actual native retry, not just a successful turn");
	assert.deepEqual(owner.reportHistory(), []);
});

test("startup rejection before any child error transcript retains the original failure and exact Run", async (t) => {
	const { ProcessChildSessionFactory } = await import("../src/runtime/process-child-session-factory.ts");
	const { AgentRuntimeSupervisor } = await import("../src/runtime/agent-runtime-supervisor.ts");
	const createRecord = ProcessChildSessionFactory.prototype.createAgentRecord;
	t.mock.method(ProcessChildSessionFactory.prototype, "createAgentRecord", function (this: InstanceType<typeof ProcessChildSessionFactory>, options: Parameters<typeof createRecord>[0]) {
		const record = createRecord.call(this, options);
		record.host = AgentRuntimeSupervisor.createChild({ agentId: record.identity.agentId, startSession: async () => { throw new Error("original model startup failure before child transcript"); } });
		return record;
	});
	const { host, owner } = await createIncidentBoundaryHarness(t);
	await spawnFromView(host.session, owner, "pre-transcript-failure", "Start without reaching a model.");
	const item = owner.reportHistory()[0];
	assert.ok(item);
	assert.match(item.report.symptom, /Run 1/);
	assert.match(item.report.suspectedDefect, /original model startup failure before child transcript/);
	assert.match(item.report.suspectedDefect, /stage: startup/);
	assert.equal((await findModerators(host)).length, 0);
	const child = owner.selectionRoster().dormant.find(record => record.agentId !== owner.status().agentId);
	assert.ok(child);
	const entries = SessionManager.open((await sessionPathFor(host, child.agentId))).getEntries();
	assert.equal(entries.some(entry => entry.type === "message" && entry.message.role === "assistant"), false);
	owner.setReportRead(item.report.reportId, true);
	const manager = SessionManager.open(host.session.sessionManager.getSessionFile()!);
	const reopened = new ModeratorReportStore({ transcript: transcriptFromSessionManager(manager), appendCustomEntry: (type, data) => manager.appendCustomEntry(type, data) });
	assert.deepEqual(reopened.history(), owner.reportHistory());
});

test("an un-obligated terminal Run error suspends without widening Moderator eligibility", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	const terminalFailure = (message: string, errorMessage: string) =>
		fauxAssistantMessage(message, {
			stopReason: "error",
			errorMessage,
		});
	host.model.setResponses(Array.from(
		{ length: host.services.settingsManager.getRetrySettings().maxRetries + 4 },
		() => terminalFailure(
			"Failed without obligations",
			"400 deterministic un-obligated terminal failure",
		),
	));
	await host.session.prompt("Fail this Owner Run without delegating anything.");
	await waitForCondition(async () => {
		const run = (await observeStatus(host, host.session.sessionId)).run;
		return run.phase === "live" && run.suspension?.reason === "runtime_error";
	});
	const suspended = (await observeStatus(host, host.session.sessionId)).run;
	assert.deepEqual(suspended.suspension, {
		reason: "runtime_error",
		evidence: {
			stage: "model",
			error: "400 deterministic un-obligated terminal failure",
			provenance: "in-process-hosted-runtime",
		},
	});
	assert.deepEqual(await findModerators(host), []);
	const reports = new ModeratorReportStore({
		transcript: transcriptFromSessionManager(host.session.sessionManager),
		appendCustomEntry: (type, data) =>
			host.session.sessionManager.appendCustomEntry(type, data),
	});
	assert.deepEqual(reports.history(), []);

	// Repeated observation of the stop must not widen Moderator eligibility.
	await host.session.waitForIdle();
	assert.deepEqual(await findModerators(host), []);
	assert.deepEqual(reports.history(), []);

	// An explicit human resume clears the stop and lets the Run continue.
	host.model.setResponses([
		fauxAssistantMessage("Recovered after explicit resumption."),
		fauxAssistantMessage("The resumed Run settled."),
	]);
	await host.session.prompt("Resume this Owner Run after the provider error.", {
		source: "interactive",
	});
	await waitForCondition(async () => {
		const run = (await observeStatus(host, host.session.sessionId)).run;
		return run.suspension === undefined;
	});
	await waitForCondition(() =>
		JSON.stringify(host.session.sessionManager.getEntries()).includes(
			"Recovered after explicit resumption.",
		)
	);
	assert.deepEqual(await findModerators(host), []);
	assert.deepEqual(reports.history(), []);
});

test("selected-child native quit fences Workflow shutdown before exit and creates no Moderator", async (t) => {
	const harness = await createIncidentBoundaryHarness(t);
	harness.host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", {
			question: "Keep this Creation Request open until the human decides.",
		}, { id: "quit-child-human-request" }), { stopReason: "toolUse" }),
	]);
	const child = await spawnFromView(
		harness.host.session, harness.owner, "spawn-selected-quitter", "Wait for human direction.",
	);
	const view = await harness.owner.openAgentView(child.agentId);
	assert.ok(view);
	await waitForCondition(() => harness.coordinator.forAgent(child.agentId).obligationFrames().length > 0);
	harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_wait", {}, { id: "wait-for-quitting-child" }), { stopReason: "toolUse" },
	));
	const waiting = assert.rejects(
		harness.owner.wait("wait-for-quitting-child", {}, new AbortController().signal),
		/Workflow is shutting down/,
	);
	await waitForCondition(() => {
		const run = harness.owner.status().run;
		return "attention" in run && run.attention === "agent_wait";
	});
	// Exercise native Pi shutdown through the actual child PTY, not a synthetic Run end.
	let shutdownAtExit: boolean | undefined;
	let cleanup: Promise<void> | undefined;
	view.projection().addExitRequestHandler(() => {
		shutdownAtExit = harness.coordinator.ownerShutdownSignal().aborted;
		cleanup = harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
	});
	view.projection().dispatchInput("/quit\r");
	await waitForCondition(() => shutdownAtExit !== undefined);
	assert.equal(shutdownAtExit, true, "Workflow must be fenced before presentation observes process exit");
	await waiting;
	await cleanup;
	assert.equal(harness.owner.status(child.agentId).run.phase, "dormant");
	assert.equal(harness.owner.status().run.phase, "dormant");
	assert.deepEqual(await findModerators(harness.host), []);
});

test("an unselected child's native quit remains Run Failure rather than Workflow shutdown", async (t) => {
	const harness = await createIncidentBoundaryHarness(t);
	harness.host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", {
			question: "Keep the child obligated.",
		}, { id: "unselected-quit-human-request" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Investigate the unexpected child exit."),
	]);
	const child = await spawnFromView(
		harness.host.session, harness.owner, "spawn-unselected-quitter", "Wait for human direction.",
	);
	const view = await harness.owner.openAgentView(child.agentId);
	assert.ok(view);
	await waitForCondition(() => harness.coordinator.forAgent(child.agentId).obligationFrames().length > 0);
	const projection = view.projection();
	await view.close();
	// Simulate a child-local quit while the terminal is no longer selected.
	projection.dispatchInput("/quit\r");
	await waitForModeratorKind(harness.host, "run_failure");
	assert.equal(harness.coordinator.ownerShutdownSignal().aborted, false);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("orderly shutdown closes exhausted Operational Attention", async (t) => {
	const harness = await createIncidentBoundaryHarness(t, {
		beforeModeratorRunStart: () => "confirmed_failure",
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
	]);
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-operational-attention-before-shutdown",
		"Settle with an Answer obligation until Owner Attention is required.",
	);
	await waitForCondition(() => harness.owner.operationalAttention().length === 1);
	const moderator = (await findModerators(harness.host))[0];
	assert.ok(moderator);
	let markNativeDisposalStarted!: () => void;
	const nativeDisposalStarted = new Promise<void>((resolve) => {
		markNativeDisposalStarted = resolve;
	});
	let releaseNativeDisposal!: () => void;
	const nativeDisposalGate = new Promise<void>((resolve) => {
		releaseNativeDisposal = resolve;
	});
	const shutdown = harness.coordinator.shutdown(async () => {
		markNativeDisposalStarted();
		await nativeDisposalGate;
		await harness.host.runtime.dispose();
	});
	await nativeDisposalStarted;

	await assert.rejects(
		async () => harness.coordinator.forModerator(moderator.id).moderatorControl(
			"moderator-control-after-shutdown",
			{ operation: "resolve", summary: "Too late", rationale: "Host is closing" },
		),
		/host_shutting_down/,
	);
	releaseNativeDisposal();
	await shutdown;

	assert.deepEqual(harness.owner.operationalAttention(), []);
});

async function waitForModerator(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): Promise<{ id: string; path: string }> {
	const deadline = Date.now() + CONDITION_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const moderators = await findModerators(host);
		if (moderators[0]) return moderators[0];
		await waitForConditionPoll();
	}
	throw new Error("Expected an Obligation Stall Moderator");
}

function renderProcessExecutionGateExtension(
	startedPath: string,
	releasePath: string,
	executionMode = "sequential",
): string {
	return `
import { access, writeFile } from "node:fs/promises";

export default function registerExecutionGateTool(pi) {
	pi.registerTool({
		name: "execution_gate",
		label: "Execution gate",
		description: "Hold one real hosted Agent execution at an observable tool boundary.",
		executionMode: "${executionMode}",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			await writeFile(${JSON.stringify(startedPath)}, "started", "utf8");
			while (true) {
				try {
					await access(${JSON.stringify(releasePath)});
					break;
				} catch (error) {
					if (!error || error.code !== "ENOENT") throw error;
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
			}
			return {
				content: [{ type: "text", text: "Execution gate released." }],
				details: undefined,
			};
		},
	});
}
`;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) return false;
		throw error;
	}
}

async function createProcessExecutionGate(name: string): Promise<Readonly<{
	waitUntilStarted(): Promise<void>;
	release(): Promise<void>;
	restoreEnvironment(): void;
}>> {
	const root = await mkdtemp(join(tmpdir(), `pi-process-execution-gate-${name}-`));
	const startedPath = join(root, "started.json");
	const releasePath = join(root, "release");
	const previousStartedPath = process.env[EXECUTION_GATE_STARTED_PATH_VARIABLE];
	const previousReleasePath = process.env[EXECUTION_GATE_RELEASE_PATH_VARIABLE];
	process.env[EXECUTION_GATE_STARTED_PATH_VARIABLE] = startedPath;
	process.env[EXECUTION_GATE_RELEASE_PATH_VARIABLE] = releasePath;
	let released = false;

	return Object.freeze({
		async waitUntilStarted() {
			let childPid: number | undefined;
			await waitForCondition(async () => {
				if (!await fileExists(startedPath)) return false;
				let evidence: { pid?: unknown };
				try {
					evidence = JSON.parse(await readFile(startedPath, "utf8")) as {
						pid?: unknown;
					};
				} catch (error) {
					if (error instanceof SyntaxError) return false;
					throw error;
				}
				if (typeof evidence.pid !== "number") return false;
				childPid = evidence.pid;
				return true;
			});
			assert.notEqual(childPid, process.pid);
		},
		async release() {
			if (released) return;
			released = true;
			await writeFile(releasePath, "released\n", { mode: 0o600 });
		},
		restoreEnvironment() {
			if (previousStartedPath === undefined) {
				delete process.env[EXECUTION_GATE_STARTED_PATH_VARIABLE];
			} else {
				process.env[EXECUTION_GATE_STARTED_PATH_VARIABLE] = previousStartedPath;
			}
			if (previousReleasePath === undefined) {
				delete process.env[EXECUTION_GATE_RELEASE_PATH_VARIABLE];
			} else {
				process.env[EXECUTION_GATE_RELEASE_PATH_VARIABLE] = previousReleasePath;
			}
		},
	});
}

async function waitForModeratorKind(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	kind: string,
): Promise<{ id: string; path: string }> {
	const deadline = Date.now() + CONDITION_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		for (const moderator of await findModerators(host)) {
			if (moderatorTriggerKind(moderator.path) === kind) return moderator;
		}
		await waitForConditionPoll();
	}
	throw new Error(`Expected a ${kind} Moderator`);
}

async function assertNoModeratorKindAtSafeBoundary(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	kind: string,
): Promise<void> {
	await view.reachSafeBoundary();
	assert.equal(
		(await findModerators(host)).some(
			({ path }) => moderatorTriggerKind(path) === kind,
		),
		false,
	);
}

async function waitForModeratorForAgent(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
): Promise<{ id: string; path: string }> {
	const deadline = Date.now() + CONDITION_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		for (const moderator of await findModerators(host)) {
			const input = SessionManager.open(moderator.path).getEntries().find(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "agent-coordination.moderator-input",
			);
			if (
				input?.type === "custom_message" &&
				typeof input.content === "string" &&
				(JSON.parse(input.content) as { trigger?: { agentId?: string } }).trigger
					?.agentId === agentId
			) return moderator;
		}
		await waitForConditionPoll();
	}
	throw new Error(`Expected an Obligation Stall Moderator for Agent ${agentId}`);
}

async function spawnFromView(
	session: AgentSession,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	toolCallId: string,
	request: string,
): Promise<{
	messageStatus: "sent" | "not_sent" | "unknown";
	agentId: string;
	requestMessageId: string;
}> {
	const input = { title: "Fixture request", request };
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.spawn(toolCallId, input);
	if (receipt.spawnStatus === "not_created") {
		throw new Error(`Agent Spawn ${toolCallId} did not create an Agent identity`);
	}
	const agentId = receipt.spawnStatus === "unknown"
		? receipt.candidateAgentId
		: "agentId" in receipt ? receipt.agentId : undefined;
	const requestMessageId = receipt.spawnStatus === "unknown"
		? receipt.candidateRequestMessageId
		: "requestMessageId" in receipt ? receipt.requestMessageId : undefined;
	if (typeof agentId !== "string" || typeof requestMessageId !== "string") {
		throw new Error(`Agent Spawn ${toolCallId} did not commit an Agent identity`);
	}
	return {
		messageStatus: receipt.spawnStatus === "unknown"
			? "unknown"
			: receipt.messageStatus,
		agentId,
		requestMessageId,
	};
}

async function cancelRequestFromView(
	session: AgentSession,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	toolCallId: string,
	requestId: string,
): Promise<void> {
	const input = {
		operation: "cancel" as const,
		requestMessageId: requestId,
		reason: "The Creation Request is no longer needed.",
	};
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.message(toolCallId, input);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
}

async function sendMessageFromView(
	session: AgentSession,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	toolCallId: string,
	targetAgentId: string,
	content: string,
): Promise<void> {
	const input = { operation: "send" as const, targetAgent: targetAgentId, content };
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.message(toolCallId, input);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
}

async function controlFromView(
	session: AgentSession,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	toolCallId: string,
	input:
		| { operation: "interrupt"; agentId: string }
		| { operation: "resume"; agentId: string; content: string }
		| { operation: "terminate"; agentId: string },
): Promise<void> {
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	await view.control(toolCallId, input);
}

async function createIncidentBoundaryHarness(
	t: TestCleanupRegistrar,
	incidentBoundaryHooks: {
		beforeEvidenceInspection?(): void | Promise<void>;
		beforeModeratorBootstrapCommit?(): void | "confirmed_failure";
		beforeModeratorRunStart?(): void | "confirmed_failure";
	} = {},
	options: Partial<ConstructorParameters<typeof WorkflowCoordinator>[2]> = {},
) {
	// Production always registers the startup hook, so an idle custom delivery can be
	// returned for its own empty extension-origin kickoff prompt. Without it the
	// admission correctly rejects the delivery as custom_startup_not_started.
	const host = await createUnboundTestOwnerHost(t, (pi) => { registerSessionStartup(pi); }, {
		persistent: true,
		processVisibleModel: true,
		implicitModeratorResponses: false,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator!: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		incidentBoundaryHooks,
		...options,
	});
	return { host, coordinator, owner: coordinator.forAgent(identity.agentId) };
}

async function findModerators(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): Promise<Array<{ id: string; path: string }>> {
	const sessionDirectory = host.session.sessionManager.getSessionDir();
	const workflowDirectory = `${sessionDirectory}/pi-durable-subagents/${host.session.sessionId}`;
	const sessions = await SessionManager.list(host.cwd, workflowDirectory);
	return sessions.flatMap(({ id, path }) => {
		const isModerator = SessionManager.open(path).getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.moderator-input",
		);
		return isModerator ? [{ id, path }] : [];
	});
}

async function transcriptTailFor(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
): Promise<string> {
	const sessionPath = await sessionPathFor(host, agentId);
	const tail = SessionManager.open(sessionPath).getEntries().at(-1);
	assert.ok(tail);
	return tail.id;
}

async function sessionPathFor(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
): Promise<string> {
	const sessionDirectory = host.session.sessionManager.getSessionDir();
	const workflowDirectory = `${sessionDirectory}/pi-durable-subagents/${host.session.sessionId}`;
	const session = (await SessionManager.list(host.cwd, workflowDirectory)).find(
		(candidate) => candidate.id === agentId,
	);
	assert.ok(session);
	return session.path;
}

async function waitForTranscriptEntry(
	sessionFile: string,
	predicate: (
		entry: ReturnType<SessionManager["getEntries"]>[number],
	) => boolean,
) {
	const deadline = Date.now() + CONDITION_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const entry = SessionManager.open(sessionFile).getEntries().find(predicate);
		if (entry) return entry;
		await waitForConditionPoll();
	}
	throw new Error("Expected Moderator transcript entry did not commit");
}

async function sendOwnerMessage(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	targetAgentId: string,
	content: string,
	toolCallId: string,
): Promise<void> {
	const input = { operation: "send" as const, targetAgent: targetAgentId, content };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const message = host.session.getToolDefinition("agent_message");
	assert.ok(message);
	const result = await message.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: result.content,
		details: result.details as JsonValue,
		isError: false,
		timestamp: Date.now(),
	});
}

async function controlAsOwner(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	toolCallId: string,
	input:
		| { operation: "interrupt"; agentId: string }
		| { operation: "resume"; agentId: string; content: string },
): Promise<void> {
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const control = host.session.getToolDefinition("agent_control");
	assert.ok(control);
	await control.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
}

function moderatorAffectedAgentId(sessionFile: string): string {
	const input = SessionManager.open(sessionFile).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(input?.type === "custom_message" && typeof input.content === "string");
	return (JSON.parse(input.content) as { trigger: { agentId: string } }).trigger.agentId;
}

function moderatorPreviousAttempt(
	sessionFile: string,
): { agentId: string; entryId: string } | undefined {
	const input = SessionManager.open(sessionFile).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(
		input?.type === "custom_message" && typeof input.content === "string",
	);
	return (JSON.parse(input.content) as {
		previousAttempt?: { agentId: string; entryId: string };
	}).previousAttempt;
}

function moderatorTriggerKind(sessionFile: string): string {
	const input = SessionManager.open(sessionFile).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(input?.type === "custom_message" && typeof input.content === "string");
	return (JSON.parse(input.content) as { trigger: { kind: string } }).trigger.kind;
}

async function answerAsOwner(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	answer: string,
	toolCallId: string,
): Promise<void> {
	const input = {
		operation: "answer" as const, requestId: obligationStack(transcriptFromSessionManager(host.session.sessionManager).inspect(), host.session.sessionId).at(-1)!.requestId,
		answer,
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const message = host.session.getToolDefinition("agent_message");
	assert.ok(message);
	const result = await message.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: result.content,
		details: result.details as JsonValue,
		isError: false,
		timestamp: Date.now(),
	});
}

async function observeStatus(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
): Promise<{
	run:
		| { phase: "dormant"; retentionReasons: readonly []; suspension?: undefined }
		| {
			phase: "starting" | "ending";
			retentionReasons: ReadonlyArray<{ reason: string; count: number }>;
			suspension?: undefined;
		}
		| {
			phase: "live";
			work: "active" | "settled";
			suspension?: {
				reason: string;
				evidence: { stage: string; error: string; provenance: string };
			};
			retentionReasons: ReadonlyArray<{ reason: string; count: number }>;
		};
}> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const result = await observe.execute(
		`observe-${agentId}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return result.details as Awaited<ReturnType<typeof observeStatus>>;
}

function runSuspension(run: AgentRunState) {
	return run.phase === "dormant" ? undefined : run.suspension;
}

async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + CONDITION_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await waitForConditionPoll();
	}
	throw new Error("Expected incident condition did not become true");
}

async function waitForConditionPoll(): Promise<void> {
	await new Promise<void>((resolve) =>
		setTimeout(resolve, CONDITION_POLL_INTERVAL_MS)
	);
}

test("blocked Delivery failure moderates an upstream obligated parent immediately", async (t) => {
	const clock = new ControllableOperationReviewClock();
	const requestDispatches: string[] = [];
	let blockedRequestId = "";
	const { host, coordinator, owner } = await createIncidentBoundaryHarness(t, {}, {
		deliveryProgressClock: clock,
		messageBoundaryHooks: {
			scheduleDeliveryDispatch(context, dispatch) {
				if (context.kind === "request") {
					requestDispatches.push(context.messageId);
					if (requestDispatches.length > 1) {
						blockedRequestId = context.messageId;
						throw new Error("controlled pre-dispatch failure");
					}
				}
				dispatch();
			},
		},
	});
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", {
			title: "Fixture request",
			request: "Do the leaf work.", label: "Blocked Leaf",
		}, { id: "spawn-blocked-leaf" }), { stopReason: "toolUse" }),
		// Agent Wait explicitly renews undelivered Requests; settle instead to isolate moderation.
		fauxAssistantMessage("The leaf remains responsible for the work; do not retry delivery."),
		fauxAssistantMessage("Investigate the blocked delivery, without retrying."),
	]);
	const parent = await spawnFromView(host.session, owner, "spawn-obligated-parent", "Delegate, then leave the blocked Request outstanding without retrying.");
	const moderator = await waitForModeratorKind(host, "delivery_stall");
	const inputEntry = SessionManager.open(moderator.path).getEntries().find(
		(entry) => entry.type === "custom_message" && entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(inputEntry?.type === "custom_message");
	const input = JSON.parse(inputEntry.content as string);
	assert.equal(input.trigger.delivery.messageId, blockedRequestId);
	assert.equal(input.trigger.reason.kind, "scheduling_failure");
	assert.ok(input.trigger.agentIds.includes(parent.agentId));
	assert.ok(input.trigger.requests.sources.some((source: { toolCallId: string }) => source.toolCallId === "spawn-obligated-parent"));
	assert.ok(input.trigger.requests.sources.some((source: { toolCallId: string }) => source.toolCallId === "spawn-blocked-leaf"));

	const parentView = coordinator.forAgent(parent.agentId);
	for (let pass = 0; pass < 3; pass++) await parentView.reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 1);
	assert.deepEqual(requestDispatches, [parent.requestMessageId, blockedRequestId],
		"moderation must not renew either Creation Request");
	const leafTranscript = transcriptFromSessionManager(SessionManager.open(
		await sessionPathFor(host, input.trigger.delivery.recipientAgentId),
	)).inspect();
	assert.deepEqual(obligationStack(leafTranscript, input.trigger.delivery.recipientAgentId), [],
		"the undelivered leaf must not acquire an Answer obligation");
	const parentRun = parentView.status(parent.agentId).run;
	assert.ok(parentRun.phase === "live" && parentRun.work === "settled");
	assert.ok(parentRun.retentionReasons.some(({ reason }) => reason === "answer_owed"));
	assert.ok(parentRun.retentionReasons.some(({ reason }) => reason === "awaiting_answer"));
});

test("blocked Delivery deadline catches a silent leaf while its obligated parent parks in agent_wait", async (t) => {
	const clock = new ControllableOperationReviewClock();
	const scheduledRequestIds = new Set<string>();
	let blockedRequestId = "";
	const { host, coordinator, owner } = await createIncidentBoundaryHarness(t, {}, {
		deliveryProgressClock: clock,
		workflowPolicy: new WorkflowPolicyStore(parseWorkflowPolicy('{"deliveryProgressIntervalMs":1000}')),
		messageBoundaryHooks: {
			scheduleDeliveryDispatch(context, dispatch) {
				if (context.kind === "request") {
					scheduledRequestIds.add(context.messageId);
					if (scheduledRequestIds.size > 1) {
						blockedRequestId ||= context.messageId;
						return;
					}
				}
				dispatch();
			},
		},
	});
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "Leaf work." }, { id: "silent-leaf" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: "silent-leaf-wait" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Investigate the silent delivery."),
	]);
	const parent = await spawnFromView(host.session, owner, "silent-parent", "Delegate then join.");
	await waitForCondition(() => {
		const run = owner.status(parent.agentId).run;
		return run.phase === "live" && run.attention === "agent_wait";
	});
	await owner.reachSafeBoundary();
	clock.advanceBy(999);
	await assertNoModeratorKindAtSafeBoundary(owner, host, "delivery_stall");
	// Transcript polls and lifecycle safe-boundary heartbeats are not progress.
	for (let n = 0; n < 3; n++) await owner.reachSafeBoundary();
	await assertNoModeratorKindAtSafeBoundary(owner, host, "delivery_stall");
	clock.advanceBy(1);
	const moderator = await waitForModeratorKind(host, "delivery_stall");
	const entry = SessionManager.open(moderator.path).getEntries()[0];
	assert.ok(entry?.type === "custom_message");
	const trigger = JSON.parse(entry.content as string).trigger;
	assert.equal(trigger.delivery.messageId, blockedRequestId);
	assert.ok(trigger.agentIds.includes(parent.agentId));
	assert.deepEqual(trigger.reason, {
		kind: "progress_deadline", stage: "eligible", intervalMs: 1000,
	});
	clock.advanceBy(10_000);
	await coordinator.forAgent(parent.agentId).reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 1);
	// Parked Wait may revisit the same pending scheduling; those visits are not new
	// Messages or Delivery progress. The settled-parent test isolates moderation retries.
	assert.deepEqual([...scheduledRequestIds], [parent.requestMessageId, blockedRequestId]);
	const leafTranscript = transcriptFromSessionManager(SessionManager.open(
		await sessionPathFor(host, trigger.delivery.recipientAgentId),
	)).inspect();
	assert.deepEqual(obligationStack(leafTranscript, trigger.delivery.recipientAgentId), [],
		"the silent leaf must remain undelivered after deadline moderation");
	const parentRun = owner.status(parent.agentId).run;
	assert.ok(parentRun.phase === "live" && parentRun.attention === "agent_wait");
	assert.ok(parentRun.retentionReasons.some(({ reason }) => reason === "answer_owed"));
	assert.ok(parentRun.retentionReasons.some(({ reason }) => reason === "awaiting_answer"));
});

test("blocked Delivery Moderator creation failure reports original incident before any Moderator commits", async (t) => {
	let requests = 0;
	let bootstrapAttempts = 0;
	let inspectionUnavailable = false;
	const { host, owner } = await createIncidentBoundaryHarness(t, {
		beforeEvidenceInspection() { if (inspectionUnavailable) throw new Error("Inspection failed with known handling"); },
		beforeModeratorBootstrapCommit: () => { bootstrapAttempts++; return "confirmed_failure"; },
	}, {
		messageBoundaryHooks: {
			scheduleDeliveryDispatch(context, dispatch) {
				if (context.kind === "request" && ++requests > 1) throw new Error("controlled blocked delivery");
				dispatch();
			},
		},
	});
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "Leaf work." }, { id: "unavailable-leaf" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Await the leaf."),
	]);
	await spawnFromView(host.session, owner, "unavailable-parent", "Delegate.");
	await waitForCondition(() => owner.operationalAttention().length > 0);
	const attention = owner.operationalAttention();
	assert.equal(attention.length, 1);
	assert.equal(attention[0]?.trigger.kind, "moderation_unavailable");
	assert.ok(attention[0]?.diagnostics.length);
	const item = owner.reportHistory()[0];
	assert.ok(item);
	assert.match(item.report.symptom, /delivery_stall/);
	assert.match(item.report.symptom, /Why moderation was triggered: .*Delivery.*unresolved Answer Obligation/);
	assert.match(item.report.symptom, /unavailable-leaf/);
	for (const agent of attention[0]!.affectedAgents) {
		assert.ok(item.report.symptom.includes(agent.agentId));
		assert.ok(item.report.symptom.includes(agent.label));
	}
	assert.match(item.report.suspectedDefect, /Moderator bootstrap commit/);
	assert.match(item.report.recoveryActions, /Committed Moderator attempts: 0 of 2/);
	assert.match(item.report.recoveryActions, /Known Moderator: none committed/);
	assert.match(item.report.evidence.join("\n"), /unavailable-leaf/);
	owner.setReportRead(item.report.reportId, true);
	for (let n = 0; n < 3; n++) await owner.reachSafeBoundary();
	assert.deepEqual(owner.operationalAttention(), attention);
	assert.equal(owner.reportHistory().length, 1);
	assert.ok(owner.reportHistory()[0]?.readAt);
	assert.equal(bootstrapAttempts, 1, "deduplication also prevents repeated staging effects");
	assert.equal((await findModerators(host)).length, 0);
	inspectionUnavailable = true;
	await owner.reachSafeBoundary();
	const inspectionReport = owner.reportHistory()[1]?.report;
	assert.ok(inspectionReport);
	assert.match(inspectionReport.symptom, /delivery_stall/);
	assert.doesNotMatch(inspectionReport.symptom, /No trigger or affected Request graph was established/);
	assert.match(inspectionReport.uncertainty, /not revalidated/);
});

test("moderation evidence failure publishes one acknowledgeable runtime report per continuous fault", async (t) => {
	let unavailable = false;
	const { host, owner } = await createIncidentBoundaryHarness(t, {
		beforeEvidenceInspection() { if (unavailable) throw new Error("controlled evidence read failure"); },
	});
	// Native Pi persistence begins with an assistant entry, independently of incident discovery.
	host.session.sessionManager.appendMessage(fauxAssistantMessage("Owner session started; no incident established."));
	unavailable = true;
	for (let n = 0; n < 3; n++) await owner.reachSafeBoundary();
	const attention = owner.operationalAttention();
	assert.equal(attention.length, 1);
	assert.equal(attention[0]?.trigger.kind, "moderation_unavailable");
	assert.deepEqual(attention[0]?.affectedAgents, [], "Owner hosts the diagnostic, not an invented incident");
	const item = owner.reportHistory()[0];
	assert.ok(item);
	assert.equal(item.report.reporter, undefined);
	assert.equal(item.report.source.kind, "runtime_diagnostic");
	assert.match(item.report.symptom, /No trigger or affected Request graph was established/);
	assert.match(item.report.suspectedDefect, /controlled evidence read failure/);
	owner.setReportRead(item.report.reportId, true);
	for (let n = 0; n < 3; n++) await owner.reachSafeBoundary();
	assert.equal(owner.reportHistory().length, 1);
	assert.ok(owner.reportHistory()[0]?.readAt);
	assert.deepEqual(owner.operationalAttention(), attention, "read does not clear live fault");
	const diagnosticId = attention[0]?.diagnostics[0]?.entryId;
	assert.equal(item.report.source.entryId, diagnosticId);
	assert.equal(item.report.source.transcriptPath, host.session.sessionManager.getSessionFile());
	const snapshot = JSON.parse(JSON.stringify(createAgentSelectorSnapshot(owner)));
	assert.ok(Check(agentControlMethods["presentation.agents.snapshot"].response, snapshot));
	assert.deepEqual(snapshot.reports, owner.reportHistory());
	const reopenedManager = SessionManager.open(host.session.sessionManager.getSessionFile()!);
	const reopened = new ModeratorReportStore({
		transcript: transcriptFromSessionManager(reopenedManager),
		appendCustomEntry: (type, data) => reopenedManager.appendCustomEntry(type, data),
	});
	assert.deepEqual(reopened.history(), owner.reportHistory(), "runtime report and acknowledgement survive cold transcript recovery");
	const diagnostic = host.session.sessionManager.getEntry(diagnosticId!);
	assert.ok(diagnostic?.type === "custom");
	assert.match(JSON.stringify(diagnostic.data), /controlled evidence read failure/);
	assert.match(JSON.stringify(diagnostic.data), /stack/);
	assert.equal(host.services.diagnostics.filter(({message}) => message.includes("controlled evidence read failure")).length, 1);
	unavailable = false;
	await owner.reachSafeBoundary();
	assert.deepEqual(owner.operationalAttention(), []);
	assert.ok(owner.reportHistory()[0]?.readAt);
	unavailable = true;
	await owner.reachSafeBoundary();
	const recurrence = owner.reportHistory();
	assert.equal(recurrence.length, 2);
	assert.notEqual(recurrence[1]?.report.reportId, item.report.reportId);
	assert.equal(recurrence[1]?.readAt, undefined);
});

test("blocked Delivery meaningful reservation resets its deadline and transcript proof clears handling without duplicate Delivery", async (t) => {
	const clock = new ControllableOperationReviewClock();
	const policy = new WorkflowPolicyStore(parseWorkflowPolicy('{"deliveryProgressIntervalMs":1000}'));
	let requests = 0;
	let dispatchRequest: (() => void) | undefined;
	let releaseSteer: (() => Promise<void>) | undefined;
	let releaseOwner!: () => void;
	const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });
	t.after(() => releaseOwner());
	const { host, coordinator, owner } = await createIncidentBoundaryHarness(t, {}, {
		deliveryProgressClock: clock,
		workflowPolicy: policy,
		messageBoundaryHooks: {
			scheduleDeliveryDispatch(context, dispatch) {
				if (context.kind === "request" && ++requests > 1) { dispatchRequest = dispatch; return; }
				dispatch();
			},
			afterSteerFreeze(context) { releaseSteer = context.release; return "defer"; },
		},
	});
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_message", {
			title: "Fixture request",
			operation: "request", targetAgent: "Owner", question: "Decide this dependency.", deliveryMode: "steer",
		}, { id: "steer-progress-request" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: "steer-progress-wait" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Inspect the held reservation."),
		async () => { await ownerGate; return fauxAssistantMessage("Owner work remains ordinary model duration."); },
	]);
	const parent = await spawnFromView(host.session, owner, "steer-progress-parent", "Ask Owner then join.");
	await waitForCondition(() => !!dispatchRequest);
	const parentView = coordinator.forAgent(parent.agentId);
	await parentView.reachSafeBoundary();
	clock.advanceBy(999);
	assert.equal((await findModerators(host)).length, 0);
	policy.publish(parseWorkflowPolicy('{"deliveryProgressIntervalMs":5000}'));
	dispatchRequest!();
	await waitForCondition(() => !!releaseSteer);
	await parentView.reachSafeBoundary();
	clock.advanceBy(999);
	await parentView.reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 0);
	clock.advanceBy(1);
	const moderator = await waitForModeratorKind(host, "delivery_stall");
	const first = SessionManager.open(moderator.path).getEntries()[0];
	assert.ok(first?.type === "custom_message");
	assert.equal(JSON.parse(first.content as string).trigger.reason.stage, "reserved");
	await releaseSteer!();
	await waitForCondition(() => host.session.sessionManager.getEntries().some(
		(entry) => entry.type === "custom_message" && entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details).includes("steer-progress-request"),
	));
	await parentView.reachSafeBoundary();
	await waitForCondition(() => !owner.status(moderator.id).run.retentionReasons.some(({reason}) => reason === "moderator_handling"));
	clock.advanceBy(10_000);
	await parentView.reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 1, "committed Delivery ends timing even while model work continues");
	assert.equal(host.session.sessionManager.getEntries().filter(
		(entry) => entry.type === "custom_message" && entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details).includes("steer-progress-request"),
	).length, 1);
});

async function createSilentLeafHarness(t: TestCleanupRegistrar, intervalMs = 1000, parkParent = true) {
	const clock = new ControllableOperationReviewClock();
	let requests = 0;
	let leafAgentId = "";
	const harness = await createIncidentBoundaryHarness(t, {}, {
		deliveryProgressClock: clock,
		workflowPolicy: new WorkflowPolicyStore(parseWorkflowPolicy(JSON.stringify({ deliveryProgressIntervalMs: intervalMs }))),
		messageBoundaryHooks: {
			scheduleDeliveryDispatch(context, dispatch) {
				if (context.kind === "request" && ++requests > 1) { leafAgentId = context.recipientAgentId; return; }
				dispatch();
			},
		},
	});
	harness.host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "Leaf work." }, { id: "excluded-leaf" }), { stopReason: "toolUse" }),
		parkParent
			? fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: "excluded-leaf-wait" }), { stopReason: "toolUse" })
			: fauxAssistantMessage("The leaf owns this work."),
		...Array.from({length: 4}, () => fauxAssistantMessage("Investigate this continuous blockage.")),
	]);
	const parent = await spawnFromView(harness.host.session, harness.owner, "excluded-parent", "Delegate then join.");
	await waitForCondition(() => {
		const run = harness.owner.status(parent.agentId).run;
		return leafAgentId !== "" && run.phase === "live" && (parkParent ? run.attention === "agent_wait" : run.work === "settled");
	});
	await harness.owner.reachSafeBoundary();
	return { ...harness, clock, parent, leafAgentId };
}

test("blocked Delivery selection suspends the interval and recurrence after selection gets independent handling", async (t) => {
	const { host, owner, clock, leafAgentId } = await createSilentLeafHarness(t);
	clock.advanceBy(999);
	const selected = await owner.openAgentView(leafAgentId);
	assert.ok(selected);
	await owner.reachSafeBoundary();
	clock.advanceBy(10_000);
	await assertNoModeratorKindAtSafeBoundary(owner, host, "delivery_stall");
	await selected.close();
	await owner.reachSafeBoundary();
	clock.advanceBy(999);
	await assertNoModeratorKindAtSafeBoundary(owner, host, "delivery_stall");
	clock.advanceBy(1);
	const first = await waitForModeratorKind(host, "delivery_stall");
	const selectedAgain = await owner.openAgentView(leafAgentId);
	assert.ok(selectedAgain);
	await owner.reachSafeBoundary();
	assert.equal(owner.status(first.id).run.retentionReasons.some(({reason}) => reason === "moderator_handling"), false);
	await selectedAgain.close();
	await owner.reachSafeBoundary();
	clock.advanceBy(1000);
	await waitForCondition(async () => (await findModerators(host)).length === 2);
});

test("blocked Delivery intentional leaf Hold excludes moderation", async (t) => {
	const { host, owner, clock, parent, leafAgentId } = await createSilentLeafHarness(t);
	await controlFromView(host.session, owner, "hold-blocked-leaf", { operation: "interrupt", agentId: leafAgentId });
	await owner.reachSafeBoundary();
	clock.advanceBy(10_000);
	await assertNoModeratorKindAtSafeBoundary(owner, host, "delivery_stall");
	await cancelRequestFromView(host.session, owner, "cancel-blocked-parent", parent.requestMessageId);
	await owner.reachSafeBoundary();
	clock.advanceBy(10_000);
	await assertNoModeratorKindAtSafeBoundary(owner, host, "delivery_stall");
});

test("blocked Delivery final upstream obligation clearance releases handling without cancelling the leaf Request", async (t) => {
	const { host, owner, clock, parent, leafAgentId } = await createSilentLeafHarness(t, 1000, false);
	clock.advanceBy(1000);
	const moderator = await waitForModeratorKind(host, "delivery_stall");
	await cancelRequestFromView(host.session, owner, "clear-blocked-obligation", parent.requestMessageId);
	await waitForCondition(() => !owner.status(parent.agentId).run.retentionReasons.some(({reason}) => reason === "answer_owed"));
	await owner.reachSafeBoundary();
	assert.equal(owner.status(moderator.id).run.retentionReasons.some(({reason}) => reason === "moderator_handling"), false);
	assert.ok(owner.status(parent.agentId).run.retentionReasons.some(({reason}) => reason === "awaiting_answer"));
	assert.ok(owner.status(leafAgentId).run.retentionReasons.some(({reason}) => reason === "pending_delivery"));
	clock.advanceBy(10_000);
	await owner.reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 1);
});

test("blocked Delivery follows existing obligations and does not time active recipient or capacity waiting", async (t) => {
	const clock = new ControllableOperationReviewClock();
	let releaseOwner!: () => void;
	const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });
	t.after(() => releaseOwner());
	let ownerStarted = false;
	const { host, owner } = await createIncidentBoundaryHarness(t, {}, {
		deliveryProgressClock: clock,
		workflowPolicy: new WorkflowPolicyStore(parseWorkflowPolicy('{"maxConcurrentAgentRuns":1,"deliveryProgressIntervalMs":1000}')),
	});
	const route = async (context: Context) => {
		const messages = JSON.stringify(context.messages);
		if (!getCurrentTools(context.messages).some(({name}) => name === "agent_spawn")) {
			ownerStarted = true;
			await ownerGate;
			return fauxAssistantMessage("Owner's ordinary model work completed.");
		}
		const tag = messages.includes("First worker") ? "first" : "second";
		if (!messages.includes(`"id":"request-${tag}-owner"`)) {
			return fauxAssistantMessage(fauxToolCall("agent_message", {
				title: "Fixture request",
				operation: "request", targetAgent: "Owner", question: `Decide for ${tag} worker.`,
			}, {id: `request-${tag}-owner`}), {stopReason: "toolUse"});
		}
		return fauxAssistantMessage(fauxToolCall("agent_wait", {}, {id: `wait-${tag}-owner`}), {stopReason: "toolUse"});
	};
	host.model.setResponses(Array.from({length: 12}, () => route));
	const first = await spawnFromView(host.session, owner, "legitimate-first", "First worker requests Owner.");
	await waitForCondition(() => ownerStarted);
	const second = await spawnFromView(host.session, owner, "legitimate-second", "Second worker requests Owner.");
	await waitForCondition(() => {
		const run = owner.status(second.agentId).run;
		return run.phase === "live" && run.attention === "agent_wait";
	});
	clock.advanceBy(100_000);
	await owner.reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 0);
	assert.ok(owner.status(first.agentId).run.retentionReasons.some(({reason}) => reason === "awaiting_answer"));
	assert.ok(owner.status(second.agentId).run.retentionReasons.some(({reason}) => reason === "awaiting_answer"));
});

test("blocked Delivery upstream Human waiting excludes moderation without timing the parked Human Request", async (t) => {
	const clock = new ControllableOperationReviewClock();
	let requests = 0;
	const { host, owner } = await createIncidentBoundaryHarness(t, {}, {
		deliveryProgressClock: clock,
		workflowPolicy: new WorkflowPolicyStore(parseWorkflowPolicy('{"deliveryProgressIntervalMs":1000}')),
		messageBoundaryHooks: {
			scheduleDeliveryDispatch(context, dispatch) {
				if (context.kind === "request" && ++requests > 1) return;
				dispatch();
			},
		},
	});
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request",request: "Blocked leaf."}, {id: "human-leaf"}), {stopReason: "toolUse"}),
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Choose whether to continue."}, {id: "human-blocked-parent"}), {stopReason: "toolUse"}),
	]);
	await spawnFromView(host.session, owner, "human-wait-parent", "Delegate, then ask the Human.");
	await waitForCondition(() => owner.humanAttention().length === 1);
	await owner.reachSafeBoundary();
	clock.advanceBy(100_000);
	await assertNoModeratorKindAtSafeBoundary(owner, host, "delivery_stall");
});

test("blocked Delivery execution capacity wait leaves an obligated parked parent unmoderated", async (t) => {
	const clock = new ControllableOperationReviewClock();
	let releaseParent!: () => void;
	let releaseCapacity!: () => void;
	const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
	const capacityGate = new Promise<void>((resolve) => { releaseCapacity = resolve; });
	t.after(() => { releaseParent(); releaseCapacity(); });
	let parentStarted = false;
	let capacityStarted = false;
	let leafStarted = false;
	const { host, owner } = await createIncidentBoundaryHarness(t, {}, {
		deliveryProgressClock: clock,
		workflowPolicy: new WorkflowPolicyStore(parseWorkflowPolicy('{"maxConcurrentAgentRuns":1,"deliveryProgressIntervalMs":1000}')),
	});
	const route = async (context: Context) => {
		const messages = JSON.stringify(context.messages);
		if (messages.includes("unrelated-capacity-work")) {
			capacityStarted = true;
			await capacityGate;
			return fauxAssistantMessage("Capacity work finished.");
		}
		if (messages.includes("capacity-parent-work")) {
			if (!messages.includes('"id":"capacity-leaf-spawn"')) {
				parentStarted = true;
				await parentGate;
				return fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request",request: "capacity-leaf-work"}, {id: "capacity-leaf-spawn"}), {stopReason: "toolUse"});
			}
			return fauxAssistantMessage(fauxToolCall("agent_wait", {}, {id: "capacity-parent-wait"}), {stopReason: "toolUse"});
		}
		leafStarted = true;
		return fauxAssistantMessage("Leaf work began.");
	};
	host.model.setResponses(Array.from({length: 12}, () => route));
	const parent = await spawnFromView(host.session, owner, "capacity-parent", "capacity-parent-work");
	await waitForCondition(() => parentStarted);
	await spawnFromView(host.session, owner, "capacity-holder", "unrelated-capacity-work");
	releaseParent();
	await waitForCondition(() => {
		const run = owner.status(parent.agentId).run;
		return capacityStarted && run.phase === "live" && run.attention === "agent_wait";
	});
	await owner.reachSafeBoundary();
	clock.advanceBy(100_000);
	await owner.reachSafeBoundary();
	assert.equal(leafStarted, false, "leaf is still legitimately waiting behind the active capacity holder");
	assert.equal((await findModerators(host)).length, 0);
});

test("moderation inspection deadline reports Owner attention while the inspection Promise remains blocked", async (t) => {
	const clock = new ControllableOperationReviewClock();
	let releaseInspection!: () => void;
	const gate = new Promise<void>((resolve) => { releaseInspection = resolve; });
	t.after(() => releaseInspection());
	let block = false;
	let started = false;
	const { owner, coordinator } = await createIncidentBoundaryHarness(t, {
		beforeEvidenceInspection() {
			if (!block) return;
			started = true;
			return gate;
		},
	}, {
		deliveryProgressClock: clock,
		workflowPolicy: new WorkflowPolicyStore(parseWorkflowPolicy('{"deliveryProgressIntervalMs":1000}')),
	});
	block = true;
	const boundary = owner.reachSafeBoundary();
	await waitForCondition(() => started);
	assert.equal(coordinator.hasAutonomousWorkflowProgress(), true, "an actual recovery inspection is progress until its deadline");
	clock.advanceBy(999);
	assert.equal(owner.operationalAttention().length, 0);
	clock.advanceBy(1);
	assert.equal(owner.operationalAttention()[0]?.trigger.kind, "moderation_unavailable");
	const report = owner.reportHistory()[0]?.report;
	assert.ok(report);
	assert.match(report.symptom, /No trigger or affected Request graph was established/);
	assert.match(report.recoveryOutcome, /still pending; terminal failure is not established/);
	assert.equal(coordinator.hasAutonomousWorkflowProgress(), false, "a stuck recovery inspection must not keep Owner parking active");
	clock.advanceBy(10_000);
	assert.equal(owner.operationalAttention().length, 1);
	block = false;
	releaseInspection();
	await boundary;
	assert.equal(owner.operationalAttention().length, 0);
	assert.deepEqual(owner.reportHistory(), [{ report }], "successful inspection does not erase its earlier report");
});

test("blocked Delivery detects a Creation Request stranded before scheduler admission without changing its canonical identity", async (t) => {
	const clock = new ControllableOperationReviewClock();
	let starts = 0;
	const { host, owner } = await createIncidentBoundaryHarness(t, {}, {
		deliveryProgressClock: clock,
		spawnBoundaryHooks: { beforeRunStart: () => ++starts > 1 ? "confirmed_failure" : undefined },
	});
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request",request: "Never admitted leaf."}, {id: "pre-admission-leaf"}), {stopReason: "toolUse"}),
		fauxAssistantMessage("The leaf remains responsible for the admitted work."),
		fauxAssistantMessage("Investigate startup without retrying."),
	]);
	const parent = await spawnFromView(host.session, owner, "pre-admission-parent", "Delegate.");
	const moderator = await waitForModeratorKind(host, "delivery_stall");
	const entry = SessionManager.open(moderator.path).getEntries()[0];
	assert.ok(entry?.type === "custom_message");
	const trigger = JSON.parse(entry.content as string).trigger;
	assert.equal(trigger.reason.kind, "scheduling_failure");
	const leafSource = trigger.requests.sources.find((source: {toolCallId: string}) => source.toolCallId === "pre-admission-leaf");
	assert.ok(leafSource);
	assert.equal(trigger.delivery.messageId, deriveMessageIdentity(leafSource));
	assert.equal(owner.status(trigger.delivery.recipientAgentId).run.phase, "dormant");
	assert.ok(trigger.agentIds.includes(parent.agentId));
	assert.equal(starts, 2);
});

test("blocked Delivery remains observable after leaf termination without cancellation or automatic restart", async (t) => {
	const { host, owner, clock, parent, leafAgentId } = await createSilentLeafHarness(t);
	await controlFromView(host.session, owner, "terminate-stranded-leaf", {
		operation: "terminate", agentId: leafAgentId,
	});
	const moderator = await waitForModeratorKind(host, "delivery_stall");
	const input = SessionManager.open(moderator.path).getEntries()[0];
	assert.ok(input?.type === "custom_message");
	const trigger = JSON.parse(input.content as string).trigger;
	assert.equal(trigger.delivery.recipientAgentId, leafAgentId);
	assert.equal(trigger.reason.kind, "scheduling_failure");
	assert.equal(owner.status(leafAgentId).run.phase, "dormant");
	const parentRun = owner.status(parent.agentId).run;
	// A delivery-failure notice uses ordinary custom-input scheduling: it preempts the
	// parked Agent Wait (returning "preempted") instead of completing the join with
	// fabricated Answers, so the parent leaves agent_wait while its Request stays
	// outstanding (docs/agent-messaging.md, "Asynchronous Delivery failure notices";
	// src/coordination/delivery-failure-notifications.ts reserves the notice delivery).
	assert.ok(parentRun.phase === "live" && parentRun.attention === "none" && parentRun.work === "settled");
	assert.ok(parentRun.retentionReasons.some(({reason}) => reason === "awaiting_answer"));
	assert.ok(parentRun.retentionReasons.some(({reason}) => reason === "answer_owed"));
	clock.advanceBy(10_000);
	await owner.reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 1);
	assert.equal(owner.status(leafAgentId).run.phase, "dormant");
});

test("a blocked replacement Moderator preparation receives deadline attention before its Promise completes", async (t) => {
	const { ProcessChildSessionFactory } = await import("../src/runtime/process-child-session-factory.ts");
	const original = ProcessChildSessionFactory.prototype.prepareModeratorRun;
	let preparations = 0;
	let blocked = false;
	let releasePreparation!: () => void;
	const gate = new Promise<void>((resolve) => { releasePreparation = resolve; });
	t.after(() => releasePreparation());
	t.mock.method(ProcessChildSessionFactory.prototype, "prepareModeratorRun", async function(
		this: InstanceType<typeof ProcessChildSessionFactory>,
		options: Parameters<typeof original>[0],
	) {
		if (++preparations === 2) {
			blocked = true;
			await gate;
		}
		return original.call(this, options);
	});
	const clock = new ControllableOperationReviewClock();
	let moderatorRunStarts = 0;
	const { host, owner, coordinator } = await createIncidentBoundaryHarness(t, {
		// Fail the first handling attempt at its Run boundary: a provider error would
		// now suspend the Moderator instead of consuming the attempt.
		beforeModeratorRunStart() {
			return ++moderatorRunStarts === 1 ? "confirmed_failure" : undefined;
		},
	}, {
		deliveryProgressClock: clock,
		workflowPolicy: new WorkflowPolicyStore(parseWorkflowPolicy('{"deliveryProgressIntervalMs":1000}')),
	});
	const route = (context: Context) => getCurrentTools(context.messages).some(({name}) => name === "moderator_control")
		? fauxAssistantMessage("Replacement investigation continues.")
		: fauxAssistantMessage("Settled without the owed Answer.");
	host.model.setResponses(Array.from({length: 8}, () => route));
	await spawnFromView(host.session, owner, "replacement-watchdog-parent", "Settle without Answer.");
	await waitForCondition(() => blocked);
	assert.equal(coordinator.hasAutonomousWorkflowProgress(), true);
	clock.advanceBy(999);
	assert.equal(owner.operationalAttention().length, 0);
	clock.advanceBy(1);
	const attention = owner.operationalAttention();
	assert.equal(attention.length, 1);
	assert.equal(attention[0]?.trigger.kind, "moderation_unavailable");
	assert.match(attention[0]?.summary ?? "", /creation blocked/);
	assert.equal(coordinator.hasAutonomousWorkflowProgress(), false, "hung replacement preparation must not keep the workflow active");
	const item = owner.reportHistory()[0];
	assert.ok(item);
	assert.match(item.report.symptom, /obligation_stall/);
	assert.match(item.report.suspectedDefect, /Moderator runtime preparation/);
	assert.match(item.report.recoveryActions, /Committed Moderator attempts: 1 of 2/);
	const firstModerator = (await findModerators(host))[0]!;
	assert.ok(item.report.recoveryActions.includes(firstModerator.id));
	assert.match(item.report.recoveryActions, /Previous attempt evidence: .*entryId/);
	assert.match(item.report.evidence.join("\n"), /Moderator diagnostic: .*entryId/);
	assert.match(item.report.recoveryOutcome, /still pending; terminal failure is not established/);
	owner.setReportRead(item.report.reportId, true);
	const pointer = attention[0]?.diagnostics[0];
	assert.ok(pointer);
	assert.ok(host.session.sessionManager.getEntry(pointer.entryId));
	clock.advanceBy(10_000);
	assert.deepEqual(owner.operationalAttention(), attention);
	assert.equal(preparations, 2);
	assert.equal(owner.reportHistory().length, 1);
	assert.ok(owner.reportHistory()[0]?.readAt);
	releasePreparation();
	await owner.reachSafeBoundary();
	await waitForCondition(async () => (await findModerators(host)).length === 2);
	assert.equal(owner.operationalAttention().length, 0);
	assert.deepEqual(owner.reportHistory()[0]?.report, item.report, "later completion does not rewrite the earlier observation");
	assert.equal(owner.reportHistory()[0]?.readAt, undefined, "new Moderator startup evidence restores attention");
	assert.equal(preparations, 2);
});

test("a failed replacement bootstrap retains Owner attention and does not restage on heartbeats", async (t) => {
	let bootstrapAttempts = 0;
	let runStarts = 0;
	const { host, owner } = await createIncidentBoundaryHarness(t, {
		beforeModeratorBootstrapCommit() {
			return ++bootstrapAttempts === 2 ? "confirmed_failure" : undefined;
		},
		beforeModeratorRunStart() {
			runStarts++;
			return "confirmed_failure";
		},
	});
	host.model.setResponses([
		fauxAssistantMessage("Settled without the owed Answer."),
		fauxAssistantMessage("Still settled after the reminder."),
	]);
	await spawnFromView(host.session, owner, "replacement-bootstrap-fault-parent", "Settle without Answer.");
	await waitForCondition(() => owner.operationalAttention().length > 0);
	const attention = owner.operationalAttention();
	assert.equal(attention[0]?.trigger.kind, "moderation_unavailable");
	const report = owner.reportHistory()[0]?.report;
	assert.ok(report);
	assert.match(report.symptom, /Why moderation was triggered: .*still owes an Answer/);
	assert.match(report.recoveryActions, /Committed Moderator attempts: 1 of 2/);
	assert.match(report.recoveryOutcome, /Creation failed; automatic staging is not retried/);
	owner.setReportRead(report.reportId, true);
	for (let n = 0; n < 4; n++) await owner.reachSafeBoundary();
	assert.deepEqual(owner.operationalAttention(), attention);
	assert.equal(owner.reportHistory().length, 1);
	assert.ok(owner.reportHistory()[0]?.readAt);
	assert.equal(bootstrapAttempts, 2);
	assert.equal(runStarts, 1, "uncommitted replacement preparation is not a committed handling attempt");
	assert.equal((await findModerators(host)).length, 1);
});

async function retryRequestFromView(
	session: AgentSession,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	toolCallId: string,
	requestId: string,
): Promise<void> {
	const input = {
		operation: "retry" as const,
		messageId: requestId,
	};
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.message(toolCallId, input);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
}

test("a settled Moderator receives one handling reminder turn and releases when the incident clears", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
	});
	let reminderTurn = false;
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "Demonstrate abandoned handling." },
			{ id: "spawn-for-moderator-reminder" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Delegated."),
		fauxAssistantMessage("Still owe an Answer."),
		fauxAssistantMessage("Still owe an Answer after reminder."),
		fauxAssistantMessage("I forgot to finish moderation."),
		(context) => {
			reminderTurn = JSON.stringify(context.messages.at(-1)).includes(
				"Inspect the original Moderator Input");
			return fauxAssistantMessage("I remain settled after the handling reminder.");
		},
	]);
	const ownerPrompt = host.session.prompt("Create the stalled Agent.");
	const moderator = await waitForModerator(host);
	await waitForCondition(() => reminderTurn);
	await waitForCondition(async () => {
		const { run } = await observeStatus(host, moderator.id);
		return run.phase === "live" && run.work === "settled";
	});
	const reminders = () => SessionManager.open(moderator.path).getEntries().filter(
		(entry) => entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-obligation-reminder",
	);
	assert.equal(reminders().length, 1);
	const reminder = reminders()[0];
	assert.ok(reminder?.type === "custom_message");
	assert.equal(reminder.display, true);
	assert.match(JSON.stringify(reminders()[0]), /moderator_control/);
	// Repeated evidence inspections cannot generate another reminder or a nested Moderator.
	for (let index = 0; index < 3; index++) {
		await observeStatus(host, moderator.id);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal(reminders().length, 1);
	assert.equal((await findModerators(host)).length, 1);
	const source = host.session.sessionManager.getEntries().find((entry) =>
		entry.type === "message" && entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.type === "toolCall" &&
			part.id === "spawn-for-moderator-reminder"));
	assert.ok(source);
	await executeAndCommitRegisteredTool(host.session, "agent_message", "cancel-reminded-incident", {
		operation: "cancel",
		requestMessageId: deriveMessageIdentity({
			agentId: host.session.sessionId, entryId: source.id,
			toolCallId: "spawn-for-moderator-reminder",
		}),
		reason: "The demonstration is complete.",
	});
	await waitForCondition(async () => (await observeStatus(host, moderator.id)).run.phase === "dormant");
	await host.session.abort();
	await ownerPrompt;
});

test("clearing the incident before native reminder commitment suppresses delivery and releases the Moderator", { timeout: 5000 }, async (t) => {
	const prepared = reminderTestDeferred<void>();
	const allowDecision = reminderTestDeferred<void>();
	const finished = reminderTestDeferred<string>();
	const originalDelivery = PiChildHostedRuntime.prototype.deliverModeratorReminder;
	t.mock.method(PiChildHostedRuntime.prototype, "deliverModeratorReminder", async function (
		this: PiChildHostedRuntime,
		commitIfCurrent: Parameters<PiChildHostedRuntime["deliverModeratorReminder"]>[0],
	) {
		let wasPrepared = false;
		const outcome = await originalDelivery.call(this, async commit => {
			wasPrepared = true;
			prepared.resolve();
			await allowDecision.promise;
			return commitIfCurrent(commit);
		});
		if (wasPrepared) finished.resolve(outcome);
		return outcome;
	});
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "Demonstrate cleared handling." },
			{ id: "spawn-before-clear" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Delegated."),
		fauxAssistantMessage("Still owe an Answer."),
		fauxAssistantMessage("Still owe an Answer after reminder."),
		fauxAssistantMessage("I forgot to finish moderation."),
	]);
	const ownerPrompt = host.session.prompt("Create the stalled Agent.");
	try {
		const moderator = await waitForModerator(host);
		await prepared.promise;
		const source = host.session.sessionManager.getEntries().find(entry =>
			entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(part => part.type === "toolCall" && part.id === "spawn-before-clear"));
		assert.ok(source);
		await executeAndCommitRegisteredTool(host.session, "agent_message", "clear-before-reminder", {
			operation: "cancel",
			requestMessageId: deriveMessageIdentity({
				agentId: host.session.sessionId, entryId: source.id, toolCallId: "spawn-before-clear",
			}),
			reason: "Clear the incident before the prepared reminder commits.",
		});
		// Observation reconciles the real handling episode while its native admission waits.
		await observeStatus(host, moderator.id);
		allowDecision.resolve();
		assert.equal(await finished.promise, "suppressed");
		await waitForCondition(async () => (await observeStatus(host, moderator.id)).run.phase === "dormant");
		assert.equal(SessionManager.open(moderator.path).getEntries().some(entry =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-obligation-reminder"), false);
	} finally {
		allowDecision.resolve();
		await host.session.abort();
		await ownerPrompt;
	}
});

function reminderTestDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

test("Owner reload stops active ordinary Moderators before fresh admission", { timeout: 5_000 }, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
	});
	let entered!: () => void;
	const moderatorEntered = new Promise<void>((resolve) => { entered = resolve; });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", {
			title: "Reload Moderator", request: "Demonstrate an obligation stall.",
		}, { id: "reload-moderator-spawn" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Delegated."),
		fauxAssistantMessage("Settled without answering."),
		fauxAssistantMessage("Settled again without answering."),
		async () => { entered(); await gate; return fauxAssistantMessage("Late Moderator completion."); },
	]);
	const prompt = host.session.prompt("Delegate stalled work.");
	await moderatorEntered;
	const moderator = await waitForModerator(host);
	await host.session.reload();
	await prompt;
	const afterShutdown = await readFile(moderator.path, "utf8");
	release();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(await readFile(moderator.path, "utf8"), afterShutdown);
	const observed = await executeAndCommitRegisteredTool(host.session, "agent_observe", "reloaded-moderator", {
		operation: "status", agentId: moderator.id,
	});
	assert.equal((observed.details as { run: { phase: string } }).run.phase, "dormant");
	assert.equal((await findModerators(host)).length, 1);
	assert.equal(host.ui.notifications.some(({ message }) => message.includes("Workflow revalidated")), false);
});
