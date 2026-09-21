import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type ImageContent,
} from "@earendil-works/pi-ai";
import {
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
	createAgentBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import { registerHerdrQuestionAttention } from "../src/pi-integration/herdr-question-attention.ts";
import { latestRequestFromContext } from "./support/model-requests.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import {
	inspectCommittedHumanRequestResult,
	resolveCommittedHumanRequest,
} from "../src/protocol/human-request.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestCleanupRegistrar,
	type TestOwnerHostOptions,
} from "./support/pi-host.ts";

const pendingCleanups = new Set<() => Promise<void>>();

/**
 * A presentation hand-off on an idle host lands in milliseconds, but the same work has
 * been measured at 31.2 s on a contended one, so read the selected child's frame against
 * a deadline that follows that scale instead of a poll count.
 */
const SELECTED_FRAME_DEADLINE_MS = 45_000;
const SELECTED_FRAME_POLL_INTERVAL_MS = 20;

afterEach(async () => {
	const cleanups = [...pendingCleanups];
	pendingCleanups.clear();
	await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

test("one native text Answer is the sole result and releases the sequential sibling barrier", async (t) => {
	const { host, coordinator, view, child } = await createHumanRequestChild(t);
	const input = { question: "Which boundary should remain authoritative?" };
	const toolCallId = "ask-native-answer";
	host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("ask_user", input, { id: toolCallId }),
				fauxToolCall("agent_observe", { operation: "status" }, { id: "after-answer" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The committed Human Answer is authoritative."),
	]);

	await sendChildMessage(host, view, child, "Ask the human for one decision.");
	await waitForInputRequired(view, child.agentId);
	const attention = view.humanAttention().find((item) => item.agentId === child.agentId);
	assert.ok(attention);
	assert.equal(attention.question, input.question);
	assert.equal(
		childEntries(child).some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "after-answer",
		),
		false,
	);

	await submitChildInput(view, child, "Keep the native Pi result.");
	await waitForChildEntry(child, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === "after-answer"
	);

	const entries = childEntries(child);
	const answerResult = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(answerResult && answerResult.type === "message");
	assert.equal(answerResult.message.role, "toolResult");
	assert.equal(answerResult.message.isError, false);
	assert.deepEqual(answerResult.message.details, {
		requestId: attention.requestId,
		answer: "Keep the native Pi result.",
	});
	assert.deepEqual(
		entries
			.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					[toolCallId, "after-answer"].includes(entry.message.toolCallId),
			)
			.map((entry) =>
				entry.type === "message" && entry.message.role === "toolResult"
					? entry.message.toolCallId
					: undefined
			),
		[toolCallId, "after-answer"],
	);
	assert.equal(
		entries.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes("Keep the native Pi result."),
		),
		false,
		"Answer adoption must not append an ordinary user Message",
	);
	assert.equal(
		entries.some((entry) => entry.type === "custom" && entry.customType.includes("human")),
		false,
	);
	assert.deepEqual(view.humanAttention(), []);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("registered Human Request schema rejects blank and malformed questions before attention", async (t) => {
	const { host, coordinator, view, child } = await createHumanRequestChild(t);
	const toolCallIds = ["blank-human-question", "malformed-human-question"];
	host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"ask_user",
					{ question: "   \n" },
					{ id: toolCallIds[0] },
				),
				fauxToolCall(
					"ask_user",
					{ prompt: "Missing required question" },
					{ id: toolCallIds[1] },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Both unavailable requests were rejected."),
	]);
	await sendChildMessage(host, view, child, "Attempt invalid Human Requests.");
	await waitForChildEntry(child, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === toolCallIds[1]
	);

	assert.notEqual(observedAttention(view, child.agentId), "input_required");
	assert.deepEqual(view.humanAttention(), []);
	const results = childEntries(child).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			toolCallIds.includes(entry.message.toolCallId),
	);
	assert.equal(results.length, 2);
	assert.equal(results.every(
		(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError,
	), true);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("blank and image-bearing submissions do not resolve as Human Answers", async (t) => {
	const { host, coordinator, view, child } = await createHumanRequestChild(t);
	const toolCallId = "ask-for-validation";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user",
				{ question: "Provide a text-only decision." },
				{ id: toolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The valid Answer was committed."),
	]);
	await sendChildMessage(host, view, child, "Ask for validated input.");
	await waitForInputRequired(view, child.agentId);

	await submitChildInput(view, child, "   ");
	assert.equal(observedAttention(view, child.agentId), "input_required");
	const image: ImageContent = {
		type: "image",
		data: "aW1hZ2U=",
		mimeType: "image/png",
	};
	assert.throws(
		() => coordinator.forAgent(child.agentId).resumeFromHuman("Keep this text", [image]),
		/Human Answers do not support images/,
	);
	assert.equal(observedAttention(view, child.agentId), "input_required");

	await submitChildInput(view, child, "Text-only Answer");
	await waitForChildEntry(child, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === toolCallId &&
		!entry.message.isError
	);

	assert.equal(
		childEntries(child).filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId &&
				!entry.message.isError,
		).length,
		1,
	);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("Alt+Enter delivery and extension commands retain native behavior", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "human-answer-command-"));
	const commandMarker = join(cwd, "answer-mode-command-ran");
	const extensionPath = join(cwd, "answer-mode-command-probe.mjs");
	await writeFile(extensionPath, `
import { writeFile } from "node:fs/promises";
export default function answerModeCommandProbe(pi) {
  pi.registerCommand("answer-mode-probe", {
    description: "Verify native command dispatch during Answer mode",
    async handler() { await writeFile(${JSON.stringify(commandMarker)}, "executed"); },
  });
}
`);
	const { host, coordinator, view, child } = await createHumanRequestChild(t, {
		cwd,
		additionalExtensionPaths: [extensionPath],
	});
	const toolCallId = "ask-before-follow-up";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user",
				{ question: "Answer only after queuing later direction." },
				{ id: toolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Answered turn settled."),
		fauxAssistantMessage("The queued follow-up ran later."),
	]);
	await sendChildMessage(host, view, child, "Open the request.");
	await waitForInputRequired(view, child.agentId);
	const requestId = view.humanAttention().find(
		({ agentId }) => agentId === child.agentId,
	)?.requestId;
	assert.ok(requestId);
	await submitChildInput(view, child, "/answer-mode-probe");
	await waitForCondition(async () => fileExists(commandMarker));
	assert.equal(observedAttention(view, child.agentId), "input_required");

	await submitChildInput(
		view,
		child,
		"Queue this after the Answered turn.",
		"\x1b\r",
	);
	assert.equal(observedAttention(view, child.agentId), "input_required");
	assert.equal(
		childEntries(child).some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId,
		),
		false,
	);

	await submitChildInput(view, child, "Answer now");
	await waitForChildEntry(child, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === toolCallId
	);
	const answer = childEntries(child).find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(answer && answer.type === "message" && answer.message.role === "toolResult");
	assert.deepEqual(answer.message.details, {
		requestId,
		answer: "Answer now",
	});

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("an unrecognized slash-prefixed string is ordinary Answer text", async (t) => {
	const { host, coordinator, view, child } = await createHumanRequestChild(t);
	const toolCallId = "ask-for-slash-answer";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user", { question: "Give the slash Answer." }, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Slash Answer received."),
	]);
	await sendChildMessage(host, view, child, "Ask for slash text.");
	await waitForInputRequired(view, child.agentId);
	await submitChildInput(view, child, "/not-a-command keep this literal");
	await waitForChildEntry(child, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === toolCallId
	);
	const result = childEntries(child).find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	assert.equal((result.message.details as { answer: string }).answer, "/not-a-command keep this literal");

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("primary Enter answers literally while Alt+Enter expands a prompt template", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "human-answer-prompt-"));
	const agentDir = join(cwd, ".pi");
	await mkdir(join(agentDir, "prompts"), { recursive: true });
	await writeFile(
		join(agentDir, "prompts", "answer-template.md"),
		"---\ndescription: Queue a later prompt\n---\nExpanded follow-up: $@\n",
	);
	const { host, coordinator, view, child } = await createHumanRequestChild(t, {
		cwd,
		agentDir,
		noPromptTemplates: false,
	});
	const toolCallId = "ask-for-literal-template-answer";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user",
				{ question: "Submit a literal prompt-template command." },
				{ id: toolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The literal Answer committed."),
		fauxAssistantMessage("The expanded follow-up ran later."),
	]);
	await sendChildMessage(host, view, child, "Ask for the literal command.");
	try {
		await waitForInputRequired(view, child.agentId);
		const requestId = view.humanAttention().find(
			({ agentId }) => agentId === child.agentId,
		)?.requestId;
		assert.ok(requestId);
		await submitChildInput(view, child, "/answer-template later work", "\x1b\r");
		assert.equal(observedAttention(view, child.agentId), "input_required");

		await submitChildInput(view, child, "/answer-template");
		await waitForCondition(() => observedAttention(view, child.agentId) !== "input_required");
		await waitForChildEntry(child, (entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			(typeof entry.message.content === "string"
				? entry.message.content
				: textContent(entry.message.content)
			).includes("Expanded follow-up: later work")
		);
		const result = childEntries(child).find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId,
		);
		assert.ok(result && result.type === "message" && result.message.role === "toolResult");
		assert.deepEqual(result.message.details, {
			requestId,
			answer: "/answer-template",
		});
		assert.equal(
			childEntries(child).some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					(typeof entry.message.content === "string"
						? entry.message.content
						: textContent(entry.message.content)
					).includes("Expanded follow-up: later work"),
			),
			true,
		);
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});

