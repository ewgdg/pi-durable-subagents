import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { activityWorkflow } from "./support/activity-workflow.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

test("a known Agent activity change refreshes only its transcript, not dormant peers", { timeout: 10_000 }, async (t) => {
	const workflow = await activityWorkflow(t, [{ id: "a" }, { id: "b" }, { id: "a1", parent: "a" }]);
	const refreshes = new Map<string, number>();
	for (const [id, transcript] of workflow.transcripts) {
		const refresh = transcript.refresh.bind(transcript);
		t.mock.method(transcript, "refresh", () => {
			refreshes.set(id, (refreshes.get(id) ?? 0) + 1);
			return refresh();
		});
	}
	const changed = workflow.coordinator.forAgent("a");
	const published = signal();
	let notifications = 0;
	const unsubscribe = workflow.owner.addAgentActivityChangeHandler(() => {
		if (++notifications === 2) published.resolve();
	});
	t.after(unsubscribe);
	changed.refreshAgentActivity();
	assert.equal(notifications, 1, "host state remains immediately visible before async evidence refresh");
	await published.promise;
	await yieldTurn();
	assert.deepEqual([...refreshes], [["a", 1]], "unrelated dormant transcripts must not be observed for one Agent's presentation change");

	refreshes.clear();
	await workflow.owner.refreshTranscriptFacts();
	assert.deepEqual([...refreshes.keys()].sort(), [...workflow.transcripts.keys()].sort(),
		"explicit authoritative refresh still checks every source, including silent appends");
});

test("activity refresh retains same-Agent and peer changes arriving during an await", { timeout: 10_000 }, async (t) => {
	const workflow = await activityWorkflow(t, [{ id: "a" }, { id: "b" }, { id: "untouched" }]);
	const entered = signal();
	const release = signal();
	t.after(release.resolve);
	const refreshed = new Map<string, number>();
	for (const [id, transcript] of workflow.transcripts) {
		const refresh = transcript.refresh.bind(transcript);
		t.mock.method(transcript, "refresh", async () => {
			const count = (refreshed.get(id) ?? 0) + 1;
			refreshed.set(id, count);
			const inspection = await refresh();
			if (id === "a" && count === 1) {
				entered.resolve();
				await release.promise;
			}
			return inspection;
		});
	}
	const a = workflow.coordinator.forAgent("a");
	const b = workflow.coordinator.forAgent("b");
	a.refreshAgentActivity();
	await entered.promise;
	const lastA = workflow.managers.get("a")!.appendCustomEntry("activity-test", { revision: 2 });
	await workflow.persist("a");
	a.refreshAgentActivity();
	a.refreshAgentActivity();
	const lastB = workflow.managers.get("b")!.appendCustomEntry("activity-test", { revision: 1 });
	await workflow.persist("b");
	b.refreshAgentActivity();
	const published = signal();
	const unsubscribe = workflow.owner.addAgentActivityChangeHandler(() => {
		if (workflow.transcripts.get("a")!.snapshot()?.entries.at(-1)?.id === lastA &&
			workflow.transcripts.get("b")!.snapshot()?.entries.at(-1)?.id === lastB) published.resolve();
	});
	t.after(unsubscribe);
	release.resolve();
	await published.promise;
	await yieldTurn();
	assert.deepEqual([...refreshed], [["a", 2], ["b", 1]],
		"the successor observes both changes, coalesces duplicate dirtiness, and skips clean Agents");
});

test("authority order is reused across presentation changes and invalidated by Agent admission", { timeout: 15_000 }, async (t) => {
	const workflow = await activityWorkflow(t,
		[{ id: "a-worker" }, { id: "b-worker" }, { id: "a1-worker", parent: "a-worker" }],
		{ beforeRunStart: () => "confirmed_failure" },
	);
	const buildsBefore = workflow.coordinator.presentationDiagnostics().authorityOrderBuilds;
	const search = () => workflow.owner.search({ operation: "search", scope: "authorized", query: "worker" }).matches.map(agent => agent.agentId);
	assert.deepEqual(search(), ["a-worker", "a1-worker", "b-worker"]);
	for (let index = 0; index < 50; index++) {
		workflow.owner.selectionRoster();
		assert.deepEqual(search(), ["a-worker", "a1-worker", "b-worker"]);
	}
	workflow.coordinator.forAgent("a-worker").refreshAgentActivity();
	await yieldTurn();
	assert.deepEqual(search(), ["a-worker", "a1-worker", "b-worker"]);
	assert.equal(workflow.coordinator.presentationDiagnostics().authorityOrderBuilds, buildsBefore + 1,
		"unchanged roster structure must not be rebuilt by search, selector, or host presentation changes");

	const input = { title: "New worker", request: "Remain dormant after the controlled start failure.", label: "new-worker" };
	const toolCallId = "spawn-new-worker";
	workflow.host.session.sessionManager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_spawn", input, { id: toolCallId }), { stopReason: "toolUse" },
	));
	const receipt = await workflow.owner.spawn(toolCallId, input);
	assert.equal(receipt.spawnStatus, "created", JSON.stringify(receipt));
	if (receipt.spawnStatus !== "created") throw new Error("Expected committed Agent identity");
	assert.equal(receipt.messageStatus, "not_sent", "the fixture must not launch a child Agent Run");
	assert.deepEqual(search(), ["a-worker", "a1-worker", "b-worker", receipt.agentId]);
	assert.equal(workflow.coordinator.presentationDiagnostics().authorityOrderBuilds, buildsBefore + 2,
		"admission invalidates the old authority order exactly once");
});

test("a failed activity refresh reports its error without retrying until a new change", { timeout: 10_000 }, async (t) => {
	const workflow = await activityWorkflow(t, [{ id: "a" }]);
	const transcript = workflow.transcripts.get("a")!;
	const refresh = transcript.refresh.bind(transcript);
	let fail = true;
	let attempts = 0;
	t.mock.method(transcript, "refresh", async () => {
		attempts++;
		if (fail) throw new Error("activity fixture read failure");
		return refresh();
	});
	const source = workflow.coordinator.forAgent("a");
	source.refreshAgentActivity();
	await yieldTurn();
	await yieldTurn();
	assert.equal(attempts, 1, "a persistent read error must not create an automatic retry loop");
	assert.ok(workflow.host.services.diagnostics.some(item => item.message.includes("activity fixture read failure")));

	fail = false;
	const published = signal();
	let notifications = 0;
	const unsubscribe = source.addAgentActivityChangeHandler(() => {
		if (++notifications === 2) published.resolve();
	});
	t.after(unsubscribe);
	source.refreshAgentActivity();
	await published.promise;
	assert.equal(attempts, 2, "a later source change can recover the failed refresh");
});

function signal(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
