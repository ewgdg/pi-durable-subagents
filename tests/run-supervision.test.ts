import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, readFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildLaunchContractGuard } from "../src/process-runtime/child-launch-contract.ts";
import { PiChildProcessRuntime } from "../src/process-runtime/pi-child-process-runtime.ts";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
	WorkflowCoordinator,
	type AgentMessageInput,
} from "../src/coordination/workflow-coordinator.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import piAgentCoordination from "../src/index.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	WorkflowPolicyStore,
	parseWorkflowPolicy,
} from "../src/policy/workflow-policy.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestCleanupRegistrar,
} from "./support/pi-host.ts";
import {
	openLiveAgentView,
	returnAgentViewToOwner,
} from "./support/agent-session.ts";

type CoordinatorView = ReturnType<WorkflowCoordinator["forAgent"]>;
type ProcessAgentDriver = Readonly<{
	agentId: string;
	view: CoordinatorView;
	transcriptPath: string;
	entries(): ReturnType<SessionManager["getEntries"]>;
	appendToolCall(toolName: string, toolCallId: string, input: Record<string, unknown>): void;
	prompt(
		text: string,
		options?: Readonly<{ expectedResult?: "commit" | "input_failure" }>,
	): Promise<void>;
	sendUserMessage(text: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	readonly isIdle: boolean;
}>;

const MAX_CONDITION_POLL_ATTEMPTS = 500;
const PROCESS_RUNTIME_FIXTURE = fileURLToPath(
	new URL("./fixtures/process-runtime-child-extension.ts", import.meta.url),
);

test("activity subscriptions publish queued Delivery changes while a child Run remains active", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-activity-queue-child");
	await child.waitForIdle();

	let markGenerationStarted!: () => void;
	const generationStarted = new Promise<void>((resolve) => {
		markGenerationStarted = resolve;
	});
	let releaseGeneration!: () => void;
	const generationRelease = new Promise<void>((resolve) => {
		releaseGeneration = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			markGenerationStarted();
			await generationRelease;
			return fauxAssistantMessage("The active child accepted queued input.");
		},
		fauxAssistantMessage("The queued input was processed."),
	]);
	let activityChanges = 0;
	const removeActivityHandler = harness.ownerView.addAgentActivityChangeHandler(
		() => activityChanges += 1,
	);
	const activeTurn = child.prompt("Remain active while input is queued.");
	await generationStarted;
	const changesBeforeQueue = activityChanges;

	await child.sendUserMessage("Queued follow-up");
	await new Promise<void>((resolve) => setImmediate(resolve));
	const changesAfterQueue = activityChanges;
	const hasPendingDelivery = harness.ownerView.status(child.agentId).run.retentionReasons
		.some(({ reason }) => reason === "pending_delivery");

	releaseGeneration();
	await activeTurn;
	await child.waitForIdle();
	removeActivityHandler();
	assert.ok(changesAfterQueue > changesBeforeQueue);
	assert.equal(hasPendingDelivery, true);
});

test("interruption holds one exact settled Run and blocks ordinary Message Delivery", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-held-child");
	await child.waitForIdle();

	const interrupted = await harness.control("interrupt-held-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	assert.deepEqual(interrupted, {
		agentId: child.agentId,
		disposition: "held",
	});
	assert.deepEqual(
		harness.ownerView.status(child.agentId).run.retentionReasons,
		[
			{ reason: "answer_owed", count: 1 },
			{ reason: "interruption_hold", count: 1 },
		],
	);

	const message = await harness.sendMessage(
		"message-admitted-while-held",
		child.agentId,
		"This ordinary Message must remain pending behind the Hold.",
	);
	assert.ok("messageStatus" in message);
	assert.equal(message.messageStatus, "sent");
	await harness.ownerView.reachSafeBoundary();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(
		child.entries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes("This ordinary Message must remain pending"),
		),
		false,
	);
	assert.equal(child.isIdle, true);

	await harness.shutdown();
});

test("interruption keeps an aborted Human Request Run held when Pi reports an error", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-aborted-human-request-child");
	await child.waitForIdle();
	const input = {
		question: "This request remains unanswered while its Run is held.",
	};
	const toolCallId = "ask-aborted-human-request";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The aborted Human Request must not continue before resumption."),
	]);
	const prompt = child.prompt("Open an interruptible Human Request.");
	await waitForCondition(() => {
		const run = child.view.status().run;
		return run.phase !== "dormant" && run.attention === "input_required";
	});
	const selectedView = await harness.ownerView.openAgentView(child.agentId) ??
		harness.activeAgentView();
	assert.ok(selectedView);
	selectedView.projection().dispatchInput("\x1b");
	await prompt;
	await waitForCondition(() => child.view.status().run.retentionReasons.some(
		({ reason }) => reason === "interruption_hold",
	));
	assert.equal(child.view.status().run.phase, "live");
	assert.equal(child.view.status().run.retentionReasons.some(
		({ reason }) => reason === "interruption_hold",
	), true);
	await selectedView.close();

});

test("an unrelated Agent abort does not preempt a later explicit interruption", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-direct-abort-child");
	await child.waitForIdle();

	await child.abort();
	const interrupted = await harness.control("interrupt-after-direct-abort", {
		operation: "interrupt",
		agentId: child.agentId,
	});

	assert.deepEqual(interrupted, {
		agentId: child.agentId,
		disposition: "held",
	});
	await harness.shutdown();
});