test("different Agents wait and commit Human Answers independently", async (t) => {
	const { host, coordinator, view, child: first, spawnChild } =
		await createHumanRequestChild(t);
	const second = await spawnChild();
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user",
				{ question: "Answer the first Agent independently." },
				{ id: "first-independent-human-request" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user",
				{ question: "Answer the second Agent independently." },
				{ id: "second-independent-human-request" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Second Agent received its Human Answer."),
		fauxAssistantMessage("First Agent received its Human Answer."),
	]);

	await sendChildMessage(host, view, first, "Open the first Human Request.");
	await waitForInputRequired(view, first.agentId);
	await sendChildMessage(host, view, second, "Open the second Human Request.");
	await waitForInputRequired(view, second.agentId);
	assert.deepEqual(
		view.humanAttention().map(({ agentId }) => agentId).sort(),
		[first.agentId, second.agentId].sort(),
	);
	const agentsCommand = host.session.prompt("/agents");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	const selector = host.ui.customSurfaces[0]!;
	assert.match(selector.render(100).join("\n"), /DECIDE 1.*DECIDE 2/s);
	selector.handleInput?.("\x1b");
	await agentsCommand;
	await selectChildView(view, second);
	// The hand-off in docs/child-ui-context.md resolves once the child's complete current
	// frame is parsed, but a bounded hand-off releases the viewer first, so read the frame
	// a human would see against a deadline instead of racing the parse.
	const selectedFrame = await waitForSelectedChildFrame(
		second,
		/\[Ask User\]/,
		"the selected second Agent's Human Request presentation",
	);
	assert.match(selectedFrame, /\[Ask User\]/);
	assert.match(selectedFrame, /Answer the second Agent independently\./);

	await submitChildInput(view, second, "Second Answer");
	await waitForChildEntry(second, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === "second-independent-human-request"
	);
	assert.equal(observedAttention(view, first.agentId), "input_required");
	assert.equal(
		view.humanAttention().some(({ agentId }) => agentId === first.agentId),
		true,
	);
	await submitChildInput(view, first, "First Answer");
	await waitForChildEntry(first, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === "first-independent-human-request"
	);
	await waitForCondition(() => view.humanAttention().length === 0);
	assert.deepEqual(view.humanAttention(), []);
	await view.openAgentView(view.status().agentId);
});

