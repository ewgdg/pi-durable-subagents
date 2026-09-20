import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type Context,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { executeAndCommitRegisteredTool } from "./support/agent-session.ts";

for (const explicitWait of [false, true]) {
	test(`Human input releases passive parking but not an executing Owner Wait (explicit Wait: ${explicitWait})`, { timeout: 10_000 }, async (t) => {
		const attentionEvents: unknown[] = [];
		const host = await createTestOwnerHost(t, piAgentCoordination, {
			persistent: true, processVisibleModel: true,
			additionalExtensionFactories: [(pi) => {
				pi.events.on("herdr:blocked", (data) => attentionEvents.push(data));
			}],
		});
		let askHuman!: () => void;
		const childGate = new Promise<void>((resolve) => { askHuman = resolve; });
		t.after(askHuman);
		const lifecycle: string[] = [];
		let ownerResponded = false;
		host.session.subscribe((event) => {
			if (event.type === "agent_settled") lifecycle.push(event.type);
		});
		const routeResponse = async (context: Context) => {
			const serialized = JSON.stringify(context.messages);
			if (serialized.includes("requestMessageId") && !serialized.includes("spawn-needs-human")) {
				await childGate;
				return fauxAssistantMessage(fauxToolCall("ask_user", {
					question: "Which option should I use?",
				}, { id: "child-needs-human" }), { stopReason: "toolUse" });
			}
			if (!serialized.includes("spawn-needs-human")) {
				return fauxAssistantMessage(fauxToolCall("agent_spawn", {
					title: "Fixture request",
					request: "Work until you need a human decision.",
				}, { id: "spawn-needs-human" }), { stopReason: "toolUse" });
			}
			ownerResponded = true;
			return explicitWait
				? fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: "owner-explicit-wait" }), { stopReason: "toolUse" })
				: fauxAssistantMessage("The background work can proceed without me.");
		};
		host.model.setResponses(Array.from({ length: 8 }, () => routeResponse));
		const prompt = host.session.prompt("Delegate the work.");
		await waitUntil(() => ownerResponded && (explicitWait || ownerAssistantTexts(host).includes("The background work can proceed without me.")));
		assert.equal(host.session.isIdle, false);
		askHuman();
		await waitUntil(() => ownerDockText(host).includes("Which option should I use"));
		assert.deepEqual(attentionEvents, [{ active: true, label: "An agent needs your input" }]);
		if (explicitWait) {
			// Agent Wait is still an executing native tool, not an agent_end boundary.
			// Its result/preemption contract is deliberately outside passive parking.
			assert.equal(host.session.isIdle, false);
			assert.deepEqual(lifecycle, []);
			await host.session.abort();
			await prompt;
			return;
		}
		await withTimeout(prompt, 3_000, "Owner stayed active after its only child required human input");
		assert.equal(host.session.isIdle, true);
		assert.deepEqual(lifecycle, ["agent_settled"]);
		assert.match(ownerDockText(host), /Which option should I use/);
		await host.session.reload();
		assert.deepEqual(attentionEvents, [
			{ active: true, label: "An agent needs your input" },
			{ active: false },
			{ active: true, label: "An agent needs your input" },
		]);
	});
}

