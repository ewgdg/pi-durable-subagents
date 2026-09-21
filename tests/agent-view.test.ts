import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type AssistantMessage,
	type Context,
	type TranscriptContext,
	type JsonObject,
} from "@earendil-works/pi-ai";
import {
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	stripTerminalSequences,
	type Component,
} from "@earendil-works/pi-tui";

import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import piAgentCoordination from "../src/index.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	executeAndCommitRegisteredTool,
	openAgentsSurface,
} from "./support/agent-session.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

// Every wait here is gated on asynchronous coordinator work, and most of them also cross
// a real child Pi process: its boot, its shutdown, a lane handoff, or a transcript it
// writes. Idle those settle in milliseconds to ~0.5 s, but one child boot has been
// measured at 31 s on a contended host, so a 5 s budget failed intact behaviour instead
// of a stuck host. Bound the wait generously and report the state that never arrived.
// One stalled wait still lands inside the file's PROCESS_TEST_TIMEOUT_MS budget, so the
// diagnostic survives instead of the runner killing the whole file.
const SURFACE_WAIT_TIMEOUT_MS = 60_000;
const MAX_SELECTOR_NAVIGATION_STEPS = 1_000;
const PROCESS_AGENT_VIEW_PROBE = fileURLToPath(
	new URL("./fixtures/process-agent-view-probe-extension.ts", import.meta.url),
);

test("selector navigation stops at a non-wrapping boundary when the Agent is absent", () => {
	let row = 0;
	let renders = 0;
	const surface: Component = {
		render() {
			assert.ok(++renders < 50, "navigation must stop instead of spinning at the boundary");
			return [`→ row ${row}`, "|owner|"];
		},
		handleInput(input) {
			if (input === "j") row = Math.min(row + 1, 1);
		},
		invalidate() {},
	};
	assert.equal(selectAgentInCurrentTree(surface, "missing", "owner"), false);
});

test("selector navigation recognizes an Agent in ANSI-styled focused details", () => {
	let selected = false;
	const surface: Component = {
		render: () => ["→ Worker", "|\x1b[36mworker\x1b[39m|"],
		handleInput(input) { selected = input === "\r"; },
		invalidate() {},
	};
	assert.equal(selectAgentInCurrentTree(surface, "worker", "owner"), true);
	assert.equal(selected, true);
});

test("/agents presents the live Agent's native interactive mode while Owner stays bound", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "interactive");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("The child is ready for direct interactive input."),
		fauxAssistantMessage("The child received input through its own editor."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-live-agent-view",
		{
			title: "Fixture request",
			request: "Remain available for direct input from the Agent view.",
			label: "Viewed Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "session_start" && entry.sessionId === agentId && entry.pid !== process.pid,
	));
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The child is ready for direct interactive input.",
		)
	);

	const ownerRuntimeSession = host.runtime.session;
	const ownerServices = host.runtime.services;
	const ownerDiagnostics = host.runtime.diagnostics;
	const ownerTranscript = host.session.sessionManager.getEntries().map(({ id }) => id);
	const ownerEditorFactory = () => undefined as never;
	host.ui.setEditorComponent(ownerEditorFactory);
	host.ui.setEditorText("unfinished Owner input");
	host.ui.statuses.set("owner-peer-status", "Owner Peer");
	let nativeRebinds = 0;
	host.runtime.setRebindSession(async () => {
		nativeRebinds += 1;
	});

	const { command, view } = await openSelectedAgentView(host, agentId);
	await waitForCondition(() => {
		const frame = stripTerminalSequences(view.render(80).join("\n"));
		return frame.replace(/\s+/g, "").includes(
			"Thechildisreadyfordirectinteractiveinput",
		) && frame.includes(`Agent footer · ${agentId}`);
	});
	const rendered = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(rendered, /Viewed Worker/);
	assert.match(rendered, new RegExp(agentId.slice(-8)));
	assert.match(rendered, new RegExp(`Agent editor · ${agentId}`));
	assert.match(rendered, new RegExp(`Agent footer · ${agentId}`));
	assert.match(rendered, new RegExp(`Agent widget · ${agentId}`));
	assert.match(
		rendered.replace(/\s+/g, ""),
		/Thechildisreadyfordirectinteractiveinput/,
	);
	assert.equal(host.runtime.session, ownerRuntimeSession);
	assert.equal(host.runtime.services, ownerServices);
	assert.equal(host.runtime.diagnostics, ownerDiagnostics);
	assert.deepEqual(
		host.session.sessionManager.getEntries().map(({ id }) => id),
		ownerTranscript,
	);
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);
	assert.equal(host.ui.getEditorText(), "unfinished Owner input");
	assert.equal(host.ui.statuses.get("owner-peer-status"), "Owner Peer");
	assert.equal(nativeRebinds, 0);
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), true);

	view.handleInput?.("/agent-view-probe");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Child-local extension overlay",
		)
	);
	view.handleInput?.("\x1b");
	await waitForCondition(() =>
		!stripTerminalSequences(view.render(80).join("\n")).includes(
			"Child-local extension overlay",
		)
	);
	view.handleInput?.("\x1b");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Custom editor Escape count · 1",
		)
	);
	assert.equal(host.ui.customSurfaces.includes(view), true);

	for (const character of "Human direction entered in the Agent editor.") {
		view.handleInput?.(character);
	}
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Human direction entered in the Agent editor.",
		)
	);
	view.handleInput?.("\r");
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Human direction entered in the Agent editor.",
		)
	);
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The child received input through its own editor.",
		)
	);
	assert.equal(host.ui.getEditorText(), "unfinished Owner input");
	assert.equal(host.runtime.session, ownerRuntimeSession);
	assert.equal(host.runtime.services, ownerServices);
	assert.equal(host.runtime.diagnostics, ownerDiagnostics);
	assert.deepEqual(
		host.session.sessionManager.getEntries().map(({ id }) => id),
		ownerTranscript,
	);
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);
	assert.equal(host.ui.getEditorText(), "unfinished Owner input");
	assert.equal(host.ui.statuses.get("owner-peer-status"), "Owner Peer");
	assert.equal(nativeRebinds, 0);

	view.handleInput?.("/agents");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("o");
	await waitForCondition(() => !host.ui.customSurfaces.includes(view));
	await command;
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), false);
	assert.equal(await hasRetention(host, agentId, "answer_owed"), true);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.equal(host.runtime.session, ownerRuntimeSession);
	assert.deepEqual(
		host.session.sessionManager.getEntries().map(({ id }) => id),
		ownerTranscript,
	);
	assert.equal(host.ui.getEditorText(), "unfinished Owner input");
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);
	assert.equal(nativeRebinds, 0);

});

test("a real child input or render failure closes the view and reports one Owner diagnostic", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	const ownerSession = host.runtime.session;
	let reportedOwnerDiagnostics = 0;
	const runChildFailureArm = async (arm: {
		scenario: string;
		creationToolCallId: string;
		spawnToolCallId: string;
		request: string;
		label: string;
		readyText: string;
		failureKind: "input" | "render";
		ownerEditor: string;
	}) => {
		const probe = configureProcessAgentViewProbe(t, arm.scenario);
		host.model.setResponses(creationAnswerResponses(arm.creationToolCallId, arm.readyText));
		const spawn = await executeAndCommitRegisteredTool(
			host.session,
			"agent_spawn",
			arm.spawnToolCallId,
			{
				title: "Fixture request",
				request: arm.request,
				label: arm.label,
			},
		);
		const agentId = (spawn.details as { agentId: string }).agentId;
		await waitForCondition(async () =>
			JSON.stringify(await childEntries(host, agentId)).includes(arm.readyText)
		);
		await waitForCondition(async () => await currentRunPhase(host, agentId) === "dormant");
		host.ui.setEditorText(arm.ownerEditor);
		const { command, view } = await openDormantAgentView(host, agentId);
		await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) =>
			childProcessSessionStarts(entries, agentId).length === 2
		);

		assert.doesNotThrow(() => view.handleInput?.("x"));
		await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.filter(
			(entry) => entry.kind === "failure_trigger" && entry.failureKind === arm.failureKind && entry.pid !== process.pid,
		).length === 1);
		await command;
		await waitForCondition(() => host.ui.customSurfaces.length === 0 && host.services.diagnostics.some(
			({ message }) => message.includes("Agent view failed:"),
		));
		assert.equal(host.ui.customSurfaces.length, 0);
		assert.equal(host.runtime.session, ownerSession);
		assert.equal(host.ui.getEditorText(), arm.ownerEditor);
		// Each failing child channel reports exactly one new Owner diagnostic.
		const reported = host.services.diagnostics.filter(({ message }) =>
			/Agent view failed: child_runtime_(?:unexpected_exit|channel_closed):/.test(message)
		).length;
		assert.equal(reported, reportedOwnerDiagnostics + 1);
		reportedOwnerDiagnostics = reported;
	};

	await runChildFailureArm({
		scenario: "failure-input",
		creationToolCallId: "answer-throwing-editor-creation-request",
		spawnToolCallId: "spawn-throwing-agent-editor",
		request: "Remain available so the Owner can trigger the editor failure.",
		label: "Throwing Editor Worker",
		readyText: "The throwing-editor Agent is ready.",
		failureKind: "input",
		ownerEditor: "Owner editor survives child input failure",
	});
	await host.session.prompt("Owner remains usable after child editor failure.");
	await host.session.waitForIdle();
	await runChildFailureArm({
		scenario: "failure-render",
		creationToolCallId: "answer-throwing-render-creation-request",
		spawnToolCallId: "spawn-throwing-agent-render",
		request: "Remain available so the Owner can trigger the render failure.",
		label: "Throwing Render Worker",
		readyText: "The throwing-render Agent is ready.",
		failureKind: "render",
		ownerEditor: "Owner editor survives child render failure",
	});
});

