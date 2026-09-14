import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import piAgentCoordination from "../src/index.ts";
import {
	executeAndCommitRegisteredTool,
	openLiveAgentView,
} from "./support/agent-session.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

const OWNER_FORK_WAIT_TIMEOUT_MS = 5_000;
const OWNER_FORK_POLL_INTERVAL_MS = 1;

test("native Owner clone closes an open Agent view and creates the replacement Workflow", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
	});
	try {
		host.model.setResponses([
			fauxAssistantMessage("The child remains available while Owner clone begins."),
		]);
		const spawn = await executeTool(host, "agent_spawn", "spawn-clone-viewed-child", {
			title: "Fixture request",
			request: "Remain available while the Owner clones from behind the Agent view.",
		});
		const childAgentId = (spawn as { agentId: string }).agentId;
		const sourceOwner = host.runtime.session;
		const opened = await openLiveAgentView(host, childAgentId);
		assert.equal(host.runtime.session, sourceOwner);
		const leafId = sourceOwner.sessionManager.getLeafId();
		assert.ok(leafId);

		const result = await host.runtime.fork(leafId, { position: "at" });
		await opened.command;

		assert.deepEqual(result, { cancelled: false, selectedText: undefined });
		assert.notEqual(host.runtime.session, sourceOwner);
		assert.equal(host.ui.customSurfaces.length, 0);
	} finally {
		await host.runtime.dispose();
	}
});

test("native fork is cancelled for a matching Moderator bootstrap", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
	});
	host.session.sessionManager.appendCustomMessageEntry(
		"agent-coordination.moderator-input",
		"Investigate one current Workflow condition.",
		true,
		{
			agentId: host.session.sessionId,
			workflowId: "source-workflow",
			creationPreset: null,
			metadata: {
				label: "Moderator",
				description: "Incident: run failure",
			},
		},
	);
	await bindTestOwnerHost(host, "tui");
	try {
		host.model.setResponses([
			fauxAssistantMessage("The Moderator transcript remains selected."),
		]);
		await host.session.prompt("Keep this native session available for fork gating.");
		await host.session.waitForIdle();
		const userEntry = host.session.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user",
			);
		assert.ok(userEntry);
		const sessionBeforeFork = host.runtime.session;

		const result = await host.runtime.fork(userEntry.id);

		assert.deepEqual(result, { cancelled: true });
		assert.equal(host.runtime.session, sessionBeforeFork);
	} finally {
		await host.runtime.dispose();
	}
});

test("offline fork preparation repairs copied child evidence into the current Owner", async (t) => {
	const source = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
	});
	source.session.sessionManager.appendCustomEntry("agent-coordination.identity", {
		agentId: source.session.sessionId,
		workflowId: "source-workflow",
		directSpawnerAgentId: "source-parent",
		creationPreset: null,
		spawnSource: {
			agentId: "source-parent",
			entryId: "source-spawn-entry",
			toolCallId: "source-spawn-call",
		},
		metadata: { label: "source-child" },
	});
	source.session.sessionManager.appendMessage(
		fauxAssistantMessage("Keep copied child conversation as native context."),
	);
	const sourceFile = source.session.sessionManager.getSessionFile();
	assert.ok(sourceFile);
	const preparedManager = SessionManager.forkFrom(
		sourceFile,
		source.cwd,
		join(source.cwd, "offline-fork"),
	);
	const preparedFile = preparedManager.getSessionFile();
	assert.ok(preparedFile);
	await source.runtime.dispose();

	const prepared = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		cwd: source.cwd,
		agentDir: source.services.agentDir,
		sessionFile: preparedFile,
	});
	await bindTestOwnerHost(prepared, "tui");
	try {
		assert.equal(
			typeof prepared.session.getToolDefinition("agent_observe")?.renderResult,
			"function",
		);
		assert.equal(prepared.session.getActiveToolNames().includes("agent_observe"), true);
		assert.equal(
			prepared.session.sessionManager.getEntries().some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity" &&
					(entry.data as { agentId?: unknown }).agentId === prepared.session.sessionId,
			),
			true,
		);
		assert.equal(
			prepared.ui.notifications.some(({ type }) => type === "error"),
			false,
		);
	} finally {
		await prepared.runtime.dispose();
	}
});

