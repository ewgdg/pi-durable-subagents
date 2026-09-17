import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { WorkflowPolicyStore, parseWorkflowPolicy } from "../src/policy/workflow-policy.ts";
import type { AgentRunState } from "../src/runtime/agent-runtime-host.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import { participantLifecycleHandlers } from "../src/bootstrap/agent-extension.ts";
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
		if (nativeOwnerLifecycle) registerParticipantLifecycle(pi, participantLifecycleHandlers(() => view));
	}, {
		persistent: true, processVisibleModel: true,
		additionalExtensionPaths: [fileURLToPath(new URL("./fixtures/quota-evidence-extension.ts", import.meta.url))],
		settings: { retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 } },
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		workflowPolicy: new WorkflowPolicyStore(parseWorkflowPolicy('{"maxConcurrentAgentRuns":1}')),
	});
	view = coordinator.forAgent(identity.agentId);
	let sequence = 0;
	function call(tool: string, input: Record<string, unknown>) {
		const id = `quota-integration-${++sequence}`;
		host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall(tool, input, { id }), { stopReason: "toolUse" }));
		return id;
	}
	async function spawn() {
		const input = { title: "Quota lifecycle", request: "Keep this Request outstanding until explicitly resumed." };
		const receipt = await view.spawn(call("agent_spawn", input), input);
		assert.ok("agentId" in receipt);
		return receipt.agentId;
	}
	return { host, view, coordinator, identity, call, spawn };
}

for (const diagnostic of [
	'{"error":{"code":"usage_limit_reached","resets_at":1893456000}}',
	'{"error":{"type":"insufficient_quota"}}',
]) {
	test(`process Workflow retains quota Run and admits independent progress: ${diagnostic}`, { timeout: 35_000 }, async t => {
		const { host, view, coordinator, call, spawn } = await harness(t);
		host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: diagnostic })]);
		const agentId = await spawn();
		await until(() => Boolean(suspension(view.status(agentId).run)), "quota suspension must become observable");
		const suspended = view.status(agentId);
		assert.equal(suspended.run.phase, "live");
		assert.ok(suspended.run.retentionReasons.some(item => item.reason === "answer_owed"));
		const obligations = coordinator.forAgent(agentId).obligationFrames();
		assert.equal(obligations.length, 1);
		const transcript = suspended.primaryEvidence.transcriptPath!;
		const entries = () => SessionManager.open(transcript).getEntries();
		const reminders = () => entries().filter(entry => entry.type === "custom_message" && entry.customType === "agent-coordination.obligation-reminder").length;
		const beforeReminders = reminders();
		const selected = await view.openAgentView(agentId);
		assert.ok(selected);
		const message = { operation: "send" as const, targetAgent: agentId, content: "QUEUED_BEHIND_QUOTA", deliveryMode: "steer" as const };
		await view.message(call("agent_message", message), message);
		for (let index = 0; index < 3; index++) {
			view.refreshAgentActivity();
			await view.reachSafeBoundary();
			await new Promise(resolve => setTimeout(resolve, 30));
		}
		assert.ok(suspension(view.status(agentId).run));
		assert.equal(JSON.stringify(entries()).includes("QUEUED_BEHIND_QUOTA"), false);
		assert.equal(reminders(), beforeReminders);
		assert.deepEqual(view.reportHistory(), [], "quota suspension is not a reportable incident");
		host.model.setResponses([fauxAssistantMessage("INDEPENDENT_PROGRESS"), fauxAssistantMessage("Independent reminder acknowledged.")]);
		const independent = await spawn();
		await until(() => {
			const path = view.status(independent).primaryEvidence.transcriptPath;
			return Boolean(path && JSON.stringify(SessionManager.open(path).getEntries()).includes("INDEPENDENT_PROGRESS"));
		}, "quota suspension must release execution capacity");
		await until(() => {
			const path = view.status(independent).primaryEvidence.transcriptPath!;
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
		const quotaRecords = host.session.sessionManager.getEntries().flatMap(entry =>
			entry.type === "custom" && entry.customType === "agent-coordination.quota-suspension"
				? [entry.data as { agentId: string; operation: string; runSequence: number }] : []
		).filter(record => record.agentId === agentId);
		assert.deepEqual(quotaRecords.map(record => [record.operation, record.runSequence]), [["suspend", 1], ["clear", 1]], "resume clears the exact retained Run, not a successor");
	});
}

