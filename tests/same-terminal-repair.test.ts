import assert from "node:assert/strict";
import test from "node:test";
import { startSameTerminalRepair } from "../src/repair/same-terminal-repair.ts";

function fixture(options: { cleanupFailure?: boolean; cancelParking?: boolean; admission?: boolean } = {}) {
	const events: string[] = [];
	const ui = { getEditorText: () => "", setEditorText() {}, notify: (message: string) => { events.push(message); } };
	const fresh = {
		ui,
		async switchSession(path: string, { withSession }: { withSession(ctx: unknown): Promise<void> }) {
			events.push(`open ${path}`);
			await withSession({ ui });
			return { cancelled: false };
		},
	};
	const initial = {
		ui,
		async switchSession(path: string, { withSession }: { withSession(ctx: unknown): Promise<void> }) {
			events.push(`open ${path}`);
			if (options.cancelParking) return { cancelled: true };
			await withSession(fresh);
			return { cancelled: false };
		},
	};
	return {
		events,
		options: {
			context: initial as never,
			ownerPath: "owner.jsonl", repairHostPath: "host.jsonl",
			retirement: {
				async prepare() { events.push("cleanup"); if (options.cleanupFailure) throw new Error("cleanup rejected"); },
				replacementCompleted() { events.push("replacement complete"); },
				assertRetired() { events.push("retirement verified"); },
			},
			helper: {
				async repair() { events.push("snapshot and commit"); },
				async recordAdmission(admitted: boolean, diagnostic?: string) { events.push(admitted ? "admitted" : `failed: ${diagnostic}`); },
				async refuse(reason: string) { events.push(`refused: ${reason}`); },
			},
			admission: () => options.admission !== false,
		},
	};
}

test("one invocation retires into unrelated host, commits before reopening, and needs no confirmation", async () => {
	const { options, events } = fixture();
	const result = await (await startSameTerminalRepair(options)).completion;
	assert.equal(result, "admitted");
	assert.deepEqual(events.slice(0, 7), ["cleanup", "open host.jsonl", "replacement complete", "retirement verified", "snapshot and commit", "open owner.jsonl", "admitted"]);
});

test("failed cleanup and cancelled parking cannot start snapshot", async () => {
	for (const failure of [{ cleanupFailure: true }, { cancelParking: true }]) {
		const { options, events } = fixture(failure);
		assert.equal(await (await startSameTerminalRepair(options)).completion, "refused");
		assert.equal(events.includes("snapshot and commit"), false);
	}
});

test("failed fresh admission records committed data outcome without throwing from replacement", async () => {
	const { options, events } = fixture({ admission: false });
	assert.equal(await (await startSameTerminalRepair(options)).completion, "committed_admission_failed");
	assert.ok(events.includes("snapshot and commit"));
	assert.ok(events.some((event) => event.startsWith("failed:")));
	assert.equal(events.some((event) => event.startsWith("refused:")), false);
});

test("replacement callback refusal is contained, never propagated into Pi fatal replacement", async () => {
	const { options, events } = fixture();
	options.retirement.assertRetired = () => { throw new Error("late bash write"); };
	assert.equal(await (await startSameTerminalRepair(options)).completion, "refused");
	assert.equal(events.includes("snapshot and commit"), false);
	assert.ok(events.includes("refused: late bash write"));
});