for (const independentFinishesFirst of [false, true]) {
	test(`Owner stays parked through nested dependency waits (independent work finishes first: ${independentFinishesFirst})`, {
		timeout: 10_000,
	}, async (t) => {
		const attentionEvents: unknown[] = [];
		const host = await createTestOwnerHost(t, piAgentCoordination, {
			persistent: true, processVisibleModel: true,
			additionalExtensionFactories: [(pi) => {
				pi.events.on("herdr:blocked", (data) => attentionEvents.push(data));
			}],
		});
		let askHuman!: () => void;
		const leafGate = new Promise<void>((resolve) => { askHuman = resolve; });
		let finishIndependent!: () => void;
		const independentGate = new Promise<void>((resolve) => { finishIndependent = resolve; });
		t.after(() => { askHuman(); finishIndependent(); });
		let parentWaiting = false;
		let independentStarted = false;
		const lifecycle: string[] = [];
		host.session.subscribe((event) => { if (event.type === "agent_settled") lifecycle.push(event.type); });
		const routeResponse = async (context: Context) => {
			const serialized = JSON.stringify(context.messages);
			const child = serialized.includes("requestMessageId") && !serialized.includes("spawn-progress-parent");
			if (child && serialized.includes("INDEPENDENT_PROGRESS_WORK")) {
				independentStarted = true;
				await independentGate;
				return fauxAssistantMessage(fauxToolCall("agent_message", {
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "Independent work finished.",
				}, { id: "independent-answer" }), { stopReason: "toolUse" });
			}
			if (child && serialized.includes("LEAF_PROGRESS_WORK") && !serialized.includes("spawn-progress-leaf")) {
				await leafGate;
				return fauxAssistantMessage(fauxToolCall("ask_user", { question: "Choose the leaf's next action." },
					{ id: "leaf-needs-human" }), { stopReason: "toolUse" });
			}
			if (child) {
				if (!serialized.includes("spawn-progress-leaf")) {
					return fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "LEAF_PROGRESS_WORK" },
						{ id: "spawn-progress-leaf" }), { stopReason: "toolUse" });
				}
				parentWaiting = true;
				return fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: "wait-for-progress-leaf" }), { stopReason: "toolUse" });
			}
			if (!serialized.includes("spawn-progress-parent")) {
				return fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "PARENT_PROGRESS_WORK" },
					{ id: "spawn-progress-parent" }), { stopReason: "toolUse" });
			}
			if (!serialized.includes("spawn-independent-progress")) {
				return fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "INDEPENDENT_PROGRESS_WORK" },
					{ id: "spawn-independent-progress" }), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage("The Owner has no independent work.");
		};
		host.model.setResponses(Array.from({ length: 20 }, () => routeResponse));
		const prompt = host.session.prompt("Delegate nested and independent work.");
		await waitUntil(() => parentWaiting && independentStarted && ownerAssistantTexts(host).includes("The Owner has no independent work."));
		assert.equal(host.session.isIdle, false);
		assert.deepEqual(lifecycle, []);
		if (independentFinishesFirst) {
			finishIndependent();
			await waitUntil(() => ownerAssistantTexts(host).filter((text) => text === "The Owner has no independent work.").length === 2);
			assert.equal(host.session.isIdle, false, "the progressing grandchild alone must keep its waiting ancestors active");
			assert.deepEqual(lifecycle, []);
		}
		askHuman();
		await waitUntil(() => ownerDockText(host).includes("Choose the leaf's next action."));
		assert.deepEqual(attentionEvents, [{ active: true, label: "An agent needs your input" }]);
		if (!independentFinishesFirst) {
			assert.equal(host.session.isIdle, false, "independent work must keep the workflow active despite Human Request");
			assert.deepEqual(lifecycle, []);
			finishIndependent();
		}
		await withTimeout(prompt, 3_000, "Owner did not settle after all autonomous work ended");
		assert.equal(host.session.isIdle, true);
		assert.deepEqual(lifecycle, ["agent_settled"]);
		assert.match(ownerDockText(host), /Choose the leaf's next action/);
	});
}