test("native Workflow suspends structured quota without terminal failure", { timeout: 15_000 }, async t => {
	const { host, view, identity } = await harness(t, false, true);
	host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: '{"error":{"code":"usage_limit_reached"}}' })]);
	await host.session.prompt("Exercise native quota evidence.");
	await until(() => Boolean(suspension(view.status(identity.agentId).run)), "native quota suspension");
	assert.equal(view.status(identity.agentId).run.phase, "live");
	await view.reachSafeBoundary();
	assert.ok(suspension(view.status(identity.agentId).run));
	await assert.rejects(view.beginExecution(), /quota_suspended/);
	assert.ok(suspension(view.status(identity.agentId).run));
	let programmaticGenerations = 0;
	host.model.setResponses([() => { programmaticGenerations++; return fauxAssistantMessage("PROGRAMMATIC_MUST_NOT_GENERATE"); }]);
	for (const submit of [
		() => host.session.sendUserMessage("Extension input must not resume quota"),
		() => host.session.prompt("RPC input must not resume quota", { source: "rpc" }),
	]) {
		await submit().catch(error => assert.match(String(error), /quota_suspended/));
		assert.ok(suspension(view.status(identity.agentId).run));
	}
	assert.equal(programmaticGenerations, 0);
	host.model.setResponses([fauxAssistantMessage("Owner explicitly resumed")]);
	const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
	await host.session.prompt("Continue after I changed the account", { source: "interactive", images: [image] });
	await until(() => !suspension(view.status(identity.agentId).run), "explicit Owner resume");
	assert.ok(host.session.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "user" &&
		JSON.stringify(entry.message.content) === JSON.stringify([{ type: "text", text: "Continue after I changed the account" }, image])));
});

test("exact Codex diagnostic suspends through the real process Workflow", { timeout: 20_000 }, async t => {
	const { view, call } = await harness(t);
	const input = { title: "Exact Codex quota", request: "Exercise the observed provider error.", config: { model: { id: "openai-codex/quota-fixture" } } };
	const receipt = await view.spawn(call("agent_spawn", input), input);
	assert.ok("agentId" in receipt);
	await until(() => Boolean(suspension(view.status(receipt.agentId).run)), "exact Codex error must suspend");
	assert.equal(suspension(view.status(receipt.agentId).run)?.evidence.diagnostic, "Codex error: The usage limit has been reached");
	assert.equal(suspension(view.status(receipt.agentId).run)?.evidence.provider, "openai-codex");
	assert.deepEqual(view.reportHistory(), [], "quota suspension publishes no report");
	const queued = { operation: "send" as const, targetAgent: receipt.agentId, content: "WAIT_THROUGH_RENEWED_QUOTA", deliveryMode: "steer" as const };
	await view.message(call("agent_message", queued), queued);
	const resume = { operation: "resume" as const, agentId: receipt.agentId, content: "Deliberately retry after reviewing quota." };
	const resumed = await view.control(call("agent_control", resume), resume);
	assert.ok("messageStatus" in resumed && resumed.messageStatus === "sent");
	await until(() => suspension(view.status(receipt.agentId).run)?.evidence.resetAt === "2030-01-01T00:00:00.000Z", "an immediate renewed quota failure must survive resume commitment");
	for (let index = 0; index < 3; index++) {
		view.refreshAgentActivity();
		await view.reachSafeBoundary();
		await new Promise(resolve => setTimeout(resolve, 30));
	}
	const entries = SessionManager.open(view.status(receipt.agentId).primaryEvidence.transcriptPath!).getEntries();
	assert.equal(JSON.stringify(entries).includes("WAIT_THROUGH_RENEWED_QUOTA"), false);
	assert.equal(entries.filter(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error").length, 2, "queued input must not start another model call");
	assert.deepEqual(view.reportHistory(), [], "a renewed suspension publishes no report either");
});

test("temporary throttle uses native retry rather than quota suspension", { timeout: 15_000 }, async t => {
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

test("unrelated terminal failure still publishes ordinary failure evidence", { timeout: 15_000 }, async t => {
	const { host, view, identity } = await harness(t);
	host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 unrelated terminal failure" })]);
	await host.session.prompt("Exercise a non-quota failure.");
	await until(() => view.reportHistory().length > 0, "terminal failure report");
	assert.equal(suspension(view.status(identity.agentId).run), undefined);
	assert.match(view.reportHistory()[0]!.report.symptom, /terminal Run failure/);
});

test("quota dependency quiets its blocked parent without hiding an unrelated failure", { timeout: 35_000 }, async t => {
	const { host, view, coordinator, spawn } = await harness(t);
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
	host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: '{"error":{"type":"insufficient_quota"}}' })]);
	const input = { title: "Quota dependency", request: "Do the delegated dependency work." };
	SessionManager.open(parentPath).appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", input, { id: "nested-quota" }), { stopReason: "toolUse" }));
	const child = await parent.spawn("nested-quota", input);
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
	assert.equal(view.reportHistory().length, reportCount, "quota alone must not create reports");
	host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 unrelated failure alongside suspended dependency" })]);
	await host.session.prompt("Fail the unrelated Owner generation.");
	await until(() => view.reportHistory().some(item => /unrelated failure alongside/.test(item.report.symptom)), "unrelated terminal incident remains visible");
	assert.ok(suspension(view.status(child.agentId).run));
});
