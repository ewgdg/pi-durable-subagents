import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { QuotaSuspensionStore } from "../src/coordination/quota-suspensions.ts";

test("suspension replay retains exact Run and evidence until explicit clearance, independent of notice reads", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("agent-coordination.identity", { agentId: manager.getSessionId() });
	const store = () => new QuotaSuspensionStore({
		transcript: transcriptFromSessionManager(manager),
		appendCustomEntry: (type, data) => manager.appendCustomEntry(type, data),
	});
	const suspension = { reason: "provider_quota" as const, evidence: { diagnostic: "usage_limit_reached", provider: "openai-codex" } };
	const retained = store().suspend("child", 6, suspension);
	assert.deepEqual(store().current("child"), retained);
	assert.deepEqual(store().suspend("child", 6, suspension), retained);
	const nativeInput = { steering: ["steer later"], followUp: ["follow up later"] };
	const checkpoint = store().suspend("child", 6, suspension, nativeInput);
	assert.equal(checkpoint.entryId, retained.entryId, "queue checkpoint does not create a second incident");
	assert.deepEqual(store().current("child")?.nativeInput, nativeInput);
	manager.appendCustomEntry("agent-coordination.moderator-report-read-state", { reportId: "notice", readAt: new Date().toISOString() });
	assert.deepEqual(store().current("child"), checkpoint);
	store().clear("child", 6);
	assert.equal(store().current("child"), undefined);
	assert.notEqual(store().suspend("child", 6, suspension).entryId, retained.entryId);
});
