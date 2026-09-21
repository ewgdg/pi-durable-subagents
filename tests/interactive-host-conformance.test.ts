import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import * as hostPi from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import {
	executeAndCommitRegisteredTool,
	openLiveAgentView,
	returnAgentViewToOwner,
} from "./support/agent-session.ts";
import {
	createPiCliTestOwnerHost,
	createTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

const PROCESS_UI_PROBE = fileURLToPath(
	new URL("./fixtures/process-ui-probe-extension.ts", import.meta.url),
);
const LLAMA_MODEL_ID = "local-conformance-model";
const MAX_CONDITION_ATTEMPTS = 1_000;
// Probe evidence can take its full polling window after the child process starts;
// leave room for host setup and teardown instead of racing the test-level timeout.
const INTERACTIVE_HOST_TEST_TIMEOUT_MS = 20_000;

test("child session_start UI side effects stay detached before, during, and after Agent view attachment", {
	timeout: INTERACTIVE_HOST_TEST_TIMEOUT_MS,
}, async (t) => {
	const evidencePath = join(tmpdir(), `.process-ui-probe-${process.pid}-detached.jsonl`);
	const previousEvidencePath = process.env.PROCESS_UI_PROBE_EVIDENCE;
	process.env.PROCESS_UI_PROBE_EVIDENCE = evidencePath;
	t.after(() => restoreEnvironment("PROCESS_UI_PROBE_EVIDENCE", previousEvidencePath));
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		fauxTokensPerSecond: 1,
		additionalExtensionPaths: [PROCESS_UI_PROBE],
	});
	assert.equal(host.ui.notifications.length, 1);
	assert.equal(host.ui.notifications[0]?.message, "startup-notice");
	const ownerEditorFactory = host.ui.getEditorComponent();
	const ownerStatuses = new Map(host.ui.statuses);
	const ownerWidgets = new Map(host.ui.widgets);
	host.model.setResponses([
		fauxAssistantMessage("Remain live while detached UI conformance is checked."),
	]);
	const agentId = await spawnRetainedChild(host, "spawn-detached-ui-agent");
	await waitForProbeEvidence(evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "session_start" && entry.sessionId === agentId && entry.pid !== process.pid,
	));

	assert.equal(host.ui.notifications.length, 1);
	assert.deepEqual(host.ui.statuses, ownerStatuses);
	assert.deepEqual(host.ui.widgets, ownerWidgets);
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);

	const opened = await openLiveAgentView(host, agentId);
	assert.equal(host.runtime.session, host.session);
	assert.equal(host.ui.notifications.length, 1);
	assert.deepEqual(host.ui.statuses, ownerStatuses);
	assert.deepEqual(host.ui.widgets, ownerWidgets);
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);
	await returnAgentViewToOwner(host, opened);

	assert.equal(host.ui.notifications.length, 1);
	assert.deepEqual(host.ui.statuses, ownerStatuses);
	assert.deepEqual(host.ui.widgets, ownerWidgets);
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);
});

test("repeated Agent view attachment does not replay either session startup lifecycle", {
	timeout: INTERACTIVE_HOST_TEST_TIMEOUT_MS,
}, async (t) => {
	const evidencePath = join(tmpdir(), `.process-ui-probe-${process.pid}-repeat.jsonl`);
	const previousEvidencePath = process.env.PROCESS_UI_PROBE_EVIDENCE;
	process.env.PROCESS_UI_PROBE_EVIDENCE = evidencePath;
	t.after(() => restoreEnvironment("PROCESS_UI_PROBE_EVIDENCE", previousEvidencePath));
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		fauxTokensPerSecond: 1,
		additionalExtensionPaths: [PROCESS_UI_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("Remain live through repeated interactive view cycles."),
	]);
	const agentId = await spawnRetainedChild(host, "spawn-view-lifecycle-agent");
	await waitForProbeEvidence(evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "session_start" && entry.sessionId === agentId,
	));

	for (let cycle = 0; cycle < 2; cycle += 1) {
		const opened = await openLiveAgentView(host, agentId);
		await returnAgentViewToOwner(host, opened);
	}

	const starts = (await readProbeEvidence(evidencePath)).filter(
		(entry) => entry.kind === "session_start",
	);
	assert.equal(starts.filter((entry) => entry.sessionId === host.session.sessionId).length, 1);
	assert.equal(starts.filter((entry) => entry.sessionId === agentId).length, 1);
	assert.notEqual(starts.find((entry) => entry.sessionId === agentId)?.pid, process.pid);
	assert.equal(host.runtime.session, host.session);
});