test("a session_start modal is interactive before Agent Run startup settles", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "startup-modal");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("The startup-modal Agent continued."),
	]);
	const ownerKeybindings = getKeybindings();
	initTheme("dark");
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[
		Symbol.for("@earendil-works/pi-coding-agent:theme")
	];
	const spawning = executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-startup-modal-agent-view",
		{
			title: "Fixture request",
			request: "Wait for the startup modal, then report readiness.",
			label: "Startup Modal Worker",
		},
	);

	let command!: Promise<void>;
	let selector!: Component;
	const selectorDeadline = Date.now() + SURFACE_WAIT_TIMEOUT_MS;
	while (Date.now() < selectorDeadline) {
		({ command, surface: selector } = await openAgentsSurface(host));
		if (
			stripTerminalSequences(selector.render(80).join("\n")).includes(
				"Startup Modal Worker",
			)
		) break;
		selector.handleInput?.("\x1b");
		await command;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	const agentId = selectAgentByLabel(selector, "Startup Modal Worker");
	assert.ok(agentId);
	await waitForCondition(() =>
		host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== selector
	);
	const view = host.ui.customSurfaces[0]!;
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Agent startup gate",
		)
	);
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "session_start" && entry.sessionId === agentId && entry.pid !== process.pid,
	));
	assert.equal(getKeybindings(), ownerKeybindings);
	assert.equal(
		(globalThis as Record<PropertyKey, unknown>)[
			Symbol.for("@earendil-works/pi-coding-agent:theme")
		],
		ownerTheme,
	);
	view.handleInput?.("\r");
	const spawn = await spawning;
	assert.equal((spawn.details as { agentId: string }).agentId, agentId);
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The startup-modal Agent continued.",
		)
	);
	await returnAgentViewToOwner(host, view, command);
});

test("a selected Agent whose runtime initialization fails opens a read-only post-mortem view", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
	});
	const spawnInput = {
		title: "Fixture request",
		request: "Remain visible after this process Runtime cannot initialize.",
		label: "Startup Failure Worker",
		config: {
			model: {
				id: "coordination-test/deterministic-owner",
				thinking: "inherit" as const,
			},
		},
	};
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-selected-startup-failure",
		spawnInput,
	);
	assert.equal((spawn.details as { spawnStatus: string }).spawnStatus, "created");
	const agentId = (spawn.details as { agentId: string }).agentId;
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-selected-startup-failure",
		{ operation: "terminate", agentId },
	);
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	host.services.modelRuntime.unregisterProvider("coordination-test");

	const { command, surface: selector } = await openAgentsSurface(host);
	selector.handleInput?.("\t");
	assert.equal(selectAgentByLabel(selector, "Startup Failure Worker"), agentId);
	await waitForCondition(() =>
		host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== selector
	);
	const postMortem = host.ui.customSurfaces[0]!;
	const rendered = stripTerminalSequences(postMortem.render(80).join("\n"));
	assert.match(rendered, /Post-mortem · read-only/);
	assert.match(rendered, /Runtime unavailable:/);
	postMortem.handleInput?.("q");
	await command;
	assert.equal(host.ui.customSurfaces.length, 0);
	assert.equal(await currentRunPhase(host, agentId), "dormant");
});

test("an unexpected child-process exit closes the exact selected view", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "unexpected-exit");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("The initial passive-failure Run settles."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-passive-failure-worker",
		{
			title: "Fixture request",
			request: "Become Dormant before passive Runtime preparation fails.",
			label: "Passive Failure Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The initial passive-failure Run settles.",
		)
	);
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-passive-failure-worker",
		{ operation: "terminate", agentId },
	);

	const { command, view } = await openDormantAgentView(host, agentId);
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) =>
		childProcessSessionStarts(entries, agentId).length === 2
	);
	view.handleInput?.("/exit-agent-process");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("/exit-agent-process")
	);
	view.handleInput?.("\r");

	await command;
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "process_exit" && entry.sessionId === agentId &&
			entry.pid !== process.pid && entry.exitCode === 17,
	));
	// The view unmounts asynchronously once the runtime release settles, and under load
	// the exit evidence above can land first. Wait for the same end state instead of
	// sampling it at one instant.
	await waitForCondition(() => host.ui.customSurfaces.length === 0, {
		description: "The selected Agent view to unmount after its child process exits",
		observed: () => `surfaces=${host.ui.customSurfaces.length}`,
	});
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	assert.match(
		JSON.stringify(host.services.diagnostics),
		/child_runtime_(?:unexpected_exit|channel_closed)/,
	);
});

test("a submitted Dormant Agent turn survives returning to the Owner during prompt preflight", async (t) => {
	const submittedInput = "Continue after the Owner leaves this Agent view.";
	const probe = configureProcessAgentViewProbe(t, "prompt-preflight");
	let coordinator!: WorkflowCoordinator;
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	await bindTestOwnerHost(host, "tui");
	const owner = coordinator.forAgent(identity.agentId);
	host.deferCleanup(async () => {
		await releaseProcessAgentViewProbe(probe.releasePath);
	});
	const spawnInput = {
		title: "Fixture request",
		request: "Settle before the Owner submits a successor turn.",
		label: "Preflight Retention Worker",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, {
				id: "spawn-preflight-retention-worker",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const spawnSourceEntry = host.session.sessionManager.getLeafEntry();
	assert.ok(spawnSourceEntry);
	const creationRequestId = deriveMessageIdentity({
		agentId: identity.agentId,
		entryId: spawnSourceEntry.id,
		toolCallId: "spawn-preflight-retention-worker",
	});
	const routePreflightResponse = (context: Context): AssistantMessage => {
		const transcript = JSON.stringify(context.messages);
		if (transcript.includes(submittedInput)) {
			return fauxAssistantMessage("The submitted turn completed after returning to the Owner.");
		}
		if (transcript.includes('"toolCallId":"answer-preflight-retention-creation-request"')) {
			return fauxAssistantMessage("The initial Agent turn settled.");
		}
		if (
			transcript.includes("Settle before the Owner submits a successor turn.") &&
			transcript.includes('\\"kind\\":\\"request\\"')
		) {
			return fauxAssistantMessage(
				fauxToolCall("agent_message", {
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
					answer: "The initial Agent turn settled.",
				}, { id: "answer-preflight-retention-creation-request" }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("The Owner received the initial Agent Answer.");
	};
	host.model.setResponses(Array.from({ length: 4 }, () => routePreflightResponse));
	const spawn = await owner.spawn("spawn-preflight-retention-worker", spawnInput);
	assert.ok("agentId" in spawn && spawn.agentId);
	const agentId = spawn.agentId;
	await waitForCondition(() => {
		const transcriptPath = owner.status(agentId).primaryEvidence.transcriptPath;
		return transcriptPath !== null && SessionManager.open(transcriptPath).getEntries().some(
			(entry) => entry.type === "message" && entry.message.role === "assistant" &&
				JSON.stringify(entry.message.content).includes("The initial Agent turn settled."),
		);
	});
	await waitForCondition(() => owner.status(agentId).run.phase === "dormant");
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) =>
		childProcessSessionShutdowns(entries, agentId).length === 1
	);

	const activeView = await owner.openAgentView(agentId);
	assert.ok(activeView);
	// A durable view is a screen consumer: reading this child's parsed presentation
	// requires the same observation the view surface holds while it is mounted.
	await activeView.projection().screenView.begin();
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) =>
		childProcessSessionStarts(entries, agentId).length === 2
	);
	for (const character of submittedInput) {
		activeView.projection().dispatchInput(character);
	}
	await waitForCondition(() =>
		stripTerminalSequences(activeView.projection().presentation.render(80).join("\n"))
			.includes(submittedInput)
	);
	activeView.projection().dispatchInput("\r");
	// Wait until the child has entered prompt preflight, then leave the view while
	// that exact submission remains blocked on its release gate.
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "input_preflight_started" && entry.sessionId === agentId,
	));
	const returningToOwner = owner.openAgentView(identity.agentId);
	await releaseProcessAgentViewProbe(probe.releasePath);
	await returningToOwner;
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "input_preflight_finished" && entry.staleContextError === null,
	));
	await waitForCondition(() => {
		const transcriptPath = owner.status(agentId).primaryEvidence.transcriptPath;
		return transcriptPath !== null && SessionManager.open(transcriptPath).getEntries().some(
			(entry) => entry.type === "message" && entry.message.role === "assistant" &&
				JSON.stringify(entry.message.content).includes(
					"The submitted turn completed after returning to the Owner.",
				),
		);
	});
	await waitForCondition(() => owner.status(agentId).run.phase === "dormant");
});

