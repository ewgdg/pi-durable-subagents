import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { AGENT_CONTROL_PROTOCOL_VERSION, ChildProcessBootstrapSchema } from "../src/control/control-protocol-schemas.ts";
import { ChildLaunchContractGuard } from "../src/process-runtime/child-launch-contract.ts";

test("launch preflight works from an installed extension with host-provided peers only", { timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-installed-launch-contract-"));
	const installed = join(root, "node_modules", "pi-durable-subagents");
	await cp(new URL("../src/", import.meta.url), join(installed, "src"), { recursive: true });
	const extensionPath = join(installed, "probe.ts");
	await writeFile(extensionPath, `
		import { ChildLaunchContractGuard } from "./src/process-runtime/child-launch-contract.ts";
		export default async function () { await new ChildLaunchContractGuard().assertCompatible(); }
	`);
	const loaded = await discoverAndLoadExtensions([extensionPath], root, join(root, "agent"));
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
});

test("fresh launch contract detects an in-place update despite cached Owner modules and latches rejection", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-launch-contract-"));
	const path = join(root, "schemas.mjs");
	const publish = (version: number, schema: unknown) => writeFile(path, `export const AGENT_CONTROL_PROTOCOL_VERSION = ${version}; export const ChildProcessBootstrapSchema = ${JSON.stringify(schema)};`);
	await publish(AGENT_CONTROL_PROTOCOL_VERSION, ChildProcessBootstrapSchema);
	const guard = new ChildLaunchContractGuard(pathToFileURL(path));
	await guard.assertCompatible();
	await publish(AGENT_CONTROL_PROTOCOL_VERSION + 1, ChildProcessBootstrapSchema);
	await assert.rejects(guard.assertCompatible(), /protocol_mismatch.*expected 9, received 8/);
	await publish(AGENT_CONTROL_PROTOCOL_VERSION, ChildProcessBootstrapSchema);
	// Resume, cancellation-triggered delivery and Moderator preparation must not repair by retry.
	for (let attempt = 0; attempt < 3; attempt++) {
		await assert.rejects(guard.assertCompatible(), (error: Error) => {
			assert.match(error.message, /Owner: report.*user immediately/);
			assert.match(error.message, /stop active work and correct.*align.*if incompatible.*restart the Pi host/);
			return true;
		});
	}
	await new ChildLaunchContractGuard(pathToFileURL(path)).assertCompatible();
});

test("same-version on-disk schema drift is rejected before Pi launch", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-launch-contract-"));
	const path = join(root, "schemas.mjs");
	await writeFile(path, `export const AGENT_CONTROL_PROTOCOL_VERSION = ${AGENT_CONTROL_PROTOCOL_VERSION}; export const ChildProcessBootstrapSchema = ${JSON.stringify({ ...ChildProcessBootstrapSchema, required: [...ChildProcessBootstrapSchema.required!, "newRequiredField"] })};`);
	await assert.rejects(new ChildLaunchContractGuard(pathToFileURL(path)).assertCompatible(), /schema_drift: expected 8, received 8; missing fields: newRequiredField/);
});

test("same-version preflight names incompatible tools constraints without exposing schema values", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-launch-contract-"));
	const path = join(root, "schemas.mjs");
	const schema = { ...ChildProcessBootstrapSchema, properties: { ...ChildProcessBootstrapSchema.properties, tools: { type: "string", const: "SECRET-SCHEMA-VALUE" } } };
	await writeFile(path, `export const AGENT_CONTROL_PROTOCOL_VERSION = 8; export const ChildProcessBootstrapSchema = ${JSON.stringify(schema)};`);
	await assert.rejects(new ChildLaunchContractGuard(pathToFileURL(path)).assertCompatible(), (error: Error) => {
		assert.match(error.message, /schema_drift: expected 8, received 8; missing fields: none; invalid fields: tools/);
		assert.doesNotMatch(error.message, /SECRET-SCHEMA-VALUE/);
		return true;
	});
});

test("a permanent launch block is reported once across concurrent probes and retries", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-launch-contract-"));
	const path = join(root, "schemas.mjs");
	await writeFile(path, "throw new Error('SECRET-PROBE-DETAIL');");
	const reported: Error[] = [];
	const guard = new ChildLaunchContractGuard(pathToFileURL(path), error => reported.push(error));
	const attempts = await Promise.allSettled([guard.assertCompatible(), guard.assertCompatible()]);
	await assert.rejects(guard.assertCompatible(), /control_bootstrap_probe_failed/);
	assert.equal(reported.length, 1);
	for (const attempt of attempts) {
		assert.equal(attempt.status, "rejected");
		if (attempt.status === "rejected") assert.equal(attempt.reason, reported[0]);
	}
	assert.doesNotMatch(reported[0]!.message, /SECRET-PROBE-DETAIL/);
});

test("probe failures identify missing modules without revealing paths or dependency names", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-launch-contract-"));
	const path = join(root, "schemas.mjs");
	await writeFile(path, "import './SECRET-MODULE-PATH.mjs';");
	await assert.rejects(new ChildLaunchContractGuard(pathToFileURL(path)).assertCompatible(), (error: Error) => {
		assert.match(error.message, /control_bootstrap_probe_failed:.*contract module or dependency is unavailable/);
		assert.doesNotMatch(error.message, /SECRET-MODULE-PATH/);
		assert.equal(error.message.includes(root), false);
		return true;
	});
});

test("a stalled contract probe reports its deadline and permanently blocks retries", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-launch-contract-"));
	const path = join(root, "schemas.mjs");
	await writeFile(path, "await new Promise(() => setInterval(() => {}, 1000));");
	const guard = new ChildLaunchContractGuard(pathToFileURL(path));
	await assert.rejects(guard.assertCompatible(), /control_bootstrap_probe_failed:.*exceeded its 5000 ms deadline/);
	await writeFile(path, `export const AGENT_CONTROL_PROTOCOL_VERSION = ${AGENT_CONTROL_PROTOCOL_VERSION}; export const ChildProcessBootstrapSchema = ${JSON.stringify(ChildProcessBootstrapSchema)};`);
	await assert.rejects(guard.assertCompatible(), /exceeded its 5000 ms deadline/);
});
