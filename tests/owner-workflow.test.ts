import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	AgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { openLiveAgentView } from "./support/agent-session.ts";

const MAX_SESSION_DISCOVERY_ATTEMPTS = 1_000;

test("coordination preserves user-controlled Pi recovery settings", async (t) => {
	const settings = {
		compaction: { enabled: true },
		transport: "auto" as const,
		retry: {
			enabled: true,
			maxRetries: 4,
			provider: { maxRetries: 5 },
		},
	};
	const host = await createTestOwnerHost(t, piAgentCoordination, { settings });
	try {
		assert.equal(host.services.settingsManager.getCompactionEnabled(), true);
		assert.equal(host.services.settingsManager.getRetrySettings().enabled, true);
		assert.equal(host.services.settingsManager.getRetrySettings().maxRetries, 4);
		assert.equal(host.services.settingsManager.getProviderRetrySettings().maxRetries, 5);
		assert.equal(host.services.settingsManager.getTransport(), "auto");
		assert.equal(host.session.agent.transport, "auto");
	} finally {
		await host.runtime.dispose();
	}
});

test("interactive Pi boots one observable Owner while preserving native interaction and disposal", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination);
	const ownerIdentity = host.session.sessionManager
		.getEntries()
		.find(
			(entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity",
		);
	assert.ok(ownerIdentity && ownerIdentity.type === "custom");
	assert.deepEqual(ownerIdentity.data, {
		agentId: host.session.sessionId,
		workflowId: host.session.sessionId,
		directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" },
	});

	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	assert.equal(host.session.getToolDefinition("ask_user"), undefined);
	const statusResult = await observe.execute(
		"observe-owner",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(statusResult.details, {
		agentId: host.session.sessionId,
		workflowId: host.session.sessionId,
		label: "Owner",
		description: "Workflow Owner",
		directSpawnerAgentId: null,
		primaryEvidence: {
			transcriptPath: null,
			inspectedThrough: {
				agentId: host.session.sessionId,
				entryId: ownerIdentity.id,
			},
		},
		run: {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [
				{ reason: "owner_host_binding", count: 1 },
			],
		},
	});

	const agentsCommand = host.session.prompt("/agents");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(host.ui.genericSelectCalls, []);
	assert.equal(host.ui.customSurfaces.length, 1);
	const agentsSurface = host.ui.customSurfaces[0]!;
	const renderedAgents = agentsSurface.render(100);
	assert.match(renderedAgents[0] ?? "", /^┌─+┐$/);
	assert.match(renderedAgents.join("\n"), /Live.*Dormant/);
	assert.match(renderedAgents.join("\n"), /Owner/);
	assert.match(renderedAgents.join("\n"), /o Owner · Tab views/);
	agentsSurface.handleInput?.("\x1b");
	await agentsCommand;

	await host.session.prompt("Keep native Pi behavior authoritative.");
	await host.session.waitForIdle();
	assert.equal(
		host.session.messages.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some(
					(part) => part.type === "text" && part.text === "Owner interaction preserved.",
				),
		),
		true,
	);

	const originalDispose = host.session.dispose.bind(host.session);
	let disposeCalls = 0;
	host.session.dispose = () => {
		disposeCalls += 1;
		originalDispose();
	};
	await host.runtime.dispose();
	assert.equal(disposeCalls, 1);
});

test("native Owner replacement closes every retained source Workflow process", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	host.model.setResponses([
		fauxAssistantMessage("Remain retained until the Owner replaces its native session."),
	]);
	const spawnInput = { title: "Fixture request", request: "Remain retained for native replacement." };
	const spawnToolCallId = "spawn-before-native-owner-replacement";
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

	await host.runtime.newSession();
	await waitForNoRuntimeArtifacts(host.session.sessionId);
	assert.ok(host.runtime.session.getToolDefinition("agent_spawn"));
	const observe = host.runtime.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	await assert.rejects(
		() => observe.execute(
			"observe-replaced-workflow-child",
			{ operation: "status", agentId: childAgentId },
			undefined,
			undefined,
			host.runtime.session.extensionRunner.createContext(),
		),
		/unknown_identity/,
	);
	await host.runtime.dispose();
});