test("a precommit Run fence rejects and restores the provisional Answer", async (t) => {
	let ownerView: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	let selectedChild: HumanRequestChild | undefined;
	const host = await createUnboundTestOwnerHost(t,
		createAgentBoundExtension(() => {
			if (!ownerView) throw new Error("Owner view unavailable");
			return ownerView;
		}),
		{ persistent: true, processVisibleModel: true },
	);
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator!: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		humanRequestBoundaryHooks: {
			beforeResultCommit: ({ failExactRun }) => {
				selectedChild?.projection?.projection().dispatchInput("newer draft");
				failExactRun();
			},
		},
		incidentBoundaryHooks: { beforeModeratorRunStart: () => "confirmed_failure" },
	});
	pendingCleanups.add(() => coordinator.shutdown(async () => host.runtime.dispose()));
	ownerView = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	const child = await spawnLiveChild(host, ownerView);
	selectedChild = child;
	const toolCallId = "answer-before-fence";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user", { question: "Submit into the fence." }, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("This continuation must not run."),
	]);
	await sendChildMessage(host, ownerView, child, "Open the fenced request.");
	await waitForInputRequired(ownerView, child.agentId);
	await submitChildInput(ownerView, child, "Restore this candidate");
	await waitForCondition(() => {
		const frame = stripTerminalSequences(
			child.projection?.projection().presentation.render(160).join("\n") ?? "",
		);
		return /Restore this candidate[\s\S]*newer draft/.test(frame);
	});
	await waitForCondition(() => ownerView.status(child.agentId).run.phase === "dormant");

	assert.equal(ownerView.status(child.agentId).run.phase, "dormant");
	const result = childEntries(child).find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	assert.equal(result.message.isError, true);
	assert.match(textContent(result.message.content), /Agent Run is no longer available/);
	assert.deepEqual(ownerView.humanAttention(), []);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("a committed Answer remains canonical after later Run failure and reopened inspection", async (t) => {
	const { host, coordinator, view, child } = await createHumanRequestChild(t, { persistent: true });
	const input = { question: "Commit this Answer before later failure." };
	const toolCallId = "answer-before-later-failure";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Fail only after commitment.", {
			stopReason: "error",
			errorMessage: "deterministic later failure",
		}),
	]);
	await sendChildMessage(host, view, child, "Ask before failing.");
	await waitForInputRequired(view, child.agentId);
	await submitChildInput(view, child, "Canonical Answer");
	await waitForChildEntry(child, (entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === toolCallId
	);

	const reopened = SessionManager.open(child.sessionFile);
	const request = resolveCommittedHumanRequest({
		agentId: child.agentId,
		transcript: transcriptFromSessionManager(reopened).inspect(),
		toolCallId,
		providedInput: input,
	});
	const resultEntry = reopened.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(resultEntry);
	assert.deepEqual(
		inspectCommittedHumanRequestResult({
			request,
			transcript: transcriptFromSessionManager(reopened).inspect(),
		}),
		{
			state: "answered",
			answer: { requestId: request.requestId, answer: "Canonical Answer" },
			resultEntryId: resultEntry.id,
		},
	);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("Human Request fails before input_required when no interactive Agent editor exists", async (t) => {
	let view: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	const host = await createUnboundTestOwnerHost(t,
		(pi) => createAgentBoundExtension(() => {
			if (!view) throw new Error("View unavailable");
			return view;
		})(pi),
	);
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator!: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		incidentBoundaryHooks: { beforeModeratorRunStart: () => "confirmed_failure" },
	});
	pendingCleanups.add(() => coordinator.shutdown(async () => host.runtime.dispose()));
	view = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	const toolCallId = "ask-without-projection";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user", { question: "This cannot be presented." }, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The unavailable request failed."),
	]);
	await host.session.prompt("Attempt an unavailable request.");
	await host.session.waitForIdle();
	assert.notEqual(observedAttention(view, identity.agentId), "input_required");
	assert.deepEqual(view.humanAttention(), []);
	const result = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	assert.equal(result.message.isError, true);
	assert.match(textContent(result.message.content), /interactive Agent editor/);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

