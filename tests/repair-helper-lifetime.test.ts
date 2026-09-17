import assert from "node:assert/strict";
import test from "node:test";
import { launchOwnedRepairHelper, shutdownRepairHelpers } from "../src/repair/owner-repair.ts";

test("CLI shutdown fences a repair still awaiting prelaunch preparation", { timeout: 2000 }, async () => {
	let finishPreparation!: () => void;
	const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
	let launches = 0;
	const command = (async () => {
		await preparation;
		return launchOwnedRepairHelper("/unused-no-helper-may-be-born", async () => {
			launches++;
			throw new Error("A helper was launched after CLI shutdown completed");
		});
	})();
	await shutdownRepairHelpers();
	finishPreparation();
	await assert.rejects(command, /Original CLI is shutting down/);
	assert.equal(launches, 0, "the native launcher must never be invoked after shutdown");
});
