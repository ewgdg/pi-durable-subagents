import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import xtermHeadless from "@xterm/headless";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { attachNativeChildDisplay, nativeChildDisplayText } from "./support/native-child-display.ts";

import type { ControlEvent } from "../src/control/agent-control-channel.ts";
import { agentControlProtocol } from "../src/control/agent-control-protocol.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createAdmittedPiChildProcessProjection } from "../src/process-runtime/admitted-pi-child-process-projection.ts";
import { assertSelectedTools, PiChildProcessRuntime } from "../src/process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../src/process-runtime/remote-participant-control.ts";
import type { AgentObserveInput } from "../src/tools/participant-coordination-tools.ts";
import {
	PROCESS_RUNTIME_TEST_MODEL,
	PROCESS_RUNTIME_TEST_PROVIDER,
	PROCESS_RUNTIME_TEST_RESPONSE,
	PROCESS_RUNTIME_TEST_WORKING_ZONE_MODEL,
} from "./fixtures/process-runtime-child-extension.ts";

const TEST_TIMEOUT_MS = 30_000;
const CHILD_EXTENSION = fileURLToPath(
	new URL("./fixtures/process-runtime-child-extension.ts", import.meta.url),
);

test("real Pi CLI resolves unset Moderator thinking from the shared Pi default", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-moderator-default-thinking-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const sessionId = "019a6b4d-1b22-7000-8000-000000000000";
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(cwd, { recursive: true }),
		mkdir(sessionDirectory, { recursive: true }),
	]);
	await writeFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultThinkingLevel: "low" })}\n`,
	);
	const sessionPath = join(sessionDirectory, "moderator.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });

	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "moderator-default-thinking-workflow",
			agentId: sessionId,
			role: "moderator",
			expectedSessionId: sessionId,
			sessionPath,
			configuration: {
				cwd,
				model: {
					provider: PROCESS_RUNTIME_TEST_PROVIDER,
					modelId: PROCESS_RUNTIME_TEST_WORKING_ZONE_MODEL,
				},
				tools: [],
				skills: [],
				extensions: [CHILD_EXTENSION],
				loadContextFiles: true,
			},
			skillPaths: [],
			projectTrusted: true,
			agentDir,
			ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			runtimeDirectory: root,
		});
		assert.equal(runtime.snapshot.thinking, "low");
	} finally {
		await runtime?.dispose();
	}
});

test("real Pi CLI runs one exact TUI session through the process Runtime Bridge", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-runtime-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000001";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });

	const lifecycle: string[] = [];
	const ownerIntentions: unknown[] = [];
	const ownerSelections: unknown[] = [];
	const runtimeEvents: ControlEvent<typeof agentControlProtocol>[] = [];
	let runtime: PiChildProcessRuntime | undefined;
	let projection: ReturnType<typeof createAdmittedPiChildProcessProjection> | undefined;
	let systemPromptArtifactPath: string | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-runtime-test-workflow",
			agentId: "process-runtime-test-agent",
			role: "ordinary",
			expectedSessionId,
			sessionPath,
			configuration: {
				cwd,
				model: {
					provider: PROCESS_RUNTIME_TEST_PROVIDER,
					modelId: PROCESS_RUNTIME_TEST_MODEL,
				},
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [CHILD_EXTENSION],
				systemPrompt: { mode: "append", body: "Runtime-owned child context" },
				loadContextFiles: true,
			},
			skillPaths: [],
			projectTrusted: true,
			ownerEnvironment: {
				...process.env,
				PI_SKIP_VERSION_CHECK: "1",
				PROCESS_RUNTIME_RESPONSE_DELAY_MS: "1000",
				HERDR_ENV: "owned",
				HERDR_SOCKET_PATH: "/tmp/owner-herdr.sock",
				HERDR_PANE_ID: "owner-pane",
			},
			runtimeDirectory: root,
			columns: 80,
			rows: 24,
			ownerRequestHandlers: ordinaryOwnerHandlers({
				executionStarted: () => ownerIntentions.push({
					agentId: "process-runtime-test-agent",
					intention: "executionStarted",
				}),
				selectorSnapshot: processSelectorSnapshot(expectedSessionId),
				select: (action) => ownerSelections.push(action),
			}),
		});
		projection = createAdmittedPiChildProcessProjection(runtime);
		systemPromptArtifactPath = runtime.snapshot.systemPrompt?.filePath;
		assert.equal(systemPromptArtifactPath, join(dirname(runtime.bootstrapPath), "system-prompt.md"));
		assert.equal((await stat(systemPromptArtifactPath)).mode & 0o777, 0o600);
		let projectionChanges = 0;
		let projectionExits = 0;
		const projectionFailures: unknown[] = [];
		projection.addChangeHandler(() => projectionChanges += 1);
		projection.addExitRequestHandler(() => projectionExits += 1);
		projection.addFailureHandler((error) => projectionFailures.push(error));
		runtime.onEvent((event: ControlEvent<typeof agentControlProtocol>) => {
			runtimeEvents.push(event);
			if (["agent.start", "agent.end", "agent.settled", "session.shutdown"].includes(event.event)) {
				lifecycle.push(event.event);
			}
		});

		assert.notEqual(runtime.pid, process.pid);
		assert.deepEqual(runtime.ready, {
			sessionId: expectedSessionId,
			mode: "tui",
			hasUI: true,
		});
		assert.deepEqual(runtime.snapshot, {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: [],
			skills: [],
			skillSources: [],
			extensions: [CHILD_EXTENSION],
			toolExecutionModes: [],
			projectTrusted: true,
			sessionId: expectedSessionId,
			sessionPath,
			systemPrompt: {
				mode: "append",
				filePath: systemPromptArtifactPath,
				body: "Runtime-owned child context",
			},
			loadContextFiles: true,
		});
		assert.equal((await stat(runtime.bootstrapPath)).mode & 0o777, 0o600);

		await waitForFrame(runtime, "PROCESS_RUNTIME_CHILD_WIDGET");
		const initialChildFrame = frameText(runtime);
		assert.match(initialChildFrame, /PROCESS_RUNTIME_CHILD_WIDGET/);
		assert.match(initialChildFrame, /Process Child.*[0-9a-f]{8}.*idle/);
		assert.match(frameText(runtime), /HERDR_ENV=undefined/);
		assert.match(frameText(runtime), /HERDR_SOCKET_PATH=undefined/);
		assert.match(frameText(runtime), /HERDR_PANE_ID=undefined/);

		projection.dispatchInput("/agents\r");
		await waitForFrame(runtime, "Tab views");
		projection.dispatchInput("\r");
		await waitUntil(() => ownerSelections.length === 1);
		assert.deepEqual(ownerSelections[0], {
			kind: "select_agent",
			agentId: expectedSessionId,
		});
		await waitUntil(async () => {
			await runtime?.drain();
			return !frameText(runtime as PiChildProcessRuntime).includes("Tab views");
		});
		projection.dispatchInput("/agents owner\r");
		await waitUntil(() => ownerSelections.length === 2);
		assert.deepEqual(ownerSelections[1], {
			kind: "select_agent",
			agentId: "process-runtime-test-workflow",
		});
		await waitUntil(async () => {
			await runtime?.drain();
			return !frameText(runtime as PiChildProcessRuntime).includes("Tab views");
		});

		projection.dispatchInput("/agents\r");
		await waitForFrame(runtime, "Tab views");
		projection.dispatchInput("o");
		await waitUntil(() => ownerSelections.length === 3);
		assert.deepEqual(ownerSelections[2], {
			kind: "select_agent",
			agentId: "process-runtime-test-workflow",
		});
		await waitUntil(async () => {
			await runtime?.drain();
			return !frameText(runtime as PiChildProcessRuntime).includes("Tab views");
		});

		assert.equal((await runtime.channel.request("message.deliver", {
			deliveryId: "process-runtime-test-run",
			delivery: { kind: "user", content: "Complete the offline process Runtime Bridge test." },
		})).accepted, true);
		await waitUntil(() => lifecycle.includes("agent.settled"));
		assert.deepEqual(lifecycle.slice(0, 3), ["agent.start", "agent.end", "agent.settled"]);
		assert.deepEqual(ownerIntentions[0], {
			agentId: "process-runtime-test-agent",
			intention: "executionStarted",
		});
		assert.match(JSON.stringify(SessionManager.open(sessionPath).getEntries()), new RegExp(PROCESS_RUNTIME_TEST_RESPONSE));
		assert.deepEqual(await runtime.channel.request("queue.clear", {
			runId: latestCycleId(runtimeEvents),
		}), { steering: [], followUp: [], queuedInputCount: 0 });
		assert.deepEqual(await runtime.channel.request("run.interrupt", {
			runId: latestCycleId(runtimeEvents),
		}), { accepted: false });
		await assert.rejects(
			runtime.channel.request("queue.clear", { runId: "stale-process-runtime-run" }),
			/stale_run/,
		);
		await assert.rejects(
			runtime.channel.request("run.interrupt", { runId: "stale-process-runtime-run" }),
			/stale_run/,
		);

		const lifecycleBeforeDelivery = lifecycle.length;
		const previousCycleId = latestCycleId(runtimeEvents);
		const activeDelivery = runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-1",
			delivery: {
				kind: "user",
				content: "Commit before the delayed model turn settles.",
			},
		});
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "agent.start" &&
			event.payload.runId !== previousCycleId
		));
		assert.equal(runtimeEvents.some((event) =>
			event.event === "agent.settled" &&
			event.payload.runId !== previousCycleId
		), false);
		const queuedDelivery = runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-2",
			delivery: {
				kind: "user",
				content: "Clear this queued direction before it commits.",
				deliverAs: "steer",
			},
		});
		const clearedDelivery = runtime.channel.request("queue.clear", {
			runId: latestCycleId(runtimeEvents),
		});
		const interruptedDelivery = runtime.channel.request("run.interrupt", {
			runId: latestCycleId(runtimeEvents),
		});
		const activeDeliveryResult = await activeDelivery;
		assert.equal(activeDeliveryResult.accepted, true);
		assert.equal(activeDeliveryResult.transcriptCommitted, true);
		assert.equal(activeDeliveryResult.modelCycleStarted, true);
		assert.equal(
			lifecycle.slice(lifecycleBeforeDelivery).includes("agent.settled"),
			false,
		);
		assert.deepEqual(await clearedDelivery, {
			steering: ["Clear this queued direction before it commits."],
			followUp: [],
			queuedInputCount: 0,
		});
		assert.deepEqual(await interruptedDelivery, { accepted: true });
		assert.deepEqual(await queuedDelivery, {
			accepted: true,
			transcriptCommitted: false,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		await waitUntil(() => lifecycle.filter((event) => event === "agent.settled").length === 2);
		assert.equal(runtimeEvents.some((event) =>
			event.event === "agent.end" &&
			event.payload.runId !== previousCycleId &&
			event.payload.outcome === "interrupted" &&
			event.payload.willRetry === false
		), true);

		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-3",
			delivery: {
				kind: "user",
				content: "Start work before the queued Control request is cancelled.",
			},
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		const cancellation = new AbortController();
		const cancelledDelivery = runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-4",
			delivery: {
				kind: "user",
				content: "This cancelled queued direction must never commit.",
				deliverAs: "steer",
			},
		}, cancellation.signal);
		await new Promise((resolve) => setTimeout(resolve, 20));
		cancellation.abort();
		await assert.rejects(cancelledDelivery, (error: unknown) =>
			error instanceof Error && error.name === "AbortError"
		);
		await waitUntil(() => lifecycle.filter((event) => event === "agent.settled").length === 3);
		assert.doesNotMatch(
			JSON.stringify(SessionManager.open(sessionPath).getEntries()),
			/This cancelled queued direction must never commit/,
		);

		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-5",
			delivery: {
				kind: "user",
				content: "PROCESS_RUNTIME_DROP_MESSAGE_COMMIT",
			},
		}), {
			accepted: true,
			transcriptCommitted: false,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		await waitUntil(() => lifecycle.filter((event) => event === "agent.settled").length === 4);
		assert.doesNotMatch(
			JSON.stringify(SessionManager.open(sessionPath).getEntries()),
			/PROCESS_RUNTIME_DROP_MESSAGE_COMMIT/,
		);

		projection.resize(100, 30);
		projection.dispatchInput("/runtime-probe OWNER_INPUT_OK\r");
		await waitForFrame(runtime, "INPUT=OWNER_INPUT_OK");
		assert.equal(projectionChanges, 0);
		assert.match(frameText(runtime), /SIZE=100x30/);
		assert.equal(runtime.dimensions().columns, 100);
		assert.equal(runtime.dimensions().rows, 30);

		const pid = runtime.pid;
		const bootstrapPath = runtime.bootstrapPath;
		const exit = await runtime.shutdown("test complete");
		assert.deepEqual(exit, { exitCode: 0, signal: 0 });
		await waitUntil(() => lifecycle.includes("session.shutdown"));
		await waitUntil(() => projectionExits === 1);
		assert.deepEqual(projectionFailures, []);
		assert.throws(() => process.kill(pid, 0), hasProcessCode("ESRCH"));
		await assert.rejects(lstat(bootstrapPath), hasFsCode("ENOENT"));
		await assert.rejects(lstat(systemPromptArtifactPath), hasFsCode("ENOENT"));
	} finally {
		await projection?.dispose();
		await runtime?.dispose();
	}
});

test("an idle prepared Request creates a working zone before exact Delivery commitment", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-working-zone-test-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000083";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		compaction: {
			enabled: true,
			reserveTokens: 16_000,
			keepRecentTokens: 1_000,
		},
	}));
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	const seededSession = SessionManager.open(sessionPath);
	for (const section of ["Earlier", "Later"]) {
		seededSession.appendMessage({
			role: "user",
			content: [{
				type: "text",
				text: `${section} acquired context.${" relevant history".repeat(15_000)}`,
			}],
			timestamp: Date.now(),
		});
	}

	let runtime: PiChildProcessRuntime | undefined;
	const runtimeEvents: ControlEvent<typeof agentControlProtocol>[] = [];
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-working-zone-workflow",
			agentId: "process-working-zone-agent",
			role: "ordinary",
			expectedSessionId,
			sessionPath,
			agentDir,
			configuration: {
				cwd,
				model: {
					provider: PROCESS_RUNTIME_TEST_PROVIDER,
					modelId: PROCESS_RUNTIME_TEST_WORKING_ZONE_MODEL,
				},
				thinking: "high",
				tools: [],
				skills: [],
				extensions: [CHILD_EXTENSION],
				loadContextFiles: true,
			},
			skillPaths: [],
			projectTrusted: true,
			ownerEnvironment: {
				...process.env,
				PI_SKIP_VERSION_CHECK: "1",
				PROCESS_RUNTIME_RESPONSE_DELAY_MS: "300",
				PROCESS_RUNTIME_WORKING_ZONE_COMPACTION: "extension",
				PROCESS_RUNTIME_WORKING_ZONE_DELAY_MS: "200",
			},
			runtimeDirectory: root,
			ownerRequestHandlers: ordinaryOwnerHandlers({
				selectorSnapshot: processSelectorSnapshot("process-working-zone-agent"),
			}),
		});
		runtime.onEvent((event) => runtimeEvents.push(event));

		const omittedItem = {
			source: {
				agentId: "working-zone-requester",
				entryId: "omitted-request-entry",
				toolCallId: "omitted-request-call",
			},
			projection: {
				title: "Fixture request",
				kind: "request" as const,
				requestMessageId: "omitted-request-call",
				fromAgentId: "working-zone-requester",
				question: "Use ordinary compaction behavior for this Request.",
			},
		};
		const omittedMessage = createMessageDelivery([omittedItem]);
		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-6",
			delivery: {
				kind: "custom",
				message: {
					...omittedMessage,
					details: { messages: [...omittedMessage.details.messages] },
				},
				triggerTurn: true,
			},
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "agent.start"
		));
		const activeSteerItem = {
			source: {
				agentId: "working-zone-requester",
				entryId: "active-steer-entry",
				toolCallId: "active-steer-call",
			},
			projection: {
				title: "Fixture request",
				kind: "request" as const,
				requestMessageId: "active-steer-call",
				fromAgentId: "working-zone-requester",
				question: "Preserve active Steer ordering without proactive preparation.",
			},
		};
		const activeSteerMessage = createMessageDelivery([activeSteerItem]);
		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-7",
			delivery: {
				kind: "custom",
				message: {
					...activeSteerMessage,
					details: { messages: [...activeSteerMessage.details.messages] },
				},
				triggerTurn: true,
				deliverAs: "steer",
				workingZonePreparation: {
					intent: { workScale: "large", contextDependence: "low" },
					prospectiveRequest: activeSteerItem.projection,
				},
			},
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		assert.equal(runtimeEvents.some((event) =>
			event.event === "runtime.compaction.started"
		), false);
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "message.dispatch.completed" &&
			event.payload.deliveryId === "test-delivery-7"
		));
		assert.equal(
			SessionManager.open(sessionPath).getEntries()
				.some((entry) => entry.type === "compaction"),
			false,
		);

		const declinedCompactionItem = {
			source: {
				agentId: "working-zone-requester",
				entryId: "declined-compaction-entry",
				toolCallId: "declined-compaction-call",
			},
			projection: {
				title: "Fixture request",
				kind: "request" as const,
				requestMessageId: "declined-compaction-call",
				fromAgentId: "working-zone-requester",
				question: "DECLINE_COMPACTION should continue Delivery without a preparation warning.",
			},
		};
		const declinedCompactionMessage = createMessageDelivery([declinedCompactionItem]);
		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-8",
			delivery: {
				kind: "custom",
				message: {
					...declinedCompactionMessage,
					details: { messages: [...declinedCompactionMessage.details.messages] },
				},
				triggerTurn: true,
				workingZonePreparation: {
					intent: { workScale: "large", contextDependence: "low" },
					prospectiveRequest: declinedCompactionItem.projection,
				},
			},
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "message.dispatch.completed" &&
			event.payload.deliveryId === "test-delivery-8"
		));
		assert.equal(SessionManager.open(sessionPath).getEntries().some((entry) =>
			entry.type === "custom_message" &&
			entry.content === declinedCompactionMessage.content
		), true);
		assert.doesNotMatch(JSON.stringify(SessionManager.open(sessionPath).getEntries()), /Working-Zone Preparation failed/);

		const cancelledItem = {
			source: {
				agentId: "working-zone-requester",
				entryId: "cancelled-preparation-entry",
				toolCallId: "cancelled-preparation-call",
			},
			projection: {
				title: "Fixture request",
				kind: "request" as const,
				requestMessageId: "cancelled-preparation-call",
				fromAgentId: "working-zone-requester",
				question: "Cancel this exact Request while its working zone is preparing.",
			},
		};
		const cancelledMessage = createMessageDelivery([cancelledItem]);
		const compactionStartsBeforeCancellation = runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length;
		const compactionCompletionsBeforeCancellation = runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.completed"
		).length;
		const cancellation = new AbortController();
		const cancelledDelivery = runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-9",
			delivery: {
				kind: "custom",
				message: {
					...cancelledMessage,
					details: { messages: [...cancelledMessage.details.messages] },
				},
				triggerTurn: true,
				workingZonePreparation: {
					intent: { workScale: "large", contextDependence: "low" },
					prospectiveRequest: cancelledItem.projection,
				},
			},
		}, cancellation.signal);
		await waitUntil(() => runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length > compactionStartsBeforeCancellation);
		cancellation.abort();
		await assert.rejects(cancelledDelivery, (error: unknown) =>
			error instanceof Error && error.name === "AbortError"
		);
		await waitUntil(() => runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.completed"
		).length > compactionCompletionsBeforeCancellation);
		assert.equal(SessionManager.open(sessionPath).getEntries().some((entry) =>
			entry.type === "custom_message" && entry.content === cancelledMessage.content
		), false);

		const preparedItem = {
			source: {
				agentId: "working-zone-requester",
				entryId: "prepared-request-entry",
				toolCallId: "prepared-request-call",
			},
			projection: {
				title: "Fixture request",
				kind: "request" as const,
				requestMessageId: "prepared-request-call",
				fromAgentId: "working-zone-requester",
				question: "Use the previously acquired relevant history to finish issue 83.",
			},
		};
		const preparedMessage = createMessageDelivery([preparedItem]);
		const compactionStartsBeforePreparedRequest = runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length;
		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-10",
			delivery: {
				kind: "custom",
				message: {
					...preparedMessage,
					details: { messages: [...preparedMessage.details.messages] },
				},
				triggerTurn: true,
				workingZonePreparation: {
					intent: { workScale: "large", contextDependence: "low" },
					prospectiveRequest: preparedItem.projection,
				},
			},
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});

		assert.equal(runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length, compactionStartsBeforePreparedRequest + 1);
		const entries = SessionManager.open(sessionPath).getEntries();
		const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
		const preparedDeliveryIndex = entries.findIndex((entry) =>
			entry.type === "custom_message" && entry.content === preparedMessage.content
		);
		assert.notEqual(compactionIndex, -1);
		assert.notEqual(preparedDeliveryIndex, -1);
		assert.equal(compactionIndex < preparedDeliveryIndex, true);
		const compaction = entries[compactionIndex];
		assert.ok(compaction?.type === "compaction");
		assert.equal(compaction.summary, "Extension-provided working-zone compaction summary.");
		const instructions = (compaction.details as { customInstructions?: string } | undefined)
			?.customInstructions;
		assert.match(instructions ?? "", /previously acquired relevant history/);
		assert.match(instructions ?? "", /has not committed to this transcript/);
		assert.match(instructions ?? "", /Do not include or paraphrase it/);
		assert.doesNotMatch(compaction.summary, /previously acquired relevant history/);
	} finally {
		await runtime?.shutdown("working-zone test complete");
		await runtime?.dispose();
	}
});

test("an idle child defers threshold compaction until later work is admitted", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-compaction-gateway-test-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000020";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		compaction: {
			enabled: true,
			reserveTokens: 16_000,
			keepRecentTokens: 1,
		},
	}));
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	let runtime: PiChildProcessRuntime | undefined;
	const runtimeEvents: ControlEvent<typeof agentControlProtocol>[] = [];
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-compaction-gateway-workflow",
			agentId: "process-compaction-gateway-agent",
			role: "ordinary",
			expectedSessionId,
			sessionPath,
			agentDir,
			configuration: {
				cwd,
				model: {
					provider: PROCESS_RUNTIME_TEST_PROVIDER,
					modelId: PROCESS_RUNTIME_TEST_MODEL,
				},
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [CHILD_EXTENSION],
				loadContextFiles: true,
			},
			skillPaths: [],
			projectTrusted: true,
			ownerEnvironment: {
				...process.env,
				PI_SKIP_VERSION_CHECK: "1",
				PROCESS_RUNTIME_RESPONSE_DELAY_MS: "100",
			},
			runtimeDirectory: root,
			ownerRequestHandlers: ordinaryOwnerHandlers({
				selectorSnapshot: processSelectorSnapshot("process-compaction-gateway-agent"),
			}),
		});
		runtime.onEvent((event) => runtimeEvents.push(event));

		assert.equal((await runtime.channel.request("message.deliver", {
			deliveryId: "process-compaction-gateway-run",
			delivery: { kind: "user", content: "Create enough history to make threshold compaction eligible." },
		})).accepted, true);
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "message.dispatch.completed" &&
			event.payload.deliveryId === "process-compaction-gateway-run"
		));

		assert.equal(
			SessionManager.open(sessionPath).getEntries().some((entry) => entry.type === "compaction"),
			false,
		);

		const nextPrompt = "Admit this prompt only after preparing the existing context.";
		assert.equal((await runtime.channel.request("message.deliver", {
			deliveryId: "process-compaction-next-prompt-run",
			delivery: { kind: "user", content: nextPrompt },
		})).accepted, true);
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "message.dispatch.completed" &&
			event.payload.deliveryId === "process-compaction-next-prompt-run"
		));
		const entriesAfterPrompt = SessionManager.open(sessionPath).getEntries();
		const promptCompactionIndex = entriesAfterPrompt.findIndex((entry) =>
			entry.type === "compaction"
		);
		const nextPromptIndex = entriesAfterPrompt.findIndex((entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			JSON.stringify(entry.message.content).includes(nextPrompt)
		);
		assert.notEqual(promptCompactionIndex, -1);
		assert.equal(promptCompactionIndex < nextPromptIndex, true);

		const customMessage = createMessageDelivery([{
			source: {
				agentId: "compaction-gateway-sender",
				entryId: "compaction-gateway-source-entry",
				toolCallId: "compaction-gateway-source-call",
			},
			projection: {
				kind: "message",
				messageId: "compaction-gateway-source-call",
				fromAgentId: "compaction-gateway-sender",
				content: "Commit this exact Delivery after deferred compaction.",
			},
		}]);
		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-11",
			delivery: {
				kind: "custom",
				message: {
					...customMessage,
					details: { messages: [...customMessage.details.messages] },
				},
				triggerTurn: true,
			},
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		const entriesAfterDelivery = SessionManager.open(sessionPath).getEntries();
		const compactionIndex = entriesAfterDelivery.findIndex((entry) =>
			entry.type === "compaction"
		);
		const deliveryIndex = entriesAfterDelivery.findIndex((entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery"
		);
		assert.notEqual(compactionIndex, -1);
		assert.equal(compactionIndex < deliveryIndex, true);
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "message.dispatch.completed" &&
			event.payload.deliveryId === "test-delivery-11"
		));
		const compactionsBeforeNativeInput = SessionManager.open(sessionPath).getEntries()
			.filter((entry) => entry.type === "compaction").length;

		const eventsBeforeNativeInput = runtimeEvents.length;
		const nativeInput = "Admit this native input after deferred compaction.";
		await attachNativeChildDisplay(runtime);
		runtime.writeInput(`${nativeInput}\r`);
		await waitUntil(() => runtimeEvents.slice(eventsBeforeNativeInput).some(event => event.event === "agent.settled"));
		const entriesAfterNativeInput = SessionManager.open(sessionPath).getEntries();
		const nativeInputIndex = entriesAfterNativeInput.findIndex((entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			JSON.stringify(entry.message.content).includes(nativeInput)
		);
		const nativeCompactionIndex = entriesAfterNativeInput.findLastIndex((entry, index) =>
			index < nativeInputIndex && entry.type === "compaction"
		);
		assert.notEqual(nativeInputIndex, -1);
		assert.notEqual(nativeCompactionIndex, -1);
		assert.equal(nativeCompactionIndex < nativeInputIndex, true);
		assert.equal(
			entriesAfterNativeInput.filter((entry) => entry.type === "compaction").length,
			compactionsBeforeNativeInput + 1,
		);

		const activeInput = `PROCESS_RUNTIME_QUEUE_AFTER_AGENT_END${
			" queued context".repeat(400)
		}`;
		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-12",
			delivery: { kind: "user", content: activeInput },
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "message.dispatch.completed" && event.payload.deliveryId === "test-delivery-12"
		));
		const entriesAfterQueuedContinuation = SessionManager.open(sessionPath).getEntries();
		const activeInputIndex = entriesAfterQueuedContinuation.findIndex((entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			JSON.stringify(entry.message.content).includes("PROCESS_RUNTIME_QUEUE_AFTER_AGENT_END")
		);
		const queuedDeliveryIndex = entriesAfterQueuedContinuation.findIndex((entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.queued-compaction-test"
		);
		assert.equal(entriesAfterQueuedContinuation.some((entry, index) =>
			entry.type === "compaction" &&
			index > activeInputIndex &&
			index < queuedDeliveryIndex
		), true);

		await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-13",
			delivery: {
				kind: "user",
				content: `Leave a large deferred context.${" padding context".repeat(400)}`,
			},
		});
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "message.dispatch.completed" && event.payload.deliveryId === "test-delivery-13"
		));

		const cancelledMessage = createMessageDelivery([{
			source: {
				agentId: "cancelled-compaction-sender",
				entryId: "cancelled-compaction-source-entry",
				toolCallId: "cancelled-compaction-source-call",
			},
			projection: {
				kind: "message",
				messageId: "cancelled-compaction-source-call",
				fromAgentId: "cancelled-compaction-sender",
				content: "This Delivery must not survive cancelled preparation.",
			},
		}]);
		const compactionStartsBeforeCancellation = runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length;
		const compactionCompletionsBeforeCancellation = runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.completed"
		).length;
		const cancellation = new AbortController();
		const cancelledDelivery = runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-14",
			delivery: {
				kind: "custom",
				message: {
					...cancelledMessage,
					details: { messages: [...cancelledMessage.details.messages] },
				},
				triggerTurn: true,
			},
		}, cancellation.signal);
		await waitUntil(() => runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length > compactionStartsBeforeCancellation);
		cancellation.abort();
		await assert.rejects(cancelledDelivery, (error: unknown) =>
			error instanceof Error && error.name === "AbortError"
		);
		await waitUntil(() => runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.completed"
		).length > compactionCompletionsBeforeCancellation);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(SessionManager.open(sessionPath).getEntries().some((entry) =>
			entry.type === "custom_message" && entry.content === cancelledMessage.content
		), false);

		const interruptedMessage = createMessageDelivery([{
			source: {
				agentId: "interrupted-compaction-sender",
				entryId: "interrupted-compaction-source-entry",
				toolCallId: "interrupted-compaction-source-call",
			},
			projection: {
				kind: "message",
				messageId: "interrupted-compaction-source-call",
				fromAgentId: "interrupted-compaction-sender",
				content: "Interruption must fence this Delivery during preparation.",
			},
		}]);
		const failuresBeforeInterruption = runtimeEvents.filter(event => event.event === "agent.end" && event.payload.outcome === "failed").length;
		const compactionStartsBeforeInterruption = runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length;
		const interruptedDelivery = runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-15",
			delivery: {
				kind: "custom",
				message: {
					...interruptedMessage,
					details: { messages: [...interruptedMessage.details.messages] },
				},
				triggerTurn: true,
			},
		});
		const interruptedDeliveryOutcome = interruptedDelivery.then(
			() => undefined,
			(error: unknown) => error,
		);
		await waitUntil(() => runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length > compactionStartsBeforeInterruption);
		assert.deepEqual(await runtime.channel.request("message.cancel", {
			deliveryId: "test-delivery-15",
		}), { accepted: true });
		assert.match(String(await interruptedDeliveryOutcome), /child_turn_admission_cancelled/);
		assert.equal(runtimeEvents.filter(event => event.event === "agent.end" && event.payload.outcome === "failed").length, failuresBeforeInterruption);
		assert.equal(SessionManager.open(sessionPath).getEntries().some((entry) =>
			entry.type === "custom_message" && entry.content === interruptedMessage.content
		), false);

		const nonTurnMessage = createMessageDelivery([{
			source: {
				agentId: "non-turn-sender",
				entryId: "non-turn-source-entry",
				toolCallId: "non-turn-source-call",
			},
			projection: {
				kind: "message",
				messageId: "non-turn-source-call",
				fromAgentId: "non-turn-sender",
				content: "Commit without starting or aborting model work.",
			},
		}]);
		const compactionStartsBeforeNonTurnDelivery = runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length;
		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-16",
			delivery: {
				kind: "custom",
				message: {
					...nonTurnMessage,
					details: { messages: [...nonTurnMessage.details.messages] },
				},
				triggerTurn: false,
			},
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: false,
			queuedInputCount: 0,
		});
		assert.equal(runtimeEvents.filter((event) =>
			event.event === "runtime.compaction.started"
		).length, compactionStartsBeforeNonTurnDelivery);

		const userDeliveryInput = "Prepare deferred context before this idle user Delivery.";
		const entriesBeforeUserDelivery = SessionManager.open(sessionPath).getEntries();
		const compactionsBeforeUserDelivery = entriesBeforeUserDelivery
			.filter((entry) => entry.type === "compaction").length;
		assert.deepEqual(await runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-17",
			delivery: { kind: "user", content: userDeliveryInput },
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		const entriesAfterUserDelivery = SessionManager.open(sessionPath).getEntries();
		const userDeliveryIndex = entriesAfterUserDelivery.findIndex((entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			JSON.stringify(entry.message.content).includes(userDeliveryInput)
		);
		assert.equal(
			entriesAfterUserDelivery.filter((entry) => entry.type === "compaction").length,
			compactionsBeforeUserDelivery + 1,
		);
		assert.equal(entriesAfterUserDelivery.some((entry, index) =>
			entry.type === "compaction" &&
			index >= entriesBeforeUserDelivery.length &&
			index < userDeliveryIndex
		), true);
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "message.dispatch.completed" &&
			event.payload.deliveryId === "test-delivery-17"
		));

		const startsBeforePreflight = runtimeEvents.filter(event => event.event === "agent.start").length;
		const delayedDelivery = runtime.channel.request("message.deliver", {
			deliveryId: "test-delivery-18",
			delivery: { kind: "user", content: "PROCESS_RUNTIME_DELAYED_INPUT" },
		});
		const delayedDeliveryOutcome = delayedDelivery.then(
			() => undefined,
			(error: unknown) => error,
		);
		await waitForFrame(runtime, "PROCESS_RUNTIME_DELAYED_INPUT_STARTED");
		assert.deepEqual(await runtime.channel.request("message.cancel", {
			deliveryId: "test-delivery-18",
		}), { accepted: true });
		assert.match(String(await delayedDeliveryOutcome), /child_turn_admission_cancelled/);
		await new Promise((resolve) => setTimeout(resolve, 550));
		assert.equal(SessionManager.open(sessionPath).getEntries().some((entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			JSON.stringify(entry.message.content).includes("PROCESS_RUNTIME_DELAYED_INPUT")
		), false);
		assert.equal(runtimeEvents.filter(event => event.event === "agent.start").length, startsBeforePreflight);
	} finally {
		await runtime?.dispose();
	}
});

test("startup tool admission compares sets and preserves execution-mode validation", () => {
	const snapshot = (tools: string[]) => ({
		tools,
		toolExecutionModes: tools.map((name) => ({ name, executionMode: "parallel" as const })),
	});
	assert.doesNotThrow(() => assertSelectedTools(snapshot([]), []));
	assert.doesNotThrow(() => assertSelectedTools(snapshot(["read", "agent_message"]), ["agent_message", "read"]));
	for (const [selected, active, missing, unexpected] of [
		[["read"], [], ["read"], []],
		[[], ["read"], [], ["read"]],
		[["read"], ["extra"], ["read"], ["extra"]],
	] as const) {
		assert.throws(() => assertSelectedTools(snapshot([...active]), selected), {
			message: `child_runtime_tools_mismatch: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(unexpected)}`,
		});
	}
	assert.throws(() => assertSelectedTools({ tools: ["read"], toolExecutionModes: [] }, ["read"]), /child_runtime_tool_modes_mismatch/);
});

for (const selection of ["reordered", "missing", "unexpected", "unavailable"] as const) {
	test(`startup checks exact initial tools: ${selection}`, {
		timeout: TEST_TIMEOUT_MS,
		skip: process.platform === "win32",
	}, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-child-selected-tools-test-"));
		const cwd = join(root, "work");
		const sessionDirectory = join(root, "sessions");
		const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000010";
		await mkdir(cwd, { recursive: true });
		await mkdir(sessionDirectory, { recursive: true });
		const sessionPath = join(sessionDirectory, "child.jsonl");
		await writeFile(sessionPath, `${JSON.stringify({
			type: "session",
			version: 3,
			id: expectedSessionId,
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`, { mode: 0o600 });
		const tools = [
			"read",
			"agent_message",
			"agent_control",
			"agent_observe",
			"agent_spawn",
			"ask_user",
			...(selection === "unavailable" ? ["unavailable_selected_tool"] : []),
		] as const;
		let runtime: PiChildProcessRuntime | undefined;
		try {
			const startup = PiChildProcessRuntime.start({
				workflowId: "process-selected-tools-workflow",
				agentId: "process-selected-tools-agent",
				role: "ordinary",
				expectedSessionId,
				sessionPath,
				configuration: {
					cwd,
					model: {
						provider: PROCESS_RUNTIME_TEST_PROVIDER,
						modelId: PROCESS_RUNTIME_TEST_MODEL,
					},
					thinking: "off",
					tools,
					skills: [],
					extensions: [CHILD_EXTENSION],
					loadContextFiles: true,
				},
				skillPaths: [],
				projectTrusted: true,
				ownerEnvironment: {
					...process.env,
					PI_SKIP_VERSION_CHECK: "1",
					PROCESS_RUNTIME_INITIAL_TOOLS: JSON.stringify([
						...tools.filter((name) => name !== "read"),
						...(selection === "missing" ? [] : ["read"]),
						...(selection === "unexpected" ? ["runtime_sequential_probe"] : []),
					]),
					// Yield in the inherited session_start handler before changing tools.
					PROCESS_RUNTIME_STARTUP_DELAY_MS: "250",
					PROCESS_RUNTIME_ACTIVATED_TOOL: "1",
					PROCESS_RUNTIME_INITIAL_TOOLS_PROBE: join(root, "initial-tools.jsonl"),
				},
				runtimeDirectory: root,
				ownerRequestHandlers: ordinaryOwnerHandlers({
					selectorSnapshot: processSelectorSnapshot(expectedSessionId),
				}),
			});
			if (selection !== "reordered") {
				const missing = selection === "missing" ? ["read"]
					: selection === "unavailable" ? ["unavailable_selected_tool"] : [];
				const unexpected = selection === "unexpected" ? ["runtime_sequential_probe"] : [];
				await assert.rejects(startup.then((admitted) => { runtime = admitted; return admitted; }), (error: unknown) => {
					assert.ok(error instanceof Error);
					assert.ok(error.message.includes(`child_runtime_tools_mismatch: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(unexpected)}`), error.message);
					return true;
				});
				return;
			}
			runtime = await startup;
			assert.deepEqual(JSON.parse(await readFile(join(root, "initial-tools.jsonl"), "utf8")), tools);
			assert.deepEqual(runtime.snapshot.tools, [
				"agent_message",
				"agent_control",
				"agent_observe",
				"agent_spawn",
				"ask_user",
				"read",
			]);
			await attachNativeChildDisplay(runtime);
			runtime.writeInput("/runtime-state\r");
			await waitForFrame(runtime, "PROCESS_RUNTIME_STATE_CHANGED");
			assert.deepEqual((await runtime.channel.request("runtime.snapshot", {})).tools, []);
			runtime.writeInput("/runtime-activate\r");
			await waitForFrame(runtime, "PROCESS_RUNTIME_TOOL_ACTIVATED");
			const activatedSnapshot = await runtime.channel.request("runtime.snapshot", {});
			assert.deepEqual(activatedSnapshot.tools, ["runtime_sequential_probe"]);
			assert.deepEqual(activatedSnapshot.toolExecutionModes, [{ name: "runtime_sequential_probe", executionMode: "sequential" }]);
			await runtime.channel.request("message.deliver", {
				deliveryId: "activate-new-tool",
				delivery: { kind: "user", content: "Call the newly activated probe." },
			});
			await waitUntil(() => SessionManager.open(sessionPath).getEntries().some(entry =>
				entry.type === "message" && entry.message.role === "toolResult" &&
				entry.message.toolName === "runtime_sequential_probe" && !entry.message.isError
			));
		} finally {
			await runtime?.dispose();
		}
	});
}

test("a pre-ready child fault rejects launch readiness without escaping startup cleanup", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-startup-fault-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000006";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	const launch = await PiChildProcessRuntime.launch({
		workflowId: "process-startup-fault-workflow",
		agentId: "process-startup-fault-agent",
		role: "ordinary",
		expectedSessionId,
		sessionPath,
		configuration: {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: [],
			skills: [],
			extensions: [CHILD_EXTENSION],
			loadContextFiles: true,
		},
		skillPaths: [],
		projectTrusted: true,
		ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
		runtimeDirectory: root,
		ownerRequestHandlers: ordinaryOwnerHandlers({
			presentationSnapshotError: new Error("Owner presentation snapshot failed"),
		}),
	});
	const pid = launch.pid;
	const bootstrapPath = launch.bootstrapPath;
	try {
		await assert.rejects(
			launch.ready(),
			/child_runtime_fault: runtime_startup_failed: request_failed: Owner presentation snapshot failed/,
		);
		assert.equal(launch.disposed, true);
		assert.throws(() => process.kill(pid, 0), hasProcessCode("ESRCH"));
		await assert.rejects(lstat(bootstrapPath), hasFsCode("ENOENT"));
	} finally {
		await launch.dispose();
	}
});

test("inherited child input preflights run before coordination consumes transformed input", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-input-order-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000007";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	const submittedInputs: string[] = [];
	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-input-order-workflow",
			agentId: "process-input-order-agent",
			role: "ordinary",
			expectedSessionId,
			sessionPath,
			configuration: {
				cwd,
				model: {
					provider: PROCESS_RUNTIME_TEST_PROVIDER,
					modelId: PROCESS_RUNTIME_TEST_MODEL,
				},
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [CHILD_EXTENSION],
				loadContextFiles: true,
			},
			skillPaths: [],
			projectTrusted: true,
			ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			runtimeDirectory: root,
			ownerRequestHandlers: ordinaryOwnerHandlers({
				selectorSnapshot: processSelectorSnapshot("process-input-order-agent"),
				humanInputSubmitted: (text) => {
					submittedInputs.push(text);
					return true;
				},
			}),
		});
		await attachNativeChildDisplay(runtime);
		runtime.writeInput("PROCESS_RUNTIME_HANDLED_INPUT\r");
		await waitForFrame(runtime, "PROCESS_RUNTIME_INPUT_HANDLED");
		assert.deepEqual(submittedInputs, []);
		runtime.writeInput("PROCESS_RUNTIME_TRANSFORM_INPUT\r");
		await waitUntil(() => submittedInputs.length === 1);
		assert.deepEqual(submittedInputs, ["PROCESS_RUNTIME_TRANSFORMED_INPUT"]);
	} finally {
		await runtime?.dispose();
	}
});

test("startup snapshot binds selected skills and file-backed launch inputs exactly", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-snapshot-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const skillDirectory = join(root, "skills", "review");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000004";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	await mkdir(skillDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	const skillPath = join(skillDirectory, "SKILL.md");
	const systemPromptBody = "Explicit process system prompt.";
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	await writeFile(skillPath, [
		"---",
		"name: review",
		"description: Review exact process state.",
		"---",
		"Review the process state.",
	].join("\n"));
	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-snapshot-workflow",
			agentId: "process-snapshot-agent",
			role: "ordinary",
			expectedSessionId,
			sessionPath,
			configuration: {
				cwd,
				model: {
					provider: PROCESS_RUNTIME_TEST_PROVIDER,
					modelId: PROCESS_RUNTIME_TEST_MODEL,
				},
				thinking: "off",
				tools: [],
				skills: ["review"],
				extensions: [CHILD_EXTENSION],
				systemPrompt: { mode: "append", body: systemPromptBody },
				loadContextFiles: true,
			},
			skillPaths: [skillPath],
			projectTrusted: false,
			ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			runtimeDirectory: root,
		});
		const systemPromptPath = join(dirname(runtime.bootstrapPath), "system-prompt.md");
		assert.deepEqual(runtime.snapshot, {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: [],
			skills: ["review"],
			skillSources: [{ name: "review", filePath: skillPath }],
			extensions: [CHILD_EXTENSION],
			toolExecutionModes: [],
			projectTrusted: false,
			sessionId: expectedSessionId,
			sessionPath,
			systemPrompt: {
				mode: "append",
				filePath: systemPromptPath,
				body: systemPromptBody,
			},
			loadContextFiles: true,
		});
	} finally {
		await runtime?.dispose();
	}
});

test("real child Observe and Message tools reach the scoped Owner handlers", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-coordination-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000003";
	const agentId = "process-coordination-agent";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	const ownerCalls: unknown[] = [];
	const observeReceipt = {
		agentId,
		workflowId: "process-coordination-workflow",
		label: "Remote Child",
		directSpawnerAgentId: "owner-agent",
		primaryEvidence: {
			transcriptPath: sessionPath,
			inspectedThrough: { agentId, entryId: "entry-observed" },
		},
		run: { phase: "dormant", retentionReasons: [] },
	} as const;
	const messageReceipt = {
		messageId: "process-message-receipt",
		targetAgentId: "process-target-agent",
		messageStatus: "sent",
	} as const;
	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-coordination-workflow",
			agentId,
			role: "ordinary",
			expectedSessionId,
			sessionPath,
			configuration: {
				cwd,
				model: {
					provider: PROCESS_RUNTIME_TEST_PROVIDER,
					modelId: PROCESS_RUNTIME_TEST_MODEL,
				},
				thinking: "off",
				tools: ["agent_observe", "agent_message"],
				skills: [],
				extensions: [CHILD_EXTENSION],
				loadContextFiles: true,
			},
			skillPaths: [],
			projectTrusted: true,
			ownerEnvironment: {
				...process.env,
				PI_SKIP_VERSION_CHECK: "1",
				PROCESS_RUNTIME_COORDINATION_TOOLS: "1",
			},
			runtimeDirectory: root,
			ownerRequestHandlers: ordinaryOwnerHandlers({
				selectorSnapshot: processSelectorSnapshot(agentId),
				executionStarted: () => ownerCalls.push([agentId, "executionStarted"]),
				observe: (input) => ownerCalls.push([agentId, "agent_observe", input]),
				message: (toolCallId, input) =>
					ownerCalls.push([agentId, "agent_message", toolCallId, input]),
				observeReceipt,
				messageReceipt,
			}),
		});
		const events: string[] = [];
		runtime.onEvent((event) => events.push(event.event));
		assert.equal((await runtime.channel.request("message.deliver", {
			deliveryId: "process-coordination-run",
			delivery: { kind: "user", content: "Invoke the scripted coordination tools." },
		})).accepted, true);
		await waitUntil(() => events.includes("agent.settled"));

		assert.deepEqual(ownerCalls.slice(0, 4), [
			[agentId, "executionStarted"],
			[agentId, "agent_observe", { operation: "status" }],
			[agentId, "agent_observe", {
				operation: "search",
				scope: "direct_children",
				query: "remote",
				limit: 20,
			}],
			[agentId, "agent_message", "process-message-call", {
				operation: "send",
				targetAgent: "process-target-agent",
				content: "Exact process message",
			}],
		]);
		const results = SessionManager.open(sessionPath).getEntries().flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult"
				? [entry.message]
				: []
		);
		assert.deepEqual(results.find((message) => message?.toolCallId === "process-observe-call")?.details, observeReceipt);
		assert.deepEqual(results.find((message) => message?.toolCallId === "process-search-call")?.details, observeReceipt);
		assert.deepEqual(results.find((message) => message?.toolCallId === "process-message-call")?.details, messageReceipt);
	} finally {
		await runtime?.dispose();
	}
});

test("process Runtime Host force-kills a child whose session shutdown never completes", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-runtime-stubborn-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000002";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });

	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-runtime-stubborn-test-workflow",
			agentId: "process-runtime-stubborn-test-agent",
			role: "ordinary",
			expectedSessionId,
			sessionPath,
			configuration: {
				cwd,
				model: {
					provider: PROCESS_RUNTIME_TEST_PROVIDER,
					modelId: PROCESS_RUNTIME_TEST_MODEL,
				},
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [CHILD_EXTENSION],
				loadContextFiles: true,
			},
			skillPaths: [],
			projectTrusted: true,
			ownerEnvironment: {
				...process.env,
				PI_SKIP_VERSION_CHECK: "1",
				PROCESS_RUNTIME_HANG_SHUTDOWN: "1",
			},
			runtimeDirectory: root,
			columns: 80,
			rows: 24,
		});
		const pid = runtime.pid;
		const bootstrapPath = runtime.bootstrapPath;
		const exit = await runtime.shutdown("force-cleanup test", 100);
		assert.notEqual(exit.signal, 0);
		assert.throws(() => process.kill(pid, 0), hasProcessCode("ESRCH"));
		await assert.rejects(lstat(bootstrapPath), hasFsCode("ENOENT"));
	} finally {
		await runtime?.dispose();
	}
});

test("process Runtime shutdown grace bounds an unresponsive Control request", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-runtime-unresponsive-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000008";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });

	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-runtime-unresponsive-test-workflow",
			agentId: "process-runtime-unresponsive-test-agent",
			role: "ordinary",
			expectedSessionId,
			sessionPath,
			configuration: {
				cwd,
				model: {
					provider: PROCESS_RUNTIME_TEST_PROVIDER,
					modelId: PROCESS_RUNTIME_TEST_MODEL,
				},
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [CHILD_EXTENSION],
				loadContextFiles: true,
			},
			skillPaths: [],
			projectTrusted: true,
			ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			runtimeDirectory: root,
		});
		const pid = runtime.pid;
		process.kill(pid, "SIGSTOP");
		const exit = await runtime.shutdown("unresponsive Control request", 100);
		assert.notEqual(exit.signal, 0);
		assert.throws(() => process.kill(pid, 0), hasProcessCode("ESRCH"));
	} finally {
		await runtime?.dispose();
	}
});

function ordinaryOwnerHandlers(options: Readonly<{
	executionStarted?: () => void;
	observe?: (input: AgentObserveInput) => void;
	message?: (toolCallId: string, input: unknown) => void;
	observeReceipt?: Awaited<ReturnType<OwnerParticipantRequestHandlers<"ordinary">["coordination"]["observe"]>>;
	messageReceipt?: Awaited<ReturnType<OwnerParticipantRequestHandlers<"ordinary">["coordination"]["message"]>>;
	selectorSnapshot?: Awaited<ReturnType<OwnerParticipantRequestHandlers<"ordinary">["presentation"]["snapshot"]>>;
	presentationSnapshotError?: Error;
	humanInputSubmitted?: (text: string) => boolean | Promise<boolean>;
	select?: (action: Parameters<OwnerParticipantRequestHandlers<"ordinary">["presentation"]["select"]>[0]) => void;
}> = {}): OwnerParticipantRequestHandlers<"ordinary"> {
	return {
		presentation: {
			setReportRead: async () => {},
			snapshot: async () => {
				if (options.presentationSnapshotError) throw options.presentationSnapshotError;
				return options.selectorSnapshot ?? ({
					live: [], dormant: [], selectedAgentId: "process-child",
					humanAttention: [], operationalAttention: [], reports: [],
				});
			},
			async select(action) {
				options.select?.(action);
				return { kind: "selected" };
			},
		},
		lifecycle: {
			async executionStarted() { options.executionStarted?.(); return []; },
			async humanInputSubmitted(input) {
				return await options.humanInputSubmitted?.(input.text)
					? "submitted"
					: "continue";
			},
			async primaryInputQueued() {},
			async humanInputMode() { return "agent"; },
			async toolResultCommitting() { return undefined; },
			async toolExecutionStarted() {},
			async safeBoundaryReached() {},
			async executionEnded() {},
		},
		coordination: {
			async agentTemplateSnapshot() {
				return {
					templates: [],
				};
			},
			async observe(input) {
				options.observe?.(input);
				return options.observeReceipt ?? {
					matches: [],
					hasMore: false,
				};
			},
			async message(toolCallId, input) {
				options.message?.(toolCallId, input);
				return options.messageReceipt ?? {
					messageId: "unused-message",
					targetAgentId: "unused-target",
					messageStatus: "sent",
				};
			},
			async wait() { return { answers: [] }; },
			async control(_toolCallId, input) {
				return { agentId: input.agentId, disposition: "not_running" };
			},
			async spawn() {
				return {
					spawnStatus: "not_created",
					failedStage: "identity_commit",
					reason: "Test child was not created",
				};
			},
			async askUser() {
				return { requestId: "unused-human", answer: "unused" };
			},
		},
	};
}

function processSelectorSnapshot(childAgentId: string): Awaited<ReturnType<
	OwnerParticipantRequestHandlers<"ordinary">["presentation"]["snapshot"]
>> {
	const status = (
		agentId: string,
		label: string,
		directSpawnerAgentId: string | null,
		retentionReason: "owner_host_binding" | "interactive_selection",
	) => ({
		agentId,
		workflowId: "process-runtime-test-workflow",
		label,
		directSpawnerAgentId,
		primaryEvidence: {
			transcriptPath: `/sessions/${agentId}.jsonl`,
			inspectedThrough: { agentId, entryId: `${agentId}-entry` },
		},
		run: {
			phase: "live" as const,
			work: "settled" as const,
			attention: "none" as const,
			retentionReasons: [{ reason: retentionReason, count: 1 }],
		},
		model: { provider: PROCESS_RUNTIME_TEST_PROVIDER, modelId: PROCESS_RUNTIME_TEST_MODEL },
		thinking: "off" as const,
		compacting: false,
		queuedInputCount: 0,
	});
	return {
		live: [
			status("process-runtime-test-workflow", "Owner", null, "owner_host_binding"),
			status(childAgentId, "Process Child", "process-runtime-test-workflow", "interactive_selection"),
		],
		dormant: [],
		selectedAgentId: childAgentId,
		humanAttention: [],
		operationalAttention: [], reports: [],
	};
}

function frameText(runtime: PiChildProcessRuntime): string {
	return nativeChildDisplayText(runtime);
}

async function waitForFrame(runtime: PiChildProcessRuntime, expected: string): Promise<void> {
	await attachNativeChildDisplay(runtime);
	await waitUntil(async () => {
		await runtime.drain();
		return frameText(runtime).includes(expected);
	});
}

async function waitUntil(condition: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for process Runtime Bridge state");
}

function hasFsCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

function hasProcessCode(code: string): (error: unknown) => boolean {
	return hasFsCode(code);
}

test("hidden real child persists work without rendering and repeated attachment redraws current native UI", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-visible-child-"));
	const cwd = join(root, "work");
	await mkdir(cwd);
	const sessionId = "019a6b4d-1b22-7000-8000-000000000095";
	const sessionPath = join(root, "child.jsonl");
	const probePath = join(root, "render-events.jsonl");
	await writeFile(sessionPath, JSON.stringify({
		type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd,
	}) + "\n");
	const runtime = await PiChildProcessRuntime.start({
		workflowId: "visible-workflow", agentId: sessionId, role: "ordinary",
		expectedSessionId: sessionId, sessionPath,
		configuration: {
			cwd, model: { provider: PROCESS_RUNTIME_TEST_PROVIDER, modelId: PROCESS_RUNTIME_TEST_MODEL },
			thinking: "off", tools: [], skills: [], extensions: [CHILD_EXTENSION],
			loadContextFiles: true,
		},
		skillPaths: [], projectTrusted: true, runtimeDirectory: root,
		ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1",
			PROCESS_RUNTIME_VISIBILITY_PROBE: probePath, PROCESS_RUNTIME_RESPONSE_DELAY_MS: "100" },
		ownerRequestHandlers: ordinaryOwnerHandlers({ selectorSnapshot: processSelectorSnapshot(sessionId) }),
		columns: 80, rows: 24,
	});
	t.after(() => runtime.dispose());
	const output: string[] = [];
	runtime.addOutputHandler(data => output.push(data));
	let settled = 0;
	let changes = 0;
	runtime.onEvent(event => { if (event.event === "agent.settled") settled++; });
	runtime.addChangeHandler(() => changes++);
	const events = async () => (await readFile(probePath, "utf8")).trim().split("\n");
	await runtime.drain();
	const initialFrame = runtime.frame();
	for (let turn = 1; turn <= 2; turn++) {
		const renderCount = (await events()).filter(line => line === "render").length;
		output.length = 0;
		await runtime.channel.request("message.deliver", { deliveryId: "visibility-" + turn, delivery: { kind: "user", content: "HIDDEN_WORK_" + turn } });
		await waitUntil(() => settled === turn);
		const transcript = JSON.stringify(SessionManager.open(sessionPath).getEntries());
		assert.match(transcript, new RegExp("HIDDEN_WORK_" + turn));
		assert.equal(transcript.split(PROCESS_RUNTIME_TEST_RESPONSE).length - 1, turn);
		assert.equal((await events()).filter(line => line === "render").length, renderCount);
		assert.equal(changes, 0, "hidden output must not update an offscreen terminal");
		assert.deepEqual(runtime.frame(), initialFrame);
		assert.doesNotMatch(output.join(""), /HIDDEN_WORK_|VISIBILITY_WIDGET|\x1b\[\?2026h/);

		const columns = turn === 1 ? 100 : 120;
		const rows = turn === 1 ? 30 : 40;
		runtime.resize(columns, rows);
		const display = new xtermHeadless.Terminal({ cols: columns, rows, allowProposedApi: true });
		t.after(() => display.dispose());
		display.onData(data => runtime.writeInput(data));
		const disconnect = await runtime.beginPhysicalTerminalAttachment(data => display.write(data));
		const screen = () => Array.from({ length: rows }, (_, row) =>
			display.buffer.active.getLine(display.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
		await waitUntil(() => screen().includes("VISIBILITY_WIDGET_" + turn));
		assert.match(screen(), new RegExp(PROCESS_RUNTIME_TEST_RESPONSE));
		assert.match(screen(), new RegExp("VISIBILITY_EDITOR_" + turn));
		assert.deepEqual(runtime.dimensions(), { columns, rows });
		runtime.writeInput("\x15/runtime-probe attached-" + turn + "\r");
		await waitUntil(() => screen().includes("INPUT=attached-" + turn));
		assert.match(screen(), new RegExp("SIZE=" + columns + "x" + rows));
		disconnect();
		await runtime.hidePresentation();
		changes = 0;
	}
	assert.equal((await events()).filter(line => line === "session_start").length, 1);
	await runtime.shutdown("visibility test complete");
	await runtime.hidePresentation();
});

function latestCycleId(events: readonly import("../src/process-runtime/pi-child-process-runtime.ts").PiChildRuntimeEvent[]): string {
	const event = events.findLast(event => event.event === "agent.start");
	assert.ok(event?.event === "agent.start", "child has reported execution");
	return event.payload.runId;
}
