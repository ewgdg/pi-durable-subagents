import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { SessionManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import type { WorkflowCoordinator, AgentSpawnReceipt } from "../src/coordination/workflow-coordinator.ts";
import { ModeratorReportStore } from "../src/coordination/moderator-reports.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { executeAndCommitRegisteredTool } from "./support/agent-session.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { ChildLaunchContractGuard } from "../src/process-runtime/child-launch-contract.ts";
import { PiChildProcessRuntime, type StartPiChildProcessRuntimeOptions } from "../src/process-runtime/pi-child-process-runtime.ts";
import { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";

test("permanent launch rejection publishes one durable unread report without Owner cooperation", { timeout: 10_000 }, async (t) => {
	let owner!: ReturnType<WorkflowCoordinator["forAgent"]>;
	const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner), { persistent: true });
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, { entryModulePath: "<inline:pi-agent-coordination>" });
	owner = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	let notifiedWithUnreadReport = false;
	const unsubscribe = owner.addAgentActivityChangeHandler(() => {
		if (owner.agentActivity().reports?.some(item => !item.readAt)) notifiedWithUnreadReport = true;
	});
	t.after(unsubscribe);
	const spawn = async (id: string) => (await executeAndCommitRegisteredTool(host.session, "agent_spawn", id, {
		title: "Probe failure", request: "Must fail before creating a child.",
	})).details as AgentSpawnReceipt;
	// Exercise a real probe failure without mutating the installed contract or
	// depending on stderr content. Restoring Node must not unlock the factory.
	const executable = process.execPath;
	let receipt: AgentSpawnReceipt;
	try {
		process.execPath = join(host.cwd, "missing-node");
		receipt = await spawn("blocked-launch");
	} finally {
		process.execPath = executable;
	}
	assert.equal(receipt.spawnStatus, "not_created");
	assert.ok(receipt.spawnStatus === "not_created");
	assert.equal(receipt.failedStage, "configuration");
	assert.match(receipt.reason, /control_bootstrap_probe_failed/);
	assert.deepEqual(owner.children(), []);
	const history = owner.reportHistory();
	assert.equal(history.length, 1, "the runtime reports even when the Owner never reads the tool result");
	const item = history[0]!;
	assert.equal(item.readAt, undefined);
	assert.equal(item.report.reporter, undefined);
	assert.equal(item.report.source.kind, "runtime_diagnostic");
	assert.match(item.report.symptom, /child and Moderator launches.*blocked/i);
	assert.match(item.report.suspectedDefect, /control_bootstrap_probe_failed/);
	assert.match(item.report.recoveryActions, /restart/i);
	assert.match(item.report.recoveryOutcome, /reading.*does not.*unblock/i);
	assert.ok(notifiedWithUnreadReport, "report publication refreshes the human attention surface");
	const diagnostic = host.session.sessionManager.getEntry(item.report.source.entryId);
	assert.ok(diagnostic?.type === "custom");
	assert.match(JSON.stringify(diagnostic.data), /control_bootstrap_probe_failed/);
	owner.setReportRead(item.report.reportId, true);
	for (let attempt = 0; attempt < 2; attempt++) {
		const retry = await spawn(`blocked-retry-${attempt}`);
		assert.equal(retry.spawnStatus, "not_created");
	}
	assert.equal(owner.reportHistory().length, 1, "latched rejection does not republish after acknowledgement");
	assert.ok(owner.reportHistory()[0]?.readAt);
	const reopened = SessionManager.open(host.session.sessionManager.getSessionFile()!);
	const reports = new ModeratorReportStore({
		transcript: transcriptFromSessionManager(reopened),
		appendCustomEntry: (type, data) => reopened.appendCustomEntry(type, data),
	});
	assert.deepEqual(reports.history(), owner.reportHistory());
});

test("an unsaved Owner gets direct launch-block attention without losing the original diagnostic", { timeout: 10_000 }, async (t) => {
	let owner!: ReturnType<WorkflowCoordinator["forAgent"]>;
	const host = await createUnboundTestOwnerHost(t, createAgentBoundExtension(() => owner));
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, { entryModulePath: "<inline:pi-agent-coordination>" });
	owner = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	assert.equal(host.session.sessionManager.getSessionFile(), undefined);
	const executable = process.execPath;
	try {
		process.execPath = join(host.cwd, "missing-node");
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await executeAndCommitRegisteredTool(host.session, "agent_spawn", `unsaved-block-${attempt}`, {
				title: "Probe failure", request: "Must fail before creating a child.",
			});
			const receipt = result.details as AgentSpawnReceipt;
			assert.ok(receipt.spawnStatus === "not_created");
			assert.match(receipt.reason, /control_bootstrap_probe_failed.*probe runtime is unavailable/);
		}
	} finally {
		process.execPath = executable;
	}
	const notifications = host.ui.notifications.filter(item => item.message.includes("control_bootstrap_probe_failed"));
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.type, "error");
	assert.match(notifications[0]!.message, /no session file.*report cannot be saved/i);
	assert.deepEqual(owner.reportHistory(), []);
	assert.deepEqual(owner.children(), []);
});

test("incompatible shared pending-delivery admission creates no Runs or Moderator launch path", { timeout: 10_000 }, async (t) => {
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
		// The empty on-disk schema is rejected as an incompatible preflight either way.
		await assert.rejects(record.host.startInLane(["pending_delivery"]), /control_bootstrap_(protocol_mismatch|schema_drift)/);
		assert.equal(record.host.currentHandle(), undefined);
		assert.equal(record.host.observe().phase, "dormant");
		await assert.rejects(factory.prepareModeratorRun({ agentId: `moderator-${attempt}` }), /control_bootstrap_(protocol_mismatch|schema_drift)/);
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
		[JSON.stringify(legacy), /protocol_mismatch: expected 9, received 7/],
		[JSON.stringify({ ...legacy, protocolVersion: 9 }), /schema_drift.*missing fields: excludedTools/],
		['{"connectionToken":"SECRET-TOKEN", invalid}', /descriptor could not be read as JSON/],
	] as const) {
		await writeFile(path, content, { mode: 0o600 });
		await assert.rejects(async () => bridge({ on() {}, registerMessageRenderer() {} } as unknown as Parameters<typeof bridge>[0]), (error: Error) => {
			assert.match(error.message, expected);
			assert.match(error.message, /stop.*align.*restart/i);
			assert.match(error.message, /Owner: report.*user immediately/);
			assert.match(error.message, /restart the Pi host/);
			assert.doesNotMatch(error.message, /SECRET-TOKEN|unused.sock/);
			return true;
		});
	}
});
