import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import type { MessageBoundaryHooks } from "../src/coordination/workflow-coordinator.ts";
import type {
	AgentWaitBoundaryHooks,
	AgentWaitClock,
} from "../src/coordination/agent-waits.ts";
import type { AgentWaitAnswer } from "../src/protocol/agent-wait.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { answerSourceDeliveryRequestId } from "../src/protocol/request-resolution.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	WorkflowPolicyStore,
	parseWorkflowPolicy,
} from "../src/policy/workflow-policy.ts";
import type { AgentRunState } from "../src/runtime/agent-runtime-supervisor.ts";
import { registerOwnerAgentTools } from "../src/tools/owner-surfaces.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestCleanupRegistrar,
} from "./support/pi-host.ts";

for (const failure of ["admission rejection", "renamed working directory"] as const) {
	test(`definite initial Request non-admission leaves no dependency or retryable Request: ${failure}`, async (t) => {
		const harness = await createDormantChildHarness(t, failure === "admission rejection" ? {
			beforeDeliveryAdmission: ({ operation }) => operation === "send" ? "confirmed_failure" : undefined,
		} : {});
		if (failure === "renamed working directory") {
			const cwd = join(harness.host.cwd, "responder-project");
			await mkdir(cwd);
			const spawnInput = { title: "Fixture request", request: "Wait for work in this project.", config: { cwd } };
			harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(
				fauxToolCall("agent_spawn", spawnInput, { id: "spawn-with-project-cwd" }), { stopReason: "toolUse" },
			));
			const child = await harness.view.spawn("spawn-with-project-cwd", spawnInput);
			if (!("agentId" in child)) throw new Error("Child Identity was not created");
			harness.childId = child.agentId;
			await rename(cwd, `${cwd}-renamed`);
		}
		const before = retentionCount(harness.view.status().run, "awaiting_answer");
		const input = { title: "Fixture request", operation: "request" as const, targetAgent: harness.childId, question: "This work was never admitted." };
		const toolCallId = "request-definite-non-admission";
		harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }), { stopReason: "toolUse" },
		));
		const receipt = await harness.view.message(toolCallId, input);
		assert.equal("messageStatus" in receipt && receipt.messageStatus, "not_sent");
		assert.equal("reason" in receipt && receipt.reason, "target_unavailable");
		assert.equal(harness.view.status(harness.childId).run.phase, "dormant");
		if (!("requestMessageId" in receipt)) throw new Error("Missing Request correlation identity");
		assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), before);
		harness.host.session.sessionManager.appendMessage({
			role: "toolResult", toolCallId, toolName: "agent_message",
			content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt,
			isError: false, timestamp: Date.now(),
		});
		harness.view.reconcileCommittedToolResults();
		assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), before);
		const retryInput = { operation: "retry" as const, messageId: receipt.requestMessageId };
		const retryCallId = "retry-unadmitted-request";
		harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryCallId }), { stopReason: "toolUse" },
		));
		await assert.rejects(harness.view.message(retryCallId, retryInput), /unknown_identity: Request .* was not created/);
		const waitInput = { requestMessageIds: [receipt.requestMessageId] };
		harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(
			fauxToolCall("agent_wait", waitInput, { id: "wait-unadmitted-request" }), { stopReason: "toolUse" },
		));
		await assert.rejects(harness.view.wait("wait-unadmitted-request", waitInput, new AbortController().signal), /is not outstanding/);
		const cancelInput = { operation: "cancel" as const, requestMessageId: receipt.requestMessageId, reason: "No work exists to cancel." };
		harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: "cancel-unadmitted-request" }), { stopReason: "toolUse" },
		));
		await assert.rejects(harness.view.message("cancel-unadmitted-request", cancelInput), /unknown_identity: Request .* was not created/);
		assert.equal(harness.view.status(harness.childId).run.phase, "dormant");
		await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
	});
}

