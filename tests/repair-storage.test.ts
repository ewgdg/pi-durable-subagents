import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rename, open, symlink, link, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearAbandonedRepairLease, createRepairSnapshot, recoverRepair } from "../src/repair/storage.ts";

async function sync(path: string) {
	const handle = await open(path, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "repair-storage-"));
	const ownerPath = join(directory, "owner.jsonl");
	const participantDirectory = join(directory, "participants");
	await mkdir(participantDirectory);
	const child = join(participantDirectory, "invalid.jsonl");
	await writeFile(ownerPath, "owner before\n", { mode: 0o640 });
	await writeFile(child, "invalid before\n", { mode: 0o600 });
	return { root: join(directory, "repair"), attemptId: "attempt-1", ownerPath,
		participantDirectory, child, retirement: { verified: true as const, evidence: "joined writers" } };
}

test("snapshot includes invalid candidates; sealed multi-file repair preserves modes and durable commit", async () => {
	const options = await fixture();
	const snapshot = await createRepairSnapshot(options);
	assert.equal(snapshot.manifest.files.length, 2);
	for (const file of snapshot.manifest.files) await writeFile(snapshot.candidatePath(file.id), `${file.id} after\n`);
	const seal = await snapshot.seal(async ({ before, after }) => {
		assert.equal(before.length, 2);
		assert.equal(after.length, 2);
		return { valid: true, report: "whole workflow checked" };
	});
	assert.equal((await snapshot.apply(seal, { authorizedAttemptId: options.attemptId })).status, "committed");
	assert.equal((await stat(options.ownerPath)).mode & 0o777, 0o640);
	assert.equal((await stat(options.child)).mode & 0o777, 0o600);
	await snapshot.release();
	await writeFile(options.ownerPath, "postcommit native append\n", { flag: "a" });
	assert.equal((await recoverRepair(options)).status, "committed");
	assert.match(await readFile(options.ownerPath, "utf8"), /postcommit native append/);
});

test("interrupted replacement restores the whole set, and restored recovery preserves later native writes", async () => {
	const options = await fixture();
	let replacements = 0;
	const snapshot = await createRepairSnapshot({ ...options, io: { sync, rename: async (from, to) => {
		if (++replacements === 2) throw new Error("rename interrupted");
		await rename(from, to);
	} } });
	for (const file of snapshot.manifest.files) await writeFile(snapshot.candidatePath(file.id), "repaired\n");
	const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
	await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), /interrupted/);
	assert.equal(await readFile(options.ownerPath, "utf8"), "repaired\n");
	assert.equal(await readFile(options.child, "utf8"), "invalid before\n");
	await snapshot.release();
	assert.equal((await recoverRepair(options)).status, "restored");
	assert.equal(await readFile(options.ownerPath, "utf8"), "owner before\n");
	assert.equal(await readFile(options.child, "utf8"), "invalid before\n");
	await writeFile(options.ownerPath, "native\n", { flag: "a" });
	assert.equal((await recoverRepair(options)).status, "restored");
	assert.match(await readFile(options.ownerPath, "utf8"), /native/);
});

test("candidate, source, membership, report, snapshot and manifest tampering refuse before originals change", async () => {
	for (const target of ["candidate", "source", "directory", "report", "snapshot", "manifest", "extra-candidate"]) {
		const options = await fixture();
		const snapshot = await createRepairSnapshot(options);
		await writeFile(snapshot.candidatePath("file-0"), "repaired\n");
		const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
		const dir = join(options.root, options.attemptId);
		const paths: Record<string, string> = {
			candidate: snapshot.candidatePath("file-0"), source: options.ownerPath,
			directory: join(options.participantDirectory, "new.jsonl"),
			report: join(dir, "seals", seal.id, "report.txt"),
			snapshot: join(dir, "snapshot", "file-0"), manifest: join(dir, "manifest.json"),
			"extra-candidate": join(dir, "candidate", "file-2"),
		};
		// Audit/snapshot files intentionally resist accidental editing; changing permissions
		// emulates an operator editing them and must still invalidate their binding.
		if (["report", "snapshot", "manifest"].includes(target)) {
			const { chmod } = await import("node:fs/promises");
			await chmod(paths[target], 0o600);
		}
		await writeFile(paths[target], "tampered\n");
		await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), { name: "Error" }, target);
		assert.equal(await readFile(options.ownerPath, "utf8"), target === "source" ? "tampered\n" : "owner before\n");
		assert.equal(await readFile(options.child, "utf8"), "invalid before\n");
		await snapshot.release();
	}
});

