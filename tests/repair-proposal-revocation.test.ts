import assert from "node:assert/strict";
import test from "node:test";
import { ProposalSettlementGate } from "../src/repair/proposal-settlement.ts";

function freeze(gate: ProposalSettlementGate) {
	return gate.freezeOnSettlement({ generation: gate.generation, outcome: "completed", hasPendingMessages: false })!;
}

for (const intervention of ["new input", "Esc abort"]) test(`${intervention} during asynchronous validation revokes application and requires a fresh complete report`, async () => {
	const gate = new ProposalSettlementGate();
	gate.reportComplete();
	const authorization = freeze(gate);
	let release!: () => void;
	const validating = new Promise<void>(resolve => { release = resolve; });
	let applied = false;
	const decision = (async () => {
		await validating;
		if (gate.beginApplication(authorization)) applied = true;
	})();
	assert.equal(gate.revokeCompletion(), true);
	assert.equal(gate.state, "validating", "candidate writes stay frozen while validation still reads them");
	assert.throws(() => gate.invalidate(), /frozen/);
	release();
	await decision;
	assert.equal(applied, false);
	assert.equal(gate.state, "editing");
	assert.equal(freeze(gate), undefined);
	gate.reportComplete();
	assert.equal(gate.beginApplication(freeze(gate)), true);
	assert.equal(gate.revokeCompletion(), false, "application is an irreversible boundary");
});

test("terminal highwater changes after complete cannot be erased by a delayed valid seal", () => {
	const gate = new ProposalSettlementGate();
	gate.reportComplete();
	const authorization = freeze(gate);
	gate.revokeCompletion();
	gate.revokeCompletion();
	assert.equal(gate.beginApplication(authorization), false);
	assert.throws(() => gate.beginApplication(authorization), /not validating/);
	gate.reportComplete();
	assert.equal(gate.beginApplication(freeze(gate)), true);
});
