import assert from "node:assert/strict";
import test from "node:test";

import {
	OperationReviewWatcher,
} from "../src/coordination/operation-review.ts";
import type { ToolCallPointer } from "../src/protocol/identities.ts";
import { ControllableOperationReviewClock } from "./support/controllable-operation-review-clock.ts";

test("a root call expires from admission and clears with its final obligation", () => {
	const clock = new ControllableOperationReviewClock();
	const unresolved = new Set(["blocking-call"]);
	const obligatedAgents = new Set(["agent-1"]);
	const watcher = new OperationReviewWatcher({
		clock,
		isUnresolved: ({ toolCallId }) => unresolved.has(toolCallId),
		hasAnswerObligation: (agentId) => obligatedAgents.has(agentId),
	});
	const toolCall = pointer("agent-1", "assistant-1", "blocking-call");

	watcher.admit({
		toolCall,
		policyIntervalMs: 1_000,
	});
	clock.advanceBy(999);
	assert.deepEqual(watcher.expiredReviews(), []);

	clock.advanceBy(1);
	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall, reviewIntervalMs: 1_000 },
	]);

	watcher.reconcileAgent("agent-1");
	clock.advanceBy(10_000);
	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall, reviewIntervalMs: 1_000 },
	]);

	obligatedAgents.delete("agent-1");
	watcher.reconcileAgent("agent-1");
	assert.deepEqual(watcher.expiredReviews(), []);

	obligatedAgents.add("agent-1");
	watcher.reconcileAgent("agent-1");
	clock.advanceBy(1_000);
	assert.deepEqual(watcher.expiredReviews(), []);
});

test("terminal tool-result commitment ends review before expiry", () => {
	const clock = new ControllableOperationReviewClock();
	const unresolved = new Set(["completed-call"]);
	const watcher = new OperationReviewWatcher({
		clock,
		isUnresolved: ({ toolCallId }) => unresolved.has(toolCallId),
		hasAnswerObligation: () => true,
	});

	watcher.admit({
		toolCall: pointer("agent-1", "assistant-1", "completed-call"),
		policyIntervalMs: 1_000,
	});
	unresolved.delete("completed-call");
	watcher.reconcileAgent("agent-1");
	clock.advanceBy(1_000);

	assert.deepEqual(watcher.expiredReviews(), []);
});

test("ending the exact Run removes all of its unresolved reviewed calls", () => {
	const clock = new ControllableOperationReviewClock();
	const watcher = new OperationReviewWatcher({
		clock,
		isUnresolved: () => true,
		hasAnswerObligation: () => true,
	});
	watcher.admit({
		toolCall: pointer("agent-1", "assistant-1", "abandoned-call"),
		policyIntervalMs: 1_000,
	});

	watcher.endRun("agent-1");
	clock.advanceBy(1_000);

	assert.deepEqual(watcher.expiredReviews(), []);
});

test("independent calls expire from their own admission", () => {
	const clock = new ControllableOperationReviewClock();
	const watcher = new OperationReviewWatcher({
		clock,
		isUnresolved: () => true,
		hasAnswerObligation: () => true,
	});
	const first = pointer("agent-1", "assistant-1", "first-call");
	const second = pointer("agent-1", "assistant-1", "second-call");
	watcher.admit({
		toolCall: first,
		policyIntervalMs: 1_000,
	});
	watcher.admit({
		toolCall: second,
		policyIntervalMs: 2_000,
	});

	clock.advanceBy(1_000);
	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall: first, reviewIntervalMs: 1_000 },
	]);

	clock.advanceBy(1_000);
	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall: first, reviewIntervalMs: 1_000 },
		{ toolCall: second, reviewIntervalMs: 2_000 },
	]);
});

test("Human waiting excludes time between Request commit and result-commit work", () => {
	const clock = new ControllableOperationReviewClock();
	const watcher = new OperationReviewWatcher({
		clock,
		isUnresolved: () => true,
		hasAnswerObligation: () => true,
	});
	const toolCall = pointer("agent-1", "assistant-1", "human-question");
	watcher.admit({
		toolCall,
		policyIntervalMs: 1_000,
	});

	clock.advanceBy(999);
	watcher.beginHumanWaiting(toolCall);
	clock.advanceBy(10_000);
	assert.deepEqual(watcher.expiredReviews(), []);

	watcher.beginHumanResultCommit(toolCall);
	clock.advanceBy(1_000);
	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall, reviewIntervalMs: 1_000 },
	]);

	watcher.beginHumanWaiting(toolCall);
	assert.deepEqual(watcher.expiredReviews(), []);
});

test("Human waiting cannot clear an expired review after Moderator Input commits", () => {
	const clock = new ControllableOperationReviewClock();
	const watcher = new OperationReviewWatcher({
		clock,
		isUnresolved: () => true,
		hasAnswerObligation: () => true,
	});
	const toolCall = pointer("agent-1", "assistant-1", "committed-human-review");
	watcher.admit({
		toolCall,
		policyIntervalMs: 1_000,
	});
	clock.advanceBy(1_000);
	watcher.markModeratorInputCommitted(toolCall);

	watcher.beginHumanWaiting(toolCall);

	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall, reviewIntervalMs: 1_000 },
	]);
});

test("Moderator renewal restarts only an exact unresolved reviewable call within policy", () => {
	const clock = new ControllableOperationReviewClock();
	const unresolved = new Set(["renewed-call", "completed-call"]);
	const watcher = new OperationReviewWatcher({
		clock,
		isUnresolved: ({ toolCallId }) => unresolved.has(toolCallId),
		hasAnswerObligation: () => true,
	});
	const renewedCall = pointer("agent-1", "assistant-1", "renewed-call");
	const completedCall = pointer("agent-1", "assistant-1", "completed-call");
	for (const toolCall of [renewedCall, completedCall]) {
		watcher.admit({
			toolCall,
			policyIntervalMs: 1_000,
		});
	}
	clock.advanceBy(1_000);

	assert.equal(watcher.renew(renewedCall, 500), "renewed");
	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall: completedCall, reviewIntervalMs: 1_000 },
	]);
	clock.advanceBy(500);
	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall: renewedCall, reviewIntervalMs: 500 },
		{ toolCall: completedCall, reviewIntervalMs: 1_000 },
	]);

	unresolved.delete("completed-call");
	assert.equal(watcher.renew(completedCall, 500), "stale");
	assert.throws(
		() => watcher.renew(renewedCall, 1_001),
		/invalid_input: renewal interval exceeds the captured Workflow Policy interval/,
	);
});

test("explicit renewal replaces an established review and restarts only its own interval", () => {
	const clock = new ControllableOperationReviewClock();
	const watcher = new OperationReviewWatcher({
		clock,
		isUnresolved: () => true,
		hasAnswerObligation: () => true,
	});
	const toolCall = pointer("agent-1", "assistant-1", "renewed-expired-call");
	watcher.admit({
		toolCall,
		policyIntervalMs: 1_000,
	});
	clock.advanceBy(1_000);

	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall, reviewIntervalMs: 1_000 },
	]);

	assert.equal(watcher.renew(toolCall, 500), "renewed");
	assert.deepEqual(watcher.expiredReviews(), []);
	clock.advanceBy(500);

	assert.deepEqual(watcher.expiredReviews(), [
		{ toolCall, reviewIntervalMs: 500 },
	]);
});

function pointer(
	agentId: string,
	entryId: string,
	toolCallId: string,
): ToolCallPointer {
	return { agentId, entryId, toolCallId };
}
