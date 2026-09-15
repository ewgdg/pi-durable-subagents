import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureOwnerForkProvenance, inspectOwnerForkProvenance, OWNER_FORK_PROVENANCE_CUSTOM_TYPE } from "../src/protocol/fork-provenance.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";

function identity(manager: SessionManager) {
	return manager.appendCustomEntry("agent-coordination.identity", {
		agentId: manager.getSessionId(), workflowId: manager.getSessionId(), directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" },
	});
}
function copied(source: SessionManager, parentSession: string) {
	const fresh = SessionManager.inMemory();
	return SessionManager.inMemory(undefined, undefined, [
		{ ...fresh.getHeader()!, parentSession }, ...source.getBranch(),
	]);
}
async function save(manager: SessionManager, path: string) {
	await writeFile(path, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
}
const inspect = (manager: SessionManager) => transcriptFromSessionManager(manager, { fresh: true }).inspect();

test("re-fork records physical source ownership despite omitted intermediate Identity; reload needs no source", { timeout: 5_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-provenance-"));
	const a = SessionManager.inMemory();
	identity(a);
	const aCall = a.appendMessage(fauxAssistantMessage("A work"));
	const aPath = join(dir, "a.jsonl");
	await save(a, aPath);
	const b = copied(a, aPath);
	identity(b);
	await captureOwnerForkProvenance(b);
	b.branch(aCall);
	const bCall = b.appendMessage(fauxAssistantMessage("B work below A branch"));
	const bPath = join(dir, "b.jsonl");
	await save(b, bPath);
	const c = copied(b, bPath);
	identity(c);
	const beforePrefix = JSON.stringify(c.getEntries());
	const beforeSource = await readFile(bPath, "utf8");
	await captureOwnerForkProvenance(c);
	const provenance = inspectOwnerForkProvenance(inspect(c));
	assert.equal(provenance?.get(aCall), a.getSessionId());
	assert.equal(provenance?.get(bCall), b.getSessionId());
	assert.equal(JSON.stringify(c.getEntries().slice(0, -1)), beforePrefix);
	assert.equal(await readFile(bPath, "utf8"), beforeSource);
	await rename(bPath, bPath + ".unavailable");
	const reloaded = SessionManager.inMemory(undefined, undefined, [c.getHeader()!, ...c.getEntries()]);
	await captureOwnerForkProvenance(reloaded);
	assert.deepEqual(inspectOwnerForkProvenance(inspect(reloaded)), provenance);
	assert.equal(reloaded.getEntries().filter(entry => entry.type === "custom" && entry.customType === OWNER_FORK_PROVENANCE_CUSTOM_TYPE).length, 1);
});

test("missing and malformed sources record unknown instead of copied Identity guesses", { timeout: 5_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-provenance-"));
	const source = SessionManager.inMemory();
	identity(source);
	const call = source.appendMessage(fauxAssistantMessage("Unverifiable source"));
	for (const body of [undefined, "{broken}\n"]) {
		const path = join(dir, body === undefined ? "missing.jsonl" : "malformed.jsonl");
		if (body !== undefined) await writeFile(path, body);
		const child = copied(source, path);
		identity(child);
		await captureOwnerForkProvenance(child);
		assert.equal(inspectOwnerForkProvenance(inspect(child))?.get(call), null);
	}
});

test("older missing captures are resolved read-only and ordinary Owners need no record", { timeout: 5_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-provenance-"));
	const a = SessionManager.inMemory();
	identity(a);
	const aCall = a.appendMessage(fauxAssistantMessage("A"));
	await captureOwnerForkProvenance(a);
	assert.equal(inspectOwnerForkProvenance(inspect(a)), undefined);
	const aPath = join(dir, "a.jsonl");
	await save(a, aPath);
	const b = copied(a, aPath);
	identity(b);
	const bPath = join(dir, "b.jsonl");
	await save(b, bPath);
	const before = await readFile(bPath, "utf8");
	const c = copied(b, bPath);
	identity(c);
	await captureOwnerForkProvenance(c);
	assert.equal(inspectOwnerForkProvenance(inspect(c))?.get(aCall), a.getSessionId());
	assert.equal(await readFile(bPath, "utf8"), before);
});

test("cyclic and contradictory source evidence stays unknown", { timeout: 5_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-provenance-"));
	const source = SessionManager.inMemory();
	const call = source.appendMessage(fauxAssistantMessage("Before Identity"));
	const path = join(dir, "cyclic.jsonl");
	const cyclic = SessionManager.inMemory(undefined, undefined, [
		{ ...source.getHeader()!, parentSession: path }, ...source.getEntries(),
	]);
	identity(cyclic);
	await save(cyclic, path);
	const child = copied(cyclic, path);
	identity(child);
	await captureOwnerForkProvenance(child);
	assert.equal(inspectOwnerForkProvenance(inspect(child))?.get(call), null);

	const changed = copied(cyclic, path);
	identity(changed);
	const records = [cyclic.getHeader(), ...cyclic.getEntries()];
	await writeFile(path, records.map(entry => JSON.stringify(entry)).join("\n").replace("Before Identity", "Changed source") + "\n");
	await captureOwnerForkProvenance(changed);
	assert.equal(inspectOwnerForkProvenance(inspect(changed))?.get(call), null);
});

test("malformed persisted capture cannot trigger source-dependent recapture or guessed attribution", { timeout: 5_000 }, async () => {
	const source = SessionManager.inMemory();
	identity(source);
	const call = source.appendMessage(fauxAssistantMessage("Source work"));
	const child = copied(source, "/unavailable/source.jsonl");
	const identityEntryId = identity(child);
	child.appendCustomEntry(OWNER_FORK_PROVENANCE_CUSTOM_TYPE, {
		version: 1, agentId: child.getSessionId(), identityEntryId,
		origins: [{ entryId: "not-a-copied-entry", agentId: "guessed-owner" }],
	});
	const before = JSON.stringify(child.getEntries());
	await captureOwnerForkProvenance(child);
	assert.equal(inspectOwnerForkProvenance(inspect(child))?.get(call), null);
	assert.equal(JSON.stringify(child.getEntries()), before);
});