test("termination discards selected native input already in prompt preflight", {
	timeout: 10_000,
}, async (t) => {
	const discardedInput = "Continue after the Owner leaves this Agent view.";
	const successorInput = "Start only from input submitted after termination.";
	const probe = configureProcessAgentViewProbe(t, "prompt-preflight");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.deferCleanup(async () => {
		await releaseProcessAgentViewProbe(probe.releasePath);
	});
	let discardedInputExecutions = 0;
	let successorInputExecutions = 0;
	const routeInputResponse = (context: Context): AssistantMessage => {
		const transcript = JSON.stringify(context.messages);
		if (transcript.includes(discardedInput)) discardedInputExecutions += 1;
		if (transcript.includes(successorInput)) successorInputExecutions += 1;
		return fauxAssistantMessage(
			transcript.includes(successorInput)
				? "Only the post-termination input started a successor."
				: "Input submitted before termination incorrectly survived.",
		);
	};
	host.model.setResponses([
		fauxAssistantMessage("Remain live while selected input enters preflight."),
		routeInputResponse,
		routeInputResponse,
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-preflight-termination-worker",
		{ title: "Fixture request", request: "Remain live for selected termination.", label: "Termination Fence Worker" },
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(() => currentRunPhase(host, agentId).then((phase) => phase === "live"));
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Remain live while selected input enters preflight.",
		)
	);
	const opened = await openSelectedAgentView(host, agentId);
	const childRuntime = childProcessSessionStarts(
		await readProcessAgentViewEvidence(probe.evidencePath),
		agentId,
	).at(-1);
	assert.ok(childRuntime);

	// Built-in commands consume terminal submissions without entering model input.
	// The later fence must therefore use the terminal's exact sequence, not a count
	// inferred only from participant input callbacks.
	opened.view.handleInput?.("/name termination-sequence-probe");
	opened.view.handleInput?.("\r");

	for (const character of discardedInput) opened.view.handleInput?.(character);
	opened.view.handleInput?.("\r");
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "input_preflight_started" && entry.sessionId === agentId,
	));
	const termination = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-during-selected-input-preflight",
		{ operation: "terminate", agentId },
	);
	assert.equal((termination.details as { disposition: string }).disposition, "terminated");
	assert.equal(await currentRunPhase(host, agentId), "dormant");

	await releaseProcessAgentViewProbe(probe.releasePath);
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "input_preflight_finished",
	));
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	assert.equal(discardedInputExecutions, 0);
	assert.equal(
		(await childEntries(host, agentId)).some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(discardedInput),
		),
		false,
	);
	assert.doesNotThrow(() => process.kill(childRuntime.pid, 0));

	for (const character of successorInput) opened.view.handleInput?.(character);
	opened.view.handleInput?.("\r");
	await waitForCondition(() => successorInputExecutions === 1);
	assert.equal(discardedInputExecutions, 0);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.equal(
		childProcessSessionStarts(
			await readProcessAgentViewEvidence(probe.evidencePath),
			agentId,
		).length,
		1,
	);
	await returnAgentViewToOwner(host, opened.view, opened.command);
});

test("termination fences selected input between participant handling and Agent admission", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
	});
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	await bindTestOwnerHost(host, "tui");
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		fauxAssistantMessage("Remain live before the admission fence."),
	]);
	const spawnInput = {
		title: "Fixture request",
		request: "Remain live for admission fencing.",
		label: "Admission Fence Worker",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, {
				id: "spawn-agent-start-termination-worker",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = await owner.spawn("spawn-agent-start-termination-worker", spawnInput);
	assert.ok("agentId" in spawn && spawn.agentId);
	const agentId = spawn.agentId;
	await waitForCondition(() => {
		const transcriptPath = owner.status(agentId).primaryEvidence.transcriptPath;
		return transcriptPath !== null && SessionManager.open(transcriptPath).getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				JSON.stringify(entry.message.content).includes(
					"Remain live before the admission fence.",
				),
		);
	});
	const activeView = await owner.openAgentView(agentId);
	assert.ok(activeView);

	// Establish one exact native submission identity without initiating model work.
	activeView.projection().dispatchInput("/name admission-fence-probe");
	activeView.projection().dispatchInput("\r");
	const terminateInput = { operation: "terminate" as const, agentId };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", terminateInput, {
				id: "terminate-before-selected-agent-admission",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const termination = await owner.control(
		"terminate-before-selected-agent-admission",
		terminateInput,
	);
	assert.ok("disposition" in termination);
	assert.equal(termination.disposition, "terminated");
	assert.equal(owner.status(agentId).run.phase, "dormant");

	await assert.rejects(
		coordinator.forAgent(agentId).beginExecution(1),
		/stale_native_input: submission preceded exact-Run termination/,
	);
	assert.equal(owner.status(agentId).run.phase, "dormant");
	await activeView.close();
});

test("a handled Dormant Agent input can return to Owner after prompt preflight", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "handled-prompt-preflight");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("Persist this response before handled input."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-handled-preflight-worker",
		{ title: "Fixture request", request: "Settle before handled input.", label: "Handled Preflight Worker" },
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(() => currentRunPhase(host, agentId).then((phase) => phase === "live"));
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-handled-preflight-worker",
		{ operation: "terminate", agentId },
	);
	await waitForCondition(() => currentRunPhase(host, agentId).then((phase) => phase === "dormant"));

	const { command, view } = await openDormantAgentView(host, agentId);
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) =>
		childProcessSessionStarts(entries, agentId).length === 2
	);
	for (const character of "Handle this input before the Owner leaves.") {
		view.handleInput?.(character);
	}
	view.handleInput?.("\r");
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "input_preflight_started" && entry.sessionId === agentId,
	));
	await releaseProcessAgentViewProbe(probe.releasePath);
	await returnAgentViewToOwner(host, view, command);
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "input_preflight_finished",
	));
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) =>
		childProcessSessionShutdowns(entries, agentId).length === 2
	);
	const handledRuntime = childProcessSessionStarts(
		await readProcessAgentViewEvidence(probe.evidencePath),
		agentId,
	).at(-1);
	assert.ok(handledRuntime);
	await waitForCondition(() => {
		try {
			process.kill(handledRuntime.pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	});
	assertProcessExited(handledRuntime.pid);
	assert.equal(host.ui.customSurfaces.length, 0);
	assert.equal(await currentRunPhase(host, agentId), "dormant");
});

test("a Dormant Agent keeps commands available and starts one successor on editor submission", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "dormant-command");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("Persist this response for interactive Dormant inspection."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-dormant-agent-view",
		{
			title: "Fixture request",
			request: "Become Dormant before the Owner inspects this transcript.",
			label: "Dormant Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Persist this response for interactive Dormant inspection.",
		)
	);
	const termination = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-dormant-agent-view",
		{ operation: "terminate", agentId },
	);
	assert.equal((termination.details as { disposition: string }).disposition, "terminated");
	const ownerSession = host.runtime.session;
	const ownerEditor = "Owner draft survives Dormant inspection";
	host.ui.setEditorText(ownerEditor);
	let successorModelRequests = 0;
	host.model.setResponses([
		() => {
			successorModelRequests += 1;
			return fauxAssistantMessage("The successor received the Dormant editor input.");
		},
	]);

	const { command, view } = await openDormantAgentView(host, agentId);
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n"))
			.replace(/\s+/g, "")
			.includes("PersistthisresponseforinteractiveDormantinspection")
	);
	const rendered = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(rendered, /Dormant Worker/);
	assert.match(rendered, /dormant/);
	assert.match(rendered.replace(/\s+/g, ""), /PersistthisresponseforinteractiveDormantinspection/);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.getEditorText(), ownerEditor);
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	assert.equal(successorModelRequests, 0);

	view.handleInput?.("/mark-dormant-view");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Dormant command executed",
		)
	);
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "command" && entry.command === "mark-dormant-view" && entry.pid !== process.pid,
	));
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	assert.equal(successorModelRequests, 0);

	for (const character of "Direction submitted from the Dormant Agent editor.") {
		view.handleInput?.(character);
	}
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Direction submitted from the Dormant Agent editor.",
		)
	);
	view.handleInput?.("\r");
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The successor received the Dormant editor input.",
		)
	);
	assert.equal(successorModelRequests, 1);
	assert.equal(
		(await childEntries(host, agentId)).filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(
					"Direction submitted from the Dormant Agent editor.",
				),
		).length,
		1,
	);
	assert.equal(await currentRunPhase(host, agentId), "live");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"The successor received the Dormant editor input.",
		)
	);
	assert.equal(host.ui.getEditorText(), ownerEditor);

	view.handleInput?.("/agents");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("o");
	await command;
	await waitForCondition(() => host.ui.customSurfaces.length === 0);
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), false);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.getEditorText(), ownerEditor);
});

