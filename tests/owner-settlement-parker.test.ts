import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type {
	Agent,
	AgentEvent,
	AgentMessage,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { installOwnerSettlementParker } from "../src/pi-integration/owner-settlement-parker.ts";

test("Owner parking runs after Pi's awaited listener and wakes only after queue admission", async () => {
	const agent = new TestAgent();
	const lifecycle: string[] = [];
	let extensionFinished = false;
	agent.subscribe(async (event) => {
		if (event.type !== "agent_end") return;
		lifecycle.push("pi:start");
		await Promise.resolve();
		extensionFinished = true;
		lifecycle.push("pi:end");
	});
	const parking = installOwnerSettlementParker({
		agent: agent.asAgent(),
		subscribeToProgressChanges: () => () => undefined,
		hasAutonomousProgress: () => true,
		async beginParking() {
			assert.equal(extensionFinished, true);
			lifecycle.push("park:start");
			return () => {
				lifecycle.push("park:end");
			};
		},
	});
	const run = agent.emit(cleanAgentEnd(), new AbortController().signal);
	await waitUntil(() => lifecycle.includes("park:start"));
	assert.equal(await isSettled(run), false);

	agent.steer(customMessage("wake-owner"));
	await run;
	assert.deepEqual(lifecycle, ["pi:start", "pi:end", "park:start", "park:end"]);
	parking.dispose();
});

test("parking bypasses absent progress, queued continuation, and non-successful low-level Runs", async () => {
	for (const candidate of [
		{ name: "no progress", progressing: false, event: cleanAgentEnd(), queued: false },
		{ name: "queued continuation", progressing: true, event: cleanAgentEnd(), queued: true },
		{ name: "error", progressing: true, event: terminalAgentEnd("error"), queued: false },
		{ name: "aborted", progressing: true, event: terminalAgentEnd("aborted"), queued: false },
		{ name: "overflow length", progressing: true, event: terminalAgentEnd("length"), queued: false },
		{ name: "deferred continuation", progressing: true, event: terminalAgentEnd("deferred"), queued: false },
	]) {
		const agent = new TestAgent();
		if (candidate.queued) agent.followUp(customMessage("already-queued"));
		let parkingEntries = 0;
		const binding = installOwnerSettlementParker({
			agent: agent.asAgent(),
			subscribeToProgressChanges: () => () => undefined,
			hasAutonomousProgress: () => candidate.progressing,
			beginParking: () => {
				parkingEntries += 1;
				return () => undefined;
			},
		});
		await agent.emit(candidate.event, new AbortController().signal);
		assert.equal(parkingEntries, 0, candidate.name);
		binding.dispose();
	}
});

test("failed enqueue does not wake parking and the exact Run abort resolves without rejection", async () => {
	const agent = new TestAgent();
	let parkingEntries = 0;
	const binding = installOwnerSettlementParker({
		agent: agent.asAgent(),
		subscribeToProgressChanges: () => () => undefined,
		hasAutonomousProgress: () => true,
		beginParking: () => {
			parkingEntries += 1;
			return () => undefined;
		},
	});
	const firstAbort = new AbortController();
	const firstRun = agent.emit(cleanAgentEnd(), firstAbort.signal);
	await waitUntil(() => parkingEntries === 1);
	agent.failNextSteer = true;
	assert.throws(() => agent.steer(customMessage("rejected")), /enqueue failed/);
	assert.equal(await isSettled(firstRun), false);
	firstAbort.abort();
	await firstRun;

	const secondRun = agent.emit(cleanAgentEnd(), new AbortController().signal);
	await waitUntil(() => parkingEntries === 2);
	agent.followUp(customMessage("admitted"));
	await secondRun;
	binding.dispose();
});

test("queue observation is installed once, closes the waiter race, and restores both methods", async () => {
	const agent = new TestAgent();
	const nativeSteer = agent.steer;
	const nativeFollowUp = agent.followUp;
	let parkingEntries = 0;
	const options = {
		agent: agent.asAgent(),
		subscribeToProgressChanges: () => () => undefined,
		hasAutonomousProgress: () => true,
		async beginParking() {
			parkingEntries += 1;
			agent.followUp(customMessage("admitted-during-entry"));
			return () => undefined;
		},
	};
	const first = installOwnerSettlementParker(options);
	const installedSteer = agent.steer;
	const installedFollowUp = agent.followUp;
	const second = installOwnerSettlementParker(options);
	assert.equal(agent.steer, installedSteer);
	assert.equal(agent.followUp, installedFollowUp);

	await agent.emit(cleanAgentEnd(), new AbortController().signal);
	assert.equal(parkingEntries, 1);
	first.dispose();
	assert.equal(agent.steer, installedSteer);
	second.dispose();
	assert.equal(agent.steer, nativeSteer);
	assert.equal(agent.followUp, nativeFollowUp);
});

test("vanished progress and parking setup failure both leave Agent listeners non-rejecting", async () => {
	for (const candidate of [
		"reconciled" as const,
		"inspection" as const,
		"failure" as const,
	]) {
		const agent = new TestAgent();
		const reported: unknown[] = [];
		const binding = installOwnerSettlementParker({
			agent: agent.asAgent(),
			subscribeToProgressChanges: () => () => undefined,
			hasAutonomousProgress: () => {
				if (candidate === "inspection") throw new Error("inspection failed");
				return true;
			},
			beginParking: () => {
				if (candidate === "reconciled") return undefined;
				throw new Error("parking setup failed");
			},
			reportError: (error) => reported.push(error),
		});
		await agent.emit(cleanAgentEnd(), new AbortController().signal);
		assert.equal(reported.length, candidate === "reconciled" ? 0 : 1);
		binding.dispose();
	}
});

test("Owner parks again after each resumed low-level response until progress ends", async () => {
	const agent = new TestAgent();
	let progressing = true;
	let parkingEntries = 0;
	const binding = installOwnerSettlementParker({
		agent: agent.asAgent(),
		subscribeToProgressChanges: () => () => undefined,
		hasAutonomousProgress: () => progressing,
		beginParking: () => {
			parkingEntries += 1;
			return () => undefined;
		},
	});

	const first = agent.emit(cleanAgentEnd(), new AbortController().signal);
	await waitUntil(() => parkingEntries === 1);
	agent.steer(customMessage("first-wake"));
	await first;
	agent.clearAllQueues();
	const second = agent.emit(cleanAgentEnd(), new AbortController().signal);
	await waitUntil(() => parkingEntries === 2);
	agent.followUp(customMessage("second-wake"));
	await second;
	agent.clearAllQueues();
	progressing = false;
	await agent.emit(cleanAgentEnd(), new AbortController().signal);
	assert.equal(parkingEntries, 2);
	binding.dispose();
});

for (const lossDuringEntry of [false, true]) {
	test(`Owner parking observes progress loss without input (entry race: ${lossDuringEntry})`, async () => {
		const agent = new TestAgent();
		let progressing = true;
		let notify: (() => void) | undefined;
		let left = 0;
		const binding = installOwnerSettlementParker({
			agent: agent.asAgent(),
			hasAutonomousProgress: () => progressing,
			subscribeToProgressChanges: (handler) => {
				notify = handler;
				return () => { notify = undefined; };
			},
			async beginParking() {
				if (lossDuringEntry) progressing = false;
				return () => { left += 1; };
			},
		});
		const run = agent.emit(cleanAgentEnd(), new AbortController().signal);
		if (!lossDuringEntry) {
			await waitUntil(() => notify !== undefined);
			assert.equal(await isSettled(run), false);
			// A handoff within one event must not report workflow completion.
			progressing = false;
			notify!();
			progressing = true;
			notify!();
			assert.equal(await isSettled(run), false);
			progressing = false;
			notify!();
		}
		await run;
		assert.equal(left, 1);
		assert.equal(notify, undefined);
		assert.equal(agent.hasQueuedMessages(), false);
		binding.dispose();
	});
}

class TestAgent {
	readonly listeners = new Set<(
		event: AgentEvent,
		signal: AbortSignal,
	) => void | Promise<void>>();
	readonly steering: AgentMessage[] = [];
	readonly followUps: AgentMessage[] = [];
	failNextSteer = false;

	readonly subscribe = (
		listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>,
	) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly steer = (message: AgentMessage) => {
		if (this.failNextSteer) {
			this.failNextSteer = false;
			throw new Error("enqueue failed");
		}
		this.steering.push(message);
	};

	readonly followUp = (message: AgentMessage) => {
		this.followUps.push(message);
	};

	hasQueuedMessages = () => this.steering.length > 0 || this.followUps.length > 0;

	clearAllQueues(): void {
		this.steering.length = 0;
		this.followUps.length = 0;
	}

	asAgent(): Agent {
		return this as unknown as Agent;
	}

	async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
		for (const listener of this.listeners) await listener(event, signal);
	}
}

function cleanAgentEnd(): Extract<AgentEvent, { type: "agent_end" }> {
	return { type: "agent_end", messages: [fauxAssistantMessage("done")] };
}

function terminalAgentEnd(
	stopReason: "error" | "aborted" | "length" | "deferred",
): Extract<AgentEvent, { type: "agent_end" }> {
	return {
		type: "agent_end",
		messages: [fauxAssistantMessage("", { stopReason })],
	};
}

function customMessage(label: string): AgentMessage {
	return {
		role: "custom",
		customType: label,
		content: label,
		display: false,
		timestamp: Date.now(),
	};
}

async function isSettled(operation: Promise<void>): Promise<boolean> {
	return Promise.race([
		operation.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
	]);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Expected parking condition was not reached");
}