for (const completion of ["answer", "interrupt", "shutdown"] as const) {
	test(`Herdr coalesces real questions across reload and ${completion}`, { timeout: 10_000 }, async (t) => {
		let view: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
		const attentionEvents: unknown[] = [];
		const host = await createUnboundTestOwnerHost(t, (pi) => {
			createAgentBoundExtension(() => view!)(pi);
			registerHerdrQuestionAttention(pi, () => view);
		}, {
			persistent: true, processVisibleModel: true,
			additionalExtensionFactories: [(pi) => {
				pi.events.on("herdr:blocked", (data) => attentionEvents.push(data));
			}],
		});
		const identity = adoptOrValidateOwnerIdentity(host.runtime);
		const coordinator = await createTestWorkflowCoordinator(host, identity, {
			entryModulePath: "<inline:pi-durable-subagents>",
			incidentBoundaryHooks: { beforeModeratorRunStart: () => "confirmed_failure" },
		});
		view = coordinator.forAgent(identity.agentId);
		await bindTestOwnerHost(host, "tui");
		host.model.setResponses(Array.from({ length: 8 }, () => (context) => {
			const answered = context.messages.some((message) => message.role === "toolResult" && message.toolName === "ask_user");
			return answered
				? fauxAssistantMessage(fauxToolCall("agent_message", {
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "Human answered.",
				}, { id: "answer-creation" }), { stopReason: "toolUse" })
				: fauxAssistantMessage(fauxToolCall("ask_user", { question: "Choose an option." },
					{ id: "ask-option" }), { stopReason: "toolUse" });
		}));
		const children: string[] = [];
		for (let index = 0; index < 2; index++) {
			const input = { title: "Fixture request", request: "Ask the human for a decision." };
			const toolCallId = `spawn-question-${index}`;
			host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", input, { id: toolCallId }), { stopReason: "toolUse" }));
			const receipt = await view.spawn(toolCallId, input);
			assert.ok("agentId" in receipt && receipt.agentId);
			children.push(receipt.agentId);
			await waitForInputRequired(view, receipt.agentId);
		}
		assert.equal(view.hasPendingHumanQuestions(), true);
		assert.deepEqual(attentionEvents, [{ active: true, label: "An agent needs your input" }]);

		await host.session.reload();
		assert.deepEqual(attentionEvents, [
			{ active: true, label: "An agent needs your input" },
			{ active: false },
			{ active: true, label: "An agent needs your input" },
		]);
		await coordinator.forAgent(children[0]!).resumeFromHuman("Use option A.", undefined);
		await waitForCondition(() => view!.humanAttention().length === 1);
		assert.equal(view.hasPendingHumanQuestions(), true);
		assert.equal(attentionEvents.length, 3, "answering one question must not clear the other");
		if (completion === "answer") {
			await coordinator.forAgent(children[1]!).resumeFromHuman("Use option B.", undefined);
		} else if (completion === "shutdown") {
			await coordinator.shutdown(async () => host.runtime.dispose());
		} else {
			const cancelInput = { operation: "interrupt" as const, agentId: children[1]! };
			host.session.sessionManager.appendMessage(fauxAssistantMessage(
				fauxToolCall("agent_control", cancelInput, { id: "cancel-question" }), { stopReason: "toolUse" },
			));
			await view.control("cancel-question", cancelInput);
		}
		await waitForCondition(() => !view!.hasPendingHumanQuestions());
		assert.deepEqual(attentionEvents.at(-1), { active: false });
		assert.equal(attentionEvents.length, 4);
		await coordinator.shutdown(async () => host.runtime.dispose());
		assert.equal(attentionEvents.length, 4, "shutdown must not release someone else's blocker");
	});
}

