import assert from "node:assert/strict";
import test from "node:test";
import { OperationalIncidentCoordinator } from "../src/coordination/operational-incidents.ts";
import { MessageCoordinator } from "../src/coordination/messages.ts";
import { HumanRequestCoordinator } from "../src/coordination/human-requests.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type { OwnerIdentity } from "../src/protocol/owner-identity.ts";
import type { AgentRuntimeHost } from "../src/runtime/agent-runtime-host.ts";
import type { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import { participant, requestHistory } from "./support/request-history.ts";
import { requestCoordination } from "./support/request-coordination.ts";

for (const cycle of ["none", "suspended", "upstream"]) for (const unrelated of [false, true]) {
	test(`a quota-suspended dependency keeps its requester Waiting (unrelated branch: ${unrelated}, cycle: ${cycle})`, async (t) => {
		const history = requestHistory();
		const leaf = participant("quota-leaf");
		history.agents.set("quota-leaf", leaf.record);
		const rootRequest = history.request();
		const leafRequest = history.request(history.responder, leaf);
		const incoming = new Map([["responder", [rootRequest]], ["quota-leaf", [leafRequest]]]);
		if (cycle === "suspended") incoming.get("responder")!.push(history.request(leaf, history.responder));
		if (cycle === "upstream") {
			const bridge = participant("bridge");
			history.agents.set("bridge", bridge.record);
			incoming.set("bridge", [history.request(history.responder, bridge)]);
			incoming.get("responder")!.push(history.request(bridge, history.responder));
		}
		if (unrelated) {
			const other = participant("other");
			history.agents.set("other", other.record);
			incoming.set("other", [history.request(history.responder, other)]);
		}
		let suspended = true;
		for (const [agentId, record] of history.agents) {
			if (agentId !== "requester") record.identity = { ...record.identity, directSpawnerAgentId: "requester" } as typeof record.identity;
			// Each fixture host reports one live Run; its handle stays current.
			const liveRun = { sequence: 1 };
			record.host = {
				currentHandle: () => liveRun,
				isCurrent: (handle: unknown) => handle === liveRun,
				observe: () => ({ phase: "live", work: "settled", attention: agentId === "requester" ? "agent_wait" : "none", retentionReasons: [{ reason: "answer_owed", count: 1 }],
					suspension: agentId === "quota-leaf" && suspended ? { reason: "provider_quota", evidence: {} } : undefined }),
				currentRunSuspension: () => agentId === "quota-leaf" && suspended ? { reason: "provider_quota", evidence: {} } : undefined,
				currentRunFailed: () => false,
				blocksOrdinaryDelivery: () => false,
				hasRetentionReason: () => false,
				requestRelationshipIds: (kind: string) => kind === "answer_owed" ? incoming.get(agentId) ?? [] : [],
			} as unknown as AgentRuntimeHost;
		}
		const policy = new WorkflowPolicyStore();
		const coordination = requestCoordination(history.agents);
		const messages = new MessageCoordinator({ agents: history.agents, ...coordination, workflowPolicy: policy, isShuttingDown: () => false });
		// Exercise incident filtering even if a previously expired delivery watcher
		// still reports the recipient when its quota suspension arrives.
		messages.blockedDeliveries = () => suspended ? [{
			messageId: leafRequest, recipientAgentId: "quota-leaf",
			reason: { kind: "scheduling_failure", diagnostic: "Previously failed admission" },
		}] : [];
		const reminded: string[] = [];
		messages.admitCustomDelivery = async (record) => { reminded.push(record.identity.agentId); return "pending"; };
		const errors: unknown[] = [];
		const incidents = new OperationalIncidentCoordinator({
			agents: history.agents, ownerIdentity: history.requester.record.identity as OwnerIdentity,
			messages, ...coordination, workflowPolicy: policy,
			humanRequests: new HumanRequestCoordinator({ agents: history.agents, ownerIdentity: history.requester.record.identity as OwnerIdentity,
				interruptRun() { assert.fail("No human interruption expected"); } }),
			sessionFactory: {} as ProcessChildSessionFactory,
			integrateAgent() { assert.fail("No Moderator expected"); },
			isShuttingDown: () => false, reportError: error => errors.push(error),
			retainDiagnostic: error => { errors.push(error); return { agentId: "requester", entryId: "diagnostic" }; },
			publishRuntimeReport() {}, appendRuntimeReportFinding() {}, runtimeReportSourceForIncident() { return undefined; },
		});
		t.after(() => incidents.shutdown());
		incidents.reconcileCommittedToolResults("requester");
		await incidents.reachSafeBoundary();
		assert.deepEqual(errors, []);
		// Best branch wins: one Waiting (suspended) dependency keeps the requester and
		// its upstream bridge from Stalling, while the unrelated stalled leaf still
		// receives its own reminder.
		assert.deepEqual(reminded.sort(), unrelated ? ["other"] : []);
		if (cycle !== "none") return;
		// Explicit clearance restores ordinary incident observation; no timer retries it.
		suspended = false;
		reminded.length = 0;
		incidents.reconcileCommittedToolResults("requester");
		await incidents.reachSafeBoundary();
		assert.ok(reminded.includes("quota-leaf"));
		assert.deepEqual(errors, []);
	});
}