test("interruption preserves Message admission that wins the target lane first", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-interruption-order-child");
	await child.waitForIdle();
	let markGenerationStarted!: () => void;
	const generationStarted = new Promise<void>((resolve) => {
		markGenerationStarted = resolve;
	});
	let releaseGeneration!: () => void;
	const generationGate = new Promise<void>((resolve) => {
		releaseGeneration = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			markGenerationStarted();
			await generationGate;
			return fauxAssistantMessage("The interrupted work reached settlement.");
		},
	]);
	const activeRun = child.prompt("Remain active through the admission race.");
	await generationStarted;

	const messageText = "Admission wins the lane, but Delivery waits behind the Hold.";
	const admitted = await harness.sendMessage(
		"admit-before-interruption",
		child.agentId,
		messageText,
	);
	assert.ok("messageStatus" in admitted);
	assert.equal(admitted.messageStatus, "sent");
	const interruption = harness.control("interrupt-after-admission", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	releaseGeneration();
	await activeRun;
	assert.deepEqual(await interruption, {
		agentId: child.agentId,
		disposition: "held",
	});
	assert.equal(
		child.entries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes(messageText),
		),
		false,
	);

	await harness.shutdown();
});

test("a Hold blocks admitted Request, Answer, and Cancellation Delivery", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-held-request-child");
	await child.waitForIdle();
	const owner = { session: harness.host.session, view: harness.ownerView };

	harness.host.model.setResponses([
		fauxAssistantMessage("The Owner retained the child's unanswered Request."),
	]);
	const outgoing = await harness.requestFromChild(
		child,
		"child-request-before-hold",
		"Keep this outgoing Request unresolved for the held Answer.",
	);
	assert.ok("requestMessageId" in outgoing);
	await harness.host.session.waitForIdle();

	harness.host.model.setResponses([
		fauxAssistantMessage("The child retained the Owner's unanswered Request."),
	]);
	const incoming = await harness.requestAs(
		owner,
		"owner-request-before-hold",
		child.agentId,
		"Keep this incoming Request unresolved for held Cancellation.",
	);
	assert.ok("requestMessageId" in incoming);
	await child.waitForIdle();
	await harness.control("interrupt-request-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});

	const heldRequestText = "This Request must wait behind the exact Hold.";
	const heldAnswerText = "This Answer must wait behind the exact Hold.";
	const heldCancellationText = "This Cancellation must wait behind the exact Hold.";
	const heldRequest = await harness.messageAs(owner, "request-admitted-while-held", {
		title: "Fixture request",
		operation: "request",
		targetAgent: child.agentId,
		question: heldRequestText,
	});
	const heldAnswer = await harness.messageAs(owner, "answer-admitted-while-held", {
		operation: "answer", requestId: outgoing.requestMessageId,
		answer: heldAnswerText,
	});
	const heldCancellation = await harness.messageAs(
		owner,
		"cancellation-admitted-while-held",
		{
			operation: "cancel",
			requestMessageId: incoming.requestMessageId,
			reason: heldCancellationText,
		},
	);
	for (const receipt of [heldRequest, heldAnswer, heldCancellation]) {
		assert.ok("messageStatus" in receipt);
		assert.equal(receipt.messageStatus, "sent");
	}
	await harness.ownerView.reachSafeBoundary();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const childEntries = child.entries();
	for (const blockedText of [heldRequestText, heldAnswerText, heldCancellationText]) {
		assert.equal(
			childEntries.some(
				(entry) =>
					entry.type === "custom_message" &&
					String(entry.content).includes(blockedText),
			),
			false,
		);
	}
	assert.equal(child.isIdle, true);
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);

	await harness.shutdown();
});

test("one Supervisory Resume Message commits alone before ordinary held backlog", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-resumed-child");
	await child.waitForIdle();
	await harness.control("interrupt-resumed-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await harness.sendMessage(
		"ordinary-backlog-after-resume",
		child.agentId,
		"Run this ordinary backlog only after the isolated resume turn.",
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The isolated supervisory resume turn completed."),
		fauxAssistantMessage("The ordinary held backlog followed settlement."),
	]);
	const resumed = await harness.control("resume-held-child", {
		operation: "resume",
		agentId: child.agentId,
		content: "Resume this exact held Run with explicit direction.",
	});
	assert.equal(resumed.agentId, child.agentId);
	assert.ok("messageStatus" in resumed && "messageId" in resumed);
	assert.equal(resumed.messageStatus, "sent");
	assert.equal(typeof resumed.messageId, "string");
	await child.waitForIdle();
	await waitForCondition(() =>
		child.entries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "The ordinary held backlog followed settlement.",
				),
		),
	);

	const deliveries = child.entries().flatMap(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery"
				? [entry]
				: [],
	);
	const resumedIndex = deliveries.findIndex((entry) =>
		String(entry.content).includes("Resume this exact held Run"),
	);
	const backlogIndex = deliveries.findIndex((entry) =>
		String(entry.content).includes("Run this ordinary backlog"),
	);
	assert.equal(resumedIndex >= 0, true);
	assert.equal(backlogIndex > resumedIndex, true);
	assert.deepEqual(
		JSON.parse(String(deliveries[resumedIndex]!.content)).messages,
		[{
			kind: "message",
			messageId: resumed.messageId,
			fromAgentId: harness.host.session.sessionId,
			content: "Resume this exact held Run with explicit direction.",
		}],
	);
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		false,
	);

	await harness.shutdown();
});

