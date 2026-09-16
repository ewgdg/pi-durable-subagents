/** Offline, cooperative-writer repair storage. No lock here retires a Pi writer. */
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface RepairScope {
	root: string;
	attemptId: string;
	ownerPath: string;
	participantDirectory: string;
}

/** These seams permit real rename/fsync failures to be exercised without a crash-only API. */
export interface RepairIO {
	rename(from: string, to: string): Promise<void>;
	sync(path: string): Promise<void>;
}

export interface RepairSnapshotOptions extends RepairScope {
	retirement: { verified: true; evidence: string };
	io?: RepairIO;
}

interface Identity {
	dev: number;
	ino: number;
	mode: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

export interface RepairFile {
	id: string;
	path: string;
	identity?: Identity;
	hash?: string;
	unreadable?: string;
}

export interface RepairManifest {
	version: 1;
	attemptId: string;
	ownerPath: string;
	participantDirectory: string;
	retirementEvidence: string;
	directory: { dev: number; ino: number; entries: string[] };
	files: RepairFile[];
}

export type RepairValidator = (input: {
	before: readonly Readonly<{ path: string; contents: string }>[];
	after: readonly Readonly<{ path: string; contents: string }>[];
}) => Promise<{ valid: boolean; report: string }>;

export interface RepairSeal { id: string; hash: string }
interface SealRecord {
	version: 1;
	attemptId: string;
	manifestHash: string;
	valid: boolean;
	reportHash: string;
	files: { id: string; hash: string; identity: Identity }[];
}
interface Intent {
	version: 1;
	attemptId: string;
	manifestHash: string;
	seal: RepairSeal;
}

export type RepairRecovery = { status: "committed" | "restored" | "unchanged"; safeToReopen: true };

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => JSON.stringify(value);
const same = (a: unknown, b: unknown) => encode(a) === encode(b);
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
function requireCondition(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Repair refused: ${message}`);
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

const defaultIO: RepairIO = {
	rename: fs.rename,
	async sync(path) {
		const file = await fs.open(path, "r");
		try { await file.sync(); } finally { await file.close(); }
	},
};

async function canonical(path: string): Promise<string> {
	requireCondition(isAbsolute(path) && resolve(path) === path, "paths must be absolute and normalized");
	requireCondition(await fs.realpath(path) === path, `symlink path: ${path}`);
	return path;
}

async function identify(path: string): Promise<Identity> {
	await canonical(path);
	const stat = await fs.lstat(path);
	requireCondition(stat.isFile() && stat.nlink === 1, `not a unique regular file: ${path}`);
	return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, size: stat.size,
		mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

async function readStable(path: string): Promise<{ bytes: Buffer; identity: Identity; hash: string }> {
	const identity = await identify(path);
	const bytes = await fs.readFile(path);
	requireCondition(same(identity, await identify(path)), `file changed while reading: ${path}`);
	return { bytes, identity, hash: digest(bytes) };
}

async function membership(path: string): Promise<RepairManifest["directory"]> {
	await canonical(path);
	const stat = await fs.stat(path);
	requireCondition(stat.isDirectory(), "participant path is not a directory");
	return { dev: stat.dev, ino: stat.ino, entries: (await fs.readdir(path)).sort() };
}

async function durableWrite(path: string, bytes: string | Buffer, mode: number, io: RepairIO): Promise<void> {
	const file = await fs.open(path, "wx", mode);
	try {
		await file.writeFile(bytes);
		// chmod is deliberate: creation umask must not change transcript permissions.
		await file.chmod(mode);
	} finally { await file.close(); }
	await io.sync(path);
	await io.sync(dirname(path));
}

async function makeDirectory(path: string, io: RepairIO): Promise<void> {
	await fs.mkdir(path, { mode: 0o700 });
	await io.sync(path);
	await io.sync(dirname(path));
}

async function optionalRead(path: string): Promise<Buffer | undefined> {
	try { return (await readStable(path)).bytes; } catch (error) { if (missing(error)) return undefined; throw error; }
}

async function takeLease(scope: RepairScope, io: RepairIO): Promise<() => Promise<void>> {
	requireCondition(process.platform !== "win32", "durable directory fsync is not supported on Windows");
	requireCondition(identifier.test(scope.attemptId), "invalid attempt ID");
	await canonical(dirname(scope.root));
	try { await makeDirectory(scope.root, io); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await canonical(scope.root);
	const path = join(scope.root, "lease");
	await makeDirectory(path, io);
	// A crash leaves this directory behind. Only explicit verified helper retirement
	// may clear it; elapsed time/PID guesses must not steal a live helper's lease.
	let released = false;
	return async () => {
		if (released) return;
		// Once removal starts this handle must never delete the lease again: a new
		// helper may acquire it even if our subsequent directory fsync fails.
		released = true;
		await fs.rmdir(path);
		await io.sync(scope.root);
	};
}

/** Caller must positively establish that the former repair helper is stopped. */
export async function clearAbandonedRepairLease(options: {
	root: string; helperRetirement: { verified: true; evidence: string };
}): Promise<void> {
	requireCondition(options.helperRetirement.verified && options.helperRetirement.evidence.trim(), "helper retirement missing");
	await canonical(options.root);
	await canonical(join(options.root, "lease"));
	await fs.rmdir(join(options.root, "lease"));
	await defaultIO.sync(options.root);
}

function attemptPath(scope: RepairScope): string { return join(scope.root, scope.attemptId); }
function snapshotPath(scope: RepairScope, id: string): string { return join(attemptPath(scope), "snapshot", id); }
function candidatePath(scope: RepairScope, id: string): string { return join(attemptPath(scope), "candidate", id); }
function stagePath(scope: RepairScope, file: RepairFile, phase: "apply" | "restore"): string {
	return join(dirname(file.path), `.pi-repair-${scope.attemptId}-${phase}-${file.id}`);
}
function sealPath(scope: RepairScope, id: string): string {
	requireCondition(identifier.test(id), "invalid seal ID");
	return join(attemptPath(scope), "seals", id);
}

function validateManifest(value: unknown, scope: RepairScope): asserts value is RepairManifest {
	const m = value as RepairManifest;
	requireCondition(m && m.version === 1 && m.attemptId === scope.attemptId
		&& m.ownerPath === scope.ownerPath && m.participantDirectory === scope.participantDirectory
		&& typeof m.retirementEvidence === "string" && m.retirementEvidence.length > 0, "manifest binding invalid");
	requireCondition(m.directory && Number.isSafeInteger(m.directory.dev) && Number.isSafeInteger(m.directory.ino)
		&& Array.isArray(m.directory.entries) && m.directory.entries.every((entry) => typeof entry === "string"
			&& entry !== "." && entry !== ".." && basename(entry) === entry)
		&& same([...new Set(m.directory.entries)].sort(), m.directory.entries), "directory manifest invalid");
	const paths = [scope.ownerPath, ...m.directory.entries.filter((entry) => entry.endsWith(".jsonl"))
		.map((entry) => join(scope.participantDirectory, entry))];
	requireCondition(new Set(paths).size === paths.length && Array.isArray(m.files) && m.files.length === paths.length,
		"manifest write set invalid");
	m.files.forEach((file, index) => {
		requireCondition(file.id === `file-${index}` && file.path === paths[index], "unknown manifest destination");
		requireCondition(typeof file.unreadable === "string" || (validIdentity(file.identity)
			&& typeof file.hash === "string" && /^[a-f0-9]{64}$/.test(file.hash)), "file manifest invalid");
	});
}

function validIdentity(value: unknown): value is Identity {
	const i = value as Identity;
	return !!i && [i.dev, i.ino, i.mode, i.size].every(Number.isSafeInteger)
		&& i.mode >= 0 && i.mode <= 0o7777 && i.size >= 0 && Number.isFinite(i.mtimeMs) && Number.isFinite(i.ctimeMs);
}

async function requireNoOtherUnfinishedAttempt(scope: RepairScope, io: RepairIO): Promise<void> {
	for (const name of await fs.readdir(scope.root)) {
		if (name === "lease" || name === scope.attemptId) continue;
		requireCondition(identifier.test(name), "unknown repair root entry");
		const dir = join(scope.root, name);
		await canonical(dir);
		const intent = await optionalRead(join(dir, "intent.json"));
		if (!intent) continue;
		let finished = false;
		for (const marker of ["committed.json", "restored.json"]) {
			const bytes = await optionalRead(join(dir, marker));
			if (!bytes) continue;
			const value = JSON.parse(bytes.toString("utf8"));
			requireCondition(value.version === 1 && value.intentHash === digest(intent), "invalid prior attempt marker");
			await io.sync(join(dir, marker));
			await io.sync(dir);
			finished = true;
		}
		requireCondition(finished, `unfinished attempt ${name}; recover it first`);
	}
}

async function loadManifest(scope: RepairScope, expectedHash?: string): Promise<{ manifest: RepairManifest; hash: string }> {
	const { bytes, hash } = await readStable(join(attemptPath(scope), "manifest.json"));
	requireCondition(!expectedHash || hash === expectedHash, "manifest changed");
	const manifest: unknown = JSON.parse(bytes.toString("utf8"));
	validateManifest(manifest, scope);
	return { manifest, hash };
}

async function snapshotBytes(scope: RepairScope, manifest: RepairManifest): Promise<Buffer[]> {
	return Promise.all(manifest.files.map(async (file) => {
		requireCondition(!file.unreadable && file.hash && file.identity, `unreadable candidate: ${file.path}`);
		const value = await readStable(snapshotPath(scope, file.id));
		requireCondition(value.hash === file.hash, "snapshot changed");
		return value.bytes;
	}));
}

async function checkFresh(scope: RepairScope, manifest: RepairManifest): Promise<void> {
	requireCondition(same(await membership(scope.participantDirectory), manifest.directory), "participant directory changed");
	for (const file of manifest.files) {
		const current = await readStable(file.path);
		requireCondition(same(current.identity, file.identity) && current.hash === file.hash, `source changed: ${file.path}`);
	}
}

async function checkCandidateSet(scope: RepairScope, manifest: RepairManifest): Promise<void> {
	requireCondition(same((await fs.readdir(join(attemptPath(scope), "candidate"))).sort(),
		manifest.files.map((file) => file.id).sort()), "candidate membership changed");
}

async function checkCandidateGeneration(scope: RepairScope, manifest: RepairManifest, record: SealRecord): Promise<void> {
	await checkCandidateSet(scope, manifest);
	for (const file of record.files) {
		const current = await readStable(candidatePath(scope, file.id));
		requireCondition(current.hash === file.hash && same(current.identity, file.identity), "candidate seal stale");
	}
}

async function loadSeal(scope: RepairScope, manifest: RepairManifest, manifestHash: string, seal: RepairSeal): Promise<SealRecord> {
	const dir = sealPath(scope, seal.id);
	const raw = await readStable(join(dir, "seal.json"));
	requireCondition(raw.hash === seal.hash, "seal changed");
	const record = JSON.parse(raw.bytes.toString("utf8")) as SealRecord;
	requireCondition(record.version === 1 && record.attemptId === scope.attemptId && record.manifestHash === manifestHash
		&& record.valid === true && Array.isArray(record.files) && record.files.length === manifest.files.length, "seal binding invalid");
	for (const [index, file] of record.files.entries()) {
		requireCondition(file.id === manifest.files[index].id && validIdentity(file.identity), "seal write set invalid");
		requireCondition((await readStable(join(dir, file.id))).hash === file.hash, "sealed candidate changed");
	}
	requireCondition((await readStable(join(dir, "report.txt"))).hash === record.reportHash, "validation report changed");
	return record;
}

export interface RepairSnapshot {
	readonly manifest: RepairManifest;
	readSnapshot(id: string): Promise<string>;
	candidatePath(id: string): string;
	seal(validator: RepairValidator): Promise<RepairSeal>;
	apply(seal: RepairSeal, authorization: { authorizedAttemptId: string }): Promise<RepairRecovery>;
	release(): Promise<void>;
}

export async function createRepairSnapshot(options: RepairSnapshotOptions): Promise<RepairSnapshot> {
	requireCondition(options.retirement.verified === true && options.retirement.evidence.trim(), "writer retirement missing");
	const scope: RepairScope = { root: options.root, attemptId: options.attemptId,
		ownerPath: options.ownerPath, participantDirectory: options.participantDirectory };
	const io = options.io ?? defaultIO;
	const releaseLease = await takeLease(scope, io);
	let active = true;
	const release = async () => {
		if (!active) return;
		active = false;
		await releaseLease();
	};
	try {
		await requireNoOtherUnfinishedAttempt(scope, io);
		await canonical(scope.ownerPath);
		const directory = await membership(scope.participantDirectory);
		requireCondition(scope.root !== scope.participantDirectory && dirname(scope.root) !== scope.participantDirectory,
			"repair state must be outside participant directory");
		const dir = attemptPath(scope);
		await makeDirectory(dir, io);
		for (const child of ["snapshot", "candidate", "seals", "backup"]) await makeDirectory(join(dir, child), io);
		const paths = [scope.ownerPath, ...directory.entries.filter((entry) => entry.endsWith(".jsonl"))
			.map((entry) => join(scope.participantDirectory, entry))];
		const manifest: RepairManifest = { version: 1, attemptId: scope.attemptId, ownerPath: scope.ownerPath,
			participantDirectory: scope.participantDirectory, retirementEvidence: options.retirement.evidence, directory, files: [] };
		for (const [index, path] of paths.entries()) {
			const id = `file-${index}`;
			let value: Awaited<ReturnType<typeof readStable>>;
			try { value = await readStable(path); } catch (error) {
				manifest.files.push({ id, path, unreadable: String(error) });
				continue;
			}
			manifest.files.push({ id, path, identity: value.identity, hash: value.hash });
			await durableWrite(snapshotPath(scope, id), value.bytes, 0o400, io);
			await durableWrite(candidatePath(scope, id), value.bytes, 0o600, io);
		}
		validateManifest(manifest, scope);
		requireCondition(same(directory, await membership(scope.participantDirectory)), "membership changed during snapshot");
		const manifestText = encode(manifest);
		const manifestHash = digest(manifestText);
		await durableWrite(join(dir, "manifest.json"), manifestText, 0o400, io);
		const ensureActive = () => requireCondition(active, "snapshot lease released");
		let busy = false;
		async function exclusive<T>(work: () => Promise<T>): Promise<T> {
			ensureActive();
			requireCondition(!busy, "snapshot operation already running");
			busy = true;
			try { return await work(); } finally { busy = false; }
		}
		return {
			// A caller may inspect this copy, but cannot mutate the authority held here.
			manifest: structuredClone(manifest),
			async readSnapshot(id) {
				ensureActive();
				const file = manifest.files.find((file) => file.id === id);
				requireCondition(file, "unknown snapshot ID");
				requireCondition(!file.unreadable && file.hash, `unreadable candidate: ${file.path}`);
				const value = await readStable(snapshotPath(scope, id));
				requireCondition(value.hash === file.hash, "snapshot changed");
				const contents = value.bytes.toString("utf8");
				requireCondition(Buffer.from(contents).equals(value.bytes), "non-UTF8 transcript cannot be validated");
				return contents;
			},
			candidatePath(id) {
				ensureActive();
				requireCondition(manifest.files.some((file) => file.id === id), "unknown candidate ID");
				return candidatePath(scope, id);
			},
			seal: (validator) => exclusive(async () => {
				await loadManifest(scope, manifestHash);
				const beforeBytes = await snapshotBytes(scope, manifest);
				await checkCandidateSet(scope, manifest);
				const after = await Promise.all(manifest.files.map((file) => readStable(candidatePath(scope, file.id))));
				const entries = (bytes: Buffer[]) => Object.freeze(manifest.files.map((file, index) => {
					const contents = bytes[index].toString("utf8");
					requireCondition(Buffer.from(contents).equals(bytes[index]), "non-UTF8 transcript cannot be validated");
					return Object.freeze({ path: file.path, contents });
				}));
				const result = await validator({ before: entries(beforeBytes), after: entries(after.map((file) => file.bytes)) });
				requireCondition(typeof result.report === "string" && typeof result.valid === "boolean", "invalid validator result");
				const id = randomUUID();
				const directory = sealPath(scope, id);
				await makeDirectory(directory, io);
				for (const [index, file] of manifest.files.entries()) {
					const current = await readStable(candidatePath(scope, file.id));
					requireCondition(same(current.identity, after[index].identity) && current.hash === after[index].hash,
						"candidate changed during validation");
					await durableWrite(join(directory, file.id), after[index].bytes, 0o400, io);
				}
				await durableWrite(join(directory, "report.txt"), result.report, 0o400, io);
				const record: SealRecord = { version: 1, attemptId: scope.attemptId, manifestHash,
					valid: result.valid, reportHash: digest(result.report), files: manifest.files.map((file, index) => ({
						id: file.id, hash: after[index].hash, identity: after[index].identity,
					})) };
				const text = encode(record);
				await durableWrite(join(directory, "seal.json"), text, 0o400, io);
				requireCondition(result.valid, "workflow validation failed; report retained");
				return { id, hash: digest(text) };
			}),
			apply: (requestedSeal, authorization) => exclusive(async () => {
				const seal = { ...requestedSeal };
				requireCondition(authorization.authorizedAttemptId === scope.attemptId, "attempt not authorized");
				requireCondition(!await optionalRead(join(dir, "intent.json")), "attempt already applied; use recovery");
				await loadManifest(scope, manifestHash);
				const before = await snapshotBytes(scope, manifest);
				const record = await loadSeal(scope, manifest, manifestHash, seal);
				await checkCandidateGeneration(scope, manifest, record);
				await checkFresh(scope, manifest);
				const staged: string[] = [];
				for (const [index, file] of manifest.files.entries()) {
					await durableWrite(join(dir, "backup", file.id), before[index], 0o400, io);
					const stage = stagePath(scope, file, "apply");
					await durableWrite(stage, (await readStable(join(sealPath(scope, seal.id), file.id))).bytes, file.identity!.mode, io);
					staged.push(stage);
				}
				const intent: Intent = { version: 1, attemptId: scope.attemptId, manifestHash, seal };
				const intentText = encode(intent);
				await durableWrite(join(dir, "intent.json"), intentText, 0o400, io);
				await loadManifest(scope, manifestHash);
				await snapshotBytes(scope, manifest);
				await loadSeal(scope, manifest, manifestHash, seal);
				await checkCandidateGeneration(scope, manifest, record);
				for (const [index, file] of manifest.files.entries()) {
					const stage = await readStable(staged[index]);
					requireCondition(stage.hash === record.files[index].hash && stage.identity.mode === file.identity!.mode,
						"staged candidate changed");
					requireCondition((await readStable(join(dir, "backup", file.id))).hash === file.hash, "preimage backup changed");
				}
				// Staging inside the participant directory is excluded from membership by
				// checking the exact original set plus these known, helper-owned stages.
				const stagedNames = staged.filter((path) => dirname(path) === scope.participantDirectory).map((path) => basename(path));
				const currentDirectory = await membership(scope.participantDirectory);
				currentDirectory.entries = currentDirectory.entries.filter((name) => !stagedNames.includes(name));
				requireCondition(same(currentDirectory, manifest.directory), "participant directory changed before apply");
				for (const file of manifest.files) {
					const current = await readStable(file.path);
					requireCondition(current.hash === file.hash && same(current.identity, file.identity), "source changed before apply");
				}
				for (const [index, file] of manifest.files.entries()) {
					await io.rename(staged[index], file.path);
					await io.sync(dirname(file.path));
				}
				await durableWrite(join(dir, "committed.json"), encode({ version: 1, intentHash: digest(intentText) }), 0o400, io);
				return { status: "committed", safeToReopen: true };
			}),
			release: async () => { requireCondition(!busy, "snapshot operation already running"); await release(); },
		};
	} catch (error) { await release(); throw error; }
}

/** Explicit operator/helper recovery, never an interceptor for arbitrary Pi launches. */
export async function recoverRepair(options: RepairScope & { io?: RepairIO }): Promise<RepairRecovery> {
	const io = options.io ?? defaultIO;
	const release = await takeLease(options, io);
	try {
		await requireNoOtherUnfinishedAttempt(options, io);
		const dir = attemptPath(options);
		const intentBytes = await optionalRead(join(dir, "intent.json"));
		if (!intentBytes) return { status: "unchanged", safeToReopen: true };
		const intent = JSON.parse(intentBytes.toString("utf8")) as Intent;
		requireCondition(intent.version === 1 && intent.attemptId === options.attemptId
			&& typeof intent.manifestHash === "string" && intent.seal && typeof intent.seal.hash === "string", "invalid transaction intent");
		const { manifest, hash } = await loadManifest(options, intent.manifestHash);
		const seal = await loadSeal(options, manifest, hash, intent.seal);
		const commitBytes = await optionalRead(join(dir, "committed.json"));
		if (commitBytes) {
			const commit = JSON.parse(commitBytes.toString("utf8"));
			requireCondition(commit.version === 1 && commit.intentHash === digest(intentBytes), "invalid commit marker");
			// Re-establish durability after an uncertain fsync; never inspect/overwrite
			// destinations, which may already contain fresh native startup appends.
			await io.sync(join(dir, "committed.json"));
			await io.sync(dir);
			return { status: "committed", safeToReopen: true };
		}
		const restoredBytes = await optionalRead(join(dir, "restored.json"));
		if (restoredBytes) {
			const restored = JSON.parse(restoredBytes.toString("utf8"));
			requireCondition(restored.version === 1 && restored.intentHash === digest(intentBytes), "invalid restored marker");
			await io.sync(join(dir, "restored.json"));
			await io.sync(dir);
			return { status: "restored", safeToReopen: true };
		}
		const allowedStages = manifest.files.flatMap((file) => [stagePath(options, file, "apply"), stagePath(options, file, "restore")]);
		const currentDirectory = await membership(options.participantDirectory);
		currentDirectory.entries = currentDirectory.entries.filter((name) => !allowedStages.includes(join(options.participantDirectory, name)));
		requireCondition(same(currentDirectory, manifest.directory), "participant directory changed before recovery");
		const backups: Buffer[] = [];
		for (const [index, file] of manifest.files.entries()) {
			const backup = await readStable(join(dir, "backup", file.id));
			requireCondition(backup.hash === file.hash && file.identity, "preimage backup changed");
			const current = await readStable(file.path);
			requireCondition(current.identity.mode === file.identity.mode
				&& (current.hash === file.hash || current.hash === seal.files[index].hash), `unknown destination: ${file.path}`);
			for (const phase of ["apply", "restore"] as const) {
				const staged = await optionalRead(stagePath(options, file, phase));
				requireCondition(!staged || digest(staged) === (phase === "apply" ? seal.files[index].hash : file.hash), "unknown staged bytes");
			}
			backups.push(backup.bytes);
		}
		// Entire destination set and all backups are checked before the first write.
		// No progress counter: repeating an interrupted rollback restores the whole set.
		for (const [index, file] of manifest.files.entries()) {
			const stage = stagePath(options, file, "restore");
			if (!await optionalRead(stage)) await durableWrite(stage, backups[index], file.identity!.mode, io);
			else {
				await fs.chmod(stage, file.identity!.mode);
				await io.sync(stage);
			}
			await io.rename(stage, file.path);
			await io.sync(dirname(file.path));
		}
		for (const file of manifest.files) {
			const stage = stagePath(options, file, "apply");
			if (await optionalRead(stage)) { await fs.unlink(stage); await io.sync(dirname(stage)); }
		}
		await durableWrite(join(dir, "restored.json"), encode({ version: 1, intentHash: digest(intentBytes) }), 0o400, io);
		return { status: "restored", safeToReopen: true };
	} finally { await release(); }
}