test("detached Dormant compaction retains its Runtime until queued input starts a successor", async (t) => {
	const queuedInput = "Continue after detached Dormant compaction.";
	const completedResponse = "Queued input survived detached Dormant compaction.";
	const probe = configureProcessAgentViewProbe(t, "compaction-retention");
	const root = await mkdtemp(join(tmpdir(), "pi-agent-compaction-retention-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		compaction: {
			enabled: true,
			reserveTokens: 64,
			keepRecentTokens: 1,
		},
	}), "utf8");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		cwd: root,
		agentDir,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.deferCleanup(async () => {
		await releaseProcessAgentViewProbe(probe.releasePath);
	});
	host.model.setResponses([
		fauxAssistantMessage("Initial response supplies compactable Dormant history."),
		fauxAssistantMessage("Second response supplies older compactable history."),
		fauxAssistantMessage(completedResponse),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-dormant-compaction-worker",
		{
			title: "Fixture request",
			request: "Become Dormant before compaction starts.",
			label: "Dormant Compaction Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Initial response supplies compactable Dormant history.",
		)
	);
	const initialView = await openSelectedAgentView(host, agentId);
	initialView.view.handleInput?.("Add another turn before becoming Dormant.");
	initialView.view.handleInput?.("\r");
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Second response supplies older compactable history.",
		)
	);
	await returnAgentViewToOwner(host, initialView.view, initialView.command);
	const termination = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-dormant-compaction",
		{ operation: "terminate", agentId },
	);
	assert.equal((termination.details as { disposition: string }).disposition, "terminated");

	const opened = await openDormantAgentView(host, agentId);
	await waitForCondition(() =>
		stripTerminalSequences(opened.view.render(80).join("\n"))
			.replace(/\s+/g, "")
			.includes("Secondresponsesuppliesoldercompactablehistory")
	);
	const childRuntime = childProcessSessionStarts(
		await readProcessAgentViewEvidence(probe.evidencePath),
		agentId,
	).at(-1);
	assert.ok(childRuntime);
	opened.view.handleInput?.("/compact");
	opened.view.handleInput?.("\r");
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "compaction_started" && entry.pid === childRuntime.pid,
	));
	await returnAgentViewToOwner(host, opened.view, opened.command);
	assert.doesNotThrow(() => process.kill(childRuntime.pid, 0));
	assert.equal(await currentRunPhase(host, agentId), "dormant");

	const compactingView = await openDormantAgentView(host, agentId);
	compactingView.view.handleInput?.(queuedInput);
	compactingView.view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(compactingView.view.render(80).join("\n")).includes(
			"Queued message for after compaction",
		)
	);
	await returnAgentViewToOwner(host, compactingView.view, compactingView.command);
	assert.doesNotThrow(() => process.kill(childRuntime.pid, 0));
	assert.equal(await currentRunPhase(host, agentId), "dormant");

	await releaseProcessAgentViewProbe(probe.releasePath);
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "compaction_completed" && entry.pid === childRuntime.pid,
	));
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(completedResponse)
	);
	assert.equal(
		(await childEntries(host, agentId)).filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(queuedInput),
		).length,
		1,
	);
});

test("a Dormant command activates the already-attached Agent runtime once", async (t) => {
	const submittedText = "Start the successor from a Dormant slash command.";
	const probe = configureProcessAgentViewProbe(t, "dormant-command-message");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("Initial Run settles before command-driven startup."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-dormant-command-message-agent",
		{
			title: "Fixture request",
			request: "Become Dormant before command-driven startup.",
			label: "Dormant Command Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Initial Run settles before command-driven startup.",
		)
	);
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-dormant-command-message",
		{ operation: "terminate", agentId },
	);
	let successorModelRequests = 0;
	host.model.setResponses([() => {
		successorModelRequests += 1;
		return fauxAssistantMessage("The command-emitted user message was processed.");
	}]);

	const opened = await openDormantAgentView(host, agentId);
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) =>
		childProcessSessionStarts(entries, agentId).length === 2
	);
	const passiveTermination = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-prepared-dormant-runtime",
		{ operation: "terminate", agentId },
	);
	assert.equal(
		(passiveTermination.details as { disposition: string }).disposition,
		"not_running",
	);
	opened.view.handleInput?.("/wake-dormant-agent");
	opened.view.handleInput?.("\r");
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The command-emitted user message was processed.",
		)
	);
	const entries = await childEntries(host, agentId);
	assert.equal(
		entries.filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(submittedText),
		).length,
		1,
	);
	assert.equal(successorModelRequests, 1);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.equal(
		childProcessSessionStarts(await readProcessAgentViewEvidence(probe.evidencePath), agentId).length,
		2,
	);
	await returnAgentViewToOwner(host, opened.view, opened.command);
});

test("Dormant session_start input activates the same attached Agent runtime", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "dormant-startup-modal");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("Initial Run settles before Dormant Runtime."),
		fauxAssistantMessage("The session_start input activated this same runtime."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-dormant-runtime-modal",
		{
			title: "Fixture request",
			request: "Settle before the Owner selects this Dormant Agent.",
			label: "Dormant Runtime Modal Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Initial Run settles before Dormant Runtime.",
		)
	);
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-dormant-runtime-modal",
		{ operation: "terminate", agentId },
	);

	const opening = openDormantAgentView(host, agentId);
	const { command, view } = await opening;
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Dormant Runtime startup",
		)
	);
	await waitForCondition(async () => await currentRunPhase(host, agentId) === "live");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		!stripTerminalSequences(view.render(80).join("\n")).includes(
			"Dormant Runtime startup",
		)
	);
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The session_start input activated this same runtime.",
		)
	);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.equal(
		childProcessSessionStarts(await readProcessAgentViewEvidence(probe.evidencePath), agentId).length,
		2,
	);
	await returnAgentViewToOwner(host, view, command);
});

test("closing a Dormant session_start modal cancels view initialization without modal input", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "selection-startup-close");
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator!: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	await bindTestOwnerHost(host, "tui");
	const owner = coordinator.forAgent(identity.agentId);
	let activeView: Awaited<ReturnType<typeof owner.openAgentView>>;
	host.deferCleanup(async () => {
		await releaseProcessAgentViewProbe(probe.releasePath);
		await activeView?.close();
	});
	const spawnInput = {
		title: "Fixture request",
		request: "Become Dormant before testing startup cancellation.",
		label: "Startup Close Worker",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: "spawn-startup-close-worker" }),
			{ stopReason: "toolUse" },
		),
	);
	host.model.setResponses([
		fauxAssistantMessage("The initial startup-close Run settles."),
	]);
	const spawn = await owner.spawn("spawn-startup-close-worker", spawnInput);
	assert.ok("agentId" in spawn && spawn.agentId);
	const agentId = spawn.agentId;
	await waitForCondition(() => {
		const run = owner.status(agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	const terminateInput = {
		operation: "terminate" as const,
		agentId,
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", terminateInput, {
				id: "terminate-startup-close-worker",
			}),
			{ stopReason: "toolUse" },
		),
	);
	await owner.control("terminate-startup-close-worker", terminateInput);

	activeView = await owner.openAgentView(agentId);
	assert.ok(activeView);
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "startup_modal" && entry.sessionId === agentId && entry.pid !== process.pid,
	));
	const startupModal = (await readProcessAgentViewEvidence(probe.evidencePath)).find(
		(entry) => entry.kind === "startup_modal" && entry.sessionId === agentId &&
			entry.pid !== process.pid,
	);
	assert.ok(startupModal);
	const closing = activeView.close();
	const closeOutcome = await Promise.race([
		closing.then(() => "closed" as const),
		new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
	]);
	if (closeOutcome === "blocked") {
		await releaseProcessAgentViewProbe(probe.releasePath);
		await closing;
	}
	assert.equal(
		closeOutcome,
		"closed",
		"view closure must not wait for hidden Dormant UI input",
	);
	assert.equal(owner.status(agentId).run.phase, "dormant");
	assertProcessExited(startupModal.pid);
	await releaseProcessAgentViewProbe(probe.releasePath);
	const lifecycleEvidence = (await readProcessAgentViewEvidence(probe.evidencePath))
		.filter((entry) => entry.sessionId === agentId && entry.pid !== process.pid);
	const sessionStarts = childProcessSessionStarts(lifecycleEvidence, agentId);
	const sessionShutdowns = childProcessSessionShutdowns(lifecycleEvidence, agentId);
	assert.equal(sessionStarts.length, 2);
	// Pre-admission cancellation owns the exact process and may use SIGKILL, so
	// only the earlier admitted Runtime is required to publish session_shutdown;
	// the cancelled process may publish it if graceful exit wins the kill race.
	assert.equal(sessionShutdowns[0]?.pid, sessionStarts[0]?.pid);
	assert.ok(sessionShutdowns.length === 1 || sessionShutdowns.length === 2);
	assert.equal(new Set(sessionShutdowns.map(({ pid }) => pid)).size, sessionShutdowns.length);
	assert.equal(
		sessionShutdowns.every(({ pid }) => sessionStarts.some((start) => start.pid === pid)),
		true,
	);
	assert.equal(
		lifecycleEvidence.filter((entry) => entry.kind === "session_start_after_ui").length,
		0,
	);
	assert.deepEqual(
		lifecycleEvidence.filter((entry) => entry.kind === "session_shutdown")
			.map((entry) => entry.kind),
		Array.from({ length: sessionShutdowns.length }, () => "session_shutdown"),
	);
	assert.equal(
		owner.status(agentId).run.retentionReasons.some(
			({ reason }) => reason === "interactive_selection",
		),
		false,
	);
});

