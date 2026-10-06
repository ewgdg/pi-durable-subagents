import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { ModeratorReminderAdmission } from "../src/process-runtime/moderator-reminder-admission.ts";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}
function admission(overrides: Partial<ConstructorParameters<typeof ModeratorReminderAdmission>[0]> = {}) {
	return new ModeratorReminderAdmission({
		admit: operation => operation(), prepare: async () => {}, isIdle: () => true,
		commit: async () => "committed", ...overrides,
	});
}
test("commit and suppression release reservations", { timeout: 1000 }, async () => {
	let commits = 0;
	const subject = admission({ commit: async () => { commits++; return "committed"; } });
	assert.equal(await subject.prepare("one"), true);
	await assert.rejects(subject.prepare("duplicate"), /already_reserved/);
	assert.throws(() => subject.finish("wrong", true), /reservation_missing/);
	assert.equal(await subject.finish("one", true), "committed");
	assert.equal(await subject.prepare("two"), true);
	assert.equal(await subject.finish("two", false), "suppressed");
	assert.equal(commits, 1);
});
test("busy after preparation waits for admission cleanup", { timeout: 1000 }, async () => {
	const cleanup = deferred();
	const operationDone = deferred();
	let idle = true;
	const subject = admission({
		admit: async operation => { await operation(); operationDone.resolve(); await cleanup.promise; },
		prepare: async () => { idle = false; }, isIdle: () => idle,
	});
	let settled = false;
	const preparing = subject.prepare("one").then(value => { settled = true; return value; });
	await operationDone.promise;
	await Promise.resolve();
	assert.equal(settled, false);
	cleanup.resolve();
	assert.equal(await preparing, false);
	idle = true;
	assert.equal(await subject.prepare("two"), false);
});
test("initial busy releases reservation", { timeout: 1000 }, async () => {
	const subject = admission({ isIdle: () => false });
	assert.equal(await subject.prepare("one"), false);
	assert.equal(await subject.prepare("two"), false);
});
test("preparation and commit failures release reservation", { timeout: 1000 }, async () => {
	let failPrepare = true;
	const subject = admission({
		prepare: async () => { if (failPrepare) throw new Error("prepare failed"); },
		commit: async () => { throw new Error("commit failed"); },
	});
	await assert.rejects(subject.prepare("one"), /prepare failed/);
	failPrepare = false;
	assert.equal(await subject.prepare("two"), true);
	await assert.rejects(subject.finish("two", true), /commit failed/);
	assert.equal(await subject.prepare("three"), true);
	assert.equal(await subject.finish("three", false), "suppressed");
});
test("cancellation before admission starts settles without an unhandled rejection", { timeout: 1000 }, async () => {
	let queued!: () => Promise<void>;
	let queue = true;
	const subject = admission({ admit: operation => {
		if (!queue) return operation();
		queued = operation;
		return new Promise<void>(() => {});
	} });
	const preparing = subject.prepare("one");
	const rejected = assert.rejects(preparing, /admission_cancelled/);
	subject.cancel();
	await rejected;
	queue = false;
	assert.equal(await subject.prepare("two"), true);
	await assert.rejects(queued(), /admission_cancelled/);
	assert.equal(await subject.finish("two", false), "suppressed");
});
test("cancellation releases a stuck preparation and prevents late commit", { timeout: 1000 }, async () => {
	const started = deferred();
	const preparation = deferred();
	let commits = 0;
	let stall = true;
	const subject = admission({
		prepare: async () => { if (stall) { started.resolve(); await preparation.promise; } },
		commit: async () => { commits++; return "committed"; },
	});
	const preparing = subject.prepare("one");
	const rejected = assert.rejects(preparing, /admission_cancelled/);
	await started.promise;
	const finished = assert.rejects(subject.finish("one", true), /admission_cancelled/);
	subject.cancel();
	await Promise.all([rejected, finished]);
	stall = false;
	assert.equal(await subject.prepare("two"), true);
	preparation.resolve();
	assert.equal(await subject.finish("two", false), "suppressed");
	assert.equal(commits, 0);
});
test("cancellation while awaiting decision releases gate", { timeout: 1000 }, async () => {
	const subject = admission();
	assert.equal(await subject.prepare("one"), true);
	const finished = assert.rejects(subject.finish("one", true), /admission_cancelled/);
	subject.cancel();
	await finished;
	assert.equal(await subject.prepare("two"), true);
	assert.equal(await subject.finish("two", false), "suppressed");
});
test("synchronous admission failure releases reservation", { timeout: 1000 }, async () => {
	const subject = admission({ admit: () => { throw new Error("admission failed"); } });
	await assert.rejects(subject.prepare("one"), /admission failed/);
	await assert.rejects(subject.prepare("two"), /admission failed/);
});

test("asynchronous admission failure releases reservation", { timeout: 1000 }, async () => {
	const subject = admission({ admit: async () => { throw new Error("admission failed"); } });
	await assert.rejects(subject.prepare("one"), /admission failed/);
	await assert.rejects(subject.prepare("two"), /admission failed/);
});
test("busy at commit reports busy and releases reservation", { timeout: 1000 }, async () => {
	let idle = true;
	// The native commit rechecks idleness itself and never dispatches into a busy session.
	const subject = admission({ isIdle: () => idle, commit: async () => idle ? "committed" : "busy" });
	assert.equal(await subject.prepare("one"), true);
	idle = false;
	assert.equal(await subject.finish("one", true), "busy");
	assert.equal(await subject.prepare("two"), false);
});
test("cancelled commit waits for native gate cleanup before releasing reservation", { timeout: 1000 }, async () => {
	const commitStarted = deferred();
	const gateReleased = deferred();
	const cleanup = deferred();
	const subject = admission({
		admit: async operation => {
			try { await operation(); }
			finally { gateReleased.resolve(); await cleanup.promise; }
		},
		commit: async signal => {
			commitStarted.resolve();
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			return "committed";
		},
	});
	assert.equal(await subject.prepare("one"), true);
	let settled = false;
	const finished = assert.rejects(subject.finish("one", true), /admission_cancelled/)
		.then(() => { settled = true; });
	await commitStarted.promise;
	subject.cancel();
	await gateReleased.promise;
	assert.equal(settled, false);
	await assert.rejects(subject.prepare("duplicate"), /already_reserved/);
	cleanup.resolve();
	await finished;
	assert.equal(await subject.prepare("two"), true);
	assert.equal(await subject.finish("two", false), "suppressed");
});

test("release without a reservation is idempotent but commit still requires one", { timeout: 1000 }, async () => {
	const subject = admission();
	assert.equal(await subject.finish("missing", false), "suppressed");
	assert.throws(() => subject.finish("missing", true), /reservation_missing/);
	assert.equal(await subject.prepare("one"), true);
	assert.throws(() => subject.finish("other", false), /reservation_missing/);
	assert.equal(await subject.finish("one", false), "suppressed");
	assert.equal(await subject.finish("one", false), "suppressed");
});
test("explicit release after interruption cancellation is idempotent", { timeout: 1000 }, async () => {
	const started = deferred();
	const subject = admission({ prepare: async () => { started.resolve(); await new Promise<void>(() => {}); } });
	const preparing = assert.rejects(subject.prepare("one"), /admission_cancelled/);
	await started.promise;
	subject.cancel();
	await preparing;
	assert.equal(await subject.finish("one", false), "suppressed");
	assert.throws(() => subject.finish("one", true), /reservation_missing/);
});