async function createHumanRequestChild(
	t: TestCleanupRegistrar,
	options?: Pick<
	TestOwnerHostOptions,
	| "additionalExtensionFactories"
	| "additionalExtensionPaths"
	| "persistent"
	| "cwd"
	| "agentDir"
	| "noPromptTemplates"
>) {
	let ownerView: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	const host = await createUnboundTestOwnerHost(t,
		createAgentBoundExtension(() => {
			if (!ownerView) throw new Error("Human Request owner view is unavailable");
			return ownerView;
		}),
		{ persistent: true, processVisibleModel: true, ...options },
	);
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator!: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		incidentBoundaryHooks: { beforeModeratorRunStart: () => "confirmed_failure" },
	});
	pendingCleanups.add(() => coordinator.shutdown(async () => host.runtime.dispose()));
	const view = coordinator.forAgent(identity.agentId);
	ownerView = view;
	await bindTestOwnerHost(host, "tui");
	const child = await spawnLiveChild(host, view);
	return {
		host,
		coordinator,
		view,
		child,
		spawnChild: () => spawnLiveChild(host, view),
	};
}

async function spawnLiveChild(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
): Promise<{
	agentId: string;
	sessionFile: string;
	projection?: Awaited<ReturnType<typeof view.openAgentView>>;
}> {
	host.model.setResponses([
		fauxAssistantMessage("The Creation Request remains available for an Agent Answer."),
	]);
	const input = { title: "Fixture request", request: "Open Human Requests when later instructed." };
	const toolCallId = `spawn-human-request-child-${view.children().length}`;
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.spawn(toolCallId, input);
	const agentId = "agentId" in receipt ? receipt.agentId : undefined;
	assert.ok(agentId);
	const sessionFile = await waitForChildSessionFile(host, agentId);
	const child = { agentId, sessionFile };
	await waitForChildEntry(child, (entry) =>
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		JSON.stringify(entry.message.content).includes(
			"The Creation Request remains available for an Agent Answer.",
		)
	);
	await waitForChildEntry(child, (entry) =>
		entry.type === "custom_message" &&
		entry.customType === "agent-coordination.obligation-reminder"
	);
	await waitForCondition(() => {
		const run = view.status(agentId).run;
		return run.phase === "live" && run.work === "settled" &&
			!run.retentionReasons.some(({ reason }) => reason === "pending_delivery");
	});
	return child;
}

