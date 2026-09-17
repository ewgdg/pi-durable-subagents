import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { QuotaSuspensionStore } from "../src/coordination/quota-suspensions.ts";

test("suspension replay retains exact Run and evidence until explicit clearance, independent of unrelated coordination entries", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("agent-coordination.identity", { agentId: manager.getSessionId() });
	const store = () => new QuotaSuspensionStore({
		transcript: transcriptFromSessionManager(manager),
		appendCustomEntry: (type, data) => manager.appendCustomEntry(type, data),
	});
	const suspension = { reason: "provider_quota" as const, evidence: { diagnostic: "usage_limit_reached", provider: "openai-codex" } };
	// The journal record sequence is the durable identity: a repeated suspension must
	// reuse the existing stop rather than appending a competing one.
	const journal = () => manager.getEntries().flatMap(entry =>
		entry.type === "custom" && entry.customType === "agent-coordination.quota-suspension"
			? [entry.data as { operation: string }] : []).map(record => record.operation);
	const retained = store().suspend("child", 6, suspension);
	assert.deepEqual(store().current("child"), retained);
	assert.deepEqual(store().suspend("child", 6, suspension), retained);
	assert.deepEqual(journal(), ["suspend"], "repeating the same suspension appends no second stop");
	const nativeInput = { steering: ["steer later"], followUp: ["follow up later"] };
	const checkpoint = store().suspend("child", 6, suspension, nativeInput);
	assert.deepEqual(journal(), ["suspend", "queue"], "a queue checkpoint does not create a second suspension");
	assert.deepEqual(store().current("child")?.nativeInput, nativeInput);
	manager.appendCustomEntry("agent-coordination.moderator-report-read-state", { reportId: "unrelated", readAt: new Date().toISOString() });
	assert.deepEqual(store().current("child"), checkpoint);
	store().clear("child", 6);
	assert.equal(store().current("child"), undefined);
	assert.deepEqual(journal(), ["suspend", "queue", "clear"]);
	store().suspend("child", 6, suspension);
	assert.deepEqual(journal(), ["suspend", "queue", "clear", "suspend"], "a renewed suspension is a new stop");
});