test("exact-Run termination of an open Agent view retains the Runtime and view", {
	timeout: 20_000,
}, async (t) => {
	const evidencePath = join(tmpdir(), `.process-ui-probe-${process.pid}-termination.jsonl`);
	const previousEvidencePath = process.env.PROCESS_UI_PROBE_EVIDENCE;
	process.env.PROCESS_UI_PROBE_EVIDENCE = evidencePath;
	t.after(() => restoreEnvironment("PROCESS_UI_PROBE_EVIDENCE", previousEvidencePath));
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		physicalDisplay: true,
		fauxTokensPerSecond: 1,
		additionalExtensionPaths: [PROCESS_UI_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("Remain live until exact-Run termination."),
		fauxAssistantMessage("Done."),
	]);
	const agentId = await spawnRetainedChild(host, "spawn-view-termination-agent");
	await waitForProbeEvidence(evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "session_start" && entry.sessionId === agentId,
	));
	const ownerSession = host.runtime.session;
	const opened = await openLiveAgentView(host, agentId);
	const agentSessionStarts = async () => (await readProbeEvidence(evidencePath)).filter(
		(entry) => entry.kind === "session_start" && entry.sessionId === agentId,
	);
	const startsBefore = await agentSessionStarts();
	assert.equal(startsBefore.length, 1);
	const childPid = startsBefore[0]!.pid;

	await waitForAsyncCondition(async () => (await agentRunStatus(host, agentId)).phase === "live");
	const terminated = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-viewed-run",
		{ operation: "terminate", agentId },
	);
	assert.equal((terminated.details as { disposition: string }).disposition, "terminated");
	assert.equal(host.runtime.session, ownerSession);
	// The retained Runtime keeps the open view attached while the Agent becomes Dormant.
	const retainedStatus = await agentRunStatus(host, agentId);
	assert.equal(retainedStatus.phase, "dormant");
	assert.equal((await agentSessionStarts()).length, 1);
	assert.doesNotThrow(() => process.kill(childPid, 0));

	// Editor input through the still-open view admits a successor in the retained Runtime.
	opened.view.handleInput?.("Continue in the retained Runtime.");
	opened.view.handleInput?.("\r");
	await waitForAsyncCondition(async () => (await agentRunStatus(host, agentId)).phase === "live");
	assert.equal((await agentSessionStarts()).length, 1);
	assert.doesNotThrow(() => process.kill(childPid, 0));
	// The successor inherits the unanswered creation-request obligation and settles live.
	await waitForAsyncCondition(async () => {
		const run = await agentRunStatus(host, agentId);
		return run.phase === "live" && run.work === "settled";
	});
	assert.equal((await agentSessionStarts()).length, 1);
	assert.doesNotThrow(() => process.kill(childPid, 0));

	await returnAgentViewToOwner(host, opened);
	assert.equal(host.runtime.session, ownerSession);
	await host.runtime.dispose();
});