test("Request commitment retains its requester and Delivery obligates its responder", async (t) => {
	const harness = await createDormantChildHarness(t);
	assert.equal(harness.view.status(harness.childId).run.phase, "dormant");

	const input = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Which exact transcript fact proves the release handoff?",
	};
	const toolCallId = "request-release-proof";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const sourceEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(sourceEntry);
	const source = {
		agentId: harness.host.session.sessionId,
		entryId: sourceEntry.id,
		toolCallId,
	};
	const requestId = deriveMessageId(source);

	harness.host.model.setResponses([
		fauxAssistantMessage("I received the correlated Request."),
	]);
	const receipt = await harness.view.message(toolCallId, input);
	assert.deepEqual(receipt, {
		requestMessageId: requestId,
		targetAgentId: harness.childId,
		messageStatus: "sent",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
	assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), 2);

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const deliveryEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [source] }),
	);
	const delivery = deliveryEntries.find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [source] }),
	);
	assert.ok(delivery && delivery.type === "custom_message");
	assert.deepEqual(JSON.parse(delivery.content as string), {
		messages: [
			{
				title: "Fixture request",
				kind: "request",
				requestMessageId: requestId,
				fromAgentId: harness.host.session.sessionId,
				question: input.question,
			},
		],
	});
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1,
	);
	const retryToolCallId = "retry-delivered-unanswered-request";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(await harness.view.message(retryToolCallId, retryInput), {
		disposition: "request_delivered",
		requestMessageId: requestId,
		deliveryEvidence: {
			agentId: harness.childId,
			entryId: delivery.id,
		},
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a prepared continuation Request crosses retry scheduling into child working-zone preparation", async (t) => {
	const harness = await createDormantChildHarness(t);
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const childSession = SessionManager.open(childSessionFile);
	for (const section of ["Earlier", "Later"]) {
		childSession.appendMessage({
			role: "user",
			content: [{
				type: "text",
				text: `${section} acquired context.${" relevant history".repeat(10_500)}`,
			}],
			timestamp: Date.now(),
		});
	}

	harness.host.model.setResponses([
		fauxAssistantMessage("Existing context retained for the continuation."),
		fauxAssistantMessage("The prepared continuation Request was delivered."),
	]);
	const toolCallId = "prepared-continuation-request";
	const input = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Continue issue 83 using the relevant context already acquired.",
		contextPreparation: {
			workScale: "large" as const,
			contextDependence: "low" as const,
		},
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const initialReceipt = unconfirmedRequestReceipt(harness, toolCallId, input);
	assert.equal("messageStatus" in initialReceipt && initialReceipt.messageStatus, "unknown");
	if (!("requestMessageId" in initialReceipt)) {
		throw new Error("Prepared Request receipt has no identity");
	}
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(initialReceipt) }],
		details: initialReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const retryToolCallId = "retry-prepared-continuation-request";
	const retryInput = {
		operation: "retry" as const,
		messageId: initialReceipt.requestMessageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await harness.view.message(retryToolCallId, retryInput);
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "sent");
	if (!("requestMessageId" in receipt)) {
		throw new Error("Retried prepared Request receipt has no identity");
	}
	assert.equal(receipt.requestMessageId, initialReceipt.requestMessageId);

	const entries = await waitForEntry(childSessionFile, (entry) =>
		entry.type === "custom_message" &&
		entry.customType === "agent-coordination.message-delivery" &&
		JSON.stringify(entry.content).includes(receipt.requestMessageId)
	);
	const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
	const deliveryIndex = entries.findIndex((entry) =>
		entry.type === "custom_message" &&
		entry.customType === "agent-coordination.message-delivery" &&
		JSON.stringify(entry.content).includes(receipt.requestMessageId)
	);
	assert.notEqual(compactionIndex, -1);
	assert.notEqual(deliveryIndex, -1);
	assert.equal(compactionIndex < deliveryIndex, true);
	const delivery = entries[deliveryIndex];
	assert.ok(delivery?.type === "custom_message");
	assert.deepEqual(JSON.parse(delivery.content as string), {
		messages: [{
			title: "Fixture request",
			kind: "request",
			requestMessageId: receipt.requestMessageId,
			fromAgentId: harness.host.session.sessionId,
			question: input.question,
		}],
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("an active responder rejects ordinary Message authorship to its requester while preserving structured communication", async (t) => {
	const harness = await createDormantChildHarness(t);
	const siblingId = await spawnDormantSibling(harness, "answer-lane-sibling");
	const rejectedCallId = "reject-provisional-message-to-requester";
	const reverseRequestCallId = "admit-reverse-request-to-requester";
	const unrelatedSendCallId = "admit-message-to-unrelated-agent";
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	harness.host.model.setResponses([
		fauxAssistantMessage([
			fauxToolCall("agent_message", {
				operation: "send",
				targetAgent: harness.host.session.sessionId,
				content: "This provisional finding must not enter the Answer route.",
			}, { id: rejectedCallId }),
			fauxToolCall("agent_message", {
				title: "Fixture request",
				operation: "request",
				targetAgent: harness.host.session.sessionId,
				question: "Which requester decision is required before the curated Answer?",
			}, { id: reverseRequestCallId }),
			fauxToolCall("agent_message", {
				operation: "send",
				targetAgent: siblingId,
				content: "This unrelated coordination remains available.",
			}, { id: unrelatedSendCallId }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("The structured communication results are complete."),
		fauxAssistantMessage("The reverse Request reached the requester."),
		fauxAssistantMessage("The unrelated Message reached its recipient."),
	]);

	const requestReceipt = await authorOwnerRequest(
		harness,
		"request-structured-answer-route",
	);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === unrelatedSendCallId,
	);
	const rejectedResult = requireToolResult(entries, rejectedCallId);
	const reverseRequestResult = requireToolResult(entries, reverseRequestCallId);
	const unrelatedSendResult = requireToolResult(entries, unrelatedSendCallId);
	assert.deepEqual(rejectedResult.message.details, {
		disposition: "rejected",
		reason: "answer_required",
		requestMessageId: requestReceipt.requestMessageId,
	});
	assert.equal(rejectedResult.message.isError, false);
	assert.equal(
		(reverseRequestResult.message.details as { messageStatus?: string }).messageStatus,
		"sent",
	);
	assert.equal(
		(unrelatedSendResult.message.details as { messageStatus?: string }).messageStatus,
		"sent",
	);
	const rejectedSourceEntry = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === rejectedCallId,
			),
	);
	assert.ok(rejectedSourceEntry);
	const rejectedSource = {
		agentId: harness.childId,
		entryId: rejectedSourceEntry.id,
		toolCallId: rejectedCallId,
	};
	assert.equal(
		harness.host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) === JSON.stringify({ messages: [rejectedSource] }),
		),
		false,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("ordinary Message authorship to the requester resumes after Answer commitment", async (t) => {
	const harness = await createDormantChildHarness(t, {
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmed_failure" : undefined,
	});
	const answerCallId = "commit-answer-before-ordinary-message";
	const sendCallId = "send-after-answer-commitment";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
				answer: "The curated Answer ends the active obligation.",
			}, { id: answerCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "send",
				targetAgent: harness.host.session.sessionId,
				content: "Independent communication is available after Answer commitment.",
			}, { id: sendCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The post-Answer Message was admitted."),
		fauxAssistantMessage("The requester received the post-Answer Message."),
	]);

	await authorOwnerRequest(harness, "request-before-post-answer-send");
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	await waitForEntry(childSessionFile, entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === answerCallId);
	const wakeInput = { operation: "send" as const, targetAgent: harness.childId, content: "Continue the independent communication." };
	harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", wakeInput, { id: "wake-after-answer" }), { stopReason: "toolUse" }));
	await harness.view.message("wake-after-answer", wakeInput);

	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === sendCallId,
	);
	assert.equal(
		(requireToolResult(entries, sendCallId).message.details as { messageStatus?: string })
			.messageStatus,
		"sent",
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("ordinary Message authorship to the requester resumes after Cancellation Delivery", async (t) => {
	const harness = await createDormantChildHarness(t);
	const sendCallId = "send-after-cancellation-delivery";
	harness.host.model.setResponses([
		fauxAssistantMessage("The Request remains active until Cancellation Delivery."),
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "send",
				targetAgent: harness.host.session.sessionId,
				content: "Independent communication is available after Cancellation Delivery.",
			}, { id: sendCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The post-Cancellation Message was admitted."),
		fauxAssistantMessage("The requester received the post-Cancellation Message."),
	]);

	const request = await authorOwnerRequest(
		harness,
		"request-before-post-cancellation-send",
	);
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1,
	);
	const cancelCallId = "cancel-before-ordinary-message";
	const cancelInput = {
		operation: "cancel" as const,
		requestMessageId: request.requestMessageId,
		reason: "End the responder obligation before unrelated communication.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellation = await harness.view.message(cancelCallId, cancelInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === sendCallId,
	);
	assert.equal(
		(requireToolResult(entries, sendCallId).message.details as { messageStatus?: string })
			.messageStatus,
		"sent",
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a Steer Request reaches an occupied responder and cancelling the earlier Request leaves it outstanding", async (t) => {
	const harness = await createDormantChildHarness(t);
	harness.host.model.setResponses([
		fauxAssistantMessage("The first Request is active."),
		fauxAssistantMessage("Both Requests remain actionable."),
		fauxAssistantMessage("The earlier Request was cancelled."),
	]);

	const firstCallId = "serial-request-first";
	const firstInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Hold the incoming Request slot.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", firstInput, { id: firstCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const firstEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(firstEntry);
	const firstSource = {
		agentId: harness.host.session.sessionId,
		entryId: firstEntry.id,
		toolCallId: firstCallId,
	};
	const firstReceipt = await harness.view.message(firstCallId, firstInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: firstCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(firstReceipt) }],
		details: firstReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [firstSource] }),
	);
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1,
	);

	const secondCallId = "serial-request-second-steer";
	const secondInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Bring this Request to attention while the earlier one remains outstanding.",
		deliveryMode: "steer" as const,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", secondInput, { id: secondCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const secondEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(secondEntry);
	const secondSource = {
		agentId: harness.host.session.sessionId,
		entryId: secondEntry.id,
		toolCallId: secondCallId,
	};
	const secondReceipt = await harness.view.message(secondCallId, secondInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: secondCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(secondReceipt) }],
		details: secondReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForEntry(childSessionFile, (entry) =>
		entry.type === "custom_message" &&
		entry.customType === "agent-coordination.message-delivery" &&
		JSON.stringify(entry.details) === JSON.stringify({ messages: [secondSource] }),
	);
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 2,
	);

	if (!("requestMessageId" in firstReceipt)) {
		throw new Error("First Request receipt has no identity");
	}
	const cancelCallId = "serial-request-release-first";
	const cancelInput = {
		operation: "cancel" as const,
		requestMessageId: firstReceipt.requestMessageId,
		reason: "Withdraw only the earlier Request.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellation = await harness.view.message(cancelCallId, cancelInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [secondSource] }),
	);
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("an explicit Answer resolves its named Request and releases queued Deferred work", async (t) => {
	const harness = await createDormantChildHarness(t);
	let releaseFirstAnswer!: () => void;
	const firstAnswerGate = new Promise<void>((resolve) => {
		releaseFirstAnswer = resolve;
	});
	const answerCallId = "answer-current-request";
	harness.host.model.setResponses([
		async (context) => {
			await firstAnswerGate;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
						answer: "Resolve the foreground Request.",
					},
					{ id: answerCallId },
				),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("The Answer committed."),
		fauxAssistantMessage("The requester received its Answer."),
		fauxAssistantMessage("The second Request is now active."),
	]);

	const authorRequest = async (toolCallId: string, question: string) => {
		const input = {
			title: "Fixture request",
			operation: "request" as const,
			targetAgent: harness.childId,
			question,
		};
		harness.host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_message", input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
		const entry = harness.host.session.sessionManager.getLeafEntry();
		assert.ok(entry);
		const source = {
			agentId: harness.host.session.sessionId,
			entryId: entry.id,
			toolCallId,
		};
		const receipt = await harness.view.message(toolCallId, input);
		harness.host.session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "agent_message",
			content: [{ type: "text", text: JSON.stringify(receipt) }],
			details: receipt,
			isError: false,
			timestamp: Date.now(),
		});
		return { source, receipt };
	};

	const first = await authorRequest(
		"queue-before-explicit-answer",
		"Answer this Request before the next one can deliver.",
	);
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [first.source] }),
	);
	const second = await authorRequest(
		"promote-after-explicit-answer",
		"Become active after the first Answer commits.",
	);
	releaseFirstAnswer();

	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerCallId,
	);
	const answerResult = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerCallId,
	);
	assert.ok(
		answerResult &&
		answerResult.type === "message" &&
		answerResult.message.role === "toolResult",
	);
	assert.equal(answerResult.message.isError, false);
	assert.equal(
		(answerResult.message.details as { requestMessageId?: string }).requestMessageId,
		"requestMessageId" in first.receipt
			? first.receipt.requestMessageId
			: undefined,
	);
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [second.source] }),
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("status reports exact Request retention multiplicity", async (t) => {
	const harness = await createDormantChildHarness(t, {
		scheduleDeliveryDispatch: () => undefined,
		afterDeliveryAdmission: () => "confirmation_lost",
	});
	assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), 1);

	const requestIds: string[] = [];
	for (const suffix of ["first", "second"]) {
		const toolCallId = `request-retention-${suffix}`;
		const input = {
			title: "Fixture request",
			operation: "request" as const,
			targetAgent: harness.childId,
			question: `Retain the ${suffix} exact Request.`,
		};
		harness.host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_message", input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
		const receipt = await harness.view.message(toolCallId, input);
		assert.ok("requestMessageId" in receipt);
		requestIds.push(receipt.requestMessageId);
		harness.host.session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "agent_message",
			content: [{ type: "text", text: JSON.stringify(receipt) }],
			details: receipt,
			isError: false,
			timestamp: Date.now(),
		});
	}
	await harness.view.reachSafeBoundary();
	assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), 3);

	const requestId = requestIds[0];
	assert.ok(requestId);
	const cancelToolCallId = "cancel-one-of-several-retained-requests";
	const cancelInput = {
		operation: "cancel" as const,
		requestMessageId: requestId,
		reason: "Resolve only this exact Request relationship.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellation = await harness.view.message(cancelToolCallId, cancelInput);
	assert.ok("messageId" in cancellation && "messageStatus" in cancellation);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});
	assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), 2);

	const repeatedCancelToolCallId = "cancel-already-cancelled-request";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: repeatedCancelToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(
		await harness.view.message(repeatedCancelToolCallId, cancelInput),
		{
			disposition: "already_cancelled",
			cancellationMessageId: cancellation.messageId,
		},
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Request retry reports indeterminate when admission confirmation is lost", async (t) => {
	const harness = await createDormantChildHarness(t, {
		afterDeliveryAdmission: ({ operation }) =>
			operation === "retry" ? "confirmation_lost" : undefined,
	});
	const requestToolCallId = "request-before-lost-retry-confirmation";
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Retry this same Request while its initial admission is uncertain.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const request = unconfirmedRequestReceipt(harness, requestToolCallId, requestInput);
	assert.ok("requestMessageId" in request);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(request) }],
		details: request,
		isError: false,
		timestamp: Date.now(),
	});

	harness.host.model.setResponses([
		fauxAssistantMessage("The retried Request reached its responder."),
	]);
	const retryToolCallId = "retry-with-lost-admission-confirmation";
	const retryInput = {
		operation: "retry" as const,
		messageId: request.requestMessageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(await harness.view.message(retryToolCallId, retryInput), {
		requestMessageId: request.requestMessageId,
		targetAgentId: harness.childId,
		messageStatus: "unknown",
		reason: "confirmation_lost",
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("only the requester may cancel and only the responder may Answer", async (t) => {
	const harness = await createDormantChildHarness(t);
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Keep participant authority fixed by this Request.",
	};
	const requestToolCallId = "request-participant-authority";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const unauthorizedCancelCallId = "responder-cannot-cancel-request";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "cancel",
					requestMessageId: requestId,
					reason: "A responder cannot abandon the requester's wait.",
				},
				{ id: unauthorizedCancelCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Participant authority remains unchanged."),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === unauthorizedCancelCallId,
	);
	const unauthorizedCancellation = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === unauthorizedCancelCallId,
	);
	if (
		!unauthorizedCancellation ||
		unauthorizedCancellation.type !== "message" ||
		unauthorizedCancellation.message.role !== "toolResult"
	) {
		throw new Error("Unauthorized Cancellation result did not commit");
	}
	assert.equal(unauthorizedCancellation.message.isError, true);
	assert.match(
		JSON.stringify(unauthorizedCancellation.message.content),
		/wrong_participant/,
	);

	const unauthorizedAnswerCallId = "requester-cannot-answer-own-request";
	const unauthorizedAnswerInput = {
		operation: "answer" as const, requestId: requestId,
		answer: "The requester cannot impersonate the responder.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", unauthorizedAnswerInput, {
				id: unauthorizedAnswerCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	await assert.rejects(
		harness.view.message(unauthorizedAnswerCallId, unauthorizedAnswerInput),
		/wrong_participant/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Answer commitment survives lost scheduling confirmation", async (t) => {
	let answerObligationAtAdmission: number | undefined;
	let harness!: Awaited<ReturnType<typeof createDormantChildHarness>>;
	harness = await createDormantChildHarness(t, {
		afterDeliveryAdmission: ({ operation }) => {
			if (operation !== "answer") return undefined;
			answerObligationAtAdmission = retentionCount(
				harness.view.status(harness.childId).run,
				"answer_owed",
			);
			return "confirmation_lost";
		},
	});
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Report the first canonical Answer only.",
	};
	const requestToolCallId = "request-one-answer";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const firstAnswerCallId = "answer-first";
		harness.host.model.setResponses([
		fauxAssistantMessage("The Request remains active until a later turn."),
		(context) => fauxAssistantMessage(
			[
				fauxToolCall(
					"agent_message",
					{
						operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
						answer: "The first committed Answer is authoritative.",
					},
					{ id: firstAnswerCallId },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The requester received the canonical Answer."),
		fauxAssistantMessage("The responder observed the first-Answer result."),
	]);

	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1,
	);
	const wakeCallId = "wake-responder-for-answer-batch";
	const wakeInput = {
		operation: "send" as const,
		targetAgent: harness.childId,
		content: "Answer the active Request now.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", wakeInput, { id: wakeCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const wakeReceipt = await harness.view.message(wakeCallId, wakeInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: wakeCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(wakeReceipt) }],
		details: wakeReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === firstAnswerCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === firstAnswerCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerId = deriveMessageId({
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: firstAnswerCallId,
	});
	const firstResult = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === firstAnswerCallId,
	);
	if (
		!firstResult ||
		firstResult.type !== "message" ||
		firstResult.message.role !== "toolResult"
	) {
		throw new Error("First Answer result did not commit");
	}
	assert.equal(
		answerObligationAtAdmission,
		1,
		"Answer obligation remains until the native tool result commits",
	);
	assert.deepEqual(firstResult.message.details, {
		requestTitle: "Fixture request",
		messageId: answerId,
		requestMessageId: requestId,
		messageStatus: "unknown",
		reason: "confirmation_lost",
	});
	await waitForCondition(
		() => retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 0,
	);
	assert.equal(
		retentionCount(harness.view.status().run, "awaiting_answer"),
		1,
		"the unresolved Creation Request must keep the requester retained",
	);
	await waitForCondition(() =>
		harness.host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({
						messages: [
							{
								agentId: harness.childId,
								entryId: answerSourceEntry.id,
								toolCallId: firstAnswerCallId,
							},
						],
					}),
		),
	);
	const lateCancelCallId = "cancel-after-answer-delivery";
	const lateCancelInput = {
		operation: "cancel" as const,
		requestMessageId: requestId,
		reason: "This cancellation lost the requester-lane race.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", lateCancelInput, { id: lateCancelCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(
		await harness.view.message(lateCancelCallId, lateCancelInput),
		{
			disposition: "already_answered",
			answerMessageId: answerId,
		},
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Request retry retrieves a committed Answer whose Delivery was lost", async (t) => {
	const harness = await createDormantChildHarness(t, {
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmed_failure" : undefined,
	});
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Return the committed Answer through Request retry.",
	};
	const requestToolCallId = "request-lost-answer";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-with-lost-delivery";
	const answerText = "The responder committed this immutable Answer.";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: answerText },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Answer remains committed after scheduling failure."),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageId(answerSource);
	const answerResult = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	if (
		!answerResult ||
		answerResult.type !== "message" ||
		answerResult.message.role !== "toolResult"
	) {
		throw new Error("Answer result did not commit");
	}
	assert.deepEqual(answerResult.message.details, {
		requestTitle: "Fixture request",
		messageId: answerId,
		requestMessageId: requestId,
		messageStatus: "not_sent",
		reason: "target_unavailable",
	});

	const retryToolCallId = "retrieve-lost-answer";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const retrieval = await harness.view.message(retryToolCallId, retryInput);
	assert.deepEqual(retrieval, {
		requestTitle: "Fixture request",
		disposition: "answer_delivered",
		requestMessageId: requestId,
		answerId,
		fromAgentId: harness.childId,
		answer: answerText,
		answerSource,
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: retryToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(retrieval) }],
		details: retrieval,
		isError: false,
		timestamp: Date.now(),
	});
	const retrievalEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(retrievalEntry);
	await harness.view.reachSafeBoundary();

	const repeatedRetryCallId = "observe-retrieved-answer";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: repeatedRetryCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const repeated = await harness.view.message(repeatedRetryCallId, retryInput);
	assert.deepEqual(repeated, {
		requestTitle: "Fixture request",
		disposition: "answer_already_delivered",
		requestMessageId: requestId,
		answerId,
		deliveryEvidence: {
			agentId: harness.host.session.sessionId,
			entryId: retrievalEntry.id,
		},
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Agent Wait retrieves an outstanding Answer and rejects a join once none remain", async (t) => {
	const harness = await createDormantChildHarness(t, {
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmed_failure" : undefined,
	});
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-lost-answer-wait");
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Return the committed Answer through Agent Wait.",
	};
	const requestToolCallId = "request-before-agent-wait";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-before-agent-wait";
	const answerText = "Agent Wait retrieved this immutable Answer.";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: answerText },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Answer remains committed for retrieval."),
	]);
	const requestReceipt = await harness.view.message(requestToolCallId, requestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);
	const waitToolCallId = "wait-for-lost-answer";
	const waitInput = {};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", waitInput, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
	);

	let progress: unknown;
	const result = await harness.view.wait(
		waitToolCallId,
		waitInput,
		new AbortController().signal,
		(update) => {
			progress = update;
		},
	);
	assert.deepEqual(progress, {
		waitingFor: [{
			requestTitle: "Fixture request",
			requestMessageId: requestId,
			responderAgentId: harness.childId,
		}],
	});
	assert.deepEqual(result, {
		answers: [{
			requestTitle: "Fixture request",
			disposition: "answer_delivered",
			requestMessageId: requestId,
			answerId: deriveMessageId(answerSource),
			fromAgentId: harness.childId,
			answer: answerText,
			answerSource,
		}],
	});
	const waitResultMessage = {
		role: "toolResult" as const,
		toolCallId: waitToolCallId,
		toolName: "agent_wait",
		content: [{ type: "text" as const, text: JSON.stringify(result) }],
		details: result,
		isError: false,
		timestamp: Date.now(),
	};
	assert.equal(harness.view.guardToolResult(waitResultMessage), undefined);
	harness.host.session.sessionManager.appendMessage(waitResultMessage);
	harness.view.reconcileCommittedToolResults();

	const repeatedCallId = "wait-with-no-outstanding-requests";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", waitInput, { id: repeatedCallId }),
			{ stopReason: "toolUse" },
		),
	);
	await assert.rejects(
		() => harness.view.wait(
			repeatedCallId,
			waitInput,
			new AbortController().signal,
		),
		/invalid_input: Agent Wait requires at least one outstanding outbound Agent Request/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Agent Wait excludes an Answer retrieved earlier in the same tool batch", async (t) => {
	const harness = await createDormantChildHarness(t, {
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmed_failure" : undefined,
	});
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-retry-wait-batch");
	const requestMessageId = await commitHarnessAnswer(
		harness,
		"request-before-retry-wait-batch",
		"answer-before-retry-wait-batch",
		"The retry retrieves this Answer before the Wait executes.",
	);
	const retryToolCallId = "retry-before-wait-in-one-batch";
	const waitToolCallId = "wait-after-retry-in-one-batch";
	const retryInput = { operation: "retry" as const, messageId: requestMessageId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			[
				fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
				fauxToolCall("agent_wait", {}, { id: waitToolCallId }),
			],
			{ stopReason: "toolUse" },
		),
	);
	const retryResult = await harness.view.message(retryToolCallId, retryInput);
	assert.equal(
		"disposition" in retryResult ? retryResult.disposition : undefined,
		"answer_delivered",
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: retryToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(retryResult) }],
		details: retryResult,
		isError: false,
		timestamp: Date.now(),
	});

	await assert.rejects(
		() => harness.view.wait(
			waitToolCallId,
			{},
			new AbortController().signal,
		),
		/invalid_input: Agent Wait requires at least one outstanding outbound Agent Request/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Agent Wait joins every outstanding Request in authoring order", async (t) => {
	let releaseFirstAnswer!: () => void;
	const firstAnswerGate = new Promise<void>((resolve) => {
		releaseFirstAnswer = resolve;
	});
	const harness = await createDormantChildHarness(t, {
		scheduleDeliveryDispatch: ({ kind }, dispatch) => {
			if (kind !== "answer") dispatch();
		},
	});
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-aggregate-wait");
	const waitToolCallId = "wait-for-all-outstanding-requests";
	const firstQuestion = "Resolve the first joined Request.";
	const secondQuestion = "Resolve the second joined Request.";
	const routeModelCall = async (messages: Context) => {
		const context = JSON.stringify(messages);
		if (context.includes("OWNER_JOIN_ALL_OUTSTANDING")) {
			return context.includes(waitToolCallId)
				? fauxAssistantMessage("The aggregate Answer set is complete.")
				: fauxAssistantMessage(
					fauxToolCall("agent_wait", {}, { id: waitToolCallId }),
					{ stopReason: "toolUse" },
				);
		}
		if (context.includes(secondQuestion)) {
			return context.includes("answer-second-joined-request")
				? fauxAssistantMessage("The second joined Answer committed.")
				: fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{ operation: "answer", requestId: latestRequestFromContext(messages).requestMessageId, answer: "Second joined Answer." },
						{ id: "answer-second-joined-request" },
					),
					{ stopReason: "toolUse" },
				);
		}
		if (context.includes(firstQuestion)) {
			if (context.includes("answer-first-joined-request")) {
				return fauxAssistantMessage("The first joined Answer committed.");
			}
			await firstAnswerGate;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{ operation: "answer", requestId: latestRequestFromContext(messages).requestMessageId, answer: "First joined Answer." },
					{ id: "answer-first-joined-request" },
				),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("No coordination action was needed.");
	};
	harness.host.model.setResponses(Array.from({ length: 8 }, () => routeModelCall));

	const authorRequest = async (toolCallId: string, question: string) => {
		const input = {
			title: "Fixture request",
			operation: "request" as const,
			targetAgent: harness.childId,
			question,
		};
		harness.host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_message", input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
		const receipt = await harness.view.message(toolCallId, input);
		harness.host.session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "agent_message",
			content: [{ type: "text", text: JSON.stringify(receipt) }],
			details: receipt,
			isError: false,
			timestamp: Date.now(),
		});
		if (!("requestMessageId" in receipt)) throw new Error("Request has no identity");
		return receipt.requestMessageId;
	};
	const firstRequestId = await authorRequest("author-first-joined-request", firstQuestion);
	const secondRequestId = await authorRequest("author-second-joined-request", secondQuestion);
	const prompt = harness.host.session.prompt("OWNER_JOIN_ALL_OUTSTANDING");
	releaseFirstAnswer();
	await prompt;

	const waitResult = requireToolResult(
		harness.host.session.sessionManager.getEntries(),
		waitToolCallId,
	).message.details;
	assert.ok(waitResult && typeof waitResult === "object" && "answers" in waitResult);
	const answers = (waitResult as { answers: AgentWaitAnswer[] }).answers;
	assert.deepEqual(
		answers.map(({ requestMessageId }) => requestMessageId),
		[firstRequestId, secondRequestId],
	);
	assert.deepEqual(
		answers.map((answer) =>
			answer.disposition === "answer_delivered" ? answer.answer : undefined
		),
		["First joined Answer.", "Second joined Answer."],
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Agent Wait excludes Requests authored after its call in the same tool batch", async (t) => {
	const harness = await createDormantChildHarness(t, {
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmed_failure" : undefined,
	});
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-wait-boundary");
	const firstRequestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Answer the Request before the Wait boundary.",
	};
	const laterRequestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Remain outside the preceding Wait boundary.",
	};
	const firstRequestToolCallId = "request-before-wait-boundary";
	const waitToolCallId = "wait-between-request-sources";
	const laterRequestToolCallId = "request-after-wait-boundary";
	const sourceEntryId = harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			[
				fauxToolCall("agent_message", firstRequestInput, {
					id: firstRequestToolCallId,
				}),
				fauxToolCall("agent_wait", {}, { id: waitToolCallId }),
				fauxToolCall("agent_message", laterRequestInput, {
					id: laterRequestToolCallId,
				}),
			],
			{ stopReason: "toolUse" },
		),
	);
	const firstRequestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: sourceEntryId,
		toolCallId: firstRequestToolCallId,
	});
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "Boundary Answer." },
				{ id: "answer-before-wait-boundary" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The boundary Answer committed."),
	]);
	const requestReceipt = await harness.view.message(
		firstRequestToolCallId,
		firstRequestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: firstRequestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	await waitForEntry(childSessionFile, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === "answer-before-wait-boundary" &&
		entry.message.isError === false
	);

	const result = await harness.view.wait(
		waitToolCallId,
		{},
		new AbortController().signal,
	);
	assert.ok(!("disposition" in result));
	assert.deepEqual(
		result.answers.map(({ requestMessageId }) => requestMessageId),
		[firstRequestId],
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Agent Wait retrieval retires a queued direct Answer Delivery before it can commit", async (t) => {
	let markAnswerDispatchHeld!: () => void;
	const answerDispatchHeld = new Promise<void>((resolve) => {
		markAnswerDispatchHeld = resolve;
	});
	let releaseAnswerDispatch!: () => void;
	const harness = await createDormantChildHarness(t, {
		scheduleDeliveryDispatch: ({ kind }, dispatch) => {
			if (kind !== "answer") {
				dispatch();
				return;
			}
			releaseAnswerDispatch = () => dispatch();
			markAnswerDispatchHeld();
		},
	});
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-held-answer-wait");
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Commit an Answer while its direct Delivery is held.",
	};
	const requestToolCallId = "request-before-held-answer-delivery";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-with-held-direct-delivery";
	const answerText = "Agent Wait retrieval retired the queued direct Delivery.";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: answerText },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			"The Answer result committed while its direct Delivery was held.",
		),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await answerDispatchHeld;

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageId(answerSource);

	const waitToolCallId = "wait-before-held-answer-delivery";
	const waitInput = {};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", waitInput, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const result = await harness.view.wait(
		waitToolCallId,
		waitInput,
		new AbortController().signal,
	);
	assert.deepEqual(result, {
		answers: [
			{
				requestTitle: "Fixture request",
				disposition: "answer_delivered",
				requestMessageId: requestId,
				answerId,
				fromAgentId: harness.childId,
				answer: answerText,
				answerSource,
			},
		],
	});
	const waitResultMessage = {
		role: "toolResult" as const,
		toolCallId: waitToolCallId,
		toolName: "agent_wait",
		content: [{ type: "text" as const, text: JSON.stringify(result) }],
		details: result,
		isError: false,
		timestamp: Date.now(),
	};
	assert.equal(harness.view.guardToolResult(waitResultMessage), undefined);
	harness.host.session.sessionManager.appendMessage(waitResultMessage);
	const waitResultEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(waitResultEntry);
	harness.view.reconcileCommittedToolResults();

	releaseAnswerDispatch();
	await harness.view.reachSafeBoundary();
	await waitForCondition(
		() => retentionCount(harness.view.status().run, "awaiting_answer") === 0,
	);
	const ownerEntries = harness.host.session.sessionManager.getEntries();
	assert.equal(
		ownerEntries.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [answerSource] }),
		),
		false,
	);
	assert.equal(
		answerSourceDeliveryRequestId({
			requesterAgentId: harness.host.session.sessionId,
			transcript: transcriptFromSessionManager(
				harness.host.session.sessionManager,
			).inspect(),
			source: answerSource,
		}),
		requestId,
	);

	const retryToolCallId = "retry-after-retrieval-retired-direct-delivery";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(await harness.view.message(retryToolCallId, retryInput), {
		requestTitle: "Fixture request",
		disposition: "answer_already_delivered",
		requestMessageId: requestId,
		answerId,
		deliveryEvidence: {
			agentId: harness.host.session.sessionId,
			entryId: waitResultEntry.id,
		},
	});

	const rootToolCallId = "root-tool-after-retrieval-retirement";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "send" as const,
					targetAgent: harness.childId,
					content: "Admit this root call after the Answer retrieval race.",
				},
				{ id: rootToolCallId },
			),
			{ stopReason: "toolUse" },
		),
	);
	assert.doesNotThrow(() =>
		harness.view.beginToolExecution(rootToolCallId, "agent_message"),
	);

	await harness.coordinator.shutdown(async () =>
		harness.host.runtime.dispose(),
	);
});

