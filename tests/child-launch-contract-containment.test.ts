import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { ChildLaunchContractGuard } from "../src/process-runtime/child-launch-contract.ts";
import { PiChildProcessRuntime, type StartPiChildProcessRuntimeOptions } from "../src/process-runtime/pi-child-process-runtime.ts";
import { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";

test("incompatible resume and cancellation delivery admissions create no Runs or Moderator launch path", { timeout: 10_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-contract-containment-"));
	const schemaPath = join(root, "schemas.mjs");
	await writeFile(schemaPath, "export const AGENT_CONTROL_PROTOCOL_VERSION = 9; export const ChildProcessBootstrapSchema = {};");
	const guard = new ChildLaunchContractGuard(pathToFileURL(schemaPath));
	const assertCompatible = ChildLaunchContractGuard.prototype.assertCompatible;
	t.mock.method(ChildLaunchContractGuard.prototype, "assertCompatible", () => assertCompatible.call(guard));
	const factory = new ProcessChildSessionFactory({
		ownerRuntime: {} as AgentSessionRuntime,
		ownerIdentity: { agentId: "owner", workflowId: "owner", directSpawnerAgentId: null, metadata: { label: "Owner", description: "Workflow Owner" } },
		entryModulePath: "/fixture/src/index.ts",
		resolveAgent() { throw new Error("incompatible preparation must stop before resolving resources"); },
		ownerRequestHandlers() { throw new Error("incompatible preparation must not launch a process"); },
	});
	const sessionPath = join(root, "child.jsonl");
	const evidence = '{"canonicalRequest":"untouched-request"}\n';
	await writeFile(sessionPath, evidence);
	const record = factory.createAgentRecord({
		identity: {
			agentId: "child", workflowId: "owner", directSpawnerAgentId: "owner",
			spawnSource: { agentId: "owner", entryId: "creation", toolCallId: "request" },
			creationPreset: { systemPromptMode: "append", loadContextFiles: true, systemPrompt: "" },
			metadata: { label: "child" },
		},
		parent: {} as AgentRecord,
		spawnInput: { title: "Retained request", request: "Unanswered work" },
		sessionPath,
	});
	let started = 0;
	let ended = 0;
	record.host.setRunStartedHandler(() => { started++; });
	record.host.addEndedHandler(() => { ended++; });
	for (let attempt = 0; attempt < 3; attempt++) {
		// Resume Messages and Request Cancellation Delivery use this same pending-delivery admission seam.
		await assert.rejects(record.host.startInLane(["pending_delivery"]), /protocol_mismatch/);
		assert.equal(record.host.currentHandle(), undefined);
		assert.equal(record.host.observe().phase, "dormant");
		await assert.rejects(factory.prepareModeratorRun({ agentId: `moderator-${attempt}` }), /protocol_mismatch/);
	}
	assert.equal(started, 0);
	assert.equal(ended, 0, "preflight failure is not an exact Run failure");
	assert.equal(await readFile(sessionPath, "utf8"), evidence);
	// The low-level entry also checks before allocating listeners, artifacts or a PTY.
	await assert.rejects(PiChildProcessRuntime.launch({} as StartPiChildProcessRuntimeOptions), /protocol_mismatch/);
});

test("new child bridge rejects legacy producers and malformed JSON without exposing descriptor secrets", { timeout: 10_000 }, async (t) => {
	const { default: bridge } = await import("../src/process-runtime/child-runtime-bridge.ts");
	const root = await mkdtemp(join(tmpdir(), "pi-bootstrap-rejection-"));
	const path = join(root, "bootstrap.json");
	const previous = process.env.PI_AGENT_COORDINATION_BOOTSTRAP;
	process.env.PI_AGENT_COORDINATION_BOOTSTRAP = path;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_AGENT_COORDINATION_BOOTSTRAP;
		else process.env.PI_AGENT_COORDINATION_BOOTSTRAP = previous;
	});
	const legacy = {
		protocolVersion: 7, endpoint: { transport: "unix", address: "/tmp/unused.sock" },
		connectionToken: "SECRET-TOKEN", workflowId: "owner", agentId: "child",
		role: "ordinary", ownerPresentation: true, expectedSessionId: "child",
	};
	for (const [content, expected] of [
		[JSON.stringify(legacy), /protocol_mismatch: expected 8, received 7/],
		[JSON.stringify({ ...legacy, protocolVersion: 8 }), /schema_drift.*missing fields: tools/],
		['{"connectionToken":"SECRET-TOKEN", invalid}', /descriptor could not be read as JSON/],
	] as const) {
		await writeFile(path, content, { mode: 0o600 });
		await assert.rejects(async () => bridge({ registerMessageRenderer() {} } as unknown as Parameters<typeof bridge>[0]), (error: Error) => {
			assert.match(error.message, expected);
			assert.match(error.message, /stop.*align.*restart/i);
			assert.doesNotMatch(error.message, /SECRET-TOKEN|unused.sock/);
			return true;
		});
	}
});
