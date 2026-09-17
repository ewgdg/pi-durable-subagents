import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRepairCompactionHandler } from "../src/repair/helper-entry.ts";
import { ProposalSettlementGate } from "../src/repair/proposal-settlement.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

for (const reason of ["manual", "threshold", "overflow"] as const) test(`native ${reason} compaction is refused before repair commit without retrying or applying`, { timeout: 5000 }, async t => {
	const automatic = reason !== "manual";
	const gate = new ProposalSettlementGate();
	let compactionAttempts = 0;
	let committed = false;
	const guard = createRepairCompactionHandler(gate, () => committed);
	const host = await createTestOwnerHost(t, pi => {
		pi.on("session_before_compact", (event, ctx) => { compactionAttempts++; return guard(event, ctx); });
	}, { settings: { compaction: { enabled: automatic, reserveTokens: 1_000, keepRecentTokens: 24 } } });
	for (let index = 0; index < 3; index++) {
		host.session.sessionManager.appendMessage({ role: "user", content: "Prior context. ".repeat(200), timestamp: Date.now() });
		const prior = fauxAssistantMessage("Prior answer.");
		host.session.sessionManager.appendMessage(reason === "threshold" && index === 2
			? { ...prior, usage: { ...prior.usage, input: 195_000, totalTokens: 195_000 } } : prior);
	}
	host.session.agent.state.messages = host.session.sessionManager.buildSessionContext().messages;
	let modelStarts = 0;
	const unsubscribe = host.session.subscribe(event => { if (event.type === "agent_start") modelStarts++; });
	t.after(unsubscribe);
	gate.reportComplete();
	if (automatic) {
		const response = reason === "overflow"
			? fauxAssistantMessage([], { stopReason: "error", errorMessage: "maximum context length exceeded" })
			: fauxAssistantMessage("Context is exhausted; repair must remain unapplied.");
		host.model.setResponses([response]);
		await host.session.prompt("Continue.");
	} else {
		await assert.rejects(host.session.compact(), /Compaction cancelled/);
	}
	assert.equal(compactionAttempts, 1);
	assert.equal(modelStarts, automatic ? 1 : 0, "cancelled native compaction must not start a retry loop");
	assert.equal(host.session.isIdle, true);
	assert.equal(host.session.sessionManager.getEntries().some(entry => entry.type === "compaction"), false);
	assert.equal(gate.freezeOnSettlement({ generation: gate.generation, outcome: "completed", hasPendingMessages: false }), undefined);
	assert.ok(host.ui.notifications.some(item => /compaction.*unavailable.*repair/i.test(item.message)));
	committed = true;
	assert.equal(guard({} as never, host.session.extensionRunner.createContext()), undefined, "committed conversation restores native compaction");
});