test("a failed Supervisory Resume dispatch leaves its exact Hold retryable", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-failed-supervisory-resume-child");
	await child.waitForIdle();
	await harness.control("interrupt-before-failed-supervisory-resume", {
		operation: "interrupt",
		agentId: child.agentId,
	});

	await chmod(child.transcriptPath, 0o400);
	try {
		await assert.rejects(
			() => harness.control("failed-supervisory-resume", {
				operation: "resume",
				agentId: child.agentId,
				content: "This dispatch fails before transcript commitment.",
			}),
		);
	} finally {
		await chmod(child.transcriptPath, 0o600);
	}
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The retry resumed the still-held exact Run."),
	]);
	const retried = await harness.control("retry-supervisory-resume", {
		operation: "resume",
		agentId: child.agentId,
		content: "Retry the exact Hold after dispatch recovery.",
	});
	assert.ok("messageStatus" in retried);
	assert.equal(retried.messageStatus, "sent");
	await child.waitForIdle();
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		false,
	);

	await harness.shutdown();
});

test("a native human editor Message clears its exact Hold for one isolated turn", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-human-resumed-child");
	await child.waitForIdle();
	await harness.control("interrupt-human-resumed-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await harness.sendMessage(
		"ordinary-backlog-after-human-resume",
		child.agentId,
		"Deliver this only after the human-resumed turn settles.",
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The isolated native human turn completed."),
		fauxAssistantMessage("The backlog followed the native human turn."),
	]);
	await child.prompt("Resume this exact Hold from the native editor.");
	await child.waitForIdle();
	await waitForCondition(() =>
		child.entries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "The backlog followed the native human turn.",
				),
		),
	);

	const entries = child.entries();
	const humanIndex = entries.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			Array.isArray(entry.message.content) &&
			entry.message.content.some(
				(part) =>
					part.type === "text" &&
					part.text === "Resume this exact Hold from the native editor.",
			),
	);
	const backlogIndex = entries.findIndex(
		(entry) =>
			entry.type === "custom_message" &&
			String(entry.content).includes("Deliver this only after the human-resumed turn"),
	);
	assert.equal(humanIndex >= 0, true);
	assert.equal(backlogIndex > humanIndex, true);
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		false,
	);

	await harness.shutdown();
});

test("a failed native human resume dispatch leaves its exact Hold retryable", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-failed-human-resume-child");
	await child.waitForIdle();
	await harness.control("interrupt-before-failed-human-resume", {
		operation: "interrupt",
		agentId: child.agentId,
	});

	harness.host.model.setResponses([
		fauxAssistantMessage("The uncommitted process input cycle settled."),
	]);
	await child.prompt("PROCESS_RUNTIME_DROP_MESSAGE_COMMIT", {
		expectedResult: "input_failure",
	});
	// The backgrounded child's input failure renders in its own complete native
	// mode; it never reaches the Owner's TUI (#59).
	const agentView = await harness.ownerView.openAgentView(child.agentId);
	const activeAgentView = agentView ?? harness.activeAgentView();
	assert.ok(activeAgentView);
	await waitForCondition(() =>
		stripTerminalSequences(
			activeAgentView.projection().presentation.render(120).join("\n"),
		)
			.includes("Human input did not commit")
	);
	assert.equal(
		harness.host.ui.notifications.some(({ message }) =>
			message.includes("human resume dispatch failed")
		),
		false,
	);
	assert.equal(
		child.entries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(
					"PROCESS_RUNTIME_DROP_MESSAGE_COMMIT",
				),
		),
		false,
	);
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The human retry resumed the still-held exact Run."),
	]);
	await child.prompt("Retry the native human resume against the exact Hold.");
	await child.waitForIdle();
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		false,
	);
	await harness.activeAgentView()?.close();

});

test("supervisory interruption settles an active Human Request through its error result", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-human-request-child");
	await child.waitForIdle();
	const toolCallId = "human-request-before-supervisor-interrupt";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user",
				{ question: "The supervisor will interrupt this exact Run." },
				{ id: toolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("This continuation must not run before explicit resumption."),
	]);
	const waitingRun = child.prompt("Open a Human Request for interruption.");
	await waitForCondition(() => {
		const run = harness.ownerView.status(child.agentId).run;
		return "attention" in run && run.attention === "input_required";
	});

	const interrupted = await harness.control("interrupt-active-human-request", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await waitingRun;
	assert.deepEqual(interrupted, {
		agentId: child.agentId,
		disposition: "held",
	});
	const result = child.entries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	assert.equal(result.message.isError, true);
	assert.equal(
		child.entries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "This continuation must not run before explicit resumption.",
				),
		),
		false,
	);
	const run = harness.ownerView.status(child.agentId).run;
	assert.equal("attention" in run && run.attention, "none");
	assert.equal(
		run.retentionReasons.some(({ reason }) => reason === "interruption_hold"),
		true,
	);

	await harness.shutdown();
});