test("shutdown with an open Agent view closes it without rebinding stopped interactive UI", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
	});
	host.model.setResponses([
		fauxAssistantMessage("Remain retained while shutdown begins from this selection."),
	]);
	const spawnInput = { title: "Fixture request", request: "Remain retained for selected-child shutdown." };
	const spawnToolCallId = "spawn-before-selected-child-shutdown";
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
	const opened = await openLiveAgentView(host, childAgentId);

	let shutdownRebindCalls = 0;
	host.runtime.setRebindSession(async () => {
		shutdownRebindCalls += 1;
	});

	await host.runtime.dispose();
	await opened.command;

	assert.equal(shutdownRebindCalls, 0);
	assert.equal(host.runtime.session, host.session);
	assert.equal(host.ui.customSurfaces.length, 0);
});

test("orderly shutdown disposes retained child and Moderator processes plus Owner session", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
		processVisibleModel: true,
	});
	host.model.setResponses([
		fauxAssistantMessage("I settled while still owing the Creation Answer."),
		fauxAssistantMessage("I remain retained as the active Moderator."),
	]);
	const spawnInput = { title: "Fixture request", request: "Remain answer-obligated for shutdown proof." };
	const spawnToolCallId = "spawn-before-complete-shutdown";
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
	const moderatorAgentId = await waitForModeratorAgentId(host);
	const disposalCounts = new Map([
		[childAgentId, 0],
		[moderatorAgentId, 0],
		[host.session.sessionId, 0],
	]);
	const nativeDispose = AgentSession.prototype.dispose;
	AgentSession.prototype.dispose = function countWorkflowDisposal() {
		if (disposalCounts.has(this.sessionId)) {
			disposalCounts.set(
				this.sessionId,
				(disposalCounts.get(this.sessionId) ?? 0) + 1,
			);
		}
		return nativeDispose.call(this);
	};
	try {
		await host.runtime.dispose();
		assert.equal(host.runtime.session.sessionId, host.session.sessionId);
		assert.deepEqual(
			Object.fromEntries(disposalCounts),
			{
				[childAgentId]: 0,
				[moderatorAgentId]: 0,
				[host.session.sessionId]: 1,
			},
		);
		await waitForNoRuntimeArtifacts(host.session.sessionId);
	} finally {
		AgentSession.prototype.dispose = nativeDispose;
	}
});

test("child AgentSession patches cannot affect process shutdown or Owner disposal", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	host.model.setResponses([
		fauxAssistantMessage("Remain retained for exhaustive shutdown cleanup."),
	]);
	const spawnInput = { title: "Fixture request", request: "Remain retained for exhaustive shutdown cleanup." };
	const spawnToolCallId = "spawn-before-failing-shutdown";
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
	const nativeAbort = AgentSession.prototype.abort;
	const nativeDispose = AgentSession.prototype.dispose;
	let childDisposeCalls = 0;
	AgentSession.prototype.abort = async function failChildAbort() {
		if (this.sessionId === childAgentId) {
			throw new Error("injected child abort failure");
		}
		return nativeAbort.call(this);
	};
	AgentSession.prototype.dispose = function countFailedChildDisposal() {
		if (this.sessionId === childAgentId) childDisposeCalls += 1;
		return nativeDispose.call(this);
	};
	const nativeOwnerDispose = host.session.dispose.bind(host.session);
	let ownerDisposeCalls = 0;
	host.session.dispose = () => {
		ownerDisposeCalls += 1;
		nativeOwnerDispose();
	};

	try {
		await host.runtime.dispose();
		assert.equal(childDisposeCalls, 0);
		assert.equal(ownerDisposeCalls, 1);
		await waitForNoRuntimeArtifacts(host.session.sessionId);
	} finally {
		AgentSession.prototype.abort = nativeAbort;
		AgentSession.prototype.dispose = nativeDispose;
	}
});

async function waitForModeratorAgentId(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): Promise<string> {
	const workflowDirectory = `${host.session.sessionManager.getSessionDir()}/pi-durable-subagents/${Buffer.from(
		host.session.sessionId,
		"utf8",
	).toString("base64url")}`;
	for (let attempt = 0; attempt < MAX_SESSION_DISCOVERY_ATTEMPTS; attempt += 1) {
		const sessions = await SessionManager.list(host.cwd, workflowDirectory);
		const moderator = sessions.find(({ path }) =>
			SessionManager.open(path).getEntries().some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "agent-coordination.moderator-input",
			)
		);
		if (moderator) return moderator.id;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected retained Moderator session was not created");
}

async function waitForNoRuntimeArtifacts(workflowId: string): Promise<void> {
	const prefix = `pi-ac-${createHash("sha256").update(workflowId).digest("hex").slice(0, 10)}-`;
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		if (!(await readdir(tmpdir())).some((name) => name.startsWith(prefix))) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Process Runtime artifacts survived Workflow shutdown");
}