test("Request retry retrieval retires a queued direct Answer Delivery before it can commit", async (t) => {
	let markAnswerDispatchHeld!: () => void;
	const answerDispatchHeld = new Promise<void>((resolve) => {
		markAnswerDispatchHeld = resolve;
	});
	let releaseAnswerDispatch!: () => void;
	let commitRetryRetrieval: (() => void) | undefined;
	const harness = await createDormantChildHarness(t, {
		scheduleDeliveryDispatch: ({ kind }, dispatch) => {
			if (kind !== "answer") {
				dispatch();
				return;
			}
			releaseAnswerDispatch = dispatch;
			markAnswerDispatchHeld();
		},
		afterSteerFreeze: () => commitRetryRetrieval?.(),
	});
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Commit an Answer while retry wins its direct Delivery freeze.",
	};
	const requestToolCallId = "request-before-retry-held-answer-delivery";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-with-direct-delivery-held-for-retry";
	const answerText = "Request retry retired the queued direct Delivery.";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: answerText },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The responder committed the Answer."),
	]);
	const requestReceipt = await harness.view.message(requestToolCallId, requestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await answerDispatchHeld;

	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageId(answerSource);

	const retryToolCallId = "retry-before-held-answer-delivery";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const result = await harness.view.message(retryToolCallId, retryInput);
	assert.deepEqual(result, {
		requestTitle: "Fixture request",
		disposition: "answer_delivered",
		requestMessageId: requestId,
		answerId,
		fromAgentId: harness.childId,
		answer: answerText,
		answerSource,
	});
	commitRetryRetrieval = () => {
		harness.host.session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: retryToolCallId,
			toolName: "agent_message",
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
			isError: false,
			timestamp: Date.now(),
		});
	};

	releaseAnswerDispatch();
	await harness.view.reachSafeBoundary();
	assert.equal(
		harness.host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [answerSource] }),
		),
		false,
	);
	assert.equal(
		answerSourceDeliveryRequestId({
			requesterAgentId: harness.host.session.sessionId,
			transcript: transcriptFromSessionManager(
				harness.host.session.sessionManager,
			).inspect(),
			source: answerSource,
		}),
		requestId,
	);

	await harness.coordinator.shutdown(async () =>
		harness.host.runtime.dispose(),
	);
});