test("Workflow shutdown cancels unselected Message-started session_start UI before Agent lanes", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "unselected-startup-shutdown");
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let coordinator!: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	await bindTestOwnerHost(host, "tui");
	const owner = coordinator.forAgent(identity.agentId);
	let shutdown: Promise<void> | undefined;
	host.deferCleanup(async () => {
		await releaseProcessAgentViewProbe(probe.releasePath);
		await shutdown;
	});
	const appendToolSource = (
		toolName: string,
		toolCallId: string,
		input: Record<string, unknown>,
	) => {
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(toolName, input as JsonObject, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
	};
	host.model.setResponses([
		fauxAssistantMessage("Initial unselected-shutdown Run settles."),
		fauxAssistantMessage("Cleanup Delivery completes if startup is not canceled."),
	]);
	const spawnInput = {
		title: "Fixture request",
		request: "Become Dormant before unselected Message startup.",
		label: "Unselected Startup Worker",
	};
	appendToolSource("agent_spawn", "spawn-unselected-startup-worker", spawnInput);
	const spawn = await owner.spawn("spawn-unselected-startup-worker", spawnInput);
	assert.ok("agentId" in spawn && spawn.agentId);
	const agentId = spawn.agentId;
	await waitForCondition(() => {
		const run = owner.status(agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	const terminateInput = { operation: "terminate" as const, agentId };
	appendToolSource(
		"agent_control",
		"terminate-unselected-startup-worker",
		terminateInput,
	);
	await owner.control("terminate-unselected-startup-worker", terminateInput);
	const messageInput = {
		operation: "send" as const,
		targetAgent: agentId,
		content: "Start an unselected successor and wait in startup UI.",
	};
	appendToolSource("agent_message", "message-starts-unselected-ui", messageInput);
	const messaging = owner.message("message-starts-unselected-ui", messageInput);
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "startup_ui" && entry.sessionId === agentId && entry.pid !== process.pid,
	));
	const startupUi = (await readProcessAgentViewEvidence(probe.evidencePath)).find(
		(entry) => entry.kind === "startup_ui" && entry.sessionId === agentId &&
			entry.pid !== process.pid,
	);
	assert.ok(startupUi);

	shutdown = coordinator.shutdown(async () => host.runtime.dispose());
	const shutdownOutcome = await Promise.race([
		shutdown.then(() => "closed" as const),
		new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
	]);
	if (shutdownOutcome === "blocked") {
		await releaseProcessAgentViewProbe(probe.releasePath);
		await Promise.allSettled([messaging, shutdown]);
	}
	assert.equal(
		shutdownOutcome,
		"closed",
		"Workflow shutdown must cancel startup UI before waiting for an unselected Agent lane",
	);
	await messaging;
	assertProcessExited(startupUi.pid);
	const lifecycleEvidence = (await readProcessAgentViewEvidence(probe.evidencePath))
		.filter((entry) => entry.sessionId === agentId && entry.pid !== process.pid);
	const sessionStarts = childProcessSessionStarts(lifecycleEvidence, agentId);
	const sessionShutdowns = childProcessSessionShutdowns(lifecycleEvidence, agentId);
	assert.equal(sessionStarts.length, 2);
	assert.equal(sessionShutdowns[0]?.pid, sessionStarts[0]?.pid);
	assert.ok(sessionShutdowns.length === 1 || sessionShutdowns.length === 2);
	assert.equal(new Set(sessionShutdowns.map(({ pid }) => pid)).size, sessionShutdowns.length);
	assert.equal(
		sessionShutdowns.every(({ pid }) => sessionStarts.some((start) => start.pid === pid)),
		true,
	);
	assert.equal(
		lifecycleEvidence.filter((entry) => entry.kind === "session_start_after_ui").length,
		0,
	);
	assert.deepEqual(
		lifecycleEvidence.filter((entry) => entry.kind === "session_shutdown")
			.map((entry) => entry.kind),
		Array.from({ length: sessionShutdowns.length }, () => "session_shutdown"),
	);
});

test("/agents switches the mounted durable view between independent child modes", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "independent");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	// Each unanswered creation Request also receives its native obligation-reminder turn.
	host.model.setResponses(["First", "Second"].flatMap(label => [
		fauxAssistantMessage(label + " switch target is ready."),
		fauxAssistantMessage(label + " switch target is ready."),
	]));
	const firstSpawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-first-switch-target",
		{ title: "Fixture request", request: "Remain available as the first switch target.", label: "First Target" },
	);
	const secondSpawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-second-switch-target",
		{ title: "Fixture request", request: "Remain available as the second switch target.", label: "Second Target" },
	);
	const firstAgentId = (firstSpawn.details as { agentId: string }).agentId;
	const secondAgentId = (secondSpawn.details as { agentId: string }).agentId;
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) =>
		childProcessSessionStarts(entries, firstAgentId).length === 1 &&
		childProcessSessionStarts(entries, secondAgentId).length === 1
	);
	await waitForCondition(async () =>
		// Concurrent child admission does not assign the shared offline response queue by label.
		JSON.stringify(await childEntries(host, firstAgentId)).includes("switch target is ready") &&
		JSON.stringify(await childEntries(host, secondAgentId)).includes("switch target is ready")
	);

	const { command, view } = await openSelectedAgentView(host, firstAgentId);
	view.handleInput?.("\x1bq");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			`Independent shortcut · ${firstAgentId}`,
		)
	);
	view.handleInput?.("/mark-independent-view");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			`Independent widget · ${firstAgentId}`,
		)
	);
	view.handleInput?.("/agents");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("j");
	view.handleInput?.("\r");
	// The switch lands when the coordinator's view lane hands the target over, which
	// serializes behind that child's own work.
	await waitForCondition(
		() => {
			const rendered = stripTerminalSequences(view.render(80).join("\n"));
			return rendered.includes("Second Target") && !rendered.includes("Tab views");
		},
		{
			description: "The mounted durable view switching to the second target",
			observed: () => {
				const rendered = stripTerminalSequences(view.render(80).join("\n"));
				return `selectorStillOpen=${rendered.includes("Tab views")}, secondTargetRendered=${rendered.includes("Second Target")}`;
			},
		},
	);
	assert.equal(await hasRetention(host, firstAgentId, "interactive_selection"), false);
	assert.equal(await hasRetention(host, secondAgentId, "interactive_selection"), true);
	const secondFrame = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(secondFrame, new RegExp(`Independent footer · ${secondAgentId}`));
	assert.doesNotMatch(secondFrame, new RegExp(`Independent widget · ${firstAgentId}`));
	assert.doesNotMatch(secondFrame, new RegExp(`Independent shortcut · ${firstAgentId}`));
	view.handleInput?.("/mark-independent-view");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			`Independent widget · ${secondAgentId}`,
		)
	);

	view.handleInput?.("/agents");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("k");
	view.handleInput?.("\r");
	await waitForCondition(() => {
		const rendered = stripTerminalSequences(view.render(80).join("\n"));
		return rendered.includes("First Target") && !rendered.includes("Tab views");
	});
	assert.equal(await hasRetention(host, firstAgentId, "interactive_selection"), true);
	assert.equal(await hasRetention(host, secondAgentId, "interactive_selection"), false);
	const restoredFirstFrame = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(restoredFirstFrame, new RegExp(`Independent footer · ${firstAgentId}`));
	assert.match(restoredFirstFrame, new RegExp(`Independent widget · ${firstAgentId}`));
	assert.doesNotMatch(
		restoredFirstFrame,
		new RegExp(`Independent widget · ${secondAgentId}`),
	);

	view.handleInput?.("/agents");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("o");
	await command;
});

