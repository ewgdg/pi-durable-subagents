import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createProcessModelBroker } from "./support/process-model-broker.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { discoverColdWorkflow } from "../src/bootstrap/cold-host-discovery.ts";

test("cold recovery prepares a suspended editor without generation, then resumes on its human message", { timeout: 30_000 }, async t => {
	const broker = await createProcessModelBroker();
	t.after(() => broker.close());
	const first = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true, additionalExtensionPaths: [broker.extensionPath],
		settings: { retry: { enabled: false } },
	});
	await bindTestOwnerHost(first, "tui");
	const identity = adoptOrValidateOwnerIdentity(first.runtime);
	const initial = await createTestWorkflowCoordinator(first, identity, { entryModulePath: "<inline:pi-agent-coordination>" });
	const initialView = initial.forAgent(identity.agentId);
	const spawn = { title: "Cold quota", request: "Keep this original obligation." };
	first.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", spawn, { id: "spawn-cold-quota" }), { stopReason: "toolUse" }));
	broker.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: '{"error":{"code":"usage_limit_reached"}}' })]);
	const receipt = await initialView.spawn("spawn-cold-quota", spawn);
	first.session.sessionManager.appendMessage({ role: "toolResult", toolName: "agent_spawn", toolCallId: "spawn-cold-quota", details: receipt, content: [{ type: "text", text: JSON.stringify(receipt) }], isError: false, timestamp: Date.now() });
	assert.ok("agentId" in receipt);
	const agentId = receipt.agentId;
	await until(() => Boolean(initialView.status(agentId).run.suspension));
	const originalStatus = initialView.status(agentId);
	const originalObligations = initial.forAgent(agentId).obligationFrames();
	const queued = { operation: "send" as const, targetAgent: agentId, content: "PRESERVED_QUEUE", deliveryMode: "steer" as const };
	first.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", queued, { id: "queue-cold-quota" }), { stopReason: "toolUse" }));
	const queuedReceipt = await initialView.message("queue-cold-quota", queued);
	first.session.sessionManager.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId: "queue-cold-quota", details: queuedReceipt, content: [{ type: "text", text: JSON.stringify(queuedReceipt) }], isError: false, timestamp: Date.now() });
	const sessionFile = first.session.sessionManager.getSessionFile()!;
	await initial.shutdown(() => first.runtime.dispose());
	let unexpectedGenerations = 0;
	broker.setResponses([() => { unexpectedGenerations++; return fauxAssistantMessage("UNEXPECTED_AUTOMATIC_WAKE"); }]);
	const reopened = await createUnboundTestOwnerHost(t, () => undefined, {
		cwd: first.cwd, agentDir: first.services.agentDir, sessionFile,
		additionalExtensionPaths: [broker.extensionPath], settings: { retry: { enabled: false } },
	});
	await bindTestOwnerHost(reopened, "tui");
	const recoveredIdentity = adoptOrValidateOwnerIdentity(reopened.runtime);
	const recovered = await discoverColdWorkflow({ ownerIdentity: recoveredIdentity, ownerSessionManager: reopened.session.sessionManager });
	const coordinator = await createTestWorkflowCoordinator(reopened, recoveredIdentity, { entryModulePath: "<inline:pi-agent-coordination>", recoveredWorkflow: recovered });
	const view = coordinator.forAgent(identity.agentId);
	assert.equal(view.status(agentId).run.phase, "live");
	assert.deepEqual(view.status(agentId).run.suspension, originalStatus.run.suspension);
	assert.deepEqual(coordinator.forAgent(agentId).obligationFrames(), originalObligations);
	assert.ok(view.status(agentId).run.retentionReasons.some(reason => reason.reason === "answer_owed"));
	assert.deepEqual(view.reportHistory(), [], "recovery publishes no quota report");
	const retainedView = await view.openAgentPresentation(agentId);
	assert.equal(retainedView.kind, "selected");
	if (retainedView.kind !== "selected" || !retainedView.view) assert.fail("Expected a prepared editor without model generation");
	assert.ok(view.status(agentId).run.suspension, "navigation preserves the quota stop");
	const projection = retainedView.view.projection();
	const detach = await projection.physicalTerminal.beginAttachment(() => undefined);
	t.after(async () => { detach(); await projection.physicalTerminal.endAttachment(); });
	reopened.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("workflow_resume", {}, { id: "cold-recovery" }), { stopReason: "toolUse" }));
	await view.resumeWorkflow("cold-recovery");
	for (let index = 0; index < 3; index++) {
		await view.reachSafeBoundary();
		await new Promise(resolve => setTimeout(resolve, 30));
	}
	assert.equal(unexpectedGenerations, 0);
	assert.ok(view.status(agentId).run.suspension);
	assert.equal(JSON.stringify(SessionManager.open(originalStatus.primaryEvidence.transcriptPath!).getEntries()).includes("PRESERVED_QUEUE"), false);
	broker.setResponses([fauxAssistantMessage("EXPLICIT_COLD_RESUME")]);
	retainedView.view.projection().dispatchInput("Continue the original work after my account change.");
	retainedView.view.projection().dispatchInput("\r");
	await until(() => !view.status(agentId).run.suspension);
	assert.ok(JSON.stringify(SessionManager.open(originalStatus.primaryEvidence.transcriptPath!).getEntries()).includes("Continue the original work after my account change."));
	assert.equal(view.status(agentId).primaryEvidence.transcriptPath, originalStatus.primaryEvidence.transcriptPath);
	assert.deepEqual(coordinator.forAgent(agentId).obligationFrames(), originalObligations);
	const checkpoints = reopened.session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "agent-coordination.quota-suspension");
	assert.deepEqual(checkpoints.map(entry => {
		const data = entry.type === "custom" ? entry.data as { operation: string; runSequence: number } : undefined;
		return [data?.operation, data?.runSequence];
	}), [["suspend", 1], ["clear", 1]]);
});

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "quota lifecycle condition timed out");
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}