test("native Owner clone creates an isolated Workflow after nested coordination", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	const sourceOwner = host.session;
	const sourceOwnerId = sourceOwner.sessionId;
	const sourceFile = sourceOwner.sessionManager.getSessionFile();
	assert.ok(sourceFile);
	try {
		// The direct and nested child processes can request their terminal response in
		// either order. Route both broker slots from their delivered Request evidence.
		const completeNestedCoordination = (context: Context) =>
			fauxAssistantMessage(
				JSON.stringify(context.messages).includes(
					"Create a nested source Workflow for clone coverage.",
				)
					? "The direct child completed nested coordination."
					: "The nested child is ready in the source Workflow.",
			);
		host.model.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"agent_spawn",
					{ title: "Fixture request", request: "Remain as a nested source Agent." },
					{ id: "spawn-source-nested-child" },
				),
				{ stopReason: "toolUse" },
			),
			completeNestedCoordination,
			completeNestedCoordination,
		]);
		const directSpawn = await executeTool(
			host,
			"agent_spawn",
			"spawn-source-direct-child",
			{ title: "Fixture request", request: "Create a nested source Workflow for clone coverage." },
		);
		const directChildId = (directSpawn as { agentId: string }).agentId;
		const directCreationRequestId = (directSpawn as {
			requestMessageId: string;
		}).requestMessageId;
		const nestedChildId = await waitForOnlyChild(host, directChildId);
		await waitForAgentTranscript(
			host,
			directChildId,
			"The direct child completed nested coordination.",
		);
		await waitForAgentTranscript(
			host,
			nestedChildId,
			"The nested child is ready in the source Workflow.",
		);
		assert.equal(host.runtime.session, sourceOwner);
		host.model.setResponses([
			fauxAssistantMessage("The initial Request no longer occupies the incoming Request slot."),
		]);
		await executeTool(
			host,
			"agent_message",
			"cancel-direct-creation-before-source-request",
			{
				operation: "cancel",
				requestMessageId: directCreationRequestId,
				reason: "The nested coordination is complete.",
			},
		);
		host.model.setResponses([
			fauxAssistantMessage("Keep the delivered Request unresolved in the source Workflow."),
		]);
		const request = await executeTool(
			host,
			"agent_message",
			"request-source-child-before-clone",
			{
				title: "Fixture request",
				operation: "request",
				targetAgent: directChildId,
				question: "What source-only result should remain unresolved?",
			},
		);
		const sourceRequestId = (
			request as { requestMessageId: string }
		).requestMessageId;
		await waitForMessageDelivery(host, directChildId, sourceRequestId);
		host.model.setResponses([
			fauxAssistantMessage("Copied conversation remains useful model context."),
		]);
		await sourceOwner.prompt("Preserve this source conversation in the clone.");
		await sourceOwner.waitForIdle();
		const sourceEntries = structuredClone(sourceOwner.sessionManager.getEntries());
		const sourceLeafId = sourceOwner.sessionManager.getLeafId();
		assert.ok(sourceLeafId);

		const clone = await host.runtime.fork(sourceLeafId, { position: "at" });

		assert.deepEqual(clone, { cancelled: false, selectedText: undefined });
		assert.deepEqual(sourceOwner.sessionManager.getEntries(), sourceEntries);
		const forkOwner = host.runtime.session;
		assert.notEqual(forkOwner.sessionId, sourceOwnerId);
		assert.equal(forkOwner.sessionManager.getHeader()?.parentSession, sourceFile);
		const identities = forkOwner.sessionManager.getEntries().filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "agent-coordination.identity",
		);
		const currentIdentities = identities.filter(
			(entry) =>
				entry.type === "custom" &&
				(entry.data as { agentId?: unknown }).agentId === forkOwner.sessionId,
		);
		assert.equal(currentIdentities.length, 1);
		assert.equal(
			identities.some(
				(entry) =>
					entry.type === "custom" &&
					(entry.data as { agentId?: unknown }).agentId === sourceOwnerId,
			),
			true,
		);
		assert.deepEqual(
			currentIdentities[0] && currentIdentities[0].type === "custom"
				? currentIdentities[0].data
				: undefined,
			{
				agentId: forkOwner.sessionId,
				workflowId: forkOwner.sessionId,
				directSpawnerAgentId: null,
				metadata: { label: "Owner", description: "Workflow Owner" },
			},
		);
		const copiedContext = JSON.stringify(
			forkOwner.sessionManager.buildSessionContext().messages,
		);
		assert.match(copiedContext, /Preserve this source conversation in the clone/);
		assert.match(copiedContext, /What source-only result should remain unresolved/);

		const children = await executeTool(
			host,
			"agent_observe",
			"observe-empty-fork-workflow",
			{ operation: "search", scope: "direct_children" },
		);
		assert.deepEqual(children, { matches: [], hasMore: false });
		await assertSourceIdentityIsUnavailable(host, {
			directChildId,
			sourceRequestId,
		});

		host.model.setResponses([
			fauxAssistantMessage("The fork child belongs only to the fresh Workflow."),
		]);
		const forkSpawn = await executeTool(
			host,
			"agent_spawn",
			"spawn-fork-only-child",
			{ title: "Fixture request", request: "Remain in the fresh fork Workflow." },
		);
		const forkChildId = (forkSpawn as { agentId: string }).agentId;
		const forkChildren = await executeTool(
			host,
			"agent_observe",
			"observe-fork-only-child",
			{ operation: "search", scope: "direct_children" },
		) as {
			matches: Array<{
				agentId: string;
				workflowId: string;
				primaryEvidence: { transcriptPath: string | null };
			}>;
		};
		assert.equal(forkChildren.matches.length, 1);
		assert.equal(forkChildren.matches[0]?.agentId, forkChildId);
		assert.equal(forkChildren.matches[0]?.workflowId, forkOwner.sessionId);
		assert.match(
			forkChildren.matches[0]?.primaryEvidence.transcriptPath ?? "",
			new RegExp(Buffer.from(forkOwner.sessionId, "utf8").toString("base64url")),
		);
		assert.notEqual(forkChildId, directChildId);
		assert.notEqual(forkChildId, nestedChildId);
	} finally {
		await host.runtime.dispose();
	}
});

