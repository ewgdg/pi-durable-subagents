import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import { createWorkflowContinuation } from "../src/protocol/workflow-continuation.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { selectedAgentWorkStatus } from "../src/presentation/selected-agent-status.ts";
import { ControllableOperationReviewClock } from "./support/controllable-operation-review-clock.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import { PiChildProcessRuntime } from "../src/process-runtime/pi-child-process-runtime.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import { PI_TEST_AGENT_DIR } from "./support/pi-test-environment.ts";
import { CONTINUATION_MODEL, CONTINUATION_PROVIDER, CONTINUATION_STARTED, CONTEXT_ROLLOVER_TOOL } from "./fixtures/settlement-continuation-extension.ts";

test("an earlier settlement cannot mark a running child continuation idle", {
	// A real process must initialize Pi and its PTY before exercising the boundary.
	timeout: 15_000, skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "child-settlement-continuation-"));
	const cwd = join(root, "work");
	await mkdir(cwd);
	const sessionPath = join(root, "child.jsonl");
	const releasePath = join(root, "release");
	const agentId = "019a6b4d-1b22-7000-8000-000000000301";
	await writeFile(sessionPath, JSON.stringify({
		type: "session", version: 3, id: agentId,
		timestamp: new Date().toISOString(), cwd,
	}) + "\n");
	const launch = await PiChildProcessRuntime.launch({
		workflowId: "settlement-continuation-workflow", agentId, role: "ordinary",
		expectedSessionId: agentId, sessionPath, agentDir: PI_TEST_AGENT_DIR,
		configuration: {
			cwd, model: { provider: CONTINUATION_PROVIDER, modelId: CONTINUATION_MODEL },
			thinking: "off", tools: [CONTEXT_ROLLOVER_TOOL], skills: [],
			extensions: [fileURLToPath(new URL("./fixtures/settlement-continuation-extension.ts", import.meta.url))],
			loadContextFiles: true,
		},
		skillPaths: [], projectTrusted: true, runtimeDirectory: root,
		ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1", CONTINUATION_RELEASE_PATH: releasePath },
	});
	const runtime = new PiChildHostedRuntime(launch);
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
		host, transcript: transcriptFromSessionManager(SessionManager.open(sessionPath)), children: [],
	};
	const clock = new ControllableOperationReviewClock();
	const policy = new WorkflowPolicyStore();
	let dispatchAttempts = 0;
	const scheduler = new MessageDeliveryScheduler({
		workflowPolicy: policy, deliveryProgressClock: clock,
		// Retain the queued delivery at its dispatch boundary to test real eligibility.
		scheduleDeliveryDispatch: () => { dispatchAttempts += 1; },
		scheduleReleaseEvaluation: () => {},
	});
	const events: string[] = [];
	launch.onEvent((event) => { events.push(event.event); });
	try {
		await host.lane.run(() => host.startInLane());
		let deliveryCompleted = false;
		const completion = runtime.deliver({ kind: "user", content: "Start the first context window." }).completion
			.then(() => { deliveryCompleted = true; });
		// Observe a fresh snapshot sent after the old settled callback returned:
		// reading native transcript alone could race transport publication.
		await waitUntil(() => SessionManager.open(sessionPath).getEntries().some(
			(entry) => entry.type === "custom" && entry.customType === CONTINUATION_STARTED,
		));
		await runtime.synchronizeState();
		assert.equal(runtime.workState(), "active", JSON.stringify(events));
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
		await writeFile(releasePath, "");
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
		await writeFile(releasePath, "");
		await runtime.dispose();
	}
});

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("continuation did not start");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