test("a third-party child-view command remains unique and does not interfere with Agent startup", {
	timeout: INTERACTIVE_HOST_TEST_TIMEOUT_MS,
}, async (t) => {
	const evidencePath = join(tmpdir(), `.process-ui-probe-${process.pid}-command.jsonl`);
	const previousEvidencePath = process.env.PROCESS_UI_PROBE_EVIDENCE;
	process.env.PROCESS_UI_PROBE_EVIDENCE = evidencePath;
	t.after(() => restoreEnvironment("PROCESS_UI_PROBE_EVIDENCE", previousEvidencePath));
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		fauxTokensPerSecond: 1,
		additionalExtensionPaths: [PROCESS_UI_PROBE],
	});
	const commands = host.session.extensionRunner.getRegisteredCommands()
		.filter(({ name }) => name === "child-view");
	assert.equal(commands.length, 1);
	assert.equal(host.session.extensionRunner.getCommand("child-view:1"), undefined);
	host.model.setResponses([
		fauxAssistantMessage("The child starts without a command collision."),
	]);
	const agentId = await spawnRetainedChild(host, "spawn-command-collision-agent");
	await waitForProbeEvidence(evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "session_start" && entry.sessionId === agentId,
	));
	const starts = (await readProbeEvidence(evidencePath)).filter(
		(entry) => entry.kind === "session_start",
	);
	assert.equal(starts.find((entry) => entry.sessionId === host.session.sessionId)?.childViewCommandCount, 1);
	assert.equal(starts.find((entry) => entry.sessionId === agentId)?.childViewCommandCount, 1);
	assert.equal(
		host.ui.notifications.some(({ message }) => message.includes("child-view")),
		false,
	);
	await commands[0]?.handler("", host.session.extensionRunner.createCommandContext());
	await waitForProbeEvidence(evidencePath, (entries) => entries.some(
		(entry) => entry.kind === "command" && entry.sessionId === host.session.sessionId,
	));

});

test("the named llama.cpp extension remains usable through child startup and shutdown on the Owner ModelRuntime", {
	timeout: INTERACTIVE_HOST_TEST_TIMEOUT_MS,
}, async (t) => {
	const router = await startMockLlamaRouter();
	const previousBaseUrl = process.env.LLAMA_BASE_URL;
	const previousApiKey = process.env.LLAMA_API_KEY;
	process.env.LLAMA_BASE_URL = router.baseUrl;
	process.env.LLAMA_API_KEY = "local-conformance-key";
	hostPi.initTheme();
	const host = await createPiCliTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		fauxTokensPerSecond: 1,
	});
	try {
		const ownerSession = host.runtime.session;
		const sharedModelRuntime = host.services.modelRuntime;
		assert.ok(sharedModelRuntime.getProvider("llama.cpp"));
		await refreshLlamaCatalogThroughCommand(host, host.session);
		await assertLlamaInference(sharedModelRuntime, "before child startup");
		host.model.setResponses([
			fauxAssistantMessage("Remain live while llama.cpp conformance is checked."),
		]);
		const agentId = await spawnRetainedChild(host, "spawn-llama-agent");
		assert.equal(host.runtime.session, ownerSession);
		assert.equal(host.runtime.services.modelRuntime, sharedModelRuntime);
		assert.ok(sharedModelRuntime.getModel("llama.cpp", LLAMA_MODEL_ID));
		await assertLlamaInference(sharedModelRuntime, "after child startup");

		await executeAndCommitRegisteredTool(
			host.session,
			"agent_control",
			"terminate-llama-child",
			{ operation: "terminate", agentId },
		);
		assert.equal(host.runtime.session, ownerSession);
		assert.ok(sharedModelRuntime.getProvider("llama.cpp"));
		await assertLlamaInference(sharedModelRuntime, "after child shutdown");
	} finally {
		if (previousBaseUrl === undefined) delete process.env.LLAMA_BASE_URL;
		else process.env.LLAMA_BASE_URL = previousBaseUrl;
		if (previousApiKey === undefined) delete process.env.LLAMA_API_KEY;
		else process.env.LLAMA_API_KEY = previousApiKey;
		await host.runtime.dispose();
		await router.close();
	}
});

