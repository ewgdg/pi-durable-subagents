import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createProcessModelBroker } from "./support/process-model-broker.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { discoverColdWorkflow } from "../src/bootstrap/cold-host-discovery.ts";

test("host loss drops a quota stop: the Agent recovers dormant and resumes as ordinary work", { timeout: 30_000 }, async t => {
	const broker = await createProcessModelBroker();
	t.after(() => broker.close());
	const first = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true, additionalExtensionPaths: [broker.extensionPath],
		settings: { retry: { enabled: false } },
	});
	await bindTestOwnerHost(first, "tui");
	const identity = adoptOrValidateOwnerIdentity(first.runtime);
	const initial = await createTestWorkflowCoordinator(first, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
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
	const coordinator = await createTestWorkflowCoordinator(reopened, recoveredIdentity, { entryModulePath: "<inline:pi-durable-subagents>", recoveredWorkflow: recovered });
	const view = coordinator.forAgent(identity.agentId);
	// The stop was process-local: recovery leaves ordinary dormant work, not a stop.
	assert.equal(view.status(agentId).run.phase, "dormant");
	assert.equal(view.status(agentId).run.suspension, undefined);
	assert.deepEqual(coordinator.forAgent(agentId).obligationFrames(), originalObligations);
	// The editor is prepared passively, and nothing the workflow recovers starts a Run.
	const retainedView = await view.openAgentPresentation(agentId);
	assert.equal(retainedView.kind, "selected");
	if (retainedView.kind !== "selected" || !retainedView.view) assert.fail("Expected a prepared editor without model generation");
	const projection = retainedView.view.projection();
	const detach = await projection.physicalTerminal.beginAttachment(() => undefined);
	t.after(async () => { detach(); await projection.physicalTerminal.endAttachment(); });
	assert.equal(unexpectedGenerations, 0, "cold recovery and passive preparation generate nothing");
	// The explicit resume re-admits captured undelivered work. The previously stopped
	// child is ordinary dormant work now, so its queued steer Message starts a successor
	// Run instead of staying suppressed. Quota is still exhausted, so that attempt stops
	// again on the same evidence without producing model output.
	broker.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: '{"error":{"code":"usage_limit_reached"}}' })]);
	reopened.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("workflow_resume", {}, { id: "cold-recovery" }), { stopReason: "toolUse" }));
	await view.resumeWorkflow("cold-recovery");
	for (let index = 0; index < 3; index++) {
		await view.reachSafeBoundary();
		await new Promise(resolve => setTimeout(resolve, 30));
	}
	const childEntries = () => JSON.stringify(SessionManager.open(originalStatus.primaryEvidence.transcriptPath!).getEntries());
	assert.equal(childEntries().includes("PRESERVED_QUEUE"), true, "explicit recovery re-admits the captured Message");
	assert.equal(view.status(agentId).run.suspension?.evidence.diagnostic, '{"error":{"code":"usage_limit_reached"}}', "a re-attempt on exhausted quota stops again");
	assert.equal(childEntries().includes("UNEXPECTED_AUTOMATIC_WAKE"), false, "recovery itself never generates");
	// A human message in the resumed Agent's editor is the deliberate retry.
	broker.setResponses([fauxAssistantMessage("EXPLICIT_RESUME_AFTER_RESTART")]);
	projection.dispatchInput("Continue the original work after my account change.");
	projection.dispatchInput("\r");
	await until(() => Boolean(view.status(agentId).primaryEvidence.transcriptPath) && JSON.stringify(
		SessionManager.open(view.status(agentId).primaryEvidence.transcriptPath!).getEntries(),
	).includes("Continue the original work after my account change."));
	assert.equal(view.status(agentId).run.suspension, undefined);
	await until(() => view.status(agentId).run.phase === "dormant", "the resumed Run must end before teardown");
	assert.equal(view.status(agentId).primaryEvidence.transcriptPath, originalStatus.primaryEvidence.transcriptPath);
	assert.deepEqual(coordinator.forAgent(agentId).obligationFrames(), originalObligations);
});

async function until(predicate: () => boolean, description = "quota lifecycle condition"): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, `${description} timed out`);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}