test("termination discards exact-Run backlog, reports residual Requests, and permits a successor", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-terminated-child");
	await child.waitForIdle();

	harness.host.model.setResponses([
		fauxAssistantMessage("The Owner received the child's residual Request."),
	]);
	const outgoingRequest = await harness.requestFromChild(
		child,
		"child-request-before-termination",
		"This outgoing Request must remain residual after termination.",
	);
	assert.ok("requestMessageId" in outgoingRequest);
	await harness.host.session.waitForIdle();
	await harness.control("interrupt-before-termination", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await harness.sendMessage(
		"discard-this-held-backlog",
		child.agentId,
		"This uncommitted exact-Run backlog must be discarded.",
	);

	const terminated = await harness.control("terminate-held-child", {
		operation: "terminate",
		agentId: child.agentId,
	});
	assert.deepEqual(terminated, {
		agentId: child.agentId,
		disposition: "terminated",
		residualRequests: { incoming: 1, outgoing: 1 },
	});
	assert.deepEqual(harness.ownerView.status(child.agentId).run, {
		phase: "dormant",
		retentionReasons: [],
	});
	assert.equal(
		child.entries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes("This uncommitted exact-Run backlog"),
		),
		false,
	);

	// Termination preserves the Owner's Answer Obligation, so settle that
	// residual Request before an ordinary Owner Message can target the child.
	harness.host.model.setResponses([
		fauxAssistantMessage("The child received the residual Answer."),
	]);
	await harness.messageAs(
		{ session: harness.host.session, view: harness.ownerView },
		"answer-residual-request-after-termination",
		{ operation: "answer", requestId: outgoingRequest.requestMessageId, answer: "The Owner answered the residual Request." },
	);
	await child.waitForIdle();
	harness.host.model.setResponses([
		fauxAssistantMessage("A fresh successor Run received only later input."),
	]);
	await harness.sendMessage(
		"start-successor-after-termination",
		child.agentId,
		"Start a successor after exact Run termination.",
	);
	await waitForCondition(() =>
		child.entries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "A fresh successor Run received only later input.",
				),
		),
	);

	await harness.shutdown();
});

test("Agent Wait awaits delivered work without reviving a terminated responder", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const spawnToolCallId = "spawn-before-dormant-wait";
	const child = await harness.spawnChild(spawnToolCallId);
	await child.waitForIdle();

	const spawnSourceEntry = harness.host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === spawnToolCallId,
			),
	);
	assert.ok(spawnSourceEntry);
	const creationRequestId = deriveMessageIdentity({
		agentId: harness.host.session.sessionId,
		entryId: spawnSourceEntry.id,
		toolCallId: spawnToolCallId,
	});
	await harness.control("terminate-before-dormant-wait", {
		operation: "terminate",
		agentId: child.agentId,
	});
	assert.equal(harness.ownerView.status(child.agentId).run.phase, "dormant");
	const replacement = await harness.spawnChild("spawn-live-replacement-before-wait");
	assert.notEqual(harness.ownerView.status(replacement.agentId).run.phase, "dormant");

	const waitToolCallId = "await-delivered-work-of-dormant-responder";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", {}, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const abort = new AbortController();
	t.after(() => abort.abort());
	let waitingFor: readonly { requestMessageId: string; responderAgentId: string }[] = [];
	const waiting = assert.rejects(harness.ownerView.wait(
		waitToolCallId, {}, abort.signal,
		progress => { waitingFor = progress.waitingFor; },
	), /Agent Wait interrupted/);
	await waitForCondition(() => {
		const run = harness.ownerView.status().run;
		return "attention" in run && run.attention === "agent_wait";
	});
	assert.ok(waitingFor.some(item => item.requestMessageId === creationRequestId && item.responderAgentId === child.agentId));
	assert.ok(waitingFor.some(item => item.responderAgentId === replacement.agentId));
	assert.equal(harness.ownerView.status(child.agentId).run.phase, "dormant");
	abort.abort();
	await waiting;

	await harness.shutdown();
});

test("authority follows only Owner descendants and immediate Direct-Spawner edges", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const parent = await harness.spawnChild("spawn-authority-parent");
	const sibling = await harness.spawnChild("spawn-authority-sibling");
	const grandchild = await harness.spawnChildFrom(
		parent,
		"spawn-authority-grandchild",
	);
	await Promise.all([
		parent.waitForIdle(),
		sibling.waitForIdle(),
		grandchild.waitForIdle(),
	]);

	assert.equal(
		harness.ownerView.status(grandchild.agentId).directSpawnerAgentId,
		parent.agentId,
	);
	assert.throws(
		() => parent.view.status(sibling.agentId),
		/unauthorized: Agent .* cannot observe/,
	);
	harness.host.model.setResponses([
		fauxAssistantMessage("The sibling received an ordinary Message without granting authority."),
	]);
	await harness.sendMessageAs(
		parent,
		"message-does-not-grant-authority",
		sibling.agentId,
		"Messaging this sibling must not grant Run control.",
	);
	await sibling.waitForIdle();
	await assert.rejects(
		() => harness.controlAs(parent, "unauthorized-sibling-interrupt", {
			operation: "interrupt",
			agentId: sibling.agentId,
		}),
		/unauthorized: Agent .* cannot control Agent Run/,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The grandchild retained the direct Spawner's Request obligation."),
	]);
	await harness.requestAs(
		parent,
		"direct-spawner-request-before-control",
		grandchild.agentId,
		"Remain live for the Direct Spawner's supervision check.",
	);
	await grandchild.waitForIdle();
	assert.equal(harness.ownerView.status(grandchild.agentId).run.phase, "live");
	const heldByDirectSpawner = await harness.controlAs(
		parent,
		"direct-spawner-interrupt",
		{ operation: "interrupt", agentId: grandchild.agentId },
	);
	assert.ok("disposition" in heldByDirectSpawner);
	assert.equal(heldByDirectSpawner.disposition, "held");
	const parentTermination = await harness.control("owner-terminates-parent-only", {
		operation: "terminate",
		agentId: parent.agentId,
	});
	assert.ok("disposition" in parentTermination);
	assert.equal(parentTermination.disposition, "terminated");
	assert.equal(harness.ownerView.status(parent.agentId).run.phase, "dormant");
	assert.equal(harness.ownerView.status(grandchild.agentId).run.phase, "live");
	assert.equal(
		harness.ownerView.status(grandchild.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);

	await harness.shutdown();
});

