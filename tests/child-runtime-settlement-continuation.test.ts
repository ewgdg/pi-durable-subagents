import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import { createWorkflowContinuation } from "../src/protocol/workflow-continuation.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { selectedAgentWorkStatus } from "../src/presentation/selected-agent-status.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import { ControllableOperationReviewClock } from "./support/controllable-operation-review-clock.ts";
import { createChildControlLoopback } from "./support/child-control-loopback.ts";

const CONTEXT_ROLLOVER_TOOL = "context_rollover";

test("an earlier settlement cannot mark a running child continuation idle", { timeout: 5_000 }, async (t) => {
	const continuationStarted = signal();
	const releaseContinuation = signal();
	t.after(() => releaseContinuation.resolve());
	const loopback = await createChildControlLoopback(t, { configure: (pi) => {
		pi.registerTool({
			name: CONTEXT_ROLLOVER_TOOL, label: "Context rollover",
			description: "End the current model loop before its context continuation.",
			parameters: Type.Object({}), executionMode: "sequential",
			async execute(_id, _input, _signal, _update, ctx) {
				// Match new_context: abort without awaiting this tool's own settlement.
				ctx.abort();
				return { terminate: true, content: [{ type: "text", text: "New context prepared." }], details: {} };
			},
		});
		let continued = false;
		pi.on("agent_settled", () => {
			if (continued) return;
			continued = true;
			// Context-rollover extensions start the successor from this hook. Pi defers
			// that run until every settled handler finishes, so it follows the old settlement.
			pi.sendUserMessage("Continue in the next context window.");
		});
	} });
	const { proxy: runtime, host: childHost } = loopback;
	childHost.model.setResponses([
		fauxAssistantMessage(fauxToolCall(CONTEXT_ROLLOVER_TOOL, {}, { id: "context-rollover" }), { stopReason: "toolUse" }),
		async () => {
			continuationStarted.resolve();
			// The parent releases actual model work only after inspecting hosted status.
			await releaseContinuation.promise;
			return fauxAssistantMessage("Continuation completed.");
		},
	]);
	const agentId = "019a6b4d-1b22-7000-8000-000000000301";
	const host = AgentRuntimeSupervisor.createChild({
		agentId, startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	const record: AgentRecord = {
		identity: {
			agentId, workflowId: "settlement-continuation-workflow",
			directSpawnerAgentId: "settlement-continuation-workflow",
			spawnSource: { agentId: "settlement-continuation-workflow", entryId: "spawn", toolCallId: "spawn" },
			creationPreset: null, metadata: { label: "Continuation child" },
		},
		host, transcript: transcriptFromSessionManager(childHost.session.sessionManager), children: [],
	};
	const clock = new ControllableOperationReviewClock();
	const policy = new WorkflowPolicyStore();
	let dispatchAttempts = 0;
	const scheduler = new MessageDeliveryScheduler({
		agents: new Map(),
		workflowPolicy: policy, deliveryProgressClock: clock,
		// Retain the queued delivery at its dispatch boundary to test real eligibility.
		scheduleDeliveryDispatch: () => { dispatchAttempts += 1; },
		scheduleReleaseEvaluation: () => {},
	});
	const events = () => JSON.stringify(loopback.events.map(({ event }) => event));
	try {
		await host.lane.run(() => host.startInLane());
		let deliveryCompleted = false;
		const completion = runtime.deliver({ kind: "user", content: "Start the first context window." }).completion
			.then(() => { deliveryCompleted = true; });
		// Observe a fresh snapshot sent after the old settled callback returned:
		// the continuation's model call alone could race transport publication.
		await continuationStarted.promise;
		await runtime.synchronizeState();
		assert.equal(runtime.workState(), "active", events());
		const run = host.observe();
		assert.ok(run.phase === "live");
		assert.equal(run.work, "active", "explicit Agent status must agree with native model work");
		assert.deepEqual(selectedAgentWorkStatus(run, false), { kind: "active" });
		await host.lane.run(() => scheduler.admitCustomInLane(record, {
			messageId: "queued-deferred", deliveryMode: "deferred", inspectProof: () => undefined,
			customMessage: createWorkflowContinuation({ activationId: "queued-continuation", agentId, runSequence: 1, outstandingRequests: [] }),
		}));
		assert.deepEqual(scheduler.blockedDeliveries(), []);
		clock.advanceBy(policy.current().deliveryProgressIntervalMs);
		assert.deepEqual(scheduler.blockedDeliveries(), [], "active continuation cannot accrue an eligible Delivery Stall");
		assert.equal(dispatchAttempts, 0, "Deferred delivery cannot dispatch into active native work");
		assert.equal(deliveryCompleted, false, "the earlier settlement cannot complete an active delivery cycle");
		releaseContinuation.resolve();
		await completion;
		await runtime.waitForIdle();
		assert.equal(runtime.workState(), "settled");
		await waitUntil(() => dispatchAttempts > 0);
		assert.deepEqual(scheduler.blockedDeliveries(), []);
		clock.advanceBy(policy.current().deliveryProgressIntervalMs);
		assert.deepEqual(scheduler.blockedDeliveries().map(({ reason }) => reason), [{
			kind: "progress_deadline", stage: "eligible", intervalMs: policy.current().deliveryProgressIntervalMs,
		}], "genuinely settled pending delivery still receives its normal deadline");
	} finally {
		scheduler.shutdownProgress();
		releaseContinuation.resolve();
	}
});

function signal(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Delivery was not dispatched");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