test("a retired Delivery dispatch callback cannot bypass a later queued Message", async (t) => {
	type HeldDispatch = Readonly<{ messageId: string; dispatch(): void }>;
	let ownerAgentId: string | undefined;
	const heldOwnerDispatches: HeldDispatch[] = [];
	let markTwoAnswerDispatchesHeld!: () => void;
	const twoAnswerDispatchesHeld = new Promise<void>((resolve) => {
		markTwoAnswerDispatchesHeld = resolve;
	});
	const harness = await createDormantChildHarness(t, {
		scheduleDeliveryDispatch: ({ recipientAgentId, messageId }, dispatch) => {
			if (recipientAgentId !== ownerAgentId) {
				dispatch();
				return;
			}
			heldOwnerDispatches.push({ messageId, dispatch });
			if (heldOwnerDispatches.length === 2) markTwoAnswerDispatchesHeld();
		},
	});
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-stale-dispatch-wait");
	ownerAgentId = harness.host.session.sessionId;
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Answer, then send a separate follow-up Message.",
	};
	const requestToolCallId = "request-before-stale-answer-dispatch";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: ownerAgentId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-before-stale-dispatch-release";
	const followUpToolCallId = "message-queued-behind-held-answer";
	const answerText = "The Answer will be retrieved before direct dispatch.";
	const followUpContent = "This later Message must receive its own dispatch boundary.";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: answerText },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "send",
					targetAgent: ownerAgentId,
					content: followUpContent,
				},
				{ id: followUpToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The separate follow-up Message was admitted."),
	]);
	const requestReceipt = await harness.view.message(requestToolCallId, requestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const answeredSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	await waitForEntry(answeredSessionFile, entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === answerToolCallId);
	const wakeInput = { operation: "send" as const, targetAgent: harness.childId, content: "Send the independent follow-up." };
	harness.host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", wakeInput, { id: "wake-for-follow-up" }), { stopReason: "toolUse" }));
	await harness.view.message("wake-for-follow-up", wakeInput);
	await twoAnswerDispatchesHeld;

	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === followUpToolCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	const followUpSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === followUpToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	assert.ok(followUpSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageId(answerSource);
	const followUpSource = {
		agentId: harness.childId,
		entryId: followUpSourceEntry.id,
		toolCallId: followUpToolCallId,
	};
	const followUpId = deriveMessageId(followUpSource);
	assert.deepEqual(
		heldOwnerDispatches.map(({ messageId }) => messageId),
		[answerId, answerId],
	);

	const waitToolCallId = "wait-before-stale-answer-dispatch-release";
	const waitInput = {};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", waitInput, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const waitResult = await harness.view.wait(
		waitToolCallId,
		waitInput,
		new AbortController().signal,
	);
	const waitResultMessage = {
		role: "toolResult" as const,
		toolCallId: waitToolCallId,
		toolName: "agent_wait",
		content: [{ type: "text" as const, text: JSON.stringify(waitResult) }],
		details: waitResult,
		isError: false,
		timestamp: Date.now(),
	};
	assert.equal(harness.view.guardToolResult(waitResultMessage), undefined);
	harness.host.session.sessionManager.appendMessage(waitResultMessage);
	harness.view.reconcileCommittedToolResults();

	heldOwnerDispatches[0]!.dispatch();
	await harness.view.reachSafeBoundary();
	assert.deepEqual(
		heldOwnerDispatches.map(({ messageId }) => messageId),
		[answerId, answerId, followUpId],
	);
	assert.equal(
		harness.host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [followUpSource] }),
		),
		false,
	);

	heldOwnerDispatches[2]!.dispatch();
	await waitForCondition(() =>
		harness.host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [followUpSource] }),
		),
	);
	heldOwnerDispatches[1]!.dispatch();
	await harness.view.reachSafeBoundary();
	assert.equal(
		harness.host.session.sessionManager.getEntries().filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [followUpSource] }),
		).length,
		1,
	);

	await harness.coordinator.shutdown(async () =>
		harness.host.runtime.dispose(),
	);
});

test("Answer retrievals re-arbitrate when direct Answer Delivery commits first", async (t) => {
	let ownerAgentId: string | undefined;
	let markAnswerDispatchHeld!: () => void;
	const answerDispatchHeld = new Promise<void>((resolve) => {
		markAnswerDispatchHeld = resolve;
	});
	let releaseAnswerDispatch!: () => void;
	let markAnswerFreezeHeld!: () => void;
	const answerFreezeHeld = new Promise<void>((resolve) => {
		markAnswerFreezeHeld = resolve;
	});
	let releaseAnswerFreeze!: () => Promise<void>;
	const harness = await createDormantChildHarness(t, {
		scheduleDeliveryDispatch: ({ kind }, dispatch) => {
			if (kind !== "answer") {
				dispatch();
				return;
			}
			releaseAnswerDispatch = () => dispatch();
			markAnswerDispatchHeld();
		},
		afterSteerFreeze: ({ recipientAgentId, release }) => {
			if (recipientAgentId !== ownerAgentId) return;
			releaseAnswerFreeze = release;
			markAnswerFreezeHeld();
			return "defer";
		},
	});
	ownerAgentId = harness.host.session.sessionId;
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-rearbitrated-wait");
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Let the reserved direct Answer Delivery commit before Agent Wait.",
	};
	const requestToolCallId = "request-before-direct-answer-delivery";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-before-agent-wait-direct-delivery";
	const answerText = "The direct Answer Delivery reached the requester first.";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: answerText },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The responder committed the Answer."),
		fauxAssistantMessage("The requester received the direct Answer Delivery."),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await answerDispatchHeld;

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageId(answerSource);
	const selectedRetryToolCallId = "retry-before-direct-answer-delivery-commits";
	const selectedRetryInput = { operation: "retry" as const, messageId: requestId };
	const waitToolCallId = "wait-before-direct-answer-delivery-commits";
	const waitInput = {};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			[
				fauxToolCall("agent_message", selectedRetryInput, {
					id: selectedRetryToolCallId,
				}),
				fauxToolCall("agent_wait", waitInput, { id: waitToolCallId }),
			],
			{ stopReason: "toolUse" },
		),
	);
	const selectedRetryResult = await harness.view.message(
		selectedRetryToolCallId,
		selectedRetryInput,
	);
	assert.equal(
		"disposition" in selectedRetryResult
			? selectedRetryResult.disposition
			: undefined,
		"answer_delivered",
	);
	const selectedWaitResult = await harness.view.wait(
		waitToolCallId,
		waitInput,
		new AbortController().signal,
	);
	assert.equal(
		"answers" in selectedWaitResult
			? selectedWaitResult.answers[0]?.disposition
			: undefined,
		"answer_delivered",
	);

	releaseAnswerDispatch();
	await answerFreezeHeld;
	const committedRetryResult = {
		requestMessageId: requestId,
		messageStatus: "unknown" as const,
		reason: "inspection_incomplete" as const,
	};
	const selectedRetryResultMessage = {
		role: "toolResult" as const,
		toolCallId: selectedRetryToolCallId,
		toolName: "agent_message",
		content: [{ type: "text" as const, text: JSON.stringify(selectedRetryResult) }],
		details: selectedRetryResult,
		isError: false,
		timestamp: Date.now(),
	};
	const guardedRetry = harness.view.guardToolResult(selectedRetryResultMessage);
	assert.deepEqual(guardedRetry?.message, {
		...selectedRetryResultMessage,
		content: [{ type: "text", text: JSON.stringify(committedRetryResult) }],
		details: committedRetryResult,
	});
	if (!guardedRetry) throw new Error("Request retry did not yield to direct Delivery");
	harness.host.session.sessionManager.appendMessage(guardedRetry.message);

	await releaseAnswerFreeze();
	await waitForCondition(() =>
		harness.host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "agent-coordination.message-delivery" &&
					JSON.stringify(entry.details) ===
						JSON.stringify({ messages: [answerSource] }),
			),
	);
	const directDeliveryEntry = harness.host.session.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [answerSource] }),
		);
	assert.ok(directDeliveryEntry);
	assert.equal(
		answerSourceDeliveryRequestId({
			requesterAgentId: harness.host.session.sessionId,
			transcript: transcriptFromSessionManager(
				harness.host.session.sessionManager,
			).inspect(),
			source: answerSource,
		}),
		requestId,
	);

	const committedWaitResult = {
		answers: [
			{
				requestTitle: "Fixture request",
				disposition: "answer_already_delivered" as const,
				requestMessageId: requestId,
				answerId,
				deliveryEvidence: {
					agentId: harness.host.session.sessionId,
					entryId: directDeliveryEntry.id,
				},
			},
		],
	};
	const selectedWaitResultMessage = {
		role: "toolResult" as const,
		toolCallId: waitToolCallId,
		toolName: "agent_wait",
		content: [{ type: "text" as const, text: JSON.stringify(selectedWaitResult) }],
		details: selectedWaitResult,
		isError: false,
		timestamp: Date.now(),
	};
	const guarded = harness.view.guardToolResult(selectedWaitResultMessage);
	assert.deepEqual(guarded?.message, {
		...selectedWaitResultMessage,
		content: [{ type: "text", text: JSON.stringify(committedWaitResult) }],
		details: committedWaitResult,
	});
	if (!guarded) throw new Error("Agent Wait did not arbitrate direct Delivery proof");
	harness.host.session.sessionManager.appendMessage(guarded.message);
	harness.view.reconcileCommittedToolResults();

	await harness.coordinator.shutdown(async () =>
		harness.host.runtime.dispose(),
	);
});

