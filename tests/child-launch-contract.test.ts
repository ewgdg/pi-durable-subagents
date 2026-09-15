import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { AGENT_CONTROL_PROTOCOL_VERSION, ChildProcessBootstrapSchema } from "../src/control/control-protocol-schemas.ts";
import { ChildLaunchContractGuard } from "../src/process-runtime/child-launch-contract.ts";

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
	await assert.rejects(guard.assertCompatible(), /Stop.*align.*restart/i);
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
