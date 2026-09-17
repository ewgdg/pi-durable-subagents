import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import type { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { ModeratorReportStore } from "../src/coordination/moderator-reports.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";

test("Moderator reports return without human waiting and survive independent incident resolution", { timeout: 15_000 }, async (t) => {
	// Real subprocess startup gets an allowance; observable progress below has a 5s deadline.
	let owner!: ReturnType<WorkflowCoordinator["forAgent"]>;
	const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
	});
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
	owner = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	const input = { symptom: "Agent stalled", suspectedDefect: "Completion wake may be lost", uncertainty: "Cause is not confirmed", recoveryActions: "Inspect then interrupt the stalled Run", recoveryOutcome: "Recovery not yet attempted", evidence: ["Committed obligation stall trigger"] };
	let affectedAgentId = "";
	let moderatorStep = 0;
	const route = (context: Context) => {
		if (!context.tools?.some(({ name }) => name === "moderator_control")) return fauxAssistantMessage("Settled without answering.");
		if (!affectedAgentId) {
			const text = context.messages.flatMap((message) => message.role !== "user" ? [] : typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).find((text) => text.includes('"kind":"obligation_stall"'));
			assert.ok(text);
			affectedAgentId = (JSON.parse(text) as { trigger: { agentId: string } }).trigger.agentId;
		}
		const step = moderatorStep++;
		if (step === 0) return fauxAssistantMessage(fauxToolCall("report_to_user", input, { id: "publish-report" }), { stopReason: "toolUse" });
		if (step === 1) return fauxAssistantMessage(fauxToolCall("moderator_control", { operation: "resolve", summary: "Report published", rationale: "Publication must not clear the stall" }, { id: "resolve-unrecovered" }), { stopReason: "toolUse" });
		if (step === 2) return fauxAssistantMessage(fauxToolCall("agent_control", { operation: "interrupt", agentId: affectedAgentId }, { id: "restore-progress-boundary" }), { stopReason: "toolUse" });
		if (step === 3) return fauxAssistantMessage(fauxToolCall("moderator_control", { operation: "resolve", summary: "Run held", rationale: "An explicit progress boundary is restored" }, { id: "resolve-recovered" }), { stopReason: "toolUse" });
		return fauxAssistantMessage("Recovery complete; the report remains available.");
	};
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "Demonstrate an unresolved Answer obligation." }, { id: "spawn-report-case" }), { stopReason: "toolUse" }),
		...Array.from({ length: 12 }, () => route),
	]);
	const prompt = host.session.prompt("Create a report and recover independently.");
	t.after(async () => { await host.session.abort(); await prompt; });
	let moderatorPath = "";
	let moderatorId = "";
	const workflowDirectory = `${host.session.sessionManager.getSessionDir()}/pi-durable-subagents/${Buffer.from(host.session.sessionId).toString("base64url")}`;
	await waitFor(async () => {
		for (const session of await SessionManager.list(host.cwd, workflowDirectory)) {
			if (SessionManager.open(session.path).getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "agent-coordination.moderator-input")) {
				moderatorPath = session.path; moderatorId = session.id; return true;
			}
		}
		return false;
	});
	const result = (toolCallId: string) => SessionManager.open(moderatorPath).getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId);
	await waitFor(() => Boolean(result("resolve-recovered")));
	for (const toolCallId of ["publish-report", "resolve-unrecovered", "restore-progress-boundary", "resolve-recovered"]) {
		const entry = result(toolCallId);
		assert.ok(entry?.type === "message" && entry.message.role === "toolResult");
		assert.equal(entry.message.isError, false, toolCallId);
	}
	const blocked = result("resolve-unrecovered");
	assert.ok(blocked?.type === "message" && blocked.message.role === "toolResult");
	assert.deepEqual(blocked.message.details, { disposition: "blocked", predicates: ["obligation_stall"] });
	const resolved = result("resolve-recovered");
	assert.ok(resolved?.type === "message" && resolved.message.role === "toolResult");
	assert.deepEqual(resolved.message.details, { disposition: "resolved" });
	assert.deepEqual(owner.humanAttention(), []);
	const history = owner.reportHistory();
	assert.equal(history.length, 1);
	const item = history[0]!;
	assert.equal(item.readAt, undefined);
	const sourceEntry = SessionManager.open(moderatorPath).getEntries().find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall" && part.id === "publish-report"));
	assert.ok(sourceEntry);
	assert.deepEqual(item.report.source, { agentId: moderatorId, entryId: sourceEntry.id, toolCallId: "publish-report", transcriptPath: moderatorPath });
	assert.equal(item.report.reporter?.agentId, moderatorId);
	assert.equal(item.report.reporter?.label, coordinator.forModerator(moderatorId).status().label);
	for (const key of Object.keys(input) as Array<keyof typeof input>) assert.deepEqual(item.report[key], input[key]);
	const published = result("publish-report");
	assert.ok(published?.type === "message" && published.message.role === "toolResult");
	assert.deepEqual(published.message.details, { reportId: item.report.reportId, createdAt: item.report.createdAt });
	const reopened = SessionManager.open(host.session.sessionManager.getSessionFile()!);
	const coldStore = new ModeratorReportStore({ transcript: transcriptFromSessionManager(reopened), appendCustomEntry: (type, data) => reopened.appendCustomEntry(type, data) });
	assert.deepEqual(coldStore.history(), history);
	await coordinator.shutdown(async () => host.runtime.dispose());
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Moderator report integration made no expected progress within 5s");
}