async function interruptedFixture() {
	const options = await fixture();
	let replacements = 0;
	const snapshot = await createRepairSnapshot({ ...options, io: { sync, rename: async (from, to) => {
		if (++replacements === 2) throw new Error("crash");
		await rename(from, to);
	} } });
	for (const file of snapshot.manifest.files) await writeFile(snapshot.candidatePath(file.id), "repaired\n");
	const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
	await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), /crash/);
	await snapshot.release();
	return options;
}

test("unknown hash in the last destination refuses whole-set recovery without overwriting the first", async () => {
	const options = await interruptedFixture();
	await writeFile(options.child, "unknown external write\n");
	await assert.rejects(recoverRepair(options), /unknown destination/);
	assert.equal(await readFile(options.ownerPath, "utf8"), "repaired\n");
	assert.equal(await readFile(options.child, "utf8"), "unknown external write\n");
});

test("unfinished transaction blocks a different attempt and recovery of the wrong attempt", async () => {
	const options = await interruptedFixture();
	await assert.rejects(createRepairSnapshot({ ...options, attemptId: "attempt-2" }), /unfinished/);
	await assert.rejects(recoverRepair({ ...options, attemptId: "attempt-2" }), /unfinished/);
	assert.equal((await recoverRepair(options)).status, "restored");
});

test("directory membership changes refuse rollback before any destination is restored", async () => {
	const options = await interruptedFixture();
	await writeFile(join(options.participantDirectory, "unexpected.jsonl"), "new participant");
	await assert.rejects(recoverRepair(options), /directory changed/);
	assert.equal(await readFile(options.ownerPath, "utf8"), "repaired\n");
});

test("late candidate or report edits during durable preparation invalidate application", async () => {
	for (const target of ["candidate", "report"]) {
		const options = await fixture();
		let mutatePath = "";
		const snapshot = await createRepairSnapshot({ ...options, io: { rename, sync: async (path) => {
			await sync(path);
			if (path.endsWith("intent.json")) {
				const { chmod } = await import("node:fs/promises");
				await chmod(mutatePath, 0o600);
				await writeFile(mutatePath, "late tamper");
			}
		} } });
		const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
		mutatePath = target === "candidate" ? snapshot.candidatePath("file-0")
			: join(options.root, options.attemptId, "seals", seal.id, "report.txt");
		await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), /changed|stale/);
		assert.equal(await readFile(options.ownerPath, "utf8"), "owner before\n");
		await snapshot.release();
	}
});

test("interrupted rollback can retry after some preimages were already restored", async () => {
	const options = await interruptedFixture();
	let replacements = 0;
	await assert.rejects(recoverRepair({ ...options, io: { sync, rename: async (from, to) => {
		if (++replacements === 2) throw new Error("rollback interrupted");
		await rename(from, to);
	} } }), /rollback interrupted/);
	assert.equal(await readFile(options.ownerPath, "utf8"), "owner before\n");
	assert.equal((await recoverRepair(options)).status, "restored");
	assert.equal(await readFile(options.ownerPath, "utf8"), "owner before\n");
	assert.equal(await readFile(options.child, "utf8"), "invalid before\n");
	assert.deepEqual(await readdir(options.participantDirectory), ["invalid.jsonl"]);
});

test("uncertain commit fsync never returns launch permission; recovery durably decides commit without rollback", async () => {
	const options = await fixture();
	const snapshot = await createRepairSnapshot({ ...options, io: { rename, sync: async (path) => {
		if (path.endsWith("committed.json")) throw new Error("uncertain commit fsync");
		await sync(path);
	} } });
	await writeFile(snapshot.candidatePath("file-0"), "repaired\n");
	const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
	await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), /uncertain commit/);
	await snapshot.release();
	assert.equal((await recoverRepair(options)).status, "committed");
	assert.equal(await readFile(options.ownerPath, "utf8"), "repaired\n");
});