test("an exact-Run fence prevents a resolved Agent Wait from becoming Answer Delivery proof", async (t) => {
	let resultCommitBoundaryReached = false;
	const harness = await createDormantChildHarness(t, {
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmed_failure" : undefined,
	}, undefined, {
		beforeResultCommit: ({ failExactRun }) => {
			resultCommitBoundaryReached = true;
			failExactRun();
		},
	});
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-resolved-fence-wait");
	const requestToolCallId = "request-before-fenced-wait";
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Commit an Answer before the requester wait is fenced.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-before-fenced-wait";
	const answerText = "This Answer remains undelivered after the wait fence.";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: answerText },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Answer is committed but undelivered."),
	]);
	const requestReceipt = await harness.view.message(requestToolCallId, requestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	const waitToolCallId = "fence-resolved-agent-wait";
	const waitInput = {};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", waitInput, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const result = await harness.view.wait(
		waitToolCallId,
		waitInput,
		new AbortController().signal,
	);
	const guarded = harness.view.guardToolResult({
		role: "toolResult",
		toolCallId: waitToolCallId,
		toolName: "agent_wait",
		content: [{ type: "text", text: JSON.stringify(result) }],
		details: result,
		isError: false,
		timestamp: Date.now(),
	});
	assert.equal(resultCommitBoundaryReached, true);
	const guardedMessage = guarded?.message;
	assert.equal(guardedMessage?.role, "toolResult");
	assert.equal(
		guardedMessage?.role === "toolResult" ? guardedMessage.isError : false,
		true,
	);
	if (!guardedMessage) throw new Error("Agent Wait fence did not replace its result");
	harness.host.session.sessionManager.appendMessage(guardedMessage);
	harness.view.reconcileCommittedToolResults();
	assert.equal(answerSourceDeliveryRequestId({
		requesterAgentId: harness.host.session.sessionId,
		transcript: transcriptFromSessionManager(
			harness.host.session.sessionManager,
		).inspect(),
		source: answerSource,
	}), undefined);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("an exact-Run fence prevents a preempted Agent Wait result from committing", async (t) => {
	const waitToolCallId = "fence-preempted-agent-wait";
	let resultCommitBoundaryReached = false;
	const harness = await createDormantChildHarness(
		t,
		{},
		undefined,
		{
			beforeResultCommit: ({ toolCallId, failExactRun }) => {
				if (toolCallId !== waitToolCallId) return;
				resultCommitBoundaryReached = true;
				failExactRun();
			},
		},
	);
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-preempted-fence-wait");
	const ownerAgentId = harness.host.session.sessionId;
	const selectedRequestToolCallId = "request-before-preemption-fence";
	const selectedRequestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Remain unanswered while preemption loses its exact Run.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", selectedRequestInput, {
				id: selectedRequestToolCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	const selectedRequestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(selectedRequestEntry);
	const selectedRequestId = deriveMessageId({
		agentId: ownerAgentId,
		entryId: selectedRequestEntry.id,
		toolCallId: selectedRequestToolCallId,
	});
	const selectedReceipt = unconfirmedRequestReceipt(harness, selectedRequestToolCallId, selectedRequestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: selectedRequestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(selectedReceipt) }],
		details: selectedReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	let releaseInboundRequest!: () => void;
	const inboundRequestGate = new Promise<void>((resolve) => {
		releaseInboundRequest = resolve;
	});
	const inboundRequestToolCallId = "request-that-preempts-fenced-wait";
	const routeModelCall = async (messages: Context) => {
		const context = JSON.stringify(messages);
		if (context.includes(inboundRequestToolCallId)) {
			return fauxAssistantMessage("The inbound Request was admitted before the fence.");
		}
		await inboundRequestGate;
		return fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					title: "Fixture request",
					operation: "request",
					targetAgent: ownerAgentId,
					question: "Preempt the wait before its exact Run is fenced.",
				},
				{ id: inboundRequestToolCallId },
			),
			{ stopReason: "toolUse" },
		);
	};
	harness.host.model.setResponses(Array.from({ length: 4 }, () => routeModelCall));
	const triggerToolCallId = "trigger-preemption-fence-request";
	const triggerInput = {
		operation: "send" as const,
		targetAgent: harness.childId,
		content: "Author the inbound Request after the Owner parks.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", triggerInput, { id: triggerToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const triggerReceipt = await harness.view.message(triggerToolCallId, triggerInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: triggerToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(triggerReceipt) }],
		details: triggerReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const waitInput = {};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", waitInput, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const wait = harness.view.wait(
		waitToolCallId,
		waitInput,
		new AbortController().signal,
	);
	await waitForCondition(() => {
		const run = harness.view.status().run;
		return "attention" in run && run.attention === "agent_wait";
	});
	releaseInboundRequest();
	const selectedResult = await settleBeforeTimeout(
		wait,
		"Inbound Request did not produce a preemption candidate",
	);
	assert.deepEqual(selectedResult, { disposition: "preempted" });
	const selectedResultMessage = {
		role: "toolResult" as const,
		toolCallId: waitToolCallId,
		toolName: "agent_wait",
		content: [{ type: "text" as const, text: JSON.stringify(selectedResult) }],
		details: selectedResult,
		isError: false,
		timestamp: Date.now(),
	};
	const guarded = harness.view.guardToolResult(selectedResultMessage);
	assert.equal(resultCommitBoundaryReached, true);
	const guardedMessage = guarded?.message;
	assert.equal(guardedMessage?.role, "toolResult");
	assert.equal(
		guardedMessage?.role === "toolResult" ? guardedMessage.isError : false,
		true,
	);
	if (!guardedMessage) throw new Error("Exact-Run fence did not replace preemption result");
	harness.host.session.sessionManager.appendMessage(guardedMessage);
	harness.view.reconcileCommittedToolResults();

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Agent Wait parks the Owner Run until the pending Answer commits", async (t) => {
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns":1}'),
	);
	const scheduledReconciliations: number[] = [];
	let cancelledReconciliations = 0;
	const clock: AgentWaitClock = {
		schedule(delayMs) {
			scheduledReconciliations.push(delayMs);
			return () => {
				cancelledReconciliations += 1;
			};
		},
	};
	const harness = await createDormantChildHarness(t, {
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer"
				? "confirmed_failure"
				: undefined,
	}, policy, undefined, clock);
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-capacity-wait");
	const requestToolCallId = "request-before-capacity-wait";
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Answer only after the requester parks its execution.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const requestReceipt = unconfirmedRequestReceipt(harness, requestToolCallId, requestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	assert.deepEqual(requestReceipt, {
		requestMessageId: requestId,
		targetAgentId: harness.childId,
		messageStatus: "unknown",
		reason: "confirmation_lost",
	});

	const retryToolCallId = "retry-before-owner-waits";
	const waitToolCallId = "park-owner-for-answer";
	const waitInput = {};
	const answerToolCallId = "answer-after-owner-parks";
	const answerText = "The responder answered while the Owner waited.";
	let responderStarted!: () => void;
	const responderStart = new Promise<void>((resolve) => {
		responderStarted = resolve;
	});
	let releaseResponder!: () => void;
	const responderRelease = new Promise<void>((resolve) => {
		releaseResponder = resolve;
	});
	harness.host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"agent_message",
					{ operation: "retry", messageId: requestId },
					{ id: retryToolCallId },
				),
				fauxToolCall("agent_wait", waitInput, { id: waitToolCallId }),
			],
			{ stopReason: "toolUse" },
		),
		async (context) => {
			responderStarted();
			await responderRelease;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: answerText },
					{ id: answerToolCallId },
				),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("The responder committed its Answer."),
		fauxAssistantMessage("The requester received the aggregate wait result."),
	]);
	const prompt = harness.host.session.prompt("Retry the Request, then wait for its Answer.");
	await responderStart;
	const parked = harness.view.status().run;
	assert.equal("attention" in parked ? parked.attention : undefined, "agent_wait");
	assert.equal("work" in parked ? parked.work : undefined, "settled");
	releaseResponder();
	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			prompt,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Agent Wait did not complete after the Answer")),
					4_000,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
	const waitEntry = harness.host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === waitToolCallId,
	);
	assert.ok(waitEntry && waitEntry.type === "message" && waitEntry.message.role === "toolResult");
	assert.equal(
		waitEntry.message.isError,
		false,
		JSON.stringify(waitEntry.message.content),
	);
	const result = waitEntry.message.details as { answers: Array<{
		disposition: string;
		answer?: string;
	}> };
	assert.equal(result.answers[0]?.disposition, "answer_delivered");
	assert.equal(
		result.answers[0]?.answer,
		answerText,
	);
	assert.deepEqual(scheduledReconciliations, [5_000]);
	assert.equal(cancelledReconciliations, 1);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("primary input in a selected child preempts Agent Wait before its next model turn", async (t) => {
	let ownerAgentId: string | undefined;
	const harness = await createDormantChildHarness(t, {
		// Keep the Owner-bound Request scheduled but undelivered so this test
		// exercises human preemption, not Wait's lost-delivery recovery.
		scheduleDeliveryDispatch: ({ recipientAgentId }, dispatch) => {
			if (recipientAgentId !== ownerAgentId) dispatch();
		},
	});
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-child-human-preemption");
	ownerAgentId = harness.host.session.sessionId;
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const directionMarker = "CHILD_WAIT_FOR_PRIMARY_HUMAN_INPUT";
	const humanDirection = "Redirect the selected child before its Answer arrives.";
	const requestCallId = "child-request-before-human-preemption";
	const waitCallId = "child-wait-before-human-preemption";
	let childRanBeforeHumanInput = false;
	let preemptedResultReachedDirectedTurn = false;
	const routeResponse = async (messages: Context) => {
		const serialized = JSON.stringify(messages);
		if (serialized.includes(humanDirection)) {
			preemptedResultReachedDirectedTurn = serialized.includes(
				'"disposition":"preempted"',
			);
			return fauxAssistantMessage("The selected child acted on the human direction.");
		}
		if (serialized.includes('"disposition":"preempted"')) {
			childRanBeforeHumanInput = true;
			return fauxAssistantMessage("The child resumed before human input was admitted.");
		}
		if (!serialized.includes(requestCallId)) {
			return fauxAssistantMessage([
				fauxToolCall(
					"agent_message",
					{
						title: "Fixture request",
						operation: "request",
						targetAgent: ownerAgentId!,
						question: "Remain unanswered while the child receives human direction.",
					},
					{ id: requestCallId },
				),
				fauxToolCall("agent_wait", {}, { id: waitCallId }),
			], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("The child is still waiting.");
	};
	harness.host.model.setResponses(Array.from({ length: 6 }, () => routeResponse));
	const directionCallId = "direct-child-into-human-preempted-wait";
	const directionInput = {
		operation: "send" as const,
		targetAgent: harness.childId,
		content: directionMarker,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", directionInput, { id: directionCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const directionReceipt = await harness.view.message(directionCallId, directionInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: directionCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(directionReceipt) }],
		details: directionReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForCondition(() => {
		const run = harness.view.status(harness.childId).run;
		return "attention" in run && run.attention === "agent_wait";
	});

	const selected = await harness.view.openAgentView(harness.childId);
	assert.ok(selected);
	selected.projection().dispatchInput(`${humanDirection}\r`);
	const entries = await waitForEntry(childSessionFile, (entry) =>
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((part) =>
			part.type === "text" &&
			part.text === "The selected child acted on the human direction."
		)
	);

	assert.equal(childRanBeforeHumanInput, false);
	assert.equal(preemptedResultReachedDirectedTurn, true);
	const waitResult = requireToolResult(entries, waitCallId);
	assert.deepEqual(waitResult.message.details, { disposition: "preempted" });
	assert.equal(
		retentionCount(harness.view.status(harness.childId).run, "awaiting_answer"),
		1,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("an inbound reverse Request preempts Agent Wait and the requester can re-wait", async (t) => {
	let moderatorRunStarts = 0;
	const harness = await createDormantChildHarness(
		t,
		{},
		new WorkflowPolicyStore(
			parseWorkflowPolicy('{"maxConcurrentAgentRuns":1}'),
		),
		undefined,
		undefined,
		() => {
			moderatorRunStarts += 1;
		},
	);
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-reverse-request-wait");
	const ownerAgentId = harness.host.session.sessionId;
	const originalRequestToolCallId = "request-before-reverse-preemption";
	const originalQuestion = "Ask the requester for one decision before answering.";
	const originalRequestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: originalQuestion,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", originalRequestInput, {
				id: originalRequestToolCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	const originalRequestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(originalRequestEntry);
	const originalRequestId = deriveMessageId({
		agentId: ownerAgentId,
		entryId: originalRequestEntry.id,
		toolCallId: originalRequestToolCallId,
	});
	const retryOriginalRequestToolCallId = "retry-before-reverse-preemption";
	const firstWaitToolCallId = "wait-preempted-by-reverse-request";

	const deferredMessageToolCallId = "deferred-message-before-reverse-request";
	const reverseRequestToolCallId = "request-decision-from-waiting-requester";
	const reverseAnswerToolCallId = "answer-reverse-request";
	const originalAnswerToolCallId = "answer-after-reverse-decision";
	const deferredMessage = "This ordinary Deferred Message must remain queued.";
	const reverseQuestion = "Should I use the concise form?";
	const reverseAnswer = "Yes, use the concise form.";
	const originalAnswer = "Used the requested concise form.";
	let releaseReverseRequest!: () => void;
	const reverseRequestGate = new Promise<void>((resolve) => {
		releaseReverseRequest = resolve;
	});
	const routeModelCall = async (messages: Context) => {
		const context = JSON.stringify(messages);
		if (context.includes("OWNER_WAIT_FOR_REVERSE_REQUEST")) {
			if (
				context.includes(originalAnswer)
			) return fauxAssistantMessage("The nested coordination completed.");
			if (context.includes('"disposition":"preempted"')) {
				return fauxAssistantMessage([
					fauxToolCall(
						"agent_message",
						{ operation: "answer", requestId: latestRequestFromContext(messages).requestMessageId, answer: reverseAnswer },
						{ id: reverseAnswerToolCallId },
					),
				], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([
				fauxToolCall(
					"agent_message",
					{ operation: "retry", messageId: originalRequestId },
					{ id: retryOriginalRequestToolCallId },
				),
				fauxToolCall(
					"agent_wait",
					{},
					{ id: firstWaitToolCallId },
				),
			], { stopReason: "toolUse" });
		}
		if (context.includes(reverseAnswer)) {
			return context.includes(originalAnswerToolCallId)
				? fauxAssistantMessage("The original Answer is committed.")
				: fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{ operation: "answer", requestId: latestRequestFromContext(messages).requestMessageId, answer: originalAnswer },
						{ id: originalAnswerToolCallId },
					),
					{ stopReason: "toolUse" },
				);
		}
		if (context.includes(reverseRequestToolCallId)) {
			return fauxAssistantMessage("I need the requester decision before answering.");
		}
		await reverseRequestGate;
		return fauxAssistantMessage([
			fauxToolCall(
				"agent_message",
				{
					operation: "send",
					targetAgent: ownerAgentId,
					content: deferredMessage,
				},
				{ id: deferredMessageToolCallId },
			),
			fauxToolCall(
				"agent_message",
				{
					title: "Fixture request",
					operation: "request",
					targetAgent: ownerAgentId,
					question: reverseQuestion,
				},
				{ id: reverseRequestToolCallId },
			),
		], { stopReason: "toolUse" });
	};
	harness.host.model.setResponses(Array.from({ length: 8 }, () => routeModelCall));

	const requestReceipt = unconfirmedRequestReceipt(harness, originalRequestToolCallId, originalRequestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: originalRequestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const prompt = harness.host.session.prompt("OWNER_WAIT_FOR_REVERSE_REQUEST");
	await waitForCondition(() => {
		const run = harness.view.status().run;
		return "attention" in run && run.attention === "agent_wait";
	});
	releaseReverseRequest();
	await settleBeforeTimeout(
		prompt,
		"Inbound reverse Request did not preempt Agent Wait",
	);

	await waitForCondition(() => harness.host.session.sessionManager.getEntries().some(entry => entry.type === "custom_message" && JSON.stringify(entry.content).includes(originalAnswer)));
	const ownerEntries = harness.host.session.sessionManager.getEntries();
	const firstWaitResult = ownerEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === firstWaitToolCallId,
	);
	assert.ok(
		firstWaitResult?.type === "message" &&
		firstWaitResult.message.role === "toolResult",
	);
	assert.equal(firstWaitResult.message.isError, false);
	assert.deepEqual(firstWaitResult.message.details, { disposition: "preempted" });
	const reverseDeliveryIndex = ownerEntries.findIndex(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.content).includes(reverseQuestion),
	);
	const reverseAnswerIndex = ownerEntries.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === reverseAnswerToolCallId,
			),
	);
	assert.notEqual(reverseDeliveryIndex, -1);
	assert.ok(reverseDeliveryIndex < reverseAnswerIndex);
	assert.equal(
		ownerEntries.slice(0, reverseAnswerIndex).some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.content).includes(deferredMessage),
		),
		false,
	);
	await harness.view.reachSafeBoundary();
	assert.equal(moderatorRunStarts, 0);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a pending third-party Request preempts a wait for another responder", async (t) => {
	let ownerAgentId: string | undefined;
	let markInboundRequestAdmitted!: () => void;
	const inboundRequestAdmitted = new Promise<void>((resolve) => {
		markInboundRequestAdmitted = resolve;
	});
	const harness = await createDormantChildHarness(t, {
		afterDeliveryAdmission: ({ recipientAgentId }) => {
			if (recipientAgentId === ownerAgentId) markInboundRequestAdmitted();
		},
	});
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-third-party-wait");
	ownerAgentId = harness.host.session.sessionId;
	const spawnThirdPartyToolCallId = "spawn-third-party-requester";
	const spawnThirdPartyInput = {
		title: "Fixture request",
		request: "Wait for a trigger, then ask the Owner an unrelated Request.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnThirdPartyInput, {
				id: spawnThirdPartyToolCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	const thirdParty = await harness.view.spawn(
		spawnThirdPartyToolCallId,
		spawnThirdPartyInput,
	);
	assert.equal(thirdParty.spawnStatus, "created");
	if (!("agentId" in thirdParty)) throw new Error("Third-party Agent was not created");

	const selectedRequestToolCallId = "request-selected-other-responder";
	const selectedRequestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Remain unanswered while a third party asks for attention.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", selectedRequestInput, {
				id: selectedRequestToolCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	const selectedRequestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(selectedRequestEntry);
	const selectedRequestId = deriveMessageId({
		agentId: ownerAgentId,
		entryId: selectedRequestEntry.id,
		toolCallId: selectedRequestToolCallId,
	});
	const selectedReceipt = unconfirmedRequestReceipt(harness, selectedRequestToolCallId, selectedRequestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: selectedRequestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(selectedReceipt) }],
		details: selectedReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const thirdPartyQuestion = "Can you review this independent choice?";
	const thirdPartyRequestToolCallId = "third-party-request-during-wait";
	const waitToolCallId = "wait-preempted-by-third-party";
	let releaseThirdParty!: () => void;
	const thirdPartyGate = new Promise<void>((resolve) => {
		releaseThirdParty = resolve;
	});
	let markThirdPartyGenerationStarted!: () => void;
	const thirdPartyGenerationStarted = new Promise<void>((resolve) => {
		markThirdPartyGenerationStarted = resolve;
	});
	let markOwnerGenerationStarted!: () => void;
	const ownerGenerationStarted = new Promise<void>((resolve) => {
		markOwnerGenerationStarted = resolve;
	});
	let markSelectedResponderStarted!: () => void;
	const selectedResponderStarted = new Promise<void>((resolve) => {
		markSelectedResponderStarted = resolve;
	});
	let releaseSelectedResponder!: () => void;
	const selectedResponderGate = new Promise<void>((resolve) => {
		releaseSelectedResponder = resolve;
	});
	t.after(() => releaseSelectedResponder());
	const routeModelCall = async (messages: Context) => {
		const context = JSON.stringify(messages);
		if (context.includes("OWNER_WAIT_FOR_THIRD_PARTY_REQUEST")) {
			markOwnerGenerationStarted();
			await inboundRequestAdmitted;
			return context.includes('"disposition":"preempted"')
				? fauxAssistantMessage("The unrelated inbound Request has my attention.")
				: fauxAssistantMessage(
					fauxToolCall(
						"agent_wait",
						{},
						{ id: waitToolCallId },
					),
					{ stopReason: "toolUse" },
				);
		}
		if (context.includes(selectedRequestInput.question)) {
			markSelectedResponderStarted();
			await selectedResponderGate;
			return fauxAssistantMessage("The selected Request remains unanswered.");
		}
		if (context.includes(thirdPartyRequestToolCallId)) {
			return fauxAssistantMessage("The independent Request was admitted.");
		}
		markThirdPartyGenerationStarted();
		await thirdPartyGate;
		return fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					title: "Fixture request",
					operation: "request",
					targetAgent: ownerAgentId,
					question: thirdPartyQuestion,
				},
				{ id: thirdPartyRequestToolCallId },
			),
			{ stopReason: "toolUse" },
		);
	};
	harness.host.model.setResponses(Array.from({ length: 5 }, () => routeModelCall));

	const selectedRetryToolCallId = "retry-selected-request-before-third-party-wait";
	const selectedRetryInput = {
		operation: "retry" as const,
		messageId: selectedRequestId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", selectedRetryInput, {
				id: selectedRetryToolCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	const selectedRetryReceipt = await harness.view.message(
		selectedRetryToolCallId,
		selectedRetryInput,
	);
	assert.equal(
		"messageStatus" in selectedRetryReceipt
			? selectedRetryReceipt.messageStatus
			: undefined,
		"sent",
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: selectedRetryToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(selectedRetryReceipt) }],
		details: selectedRetryReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await selectedResponderStarted;

	const triggerToolCallId = "trigger-third-party-requester";
	const triggerInput = {
		operation: "send" as const,
		targetAgent: thirdParty.agentId,
		content: "Ask the independent Request now.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", triggerInput, { id: triggerToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const triggerReceipt = await harness.view.message(triggerToolCallId, triggerInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: triggerToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(triggerReceipt) }],
		details: triggerReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await thirdPartyGenerationStarted;
	const prompt = harness.host.session.prompt("OWNER_WAIT_FOR_THIRD_PARTY_REQUEST");
	await ownerGenerationStarted;
	releaseThirdParty();
	await settleBeforeTimeout(
		prompt,
		"Third-party Request did not preempt Agent Wait",
	);

	const entries = harness.host.session.sessionManager.getEntries();
	const waitResult = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === waitToolCallId,
	);
	assert.ok(waitResult?.type === "message" && waitResult.message.role === "toolResult");
	assert.deepEqual(waitResult.message.details, { disposition: "preempted" });
	assert.equal(waitResult.message.isError, false);
	assert.equal(entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.content).includes(thirdPartyQuestion) &&
			JSON.stringify(entry.content).includes(thirdParty.agentId),
	), true);

	releaseSelectedResponder();
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a completed outstanding aggregate wins the inbound Request preemption race", async (t) => {
	let ownerAgentId: string | undefined;
	let commitSelectedAnswer = () => undefined;
	let raceBoundaryChecks = 0;
	const harness = await createDormantChildHarness(
		t,
		{
			beforeDeliveryAdmission: ({ recipientAgentId, operation }) => {
				if (operation === "send" && recipientAgentId === ownerAgentId) {
					commitSelectedAnswer();
				}
			},
		},
		undefined,
		{
			beforePreemptionDecision: () => {
				raceBoundaryChecks += 1;
			},
		},
	);
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-completion-race-wait");
	ownerAgentId = harness.host.session.sessionId;
	const selectedRequestToolCallId = "request-before-completion-race";
	const selectedRequestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Commit the selected Answer at the inbound Request race boundary.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", selectedRequestInput, {
				id: selectedRequestToolCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	const selectedRequestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(selectedRequestEntry);
	const selectedRequestId = deriveMessageId({
		agentId: ownerAgentId,
		entryId: selectedRequestEntry.id,
		toolCallId: selectedRequestToolCallId,
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("Keep the selected Request active until the race boundary."),
	]);
	const selectedReceipt = await harness.view.message(
		selectedRequestToolCallId,
		selectedRequestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: selectedRequestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(selectedReceipt) }],
		details: selectedReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1
	);
	const selectedResponderSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const selectedAnswerToolCallId = "answer-at-preemption-race-boundary";
	const selectedAnswer = "The completed aggregate wins the race.";
	let selectedAnswerSource: {
		agentId: string;
		entryId: string;
		toolCallId: string;
	} | undefined;
	commitSelectedAnswer = () => {
		if (selectedAnswerSource) return;
		const session = SessionManager.open(selectedResponderSessionFile);
		const entryId = session.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{ operation: "answer", requestId: selectedRequestId, answer: selectedAnswer },
					{ id: selectedAnswerToolCallId },
				),
				{ stopReason: "toolUse" },
			),
		);
		selectedAnswerSource = {
			agentId: harness.childId,
			entryId,
			toolCallId: selectedAnswerToolCallId,
		};
		session.appendMessage({
			role: "toolResult",
			toolCallId: selectedAnswerToolCallId,
			toolName: "agent_message",
			content: [{ type: "text", text: "Selected Answer committed." }],
			details: {
				requestTitle: "Fixture request",
				messageId: deriveMessageId(selectedAnswerSource),
				requestMessageId: selectedRequestId,
				messageStatus: "not_sent",
				reason: "target_unavailable",
			},
			isError: false,
			timestamp: Date.now(),
		});
	};

	const spawnThirdPartyToolCallId = "spawn-race-third-party";
	const spawnThirdPartyInput = { title: "Fixture request", request: "Ask an independent Request when triggered." };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnThirdPartyInput, {
				id: spawnThirdPartyToolCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	const thirdParty = await harness.view.spawn(
		spawnThirdPartyToolCallId,
		spawnThirdPartyInput,
	);
	if (!("agentId" in thirdParty) || !("requestMessageId" in thirdParty)) {
		throw new Error("Race third-party Agent was not created");
	}
	await cancelHarnessRequest(
		harness,
		thirdParty.requestMessageId,
		thirdParty.agentId,
		"cancel-race-third-party-creation-request",
	);
	const inboundRequestToolCallId = "inbound-request-at-answer-race";
	const waitToolCallId = "wait-that-wins-completion-race";
	let releaseInboundRequest!: () => void;
	const inboundRequestGate = new Promise<void>((resolve) => {
		releaseInboundRequest = resolve;
	});
	const routeModelCall = async (messages: Context) => {
		const context = JSON.stringify(messages);
		if (context.includes("OWNER_WAIT_FOR_COMPLETION_RACE")) {
			return context.includes(selectedAnswer)
				? fauxAssistantMessage("The completed outstanding aggregate won.")
				: fauxAssistantMessage(
					fauxToolCall(
						"agent_wait",
						{},
						{ id: waitToolCallId },
					),
					{ stopReason: "toolUse" },
				);
		}
		if (context.includes(inboundRequestToolCallId)) {
			return fauxAssistantMessage("The race-triggering Request was admitted.");
		}
		await inboundRequestGate;
		return fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					title: "Fixture request",
					operation: "request",
					targetAgent: ownerAgentId as string,
					question: "This inbound Request reaches the answer race boundary.",
				},
				{ id: inboundRequestToolCallId },
			),
			{ stopReason: "toolUse" },
		);
	};
	harness.host.model.setResponses(Array.from({ length: 5 }, () => routeModelCall));
	const triggerToolCallId = "trigger-completion-race-request";
	const triggerInput = {
		operation: "send" as const,
		targetAgent: thirdParty.agentId,
		content: "Trigger the inbound Request race.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", triggerInput, { id: triggerToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const triggerReceipt = await harness.view.message(triggerToolCallId, triggerInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: triggerToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(triggerReceipt) }],
		details: triggerReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const prompt = harness.host.session.prompt("OWNER_WAIT_FOR_COMPLETION_RACE");
	await waitForCondition(() => {
		const run = harness.view.status().run;
		return "attention" in run && run.attention === "agent_wait";
	});
	releaseInboundRequest();
	await prompt;

	assert.equal(raceBoundaryChecks, 1);
	assert.ok(selectedAnswerSource);
	const waitResult = harness.host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === waitToolCallId,
	);
	assert.ok(waitResult?.type === "message" && waitResult.message.role === "toolResult");
	assert.equal(waitResult.message.isError, false);
	assert.deepEqual(waitResult.message.details, {
		answers: [{
			requestTitle: "Fixture request",
			disposition: "answer_delivered",
			requestMessageId: selectedRequestId,
			answerId: deriveMessageId(selectedAnswerSource),
			fromAgentId: harness.childId,
			answer: selectedAnswer,
			answerSource: selectedAnswerSource,
		}],
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Agent Wait fallback reconciliation finds an Answer committed without a live notification", async (t) => {
	let reconcile!: () => void;
	const clock: AgentWaitClock = {
		schedule(delayMs, callback) {
			assert.equal(delayMs, 5_000);
			reconcile = callback;
			return () => undefined;
		},
	};
	const harness = await createDormantChildHarness(
		t,
		{},
		undefined,
		undefined,
		clock,
	);
	await cancelHarnessCreationRequest(harness, "cancel-creation-before-fallback-wait");
	const requestToolCallId = "request-before-fallback-reconciliation";
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Leave this Request unanswered until transcript reconciliation.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("Keep the delivered Request active for now."),
	]);
	const requestReceipt = await harness.view.message(requestToolCallId, requestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1
	);
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const waitToolCallId = "wait-for-fallback-reconciliation";
	const waitInput = {};
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("agent_wait", waitInput, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The fallback reconciliation returned the Answer."),
	]);
	const prompt = harness.host.session.prompt("Wait for the selected Request Answer.");
	await waitForCondition(() => {
		const run = harness.view.status().run;
		return typeof reconcile === "function" &&
			("attention" in run ? run.attention === "agent_wait" : false);
	});

	const childSession = SessionManager.open(childSessionFile);
	const answerToolCallId = "answer-without-live-notification";
	const answerText = "The periodic reconciliation found this committed Answer.";
	const answerEntryId = childSession.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: requestId, answer: answerText },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
	);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerEntryId,
		toolCallId: answerToolCallId,
	};
	childSession.appendMessage({
		role: "toolResult",
		toolCallId: answerToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Answer committed without return scheduling." }],
		details: {
			requestTitle: "Fixture request",
			messageId: deriveMessageId(answerSource),
			requestMessageId: requestId,
			messageStatus: "not_sent",
			reason: "target_unavailable",
		},
		isError: false,
		timestamp: Date.now(),
	});
	reconcile();
	await prompt;
	const waitEntry = harness.host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === waitToolCallId,
	);
	assert.ok(waitEntry && waitEntry.type === "message" && waitEntry.message.role === "toolResult");
	assert.equal(waitEntry.message.isError, false, JSON.stringify(waitEntry.message.content));
	assert.deepEqual(waitEntry.message.details, {
		answers: [{
			requestTitle: "Fixture request",
			disposition: "answer_delivered",
			requestMessageId: requestId,
			answerId: deriveMessageId(answerSource),
			fromAgentId: harness.childId,
			answer: answerText,
			answerSource,
		}],
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("requester Cancellation suppresses an undelivered Request without reviving it", async (t) => {
	const harness = await createDormantChildHarness(t, {
		afterDeliveryAdmission: ({ operation }) =>
			operation === "cancel" ? "confirmation_lost" : undefined,
	});
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "This Request will be abandoned before Delivery.",
	};
	const requestToolCallId = "request-before-cancellation";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const requestReceipt = unconfirmedRequestReceipt(harness, requestToolCallId, requestInput);
	assert.deepEqual(requestReceipt, {
		requestMessageId: requestId,
		targetAgentId: harness.childId,
		messageStatus: "unknown",
		reason: "confirmation_lost",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const cancelToolCallId = "cancel-undelivered-request";
	const cancelInput = {
		operation: "cancel" as const,
		requestMessageId: requestId,
		reason: "The result is no longer needed.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellationEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(cancellationEntry);
	const cancellationSource = {
		agentId: harness.host.session.sessionId,
		entryId: cancellationEntry.id,
		toolCallId: cancelToolCallId,
	};
	const cancellationId = deriveMessageId(cancellationSource);
	harness.host.model.setResponses([
		fauxAssistantMessage("I received only the Request Cancellation."),
	]);
	const cancellation = await harness.view.message(cancelToolCallId, cancelInput);
	assert.deepEqual(cancellation, {
		messageId: cancellationId,
		targetAgentId: harness.childId,
		messageStatus: "unknown",
		reason: "confirmation_lost",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) ===
				JSON.stringify({ messages: [cancellationSource] }),
	);
	const cancellationDelivery = entries.find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) ===
				JSON.stringify({ messages: [cancellationSource] }),
	);
	assert.ok(cancellationDelivery && cancellationDelivery.type === "custom_message");
	assert.deepEqual(JSON.parse(cancellationDelivery.content as string), {
		messages: [
			{
				kind: "request_cancellation",
				cancellationId,
				requestMessageId: requestId,
				fromAgentId: harness.host.session.sessionId,
				reason: cancelInput.reason,
			},
		],
	});
	assert.equal(
		entries.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({
						messages: [
							{
								agentId: harness.host.session.sessionId,
								entryId: requestEntry.id,
								toolCallId: requestToolCallId,
							},
						],
					}),
		),
		false,
	);

	const retryToolCallId = "retry-cancelled-request";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(await harness.view.message(retryToolCallId, retryInput), {
		requestMessageId: requestId,
		targetAgentId: harness.childId,
		messageStatus: "not_sent",
		reason: "policy_rejected",
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Cancellation delivered to a busy responder suppresses its queued Request", async (t) => {
	const harness = await createDormantChildHarness(t);
	let markActiveGenerationStarted!: () => void;
	const activeGenerationStarted = new Promise<void>((resolve) => {
		markActiveGenerationStarted = resolve;
	});
	let releaseActiveGeneration!: () => void;
	const activeGenerationGate = new Promise<void>((resolve) => {
		releaseActiveGeneration = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			markActiveGenerationStarted();
			await activeGenerationGate;
			return fauxAssistantMessage("The existing work reached its safe boundary.");
		},
		fauxAssistantMessage("The Cancellation arrived without the queued Request."),
	]);

	const workInput = {
		operation: "send" as const,
		targetAgent: harness.childId,
		content: "Start active work before the Request is admitted.",
	};
	const workCallId = "start-work-before-cancellation";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", workInput, { id: workCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const workReceipt = await harness.view.message(workCallId, workInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: workCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(workReceipt) }],
		details: workReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await activeGenerationStarted;

	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "This queued Request must be suppressed.",
		deliveryMode: "steer" as const,
	};
	const requestCallId = "queue-request-before-cancellation";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestSource = {
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestCallId,
	};
	const requestId = deriveMessageId(requestSource);
	const requestReceipt = await harness.view.message(requestCallId, requestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const cancelInput = {
		operation: "cancel" as const,
		requestMessageId: requestId,
		reason: "Suppress this queued work before Delivery.",
	};
	const cancelCallId = "cancel-queued-request";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellationEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(cancellationEntry);
	const cancellationSource = {
		agentId: harness.host.session.sessionId,
		entryId: cancellationEntry.id,
		toolCallId: cancelCallId,
	};
	const cancellation = await harness.view.message(cancelCallId, cancelInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});
	releaseActiveGeneration();

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) ===
				JSON.stringify({ messages: [cancellationSource] }),
	);
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);
	assert.equal(
		entries.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [requestSource] }),
		),
		false,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Cancellation Delivery wins the responder lane before a later Answer", async (t) => {
	const harness = await createDormantChildHarness(t);
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Wait until Cancellation arrives before attempting an Answer.",
	};
	const requestToolCallId = "request-before-delivered-cancellation";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I will wait with the Answer obligation unresolved."),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1,
	);

	const cancelToolCallId = "deliver-cancellation-before-answer";
	const cancelInput = {
		operation: "cancel" as const,
		requestMessageId: requestId,
		reason: "Stop before authoring the Answer.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellationEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(cancellationEntry);
	const cancellationId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: cancellationEntry.id,
		toolCallId: cancelToolCallId,
	});
	const losingAnswerCallId = "answer-after-delivered-cancellation";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
					answer: "This Answer must not become canonical.",
				},
				{ id: losingAnswerCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The delivered Cancellation won the responder lane."),
	]);
	const cancellation = await harness.view.message(cancelToolCallId, cancelInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === losingAnswerCallId,
	);
	const losingAnswer = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === losingAnswerCallId,
	);
	if (
		!losingAnswer ||
		losingAnswer.type !== "message" ||
		losingAnswer.message.role !== "toolResult"
	) {
		throw new Error("Losing Answer result did not commit");
	}
	assert.equal(losingAnswer.message.isError, true);
	assert.match(
		JSON.stringify(losingAnswer.message.content),
		/was cancelled/,
	);
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Answer commit and Cancellation commit remain canonical across crossed Deliveries", async (t) => {
	const harness = await createDormantChildHarness(t, {
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmed_failure" : undefined,
	});
	const requestInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Commit an Answer before its return Delivery is available.",
	};
	const requestToolCallId = "request-crossed-deliveries";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-before-cancellation-delivery";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
					answer: "The Answer committed before Cancellation Delivery.",
				},
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The initial Answer Delivery was unavailable."),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const answeredEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	const answerSourceEntry = answeredEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageId(answerSource);

	const cancelToolCallId = "cancel-before-answer-delivery";
	const cancelInput = {
		operation: "cancel" as const,
		requestMessageId: requestId,
		reason: "Abandon the wait while the committed Answer is undelivered.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellationEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(cancellationEntry);
	const cancellationSource = {
		agentId: harness.host.session.sessionId,
		entryId: cancellationEntry.id,
		toolCallId: cancelToolCallId,
	};
	const cancellationId = deriveMessageId(cancellationSource);
	const answerRetryCallId = "retry-answer-after-cancellation";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "retry", messageId: answerId },
				{ id: answerRetryCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The late Answer Delivery did not revive the wait."),
		fauxAssistantMessage("Both committed facts remain visible."),
	]);
	const cancellation = await harness.view.message(cancelToolCallId, cancelInput);
	assert.deepEqual(cancellation, {
		messageId: cancellationId,
		targetAgentId: harness.childId,
		messageStatus: "sent",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});

	await waitForCondition(() =>
		harness.host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [answerSource] }),
		),
	);
	const crossedEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) ===
				JSON.stringify({ messages: [cancellationSource] }),
	);
	assert.equal(
		crossedEntries.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [cancellationSource] }),
		),
		true,
	);

	const retryRequestCallId = "retry-locally-cancelled-after-answer-delivery";
	const retryRequestInput = {
		operation: "retry" as const,
		messageId: requestId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryRequestInput, {
				id: retryRequestCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(
		await harness.view.message(retryRequestCallId, retryRequestInput),
		{
			requestMessageId: requestId,
			targetAgentId: harness.childId,
			messageStatus: "not_sent",
			reason: "policy_rejected",
		},
	);

});

