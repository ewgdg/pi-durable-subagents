import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type Context } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import type { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { MODERATOR_INPUT_CUSTOM_TYPE } from "../src/protocol/moderator-input.ts";
import { MODERATOR_ROUTINE_START_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { MANUAL_REPAIR_PROCEDURE } from "../src/coordination/manual-repair.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}

function countCustomType(path: string, customType: string): number {
	return SessionManager.open(path).getEntries().filter(
		(entry) => entry.type === "custom_message" && entry.customType === customType,
	).length;
}

test("manual repair hosts a real Moderator and resolves it to Dormant", { timeout: 90000 }, async (t) => {
	let owner!: ReturnType<WorkflowCoordinator["forAgent"]>;
	const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
	});
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, { entryModulePath: "<inline:pi-durable-subagents>" });
	owner = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	let resolveSent = false;
	const moderatorRoute = (context: Context) => {
		if (!getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("Owner idle; the repair Moderator owns this check.");
		}
		if (!resolveSent) {
			resolveSent = true;
			return fauxAssistantMessage(fauxToolCall("moderator_control", {
				operation: "resolve",
				summary: "Repair triage complete",
				rationale: "Manual inspection finished with no incident handling remaining.",
			}, { id: "repair-resolve" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Repair triage complete; holding for human direction.");
	};
	host.model.setResponses(Array.from({ length: 8 }, () => moderatorRoute));
	const ownerBefore = JSON.stringify(host.session.sessionManager.getEntries());
	const receipt = await owner.requestManualRepair("Investigate the stalled handoff.");
	assert.equal(receipt.disposition, "created");
	const moderatorId = receipt.moderatorAgentId;
	assert.notEqual(moderatorId, identity.agentId);
	const joined = await owner.requestManualRepair("Duplicate attempt.");
	assert.deepEqual(joined, { disposition: "joined", moderatorAgentId: moderatorId });
	const repairDir = join(host.session.sessionManager.getSessionDir(), "pi-durable-subagents", host.session.sessionId, "repair");
	let moderatorPath = "";
	let moderatorSessionId = "";
	await waitFor(async () => {
		for (const session of await SessionManager.list(host.cwd, repairDir)) {
			if (countCustomType(session.path, MODERATOR_INPUT_CUSTOM_TYPE) === 1) {
				moderatorPath = session.path;
				moderatorSessionId = session.id;
				return true;
			}
		}
		return false;
	}, 20000, "repair Moderator transcript was not committed under repair/");
	assert.equal(moderatorSessionId, moderatorId);
	assert.equal((await readdir(repairDir)).length, 1);
	const entries = SessionManager.open(moderatorPath).getEntries();
	const inputEntry = entries[0];
	assert.ok(inputEntry && inputEntry.type === "custom_message");
	assert.equal(inputEntry.customType, MODERATOR_INPUT_CUSTOM_TYPE);
	assert.equal(inputEntry.parentId, null);
	assert.equal(inputEntry.display, true);
	const parsedInput = JSON.parse(inputEntry.content as string) as {
		trigger: unknown;
		inspectedThrough: unknown;
		repairContext?: Record<string, unknown>;
		procedure?: unknown;
	};
	assert.deepEqual(parsedInput.trigger, { kind: "manual_repair", reason: "Investigate the stalled handoff." });
	assert.deepEqual(parsedInput.inspectedThrough, []);
	assert.equal(parsedInput.repairContext?.stage, "admitted Owner trigger");
	assert.equal(parsedInput.repairContext?.ownerId, identity.agentId);
	assert.equal(parsedInput.repairContext?.workflowId, identity.agentId);
	assert.ok(typeof parsedInput.repairContext?.workflowDirectory === "string" && (parsedInput.repairContext?.workflowDirectory as string).length > 0);
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	if (ownerSessionFile) assert.equal(parsedInput.repairContext?.transcriptPath, ownerSessionFile);
	else assert.equal(parsedInput.repairContext?.transcriptPath, undefined);
	assert.equal(parsedInput.procedure, MANUAL_REPAIR_PROCEDURE);
	assert.equal((inputEntry.details as { agentId: string }).agentId, moderatorId);
	assert.equal((inputEntry.details as { workflowId: string }).workflowId, identity.agentId);
	const roster = owner.selectionRoster();
	assert.ok(roster.live.some((status) => status.agentId === moderatorId));
	const status = coordinator.forModerator(moderatorId).status();
	assert.equal(status.label, "Moderator");
	assert.equal(status.directSpawnerAgentId, null);
	assert.ok(status.run.phase === "live" || status.run.phase === "starting");
	assert.ok(status.run.retentionReasons.some(({ reason }) => reason === "moderator_handling"));
	assert.deepEqual(coordinator.forModerator(moderatorId).openIncomingRequests(), { requests: [] });
	assert.deepEqual(owner.children(), []);
	assert.equal(JSON.stringify(host.session.sessionManager.getEntries()), ownerBefore);
	await waitFor(() => {
		const result = SessionManager.open(moderatorPath).getEntries().find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "repair-resolve",
		);
		return result?.type === "message" && result.message.role === "toolResult" && !result.message.isError;
	}, 30000, "repair Moderator resolve was not committed");
	const resolveResult = SessionManager.open(moderatorPath).getEntries().find(
		(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "repair-resolve",
	);
	assert.ok(resolveResult?.type === "message" && resolveResult.message.role === "toolResult");
	assert.deepEqual(resolveResult.message.details, { disposition: "resolved" });
	await waitFor(
		() => coordinator.forModerator(moderatorId).status().run.phase === "dormant",
		15000,
		"repair Moderator did not release to Dormant after resolve",
	);
	const retained = SessionManager.open(moderatorPath).getEntries();
	assert.equal(retained[0]?.type === "custom_message" && retained[0].customType, MODERATOR_INPUT_CUSTOM_TYPE);
	assert.equal(countCustomType(moderatorPath, MODERATOR_ROUTINE_START_CUSTOM_TYPE), 1);
	const beforeSelection = await readFile(moderatorPath, "utf8");
	const selection = await owner.openAgentPresentation(moderatorId);
	assert.equal(selection.kind, "selected");
	if (selection.kind === "selected" && selection.view) await selection.view.close();
	else await owner.openAgentPresentation(identity.agentId);
	assert.equal(countCustomType(moderatorPath, MODERATOR_ROUTINE_START_CUSTOM_TYPE), 1);
	assert.equal(countCustomType(moderatorPath, MODERATOR_INPUT_CUSTOM_TYPE), 1);
	assert.equal(await readFile(moderatorPath, "utf8"), beforeSelection);
	await coordinator.shutdown(async () => host.runtime.dispose());
});