test("failure after all destination renames but before the commit marker restores every preimage", async () => {
	const options = await fixture();
	let replacements = 0;
	const snapshot = await createRepairSnapshot({ ...options, io: {
		rename: async (from, to) => { await rename(from, to); replacements++; },
		sync: async (path) => {
			if (replacements === 2 && path === options.participantDirectory) throw new Error("directory fsync failed");
			await sync(path);
		},
	} });
	for (const file of snapshot.manifest.files) await writeFile(snapshot.candidatePath(file.id), "repaired\n");
	const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
	await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), /directory fsync/);
	await snapshot.release();
	assert.equal((await recoverRepair(options)).status, "restored");
	assert.equal(await readFile(options.ownerPath, "utf8"), "owner before\n");
	assert.equal(await readFile(options.child, "utf8"), "invalid before\n");
});

test("unreadable, symlinked and hardlinked directory candidates are inventoried and block validation", async () => {
	for (const kind of ["directory", "symlink", "hardlink"]) {
		const options = await fixture();
		const path = join(options.participantDirectory, "quarantined.jsonl");
		if (kind === "directory") await mkdir(path);
		if (kind === "symlink") await symlink(options.child, path);
		if (kind === "hardlink") await link(options.child, path);
		const snapshot = await createRepairSnapshot(options);
		assert.equal(snapshot.manifest.files.length, 3);
		assert.ok(snapshot.manifest.files.find((file) => file.path === path)?.unreadable);
		await assert.rejects(snapshot.seal(async () => ({ valid: true, report: "must not validate" })), /unreadable/);
		await snapshot.release();
	}
});

test("duplicate attempts, missing authorization, failed validation and cancellation cannot change originals", async () => {
	const options = await fixture();
	const snapshot = await createRepairSnapshot(options);
	await assert.rejects(createRepairSnapshot({ ...options, attemptId: "attempt-2" }), /EEXIST/);
	await assert.rejects(recoverRepair(options), /EEXIST/);
	await writeFile(snapshot.candidatePath("file-0"), "repaired\n");
	await assert.rejects(snapshot.seal(async () => ({ valid: false, report: "invalid protocol effects" })), /validation failed/);
	const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
	await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: "different-attempt" }), /not authorized/);
	await snapshot.release();
	await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), /released/);
	assert.equal((await recoverRepair(options)).status, "unchanged");
	assert.equal(await readFile(options.ownerPath, "utf8"), "owner before\n");
});

test("abandoned helper lease requires positive external retirement before explicit removal", async () => {
	const options = await fixture();
	await mkdir(options.root);
	await mkdir(join(options.root, "lease"));
	await assert.rejects(recoverRepair(options), /EEXIST/);
	await assert.rejects(clearAbandonedRepairLease({ root: options.root,
		helperRetirement: { verified: true, evidence: "" } }), /retirement missing/);
	await clearAbandonedRepairLease({ root: options.root,
		helperRetirement: { verified: true, evidence: "operator joined stopped helper" } });
	assert.equal((await recoverRepair(options)).status, "unchanged");
});

test("backup or intent durability failure changes no destination", async () => {
	for (const failure of ["backup", "intent"]) {
		const options = await fixture();
		const snapshot = await createRepairSnapshot({ ...options, io: { rename, sync: async (path) => {
			if ((failure === "backup" && path.endsWith("backup/file-1"))
				|| (failure === "intent" && path.endsWith("intent.json"))) throw new Error("durability unavailable");
			await sync(path);
		} } });
		for (const file of snapshot.manifest.files) await writeFile(snapshot.candidatePath(file.id), "repaired\n");
		const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
		await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), /durability unavailable/);
		assert.equal(await readFile(options.ownerPath, "utf8"), "owner before\n");
		assert.equal(await readFile(options.child, "utf8"), "invalid before\n");
		await snapshot.release();
		assert.equal((await recoverRepair(options)).status, failure === "backup" ? "unchanged" : "restored");
	}
});

