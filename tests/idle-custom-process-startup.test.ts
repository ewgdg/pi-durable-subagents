import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { PiChildProcessRuntime } from "../src/process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../src/process-runtime/remote-participant-control.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE, MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
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

for (const kind of ["message", "request"] as const) {
	test(`real process child prepares its first idle ${kind} and subsequent settled wake through a tool round trip`, {
		timeout: TEST_TIMEOUT_MS, skip: process.platform === "win32",
	}, async t => {
		const child = await startChild(t);
		for (const turn of [1, 2]) {
			const source = { agentId: "startup-sender", entryId: `startup-${kind}-${turn}`, toolCallId: `send-${kind}-${turn}` };
			const messageId = deriveMessageIdentity(source);
			const content = `Prepared ${kind} wake ${turn}`;
			const message = createMessageDelivery([{
				source,
				projection: kind === "message"
					? { kind, messageId, fromAgentId: source.agentId, content }
					: { kind, requestMessageId: messageId, fromAgentId: source.agentId, title: content, question: content },
			}]);
			const deliveryId = `startup-${kind}-${turn}`;
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
			const entries = SessionManager.open(child.sessionPath).getEntries();
			const committed = entries.filter(entry => entry.type === "custom_message" && entry.content === message.content);
			assert.equal(committed.length, 1, "the original Message must have one canonical Delivery");
			const entry = committed[0];
			assert.ok(entry?.type === "custom_message");
			assert.deepEqual({ customType: entry.customType, content: entry.content, display: entry.display, details: entry.details }, message);
			assert.match(JSON.stringify(entry.content), new RegExp(messageId));
			await assertPreparedTurn(child, turn);
			const kickoffs = entries.filter(candidate => candidate.type === "message" && candidate.message.role === "user");
			assert.equal(kickoffs.length, turn, "each idle Run commits exactly one empty kickoff");
			assert.ok(entries.indexOf(kickoffs.at(-1)!) < entries.indexOf(entry), "the empty kickoff precedes canonical Delivery");
		}
		await attachNativeChildDisplay(child.runtime);
		await waitUntil(async () => {
			await child.runtime.drain();
			return nativeChildDisplayText(child.runtime).includes(`Prepared ${kind} wake 2`);
		}).catch(error => { throw new Error(`${error.message}\n${nativeChildDisplayText(child.runtime)}`); });
		assert.doesNotMatch(nativeChildDisplayText(child.runtime), /agent-coordination\.message-delivery/,
			"the retained custom type still uses its registered native renderer");
		assert.equal(child.humanInputs(), 0, "empty extension kickoffs must not create Human Requests");
	});
}

test("real process child prepares the separate Moderator reminder startup on first and settled Runs", {
	timeout: TEST_TIMEOUT_MS, skip: process.platform === "win32",
}, async t => {
	const child = await startChild(t);
	for (const turn of [1, 2]) {
		const reservationId = `prepared-reminder-${turn}`;
		assert.deepEqual(await bounded(child.runtime.channel.request("moderatorReminder.prepare", { reservationId })), { prepared: true });
		assert.deepEqual(await bounded(child.runtime.channel.request("moderatorReminder.finish", { reservationId, commit: true })), { outcome: "committed" });
		await waitUntil(() => child.settled() === turn);
		const reminders = SessionManager.open(child.sessionPath).getEntries().filter(entry =>
			entry.type === "custom_message" && entry.customType === MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE);
		assert.equal(reminders.length, turn, "each admitted reminder commits exactly once");
		await assertPreparedTurn(child, turn);
	}
	assert.equal(child.humanInputs(), 0);
});

async function startChild(t: TestContext) {
	const host = await createTestOwnerHost(t, () => {}, {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
	});
	const broker = host.services.resourceLoader.getExtensions().extensions.find(extension =>
		extension.resolvedPath.endsWith("process-model-broker-extension.mjs"));
	assert.ok(broker);
	const contexts: Context[] = [];
	host.model.setResponses(Array.from({ length: 4 }, (_, call) => context => {
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
	let settled = 0;
	runtime.onEvent(event => {
		if (event.event === "message.dispatch.completed") completed.set(event.payload.deliveryId, event.payload.error);
		if (event.event === "agent.settled") settled++;
	});
	return { runtime, sessionPath, probePath, contexts, completed, humanInputs: () => humanInputs, settled: () => settled };
}

async function assertPreparedTurn(child: Awaited<ReturnType<typeof startChild>>, turn: number) {
	assert.equal(child.contexts.length, turn * 2, "each idle start executes one registered tool and its continuation");
	for (const context of child.contexts.slice((turn - 1) * 2)) {
		assert.ok(context.tools?.some(tool => tool.name === STARTUP_TOOL));
		assert.ok(context.systemPrompt?.includes(STARTUP_GUIDANCE), "idle custom Runs must receive before-start tool guidance, including after the tool result");
		assert.ok(context.systemPrompt?.includes(`Startup input ${turn}; preparation ${turn}.`));
	}
	const toolResult = child.contexts.at(-1)?.messages.findLast(message => message.role === "toolResult");
	assert.ok(toolResult?.role === "toolResult");
	assert.equal(toolResult.isError, false);
	assert.match(JSON.stringify(toolResult.content), new RegExp(STARTUP_TOOL_RESULT));
	const probe = (await readFile(child.probePath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
	assert.deepEqual(probe.filter(event => event.phase === "input"),
		Array.from({ length: turn }, () => ({ phase: "input", text: "", source: "extension" })));
	assert.deepEqual(probe.filter(event => event.phase === "prepare"),
		Array.from({ length: turn }, (_, index) => ({ phase: "prepare", inputs: index + 1, preparations: index + 1 })));
	assert.equal(probe.filter(event => event.phase === "tool").length, turn);
	const kickoffs = SessionManager.open(child.sessionPath).getEntries().filter(entry =>
		entry.type === "message" && entry.message.role === "user");
	assert.equal(kickoffs.length, turn);
	for (const entry of kickoffs) {
		assert.ok(entry.type === "message" && entry.message.role === "user");
		const content = entry.message.content;
		assert.equal(typeof content === "string" ? content : content.map(part => part.type === "text" ? part.text : "image").join(""), "");
	}
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
			toolResultCommitting: async () => undefined, toolExecutionStarted: async () => {},
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