test("Owner stays active through terminal child failure and Moderator recovery, then settles when recovery needs a human", {
	timeout: 10_000,
}, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
		settings: { retry: { enabled: false } },
	});
	let failChild!: () => void;
	const childGate = new Promise<void>((resolve) => { failChild = resolve; });
	let askHuman!: () => void;
	const recoveryGate = new Promise<void>((resolve) => { askHuman = resolve; });
	t.after(() => { failChild(); askHuman(); });
	let moderatorStarted = false;
	const lifecycle: string[] = [];
	host.session.subscribe((event) => { if (event.type === "agent_settled") lifecycle.push(event.type); });
	const routeResponse = async (context: Context) => {
		if (getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
			moderatorStarted = true;
			await recoveryGate;
			return fauxAssistantMessage(fauxToolCall("ask_user", { question: "Recovery needs your decision." },
				{ id: "recovery-needs-human" }), { stopReason: "toolUse" });
		}
		const serialized = JSON.stringify(context.messages);
		if (serialized.includes("requestMessageId") && !serialized.includes("spawn-to-fail")) {
			await childGate;
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid_request_error: deterministic child failure" });
		}
		if (!serialized.includes("spawn-to-fail")) return fauxAssistantMessage(fauxToolCall("agent_spawn", {
			title: "Fixture request",
			request: "Work until the controlled failure.",
		}, { id: "spawn-to-fail" }), { stopReason: "toolUse" });
		return fauxAssistantMessage("The Owner has delegated the work.");
	};
	host.model.setResponses(Array.from({ length: 12 }, () => routeResponse));
	const prompt = host.session.prompt("Start background work.");
	await waitUntil(() => ownerAssistantTexts(host).includes("The Owner has delegated the work."));
	failChild();
	await waitUntil(() => moderatorStarted);
	assert.equal(host.session.isIdle, false);
	assert.deepEqual(lifecycle, [], "failure-to-recovery handoff must not produce transient completion");
	askHuman();
	await withTimeout(prompt, 3_000, "Owner stayed parked after recovery required human input");
	assert.equal(host.session.isIdle, true);
	assert.deepEqual(lifecycle, ["agent_settled"]);
	assert.match(ownerDockText(host), /Recovery needs your decision/);
});

test("terminating the last progressing child releases Owner parking without an Answer", { timeout: 10_000 }, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	let releaseChild!: () => void;
	const gate = new Promise<void>((resolve) => { releaseChild = resolve; });
	t.after(releaseChild);
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		if (serialized.includes("requestMessageId") && !serialized.includes("spawn-to-terminate")) {
			await gate;
			return fauxAssistantMessage("Unused after termination.");
		}
		if (!serialized.includes("spawn-to-terminate")) return fauxAssistantMessage(fauxToolCall("agent_spawn", {
			title: "Fixture request",
			request: "Work in the background.",
		}, { id: "spawn-to-terminate" }), { stopReason: "toolUse" });
		return fauxAssistantMessage("Waiting for the background work.");
	};
	host.model.setResponses(Array.from({ length: 6 }, () => routeResponse));
	const prompt = host.session.prompt("Start background work.");
	await waitUntil(() => ownerAssistantTexts(host).includes("Waiting for the background work."));
	const receipt = host.session.sessionManager.getEntries().find((entry) => entry.type === "message" &&
		entry.message.role === "toolResult" && entry.message.toolCallId === "spawn-to-terminate");
	assert.ok(receipt?.type === "message" && receipt.message.role === "toolResult");
	const { agentId } = receipt.message.details as { agentId: string };
	assert.equal(host.session.isIdle, false);
	await executeAndCommitRegisteredTool(host.session, "agent_control", "terminate-background", { operation: "terminate", agentId });
	await withTimeout(prompt, 3_000, "Termination left the Owner parked on its unanswered Request");
	assert.equal(host.session.isIdle, true);
	const status = await executeAndCommitRegisteredTool(host.session, "agent_observe", "observe-dormant-background", { operation: "status", agentId });
	assert.equal((status.details as { run: { phase: string } }).run.phase, "dormant");
	await withTimeout(host.session.prompt("No further work is needed."), 3_000, "Dormant dependency parked a later Owner response");
});