test("every backup and the intent have been synced before the first replacement", async () => {
	const options = await fixture();
	const synced = new Set<string>();
	const dir = join(options.root, options.attemptId);
	const snapshot = await createRepairSnapshot({ ...options, io: {
		sync: async (path) => { await sync(path); synced.add(path); },
		rename: async (from, to) => {
			for (const path of [join(dir, "backup", "file-0"), join(dir, "backup", "file-1"),
				join(dir, "backup"), join(dir, "intent.json"), dir]) assert.ok(synced.has(path), path);
			assert.equal(await readFile(join(dir, "backup", "file-0"), "utf8"), "owner before\n");
			assert.equal(await readFile(join(dir, "backup", "file-1"), "utf8"), "invalid before\n");
			await rename(from, to);
		},
	} });
	const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
	await snapshot.apply(seal, { authorizedAttemptId: options.attemptId });
	await snapshot.release();
});

test("modified journal versions and destination bindings refuse recovery before writes", async () => {
	for (const target of ["version", "manifest", "destination", "scope"]) {
		const options = await interruptedFixture();
		const dir = join(options.root, options.attemptId);
		const { chmod } = await import("node:fs/promises");
		if (target === "scope") {
			await assert.rejects(recoverRepair({ ...options, ownerPath: options.child }), /binding invalid/);
		} else {
			const path = join(dir, "intent.json");
			const intent = JSON.parse(await readFile(path, "utf8"));
			if (target === "version") intent.version = 42;
			if (target === "manifest") intent.manifestHash = "0".repeat(64);
			if (target === "destination") {
				const manifestPath = join(dir, "manifest.json");
				const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
				manifest.files[0].path = "/tmp/unrelated-transcript.jsonl";
				const bytes = JSON.stringify(manifest);
				await chmod(manifestPath, 0o600);
				await writeFile(manifestPath, bytes);
				const { createHash } = await import("node:crypto");
				intent.manifestHash = createHash("sha256").update(bytes).digest("hex");
			}
			await chmod(path, 0o600);
			await writeFile(path, JSON.stringify(intent));
			await assert.rejects(recoverRepair(options), /intent|manifest|destination/);
		}
		assert.equal(await readFile(options.ownerPath, "utf8"), "repaired\n");
		assert.equal(await readFile(options.child, "utf8"), "invalid before\n");
	}
});

test("failed lease release closes the old snapshot and cannot remove a new helper's lease", async () => {
	const options = await fixture();
	let releasing = false;
	const snapshot = await createRepairSnapshot({ ...options, io: { rename, sync: async (path) => {
		if (releasing && path === options.root) throw new Error("release fsync failed");
		await sync(path);
	} } });
	const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
	releasing = true;
	await assert.rejects(snapshot.release(), /release fsync failed/);
	const next = await createRepairSnapshot({ ...options, attemptId: "attempt-2" });
	await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), /released/);
	await snapshot.release();
	await assert.rejects(createRepairSnapshot({ ...options, attemptId: "attempt-3" }), /EEXIST/);
	await next.release();
});

test("starting release immediately revokes the snapshot while directory fsync is still pending", async () => {
	const options = await fixture();
	let releasing = false;
	let resume!: () => void;
	let reached!: () => void;
	const waiting = new Promise<void>((resolve) => { reached = resolve; });
	const paused = new Promise<void>((resolve) => { resume = resolve; });
	const snapshot = await createRepairSnapshot({ ...options, io: { rename, sync: async (path) => {
		if (releasing && path === options.root) { reached(); await paused; }
		await sync(path);
	} } });
	const seal = await snapshot.seal(async () => ({ valid: true, report: "valid" }));
	releasing = true;
	const release = snapshot.release();
	await waiting;
	try {
		await assert.rejects(snapshot.apply(seal, { authorizedAttemptId: options.attemptId }), /released/);
	} finally { resume(); await release; }
});
