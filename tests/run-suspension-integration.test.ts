import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import type { AgentRunState } from "../src/runtime/agent-runtime-host.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import { createViewBackedParticipantHandlers } from "../src/coordination/view-backed-participant-handlers.ts";
import { registerParticipantLifecycle } from "../src/pi-integration/participant-lifecycle.ts";

function suspension(run: AgentRunState) { return run.phase === "dormant" ? undefined : run.suspension; }

async function until(predicate: () => boolean, description: string) {
	const deadline = Date.now() + 12_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, description);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

async function harness(t: TestContext, retry = false, nativeOwnerLifecycle = false) {
	let view!: OrdinaryAgentCoordinatorView;
	const host = await createUnboundTestOwnerHost(t, pi => {
		if (nativeOwnerLifecycle) registerParticipantLifecycle(pi, createViewBackedParticipantHandlers("owner", () => view).lifecycle);
	}, {
		persistent: true, processVisibleModel: true,
		settings: { retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 } },
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	view = coordinator.forAgent(identity.agentId);
	let sequence = 0;
	function call(tool: string, input: Record<string, unknown>) {
		const id = `suspension-integration-${++sequence}`;
		host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall(tool, input as JsonObject, { id }), { stopReason: "toolUse" }));
		return id;
	}
	async function spawn() {
		const input = { title: "Suspension lifecycle", request: "Keep this Request outstanding until explicitly resumed." };
		const receipt = await view.spawn(call("agent_spawn", input), input);
		assert.ok("agentId" in receipt);
		return receipt.agentId;
	}
	return { host, view, coordinator, identity, call, spawn };
}

test("process Workflow retains a suspended child Run and admits independent progress until explicit resume", { timeout: 35_000 }, async t => {
	const { host, view, coordinator, call, spawn } = await harness(t);
	host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 child runtime failure" })]);
	const agentId = await spawn();
	// The Request's commit proof and the Run's stop arrive as independent child
	// events, so the owed Answer can attach just after the suspension is observable.
	await until(() => {
		const run = view.status(agentId).run;
		return suspension(run)?.reason === "runtime_error" && run.retentionReasons.some(item => item.reason === "answer_owed");
	}, "suspension must retain the owed Answer");
	assert.equal(
		view.selectionRoster().live.some(agent => agent.label.startsWith("Moderator")),
		false,
		"a child runtime error creates no Moderator",
	);
	const suspended = view.status(agentId);
	assert.equal(suspended.run.phase, "live");
	const obligations = coordinator.forAgent(agentId).obligationFrames();
	assert.equal(obligations.length, 1);
	const transcript = suspended.primaryEvidence.transcriptPath!;
	const entries = () => SessionManager.open(transcript).getEntries();
	const reminders = () => entries().filter(entry => entry.type === "custom_message" && entry.customType === "agent-coordination.obligation-reminder").length;
	const beforeReminders = reminders();
	const selected = await view.openAgentView(agentId);
	assert.ok(selected);
	const message = { operation: "send" as const, targetAgent: agentId, content: "QUEUED_BEHIND_SUSPENSION", deliveryMode: "steer" as const };
	await view.message(call("agent_message", message), message);
	for (let index = 0; index < 3; index++) {
		view.refreshAgentActivity();
		await view.reachSafeBoundary();
		await new Promise(resolve => setTimeout(resolve, 30));
	}
	assert.ok(suspension(view.status(agentId).run));
	assert.equal(JSON.stringify(entries()).includes("QUEUED_BEHIND_SUSPENSION"), false);
	assert.equal(reminders(), beforeReminders);
	assert.deepEqual(view.reportHistory(), [], "a suspension is not a reportable incident");
	host.model.setResponses([fauxAssistantMessage("INDEPENDENT_PROGRESS"), fauxAssistantMessage("Independent reminder acknowledged.")]);
	const independent = await spawn();
	await until(() => {
		const path = view.status(independent).primaryEvidence.transcriptPath;
		if (!path) return false;
		const run = view.status(independent).run;
		const entries = SessionManager.open(path).getEntries();
		return entries.some(entry => entry.type === "custom_message" && entry.customType === "agent-coordination.obligation-reminder") && run.phase === "live" && run.work === "settled" && !run.retentionReasons.some(item => item.reason === "pending_delivery");
	}, "independent reminder settles before changing shared responses");
	host.model.setResponses([fauxAssistantMessage("EXPLICIT_RESUME_PROGRESS"), fauxAssistantMessage("Queued message acknowledged."), fauxAssistantMessage("Resumed reminder acknowledged.")]);
	const resume = { operation: "resume" as const, agentId, content: "Resume only by explicit authorization." };
	const receipt = await view.control(call("agent_control", resume), resume);
	assert.ok("messageStatus" in receipt);
	assert.equal(receipt.messageStatus, "sent");
	await until(() => !suspension(view.status(agentId).run), "explicit resume clears suspension");
	assert.equal(view.status(agentId).primaryEvidence.transcriptPath, transcript);
	assert.ok(view.status(agentId).run.retentionReasons.some(item => item.reason === "answer_owed"));
	assert.deepEqual(coordinator.forAgent(agentId).obligationFrames(), obligations);
	await until(() => JSON.stringify(entries()).includes("EXPLICIT_RESUME_PROGRESS"), "the resumed Run continues in the same Agent");
	assert.deepEqual(view.reportHistory(), []);
});

