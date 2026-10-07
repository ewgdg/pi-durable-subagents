import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { OperationalIncidentCoordinator } from "../src/coordination/operational-incidents.ts";
import { HumanRequestCoordinator } from "../src/coordination/human-requests.ts";
import type { MessageCoordinator } from "../src/coordination/messages.ts";
import type { ScheduledCustomDelivery } from "../src/coordination/message-delivery-scheduler.ts";
import type { RequestEvidence } from "../src/coordination/request-evidence.ts";
import type { RequestRelationships } from "../src/coordination/request-relationships.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type { OwnerIdentity } from "../src/protocol/owner-identity.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedAgentRuntime } from "../src/runtime/hosted-agent-runtime.ts";
import type { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import { participant } from "./support/request-history.ts";

// The reminder is admitted without awaiting the Agent lane, so an abort already
// queued there can end the stalled Run first. Delivering it then would boot a
// successor Run the supervisor just stopped.
test("an Obligation Reminder is suppressed once the stalled Run it was evaluated for ends", async () => {
	const owner = participant("requester");
	const child = participant("child");
	child.record.identity = { agentId: "child", workflowId: "requester", directSpawnerAgentId: "requester", creationPreset: null,
		spawnSource: { agentId: "requester", entryId: "request-entry", toolCallId: "request-call" }, metadata: { label: "Child", description: "Stalled Run fixture" } };
	const runtime = {
		subscribe: () => () => undefined,
		workState: () => "settled",
		clearQueue: async () => ({ steering: [], followUp: [] }),
		abort: async () => undefined, waitForIdle: async () => undefined, dispose: async () => undefined,
	} as unknown as HostedAgentRuntime;
	child.record.host = AgentRuntimeSupervisor.createChild({ agentId: "child", startSession: async () => ({ runtime }) });
	const reminders: ScheduledCustomDelivery[] = [];
	const messages = {
		subscribeDeliveryProgress() {},
		blockedDeliveries: () => [], answerArbitration: { inspect: (_requester: unknown, requestIds: readonly string[]) => requestIds.map(() => ({ state: "unanswered" })) }, hasDeliveryProgress: () => false,
		shutdownDeliveryProgress() {},
		admitCustomDelivery: async (_recipient: unknown, delivery: ScheduledCustomDelivery) => {
			reminders.push(delivery);
			return "pending";
		},
	} as unknown as MessageCoordinator;
	const requestRelationships = {
		refresh: async () => undefined,
		answerOwedRequestIds: (record: typeof child.record) => record === child.record ? ["request"] : [],
		outstandingRequestIds: (record: typeof owner.record) => record === owner.record ? ["request"] : [],
		obligationFrames: () => [{ requestId: "request" }],
		hasUnsettledAnswerObligation: () => true,
	} as unknown as RequestRelationships;
	const requestEvidence = {
		requestMetadata: () => ({ title: "Fixture request", targetAgentId: "child", source: { agentId: "requester", entryId: "request-entry", toolCallId: "request-call" } }),
	} as unknown as RequestEvidence;
	const incidents = new OperationalIncidentCoordinator({
		agents: new Map([["requester", owner.record], ["child", child.record]]),
		ownerIdentity: owner.record.identity as OwnerIdentity,
		messages, requestEvidence, requestRelationships, workflowPolicy: new WorkflowPolicyStore(),
		humanRequests: new HumanRequestCoordinator({ agents: new Map([["requester", owner.record]]), ownerIdentity: owner.record.identity as OwnerIdentity,
			interruptRun() { throw new Error("Unexpected human interruption"); } }),
		sessionFactory: { admitProcessRuntimePlatform() { throw new Error("Moderator unavailable in fixture"); } } as unknown as ProcessChildSessionFactory,
		integrateAgent() { throw new Error("No Moderator should start"); },
		isShuttingDown: () => false,
		reportError(error) { throw error; },
		retainDiagnostic: () => { throw new Error("No diagnostic expected"); },
		publishRuntimeReport: () => { throw new Error("No Runtime Report expected"); },
		appendRuntimeReportFinding: () => { throw new Error("No Runtime Report expected"); },
		runtimeReportSourceForIncident: () => undefined,
	});
	incidents.integrate(child.record);
	try {
		await child.record.host.lane.run(() => child.record.host.startInLane());
		child.record.host.replaceRequestRelationships({ awaitingAnswerRequestIds: [], answerOwedRequestIds: ["request"] });
		await incidents.reachSafeBoundary();
		assert.equal(reminders.length, 1, "the settled obligated Run is reminded");
		const [reminder] = reminders;
		assert.equal(reminder!.isSuppressed?.(), false);

		await child.record.host.lane.run(() => child.record.host.discardAndEndInLane("abort"));
		assert.equal(child.record.host.observe().phase, "dormant");
		assert.equal(reminder!.isSuppressed?.(), true);
	} finally {
		incidents.shutdown();
	}
});
