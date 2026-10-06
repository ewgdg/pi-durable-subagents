import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";

import { MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
import { MODERATOR_OBLIGATION_REMINDER_GUIDANCE } from "../src/protocol/moderator-obligation-reminder.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import type { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import { createChildControlLoopback, type ChildControlLoopback } from "./support/child-control-loopback.ts";

test("child reminder admission defers active work and serializes clear versus commit", { timeout: 5_000 }, async t => {
	const nativeHeld = signal();
	const releaseNative = signal();
	t.after(() => releaseNative.resolve());
	const contexts: string[] = [];
	const recordContext: FauxResponseStep = context => {
		contexts.push(JSON.stringify(context.messages));
		return fauxAssistantMessage("Processed.");
	};
	const loopback = await createChildControlLoopback(t);
	const { proxy: runtime, host } = loopback;
	host.model.setResponses([
		async context => {
			contexts.push(JSON.stringify(context.messages));
			nativeHeld.resolve();
			await releaseNative.promise;
			return fauxAssistantMessage("Native work done.");
		},
		recordContext, recordContext, recordContext,
	]);

	const native = loopback.submitNativeInput("Hold a native model cycle.");
	await nativeHeld.promise;
	let callbackCalls = 0;
	assert.equal(await runtime.deliverModeratorReminder(async (commit) => {
		callbackCalls++;
		return commit();
	}), "busy");
	assert.equal(callbackCalls, 0, "active native work must not reserve or invoke reconciliation");
	assert.equal(reminders(loopback), 0);
	assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: [] });
	const nativeSettled = nextSettlement(runtime);
	releaseNative.resolve();
	await native;
	await nativeSettled;

	const lane = new SerialLane();
	let handling = true;
	const clearEntered = signal();
	const allowClear = signal();
	const clear = lane.run(async () => {
		clearEntered.resolve();
		await allowClear.promise;
		handling = false;
	});
	await clearEntered.promise;
	const prepared = signal();
	const suppressed = runtime.deliverModeratorReminder((commit) => {
		prepared.resolve();
		return lane.run(async () => handling ? commit() : "suppressed");
	});
	await prepared.promise;
	allowClear.resolve();
	await clear;
	assert.equal(await suppressed, "suppressed");
	assert.equal(reminders(loopback), 0);

	// Both normal delivery kinds must survive release of the suppressed reservation.
	for (const kind of ["message", "request"] as const) {
		const content = "ordinary-" + kind + "-after-suppression";
		const message = createMessageDelivery([{
			source: { agentId: "sender", entryId: kind + "-entry", toolCallId: kind + "-call" },
			projection: kind === "message"
				? { kind, messageId: kind + "-call", fromAgentId: "sender", content }
				: { title: "Fixture request", kind, requestMessageId: kind + "-call", fromAgentId: "sender", question: content },
		}]);
		const delivery = runtime.deliver({ kind: "custom", message, triggerTurn: true }, {
			inspectCommit: () => host.session.sessionManager.getEntries().some(
				(entry) => entry.type === "custom_message" && entry.content === message.content,
			),
		});
		assert.equal(await delivery.transcriptCommit, true);
		await delivery.completion;
		assert.ok(contexts.at(-1)?.includes(content));
	}
	assert.equal(reminders(loopback), 0);
	assert.ok(!contexts.join("\n").includes(JSON.stringify(MODERATOR_OBLIGATION_REMINDER_GUIDANCE).slice(1, -1)));

	handling = true;
	const committedInsideLane = signal();
	const releaseLane = signal();
	const reminderSettled = nextSettlement(runtime);
	const committed = runtime.deliverModeratorReminder((commit) => lane.run(async () => {
		assert.equal(handling, true);
		const outcome = await commit();
		assert.equal(outcome, "committed");
		assert.equal(reminders(loopback), 1, "commit must include durable child proof before releasing the Owner lane");
		committedInsideLane.resolve();
		await releaseLane.promise;
		return outcome;
	}));
	await committedInsideLane.promise;
	let clearRan = false;
	const laterClear = lane.run(() => { handling = false; clearRan = true; });
	assert.equal(clearRan, false);
	releaseLane.resolve();
	assert.equal(await committed, "committed");
	await laterClear;
	await reminderSettled;
	assert.equal(handling, false);
	assert.equal(reminders(loopback), 1);
	assert.ok(contexts.at(-1)?.includes(JSON.stringify(MODERATOR_OBLIGATION_REMINDER_GUIDANCE).slice(1, -1)));
	assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: [] });
});

test("a busy reminder reservation is released and does not block its successor", { timeout: 5_000 }, async t => {
	const { loopback: { proxy: runtime }, held, release } = await createHeldRunLoopback(t);
	await held;
	let callbackCalls = 0;
	assert.equal(await runtime.deliverModeratorReminder(async () => {
		callbackCalls++;
		return "committed";
	}), "busy");
	assert.equal(callbackCalls, 0);
	const settled = nextSettlement(runtime);
	release();
	await settled;
	assert.equal(await runtime.deliverModeratorReminder(async () => {
		callbackCalls++;
		return "suppressed";
	}), "suppressed");
	assert.equal(callbackCalls, 1, "a busy reservation must not block its successor");
});

