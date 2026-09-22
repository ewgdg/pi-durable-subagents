import assert from "node:assert/strict";
import test from "node:test";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
import { preadmissionFailureNotice, setupPreadmissionRepairHost } from "../src/bootstrap/preadmission-host.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { createUnboundTestOwnerHost } from "./support/pi-host.ts";

function failureFor(agentId: string): OwnerRecoveryError {
	return new OwnerRecoveryError("Owner coordination initialization", agentId, undefined, new ProtocolInvariantError("committed Request is invalid", { source: { agentId, entryId: "source-entry", toolCallId: "source-call" }, cause: new Error("boom") }));
}

test("preadmission failure notice keeps a visible signal with no writes", () => {
	const notice = preadmissionFailureNotice(new Error("capture-boom"));
	assert.ok(notice.indexOf("Preadmission repair host unavailable") !== -1);
	assert.ok(notice.indexOf("capture-boom") !== -1);
	assert.ok(notice.indexOf("Diagnostics remain available; no transcript was modified") !== -1);
});

test("preadmission setup refuses identity mismatch and failed capture without a host", async () => {
	await assert.rejects(setupPreadmissionRepairHost({ captureRuntime: async () => { throw new Error("unreachable"); }, entryModulePath: "<inline>", failure: failureFor("owner-a"), identifiedOwnerId: "owner-b", ownerIdentified: true }), /identity_mismatch/);
	await assert.rejects(setupPreadmissionRepairHost({ captureRuntime: async () => { throw new Error("unreachable"); }, entryModulePath: "<inline>", failure: failureFor("owner-a"), identifiedOwnerId: undefined, ownerIdentified: false }), /identity_mismatch/);
	await assert.rejects(setupPreadmissionRepairHost({ captureRuntime: async () => { throw new Error("capture-boom"); }, entryModulePath: "<inline>", failure: failureFor("owner-a"), identifiedOwnerId: "owner-a", ownerIdentified: true }), /capture-boom/);
});

test("preadmission setup evidence matches the coordinator host directories", async (t) => {
	const host = await createUnboundTestOwnerHost(t, (() => {}) as never, { persistent: true });
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const setup = await setupPreadmissionRepairHost({ captureRuntime: async () => host.runtime, entryModulePath: "<inline:pi-durable-subagents>", failure: failureFor(identity.agentId), identifiedOwnerId: identity.agentId, ownerIdentified: true });
	assert.equal(setup.ownerId, identity.agentId);
	assert.equal(setup.evidence.workflowDirectory, setup.coordinator.preadmissionRepairWorkflowDirectory());
	assert.equal(setup.resolvePreadmissionRepair().status().agentId, identity.agentId);
	await setup.coordinator.shutdown(async () => undefined);
	await host.runtime.dispose();
});
