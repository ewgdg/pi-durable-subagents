import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { participantLifecycleHandlers } from "../src/bootstrap/agent-extension.ts";
import { registerParticipantLifecycle } from "../src/pi-integration/participant-lifecycle.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { WorkflowPolicyStore, parseWorkflowPolicy } from "../src/policy/workflow-policy.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
// Settlement must not hold model-execution capacity: Pi runs agent_end before
// agent_before_settle, so executionEnded already released this execution permit.
// Re-admitting at the boundary starves maxConcurrentAgentRuns and makes the
// continuation agent_start beginExecution throw already-holds-capacity (an error
// Pi swallows, leaving stale reconciliation). Real coordinator, quota 1.
// Continuation-with-outstanding-work semantics stay covered by the registrar suite;
// this test pins the permit invariant that makes that continuation possible.
test("settlement boundary holds no execution permit across continuation", { timeout: 15000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => {});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		workflowPolicy: new WorkflowPolicyStore(parseWorkflowPolicy('{"maxConcurrentAgentRuns":1}')),
		incidentBoundaryHooks: { beforeModeratorRunStart: () => "confirmed_failure" },
	});
	const view = coordinator.forAgent(identity.agentId);
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, participantLifecycleHandlers(() => view));
	const context = createExtensionContext(host.session.sessionManager);
	// A live run is what admits execution capacity; establish it before the lifecycle.
	host.model.setResponses([fauxAssistantMessage("Execution established.")]);
	await host.session.prompt("Establish the execution.");
	// The live execution holds the quota-1 permit while it runs.
	await pi.emit("agent_start", { type: "agent_start" }, context);
	await assert.rejects(pi.emit("agent_start", { type: "agent_start" }, context), /already holds Workflow capacity/,
		"the execution permit is really held while the execution is live");
	// Real Pi order: agent_end releases the permit before agent_before_settle reconciles.
	await pi.emit("agent_end", { type: "agent_end", messages: [] }, context);
	assert.equal(await pi.emit("agent_before_settle", { type: "agent_before_settle", context: { canContinue: true } }, context), undefined);
	// The continuation agent_start must not hit a swallowed already-holds-capacity error.
	await pi.emit("agent_start", { type: "agent_start" }, context);
	await pi.emit("agent_end", { type: "agent_end", messages: [] }, context);
	// Permits return to zero: a fresh execution admits cleanly.
	await pi.emit("agent_start", { type: "agent_start" }, context);
	await pi.emit("agent_end", { type: "agent_end", messages: [] }, context);
	assert.deepEqual(context.notifications.filter((notification) => notification.type === "error"), []);
});
type CapturedHandler = (event: never, context: ExtensionContext) => unknown;
class CapturedExtensionApi {
	readonly handlers = new Map<string, CapturedHandler[]>();
	readonly api = {
		on: (eventName: string, handler: CapturedHandler) => {
			const handlers = this.handlers.get(eventName) ?? [];
			handlers.push(handler);
			this.handlers.set(eventName, handlers);
		},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	async emit(eventName: string, event: unknown, context: ExtensionContext): Promise<unknown> {
		const handlers = this.handlers.get(eventName) ?? [];
		assert.equal(handlers.length, 1, eventName);
		return handlers[0]!(event as never, context);
	}
}
function createExtensionContext(sessionManager: SessionManager) {
	let editorText = "";
	const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	const ui = {
		setEditorText(text: string) { editorText = text; },
		getEditorText() { return editorText; },
		notify(message: string, type?: "info" | "warning" | "error") { notifications.push({ message, type }); },
	};
	return Object.assign(
		{ ui, sessionManager, hasPendingMessages: () => false },
		{ notifications },
	) as unknown as ExtensionContext & { notifications: typeof notifications };
}