test("a created-unscheduled Creation Request uses ordinary retry and Answer behavior", async (t) => {
	const harness = await createDormantChildHarness(t);
	const requestId = harness.creationRequestId;
	const answerToolCallId = "answer-creation-request";
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
					answer: "The Creation Request completed through the ordinary protocol.",
				},
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Creation Request Answer reached its requester."),
		fauxAssistantMessage("The child finished its Answer turn."),
	]);

	const retryToolCallId = "retry-creation-request";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const retry = await harness.view.message(retryToolCallId, retryInput);
	assert.deepEqual(retry, {
		requestMessageId: requestId,
		targetAgentId: harness.childId,
		messageStatus: "sent",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: retryToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(retry) }],
		details: retry,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	await waitForCondition(
		() => retentionCount(harness.view.status().run, "awaiting_answer") === 0,
	);
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a Creation Request occupies the same incoming Request slot", async (t) => {
	const harness = await createDormantChildHarness(t);
	harness.host.model.setResponses([
		fauxAssistantMessage("The Creation Request is active."),
		fauxAssistantMessage("The Creation Request was cancelled."),
		fauxAssistantMessage("The ordinary Request was promoted."),
	]);

	const retryCallId = "activate-creation-request-slot";
	const retryInput = {
		operation: "retry" as const,
		messageId: harness.creationRequestId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const retry = await harness.view.message(retryCallId, retryInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: retryCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(retry) }],
		details: retry,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1,
	);

	const ordinaryCallId = "request-behind-creation-slot";
	const ordinaryInput = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Wait behind the active Creation Request.",
		deliveryMode: "steer" as const,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", ordinaryInput, { id: ordinaryCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const ordinaryEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(ordinaryEntry);
	const ordinarySource = {
		agentId: harness.host.session.sessionId,
		entryId: ordinaryEntry.id,
		toolCallId: ordinaryCallId,
	};
	const ordinary = await harness.view.message(ordinaryCallId, ordinaryInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: ordinaryCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(ordinary) }],
		details: ordinary,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	assert.equal(
		SessionManager.open(childSessionFile).getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) === JSON.stringify({ messages: [ordinarySource] }),
		),
		false,
	);

	const cancelCallId = "release-creation-request-slot";
	const cancelInput = {
		operation: "cancel" as const,
		requestMessageId: harness.creationRequestId,
		reason: "Advance to the ordinary Request.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellation = await harness.view.message(cancelCallId, cancelInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [ordinarySource] }),
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("residual inspection rejects an Answer result naming an unknown Request", async (t) => {
	const harness = await createDormantChildHarness(t);
	const answerCallId = "answer-result-with-unknown-request";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer", requestId: "x".repeat(43),
				answer: "This result cannot name an unknown Request.",
			}, { id: answerCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const answerEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(answerEntry);
	const answerId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: answerEntry.id,
		toolCallId: answerCallId,
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: answerCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Answer scheduling failed." }],
		details: {
			requestTitle: "Fixture request",
			messageId: answerId,
			requestMessageId: "x".repeat(43),
			messageStatus: "not_sent",
			reason: "target_unavailable",
		},
		isError: false,
		timestamp: Date.now(),
	});
	await assert.rejects(
		harness.view.reachSafeBoundary(),
		/unknown_identity: Request x{43}/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Answer Delivery starts a successor Run for a dormant requester", async (t) => {
	const harness = await createDormantChildHarness(t);
	const childRequestCallId = "child-request-before-run-failure";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					title: "Fixture request",
					operation: "request",
					targetAgent: harness.host.session.sessionId,
					question: "Answer after this exact requester Run has failed.",
				},
				{ id: childRequestCallId },
			),
			{ stopReason: "toolUse" },
		),
		...Array.from(
			{ length: 7 },
			() => (context: Context) => requesterFailureOrResponderReceipt(context.messages),
		),
	]);
	const wakeInput = {
		operation: "send" as const,
		targetAgent: harness.childId,
		content: "Start the requester Run.",
	};
	const wakeCallId = "wake-dormant-requester";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", wakeInput, { id: wakeCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const wakeReceipt = await harness.view.message(wakeCallId, wakeInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: wakeCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(wakeReceipt) }],
		details: wakeReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === childRequestCallId,
	);
	const requestSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === childRequestCallId,
			),
	);
	assert.ok(requestSourceEntry);
	const requestId = deriveMessageId({
		agentId: harness.childId,
		entryId: requestSourceEntry.id,
		toolCallId: childRequestCallId,
	});
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);
	await waitForCondition(
		() => retentionCount(harness.view.status().run, "answer_owed") === 1,
	);

	const answerInput = {
		operation: "answer" as const, requestId: requestId,
		answer: "This Answer starts the requester's successor Run.",
	};
	const answerCallId = "answer-dormant-requester";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", answerInput, { id: answerCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const answerEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(answerEntry);
	const answerSource = {
		agentId: harness.host.session.sessionId,
		entryId: answerEntry.id,
		toolCallId: answerCallId,
	};
	harness.host.model.setResponses([
		fauxAssistantMessage("The successor requester Run received its Answer."),
	]);
	const answer = await harness.view.message(answerCallId, answerInput);
	assert.equal(
		"messageStatus" in answer ? answer.messageStatus : undefined,
		"sent",
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: answerCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(answer) }],
		details: answer,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) ===
				JSON.stringify({ messages: [answerSource] }),
	);
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);
	assert.equal(
		retentionCount(harness.view.status().run, "answer_owed"),
		0,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

// Commit uncertain initial admission without scheduling live work; retry/Wait tests
// own when Delivery resumes. Definitive non-admission cannot stand in for this state.
function unconfirmedRequestReceipt(
	harness: DormantChildHarness,
	toolCallId: string,
	input: { targetAgent: string },
) {
	const entry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(entry);
	return {
		requestMessageId: deriveMessageId({ agentId: harness.host.session.sessionId, entryId: entry.id, toolCallId }),
		targetAgentId: input.targetAgent,
		messageStatus: "unknown" as const,
		reason: "confirmation_lost" as const,
	};
}

async function createDormantChildHarness(
	t: TestCleanupRegistrar,
	messageBoundaryHooks: MessageBoundaryHooks = {},
	workflowPolicy?: WorkflowPolicyStore,
	agentWaitBoundaryHooks?: AgentWaitBoundaryHooks,
	agentWaitClock?: AgentWaitClock,
	onModeratorRunStart?: () => void,
) {
	let view!: ReturnType<WorkflowCoordinator["forAgent"]>;
	const host = await createUnboundTestOwnerHost(t, (pi) => {
		registerOwnerAgentTools(pi, () => view);
	}, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		// This suite parks unanswered work to probe Request semantics. Suppress live
		// Moderator Runs so incidental stall handling does not consume scripted replies.
		incidentBoundaryHooks: {
			beforeModeratorRunStart: () => {
				onModeratorRunStart?.();
				return "confirmed_failure";
			},
		},
		spawnBoundaryHooks: {
			beforeDeliveryAdmission: () => "confirmed_failure",
		},
		messageBoundaryHooks,
		workflowPolicy,
		agentWaitBoundaryHooks,
		agentWaitClock,
	});
	view = coordinator.forAgent(identity.agentId);
	const spawnToolCallId = "spawn-request-responder";
	const spawnInput = {
		title: "Fixture request",
		request: "Remain dormant until a correlated Request arrives.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: spawnToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = await view.spawn(spawnToolCallId, spawnInput);
	assert.equal(spawn.spawnStatus, "created");
	assert.equal("messageStatus" in spawn && spawn.messageStatus, "not_sent");
	if (!("agentId" in spawn) || !("requestMessageId" in spawn)) {
		throw new Error("Spawn receipt has no child or Creation Request identity");
	}
	return {
		host,
		coordinator,
		view,
		childId: spawn.agentId,
		creationRequestId: spawn.requestMessageId,
	};
}

type DormantChildHarness = Awaited<ReturnType<typeof createDormantChildHarness>>;

async function cancelHarnessCreationRequest(
	harness: DormantChildHarness,
	toolCallId: string,
): Promise<void> {
	await cancelHarnessRequest(
		harness,
		harness.creationRequestId,
		harness.childId,
		toolCallId,
	);
}

async function cancelHarnessRequest(
	harness: DormantChildHarness,
	requestMessageId: string,
	responderAgentId: string,
	toolCallId: string,
): Promise<void> {
	const settledMessage = `Harness Request cancelled by ${toolCallId}.`;
	harness.host.model.setResponses([fauxAssistantMessage(settledMessage)]);
	const input = {
		operation: "cancel" as const,
		requestMessageId,
		reason: "Exclude this unscheduled harness Request from the wait scenario.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await harness.view.message(toolCallId, input);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
	const responderSessionFile = await waitForChildSessionFile(
		harness.host,
		responderAgentId,
	);
	await waitForEntry(responderSessionFile, (entry) =>
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		JSON.stringify(entry.message.content).includes(settledMessage)
	);
}

type TranscriptEntry = ReturnType<SessionManager["getEntries"]>[number];
type MessageTranscriptEntry = Extract<TranscriptEntry, { type: "message" }>;
type ToolResultTranscriptEntry = MessageTranscriptEntry & {
	message: Extract<MessageTranscriptEntry["message"], { role: "toolResult" }>;
};

async function spawnDormantSibling(
	harness: DormantChildHarness,
	toolCallId: string,
): Promise<string> {
	const input = { title: "Fixture request", request: "Remain dormant as an unrelated Message recipient." };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await harness.view.spawn(toolCallId, input);
	assert.equal(receipt.spawnStatus, "created");
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "not_sent");
	if (!("agentId" in receipt)) throw new Error("Sibling Spawn has no Agent identity");
	return receipt.agentId;
}

async function authorOwnerRequest(
	harness: DormantChildHarness,
	toolCallId: string,
): Promise<{ requestMessageId: string }> {
	const input = {
		title: "Fixture request",
		operation: "request" as const,
		targetAgent: harness.childId,
		question: "Resolve this active Answer Obligation.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await harness.view.message(toolCallId, input);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
	if (!("requestMessageId" in receipt)) {
		throw new Error("Request receipt has no identity");
	}
	return { requestMessageId: receipt.requestMessageId };
}

async function commitHarnessAnswer(
	harness: DormantChildHarness,
	requestToolCallId: string,
	answerToolCallId: string,
	answer: string,
): Promise<string> {
	harness.host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The harness Answer committed."),
	]);
	const request = await authorOwnerRequest(harness, requestToolCallId);
	const responderSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	await waitForEntry(responderSessionFile, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === answerToolCallId &&
		entry.message.isError === false
	);
	return request.requestMessageId;
}

