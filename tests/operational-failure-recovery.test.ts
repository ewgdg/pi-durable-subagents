import assert from "node:assert/strict";
import test from "node:test";
import { OperationalIncidentCoordinator } from "../src/coordination/operational-incidents.ts";
import { ModeratorReportStore } from "../src/coordination/moderator-reports.ts";
import type { MessageCoordinator } from "../src/coordination/messages.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type { OwnerIdentity } from "../src/protocol/owner-identity.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedAgentRuntime } from "../src/runtime/hosted-agent-runtime.ts";
import type { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import { participant } from "./support/request-history.ts";

test("a successor after obligation clearance appends to the retained failed Run report", async () => {
	const owner = participant("requester");
	const child = participant("child");
	child.record.identity = { agentId: "child", workflowId: "requester", directSpawnerAgentId: "requester", creationPreset: null,
		spawnSource: { agentId: "requester", entryId: "request-entry", toolCallId: "request-call" }, metadata: { label: "Child", description: "Failed Run fixture" } };
	let failStartup = true;
	let obligationRemains = true;
	let shuttingDown = false;
	const runtime = {
		subscribe: () => () => undefined,
		workState: () => "settled",
		clearQueue: async () => ({ steering: [], followUp: [] }),
		abort: async () => undefined, waitForIdle: async () => undefined, dispose: async () => undefined,
	} as unknown as HostedAgentRuntime;
	child.record.host = AgentRuntimeSupervisor.createChild({ agentId: "child", startSession: async () => {
		if (failStartup) throw new Error("Original startup failed");
		return { runtime };
	} });
	const reports = new ModeratorReportStore({ transcript: owner.record.transcript, appendCustomEntry: (type, data) => owner.manager.appendCustomEntry(type, data) });
	const messages = {
		refreshTranscriptFacts: async () => undefined,
		answerObligationRequestIds: () => ["request"], outstandingRequestIdsFor: () => [],
		hasUnsettledAnswerObligation: () => obligationRemains,
		requestSources: () => [{ agentId: "requester", entryId: "request-entry", toolCallId: "request-call" }],
		blockedDeliveries: () => [], unansweredRequestRelationships: () => [],
		shutdownDeliveryProgress() {},
	} as unknown as MessageCoordinator;
	const incidents = new OperationalIncidentCoordinator({
		agents: new Map([["requester", owner.record], ["child", child.record]]),
		ownerIdentity: owner.record.identity as OwnerIdentity,
		messages, workflowPolicy: new WorkflowPolicyStore(),
		sessionFactory: { admitProcessRuntimePlatform() { throw new Error("Moderator unavailable in fixture"); } } as unknown as ProcessChildSessionFactory,
		integrateAgent() { throw new Error("No Moderator should start"); },
		isShuttingDown: () => shuttingDown,
		reportError(error) { throw error; },
		retainDiagnostic: error => ({ agentId: "requester", entryId: owner.manager.appendCustomEntry("diagnostic", String(error)) }),
		publishRuntimeReport: (input, source, incidentKey) => { reports.publishRuntime(input, { ...source, incidentKey, kind: "runtime_diagnostic", transcriptPath: "/tmp/owner-evidence.jsonl" }); },
		appendRuntimeReportFinding: (source, finding) => reports.appendRuntimeFinding(source, finding),
		runtimeReportSourceForIncident: key => reports.runtimeSourceForIncident(key),
	});
	incidents.integrate(child.record);
	try {
		await assert.rejects(child.record.host.lane.run(() => child.record.host.startInLane()), /Original startup failed/);
		await incidents.reachSafeBoundary();
		const original = reports.history()[0]!;
		assert.ok(original);
		reports.setRead(original.report.reportId, true);
		// Control the durable-obligation observation independently of Delivery:
		// cancellation must clear handling before any successor Run is admitted.
		obligationRemains = false;
		incidents.deliveryProgressChanged();
		await incidents.reachSafeBoundary();
		assert.ok(reports.history()[0]?.findings?.some(finding => finding.key === "condition-cleared"));
		assert.equal(reports.history()[0]?.readAt, undefined);
		reports.setRead(original.report.reportId, true);
		failStartup = false;
		await child.record.host.lane.run(() => child.record.host.startInLane());
		await incidents.reachSafeBoundary();
		const updated = reports.history()[0]!;
		assert.ok(updated.findings?.some(finding => finding.key === "successor:2"));
		assert.deepEqual(updated.report, original.report);
		assert.equal(updated.readAt, undefined, "later successor evidence restores attention after re-acknowledgment");
		assert.equal(reports.history().length, 1);
	} finally {
		shuttingDown = true;
		incidents.shutdown();
		await child.record.host.lane.run(() => child.record.host.discardAndEndInLane("shutdown"));
	}
});