type HumanRequestChild = Awaited<ReturnType<typeof spawnLiveChild>>;
const activeChildViews = new WeakMap<object, NonNullable<HumanRequestChild["projection"]>>();
let childMessageSequence = 0;

async function sendChildMessage(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	child: HumanRequestChild,
	content: string,
): Promise<void> {
	const toolCallId = `human-request-direction-${childMessageSequence++}`;
	const input = {
		operation: "send" as const,
		targetAgent: child.agentId,
		content,
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.message(toolCallId, input);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
}

async function submitChildInput(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	child: HumanRequestChild,
	text: string,
	submitKey = "\r",
): Promise<void> {
	await selectChildView(view, child);
	child.projection?.projection().dispatchInput(`${text}${submitKey}`);
}

async function selectChildView(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	child: HumanRequestChild,
): Promise<void> {
	if (!child.projection || child.projection.agentId !== child.agentId) {
		const opened = await view.openAgentView(child.agentId);
		child.projection = opened ?? activeChildViews.get(view);
		assert.ok(child.projection);
		activeChildViews.set(view, child.projection);
	}
	// A human sees a selected child through its attached presentation. The Owner only
	// feeds the parsed cell grid while a viewer watches that child's screen
	// (docs/child-ui-context.md), so this harness attaches exactly like the surface.
	await child.projection.projection().screenView.begin();
}

function childEntries(child: HumanRequestChild) {
	return SessionManager.open(child.sessionFile).getEntries();
}

async function waitForChildEntry(
	child: HumanRequestChild,
	predicate: (entry: ReturnType<SessionManager["getEntries"]>[number]) => boolean,
): Promise<ReturnType<SessionManager["getEntries"]>> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const entries = childEntries(child);
		if (entries.some(predicate)) return entries;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected child transcript entry did not commit");
}

async function waitForChildSessionFile(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	agentId: string,
): Promise<string> {
	const sessionDirectory = host.session.sessionManager.getSessionDir();
	if (!sessionDirectory) throw new Error("Persistent Owner session directory unavailable");
	const workflowDirectory = join(
		sessionDirectory,
		"pi-durable-subagents",
		host.session.sessionId,
	);
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const sessions = await SessionManager.list(host.cwd, workflowDirectory);
		const child = sessions.find(({ id }) => id === agentId);
		if (child) return child.path;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Child Pi session file was not created");
}

async function waitForInputRequired(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	agentId: string,
): Promise<void> {
	await waitForCondition(() => observedAttention(view, agentId) === "input_required");
}

function observedAttention(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	agentId: string,
): "none" | "input_required" | "agent_wait" | "dormant" {
	const run = view.status(agentId).run;
	return "attention" in run ? run.attention : "dormant";
}

async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected Human Request condition was not reached");
}

/**
 * The frame a human sees for a selected child, once its presentation carries the expected
 * content. A bounded hand-off releases the viewer before Pi's complete repaint is parsed,
 * so the frame that follows the attachment is read by deadline, not by a single read.
 */
async function waitForSelectedChildFrame(
	child: HumanRequestChild,
	expected: RegExp,
	description: string,
): Promise<string> {
	const deadline = Date.now() + SELECTED_FRAME_DEADLINE_MS;
	let rendered = "";
	while (true) {
		rendered = stripTerminalSequences(
			child.projection?.projection().presentation.render(100).join("\n") ?? "",
		);
		if (expected.test(rendered)) return rendered;
		if (Date.now() >= deadline) {
			throw new Error(
				`${description} never rendered ${expected} within ${SELECTED_FRAME_DEADLINE_MS} ms. `
				+ `The selected child frame rendered:\n${rendered}`,
			);
		}
		await new Promise<void>((resolve) =>
			setTimeout(resolve, SELECTED_FRAME_POLL_INTERVAL_MS)
		);
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function textContent(content: readonly unknown[]): string {
	return content.flatMap((part) =>
		typeof part === "object" && part !== null &&
		"type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
			? [part.text]
			: []
	).join("\n");
}
