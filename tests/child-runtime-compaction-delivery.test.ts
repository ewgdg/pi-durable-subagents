import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type FauxResponseStep } from "@earendil-works/pi-ai";

import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import type { AgentRuntimeDelivery, AgentRuntimeHost } from "../src/runtime/agent-runtime-host.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import type { WorkingZonePreparation } from "../src/runtime/agent-runtime-host.ts";
import { createChildControlLoopback, type ChildControlLoopback } from "./support/child-control-loopback.ts";

const COMPACTION_SETTINGS = { compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 24 } };

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
		let safeBoundary: () => Promise<void> = async () => {};
		let safeBoundaries = 0;
		let manualSignal: AbortSignal | undefined;
		let manualAttempts = 0;
		let preparations = 0;
		let finishReplacement!: () => void;
		const replacementGate = new Promise<void>((resolve) => { finishReplacement = resolve; });
		t.after(finishReplacement);
		let requestSeen!: () => void;
		const requestInModel = new Promise<void>((resolve) => { requestSeen = resolve; });
		const loopback: ChildControlLoopback = await createChildControlLoopback(t, { host: { settings: COMPACTION_SETTINGS }, configure: (pi) => {
			pi.on("before_agent_start", event => {
				preparations++;
				return { systemPrompt: `${event.systemPrompt}\nCHILD_CUSTOM_PREPARED` };
			});
			pi.registerTool({
				name: "checkpoint", label: "Checkpoint", description: "Complete checkpoint work.",
				parameters: Type.Object({}),
				async execute() { return { content: [{ type: "text", text: "Checkpoint complete." }], details: {} }; },
			});
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
					await loopback.host.session.waitForIdle();
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			});
		} });
		const { host, proxy: parent } = loopback;
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
			assert.match(getCurrentSystemPrompt(modelContext.messages), /CHILD_CUSTOM_PREPARED/,
				"each custom start and its tool continuation retain before-start preparation");
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

		const failures: string[] = [];
		let dispatched!: ReturnType<typeof parent.deliver>;
		const handle = Object.freeze({ sequence: 1 });
		const scheduler = new MessageDeliveryScheduler({ agents: new Map(), workflowPolicy: new WorkflowPolicyStore() });
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
		safeBoundary = () => record.host.lane.run(() => scheduler.reachSafeBoundaryInLane(record));
		try {
			// Reuse the same bridge/adapter after an earlier model cycle settles.
			const previous = parent.deliver({
				kind: "user",
				content: "Earlier work.",
				deliverAs: "followUp",
			});
			await previous.completion;
			await session.waitForIdle();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await record.host.lane.idle();
			assert.equal(parent.workState(), "settled");
			previousTurnDone = true;
			safeBoundaries = 0;
			const firstEvent = loopback.events.length;
			const events = () => loopback.events.slice(firstEvent);

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
			assert.equal(lastStartedRunId(events()), replacementFinishesFirst ? "native-run-3" : "native-run-2");
			assert.equal(manualAttempts, 1);
			assert.equal(preparations, replacementFinishesFirst ? 3 : 2,
				"initial user input and each genuinely idle custom Run prepare exactly once");
			assert.equal(manualSignal?.aborted, false);
			assert.deepEqual(host.ui.notifications, []);
			assert.deepEqual(loopback.hostShell.notices, []);
			assert.deepEqual(events().filter(({ event }) => event === "runtime.fault"), []);
			const committed = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
			assert.deepEqual(committed.map((entry) => entry.customType), [
				replacementType, deliveryMessage.customType,
			]);
			assert.equal(committed[1]?.content, deliveryMessage.content);
			assert.equal(events().filter(({ event }) => event === "agent.settled").length, replacementFinishesFirst ? 1 : 0);

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
			assert.deepEqual(events().flatMap((event) => event.event.startsWith("agent.") && "runId" in event.payload ? [[event.event, event.payload.runId]] : []), [
				["agent.start", "native-run-2"], ["agent.end", "native-run-2"], ["agent.settled", "native-run-2"],
				...(replacementFinishesFirst ? [["agent.start", "native-run-3"], ["agent.end", "native-run-3"], ["agent.settled", "native-run-3"]] : []),
			]);
			assert.deepEqual(events().filter(({ event }) => event === "runtime.fault"), []);
		} finally {
			finishReplacement();
			await session.waitForIdle();
		}
	});
}