test("Owner stays parked while a supervisory resumed child executes in isolation", { timeout: 10_000 }, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	let releaseInitial!: () => void;
	let releaseResumed!: () => void;
	const initialGate = new Promise<void>((resolve) => { releaseInitial = resolve; });
	const resumedGate = new Promise<void>((resolve) => { releaseResumed = resolve; });
	t.after(() => { releaseInitial(); releaseResumed(); });
	let childStarted = false;
	let childResumed = false;
	let agentId = "";
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		if (serialized.includes("requestMessageId") && !serialized.includes("spawn-to-resume")) {
			if (!serialized.includes("Continue isolated work.")) {
				childStarted = true;
				await initialGate;
				return fauxAssistantMessage("Interrupted work.");
			}
			childResumed = true;
			await resumedGate;
			return fauxAssistantMessage(fauxToolCall("agent_message", {
				operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "Resumed work complete.",
			}, { id: "answer-resumed" }), { stopReason: "toolUse" });
		}
		if (!serialized.includes("spawn-to-resume")) return fauxAssistantMessage(fauxToolCall("agent_spawn", {
			title: "Fixture request",
			request: "Work until interrupted, then resume.",
		}, { id: "spawn-to-resume" }), { stopReason: "toolUse" });
		if (!serialized.includes("Resume the held child.")) return fauxAssistantMessage("Waiting for initial work.");
		if (!serialized.includes("resume-held-child")) return fauxAssistantMessage(fauxToolCall("agent_control", {
			operation: "resume", agentId, content: "Continue isolated work.",
		}, { id: "resume-held-child" }), { stopReason: "toolUse" });
		return fauxAssistantMessage("Waiting for resumed work.");
	};
	host.model.setResponses(Array.from({ length: 12 }, () => routeResponse));
	const initialPrompt = host.session.prompt("Start interruptible work.");
	await waitUntil(() => childStarted && ownerAssistantTexts(host).includes("Waiting for initial work."));
	const receipt = host.session.sessionManager.getEntries().find((entry) => entry.type === "message" &&
		entry.message.role === "toolResult" && entry.message.toolCallId === "spawn-to-resume");
	assert.ok(receipt?.type === "message" && receipt.message.role === "toolResult");
	agentId = (receipt.message.details as { agentId: string }).agentId;
	await executeAndCommitRegisteredTool(host.session, "agent_control", "hold-child", { operation: "interrupt", agentId });
	releaseInitial();
	await withTimeout(initialPrompt, 3_000, "Actual Interruption Hold did not release Owner parking");
	assert.equal(host.session.isIdle, true);
	let settled = false;
	const resumedPrompt = host.session.prompt("Resume the held child.").then(() => { settled = true; });
	await waitUntil(() => childResumed && ownerAssistantTexts(host).includes("Waiting for resumed work."));
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	assert.equal(settled, false, "Owner settled while the isolated resumed response was still gated");
	assert.equal(host.session.isIdle, false);
	releaseResumed();
	await withTimeout(resumedPrompt, 3_000, "Owner did not settle after resumed work answered");
	assert.equal(host.session.isIdle, true);
});

test("Owner parks for ordinary background work even after every Request was answered", { timeout: 10_000 }, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	let finishWork!: () => void;
	const gate = new Promise<void>((resolve) => { finishWork = resolve; });
	t.after(finishWork);
	let working = false;
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		if (serialized.includes("requestMessageId") && !serialized.includes("spawn-message-worker")) {
			if (serialized.includes("ORDINARY_BACKGROUND_WORK")) {
				working = true;
				await gate;
				return fauxAssistantMessage("Ordinary background work finished.");
			}
			return fauxAssistantMessage(fauxToolCall("agent_message", {
				operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "Creation work complete.",
			}, { id: "answer-message-worker" }), { stopReason: "toolUse" });
		}
		if (!serialized.includes("spawn-message-worker")) return fauxAssistantMessage(fauxToolCall("agent_spawn", {
			title: "Fixture request",
			request: "Answer the creation work.",
		}, { id: "spawn-message-worker" }), { stopReason: "toolUse" });
		return fauxAssistantMessage("No Owner work remains.");
	};
	host.model.setResponses(Array.from({ length: 12 }, () => routeResponse));
	await host.session.prompt("Create the worker.");
	const receipt = host.session.sessionManager.getEntries().find((entry) => entry.type === "message" &&
		entry.message.role === "toolResult" && entry.message.toolCallId === "spawn-message-worker");
	assert.ok(receipt?.type === "message" && receipt.message.role === "toolResult");
	const { agentId } = receipt.message.details as { agentId: string };
	await executeAndCommitRegisteredTool(host.session, "agent_message", "send-ordinary-work", {
		operation: "send", targetAgent: agentId, content: "ORDINARY_BACKGROUND_WORK",
	});
	await waitUntil(() => working);
	const status = await executeAndCommitRegisteredTool(host.session, "agent_observe", "observe-no-requests", { operation: "status" });
	assert.equal((status.details as { run: { retentionReasons: { reason: string }[] } }).run.retentionReasons.some(({ reason }) => reason === "awaiting_answer"), false);
	const responseCount = ownerAssistantTexts(host).length;
	const prompt = host.session.prompt("Let the worker finish independently.");
	await waitUntil(() => ownerAssistantTexts(host).length > responseCount);
	assert.equal(host.session.isIdle, false);
	finishWork();
	await withTimeout(prompt, 3_000, "Owner did not settle when ordinary background work completed");
	assert.equal(host.session.isIdle, true);
});