async function spawnRetainedChild(
	host: TestOwnerHost,
	toolCallId: string,
): Promise<string> {
	const result = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		toolCallId,
		{ title: "Fixture request", request: "Remain live for interactive host conformance." },
	);
	assert.deepEqual(
		{
			spawnStatus: (result.details as { spawnStatus: string }).spawnStatus,
			messageStatus: (result.details as { messageStatus: string }).messageStatus,
		},
		{ spawnStatus: "created", messageStatus: "sent" },
	);
	return (result.details as { agentId: string }).agentId;
}

async function refreshLlamaCatalogThroughCommand(
	host: TestOwnerHost,
	session: hostPi.AgentSession,
): Promise<void> {
	const prompt = session.prompt("/llama");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	const surface = host.ui.customSurfaces[0];
	assert.ok(surface?.handleInput);
	try {
		await waitForCondition(() =>
			surface.render(120).some((line) => line.includes(LLAMA_MODEL_ID))
		);
	} catch {
		throw new Error(
			`llama.cpp catalog did not render:\n${surface.render(120).join("\n")}\n` +
			`notifications: ${JSON.stringify(host.ui.notifications)}`,
		);
	}
	surface.handleInput("\x1b");
	await prompt;
}

async function assertLlamaInference(
	modelRuntime: hostPi.ModelRuntime,
	prompt: string,
): Promise<void> {
	const model = modelRuntime.getModel("llama.cpp", LLAMA_MODEL_ID);
	assert.ok(model);
	const response = await modelRuntime.completeSimple(model, {
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	});
	assert.equal(response.stopReason, "stop");
	assert.deepEqual(response.content, [{ type: "text", text: "llama conformance response" }]);
}

async function startMockLlamaRouter(): Promise<{
	baseUrl: string;
	close(): Promise<void>;
}> {
	let completionSequence = 0;
	const server = createServer((request, response) => {
		request.resume();
		if (request.url?.startsWith("/props")) {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ models_autoload: false }));
			return;
		}
		if (request.url === "/models") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({
				data: [{
					id: LLAMA_MODEL_ID,
					status: { value: "loaded" },
					meta: { n_ctx: 8_192 },
					architecture: { input_modalities: ["text"] },
				}],
			}));
			return;
		}
		if (request.url === "/v1/chat/completions") {
			completionSequence += 1;
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.write(`data: ${JSON.stringify({
				id: `llama-conformance-${completionSequence}`,
				model: LLAMA_MODEL_ID,
				choices: [{
					index: 0,
					delta: { role: "assistant", content: "llama conformance response" },
					finish_reason: null,
				}],
			})}\n\n`);
			response.write(`data: ${JSON.stringify({
				id: `llama-conformance-${completionSequence}`,
				model: LLAMA_MODEL_ID,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			})}\n\n`);
			response.end("data: [DONE]\n\n");
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_ATTEMPTS; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected conformance condition did not become true");
}

async function waitForAsyncCondition(predicate: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_ATTEMPTS; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected conformance condition did not become true");
}

type ObservedAgentRun = Readonly<{
	phase: string;
	work?: string;
	retentionReasons: readonly Readonly<{ reason: string }>[];
}>;

async function agentRunStatus(
	host: TestOwnerHost,
	agentId: string,
): Promise<ObservedAgentRun> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		`observe-terminated-view-${Date.now()}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return (status.details as { run: ObservedAgentRun }).run;
}

type ProcessUiProbeEvidence = Readonly<{
	kind: string;
	sessionId: string;
	pid: number;
	reason?: string;
	childViewCommandCount?: number;
}>;

async function readProbeEvidence(path: string): Promise<ProcessUiProbeEvidence[]> {
	try {
		return (await readFile(path, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ProcessUiProbeEvidence);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function waitForProbeEvidence(
	path: string,
	predicate: (entries: readonly ProcessUiProbeEvidence[]) => boolean,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (predicate(await readProbeEvidence(path))) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected child process UI evidence did not become durable");
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