test("native Owner fork preserves branch editing and source Workflow continuation", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	const sourceOwner = host.session;
	const sourceOwnerId = sourceOwner.sessionId;
	const sourceFile = sourceOwner.sessionManager.getSessionFile();
	assert.ok(sourceFile);
	let resumedSource: TestOwnerHost | undefined;
	try {
		host.model.setResponses([
			(context) => fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
						answer: "The source child is durable across branch selection.",
					},
					{ id: "answer-source-branch-creation" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The source child is durable across branch selection."),
			fauxAssistantMessage("The source child Answer reached its Owner."),
		]);
		const spawn = await executeTool(
			host,
			"agent_spawn",
			"spawn-source-branch-child",
			{ title: "Fixture request", request: "Remain available in the source Workflow after its Owner forks." },
		);
		const sourceChildId = (spawn as { agentId: string }).agentId;
		await waitForAgentTranscript(
			host,
			sourceChildId,
			"The source child is durable across branch selection.",
		);
		assert.equal(host.runtime.session, sourceOwner);

		const sourceIdentity = sourceOwner.sessionManager.getEntries().find(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "agent-coordination.identity" &&
				(entry.data as { agentId?: unknown }).agentId === sourceOwnerId,
		);
		assert.ok(sourceIdentity);
		sourceOwner.sessionManager.branch(sourceIdentity.id);
		host.model.setResponses([
			fauxAssistantMessage("This branch can be edited into a fresh Workflow."),
		]);
		const editorText = "Edit this user message in the fresh Workflow.";
		await sourceOwner.prompt(editorText);
		await sourceOwner.waitForIdle();
		const forkUserEntry = sourceOwner.sessionManager.getEntries().find(
			(entry) =>
				entry.parentId === sourceIdentity.id &&
				entry.type === "message" &&
				entry.message.role === "user",
		);
		assert.ok(forkUserEntry);

		const fork = await host.runtime.fork(forkUserEntry.id);

		assert.deepEqual(fork, { cancelled: false, selectedText: editorText });
		const forkOwner = host.runtime.session;
		assert.notEqual(forkOwner.sessionId, sourceOwnerId);
		assert.deepEqual(
			(await executeTool(
				host,
				"agent_observe",
				"observe-branch-fork-children",
				{ operation: "search", scope: "direct_children" },
			)) as { matches: unknown[]; hasMore: boolean },
			{ matches: [], hasMore: false },
		);

		resumedSource = await createUnboundTestOwnerHost(t, piAgentCoordination, {
			cwd: host.cwd,
			agentDir: host.services.agentDir,
			sessionFile: sourceFile,
			processVisibleModel: true,
		});
		await bindTestOwnerHost(resumedSource, "tui");
		const recovered = await executeTool(
			resumedSource,
			"agent_observe",
			"observe-reopened-source-child",
			{ operation: "search", scope: "direct_children" },
		) as { matches: Array<{ agentId: string; workflowId: string }> };
		assert.equal(recovered.matches.length, 1);
		assert.equal(recovered.matches[0]?.agentId, sourceChildId);
		assert.equal(recovered.matches[0]?.workflowId, sourceOwnerId);
		resumedSource.model.setResponses([
			fauxAssistantMessage("The reopened source child accepted new work."),
		]);
		const continued = await executeTool(
			resumedSource,
			"agent_message",
			"continue-reopened-source-workflow",
			{
				operation: "send",
				targetAgent: sourceChildId,
				content: "Continue only in the reopened source Workflow.",
			},
		) as { messageStatus: string };
		assert.equal(continued.messageStatus, "sent");
		assert.equal(host.runtime.session, forkOwner);
	} finally {
		if (resumedSource) await resumedSource.runtime.dispose();
		await host.runtime.dispose();
	}
});