test("primary Owner input preempts Agent Wait before the next model turn", {
	timeout: 10_000,
}, async (t) => {
	const extensionWithLaterAsyncInputHandler: ExtensionFactory = async (pi) => {
		await piAgentCoordination(pi);
		pi.on("session_start", () => {
			pi.on("input", async (event) => {
				if (event.streamingBehavior !== "steer") return;
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
			});
		});
	};
	const host = await createTestOwnerHost(t, extensionWithLaterAsyncInputHandler, {
		persistent: true,
		processVisibleModel: true,
	});
	let releaseAnswer!: () => void;
	const answerGate = new Promise<void>((resolve) => {
		releaseAnswer = resolve;
	});
	const requestMarker = "OWNER_HUMAN_PREEMPT_REQUEST";
	const queuedFollowUp = "Handle this only after the current wait has ended.";
	const userDirection = "Change direction before the background Answer arrives.";
	const answerText = "The preserved background Answer arrived.";
	const spawnCallId = "spawn-before-owner-human-preemption";
	const waitCallId = "wait-before-owner-human-preemption";
	const stuckWaitCallId = "wait-reissued-before-owner-input-delivery";
	const answerCallId = "answer-after-owner-human-preemption";
	let ownerRanBeforeHumanInput = false;
	let preemptedResultReachedDirectedTurn = false;
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		const isResponder = serialized.includes(requestMarker) &&
			serialized.includes("requestMessageId") &&
			!serialized.includes(spawnCallId);
		if (isResponder) {
			if (serialized.includes(answerCallId)) {
				return fauxAssistantMessage("The preserved Answer was committed.");
			}
			await answerGate;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: answerText },
					{ id: answerCallId },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (serialized.includes(answerText)) {
			return fauxAssistantMessage("The Owner later received the preserved Answer.");
		}
		if (serialized.includes(queuedFollowUp)) {
			return fauxAssistantMessage("The Owner processed the explicitly queued follow-up.");
		}
		if (serialized.includes(userDirection)) {
			preemptedResultReachedDirectedTurn = serialized.includes(
				'"disposition":"preempted"',
			);
			return fauxAssistantMessage("The Owner acted on the new human direction.");
		}
		if (serialized.includes('"disposition":"preempted"')) {
			ownerRanBeforeHumanInput = true;
			return fauxAssistantMessage(
				fauxToolCall("agent_wait", {}, { id: stuckWaitCallId }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(spawnCallId)) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_spawn",
					{ request: requestMarker },
					{ id: spawnCallId },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(waitCallId)) {
			return fauxAssistantMessage(
				fauxToolCall("agent_wait", {}, { id: waitCallId }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("The Owner is still waiting for human input.");
	};
	host.model.setResponses(Array.from({ length: 10 }, () => routeResponse));

	const initialPrompt = host.session.prompt(requestMarker);
	await waitUntil(() => host.session.sessionManager.getEntries().some((entry) =>
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((part) =>
			part.type === "toolCall" && part.id === waitCallId
		)
	));
	const followUpPrompt = host.session.prompt(queuedFollowUp, {
		streamingBehavior: "followUp",
	});
	await waitUntil(() => host.session.pendingMessageCount === 1);
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const waitingStatus = await observe.execute(
		"observe-wait-after-explicit-follow-up",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.equal(
		(waitingStatus.details as { run: { attention: string } }).run.attention,
		"agent_wait",
	);
	assert.equal(host.session.sessionManager.getEntries().some((entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === waitCallId
	), false);

	const directedPrompt = host.session.prompt(userDirection, {
		streamingBehavior: "steer",
	});
	await waitUntil(() =>
		ownerRanBeforeHumanInput ||
		ownerAssistantTexts(host).includes(
			"The Owner processed the explicitly queued follow-up.",
		)
	);
	const ownerTexts = ownerAssistantTexts(host);
	assert.equal(
		ownerTexts.indexOf("The Owner acted on the new human direction.") <
			ownerTexts.indexOf("The Owner processed the explicitly queued follow-up."),
		true,
	);

	assert.equal(ownerRanBeforeHumanInput, false);
	assert.equal(preemptedResultReachedDirectedTurn, true);
	assert.equal(host.session.sessionManager.getEntries().some((entry) =>
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((part) =>
			part.type === "toolCall" && part.id === stuckWaitCallId
		)
	), false);
	const waitResult = host.session.sessionManager.getEntries().find((entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === waitCallId
	);
	assert.ok(waitResult?.type === "message" && waitResult.message.role === "toolResult");
	assert.deepEqual(waitResult.message.details, { disposition: "preempted" });
	const status = await observe.execute(
		"observe-request-preserved-after-human-preemption",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(
		(status.details as { run: { retentionReasons: Array<{ reason: string }> } })
			.run.retentionReasons.some(({ reason }) => reason === "awaiting_answer"),
		true,
	);

	releaseAnswer();
	await withTimeout(
		Promise.all([initialPrompt, followUpPrompt, directedPrompt]).then(() => undefined),
		5_000,
		"Owner did not settle after its preserved Answer arrived",
	);
});

test("Owner and Herdr remain working until the Creation Request Answer arrives, then settle once", {
	timeout: 10_000,
}, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		settings: {
			compaction: {
				enabled: true,
				reserveTokens: 16_000,
				keepRecentTokens: 1,
			},
		},
	});
	let releaseAnswer!: () => void;
	const answerGate = new Promise<void>((resolve) => {
		releaseAnswer = resolve;
	});
	// Herdr keeps the root pane working from agent_start until this exact native
	// agent_settled event. No project settlement projection may appear while parked.
	const lifecycle: string[] = [];
	let compactionStarts = 0;
	let explicitNextTurnSeenDuringContinuation = false;
	host.session.subscribe((event) => {
		if (event.type === "agent_end") lifecycle.push("agent_end");
		if (event.type === "agent_settled") lifecycle.push("agent_settled");
		if (event.type === "compaction_start") compactionStarts += 1;
	});
	const requestMarker = "OWNER_PARK_CREATION_REQUEST";
	const request = `${requestMarker} ${"retained context ".repeat(30_000)}`;
	const answerCallId = "answer-owner-parked-request";
	const explicitNextTurnProbe = "Store this only for a later fresh prompt.";
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		if (serialized.includes(explicitNextTurnProbe)) {
			explicitNextTurnSeenDuringContinuation = true;
		}
		if (
			serialized.includes(requestMarker) &&
			serialized.includes("requestMessageId") &&
			!serialized.includes("spawn-owner-parked-request")
		) {
			if (!serialized.includes(answerCallId)) {
				await answerGate;
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "The background result is ready." },
						{ id: answerCallId },
					),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("The Answer was committed.");
		}
		if (serialized.includes(requestMarker)) {
			if (!serialized.includes("spawn-owner-parked-request")) {
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_spawn",
						{ request },
						{ id: "spawn-owner-parked-request" },
					),
					{ stopReason: "toolUse" },
				);
			}
			if (serialized.includes("The background result is ready.")) {
				return fauxAssistantMessage("The Owner received the background result.");
			}
			return fauxAssistantMessage("No independent work remains in this turn.");
		}
		return fauxAssistantMessage("No coordination action was needed.");
	};
	host.model.setResponses(Array.from({ length: 8 }, () => routeResponse));

	const prompt = host.session.prompt(request);
	await waitUntil(() => ownerAssistantTexts(host).includes(
		"No independent work remains in this turn.",
	));
	assert.equal(host.session.isIdle, false);
	assert.equal(compactionStarts, 0);
	assert.deepEqual(lifecycle, ["agent_end"]);

	await host.session.sendCustomMessage({
		customType: "owner-parking-next-turn-probe",
		content: explicitNextTurnProbe,
		display: false,
	}, { triggerTurn: true, deliverAs: "nextTurn" });
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(lifecycle, ["agent_end"]);

	releaseAnswer();
	await withTimeout(prompt, 5_000, "Owner did not resume after Answer Delivery");
	await host.session.waitForIdle();
	assert.equal(host.session.isIdle, true);
	assert.equal(compactionStarts > 0, true);
	assert.equal(explicitNextTurnSeenDuringContinuation, false);
	assert.equal(lifecycle.filter((event) => event === "agent_end").length >= 2, true);
	assert.equal(lifecycle.filter((event) => event === "agent_settled").length, 1);

	const entries = host.session.sessionManager.getEntries();
	assert.equal(
		entries.some((entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some((part) =>
				part.type === "toolCall" && part.name === "agent_wait"
			)
		),
		false,
	);
});

test("native custom input wakes a parked working Owner and remains in model context", {
	timeout: 10_000,
}, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	let releaseAnswer!: () => void;
	const answerGate = new Promise<void>((resolve) => {
		releaseAnswer = resolve;
	});
	const lifecycle: string[] = [];
	host.session.subscribe((event) => {
		if (event.type === "agent_end") lifecycle.push("agent_end");
		if (event.type === "agent_settled") lifecycle.push("agent_settled");
	});
	const requestMarker = "OWNER_NATIVE_CUSTOM_WAKE_REQUEST";
	const customProbe = "Process this custom input using native active-Agent semantics.";
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		if (
			serialized.includes(requestMarker) &&
			serialized.includes("requestMessageId") &&
			!serialized.includes("spawn-native-custom-wake")
		) {
			if (!serialized.includes("answer-native-custom-wake")) {
				await answerGate;
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "Native custom wake test complete." },
						{ id: "answer-native-custom-wake" },
					),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("The child Answer was committed.");
		}
		if (!serialized.includes("spawn-native-custom-wake")) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_spawn",
					{ request: requestMarker },
					{ id: "spawn-native-custom-wake" },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (serialized.includes("Native custom wake test complete.")) {
			return fauxAssistantMessage("The Owner received the final Answer.");
		}
		if (serialized.includes(customProbe)) {
			return fauxAssistantMessage("The parked Owner processed native custom input.");
		}
		return fauxAssistantMessage("The Owner is parked with background work outstanding.");
	};
	host.model.setResponses(Array.from({ length: 8 }, () => routeResponse));

	const prompt = host.session.prompt(requestMarker);
	await waitUntil(() => ownerAssistantTexts(host).includes(
		"The Owner is parked with background work outstanding.",
	));
	assert.equal(host.session.isIdle, false);
	assert.deepEqual(lifecycle, ["agent_end"]);

	await host.session.sendCustomMessage({
		customType: "owner-parking-native-custom-wake",
		content: customProbe,
		display: false,
	});
	await waitUntil(() => ownerAssistantTexts(host).includes(
		"The parked Owner processed native custom input.",
	));
	assert.equal(host.session.isIdle, false);
	assert.equal(lifecycle.includes("agent_settled"), false);
	assert.equal(
		host.session.sessionManager.getEntries().some((entry) =>
			entry.type === "custom_message" && entry.content === customProbe
		),
		true,
	);

	releaseAnswer();
	await withTimeout(prompt, 5_000, "Owner did not settle after the final Answer");
	assert.equal(lifecycle.filter((event) => event === "agent_settled").length, 1);
});

function ownerDockText(host: Awaited<ReturnType<typeof createTestOwnerHost>>): string {
	return [...host.ui.widgets.values()].flatMap((widget) => "render" in widget ? widget.render(180) : widget).join("\n");
}

function ownerAssistantTexts(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): string[] {
	return host.session.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return [];
		return entry.message.content.flatMap((part) =>
			part.type === "text" ? [part.text] : []
		);
	});
}

async function withTimeout(
	operation: Promise<void>,
	milliseconds: number,
	message: string,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected Owner parking condition was not reached");
}
