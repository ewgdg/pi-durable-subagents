import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentWaitCoordinator } from "../src/coordination/agent-waits.ts";
import { MessageCoordinator } from "../src/coordination/messages.ts";
import { OperationalIncidentCoordinator } from "../src/coordination/operational-incidents.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type { OwnerIdentity } from "../src/protocol/owner-identity.ts";
import type { AgentRuntimeHost, AgentRunHandle, AgentRuntimeDelivery } from "../src/runtime/agent-runtime-host.ts";
import type { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { participant, requestHistory } from "./support/request-history.ts";

for (const delivered of [false, true]) {
	test(`${delivered ? "proven" : "unproven"} Deferred prompt ${delivered ? "permits" : "excludes"} dependency deadlock handling during agent_wait`, { timeout: 5_000 }, async t => {
		const history = requestHistory();
		const owner = history.requester;
		const worker = history.responder;
		const peer = participant("peer");
		history.agents.set("peer", peer.record);
		const workerToPeer = history.request(worker, peer);
		const peerToWorker = history.request(peer, worker);
		let commitDelivery: (() => void) | undefined;
		let dispatchCount = 0;
		let resolvePrompt!: () => void;
		const prompt = new Promise<void>(resolve => { resolvePrompt = resolve; });
		let promptSettled = false;
		void prompt.then(() => { promptSettled = true; });
		for (const p of [owner, worker, peer]) {
			if (p !== owner) p.record.identity = { ...p.record.identity, directSpawnerAgentId: "requester" } as typeof p.record.identity;
			const handle: AgentRunHandle = { sequence: 1 };
			let attention: "none" | "agent_wait" = "none";
			const retention = new Set(p === owner ? ["owner_host_binding"] : ["awaiting_answer", "answer_owed"]);
			p.record.host = {
				lane: new SerialLane(), currentHandle: () => handle, latestStartedRunSequence: () => 1,
				isCurrent: (candidate: AgentRunHandle) => candidate === handle,
				setRunStartInitializer() {}, addSettledHandler: () => () => {}, addEndedHandler: () => () => {},
				addRetentionReason: (reason: string) => { retention.add(reason); },
				removeRetentionReason: (reason: string) => { retention.delete(reason); },
				hasRetentionReason: (reason: string) => retention.has(reason),
				blocksOrdinaryDelivery: () => false,
				currentWorkState: () => attention === "agent_wait" ? "active" : "settled",
				// The supervisor projects a parked Wait as settled while its native prompt remains active.
				observe: () => ({ phase: "live", work: "settled", attention,
					retentionReasons: [...retention].map(reason => ({ reason, count: 1 })) }),
				currentRunFailed: () => false,
				requestRelationshipIds: () => p === owner ? [] : [p === worker ? peerToWorker : workerToPeer],
				beginAgentWait: () => { attention = "agent_wait"; }, endAgentWait: () => { attention = "none"; },
				releaseIfEligibleInLane: () => "retained",
				deliverInLane: (input: AgentRuntimeDelivery) => {
					assert.equal(p, worker);
					assert.equal(input.kind, "custom");
					if (input.kind !== "custom") throw new Error("Expected custom Delivery");
					dispatchCount++;
					const m = input.message;
					commitDelivery = () => { p.manager.appendCustomMessageEntry(m.customType, m.content, m.display, "details" in m ? m.details : undefined); };
					return { completion: prompt };
				},
			} as unknown as AgentRuntimeHost;
		}
		const workflowPolicy = new WorkflowPolicyStore();
		const messages = new MessageCoordinator({ agents: history.agents, workflowPolicy, isShuttingDown: () => false });
		for (const p of [owner, worker, peer]) messages.integrate(p.record);
		const waits = new AgentWaitCoordinator({ agents: history.agents, messages,
			clock: { schedule: () => () => {} }, suspendExecution() {}, async resumeExecution() {},
		});
		const abort = new AbortController();
		const pendingWaits: Promise<unknown>[] = [];
		let creationAttempts = 0;
		const incidents = new OperationalIncidentCoordinator({
			agents: history.agents, ownerIdentity: owner.record.identity as OwnerIdentity, messages, workflowPolicy,
			sessionFactory: { admitProcessRuntimePlatform() { creationAttempts++; throw new Error("Test platform unavailable"); } } as unknown as ProcessChildSessionFactory,
			integrateAgent() { throw new Error("Unexpected runtime creation"); }, isShuttingDown: () => false,
			reportError(error) { throw error; },
			retainDiagnostic: () => ({ agentId: "requester", entryId: owner.manager.appendCustomEntry("diagnostic", {}) }),
		});
		t.after(async () => {
			incidents.shutdown(); abort.abort(); waits.shutdown();
			await Promise.allSettled(pendingWaits);
			messages.shutdownDeliveryProgress(); resolvePrompt();
		});
		const input = { title: "Deferred task", operation: "request" as const, targetAgent: "responder", question: "Do the task." };
		owner.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", input, { id: "task" }), { stopReason: "toolUse" }));
		const result = await messages.execute("requester", "task", input);
		owner.manager.appendMessage({ role: "toolResult", toolCallId: "task", toolName: "agent_message", content: [], details: result, isError: false, timestamp: Date.now() });
		assert.equal(dispatchCount, 1);
		assert.ok(commitDelivery);
		if (delivered) commitDelivery();
		for (const p of [worker, peer]) {
			p.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: "wait" }), { stopReason: "toolUse" }));
			const waiting = waits.wait(p.record.identity.agentId, "wait", {}, abort.signal);
			pendingWaits.push(waiting);
			void waiting.catch(() => {});
		}
		for (let i = 0; i < 8; i++) await setImmediate();
		for (const p of [worker, peer]) {
			const run = p.record.host.observe();
			assert.equal(run.phase, "live");
			assert.ok("attention" in run && run.attention === "agent_wait");
		}
		assert.equal(promptSettled, false);
		// Repeated queue advancement must not redispatch the original task.
		await messages.deliveryEligibilityChanged(worker.record);
		await messages.deliveryEligibilityChanged(worker.record);
		incidents.deliveryProgressChanged();
		await incidents.reachSafeBoundary();
		assert.equal(creationAttempts, delivered ? 1 : 0);
		if (!delivered) assert.deepEqual(incidents.attentionItems("requester"), []);
		if (delivered) assert.deepEqual(incidents.attentionItems("requester")[0]?.trigger, {
			kind: "dependency_deadlock", agentIds: ["peer", "responder"],
			requests: { total: 2, sources: messages.requestSources([workerToPeer, peerToWorker].sort()) },
		});
		assert.equal(messages.hasDeliveryProgress(worker.record), !delivered);
		assert.equal(dispatchCount, 1, "Delivery is not repeated while its prompt remains unresolved");
		assert.equal(worker.record.host.hasRetentionReason("pending_delivery"), true, "prompt ownership retains its Run");
		worker.record.host.endAgentWait(worker.record.host.currentHandle()!, "wait");
		await messages.admitCustomDelivery(worker.record, {
			messageId: "next-task", deliveryMode: "deferred",
			customMessage: { customType: "agent-coordination.workflow-continuation", content: "Next task", display: true },
			inspectProof: () => undefined,
		});
		assert.equal(dispatchCount, 1, "the unresolved prompt still serializes subsequent Deferred dispatch");
	});
}
