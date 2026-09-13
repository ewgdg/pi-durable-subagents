import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { createModelVisibleModeratorObligationReminder } from "../src/protocol/moderator-obligation-reminder.ts";
import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

test("an active native Run cannot queue a reminder that clears before commitment", { timeout: 5000 }, async t => {
	const modelStarted = deferred();
	const finishModel = deferred();
	const host = await createTestOwnerHost(t, () => {}, { persistent: true, implicitModeratorResponses: false });
	const contexts: string[] = [];
	host.model.setResponses([
		async context => {
			contexts.push(JSON.stringify(context));
			modelStarted.resolve();
			await finishModel.promise;
			return fauxAssistantMessage("Initial handling finished.");
		},
		context => { contexts.push(JSON.stringify(context)); return fauxAssistantMessage("Unrelated follow-up received."); },
	]);
	const initial = host.session.prompt("Investigate original incident");
	await modelStarted.promise;
	const runtime = InProcessHostedRuntime.fromSession({ session: host.session, services: host.services, projection: undefined });
	const lane = new SerialLane();
	const handle = { sequence: 1 };
	let cleared = false;
	const record = {
		identity: { agentId: host.session.sessionId },
		host: {
			lane, currentHandle: () => handle, isCurrent: (candidate: unknown) => candidate === handle,
			addSettledHandler: () => () => {}, addRetentionReason() {}, removeRetentionReason() {},
			blocksOrdinaryDelivery: () => false,
			// Reproduce the Owner's stale settled projection at the process boundary.
			currentWorkState: () => "settled",
			observe: () => ({ phase: "live", work: "settled", attention: "none", retentionReasons: [] }),
			deliverInLane: runtime.deliver.bind(runtime),
			deliverModeratorReminderInLane: (...args: Parameters<InProcessHostedRuntime["deliverModeratorReminder"]>) =>
				runtime.deliverModeratorReminder(...args),
		},
	} as unknown as AgentRecord;
	const reminder = createModelVisibleModeratorObligationReminder();
	const scheduler = new MessageDeliveryScheduler({ workflowPolicy: new WorkflowPolicyStore() });
	try {
		const delivery = {
			messageId: "handling-reminder", deliveryMode: "deferred" as const, customMessage: reminder,
			inspectProof: () => {
				const entry = host.session.sessionManager.getEntries().find(entry => entry.type === "custom_message" && entry.customType === reminder.customType);
				return entry ? { agentId: host.session.sessionId, entryId: entry.id } : undefined;
			},
			isSuppressed: () => cleared,
			commitIfCurrent: async (commit: () => Promise<"committed" | "busy">) => cleared ? "suppressed" as const : commit(),
		};
		await scheduler.admitCustom(record, delivery);
		cleared = true;
		await scheduler.reachSafeBoundary(record);
		await host.session.followUp("Unrelated ordinary input");
		finishModel.resolve();
		await initial;
		assert.equal(host.session.sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === reminder.customType), false,
			"a cleared reminder must not reach the native transcript");
		assert.equal(contexts.some(context => context.includes("original Moderator Input")), false);
		assert.ok(contexts.some(context => context.includes("Unrelated ordinary input")));
	} finally {
		finishModel.resolve();
		scheduler.shutdownProgress();
	}
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(yes => { resolve = yes; });
	return { promise, resolve };
}

