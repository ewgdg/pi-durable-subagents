import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { WorkflowCoordinator, type OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { registerSessionStartup } from "../src/pi-integration/session-startup.ts";
import { registerParticipantInputLifecycle } from "../src/pi-integration/participant-lifecycle.ts";
import { participantLifecycleHandlers } from "../src/bootstrap/agent-extension.ts";

test("repaired Owner retains obligations across native thinking changes until new human input", { timeout: 10000 }, async (t) => {
	let owner!: OrdinaryAgentCoordinatorView;
	const host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		registerParticipantInputLifecycle(pi, participantLifecycleHandlers(() => owner));
		pi.registerCommand("test-navigation", { handler: async () => { await owner.reachSafeBoundary(); } });
	});
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const manager = host.session.sessionManager;
	const toolCallId = "self-request";
	const entryId = manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: identity.agentId, title: "Retained request", question: "Wait for human permission.",
	}, { id: toolCallId })));
	const source = { agentId: identity.agentId, entryId, toolCallId };
	const requestMessageId = deriveMessageIdentity(source);
	manager.appendMessage({ role: "toolResult", toolName: "agent_message", toolCallId, content: [], isError: false, timestamp: Date.now(), details: { requestMessageId, targetAgentId: identity.agentId, messageStatus: "sent" } });
	const delivery = createMessageDelivery([{ source, projection: { kind: "request", requestMessageId, fromAgentId: identity.agentId, title: "Retained request", question: "Wait for human permission." } }]);
	manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Saved marker" }], timestamp: Date.now() });
	const coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:test>", waitForHumanInput: true,
	});
	t.after(() => coordinator.shutdown(async () => undefined));
	await coordinator.initialize();
	owner = coordinator.forAgent(identity.agentId);
	const before = manager.getEntries().length;
	let starts = 0;
	const unsubscribe = host.session.subscribe(event => { if (event.type === "agent_start") starts++; });
	t.after(unsubscribe);
	host.session.setThinkingLevel("high");
	await owner.reachSafeBoundary();
	await owner.reachSafeBoundary();
	await host.session.prompt("/test-navigation");
	await host.session.prompt("Do not resume from an extension", { source: "extension" });
	assert.equal(starts, 0, "a native state change must not generate a reminder turn");
	assert.deepEqual(manager.getEntries().slice(before).filter(entry => entry.type !== "thinking_level_change"), [], "gate before empty user or reminder persistence");
	assert.equal(owner.openIncomingRequests().requests.length, 1, "repair must preserve the Answer obligation");
	assert.equal(owner.humanInputMode(), "awaiting_human");
	await host.session.prompt("Please continue now.");
	assert.equal(starts, 1);
	assert.equal(owner.humanInputMode(), "agent");
});