test("a reminder is busy while another input prepares its startup and never joins the native queue", { timeout: 5_000 }, async t => {
	const preparing = signal();
	const release = signal();
	t.after(() => release.resolve());
	const loopback = await createChildControlLoopback(t, {
		configure: pi => pi.on("input", async () => { preparing.resolve(); await release.promise; }),
	});
	loopback.host.model.setResponses([fauxAssistantMessage("Unrelated run.")]);
	const human = loopback.submitNativeInput("Unrelated work.");
	await preparing.promise;
	assert.equal(await loopback.proxy.deliverModeratorReminder(commit => commit()), "busy");
	release.resolve();
	await human;
	assert.equal(reminders(loopback), 0);
});

test("a busy reminder creates no speculative Run identity", { timeout: 5_000 }, async t => {
	const { loopback, held, release } = await createHeldRunLoopback(t);
	const runtime = loopback.proxy;
	await held;
	assert.equal(await runtime.deliverModeratorReminder(async () => "committed"), "busy");
	assert.equal(runtime.workState(), "active");
	const settled = nextSettlement(runtime);
	release();
	await settled;
	assert.equal(runtime.workState(), "settled", "busy admission must not leave a stale Run identity");
	assert.deepEqual(loopback.events.flatMap(event => event.event === "agent.start" ? [event.payload.runId] : []), ["native-run-1"]);
});

test("a reminder callback that suppresses releases its reservation without committing", { timeout: 5_000 }, async t => {
	const loopback = await createChildControlLoopback(t);
	const runtime = loopback.proxy;
	assert.equal(await runtime.deliverModeratorReminder(async (commit) => {
		assert.equal(typeof commit, "function");
		return "suppressed";
	}), "suppressed");
	assert.equal(await runtime.deliverModeratorReminder(async () => "suppressed"), "suppressed");
	assert.equal(reminders(loopback), 0);
});

test("a throwing reminder callback releases its reservation", { timeout: 5_000 }, async t => {
	const loopback = await createChildControlLoopback(t);
	const runtime = loopback.proxy;
	const callbackError = new Error("reconciliation failed");
	await assert.rejects(
		runtime.deliverModeratorReminder(async () => { throw callbackError; }),
		(error) => error === callbackError,
	);
	assert.equal(await runtime.deliverModeratorReminder(async () => "suppressed"), "suppressed");
	assert.equal(reminders(loopback), 0);
});

test("aborting while a reminder callback waits releases promptly and a late callback cannot commit", { timeout: 5_000 }, async t => {
	const loopback = await createChildControlLoopback(t);
	const runtime = loopback.proxy;
	const callbackEntered = signal();
	const lateCallbackAllowed = signal();
	t.after(() => lateCallbackAllowed.resolve());
	let lateCommitRejected = false;
	const callbackCompleted = signal();
	const reminder = runtime.deliverModeratorReminder(async (commit) => {
		callbackEntered.resolve();
		await lateCallbackAllowed.promise;
		try {
			await commit();
		} catch {
			lateCommitRejected = true;
		}
		callbackCompleted.resolve();
		return "suppressed";
	});
	await callbackEntered.promise;
	await runtime.abort();
	await assert.rejects(reminder);
	// The released reservation admits its successor before the late callback runs.
	assert.equal(await runtime.deliverModeratorReminder(async () => "suppressed"), "suppressed");
	lateCallbackAllowed.resolve();
	await callbackCompleted.promise;
	assert.equal(lateCommitRejected, true);
	assert.equal(reminders(loopback), 0, "an aborted callback cannot commit after release");
});

async function createHeldRunLoopback(t: Parameters<typeof createChildControlLoopback>[0]) {
	const held = signal();
	const releaseModel = signal();
	t.after(() => releaseModel.resolve());
	const loopback = await createChildControlLoopback(t);
	loopback.host.model.setResponses([async () => {
		held.resolve();
		await releaseModel.promise;
		return fauxAssistantMessage("Native work done.");
	}]);
	const native = loopback.submitNativeInput("Hold a native model cycle.");
	t.after(() => native);
	return { loopback, held: held.promise, release: releaseModel.resolve };
}

function reminders({ host }: ChildControlLoopback): number {
	return host.session.sessionManager.getEntries().filter(
		(entry) => entry.type === "custom_message" && entry.customType === MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE,
	).length;
}

function signal(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function nextSettlement(runtime: PiChildHostedRuntime): Promise<void> {
	return new Promise((resolve) => {
		const remove = runtime.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			remove();
			resolve();
		});
	});
}
