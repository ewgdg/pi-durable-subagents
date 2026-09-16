import assert from "node:assert/strict";
import test from "node:test";
import { ManagedWriterInventory } from "../src/repair/managed-writer-inventory.ts";
import { OwnerRetirement } from "../src/repair/owner-retirement.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("retirement joins launches already pending, and exact process exit after failed launch", async () => {
	const inventory = new ManagedWriterInventory();
	const preparing = deferred();
	const exit = deferred();
	const launch = inventory.launch(async (observeExit) => {
		await preparing.promise;
		observeExit(exit.promise);
		throw new Error("admission rejected");
	});
	void launch.catch(() => undefined);
	let retired = false;
	const retirement = inventory.retire().then(() => { retired = true; });
	assert.throws(() => inventory.launch(async () => undefined), /retir/);
	preparing.resolve();
	await assert.rejects(launch, /admission rejected/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(retired, false);
	exit.resolve();
	await retirement;
	assert.equal(retired, true);
});

test("cleanup rejection remains authoritative on repeated retirement", async () => {
	const cleanupError = new Error("native disposal failed");
	const native = {
		abortBash() {}, isBashRunning: false, hasPendingBashMessages: false, isIdle: true,
		async abort() {}, async waitForIdle() {},
	};
	const retirement = new OwnerRetirement(native);
	retirement.setCoordinatorCleanup(async () => { throw cleanupError; });
	const first = retirement.prepare();
	await assert.rejects(first, (error) => error === cleanupError);
	assert.equal(retirement.prepare(), first);
	assert.throws(() => retirement.assertRetired(), /cleanup/);
});

test("native bash persistence drains before abort, and shutdown is rechecked after replacement", async () => {
	const events: string[] = [];
	const native = {
		isBashRunning: true, hasPendingBashMessages: false, isIdle: true,
		abortBash() { events.push("bash cancel"); setTimeout(() => { events.push("bash persisted"); native.isBashRunning = false; }, 5); },
		async abort() { events.push("abort"); }, async waitForIdle() { events.push("idle"); },
	};
	const retirement = new OwnerRetirement(native);
	retirement.establishNoCoordinator();
	await retirement.prepare();
	assert.deepEqual(events, ["bash cancel", "bash persisted", "abort", "idle"]);
	assert.throws(() => retirement.assertRetired(), /replacement/);
	retirement.replacementCompleted();
	retirement.assertRetired();
	native.hasPendingBashMessages = true;
	assert.throws(() => retirement.assertRetired(), /bash/);
});

test("unknown coordinator cleanup cannot authorize repair", async () => {
	const retirement = new OwnerRetirement({
		abortBash() {}, isBashRunning: false, hasPendingBashMessages: false, isIdle: true,
		async abort() {}, async waitForIdle() {},
	});
	await assert.rejects(retirement.prepare(), /unknown/);
});