test("native Workflow suspends a terminal error without Run Failure and resumes only on explicit Owner input", { timeout: 15_000 }, async t => {
	const { host, view, identity } = await harness(t, false, true);
	host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 unrelated terminal failure" })]);
	await host.session.prompt("Exercise a native terminal error.");
	await until(() => Boolean(suspension(view.status(identity.agentId).run)), "native suspension");
	assert.deepEqual(suspension(view.status(identity.agentId).run), {
		reason: "runtime_error",
		evidence: {
			stage: "model",
			error: "400 unrelated terminal failure",
			provenance: "native-session-driver",
		},
	});
	assert.deepEqual(view.reportHistory(), [], "a Runtime error stop publishes no report");
	assert.equal(view.status(identity.agentId).run.phase, "live");
	await view.reachSafeBoundary();
	assert.ok(suspension(view.status(identity.agentId).run));
	await assert.rejects(view.beginExecution(), /run_suspended/);
	// Root tool execution start and Agent Wait resume share this guard.
	assert.throws(() => view.assertNotShutDownOrSuspended(), /run_suspended/);
	assert.ok(suspension(view.status(identity.agentId).run));
	let programmaticGenerations = 0;
	host.model.setResponses([() => { programmaticGenerations++; return fauxAssistantMessage("PROGRAMMATIC_MUST_NOT_GENERATE"); }]);
	await host.session.sendUserMessage("Extension input must not resume the stop")
		.catch(error => assert.match(String(error), /run_suspended/));
	assert.ok(suspension(view.status(identity.agentId).run));
	assert.equal(programmaticGenerations, 0);
	host.model.setResponses([fauxAssistantMessage("Owner explicitly resumed")]);
	const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
	// An RPC client is the human of a headless Owner session.
	await host.session.prompt("Continue after I changed the account", { source: "rpc", images: [image] });
	await until(() => !suspension(view.status(identity.agentId).run), "explicit Owner resume");
	// The fixture model is text-only, so Pi omits the forwarded image with a hint.
	assert.ok(host.session.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "user" &&
		JSON.stringify(entry.message.content) === JSON.stringify([{ type: "text",
			text: "Continue after I changed the account\n\n[Image omitted: could not be resized below the inline image size limit.]" }])));
});

test("temporary throttle uses native retry rather than suspension", { timeout: 15_000 }, async t => {
	const { host, view, identity } = await harness(t, true);
	const retries: boolean[] = [];
	host.session.subscribe(event => { if (event.type === "agent_end") retries.push(event.willRetry); });
	host.model.setResponses([
		fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Too Many Requests" }),
		fauxAssistantMessage("Native retry recovered"),
	]);
	await host.session.prompt("Retry the temporary throttle.");
	await view.reachSafeBoundary();
	assert.deepEqual(retries, [true, false]);
	assert.equal(suspension(view.status(identity.agentId).run), undefined);
	assert.deepEqual(view.reportHistory(), []);
});

test("a suspended dependency quiets its blocked parent without hiding an unrelated stop", { timeout: 35_000 }, async t => {
	const { host, view, coordinator, identity, spawn } = await harness(t);
	host.model.setResponses([fauxAssistantMessage("Parent will delegate."), fauxAssistantMessage("Parent reminder acknowledged.")]);
	const parentId = await spawn();
	const parent = coordinator.forAgent(parentId);
	const parentPath = view.status(parentId).primaryEvidence.transcriptPath!;
	const parentEntries = () => SessionManager.open(parentPath).getEntries();
	await until(() => parentEntries().some(entry => entry.type === "custom_message" && entry.customType === "agent-coordination.obligation-reminder"), "parent initially settles");
	await until(() => {
		const run = view.status(parentId).run;
		return run.phase === "live" && run.work === "settled" && !run.retentionReasons.some(item => item.reason === "pending_delivery");
	}, "parent reminder generation must finish before changing shared model responses");
	host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 dependency runtime failure" })]);
	const input = { title: "Suspended dependency", request: "Do the delegated dependency work." };
	SessionManager.open(parentPath).appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", input, { id: "nested-dependency" }), { stopReason: "toolUse" }));
	const child = await parent.spawn("nested-dependency", input);
	assert.ok("agentId" in child);
	await until(() => Boolean(suspension(view.status(child.agentId).run)), "dependency suspends");
	const reminderCount = () => parentEntries().filter(entry => entry.type === "custom_message" && entry.customType === "agent-coordination.obligation-reminder").length;
	const before = reminderCount();
	const reportCount = view.reportHistory().length;
	for (let index = 0; index < 4; index++) {
		view.refreshAgentActivity();
		await view.reachSafeBoundary();
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	assert.equal(reminderCount(), before, "blocked parent must not enter a reminder loop");
	assert.equal(view.reportHistory().length, reportCount, "a suspension alone must not create reports");
	host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 unrelated failure alongside suspended dependency" })]);
	await host.session.prompt("Fail the unrelated Owner generation.");
	await until(
		() => suspension(view.status(identity.agentId).run)?.reason === "runtime_error",
		"unrelated Owner stop remains visible",
	);
	assert.deepEqual(suspension(view.status(identity.agentId).run), {
		reason: "runtime_error",
		evidence: {
			stage: "model",
			error: "400 unrelated failure alongside suspended dependency",
			provenance: "native-session-driver",
		},
	});
	assert.equal(view.reportHistory().length, reportCount, "neither stop publishes a report");
	assert.ok(suspension(view.status(child.agentId).run));
});