for (const invalidTool of ["agent_spawn", "agent_message"] as const) {
	test(`blocked Owner forks independently with now-invalid successful ${invalidTool} history`, { timeout: 15_000 }, async (t) => {
		const source = await createTestOwnerHost(t, piAgentCoordination, {
			persistent: true, processVisibleModel: true,
		});
		let reopened: TestOwnerHost | undefined;
		try {
			source.model.setResponses([
				fauxAssistantMessage("The historical Creation Request remains unanswered."),
			]);
			const spawn = await executeTool(source, "agent_spawn", "historical-successful-spawn", {
				title: "Historical creation", request: "Keep this source-only Creation Request unresolved.",
			}) as { agentId: string; requestMessageId: string; spawnStatus: string };
			assert.equal(spawn.spawnStatus, "created");
			await waitForAgentTranscript(source, spawn.agentId, "The historical Creation Request remains unanswered.");
			source.model.setResponses([
				fauxAssistantMessage("The historical Request remains unanswered too."),
			]);
			const request = await executeTool(source, "agent_message", "historical-successful-request", {
				operation: "request", targetAgent: spawn.agentId, deliveryMode: "steer",
				title: "Historical request", question: "Keep this source-only Request unresolved.",
			}) as { requestMessageId: string; messageStatus: string };
			assert.equal(request.messageStatus, "sent");
			await waitForMessageDelivery(source, spawn.agentId, request.requestMessageId);
			await waitForAgentTranscript(source, spawn.agentId, "The historical Request remains unanswered too.");
			const childStatus = await executeTool(source, "agent_observe", "historical-child-path", {
				operation: "status", agentId: spawn.agentId,
			}) as { primaryEvidence: { transcriptPath: string } };
			const editorText = "Edit this selected message in the independent Workflow.";
			const selectedId = source.session.sessionManager.appendMessage({
				role: "user", content: editorText, timestamp: Date.now(),
			});
			const sourceFile = source.session.sessionManager.getSessionFile()!;
			const sourceId = source.session.sessionId;
			await source.runtime.dispose();

			// Simulate a formerly accepted input whose required title is now missing.
			// Retain its real successful receipt and all participant delivery evidence.
			const records = (await readFile(sourceFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
			// Invalid child Spawn proof is quarantined, not a whole-Owner blockage.
			// Keep an invalid Owner Request in both cases to exercise failed admission.
			const callIds = invalidTool === "agent_spawn"
				? ["historical-successful-spawn", "historical-successful-request"]
				: ["historical-successful-request"];
			for (const callId of callIds) {
				const call = records.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant"
					? entry.message.content : []).find((part) => part.type === "toolCall" && part.id === callId);
				assert.ok(call);
				delete call.arguments.title;
			}
			await writeFile(sourceFile, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			const sourceBytes = await readFile(sourceFile, "utf8");
			const childBytes = await readFile(childStatus.primaryEvidence.transcriptPath, "utf8");

			reopened = await createUnboundTestOwnerHost(t, piAgentCoordination, {
				cwd: source.cwd, agentDir: source.services.agentDir, sessionFile: sourceFile,
				processVisibleModel: true,
			});
			await bindTestOwnerHost(reopened, "tui");
			assert.equal(reopened.session.getActiveToolNames().includes("agent_spawn"), false);
			assert.ok(reopened.ui.widgets.has("agent-coordination.blockage"));
			// Reload must not turn the historical successful admission into authority.
			await reopened.session.reload();
			assert.equal(reopened.session.getActiveToolNames().includes("agent_spawn"), false);
			const sourceEntries = structuredClone(reopened.session.sessionManager.getEntries());
			const position = invalidTool === "agent_spawn" ? "at" : "before";
			const context = reopened.session.sessionManager.buildSessionContext().messages;
			const expectedContext = position === "at" ? context : context.slice(0, -1);

			assert.deepEqual(await reopened.runtime.fork(selectedId, { position }), {
				cancelled: false, selectedText: position === "at" ? undefined : editorText,
			});
			const fork = reopened.runtime.session;
			assert.notEqual(fork.sessionId, sourceId);
			assert.equal(fork.sessionManager.getHeader()?.parentSession, sourceFile);
			assert.deepEqual(reopened.session.sessionManager.getEntries(), sourceEntries);
			assert.deepEqual(fork.sessionManager.buildSessionContext().messages, expectedContext);
			const cutoff = fork.sessionManager.getEntries().find((entry) => entry.type === "custom"
				&& entry.customType === "agent-coordination.identity"
				&& (entry.data as { agentId?: string }).agentId === fork.sessionId);
			assert.ok(cutoff?.type === "custom");
			assert.deepEqual(cutoff.data, {
				agentId: fork.sessionId, workflowId: fork.sessionId, directSpawnerAgentId: null,
				metadata: { label: "Owner", description: "Workflow Owner" },
			});
			assert.equal(fork.getActiveToolNames().includes("agent_spawn"), true);
			assert.equal(reopened.ui.widgets.has("agent-coordination.blockage"), false);
			assert.deepEqual(await executeTool(reopened, "agent_observe", "fork-without-old-agents", {
				operation: "search", scope: "direct_children",
			}), { matches: [], hasMore: false });
			assert.deepEqual(await executeTool(reopened, "agent_observe", "fork-without-old-obligations", {
				operation: "obligations",
			}), { requests: [] });
			const resumed = await executeAndCommitRegisteredTool(fork, "workflow_resume", "resume-only-fresh-workflow", {});
			assert.deepEqual(resumed.details, { workflowId: fork.sessionId, outstandingRequests: [] });
			await assertSourceIdentityIsUnavailable(reopened, {
				directChildId: spawn.agentId, sourceRequestId: request.requestMessageId,
			});
			assert.equal(await readFile(sourceFile, "utf8"), sourceBytes);
			assert.equal(await readFile(childStatus.primaryEvidence.transcriptPath, "utf8"), childBytes);
		} finally {
			if (reopened) await reopened.runtime.dispose();
			await source.runtime.dispose();
		}
	});
}

for (const role of ["unidentified", "child"] as const) {
	test(`failed Owner role identification explicitly refuses native fork for ${role} session`, async (t) => {
		const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
		try {
			// Copied Moderator evidence without an Owner Identity cannot establish the
			// current session's role. Failure is not proof that this is an Owner.
			if (role === "unidentified") {
				host.session.sessionManager.appendCustomMessageEntry("agent-coordination.moderator-input", "Copied role evidence", true, {
					agentId: "another-session", workflowId: "another-workflow",
				});
			} else {
				host.session.sessionManager.appendCustomEntry("agent-coordination.identity", {
					agentId: host.session.sessionId, workflowId: "source-workflow",
					directSpawnerAgentId: "source-parent", creationPreset: null,
					spawnSource: { agentId: "source-parent", entryId: "spawn-entry", toolCallId: "spawn-call" },
					metadata: { label: "source-child" },
				});
			}
			const selectedId = host.session.sessionManager.appendMessage({ role: "user", content: "Keep this session", timestamp: Date.now() });
			await bindTestOwnerHost(host, "tui");
			assert.equal(host.session.getActiveToolNames().includes("agent_spawn"), false);
			const sourceEntries = structuredClone(host.session.sessionManager.getEntries());
			assert.deepEqual(await host.runtime.fork(selectedId), { cancelled: true });
			assert.equal(host.runtime.session, host.session);
			assert.deepEqual(host.session.sessionManager.getEntries(), sourceEntries);
			assert.deepEqual(host.ui.notifications.at(-1), {
				message: "Cannot fork this session: safe Workflow Owner identification did not complete. Child Agents and Moderators cannot fork; use native /new for a clean Owner session.",
				type: "error",
			});
		} finally {
			await host.runtime.dispose();
		}
	});
}

async function executeTool(
	host: TestOwnerHost,
	toolName: "agent_spawn" | "agent_message" | "agent_observe" | "agent_control",
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	const result = await executeAndCommitRegisteredTool(
		host.runtime.session,
		toolName,
		toolCallId,
		input,
	);
	return result.details;
}

async function waitForOnlyChild(
	host: TestOwnerHost,
	agentId: string,
): Promise<string> {
	const deadline = Date.now() + OWNER_FORK_WAIT_TIMEOUT_MS;
	let attempt = 0;
	while (Date.now() < deadline) {
		const observe = host.session.getToolDefinition("agent_observe");
		assert.ok(observe);
		const result = await observe.execute(
			`wait-for-nested-child-${attempt}`,
			{ operation: "search", scope: { directSpawnerAgentId: agentId } },
			undefined,
			undefined,
			host.session.extensionRunner.createContext(),
		);
		const matches = (result.details as { matches: Array<{ agentId: string }> }).matches;
		if (matches.length === 1) return matches[0]!.agentId;
		attempt += 1;
		await waitForOwnerForkPoll();
	}
	throw new Error(`Agent ${agentId} did not create one nested child`);
}

async function waitForAgentTranscript(
	host: TestOwnerHost,
	agentId: string,
	expected: string,
): Promise<void> {
	const deadline = Date.now() + OWNER_FORK_WAIT_TIMEOUT_MS;
	let attempt = 0;
	while (Date.now() < deadline) {
		const observe = host.session.getToolDefinition("agent_observe");
		assert.ok(observe);
		const result = await observe.execute(
			`wait-for-agent-transcript-${agentId}-${attempt}`,
			{ operation: "status", agentId },
			undefined,
			undefined,
			host.session.extensionRunner.createContext(),
		);
		const transcriptPath = (result.details as {
			primaryEvidence: { transcriptPath: string | null };
		}).primaryEvidence.transcriptPath;
		if (
			transcriptPath &&
			JSON.stringify(SessionManager.open(transcriptPath).getEntries()).includes(expected)
		) return;
		attempt += 1;
		await waitForOwnerForkPoll();
	}
	throw new Error(`Agent ${agentId} transcript did not include ${expected}`);
}

async function waitForOwnerForkPoll(): Promise<void> {
	await new Promise<void>((resolve) =>
		setTimeout(resolve, OWNER_FORK_POLL_INTERVAL_MS)
	);
}

async function waitForMessageDelivery(
	host: TestOwnerHost,
	targetAgentId: string,
	messageId: string,
): Promise<void> {
	await waitForAgentTranscript(host, targetAgentId, messageId);
	const delivered = await executeTool(
		host,
		"agent_message",
		"poll-delivered-source-request-before-clone",
		{ operation: "poll", messageId },
	) as { disposition: string };
	assert.equal(delivered.disposition, "delivered");
}

async function assertSourceIdentityIsUnavailable(
	host: TestOwnerHost,
	options: { directChildId: string; sourceRequestId: string },
): Promise<void> {
	const cases = [
		{
			tool: "agent_observe" as const,
			input: { operation: "status", agentId: options.directChildId },
		},
		{
			tool: "agent_control" as const,
			input: { operation: "interrupt", agentId: options.directChildId },
		},
		{
			tool: "agent_message" as const,
			input: {
				operation: "send",
				targetAgent: options.directChildId,
				content: "Do not cross the Workflow cutoff.",
			},
		},
		{
			tool: "agent_message" as const,
			input: { operation: "poll", messageId: options.sourceRequestId },
		},
		{
			tool: "agent_message" as const,
			input: { operation: "retry", messageId: options.sourceRequestId },
		},
		{
			tool: "agent_message" as const,
			input: {
				operation: "cancel",
				requestMessageId: options.sourceRequestId,
				reason: "Do not cancel across Workflows.",
			},
		},
	];
	for (const [index, candidate] of cases.entries()) {
		const session = host.runtime.session;
		const toolCallId = `reject-source-identity-${index}`;
		session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(candidate.tool, candidate.input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
		const tool = session.getToolDefinition(candidate.tool);
		assert.ok(tool);
		await assert.rejects(
			() => tool.execute(
				toolCallId,
				candidate.input,
				undefined,
				undefined,
				session.extensionRunner.createContext(),
			),
			/unknown_identity|wrong_workflow|wrong_participant/,
		);
	}
}
