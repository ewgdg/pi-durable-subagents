import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { PiChildProcessRuntime } from "../src/process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../src/process-runtime/remote-participant-control.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { attachNativeChildDisplay, nativeChildDisplayText } from "./support/native-child-display.ts";
import {
	STARTUP_GUIDANCE,
	STARTUP_PROBE_ENVIRONMENT,
	STARTUP_TOOL,
	STARTUP_TOOL_RESULT,
} from "./fixtures/idle-custom-startup-extension.ts";

const TEST_TIMEOUT_MS = 20_000;
const OPERATION_TIMEOUT_MS = 5_000;
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/idle-custom-startup-extension.ts", import.meta.url));

// Child Delivery and reminder startup semantics live on the Child Control loopback
// (child-idle-custom-startup). This smoke keeps what only a real child proves:
// an inherited extension's input preflight and tool guidance inside the launched
// process, the wire receipt, and the native renderer for the retained custom type.
test("real process child prepares its first idle message through an inherited extension", {
	timeout: TEST_TIMEOUT_MS, skip: process.platform === "win32",
}, async t => {
	const child = await startChild(t);
	const source = { agentId: "startup-sender", entryId: "startup-message", toolCallId: "send-message" };
	const messageId = deriveMessageIdentity(source);
	const content = "Prepared message wake";
	const message = createMessageDelivery([{
		source,
		projection: { kind: "message", messageId, fromAgentId: source.agentId, content },
	}]);
	const deliveryId = "startup-message";
	const receipt = await bounded(child.runtime.channel.request("message.deliver", {
		deliveryId,
		delivery: {
			kind: "custom",
			message: { ...message, details: { messages: [...message.details.messages] } },
			triggerTurn: true,
		},
	}));
	assert.equal(receipt.accepted, true);
	assert.equal(receipt.transcriptCommitted, true);
	assert.equal(receipt.modelCycleStarted, true);
	assert.equal(receipt.queuedInputCount, 0);
	await waitUntil(() => child.completed.has(deliveryId));
	assert.equal(child.completed.get(deliveryId), undefined);
	const committed = SessionManager.open(child.sessionPath).getEntries().filter(entry =>
		entry.type === "custom_message" && entry.content === message.content);
	assert.equal(committed.length, 1, "the original Message must have one canonical Delivery");
	await assertPreparedTurn(child);
	await attachNativeChildDisplay(child.runtime);
	await waitUntil(async () => {
		await child.runtime.drain();
		return nativeChildDisplayText(child.runtime).includes(content);
	}).catch(error => { throw new Error(`${error.message}\n${nativeChildDisplayText(child.runtime)}`); });
	assert.doesNotMatch(nativeChildDisplayText(child.runtime), /agent-coordination\.message-delivery/,
		"the retained custom type still uses its registered native renderer");
	assert.equal(child.humanInputs(), 0, "empty extension kickoffs must not create Human Requests");
});

