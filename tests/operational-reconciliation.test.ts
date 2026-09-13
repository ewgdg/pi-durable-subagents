import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { MessageCoordinator } from "../src/coordination/messages.ts";
import { OperationalIncidentCoordinator } from "../src/coordination/operational-incidents.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import { AgentTranscript, type TranscriptInspection } from "../src/transcript/agent-transcript.ts";
import { createTestOwnerHost, type TestCleanupRegistrar } from "./support/pi-host.ts";

test("a burst of host changes shares one fresh reconciliation after yielding to native events", async (t) => {
	const harness = await reconciliationHarness(t);
	let nativeEventHandled = false;
	const nativeEvent = setImmediate().then(() => { nativeEventHandled = true; });
	let inspections = 0;
	harness.onInspection(() => {
		inspections += 1;
		assert.equal(nativeEventHandled, true, "reconciliation must yield before scanning evidence");
	});

	for (let change = 0; change < 20; change += 1) {
		harness.owner.host.addRetentionReason("interactive_selection");
		harness.owner.host.removeRetentionReason("interactive_selection");
	}
	await harness.incidents.reachSafeBoundary();
	await nativeEvent;

	assert.deepEqual(harness.errors, []);
	assert.equal(inspections, 1, "one pending burst must acquire evidence only once");
});

test("a change during reconciliation gets fresh evidence in a successor pass after native events", async (t) => {
	const harness = await reconciliationHarness(t);
	let inspections = 0;
	let nativeEventHandled = false;
	let sawNewSource = false;
	harness.onInspection((snapshot) => {
		inspections += 1;
		if (inspections === 1) {
			void setImmediate().then(() => { nativeEventHandled = true; });
			harness.addCreationRequest("later-worker");
			return;
		}
		assert.equal(nativeEventHandled, true, "a successor must yield to native events");
		sawNewSource ||= snapshot.entries.some((entry) =>
			entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some((part) =>
				part.type === "toolCall" && part.id === "spawn-later-worker"
			)
		);
	});

	harness.owner.host.addRetentionReason("interactive_selection");
	await harness.incidents.reachSafeBoundary();
	// The first boundary predates the state change produced during its pass.
	await harness.incidents.reachSafeBoundary();

	assert.deepEqual(harness.errors, []);
	assert.equal(sawNewSource, true, "the successor must see the new durable Request source");
	assert.ok(inspections >= 2 && inspections <= 3, "only the two required passes inspect evidence");
});

test("a failed reconciliation reports once and does not prevent a later pass", async (t) => {
	const harness = await reconciliationHarness(t);
	const failure = new Error("Transcript read failed");
	harness.onInspection(() => { throw failure; });
	harness.owner.host.addRetentionReason("interactive_selection");
	harness.owner.host.removeRetentionReason("interactive_selection");
	await harness.incidents.reachSafeBoundary();
	assert.deepEqual(harness.errors, [failure]);

	let inspected = false;
	harness.onInspection(() => { inspected = true; });
	harness.owner.host.addRetentionReason("interactive_selection");
	await harness.incidents.reachSafeBoundary();
	assert.equal(inspected, true);
	assert.deepEqual(harness.errors, [failure]);
});

test("shutdown fences pending operational reconciliation before inspecting evidence", async (t) => {
	const harness = await reconciliationHarness(t);
	harness.onInspection(() => { throw new Error("Shutdown must fence pending inspection"); });
	harness.owner.host.addRetentionReason("interactive_selection");
	harness.shutdown();
	await harness.incidents.reachSafeBoundary();
	assert.deepEqual(harness.errors, []);
});

async function reconciliationHarness(t: TestCleanupRegistrar) {
	const host = await createTestOwnerHost(t, () => undefined);
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const reader = transcriptFromSessionManager(host.session.sessionManager);
	let inspect: (snapshot: TranscriptInspection) => void = () => undefined;
	const owner: AgentRecord = {
		identity,
		host: AgentRuntimeSupervisor.bindOwner(host.runtime),
		transcript: new AgentTranscript({
			read() {
				const snapshot = reader.inspect();
				inspect(snapshot);
				return snapshot;
			},
		}),
		children: [],
	};
	const agents = new Map([[identity.agentId, owner]]);
	const workflowPolicy = new WorkflowPolicyStore();
	let shuttingDown = false;
	const messages = new MessageCoordinator({
		agents,
		isShuttingDown: () => shuttingDown,
		workflowPolicy,
	});
	const sessionFactory = new ProcessChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity: identity,
		entryModulePath: "<inline:pi-agent-coordination>",
		resolveAgent: (agentId) => agents.get(agentId),
		ownerRequestHandlers() {
			throw new Error("This active Request graph must not start a Moderator");
		},
	});
	const errors: unknown[] = [];
	const incidents = new OperationalIncidentCoordinator({
		agents,
		ownerIdentity: identity,
		sessionFactory,
		messages,
		workflowPolicy,
		integrateAgent() { throw new Error("Unexpected Moderator"); },
		isShuttingDown: () => shuttingDown,
		reportError: (error) => errors.push(error),
		retainDiagnostic: (error) => {
			errors.push(error);
			return { agentId: identity.agentId, entryId: host.session.sessionManager.appendCustomEntry("test-diagnostic", String(error)) };
		},
	});
	incidents.integrate(owner);
	function shutdown() {
		shuttingDown = true;
		incidents.shutdown();
	}
	t.after(async () => {
		shutdown();
		await incidents.reachSafeBoundary();
	});
	function addCreationRequest(childId: string): string {
		const toolCallId = `spawn-${childId}`;
		const entryId = host.session.sessionManager.appendMessage(fauxAssistantMessage(
			fauxToolCall("agent_spawn", { title: "Fixture request", request: `Complete ${childId}.` }, { id: toolCallId }),
			{ stopReason: "toolUse" },
		));
		const source = { agentId: identity.agentId, entryId, toolCallId };
		const child: AgentRecord = {
			identity: {
				agentId: childId,
				workflowId: identity.agentId,
				directSpawnerAgentId: identity.agentId,
				creationPreset: null,
				spawnSource: source,
				metadata: { label: childId },
			},
			host: AgentRuntimeSupervisor.createChild({
				agentId: childId,
				async startSession() { throw new Error("Request lookup must not start a Run"); },
			}),
			transcript: transcriptFromSessionManager(SessionManager.inMemory(host.cwd, { id: childId })),
			children: [],
		};
		agents.set(childId, child);
		owner.children.push(childId);
		const requestId = deriveMessageIdentity(source);
		owner.host.addRetentionReason("awaiting_answer", requestId);
		return requestId;
	}
	addCreationRequest("worker");
	await incidents.reachSafeBoundary();
	return {
		owner,
		incidents,
		errors,
		addCreationRequest,
		shutdown,
		onInspection(handler: typeof inspect) { inspect = handler; },
	};
}