for (const cancellation of [undefined, "delivery", "native"] as const) {
	const cancelWhilePreparing = cancellation !== undefined;
	test(`compaction admission releases for competing native preparation${cancellation === "native" ? " and native abort cancels waiting delivery" : cancellation === "delivery" ? " and cancellation preserves that input" : " before retrying the original custom queue mode"}`, {
		timeout: 5_000,
	}, async t => {
		const inputEntered = deferred();
		const releaseInput = deferred();
		const modelEntered = deferred();
		const releaseModel = deferred();
		t.after(() => { releaseInput.resolve(); releaseModel.resolve(); });
		let nativePrompt: Promise<void> | undefined;
		let manualAttempts = 0;
		let preparations = 0;
		const loopback: ChildControlLoopback = await createChildControlLoopback(t, { host: { settings: COMPACTION_SETTINGS }, configure: pi => {
			pi.on("input", async event => {
				if (event.source !== "interactive") return { action: "continue" };
				inputEntered.resolve();
				if (cancelWhilePreparing) await releaseInput.promise;
				return { action: "continue" };
			});
			pi.on("before_agent_start", event => {
				preparations++;
				return { systemPrompt: `${event.systemPrompt}\nCOMPETING_NATIVE_PREPARED` };
			});
			pi.on("session_before_compact", event => {
				if (event.reason === "manual") manualAttempts++;
				return { cancel: true };
			});
			pi.on("session_compact_failed", async event => {
				if (event.reason !== "manual" || !event.aborted) return;
				// A human submits while the child prepares; the binding's input handler
				// reserves this native turn at the child gate. Its prompt already owns
				// preparation when custom admission resumes: the interactive loop reports
				// input start over Control first, so hold compaction until input entry.
				nativePrompt = loopback.submitNativeInput("Native replacement after compaction.");
				void nativePrompt.catch(() => undefined);
				await inputEntered.promise;
			});
		} });
		const { host, ownerChannel, events } = loopback;
		const session = host.session;
		for (let index = 0; index < 3; index++) {
			session.sessionManager.appendMessage({ role: "user", content: "Prior context. ".repeat(200), timestamp: Date.now() });
			session.sessionManager.appendMessage(fauxAssistantMessage("Prior response."));
		}
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		session.getContextUsage = () => ({ tokens: 120_000, contextWindow: 200_000, percent: 60 });
		const seen: boolean[] = [];
		host.model.setResponses([
			async context => {
				seen.push(JSON.stringify(context.messages).includes(preparation.prospectiveRequest.question));
				assert.match(getCurrentSystemPrompt(context.messages), /COMPETING_NATIVE_PREPARED/);
				modelEntered.resolve();
				await releaseModel.promise;
				return fauxAssistantMessage("Native work completed.");
			},
			context => {
				seen.push(JSON.stringify(context.messages).includes(preparation.prospectiveRequest.question));
				assert.match(getCurrentSystemPrompt(context.messages), /COMPETING_NATIVE_PREPARED/);
				return fauxAssistantMessage("Custom follow-up completed.");
			},
		]);
		const dispatch = ownerChannel.request("message.deliver", { deliveryId: "competing-delivery", proveCommit: true, delivery: {
			kind: "custom", message: {
				...deliveryMessage, details: { messages: [...deliveryMessage.details.messages] },
			}, triggerTurn: true,
			deliverAs: "followUp", workingZonePreparation: preparation,
		} });
		void dispatch.catch(() => undefined);
		await inputEntered.promise;
		// The held input hook runs before the binding reserves the native turn, so let
		// the failed compaction return and the Delivery release its admission to wait
		// on the native preparation before cancelling either side.
		await new Promise<void>(resolve => setImmediate(resolve));
		if (cancelWhilePreparing) {
			if (cancellation === "native") {
				await session.abort();
				let timeout!: ReturnType<typeof setTimeout>;
				try {
					await Promise.race([
						assert.rejects(dispatch, /startup_admission_cancelled/),
						new Promise<never>((_resolve, reject) => {
							timeout = setTimeout(() => reject(new Error("Native abort left child Delivery waiting for preparation")), 1_000);
						}),
					]);
				} finally { clearTimeout(timeout); }
			} else {
				assert.deepEqual(await ownerChannel.request("message.cancel", { deliveryId: "competing-delivery" }), { accepted: true });
				await assert.rejects(dispatch, /child_turn_admission_cancelled/);
			}
			releaseInput.resolve();
		} else {
			await modelEntered.promise;
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(session.agent.hasQueuedMessages(), true, "the original custom follow-up is queued after native entry");
		}
		if (cancellation !== "native") await modelEntered.promise;
		releaseModel.resolve();
		if (!cancelWhilePreparing) {
			assert.equal((await dispatch).transcriptCommitted, true);
		}
		if (cancellation === "native") await assert.rejects(nativePrompt!, /startup_admission_cancelled/);
		else await nativePrompt;
		await session.waitForIdle();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(manualAttempts, 1);
		assert.equal(preparations, 1,
			"only the competing native input prepares; active custom input stays native");
		assert.deepEqual(seen, cancellation === "native" ? [] : cancelWhilePreparing ? [false] : [false, true]);
		assert.equal(session.pendingMessageCount, 0);
		assert.equal(session.sessionManager.getEntries().filter(entry =>
			entry.type === "custom_message" && entry.customType === deliveryMessage.customType).length,
			cancelWhilePreparing ? 0 : 1);
		assert.deepEqual(await ownerChannel.request("message.cancel", { deliveryId: "competing-delivery" }), { accepted: false },
			"the settled Delivery is no longer cancellable");
		assert.deepEqual(events.filter(event => event.event === "runtime.fault"), []);
	});
}

