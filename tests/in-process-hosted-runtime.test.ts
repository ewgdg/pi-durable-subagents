import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { registerSessionStartup } from "../src/pi-integration/session-startup.ts";
import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

async function ownerRuntime(t: Parameters<typeof createTestOwnerHost>[0], extension?: ExtensionFactory) {
	const host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		return extension?.(pi);
	}, { fauxTokensPerSecond: 100_000 });
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	return { host, runtime };
}

test("the Owner Runtime publishes the driver's Run end unchanged", { timeout: 5000 }, async t => {
	const { host, runtime } = await ownerRuntime(t);
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe(event => events.push(event));
	host.model.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 upstream provider exploded" })]);
	await runtime.deliver({ kind: "user", content: "Start the Run." }).completion;
	await runtime.waitForIdle();
	assert.deepEqual(events.filter(event => event.type !== "state_changed"), [
		{
			type: "agent_end", outcome: "error", willRetry: false,
			failure: { stage: "model", error: "400 upstream provider exploded", provenance: "native-session-driver" },
		},
		{ type: "agent_settled" },
	]);
	assert.equal(runtime.workState(), "settled");
});

test("an Owner Delivery confirms only when the driver proof and the caller's inspection agree", { timeout: 5000 }, async t => {
	const { host, runtime } = await ownerRuntime(t);
	host.model.setResponses([fauxAssistantMessage("First handled."), fauxAssistantMessage("Second handled.")]);
	const confirmed = runtime.deliver({ kind: "user", content: "Confirmed by both." }, { inspectCommit: () => true });
	assert.equal(await confirmed.transcriptCommit, true);
	await confirmed.completion;
	const refused = runtime.deliver({ kind: "user", content: "Refused by the caller." }, { inspectCommit: () => false });
	assert.equal(await refused.transcriptCommit, false);
	await refused.completion;
});

test("an Owner user Delivery proves commit after an Owner input extension appends to it", { timeout: 5000 }, async t => {
	const { host, runtime } = await ownerRuntime(t, pi => {
		pi.on("input", event => ({ action: "transform", text: `Prefixed by an Owner input extension.\n\n${event.text}` }));
	});
	host.model.setResponses([fauxAssistantMessage("Transformed input handled.")]);
	const delivery = runtime.deliver({ kind: "user", content: "Human input." }, {});
	assert.equal(await delivery.transcriptCommit, true);
	await delivery.completion;
});

test("the Owner Runtime rejects Moderator reminder delivery because Moderators run as child processes", { timeout: 5000 }, async t => {
	const { host, runtime } = await ownerRuntime(t);
	let commitAttempts = 0;
	await assert.rejects(
		runtime.deliverModeratorReminder(async commit => { commitAttempts++; return commit(); }),
		/owner_runtime_hosts_no_moderator/,
	);
	assert.equal(commitAttempts, 0);
	assert.equal(host.session.sessionManager.getEntries().some(entry => entry.type === "custom_message"), false);
});
