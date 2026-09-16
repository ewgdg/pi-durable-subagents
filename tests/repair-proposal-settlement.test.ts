import assert from "node:assert/strict";
import test from "node:test";
import { ProposalSettlementGate } from "../src/repair/proposal-settlement.ts";

function settle(gate: ProposalSettlementGate) {
	return gate.freezeOnSettlement({ generation: gate.generation, outcome: "completed", hasPendingMessages: false });
}

test("only an explicit complete report at a successful idle settlement freezes a proposal once", () => {
	const gate = new ProposalSettlementGate();
	assert.equal(settle(gate), undefined);
	gate.reportComplete();
	const authorization = settle(gate);
	assert.ok(authorization);
	assert.equal(gate.state, "validating");
	assert.equal(settle(gate), undefined);
	gate.beginApplication(authorization);
	assert.equal(gate.state, "applying");
	assert.equal(settle(gate), undefined);
	assert.throws(() => gate.beginApplication(authorization), /not validating/);
});

for (const outcome of ["aborted", "error"] as const) test(`${outcome} invalidates completion without ending the conversation`, () => {
	const gate = new ProposalSettlementGate();
	gate.reportComplete();
	assert.equal(gate.freezeOnSettlement({ generation: gate.generation, outcome, hasPendingMessages: false }), undefined);
	assert.equal(settle(gate), undefined, "a later successful boundary must not reuse the old completion");
	gate.reportComplete();
	assert.ok(settle(gate), "new explicit completion can authorize a corrected proposal");
});

test("queued input invalidates completion even if the queue drains before the next settlement", () => {
	const gate = new ProposalSettlementGate();
	gate.reportComplete();
	assert.equal(gate.freezeOnSettlement({ generation: gate.generation, outcome: "completed", hasPendingMessages: true }), undefined);
	assert.equal(settle(gate), undefined);
	gate.reportComplete();
	assert.ok(settle(gate));
});

test("input, candidate writes, and immediate abort invalidation reject stale settlement observations", () => {
	const gate = new ProposalSettlementGate();
	for (const _event of ["interactive input", "steering", "followup", "candidate write", "Esc"]) {
		gate.reportComplete();
		const observed = gate.generation;
		gate.invalidate();
		assert.equal(settle(gate), undefined);
		gate.reportComplete();
		assert.equal(gate.freezeOnSettlement({ generation: observed, outcome: "completed", hasPendingMessages: false }), undefined);
	}
	assert.ok(settle(gate));
});

test("rejected validation permits correction but requires a new complete report and new authorization", () => {
	const gate = new ProposalSettlementGate();
	gate.reportComplete();
	const rejected = settle(gate)!;
	assert.throws(() => gate.invalidate(), /frozen/);
	assert.throws(() => gate.reportComplete(), /frozen/);
	gate.validationRejected(rejected);
	assert.equal(gate.state, "editing");
	assert.equal(settle(gate), undefined);
	gate.invalidate();
	gate.reportComplete();
	const corrected = settle(gate)!;
	assert.throws(() => gate.beginApplication(rejected), /Stale/);
	assert.throws(() => gate.validationRejected(rejected), /Stale/);
	gate.beginApplication(corrected);
	assert.throws(() => gate.validationRejected(corrected), /not validating/);
	assert.throws(() => gate.invalidate(), /frozen/);
	assert.throws(() => gate.reportComplete(), /frozen/);
});

test("an authorization cannot apply another conversation's proposal", () => {
	const first = new ProposalSettlementGate();
	const second = new ProposalSettlementGate();
	first.reportComplete();
	second.reportComplete();
	const firstAuthorization = settle(first)!;
	const secondAuthorization = settle(second)!;
	assert.throws(() => second.beginApplication(firstAuthorization), /Stale/);
	second.beginApplication(secondAuthorization);
});
