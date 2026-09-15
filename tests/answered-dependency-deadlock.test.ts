import type { ReportToUserInput } from "../src/protocol/moderator-report.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MessageCoordinator } from "../src/coordination/messages.ts";
import { OperationalIncidentCoordinator } from "../src/coordination/operational-incidents.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type { OwnerIdentity } from "../src/protocol/owner-identity.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import type { AgentRuntimeHost } from "../src/runtime/agent-runtime-host.ts";
import type { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import { participant, requestHistory } from "./support/request-history.ts";

for (const ownerAnswered of [false, true]) {
	test(`a ${ownerAnswered ? "committed-undelivered Answer does not hide" : "genuine unanswered Owner dependency opens"} the core/publication cycle`, async (t) => {
		const history = requestHistory();
		const owner = history.requester;
		const core = history.responder;
		const publication = participant("publication");
		const upstream = participant("upstream");
		history.agents.set("publication", publication.record);
		history.agents.set("upstream", upstream.record);
		history.request(owner, core);
		history.request(owner, publication);
		const coreToPublication = history.request(core, publication, false);
		const publicationToCore = history.request(publication, core, false);
		history.request(upstream, core, false);
		const coreToOwner = history.request(core, owner);
		if (ownerAnswered) {
			const toolCallId = "owner-answer";
			const entryId = owner.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
				operation: "answer", requestId: coreToOwner, answer: "Proceed.",
			}, { id: toolCallId }), { stopReason: "toolUse" }));
			owner.manager.appendMessage({
				role: "toolResult", toolCallId, toolName: "agent_message", content: [], isError: false, timestamp: Date.now(),
				details: { requestTitle: "Fixture request", messageId: deriveMessageIdentity({ agentId: "requester", entryId, toolCallId }),
					requestMessageId: coreToOwner, messageStatus: "sent" },
			});
		}
		// Only live Runtime observations are adapted; canonical evidence and
		// incident normalization use the production coordination modules.
		for (const record of history.agents.values()) {
			if (record !== owner.record) record.identity = { ...record.identity, directSpawnerAgentId: "requester" } as typeof record.identity;
			const retentionReasons = [{ reason: record === owner.record ? "owner_host_binding" : "awaiting_answer", count: 1 }];
			record.host = {
				observe: () => ({ phase: "live", work: "settled", attention: "agent_wait", retentionReasons }),
				currentRunFailed: () => false,
				hasRetentionReason: (reason: string) => retentionReasons.some(item => item.reason === reason),
			} as unknown as AgentRuntimeHost;
		}
		const workflowPolicy = new WorkflowPolicyStore();
		const messages = new MessageCoordinator({ agents: history.agents, workflowPolicy, isShuttingDown: () => false });
		let creationAttempts = 0;
		const reports: ReportToUserInput[] = [];
		const incidents = new OperationalIncidentCoordinator({
			agents: history.agents, ownerIdentity: owner.record.identity as OwnerIdentity, messages, workflowPolicy,
			sessionFactory: {
				admitProcessRuntimePlatform() { creationAttempts++; throw new Error("Test platform unavailable"); },
			} as unknown as ProcessChildSessionFactory,
			integrateAgent() { throw new Error("Unexpected runtime creation"); },
			isShuttingDown: () => false,
			reportError(error) { throw error; },
			publishRuntimeReport(report) { reports.push(report); },
		appendRuntimeReportFinding() {},
		runtimeReportSourceForIncident() { return undefined; },
			retainDiagnostic: () => ({ agentId: "requester", entryId: owner.manager.appendCustomEntry("diagnostic", {}) }),
		});
		t.after(() => { incidents.shutdown(); messages.shutdownDeliveryProgress(); });
		incidents.deliveryProgressChanged();
		await incidents.reachSafeBoundary();
		assert.equal(creationAttempts, ownerAnswered ? 1 : 0);
		const attention = incidents.attentionItems("requester");
		if (!ownerAnswered) {
			assert.deepEqual(attention, []);
			return;
		}
		assert.equal(attention.length, 1);
		assert.equal(attention[0]!.trigger.kind, "moderation_unavailable");
		assert.ok(reports[0]?.evidence.includes(`Original trigger: ${JSON.stringify({
			kind: "dependency_deadlock",
			agentIds: ["publication", "responder"],
			requests: { total: 2, sources: messages.requestSources([coreToPublication, publicationToCore].sort()) },
		})}`));
		assert.ok(messages.outstandingRequestIdsFor(core.record).includes(coreToOwner),
			"the undelivered Owner Answer remains outstanding for all-answer Wait");
	});
}