test("later Runtime preparations load current file-backed child configuration without mutating a retained mode", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "reload-generation");
	setTestEnvironment(t, "PROCESS_AGENT_VIEW_GENERATION", "original");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("Original resource Run remains retained."),
		fauxAssistantMessage("Replacement resource Run is ready."),
	]);
	const firstSpawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-original-resource-view",
		{ title: "Fixture request", request: "Retain the original extension mode.", label: "Original Resource" },
	);
	const firstAgentId = (firstSpawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, firstAgentId)).includes("remains retained")
	);

	process.env.PROCESS_AGENT_VIEW_GENERATION = "replacement";
	const secondSpawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-replacement-resource-view",
		{ title: "Fixture request", request: "Load the replacement extension mode.", label: "Replacement Resource" },
	);
	const secondAgentId = (secondSpawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, secondAgentId)).includes("Replacement resource")
	);
	await waitForCondition(async () => {
		const run = await currentRunState(host, secondAgentId);
		return run.phase === "live" && run.work === "settled";
	});
	const secondOpen = await openSelectedAgentView(host, secondAgentId);
	// The test-owned display parses the child's repaint asynchronously, so the first
	// synchronous snapshot after the surface appears can precede the frame itself.
	await waitForCondition(() =>
		/Factory generation · replacement/.test(
			stripTerminalSequences(secondOpen.view.render(80).join("\n")),
		)
	);
	await returnAgentViewToOwner(host, secondOpen.view, secondOpen.command);

	const reopenedFirst = await openSelectedAgentView(host, firstAgentId);
	await waitForCondition(() =>
		/Factory generation · original/.test(
			stripTerminalSequences(reopenedFirst.view.render(80).join("\n")),
		)
	);
	const retainedFrame = stripTerminalSequences(reopenedFirst.view.render(80).join("\n"));
	assert.match(retainedFrame, /Factory generation · original/);
	assert.doesNotMatch(retainedFrame, /Factory generation · replacement/);
	const generationEvidence = await readProcessAgentViewEvidence(probe.evidencePath);
	const firstStarts = childProcessSessionStarts(generationEvidence, firstAgentId);
	const secondStarts = childProcessSessionStarts(generationEvidence, secondAgentId);
	assert.equal(firstStarts.length, 1);
	assert.equal(firstStarts[0]?.generation, "original");
	assert.equal(secondStarts.length, 1);
	assert.equal(secondStarts[0]?.generation, "replacement");
	assert.notEqual(firstStarts[0]?.pid, secondStarts[0]?.pid);
	await returnAgentViewToOwner(host, reopenedFirst.view, reopenedFirst.command);
});

test("a terminally failed viewed Run stays open on the durable Dormant Agent", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		settings: { retry: { enabled: false } },
	});
	let markFailureStarted!: () => void;
	const failureStarted = new Promise<void>((resolve) => {
		markFailureStarted = resolve;
	});
	let releaseFailure!: () => void;
	const failureGate = new Promise<void>((resolve) => {
		releaseFailure = resolve;
	});
	host.deferCleanup(() => {
		releaseFailure();
	});
	// Answering the Creation Request ends its model/tool loop and settles the Run,
	// so the committed Answer is this Agent's durable readiness evidence
	// (docs/run-supervision.md) and the fixture must reuse that text as the readiness
	// the wait below observes, exactly as creationAnswerResponses does.
	const readyText = "The viewed Agent is ready for a selected failure trigger.";
	const routeResponse = async (context: Context) => {
		const messages = JSON.stringify(context.messages);
		if (messages.includes("Trigger the selected Agent Run failure.")) {
			markFailureStarted();
			await failureGate;
			return fauxAssistantMessage("The viewed exact Run failed terminally.", {
				stopReason: "error",
				errorMessage: "deterministic viewed Run failure",
			});
		}
		if (messages.includes('"toolCallId":"answer-viewed-failure-creation-request"')) {
			return fauxAssistantMessage(readyText);
		}
		const requestId = creationRequestIdFromContext(context);
		if (requestId) {
			return fauxAssistantMessage(
				fauxToolCall("agent_message", {
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
					answer: readyText,
				}, { id: "answer-viewed-failure-creation-request" }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("The Owner input loop remains usable after viewed Run failure.");
	};
	host.model.setResponses(Array.from({ length: 12 }, () => routeResponse));
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-failing-agent-view",
		{
			title: "Fixture request",
			request: "Prepare for a terminal failure while the durable Agent view remains open.",
			label: "Failing Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The viewed Agent is ready for a selected failure trigger.",
		)
	);
	// Answering the Creation Request ends its model/tool loop and settles the Run
	// (docs/run-supervision.md), so this Agent is already Dormant before termination;
	// an already-Dormant receipt reports `not_running` (docs/run-supervision.md:163).
	await waitForCondition(async () => await currentRunPhase(host, agentId) === "dormant");
	const terminated = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-ready-viewed-failure-worker",
		{ operation: "terminate", agentId },
	);
	assert.equal((terminated.details as { disposition: string }).disposition, "not_running");
	const ownerSession = host.runtime.session;
	const { command, view } = await openDormantAgentView(host, agentId);
	await waitForCondition(() =>
		/Failing Worker.*dormant/.test(stripTerminalSequences(view.render(80).join("\n")))
	);
	for (const character of "Trigger the selected Agent Run failure.") {
		view.handleInput?.(character);
	}
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Trigger the selected Agent Run failure.",
		)
	);
	view.handleInput?.("\r");
	await failureStarted;
	await waitForCondition(() =>
		/Failing Worker.*active/.test(stripTerminalSequences(view.render(80).join("\n")))
	);

	releaseFailure();
	// An unexpected terminal error retains the exact Run as a stop: the view stays
	// open on the same Agent, the exception stays in its transcript, and the Run only
	// ends through explicit termination.
	await waitForCondition(async () => (await currentRunState(host, agentId)).suspension?.reason === "runtime_error");
	assert.equal(host.ui.customSurfaces[0], view);
	assert.equal(host.runtime.session, ownerSession);
	await waitForCondition(() => {
		const frame = stripTerminalSequences(view.render(80).join("\n"));
		return frame.includes("viewed exact Run failed terminally") &&
			frame.includes("Error: deterministic viewed Run failure");
	});
	// Explicit termination still reaches the durable Dormant Agent without closing the view.
	const stoppedTerminated = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-stopped-viewed-failure-worker",
		{ operation: "terminate", agentId },
	);
	assert.equal((stoppedTerminated.details as { disposition: string }).disposition, "terminated");
	await waitForCondition(async () => await currentRunPhase(host, agentId) === "dormant");

	await host.session.prompt("Confirm the Owner input loop still runs.");
	await host.session.waitForIdle();
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.customSurfaces[0], view);

	await returnAgentViewToOwner(host, view, command);
	assert.equal(host.runtime.session, ownerSession);
});

test("repeated successor Runs reuse one selected Agent runtime and dispose its mode once", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "lifecycle");
	const baselineListeners = processListenerCounts();
	const baselineResources = processResourceCounts();
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		implicitModeratorResponses: false,
		settings: { retry: { enabled: false } },
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	// Keep process cleanup failure-safe: any assertion before the explicit disposal
	// below must not leave child Runtimes holding the test worker open.
	let releaseInitialFailure!: () => void;
	const initialFailureGate = new Promise<void>((resolve) => {
		releaseInitialFailure = resolve;
	});
	const successorInputs = ["Start exact successor one.", "Start exact successor two."];
	let notifySuccessorStarted: () => void = () => undefined;
	let successorResponseGate = Promise.resolve();
	let releaseSuccessorResponse: () => void = () => undefined;
	t.after(() => releaseSuccessorResponse());
	const routeFailure = async (context: TranscriptContext) => {
		if (getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("Moderator observed repeated successor failure.");
		}
		const messages = JSON.stringify(context.messages);
		if (messages.includes("Wait for selection before the initial exact Run fails.")) {
			await initialFailureGate;
		}
		if (successorInputs.some((input) => messages.includes(input))) {
			notifySuccessorStarted();
			await successorResponseGate;
		}
		return fauxAssistantMessage("This exact successor Run failed as requested.", {
			stopReason: "error",
			errorMessage: "deterministic repeated successor failure",
		});
	};
	host.model.setResponses(Array.from({ length: 30 }, () => routeFailure));
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-repeated-successor-worker",
		{
			title: "Fixture request",
			request: "Wait for selection before the initial exact Run fails.",
			label: "Repeated Successor Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	const opened = await openSelectedAgentView(host, agentId);
	releaseInitialFailure();
	// The terminal error retains the Run as a stop; each typed input resumes it.
	await waitForCondition(async () => (await currentRunState(host, agentId)).suspension?.reason === "runtime_error");

	for (const input of successorInputs) {
		const startsBeforeSuccessor = childProcessSessionStarts(
			await readProcessAgentViewEvidence(probe.evidencePath),
			agentId,
		).length;
		let markSuccessorStarted!: () => void;
		const successorStarted = new Promise<void>((resolve) => {
			markSuccessorStarted = resolve;
		});
		notifySuccessorStarted = markSuccessorStarted;
		successorResponseGate = new Promise<void>((resolve) => {
			releaseSuccessorResponse = resolve;
		});
		for (const character of input) opened.view.handleInput?.(character);
		opened.view.handleInput?.("\r");
		await successorStarted;
		assert.equal(await currentRunPhase(host, agentId), "live");
		releaseSuccessorResponse();
		await waitForCondition(() =>
			stripTerminalSequences(opened.view.render(80).join("\n")).includes(input)
		);
		await waitForCondition(async () => (await currentRunState(host, agentId)).suspension?.reason === "runtime_error");
		assert.equal(
			childProcessSessionStarts(
				await readProcessAgentViewEvidence(probe.evidencePath),
				agentId,
			).length,
			startsBeforeSuccessor,
		);
	}

	await returnAgentViewToOwner(host, opened.view, opened.command);
	await host.runtime.dispose();
	await waitForProcessAgentViewEvidence(probe.evidencePath, (entries) =>
		childProcessSessionShutdowns(entries, agentId).length === 1
	);
	const childLifecycle = (await readProcessAgentViewEvidence(probe.evidencePath))
		.filter((entry) => entry.sessionId === agentId && entry.pid !== process.pid);
	assert.equal(childProcessSessionStarts(childLifecycle, agentId).length, 1);
	assert.equal(childProcessSessionShutdowns(childLifecycle, agentId).length, 1);
	assert.equal(new Set(childLifecycle.map((entry) => entry.pid)).size, 1);
	assert.deepEqual(processListenerCounts(), baselineListeners);
	await waitForCondition(() => {
		try {
			assertNoProcessResourceGrowth(baselineResources, processResourceCounts());
			return true;
		} catch {
			return false;
		}
	});
	assertNoProcessResourceGrowth(baselineResources, processResourceCounts());
});

