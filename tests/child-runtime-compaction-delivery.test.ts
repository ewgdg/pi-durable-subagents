import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import type { AgentRuntimeDelivery, AgentRuntimeHost } from "../src/runtime/agent-runtime-host.ts";
import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import type { PiChildProcessLaunch, PiChildProcessRuntime, PiChildRuntimeEvent } from "../src/process-runtime/pi-child-process-runtime.ts";
import { createChildRuntimeBinding } from "../src/process-runtime/child-runtime-bridge.ts";
import { NativeInputSubmissionIdentity } from "../src/process-runtime/native-input-submission-identity.ts";
import { TerminalInputSubmissionAcknowledger } from "../src/process-runtime/terminal-input-submission-acknowledger.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import type { WorkingZonePreparation } from "../src/runtime/agent-runtime-host.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const preparation: WorkingZonePreparation = {
	intent: { workScale: "large", contextDependence: "low" },
	prospectiveRequest: {
		title: "Fixture request",
		kind: "request",
		requestMessageId: "prepared-request",
		fromAgentId: "requester",
		question: "Continue the prepared Request.",
	},
};
const deliveryMessage = createMessageDelivery([{
	source: { agentId: "requester", entryId: "source-entry", toolCallId: "source-call" },
	projection: preparation.prospectiveRequest,
}]);
const replacementType = "test.compaction-replacement";