function requireToolResult(
	entries: readonly TranscriptEntry[],
	toolCallId: string,
): ToolResultTranscriptEntry {
	const result = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	if (!result || result.type !== "message" || result.message.role !== "toolResult") {
		throw new Error(`Tool result ${toolCallId} did not commit`);
	}
	return result as ToolResultTranscriptEntry;
}

function deriveMessageId(source: {
	agentId: string;
	entryId: string;
	toolCallId: string;
}): string {
	return deriveMessageIdentity(source);
}

function retentionCount(
	run: AgentRunState,
	reason: "awaiting_answer" | "answer_owed",
): number {
	return run.retentionReasons.find((retention) => retention.reason === reason)?.count ?? 0;
}

async function waitForChildSessionFile(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	childId: string,
): Promise<string> {
	const workflowDirectory = join(
		host.session.sessionManager.getSessionDir(),
		"pi-agent-coordination",
		Buffer.from(host.session.sessionId, "utf8").toString("base64url"),
	);
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const sessions = await SessionManager.list(host.cwd, workflowDirectory);
		const child = sessions.find(({ id }) => id === childId);
		if (child) return child.path;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Child Pi session file was not created");
}

async function waitForEntry(
	sessionFile: string,
	predicate: (entry: ReturnType<SessionManager["getEntries"]>[number]) => boolean,
) {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const entries = SessionManager.open(sessionFile).getEntries();
		if (entries.some(predicate)) return entries;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected child transcript entry did not commit");
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected condition was not reached");
}

async function settleBeforeTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(message)), 2_000);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function requesterFailureOrResponderReceipt(messages: readonly unknown[]) {
	const delivery = findLatestModelDelivery(messages);
	return delivery.some(({ kind }) => kind === "request")
		? fauxAssistantMessage("The responder retained the delivered Request.")
		: fauxAssistantMessage("The requester Run fails after committing its Request.", {
			stopReason: "error",
			errorMessage: "deterministic requester failure",
		});
}

function findLatestModelDelivery(
	messages: readonly unknown[],
): Array<{ kind?: string }> {
	for (const message of [...messages as Array<{
		role?: string;
		content?: unknown;
	}>].reverse()) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = message.content.find(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string",
		);
		if (!text) continue;
		try {
			const parsed = JSON.parse(text.text) as { messages?: unknown };
			if (Array.isArray(parsed.messages)) {
				return parsed.messages as Array<{ kind?: string }>;
			}
		} catch {
			continue;
		}
	}
	return [];
}