test("an ordinary Message activates the already-open Agent runtime before execution", async (t) => {
	const probe = configureProcessAgentViewProbe(t, "message-runtime");
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		additionalExtensionPaths: [PROCESS_AGENT_VIEW_PROBE],
	});
	let releaseInitialFailure!: () => void;
	const initialFailureGate = new Promise<void>((resolve) => {
		releaseInitialFailure = resolve;
	});
	let markInitialFailureStarted!: () => void;
	const initialFailureStarted = new Promise<void>((resolve) => {
		markInitialFailureStarted = resolve;
	});
	let releaseSuccessor!: () => void;
	const successorGate = new Promise<void>((resolve) => {
		releaseSuccessor = resolve;
	});
	host.deferCleanup(() => {
		releaseInitialFailure();
		releaseSuccessor();
	});
	let view!: Component;
	let markSuccessorExecutionStarted!: () => void;
	const successorExecutionStarted = new Promise<void>((resolve) => {
		markSuccessorExecutionStarted = resolve;
	});
	let attachedBeforeExecution = false;
	let runAdmittedBeforeExecution = false;
	let initialFailureProduced = false;
	const routeSuccessor = async (context: TranscriptContext) => {
		const messages = JSON.stringify(context.messages);
		if (getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("Moderator background work remains independent.");
		}
		if (
			!initialFailureProduced &&
			messages.includes("Fail while selected before ordinary Message delivery.")
		) {
			initialFailureProduced = true;
			markInitialFailureStarted();
			await initialFailureGate;
			return fauxAssistantMessage("The initially selected Run failed.", {
				stopReason: "error",
				errorMessage: "deterministic failure before Message successor",
			});
		}
		if (messages.includes("Start the successor through ordinary Message delivery.")) {
			attachedBeforeExecution = host.ui.customSurfaces[0] === view;
			runAdmittedBeforeExecution = await currentRunPhase(host, agentId) === "live";
			markSuccessorExecutionStarted();
			await successorGate;
			return fauxAssistantMessage("The Message-started successor completed.");
		}
		return fauxAssistantMessage("Unrelated Owner work remained on the Owner session.");
	};
	host.model.setResponses(Array.from({ length: 16 }, () => routeSuccessor));
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-message-successor-view",
		{
			title: "Fixture request",
			request: "Fail while selected before ordinary Message delivery.",
			label: "Successor Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await initialFailureStarted;
	const ownerSession = host.runtime.session;
	const opened = await openSelectedAgentView(host, agentId);
	view = opened.view;
	releaseInitialFailure();
	// The stop retains the Run, so the ordinary Message below needs the Agent dormant
	// again: explicit termination is what ends a stopped Run.
	await waitForCondition(async () => (await currentRunState(host, agentId)).suspension?.reason === "runtime_error");
	const stoppedTermination = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-stopped-viewed-successor",
		{ operation: "terminate", agentId },
	);
	assert.equal((stoppedTermination.details as { disposition: string }).disposition, "terminated");
	await waitForCondition(async () => await currentRunPhase(host, agentId) === "dormant");

	const sent = await executeAndCommitRegisteredTool(
		host.session,
		"agent_message",
		"message-starts-viewed-successor",
		{
			operation: "send",
			targetAgent: agentId,
			content: "Start the successor through ordinary Message delivery.",
		},
	);
	assert.equal(
		(sent.details as { messageStatus: string }).messageStatus,
		"sent",
	);
	await successorExecutionStarted;
	assert.equal(attachedBeforeExecution, true);
	assert.equal(runAdmittedBeforeExecution, true);
	await waitForCondition(() => {
		const rendered = stripTerminalSequences(view.render(80).join("\n")).replace(/\s+/g, "");
		return rendered.includes("SuccessorWorker") && rendered.includes("active") &&
			rendered.includes("StartthesuccessorthroughordinaryMessagedelivery.");
	});
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.customSurfaces[0], view);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), true);
	assert.equal(
		childProcessSessionStarts(await readProcessAgentViewEvidence(probe.evidencePath), agentId).length,
		1,
	);

	releaseSuccessor();
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The Message-started successor completed.",
		)
	);
	await returnAgentViewToOwner(host, view, opened.command);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), false);
});

async function openSelectedAgentView(
	host: TestOwnerHost,
	agentId: string,
): Promise<Readonly<{ command: Promise<void>; view: Component }>> {
	const { command, surface: selector } = await openAgentsSurface(host);
	if (!selectAgentInCurrentTree(selector, agentId, host.session.sessionId)) {
		selector.handleInput?.("\x1b");
		await command;
		assert.fail(`Agent ${agentId} is absent from the Live selector hierarchy`);
	}
	await waitForCondition(() =>
		host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== selector
	);
	return { command, view: host.ui.customSurfaces[0]! };
}

async function returnAgentViewToOwner(
	host: TestOwnerHost,
	view: Component,
	command: Promise<void>,
): Promise<void> {
	view.handleInput?.("/agents");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("/agents")
	);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("o");
	await command;
	// Physical selection commands finish at handoff, before returning to Owner.
	// Unmounting releases the child Runtime, so this wait is bounded by that shutdown.
	await waitForCondition(() => host.ui.customSurfaces.length === 0, {
		description: "The Agent view to unmount on return to Owner",
		observed: () => `surfaces=${host.ui.customSurfaces.length}`,
	});
}

async function openDormantAgentView(
	host: TestOwnerHost,
	agentId: string,
): Promise<Readonly<{ command: Promise<void>; view: Component }>> {
	const { command, surface: selector } = await openAgentsSurface(host);
	selector.handleInput?.("\t");
	const firstRender = selector.render(80).join("\n");
	let currentRender = firstRender;
	for (let attempt = 0; attempt < MAX_SELECTOR_NAVIGATION_STEPS; attempt += 1) {
		if (focusedDetailsShowAgent(selector, agentId)) {
			selector.handleInput?.("\r");
			// A dormant Agent's view is published only after its Runtime boots, so this
			// wait is bounded by a child process, not by in-process state.
			await waitForCondition(
				() => host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== selector,
				{
					description: `The view of dormant Agent ${agentId} replacing the selector`,
					observed: () =>
						`surfaces=${host.ui.customSurfaces.length}, selectorStillMounted=${host.ui.customSurfaces[0] === selector}`,
				},
			);
			return { command, view: host.ui.customSurfaces[0]! };
		}
		selector.handleInput?.("j");
		currentRender = selector.render(80).join("\n");
		if (currentRender === firstRender) break;
	}
	selector.handleInput?.("\x1b");
	await command;
	assert.fail(`Dormant Agent ${agentId} is absent from the selector`);
}

function selectAgentInCurrentTree(
	surface: Component,
	targetAgentId: string,
	ownerAgentId: string,
): boolean {
	const firstRender = surface.render(80).join("\n");
	let currentRender = firstRender;
	// Selector focus does not wrap; comparing only with the first frame spins at the footer.
	for (let attempt = 0; attempt < MAX_SELECTOR_NAVIGATION_STEPS; attempt += 1) {
		if (focusedDetailsShowAgent(surface, targetAgentId)) {
			surface.handleInput?.("\r");
			return true;
		}
		if (!focusedDetailsShowAgent(surface, ownerAgentId)) {
			const beforeZoom = currentRender;
			surface.handleInput?.("l");
			const afterZoom = surface.render(80).join("\n");
			if (afterZoom !== beforeZoom) {
				if (selectAgentInCurrentTree(surface, targetAgentId, ownerAgentId)) return true;
				surface.handleInput?.("h");
			}
		}
		const beforeMove = surface.render(80).join("\n");
		surface.handleInput?.("j");
		currentRender = surface.render(80).join("\n");
		if (currentRender === beforeMove || currentRender === firstRender) break;
	}
	return false;
}