const paths = [
	{ name: "optional working zone", tokens: 120_000, preparation },
	{ name: "mandatory working zone", tokens: 190_000, preparation },
	{ name: "native threshold", tokens: 190_000, preparation: undefined },
] as const;
const cases = [
	...paths.flatMap((path) => [false, true].flatMap((replacementFinishesFirst) =>
		(["deferred", "steer"] as const).map((deliveryMode) => ({ path, replacementFinishesFirst, deliveryMode })))),
];
for (const { path, replacementFinishesFirst, deliveryMode } of cases) {
	test(`${deliveryMode}, ${path.name} after a completed turn: tool-bearing replacement ${replacementFinishesFirst ? "finishes before rejection" : "still active"}`, {
		timeout: 5_000,
	}, async (t) => {
		let context!: ExtensionContext;
		let safeBoundary: () => Promise<void> = async () => {};
		let safeBoundaries = 0;
		const cancellation = new AbortController();
		let manualSignal: AbortSignal | undefined;
		let manualAttempts = 0;
		let finishReplacement!: () => void;
		const replacementGate = new Promise<void>((resolve) => { finishReplacement = resolve; });
		t.after(finishReplacement);
		let requestSeen!: () => void;
		const requestInModel = new Promise<void>((resolve) => { requestSeen = resolve; });
		const host = await createTestOwnerHost(t, (pi) => {
			pi.registerTool({
				name: "checkpoint", label: "Checkpoint", description: "Complete checkpoint work.",
				parameters: Type.Object({}),
				async execute() { return { content: [{ type: "text", text: "Checkpoint complete." }], details: {} }; },
			});
			pi.on("session_start", (_event, ctx) => { context = ctx; });
			pi.on("turn_end", async () => { await safeBoundary(); safeBoundaries += 1; });
			pi.on("session_before_compact", (event) => {
				if (event.reason === "manual") {
					manualAttempts += 1;
					manualSignal = event.signal;
				}
				return { cancel: true };
			});
			pi.on("session_compact_failed", async (event) => {
				if (event.reason !== "manual" || !event.aborted || manualSignal?.aborted) return;
				// Extensions may replace compaction with an ordinary model turn.
				pi.sendMessage({
					customType: replacementType,
					content: "Save checkpoint notes and continue.",
					display: true,
				}, { triggerTurn: true, deliverAs: "steer" });
				if (replacementFinishesFirst) {
					await host.session.waitForIdle();
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			});
		}, {
			settings: { compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 24 } },
		});
		const session = host.session;
		for (let index = 0; index < 3; index += 1) {
			session.sessionManager.appendMessage({
				role: "user", content: "Prior context. ".repeat(200), timestamp: Date.now(),
			});
			session.sessionManager.appendMessage(fauxAssistantMessage("Prior response."));
		}
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		let previousTurnDone = false;
		session.getContextUsage = () => ({
			tokens: previousTurnDone ? path.tokens : 0, contextWindow: 200_000,
			percent: previousTurnDone ? path.tokens / 2_000 : 0,
		});
		let checkpointRequested = false;
		const respond: FauxResponseStep = async (modelContext) => {
			if (!previousTurnDone) return fauxAssistantMessage("Earlier work completed.");
			if (!checkpointRequested) {
				checkpointRequested = true;
				return fauxAssistantMessage(fauxToolCall("checkpoint", {}, { id: "replacement-checkpoint" }), { stopReason: "toolUse" });
			}
			if (JSON.stringify(modelContext.messages).includes(preparation.prospectiveRequest.question)) {
				requestSeen();
				await replacementGate;
			}
			return fauxAssistantMessage("Checkpoint and Request processed.");
		};
		host.model.setResponses([respond, respond, respond, respond]);

		type ControlState = Parameters<typeof createChildRuntimeBinding>[0];
		const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
		const events: Array<{ event: string; payload: unknown }> = [];
		// Keep transport outside this focused binding test; Pi and bridge lifecycle are real.
		const channel = {
			async sendEvent(event: string, payload: unknown) {
				events.push({ event, payload });
				for (const handler of eventHandlers) handler({ event, payload } as PiChildRuntimeEvent);
			},
		} as unknown as ControlState["channel"];
		const inputSubmissionAcknowledger = new TerminalInputSubmissionAcknowledger(() => {});
		const state: ControlState = {
			channel,
			waitProgressHandlers: new Map(),
			currentRunOutcome: "completed",
			nativeRunSequence: 0,
			queueIntentionTail: Promise.resolve(),
			shutdownStarted: false,
			inputSubmissionAcknowledger,
			nativeInputIdentity: new NativeInputSubmissionIdentity(),
		};
		const binding = createChildRuntimeBinding(
			state, host.runtime, context, () => {}, "recipient",
			inputSubmissionAcknowledger.bind(), () => {}, () => {},
		);
		state.currentBinding = binding;
		const parent = new PiChildHostedRuntime({
			exited: new Promise(() => {}),
			addChangeHandler: () => () => {},
			addFailureHandler: () => () => {},
			ready: async () => ({
				snapshot: {
					cwd: context.cwd, model: { provider: "test", modelId: "test" }, thinking: "off",
					tools: [], skills: [], skillSources: [], extensions: [], toolExecutionModes: [],
					projectTrusted: true, sessionId: session.sessionId, sessionPath: null,
					systemPrompt: null, loadContextFiles: true,
				},
				channel: {
					onClose: () => () => {},
					request: async (method: string, payload: unknown) => binding.handleOwnerRequest({
						method, payload, signal: cancellation.signal,
					} as Parameters<typeof binding.handleOwnerRequest>[0]),
				},
			} as unknown as PiChildProcessRuntime),
			onEvent: (handler: (event: PiChildRuntimeEvent) => void) => {
				eventHandlers.add(handler);
				return () => { eventHandlers.delete(handler); };
			},
			dispose: async () => {},
		} as unknown as PiChildProcessLaunch, []);
		await parent.ready;
		const failures: string[] = [];
		let dispatched!: ReturnType<typeof parent.deliver>;
		const handle = Object.freeze({ sequence: 1 });
		const scheduler = new MessageDeliveryScheduler({ workflowPolicy: new WorkflowPolicyStore() });
		const record = {
			identity: { agentId: "recipient" },
			host: {
				lane: new SerialLane(),
				currentHandle: () => handle,
				isCurrent: (candidate: unknown) => candidate === handle,
				addSettledHandler: (handler: (settledHandle: typeof handle, outcome: "settled") => void) =>
					parent.subscribe((event) => { if (event.type === "agent_settled") handler(handle, "settled"); }),
				addEndedHandler: () => () => {},
				addRetentionReason() {},
				removeRetentionReason() {},
				blocksOrdinaryDelivery: () => false,
				currentWorkState: () => parent.workState(),
				observe: () => ({ phase: "live", work: parent.workState(), attention: "none", retentionReasons: [] }),
				deliverInLane: (input: AgentRuntimeDelivery) => dispatched = parent.deliver(input, { inspectCommit: () => true }),
				finishIsolatedResumptionInLane() {},
				discardAndEndInLane: async (cause: string) => { failures.push(cause); },
				releaseIfEligibleInLane() {},
			} as unknown as AgentRuntimeHost,
		} as unknown as AgentRecord;
		scheduler.integrate(record);
		safeBoundary = () => scheduler.reachSafeBoundary(record);
		try {
			// Reuse the same bridge/adapter after an earlier model cycle settles.
			const previous = parent.deliver({
				kind: "user",
				content: "Earlier work.",
				deliverAs: "followUp",
			}, { inspectCommit: () => true });
			await previous.completion;
			await session.waitForIdle();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await record.host.lane.idle();
			assert.equal(parent.workState(), "settled");
			previousTurnDone = true;
			safeBoundaries = 0;
			events.length = 0;

			await scheduler.admit(record, {
				messageId: "actual-request",
				deliveryMode,
				...(path.preparation ? { contextPreparation: path.preparation.intent } : {}),
				deliveryItem: {
					source: { agentId: "requester", entryId: "source-entry", toolCallId: "source-call" },
					projection: preparation.prospectiveRequest,
				},
				inspectProof: () => {
					const entry = session.sessionManager.getEntries().find((entry) =>
						entry.type === "custom_message" && entry.customType === deliveryMessage.customType);
					return entry ? { agentId: "recipient", entryId: entry.id } : undefined;
				},
			});
			let completed = false;
			void dispatched.completion.then(() => { completed = true; }, () => {});
			const commitResult = await dispatched.transcriptCommit?.catch((error: unknown) => error);
			assert.equal(commitResult, true);
			await requestInModel;
			assert.equal(session.isIdle, false);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(completed, false, "Owner completion must remain pending during the actual Request");
			assert.deepEqual(failures, [], "replacement settlement must not fail the actual Delivery");
			assert.equal(parent.workState(), "active");
			assert.equal(state.currentRunId, replacementFinishesFirst ? "native-run-3" : "native-run-2");
			assert.equal(manualAttempts, 1);
			assert.equal(manualSignal?.aborted, false);
			assert.deepEqual(host.ui.notifications, []);
			assert.deepEqual(events.filter(({ event }) => event === "runtime.fault"), []);
			const committed = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
			assert.deepEqual(committed.map((entry) => entry.customType), [
				replacementType, deliveryMessage.customType,
			]);
			assert.equal(committed[1]?.content, deliveryMessage.content);
			assert.equal(events.filter(({ event }) => event === "agent.settled").length, replacementFinishesFirst ? 1 : 0);

			finishReplacement();
			await session.waitForIdle();
			await dispatched.completion;
			await new Promise<void>((resolve) => setImmediate(resolve));
			await record.host.lane.run(() => {});
			assert.deepEqual(failures, [], "successful Delivery must not fail its Run");
			// followUp starts after replacement turn_end; steering can join that turn.
			assert.equal(safeBoundaries, replacementFinishesFirst || deliveryMode === "deferred" ? 3 : 2);
			assert.ok(session.sessionManager.getEntries().some(entry => entry.type === "message" &&
				entry.message.role === "toolResult" && entry.message.toolCallId === "replacement-checkpoint" && !entry.message.isError));
			assert.equal(parent.workState(), "settled");
			assert.deepEqual(events.filter(({ event }) => event.startsWith("agent.")).map(({ event, payload }) => [event, (payload as { runId: string }).runId]), [
				["agent.start", "native-run-2"], ["agent.end", "native-run-2"], ["agent.settled", "native-run-2"],
				...(replacementFinishesFirst ? [["agent.start", "native-run-3"], ["agent.end", "native-run-3"], ["agent.settled", "native-run-3"]] : []),
			]);
			assert.deepEqual(events.filter(({ event }) => event === "runtime.fault"), []);
		} finally {
			finishReplacement();
			await session.waitForIdle();
			binding.dispose();
			await parent.dispose();
		}
	});
}