async function startChild(t: TestContext) {
	const host = await createTestOwnerHost(t, () => {}, {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
	});
	const broker = host.services.resourceLoader.getExtensions().extensions.find(extension =>
		extension.resolvedPath.endsWith("process-model-broker-extension.mjs"));
	assert.ok(broker);
	const contexts: Context[] = [];
	host.model.setResponses(Array.from({ length: 2 }, (_, call) => context => {
		contexts.push(context);
		return call % 2 === 0
			? fauxAssistantMessage(fauxToolCall(STARTUP_TOOL, {}, { id: `startup-probe-${call}` }), { stopReason: "toolUse" })
			: fauxAssistantMessage("Prepared startup completed.");
	}));
	const root = await mkdtemp(join(tmpdir(), "pi-idle-custom-startup-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	const sessionPath = join(root, "child.jsonl");
	const probePath = join(root, "preparation.jsonl");
	const agentId = "019a6b4d-1b22-7000-8000-000000000139";
	const timestamp = new Date().toISOString();
	await writeFile(sessionPath, [
		{ type: "session", version: 3, id: agentId, timestamp, cwd },
		{
			type: "custom", id: "startup-identity", parentId: null, timestamp,
			customType: AGENT_IDENTITY_CUSTOM_TYPE,
			data: {
				agentId, workflowId: "startup-workflow", directSpawnerAgentId: "startup-workflow",
				spawnSource: { agentId: "startup-workflow", entryId: "spawn-entry", toolCallId: "spawn-call" },
				creationPreset: null, metadata: { label: "Startup Child" },
			},
		},
	].map(entry => JSON.stringify(entry) + "\n").join(""));
	await writeFile(probePath, "");
	let humanInputs = 0;
	const runtime = await PiChildProcessRuntime.start({
		workflowId: "startup-workflow", agentId, role: "ordinary", expectedSessionId: agentId,
		sessionPath, agentDir, runtimeDirectory: root,
		configuration: {
			cwd, model: { provider: "coordination-test", modelId: "deterministic-owner" },
			thinking: "off", excludeTools: [], skills: [], loadContextFiles: false,
			excludeSkills: [],
			extensions: [broker.resolvedPath, FIXTURE_PATH],
		},
		skillPaths: [], projectTrusted: true,
		ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1", [STARTUP_PROBE_ENVIRONMENT]: probePath },
		ownerRequestHandlers: ownerHandlers(agentId, sessionPath, () => { humanInputs++; }),
		columns: 110, rows: 35,
	});
	host.deferCleanup(() => runtime.dispose());
	const completed = new Map<string, string | undefined>();
	runtime.onEvent(event => {
		if (event.event === "message.dispatch.completed") completed.set(event.payload.deliveryId, event.payload.error);
	});
	return { runtime, sessionPath, probePath, contexts, completed, humanInputs: () => humanInputs };
}

async function assertPreparedTurn(child: Awaited<ReturnType<typeof startChild>>) {
	assert.equal(child.contexts.length, 2, "the idle start executes one registered tool and its continuation");
	for (const context of child.contexts) {
		assert.ok(getCurrentTools(context.messages).some(tool => tool.name === STARTUP_TOOL));
		assert.ok(getCurrentSystemPrompt(context.messages).includes(STARTUP_GUIDANCE), "idle custom Runs must receive before-start tool guidance, including after the tool result");
		assert.ok(getCurrentSystemPrompt(context.messages).includes("Startup input 1; preparation 1."));
	}
	const toolResult = child.contexts.at(-1)?.messages.findLast(message => message.role === "toolResult");
	assert.ok(toolResult?.role === "toolResult");
	assert.equal(toolResult.isError, false);
	assert.match(JSON.stringify(toolResult.content), new RegExp(STARTUP_TOOL_RESULT));
	const probe = (await readFile(child.probePath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
	assert.deepEqual(probe, [
		{ phase: "input", text: "", source: "extension" },
		{ phase: "prepare", inputs: 1, preparations: 1 },
		{ phase: "tool" },
	]);
}

function ownerHandlers(agentId: string, sessionPath: string, humanInput: () => void): OwnerParticipantRequestHandlers<"ordinary"> {
	const unused = async (): Promise<never> => { throw new Error("Unexpected coordination call in startup fixture"); };
	const status = {
		agentId, workflowId: "startup-workflow", label: "Startup Child", directSpawnerAgentId: "startup-workflow",
		primaryEvidence: { transcriptPath: sessionPath, inspectedThrough: { agentId, entryId: "initial-entry" } },
		run: {
			phase: "live" as const, work: "settled" as const, attention: "none" as const,
			retentionReasons: [{ reason: "interactive_selection" as const, count: 1 }],
		},
		model: { provider: "coordination-test", modelId: "deterministic-owner" },
		thinking: "off" as const, compacting: false, queuedInputCount: 0,
	};
	return {
		presentation: {
			setReportRead: unused, select: unused,
			snapshot: async () => ({ live: [status], dormant: [], selectedAgentId: agentId, humanAttention: [], operationalAttention: [], reports: [] }),
		},
		lifecycle: {
			executionStarted: async () => [],
			humanInputSubmitted: async () => { humanInput(); return "continue"; },
			primaryInputQueued: async () => {}, humanInputMode: async () => "agent",
			toolResultCommitting: async () => undefined, rootToolExecutionStarted: async () => {},
			safeBoundaryReached: async () => {}, executionEnded: async () => {},
		},
		coordination: {
			agentTemplateSnapshot: async () => ({ templates: [] }), observe: unused, message: unused, wait: unused,
			control: unused, spawn: unused, askUser: unused,
		},
	};
}

async function waitUntil(condition: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + OPERATION_TIMEOUT_MS;
	while (!await condition()) {
		if (Date.now() >= deadline) throw new Error("Idle custom startup condition did not settle within 5s");
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

function bounded<T>(operation: Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Idle custom startup operation exceeded 5s")), OPERATION_TIMEOUT_MS);
		operation.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}