function selectAgentByLabel(surface: Component, label: string): string | undefined {
	const firstRender = stripTerminalSequences(surface.render(80).join("\n"));
	let currentRender = firstRender;
	for (let attempt = 0; attempt < MAX_SELECTOR_NAVIGATION_STEPS; attempt += 1) {
		const lines = stripTerminalSequences(surface.render(80).join("\n")).split("\n");
		const selectedRow = lines.findIndex((line) => line.includes("→"));
		if (selectedRow >= 0 && lines[selectedRow]?.includes(label)) {
			const agentId = lines
				.slice(selectedRow + 1, selectedRow + 5)
				.map((line) => line.slice(1, -1).trim())
				.find((line) => /^[0-9a-f-]{36}$/i.test(line));
			surface.handleInput?.("\r");
			return agentId;
		}
		surface.handleInput?.("k");
		const nextRender = stripTerminalSequences(surface.render(80).join("\n"));
		if (nextRender === currentRender || nextRender === firstRender) break;
		currentRender = nextRender;
	}
	return undefined;
}

function focusedDetailsShowAgent(surface: Component, targetAgentId: string): boolean {
	const lines = surface.render(80).map(stripTerminalSequences);
	const selectedRow = lines.findIndex((line) => line.includes("→"));
	if (selectedRow < 0) return false;
	return lines
		.slice(selectedRow + 1, selectedRow + 5)
		.some((line) => line.slice(1, -1).trim() === targetAgentId);
}

async function hasRetention(
	host: TestOwnerHost,
	agentId: string,
	reason: string,
): Promise<boolean> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const result = await observe.execute(
		`observe-${reason}-${Date.now()}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return (result.details as {
		run: { retentionReasons: Array<{ reason: string }> };
	}).run.retentionReasons.some((retention) => retention.reason === reason);
}

async function currentRunPhase(host: TestOwnerHost, agentId: string): Promise<string> {
	return (await currentRunState(host, agentId)).phase;
}

async function currentRunState(
	host: TestOwnerHost,
	agentId: string,
): Promise<{ phase: string; work?: string; suspension?: { reason: string } }> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		`observe-run-state-${Date.now()}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return (status.details as {
		run: { phase: string; work?: string; suspension?: { reason: string } };
	}).run;
}

async function childEntries(host: TestOwnerHost, agentId: string) {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		`locate-child-transcript-${Date.now()}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const transcriptPath = (status.details as {
		primaryEvidence: { transcriptPath: string | null };
	}).primaryEvidence.transcriptPath;
	assert.ok(transcriptPath);
	return SessionManager.open(transcriptPath).getEntries();
}

function creationAnswerResponses(
	toolCallId: string,
	readyText: string,
): Array<(context: Context) => AssistantMessage> {
	const route = (context: Context): AssistantMessage => {
		const transcript = JSON.stringify(context.messages);
		if (transcript.includes(`"toolCallId":"${toolCallId}"`)) {
			return fauxAssistantMessage(readyText);
		}
		const requestId = creationRequestIdFromContext(context);
		if (requestId) {
			return fauxAssistantMessage(
				fauxToolCall("agent_message", {
					operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
					answer: readyText,
				}, { id: toolCallId }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("The Owner remained usable after child startup.");
	};
	return Array.from({ length: 4 }, () => route);
}

function creationRequestIdFromContext(context: Context): string | undefined {
	return findCreationRequestId(context.messages);
}

function findCreationRequestId(value: unknown): string | undefined {
	if (typeof value === "string") {
		try {
			return findCreationRequestId(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const requestId = findCreationRequestId(item);
			if (requestId) return requestId;
		}
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.kind === "request" &&
		typeof record.requestMessageId === "string"
	) {
		return record.requestMessageId;
	}
	for (const nested of Object.values(record)) {
		const requestId = findCreationRequestId(nested);
		if (requestId) return requestId;
	}
	return undefined;
}

function processListenerCounts(): Readonly<Record<string, number>> {
	return {
		SIGTERM: process.listenerCount("SIGTERM"),
		SIGHUP: process.listenerCount("SIGHUP"),
		uncaughtException: process.listenerCount("uncaughtException"),
	};
}

function processResourceCounts(): Readonly<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const resource of process.getActiveResourcesInfo()) {
		counts[resource] = (counts[resource] ?? 0) + 1;
	}
	return counts;
}

function assertNoProcessResourceGrowth(
	baseline: Readonly<Record<string, number>>,
	actual: Readonly<Record<string, number>>,
): void {
	for (const [resource, count] of Object.entries(actual)) {
		assert.ok(
			count <= (baseline[resource] ?? 0),
			`${resource} grew from ${baseline[resource] ?? 0} to ${count}`,
		);
	}
}

type ProcessAgentViewEvidence = Readonly<{
	kind: string;
	pid: number;
	sessionId?: string;
	failureKind?: string;
	command?: string;
	staleContextError?: string | null;
	generation?: string;
	exitCode?: number;
}>;

function configureProcessAgentViewProbe(
	t: TestContext,
	scenario: string,
): Readonly<{ evidencePath: string; releasePath: string }> {
	const nonce = `${process.pid}-${scenario}-${randomUUID()}`;
	const evidencePath = join(tmpdir(), `.process-agent-view-${nonce}.jsonl`);
	const releasePath = join(tmpdir(), `.process-agent-view-${nonce}.release`);
	setTestEnvironment(t, "PROCESS_AGENT_VIEW_SCENARIO", scenario);
	setTestEnvironment(t, "PROCESS_AGENT_VIEW_EVIDENCE", evidencePath);
	setTestEnvironment(t, "PROCESS_AGENT_VIEW_RELEASE", releasePath);
	return { evidencePath, releasePath };
}

function setTestEnvironment(t: TestContext, name: string, value: string): void {
	const previous = process.env[name];
	process.env[name] = value;
	t.after(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	});
}

async function releaseProcessAgentViewProbe(path: string): Promise<void> {
	await writeFile(path, "released\n", "utf8");
}

async function readProcessAgentViewEvidence(path: string): Promise<ProcessAgentViewEvidence[]> {
	try {
		return (await readFile(path, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ProcessAgentViewEvidence);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function waitForProcessAgentViewEvidence(
	path: string,
	predicate: (entries: readonly ProcessAgentViewEvidence[]) => boolean,
): Promise<void> {
	const deadline = Date.now() + SURFACE_WAIT_TIMEOUT_MS;
	for (;;) {
		const entries = await readProcessAgentViewEvidence(path);
		if (predicate(entries)) return;
		if (Date.now() >= deadline) {
			const kinds = entries.map((entry) => entry.kind).join(", ");
			throw new Error(
				`Expected child process Agent-view evidence was not observed within ${SURFACE_WAIT_TIMEOUT_MS} ms` +
					` (observed: ${kinds === "" ? "no evidence" : kinds})`,
			);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

function childProcessSessionStarts(
	entries: readonly ProcessAgentViewEvidence[],
	agentId: string,
): ProcessAgentViewEvidence[] {
	return entries.filter((entry) =>
		entry.kind === "session_start" &&
		entry.sessionId === agentId &&
		entry.pid !== process.pid
	);
}

function childProcessSessionShutdowns(
	entries: readonly ProcessAgentViewEvidence[],
	agentId: string,
): ProcessAgentViewEvidence[] {
	return entries.filter((entry) =>
		entry.kind === "session_shutdown" &&
		entry.sessionId === agentId &&
		entry.pid !== process.pid
	);
}

function assertProcessExited(pid: number): void {
	assert.throws(
		() => process.kill(pid, 0),
		(error: unknown) =>
			typeof error === "object" && error !== null && "code" in error &&
			(error as NodeJS.ErrnoException).code === "ESRCH",
	);
}

async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	options: Readonly<{
		description?: string;
		observed?: () => string;
	}> = {},
): Promise<void> {
	const deadline = Date.now() + SURFACE_WAIT_TIMEOUT_MS;
	for (;;) {
		// The deadline is checked after the predicate, so a slow predicate is never
		// abandoned mid-evaluation — which is exactly what a loaded host produces.
		if (await predicate()) return;
		if (Date.now() >= deadline) {
			const observed = options.observed?.();
			// Name the wait site too: the caller frame is what a reviewer needs when a
			// site did not pass a description.
			const site = new Error().stack?.split("\n")[2]?.trim();
			throw new Error(
				`${options.description ?? "Agent view state"} was not reached within ${SURFACE_WAIT_TIMEOUT_MS} ms` +
					(observed === undefined ? "" : ` (observed: ${observed})`) +
					(site === undefined ? "" : ` [${site}]`),
			);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
}