for (const outcome of ["suppressed", "failed"] as const) {
	test(`a ${outcome} reminder releases scheduler retention without another native settlement`, { timeout: 5000 }, async () => {
		const lane = new SerialLane();
		const handle = { sequence: 1 };
		const released = deferred();
		const prepared = deferred();
		const finish = deferred();
		const reasons = new Set<string>();
		const record = {
			identity: { agentId: "moderator" },
			host: {
				lane, currentHandle: () => handle, isCurrent: () => true,
				addSettledHandler: () => () => {},
				addRetentionReason: (reason: string) => reasons.add(reason),
				removeRetentionReason: (reason: string) => reasons.delete(reason),
				blocksOrdinaryDelivery: () => false,
				currentWorkState: () => "settled",
				observe: () => ({ phase: "live", work: "settled", attention: "none", retentionReasons: [] }),
				releaseIfEligibleInLane: () => { if (!reasons.size) released.resolve(); },
				async deliverModeratorReminderInLane() {
					prepared.resolve();
					await finish.promise;
					if (outcome === "failed") throw new Error("admission failed");
					return "suppressed";
				},
			},
		} as unknown as AgentRecord;
		const scheduler = new MessageDeliveryScheduler({ workflowPolicy: new WorkflowPolicyStore() });
		try {
			await scheduler.admitCustom(record, {
				messageId: "reminder", deliveryMode: "deferred",
				customMessage: createModelVisibleModeratorObligationReminder(),
				inspectProof: () => undefined,
				commitIfCurrent: async () => "suppressed",
			});
			await prepared.promise;
			assert.ok(reasons.has("pending_delivery"));
			finish.resolve();
			await released.promise;
			assert.equal(scheduler.hasProgress(record), false);
			assert.equal(reasons.has("pending_delivery"), false);
		} finally { finish.resolve(); scheduler.shutdownProgress(); }
	});
}

for (const kind of ["message", "request"] as const) {
	test(`failed reminder preparation advances an already admitted ${kind} without an external boundary`, { timeout: 5000 }, async () => {
		const lane = new SerialLane();
		const handle = { sequence: 1 };
		const finishPreparation = deferred();
		const releaseEvaluated = deferred();
		const delivered: string[] = [];
		const record = {
			identity: { agentId: "moderator" },
			host: {
				lane, currentHandle: () => handle, isCurrent: () => true,
				addSettledHandler: () => () => {},
				addRetentionReason() {}, removeRetentionReason() {},
				blocksOrdinaryDelivery: () => false,
				currentWorkState: () => "settled",
				observe: () => ({ phase: "live", work: "settled", attention: "none", retentionReasons: [] }),
				releaseIfEligibleInLane: () => releaseEvaluated.resolve(),
				async deliverModeratorReminderInLane() {
					await finishPreparation.promise;
					throw new Error("native preparation failed");
				},
				deliverInLane(delivery: { message: { content: string } }) {
					delivered.push(delivery.message.content);
					return { completion: Promise.resolve() };
				},
			},
		} as unknown as AgentRecord;
		const scheduler = new MessageDeliveryScheduler({ workflowPolicy: new WorkflowPolicyStore() });
		const content = `ordinary ${kind} admitted during reminder preparation`;
		try {
			await scheduler.admitCustom(record, {
				messageId: "reminder", deliveryMode: "deferred",
				customMessage: createModelVisibleModeratorObligationReminder(),
				inspectProof: () => undefined,
				commitIfCurrent: async commit => commit(),
			});
			await scheduler.admit(record, {
				messageId: "ordinary", deliveryMode: "deferred", isIncomingRequest: kind === "request",
				inspectProof: () => undefined,
				deliveryItem: {
					source: { agentId: "sender", entryId: "source", toolCallId: "ordinary" },
					projection: kind === "message"
						? { kind, messageId: "ordinary", fromAgentId: "sender", content }
						: { title: "Fixture request", kind, requestMessageId: "ordinary", fromAgentId: "sender", question: content },
				},
			});
			assert.equal(delivered.length, 0, "preparation still owns the dispatch reservation");
			finishPreparation.resolve();
			// Failure completion already evaluates release; observing it does not kick scheduling.
			await releaseEvaluated.promise;
			assert.equal(delivered.length, 1, "eligible delivery must advance without another settlement");
			assert.ok(delivered[0]?.includes(content));
		} finally {
			finishPreparation.resolve();
			scheduler.shutdownProgress();
		}
	});
}