test("the one resume reservation remains available when ordinary capacity is exhausted", async (t) => {
	const harness = await createRunSupervisionHarness(t, {
		workflowPolicy: new WorkflowPolicyStore(
			parseWorkflowPolicy('{"maxPendingDeliveriesPerAgent": 1}'),
		),
	});
	const child = await harness.spawnChild("spawn-resume-capacity-child");
	await child.waitForIdle();
	await harness.control("interrupt-resume-capacity-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	const first = await harness.sendMessage(
		"fill-ordinary-held-capacity",
		child.agentId,
		"This Message occupies the only ordinary pending slot.",
	);
	assert.ok("messageStatus" in first);
	assert.equal(first.messageStatus, "sent");
	const exhausted = await harness.sendMessage(
		"exceed-ordinary-held-capacity",
		child.agentId,
		"This Message cannot enter ordinary pending capacity.",
	);
	assert.ok("messageId" in exhausted && "messageStatus" in exhausted);
	assert.deepEqual(exhausted, {
		messageId: exhausted.messageId,
		targetAgentId: child.agentId,
		messageStatus: "not_sent",
		reason: "capacity_exhausted",
	});

	harness.host.model.setResponses([
		fauxAssistantMessage("The reserved resume ran despite ordinary exhaustion."),
		fauxAssistantMessage("The one admitted ordinary Message followed."),
	]);
	const resumed = await harness.control("resume-outside-ordinary-capacity", {
		operation: "resume",
		agentId: child.agentId,
		content: "Use the reserved resumption slot.",
	});
	assert.ok("messageStatus" in resumed);
	assert.equal(resumed.messageStatus, "sent");
	await child.waitForIdle();
	await waitForCondition(() =>
		child.entries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "The one admitted ordinary Message followed.",
				),
		),
	);

	await harness.shutdown();
});

test("a resume bound to an earlier Hold becomes ordinary direction and cannot clear a later Hold", async (t) => {
	const harness = await createRunSupervisionHarness(t, { deferFirstResume: true });
	const child = await harness.spawnChild("spawn-stale-resume-child");
	await child.waitForIdle();
	await harness.control("interrupt-for-stale-resume", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	const stale = await harness.control("reserve-stale-resume", {
		operation: "resume",
		agentId: child.agentId,
		content: "This resume is bound only to the earlier Hold.",
	});
	assert.ok("messageStatus" in stale);
	assert.equal(stale.messageStatus, "sent");
	assert.equal(
		child.entries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes("bound only to the earlier Hold"),
		),
		false,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("Human input cleared the earlier Hold first."),
	]);
	await child.prompt("Clear the earlier Hold with native human input.");
	await child.waitForIdle();
	await harness.control("interrupt-after-stale-resume", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await harness.releaseDeferredResume();
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);
	assert.equal(
		child.entries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes("bound only to the earlier Hold"),
		),
		false,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The later exact Hold was resumed explicitly."),
		fauxAssistantMessage("The stale resume arrived afterward as ordinary direction."),
	]);
	const current = await harness.control("resume-later-exact-hold", {
		operation: "resume",
		agentId: child.agentId,
		content: "Resume the later exact Hold.",
	});
	assert.ok("messageStatus" in current);
	assert.equal(current.messageStatus, "sent");
	await child.waitForIdle();
	await waitForCondition(() =>
		child.entries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "The stale resume arrived afterward as ordinary direction.",
				),
		),
	);
	const deliveries = child.entries().flatMap((entry) =>
		entry.type === "custom_message" &&
		entry.customType === "agent-coordination.message-delivery"
			? [String(entry.content)]
			: []
	);
	assert.equal(
		deliveries.findIndex((content) => content.includes("bound only to the earlier Hold")) >
			deliveries.findIndex((content) => content.includes("Resume the later exact Hold")),
		true,
	);

	await harness.shutdown();
});