test("cancelled child reminder preparation leaves no delivery and permits one later reminder", { timeout: 5_000 }, async t => {
	const inputEntered = deferred();
	const releaseInput = deferred();
	t.after(() => releaseInput.resolve());
	let holdPreparation = true;
	let modelCalls = 0;
	const { host, ownerChannel } = await createChildControlLoopback(t, { host: { settings: COMPACTION_SETTINGS }, configure: pi => {
		pi.on("input", async event => {
			if (event.source === "extension" && holdPreparation) {
				inputEntered.resolve();
				await releaseInput.promise;
			}
			return { action: "continue" };
		});
	} });
	host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Reminder processed."); }]);
	assert.deepEqual(await ownerChannel.request("moderatorReminder.prepare", { reservationId: "cancelled-reminder" }), { prepared: true });
	// The Owner abandons the commit while the reminder input is still preparing.
	const abandon = new AbortController();
	const cancelled = ownerChannel.request("moderatorReminder.finish", { reservationId: "cancelled-reminder", commit: true }, abandon.signal);
	const rejected = assert.rejects(cancelled, { name: "AbortError" });
	await inputEntered.promise;
	abandon.abort();
	await rejected;
	holdPreparation = false;
	releaseInput.resolve();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(modelCalls, 0);
	assert.equal(host.session.pendingMessageCount, 0);
	assert.equal(host.session.sessionManager.getEntries().some(entry => entry.type === "custom_message"), false);
	assert.deepEqual(await ownerChannel.request("moderatorReminder.prepare", { reservationId: "next-reminder" }), { prepared: true });
	assert.deepEqual(await ownerChannel.request("moderatorReminder.finish", { reservationId: "next-reminder", commit: true }), { outcome: "committed" });
	await host.session.waitForIdle();
	assert.equal(modelCalls, 1);
	assert.equal(host.session.sessionManager.getEntries().filter(entry =>
		entry.type === "custom_message" && entry.customType === "agent-coordination.moderator-obligation-reminder").length, 1);
});

function lastStartedRunId(events: readonly ChildControlLoopback["events"][number][]): string | undefined {
	return events.findLast(event => event.event === "agent.start")?.payload.runId;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(settle => { resolve = settle; });
	return { promise, resolve };
}