test("the registered agent_control tool authenticates structural committed input", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	host.model.setResponses([
		fauxAssistantMessage("The tool-controlled child remains available."),
	]);
	const spawnInput = { title: "Fixture request", request: "Remain available for registered Run control." };
	const spawnToolCallId = "spawn-tool-controlled-child";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: spawnToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	const spawnResult = await spawn.execute(
		spawnToolCallId,
		spawnInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const childAgentId = (spawnResult.details as { agentId: string }).agentId;

	const toolCallId = "registered-agent-control-interrupt";
	const committedInput = { operation: "interrupt" as const, agentId: childAgentId };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", committedInput, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const control = host.session.getToolDefinition("agent_control");
	assert.ok(control);
	const result = await control.execute(
		toolCallId,
		{ agentId: childAgentId, operation: "interrupt" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(result.details, {
		agentId: childAgentId,
		disposition: "held",
	});
	const output = result.content[0];
	assert.ok(output?.type === "text");
	assert.deepEqual(JSON.parse(output.text), result.details);

	await host.runtime.dispose();
});

test("/agents retains only the viewed exact Run and keeps Owner bound through close", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
	});
	host.model.setResponses([
		fauxAssistantMessage("The viewed child remains available."),
	]);
	const spawnInput = { title: "Fixture request", request: "Remain live for durable Agent view retention." };
	const spawnToolCallId = "spawn-view-retained-child";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: spawnToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	const spawnResult = await spawn.execute(
		spawnToolCallId,
		spawnInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const childAgentId = (spawnResult.details as { agentId: string }).agentId;
	const ownerSession = host.runtime.session;
	const opened = await openLiveAgentView(host, childAgentId);
	assert.equal(host.runtime.session, ownerSession);
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = async (toolCallId: string) => observe.execute(
		toolCallId,
		{ operation: "status", agentId: childAgentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.equal(
		((await status("observe-open-agent-view")).details as {
			run: { retentionReasons: Array<{ reason: string }> };
		}).run.retentionReasons.some(({ reason }) => reason === "interactive_selection"),
		true,
	);
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const run = ((await status(`observe-view-settlement-${attempt}`)).details as {
			run: { phase: string; work?: string };
		}).run;
		if (run.phase === "live" && run.work === "settled") break;
		if (attempt === MAX_CONDITION_POLL_ATTEMPTS - 1) {
			assert.fail("Viewed process child did not settle");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}

	await returnAgentViewToOwner(host, opened);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(
		((await status("observe-closed-agent-view")).details as {
			run: { retentionReasons: Array<{ reason: string }> };
		}).run.retentionReasons.some(({ reason }) => reason === "interactive_selection"),
		false,
	);
	await host.runtime.dispose();
});

test("shutdown fences Run, tool, control, and Human Request admission", async (t) => {
	const harness = await createRunSupervisionHarness(t);
	const child = await harness.spawnChild("spawn-before-admission-fence");
	await child.waitForIdle();
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
		async () => harness.ownerView.control(
			"control-after-shutdown",
			{ operation: "interrupt", agentId: child.agentId },
		),
		/host_shutting_down/,
	);
	await assert.rejects(
		async () => harness.ownerView.askHuman(
			"human-after-shutdown",
			{ question: "This request must not open." },
			new AbortController().signal,
		),
		/host_shutting_down/,
	);
	await assert.rejects(
		() => harness.ownerView.beginExecution(),
		/host_shutting_down/,
	);
	await assert.rejects(
		() => harness.ownerView.ensureExecution(),
		/host_shutting_down/,
	);
	assert.throws(
		() => harness.ownerView.beginToolExecution("tool-after-shutdown", "read"),
		/host_shutting_down/,
	);

	releaseNativeDisposal();
	await shutdown;
});

async function createRunSupervisionHarness(
	t: TestCleanupRegistrar,
	options?: {
	workflowPolicy?: WorkflowPolicyStore;
	deferFirstResume?: boolean;
}) {
	let deferredResumeRelease: (() => Promise<void>) | undefined;
	let didDeferResume = false;
	let activeAgentView: Awaited<ReturnType<CoordinatorView["openAgentView"]>>;
	let promptSequence = 0;
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		additionalExtensionPaths: [PROCESS_RUNTIME_FIXTURE],
	});
	await bindTestOwnerHost(host, "tui");
	const ownerIdentity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, ownerIdentity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		workflowPolicy: options?.workflowPolicy,
		messageBoundaryHooks: options?.deferFirstResume
			? {
				afterResumeReservation({ release }) {
					if (didDeferResume) return;
					didDeferResume = true;
					deferredResumeRelease = release;
					return "defer";
				},
			}
			: undefined,
	});
	const ownerView = coordinator.forAgent(ownerIdentity.agentId);

	const selectAgent = async (agentId: string) => {
		const opened = await ownerView.openAgentView(agentId);
		if (opened) activeAgentView = opened;
		assert.ok(activeAgentView);
		assert.equal(activeAgentView.agentId, agentId);
		return activeAgentView;
	};
	const createDriver = (agentId: string): ProcessAgentDriver => {
		const transcriptPath = ownerView.status(agentId).primaryEvidence.transcriptPath;
		assert.ok(transcriptPath);
		const entries = () => SessionManager.open(transcriptPath).getEntries();
		const appendToolCall = (
			toolName: string,
			toolCallId: string,
			input: Record<string, unknown>,
		) => {
			SessionManager.open(transcriptPath).appendMessage(
				fauxAssistantMessage(
					fauxToolCall(toolName, input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
		};
		const dispatchInteractiveInput = async (text: string) => {
			const selected = await selectAgent(agentId);
			selected.projection().dispatchInput(text);
			selected.projection().dispatchInput("\r");
			return selected;
		};
		const driver = {
			agentId,
			view: coordinator.forAgent(agentId),
			transcriptPath,
			entries,
			appendToolCall,
			async prompt(text: string, options) {
				const beforeEntryIds = new Set(entries().map(({ id }) => id));
				const held = ownerView.status(agentId).run.retentionReasons.some(
					({ reason }) => reason === "interruption_hold",
				);
				let selected: Awaited<ReturnType<typeof dispatchInteractiveInput>> | undefined;
				if (held) {
					selected = await dispatchInteractiveInput(text);
				} else {
					promptSequence += 1;
					const toolCallId = `process-prompt-${promptSequence}`;
					const input = {
						operation: "send" as const,
						targetAgent: agentId,
						content: text,
					};
					host.session.sessionManager.appendMessage(
						fauxAssistantMessage(
							fauxToolCall("agent_message", input, { id: toolCallId }),
							{ stopReason: "toolUse" },
						),
					);
					await ownerView.message(toolCallId, input);
				}
				const expectedResult = options?.expectedResult ?? "commit";
				await waitForCondition(() => {
					const committed = entries().some((entry) =>
						!beforeEntryIds.has(entry.id) &&
						JSON.stringify(entry).includes(text)
					);
					const inputFailure = Boolean(selected && stripTerminalSequences(
						selected.projection().presentation.render(120).join("\n"),
					).includes("Agent input failed"));
					return expectedResult === "input_failure" ? inputFailure : committed;
				});
				if (expectedResult === "input_failure") return;
				await waitForCondition(() => {
					const run = ownerView.status(agentId).run;
					return run.phase === "dormant" ||
						(run.phase === "live" && run.work === "settled");
				});
			},
			async sendUserMessage(text: string) {
				promptSequence += 1;
				const toolCallId = `process-queued-input-${promptSequence}`;
				const input = {
					operation: "send" as const,
					targetAgent: agentId,
					content: text,
					deliveryMode: "steer" as const,
				};
				host.session.sessionManager.appendMessage(
					fauxAssistantMessage(
						fauxToolCall("agent_message", input, { id: toolCallId }),
						{ stopReason: "toolUse" },
					),
				);
				await ownerView.message(toolCallId, input);
				// Native child queues are process-local; refresh through the public
				// activity seam after the Owner admits the queued Delivery.
				ownerView.refreshAgentActivity();
			},
			async abort() {
				const selected = await selectAgent(agentId);
				selected.projection().dispatchInput("\x03");
				await waitForCondition(() => {
					const run = ownerView.status(agentId).run;
					return run.phase === "dormant" ||
						(run.phase === "live" && run.work === "settled");
				});
			},
			waitForIdle: () => waitForCondition(() => {
				const run = ownerView.status(agentId).run;
				return run.phase === "dormant" ||
					(run.phase === "live" && run.work === "settled");
			}),
			get isIdle() {
				const run = ownerView.status(agentId).run;
				return run.phase === "dormant" ||
					(run.phase === "live" && run.work === "settled");
			},
		} satisfies ProcessAgentDriver;
		return driver;
	};
	type OwnerCaller = { session: typeof host.session; view: CoordinatorView };
	const appendCallerToolCall = (
		caller: ProcessAgentDriver | OwnerCaller,
		toolName: string,
		toolCallId: string,
		input: Record<string, unknown>,
	) => {
		if ("appendToolCall" in caller) {
			caller.appendToolCall(toolName, toolCallId, input);
			return;
		}
		caller.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(toolName, input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
	};

	return {
		host,
		coordinator,
		ownerView,
		activeAgentView: () => activeAgentView,
		async spawnChild(toolCallId: string) {
			host.model.setResponses([
				fauxAssistantMessage("The child is settled and ready for supervision."),
			]);
			const input = { title: "Fixture request", request: "Remain available for exact Run supervision." };
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_spawn", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			const receipt = await ownerView.spawn(toolCallId, input);
			assert.ok("agentId" in receipt && typeof receipt.agentId === "string");
			const driver = createDriver(receipt.agentId);
			await waitForCondition(() => {
				const run = ownerView.status(receipt.agentId).run;
				return driver.entries().some(
					(entry) => entry.type === "custom_message" &&
						entry.customType === "agent-coordination.obligation-reminder",
				) && run.phase === "live" && run.work === "settled" &&
					run.retentionReasons.some(({ reason }) => reason === "answer_owed") &&
					!run.retentionReasons.some(({ reason }) => reason === "pending_delivery");
			});
			return driver;
		},
		async spawnChildFrom(parent: ProcessAgentDriver, toolCallId: string) {
			host.model.setResponses([
				fauxAssistantMessage("The nested child is settled for supervision."),
			]);
			const input = { title: "Fixture request", request: "Remain available as a nested supervised Agent." };
			parent.appendToolCall("agent_spawn", toolCallId, input);
			const receipt = await parent.view.spawn(toolCallId, input);
			assert.ok("agentId" in receipt && typeof receipt.agentId === "string");
			const driver = createDriver(receipt.agentId);
			await waitForCondition(() => {
				const run = ownerView.status(receipt.agentId).run;
				return driver.entries().some(
					(entry) => entry.type === "custom_message" &&
						entry.customType === "agent-coordination.obligation-reminder",
				) && run.phase === "live" && run.work === "settled" &&
					run.retentionReasons.some(({ reason }) => reason === "answer_owed") &&
					!run.retentionReasons.some(({ reason }) => reason === "pending_delivery");
			});
			return driver;
		},
		async control(
			toolCallId: string,
			input:
				| { operation: "interrupt"; agentId: string }
				| { operation: "resume"; agentId: string; content: string }
				| { operation: "terminate"; agentId: string },
		) {
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_control", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			return ownerView.control(toolCallId, input);
		},
		async sendMessage(toolCallId: string, targetAgentId: string, content: string) {
			const input = { operation: "send" as const, targetAgent: targetAgentId, content };
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_message", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			return ownerView.message(toolCallId, input);
		},
		async sendMessageAs(
			caller: ProcessAgentDriver,
			toolCallId: string,
			targetAgentId: string,
			content: string,
		) {
			const input = { operation: "send" as const, targetAgent: targetAgentId, content };
			caller.appendToolCall("agent_message", toolCallId, input);
			return caller.view.message(toolCallId, input);
		},
		async messageAs(
			caller: ProcessAgentDriver | OwnerCaller,
			toolCallId: string,
			input: AgentMessageInput,
		) {
			appendCallerToolCall(caller, "agent_message", toolCallId, input);
			return caller.view.message(toolCallId, input);
		},
		async controlAs(
			caller: ProcessAgentDriver,
			toolCallId: string,
			input:
				| { operation: "interrupt"; agentId: string }
				| { operation: "resume"; agentId: string; content: string }
				| { operation: "terminate"; agentId: string },
		) {
			caller.appendToolCall("agent_control", toolCallId, input);
			return caller.view.control(toolCallId, input);
		},
		async requestFromChild(
			child: ProcessAgentDriver,
			toolCallId: string,
			question: string,
		) {
			const input = {
				title: "Fixture request",
				operation: "request" as const,
				targetAgent: ownerIdentity.agentId,
				question,
			};
			child.appendToolCall("agent_message", toolCallId, input);
			return child.view.message(toolCallId, input);
		},
		async requestAs(
			caller: ProcessAgentDriver | OwnerCaller,
			toolCallId: string,
			targetAgentId: string,
			question: string,
		) {
			const input = { title: "Fixture request", operation: "request" as const, targetAgent: targetAgentId, question };
			appendCallerToolCall(caller, "agent_message", toolCallId, input);
			return caller.view.message(toolCallId, input);
		},
		async releaseDeferredResume() {
			if (!deferredResumeRelease) {
				throw new Error("No deferred resume reservation was captured");
			}
			await deferredResumeRelease();
		},
		shutdown: () => coordinator.shutdown(async () => host.runtime.dispose()),
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected Run supervision condition was not reached");
}

test("workflow resume and cancellation retain canonical identities through a latched bootstrap mismatch", { timeout: 30_000 }, async (t) => {
	const harness = await createRunSupervisionHarness(t);
	t.after(() => harness.shutdown());
	harness.host.model.setResponses([fauxAssistantMessage("The request remains unanswered.")]);
	const spawnInput = { title: "Preserve this request", request: "Keep this request unanswered until the Owner decides." };
	harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", spawnInput, { id: "spawn-before-contract-change" })));
	const spawned = await harness.ownerView.spawn("spawn-before-contract-change", spawnInput);
	assert.ok("agentId" in spawned);
	const child = {
		agentId: spawned.agentId,
		view: harness.coordinator.forAgent(spawned.agentId),
		transcriptPath: harness.ownerView.status(spawned.agentId).primaryEvidence.transcriptPath!,
	};
	await waitForCondition(() => child.view.openIncomingRequests().requests.length > 0);
	const [request] = child.view.openIncomingRequests().requests;
	assert.ok(request);
	const canonicalRequest = harness.ownerView.inspectRequest(request.requestMessageId);
	await harness.control("terminate-before-contract-change", { operation: "terminate", agentId: child.agentId });
	assert.equal(harness.ownerView.status(child.agentId).run.phase, "dormant");
	const transcriptBefore = await readFile(child.transcriptPath, "utf8");
	const allAgents = () => (["starting", "live", "ending", "dormant"] as const).flatMap(phase =>
		harness.ownerView.search({ operation: "search", scope: "authorized", phase }).matches.map(agent => agent.agentId)
	).sort();
	const identitiesBefore = allAgents();
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-contract-"));
	const schemaPath = join(root, "schemas.mjs");
	await writeFile(schemaPath, "export const AGENT_CONTROL_PROTOCOL_VERSION = 9; export const ChildProcessBootstrapSchema = {};");
	const guard = new ChildLaunchContractGuard(pathToFileURL(schemaPath));
	const assertCompatible = ChildLaunchContractGuard.prototype.assertCompatible;
	t.mock.method(ChildLaunchContractGuard.prototype, "assertCompatible", () => assertCompatible.call(guard));
	let launches = 0;
	t.mock.method(PiChildProcessRuntime, "launch", async () => {
		launches++;
		throw new Error("incompatible preparation reached process launch");
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		const id = `workflow-resume-incompatible-${attempt}`;
		harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("workflow_resume", {}, { id })));
		const receipt = await harness.ownerView.resumeWorkflow(id);
		const retained = receipt.outstandingRequests.find(item => item.requestMessageId === request.requestMessageId);
		assert.ok(retained);
		assert.match(retained.reason ?? "", /protocol_mismatch.*Stop.*align.*restart/);
		assert.equal(harness.ownerView.status(child.agentId).run.phase, "dormant");
		assert.deepEqual(harness.ownerView.inspectRequest(request.requestMessageId), canonicalRequest);
	}
	const owner = { session: harness.host.session, view: harness.ownerView };
	const cancellation = await harness.messageAs(owner, "cancel-incompatible-request", {
		operation: "cancel", requestMessageId: request.requestMessageId, reason: "Human withdrew the work; do not launch to repair packages.",
	});
	assert.ok("messageId" in cancellation && "messageStatus" in cancellation);
	assert.equal(cancellation.messageStatus, "not_sent");
	harness.host.session.sessionManager.appendMessage({ role: "toolResult", toolCallId: "cancel-incompatible-request", toolName: "agent_message", content: [], details: cancellation, isError: false, timestamp: Date.now() });
	for (let attempt = 0; attempt < 2; attempt++) {
		const retry = await harness.messageAs(owner, `retry-incompatible-cancellation-${attempt}`, { operation: "retry", messageId: cancellation.messageId });
		assert.equal("messageId" in retry && retry.messageId, cancellation.messageId);
		assert.equal("messageStatus" in retry && retry.messageStatus, "not_sent");
	}
	const again = await harness.messageAs(owner, "cancel-incompatible-again", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Still withdrawn." });
	assert.deepEqual(again, { disposition: "already_cancelled", cancellationMessageId: cancellation.messageId });
	assert.equal(launches, 0);
	assert.equal(harness.ownerView.status(child.agentId).run.phase, "dormant");
	assert.deepEqual(allAgents(), identitiesBefore, "no Moderator or replacement Agent is created");
	assert.equal(await readFile(child.transcriptPath, "utf8"), transcriptBefore, "no replay, cancellation Delivery, or Run evidence is fabricated");
	assert.deepEqual(harness.ownerView.inspectRequest(request.requestMessageId), canonicalRequest);
	assert.deepEqual(child.view.openIncomingRequests().requests, [request], "undelivered cancellation does not discharge the responder obligation");
});
