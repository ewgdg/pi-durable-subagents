import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
} from "@earendil-works/pi-ai";
import {
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import { discoverColdWorkflow } from "../src/bootstrap/cold-host-discovery.ts";
import { workflowSessionDirectory } from "../src/runtime/workflow-session-directory.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";
import { createProcessModelBroker } from "./support/process-model-broker.ts";

const TEST_TIMEOUT_MS = 45_000;
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

test("coordinator admits a skipped spawn as an observable dormant Agent without starting or rewriting it", { timeout: 5_000 }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const manager = host.session.sessionManager;
	const entryId = manager.appendMessage(
		fauxAssistantMessage(fauxToolCall(
			"agent_spawn",
			{
				request: "No title",
				template: "removed-template",
				config: { cwd: "/rejected" },
			},
			{ id: "rejected-spawn" },
		)),
	);
	const child = SessionManager.create(
		host.cwd,
		workflowSessionDirectory(manager.getSessionDir(), identity.workflowId),
	);
	child.appendCustomEntry("agent-coordination.identity", {
		agentId: child.getSessionId(),
		workflowId: identity.workflowId,
		directSpawnerAgentId: identity.agentId,
		creationPreset: null,
		spawnSource: {
			agentId: identity.agentId,
			entryId,
			toolCallId: "rejected-spawn",
		},
		metadata: { label: "Recovered" },
	});
	child.appendMessage(fauxAssistantMessage("Persist"));
	const path = child.getSessionFile()!;
	const before = await readFile(path, "utf8");
	const recoveredWorkflow = await discoverColdWorkflow({
		ownerIdentity: identity,
		ownerSessionManager: manager,
	});
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		recoveredWorkflow,
	});
	try {
		const status = coordinator.forAgent(identity.agentId).status(child.getSessionId());
		assert.equal(status.run.phase, "dormant");
		assert.equal(status.primaryEvidence.transcriptPath, path);
		assert.equal(await readFile(path, "utf8"), before);
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});

test("a descendant inherits neither the Owner's active tools nor its skills", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const owner: AgentRecord = {
		identity,
		host: AgentRuntimeSupervisor.bindOwner(host.runtime),
		transcript: transcriptFromSessionManager(host.session.sessionManager),
		children: [],
	};
	const factory = new ProcessChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity: identity,
		entryModulePath: "<inline:pi-durable-subagents>",
		templateRoots: () => [],
		resolveAgent: (agentId) => agentId === identity.agentId ? owner : undefined,
		ownerRequestHandlers() { throw new Error("Preparation must not launch a child process"); },
	});
	try {
		assert.ok(host.session.getAllTools().some(({ name }) => name === "bash"));
		for (const admitted of [true, false]) {
			owner.host = admitted ? AgentRuntimeSupervisor.bindOwner(host.runtime)
				: { effectiveRuntimeSnapshot: () => undefined } as AgentRecord["host"];
			for (const active of [["read"], ["bash"], []]) {
				host.session.setActiveToolsByName(active);
				const prepared = await factory.prepareOrdinaryRun({
					agentId: "descendant", parent: owner,
					spawnInput: { title: "Keep the runtime default", request: "Keep your own runtime default surface." },
				});
				// The Owner's active surface is not a source of child configuration.
				assert.deepEqual(prepared.configuration.excludeTools, []);
				assert.deepEqual(prepared.configuration.excludeSkills, []);
			}
			for (const excludeTools of [["bash"], []]) {
				const explicit = await factory.prepareOrdinaryRun({
					agentId: "explicit", parent: owner,
					spawnInput: { title: "Withhold one tool", request: "Withhold one tool.", config: { excludeTools } },
				});
				assert.deepEqual(explicit.configuration.excludeTools, excludeTools);
				const preset = await factory.prepareOrdinaryRun({
					agentId: "preset", parent: owner,
					spawnInput: { title: "Withhold Template tools", request: "Withhold Template tools.", config: { excludeTools } },
					creationPreset: {
						excludeTools: ["read"],
						systemPromptMode: "append", loadContextFiles: false, systemPrompt: "",
					},
				});
				// A Template rule accumulates with the Spawn rule instead of being replaced.
				assert.deepEqual(
					preset.configuration.excludeTools,
					["read", ...excludeTools.filter((name) => name !== "read")],
				);
			}
		}
	} finally {
		await host.runtime.dispose();
	}
});

for (const skippedSpawn of [false, true]) test(`a dormant parent retains creation preset rules while descendant catalogues load current resources (skipped spawn: ${skippedSpawn})`, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-dynamic-parent-runtime-"));
	const templateRoot = join(root, "templates");
	await mkdir(templateRoot);
	const templatePath = join(templateRoot, "parent.md");
	await writeFile(
		templatePath,
		"---\nname: dynamic-parent\nuseWhen: Use for dynamic parent work.\nmodels:\n  - id: missing/model\n    thinking: low\n  - id: coordination-test/deterministic-owner\n    thinking: high\nexcludeTools:\n  - read\n  - bash\n---\n",
	);
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const ownerIdentity = adoptOrValidateOwnerIdentity(host.runtime);
	const ownerRecord: AgentRecord = {
		identity: ownerIdentity,
		host: AgentRuntimeSupervisor.bindOwner(host.runtime),
		transcript: transcriptFromSessionManager(host.session.sessionManager),
		children: ["dormant-parent"],
	};
	const parentSession = SessionManager.inMemory(host.cwd, { id: "dormant-parent" });
	parentSession.appendCustomEntry("agent-coordination.identity", { marker: true });
	const parentRecord = {
		identity: {
			agentId: "dormant-parent",
			workflowId: ownerIdentity.workflowId,
			directSpawnerAgentId: ownerIdentity.agentId,
			spawnSource: {
				agentId: ownerIdentity.agentId,
				entryId: "parent-spawn-entry",
				toolCallId: "parent-spawn-call",
			},
			metadata: { label: "dynamic-parent" },
			creationPreset: {
				models: [{ model: { provider: "coordination-test", modelId: "deterministic-owner" }, thinking: "high" }],
				systemPromptMode: "append", loadContextFiles: true, systemPrompt: "",
			},
		},
		creationInput: skippedSpawn ? undefined : {
			title: "Fixture request",
			request: "Act as the dynamically configured parent.",
			template: "dynamic-parent",
		},
		host: {
			effectiveRuntimeSnapshot: () => undefined,
		} as unknown as AgentRecord["host"],
		transcript: transcriptFromSessionManager(parentSession),
		children: [],
	} satisfies AgentRecord;
	const agents = new Map([
		[ownerIdentity.agentId, ownerRecord],
		[parentRecord.identity.agentId, parentRecord],
	]);
	const factory = new ProcessChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity,
		entryModulePath: "<inline:pi-durable-subagents>",
		packageRoot: root,
		templateRoots: () => [{ scope: "test", path: templateRoot }],
		resolveAgent: (agentId) => agents.get(agentId),
		ownerRequestHandlers() {
			throw new Error("Preparation test must not launch a child process");
		},
	});
	try {
		const first = await factory.prepareOrdinaryRun({
			agentId: "descendant",
			parent: parentRecord,
			spawnInput: skippedSpawn ? undefined : {
				title: "Fixture request",
				request: "Inherit the current parent configuration.",
			},
			creationPreset: null,
		});
		// Neither a Template rule nor a Spawn exclusion applies here, and nothing is
		// inherited from the Owner's surface.
		assert.deepEqual(first.configuration.excludeTools, []);
		assert.deepEqual(first.configuration.excludeSkills, []);
		assert.deepEqual(first.configuration.model, {
			provider: "coordination-test",
			modelId: "deterministic-owner",
		});
		assert.equal(first.configuration.thinking, "high");
		assert.deepEqual(
			first.agentTemplateSnapshot?.templates.find(({ name }) => name === "dynamic-parent")
				?.excludeTools,
			["read", "bash"],
		);

		await writeFile(
			templatePath,
			"---\nname: dynamic-parent\nuseWhen: Use for dynamic parent work.\nmodels:\n  - id: missing/model\n    thinking: low\n  - id: coordination-test/deterministic-owner\n    thinking: high\nexcludeTools: read\n---\n",
		);
		const second = await factory.prepareOrdinaryRun({
			agentId: "descendant",
			parent: parentRecord,
			spawnInput: { title: "Fixture request", request: "Inherit the current parent configuration." },
		});
		// The reloaded Template only updates the descendant catalogue; this Spawn
		// names no Template and no exclusions, so it withholds nothing.
		assert.deepEqual(second.configuration.excludeTools, []);
		assert.deepEqual(
			second.agentTemplateSnapshot?.templates.find(({ name }) => name === "dynamic-parent")
				?.excludeTools,
			["read"],
		);
	} finally {
		await host.runtime.dispose();
	}
});

test("a live parent contributes its current synchronized Runtime state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-live-parent-runtime-"));
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const ownerIdentity = adoptOrValidateOwnerIdentity(host.runtime);
	const ownerRecord: AgentRecord = {
		identity: ownerIdentity,
		host: AgentRuntimeSupervisor.bindOwner(host.runtime),
		transcript: transcriptFromSessionManager(host.session.sessionManager),
		children: ["live-parent"],
	};
	const parentSession = SessionManager.inMemory(host.cwd, { id: "live-parent" });
	parentSession.appendCustomEntry("agent-coordination.identity", { marker: true });
	const model = host.session.model;
	assert.ok(model);
	let synchronizedSnapshot: NonNullable<ReturnType<AgentRecord["host"]["effectiveRuntimeSnapshot"]>> = {
		cwd: host.cwd,
		model: { provider: model.provider, modelId: model.id },
		thinking: host.session.thinkingLevel,
		tools: ["bash"],
		skills: [],
		skillSources: [],
		fileExtensionPaths: [],
		projectTrusted: true,
		sessionId: "live-parent",
	};
	let synchronizations = 0;
	const parentRecord = {
		identity: {
			agentId: "live-parent",
			workflowId: ownerIdentity.workflowId,
			directSpawnerAgentId: ownerIdentity.agentId,
			spawnSource: {
				agentId: ownerIdentity.agentId,
				entryId: "live-parent-spawn-entry",
				toolCallId: "live-parent-spawn-call",
			},
			metadata: { label: "live-parent" },
			creationPreset: null,
		},
		creationInput: { title: "Fixture request", request: "Act as the live parent." },
		host: {
			effectiveRuntimeSnapshot: () => ({ ...synchronizedSnapshot, tools: ["read"] }),
			async synchronizeRuntimeState() {
				synchronizations += 1;
				return synchronizedSnapshot;
			},
		} as unknown as AgentRecord["host"],
		transcript: transcriptFromSessionManager(parentSession),
		children: [],
	} satisfies AgentRecord;
	const agents = new Map([
		[ownerIdentity.agentId, ownerRecord],
		[parentRecord.identity.agentId, parentRecord],
	]);
	const factory = new ProcessChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity,
		entryModulePath: "<inline:pi-durable-subagents>",
		packageRoot: root,
		templateRoots: () => [],
		resolveAgent: (agentId) => agents.get(agentId),
		ownerRequestHandlers() {
			throw new Error("Preparation test must not launch a child process");
		},
	});
	try {
		const prepared = await factory.prepareOrdinaryRun({
			agentId: "live-descendant",
			parent: parentRecord,
			spawnInput: { title: "Fixture request", request: "Inherit current live state." },
		});
		assert.equal(synchronizations, 1);
		// The live parent contributes identity, not a tool surface.
		assert.deepEqual(prepared.configuration.excludeTools, []);
		assert.deepEqual(prepared.configuration.excludeSkills, []);

		const omitted = await factory.prepareOrdinaryRun({
			agentId: "omitted", parent: parentRecord, spawnInput: { title: "Fixture request", request: "Inherit" },
			creationPreset: { systemPromptMode: "append", loadContextFiles: false, systemPrompt: "Fixed rules." },
		});
		const explicit = await factory.prepareOrdinaryRun({
			agentId: "explicit", parent: parentRecord,
			spawnInput: { title: "Fixture request", request: "Inherit", config: { model: { id: "inherit", thinking: "inherit" }, extensions: "inherit" } },
			creationPreset: {
				excludeTools: ["read"], extensions: "none",
				systemPromptMode: "replace", loadContextFiles: false, systemPrompt: "Fixed rules.",
			},
		});

		const inheritedExtension = join(root, "inherited.mjs");
		await writeFile(inheritedExtension, "export default function () {}");
		const inheritedSkill = join(root, "SKILL.md");
		await writeFile(inheritedSkill, "---\nname: inherited-skill\ndescription: Inherited skill\n---\nInherited.");
		const currentCwd = join(root, "current");
		await mkdir(currentCwd);
		synchronizedSnapshot = {
			...synchronizedSnapshot,
			model: { provider: "current-parent", modelId: "current-model" },
			thinking: "high", tools: ["grep"], cwd: currentCwd,
			skills: ["inherited-skill"], skillSources: [{ name: "inherited-skill", filePath: inheritedSkill }],
			fileExtensionPaths: [inheritedExtension],
		};
		for (const [prepared, config, expectedExcludeTools] of [
			[omitted, undefined, []],
			[explicit, { model: { id: "inherit", thinking: "inherit" }, extensions: "inherit" }, ["read"]],
		] as const) {
			const restarted = await factory.prepareOrdinaryRun({
				agentId: prepared.agentId, parent: parentRecord,
				spawnInput: { title: "Fixture request", request: "Inherit", ...(config === undefined ? {} : { config }) },
				creationPreset: prepared.creationPreset,
			});
			assert.deepEqual(restarted.configuration.model, { provider: "current-parent", modelId: "current-model" });
			assert.equal(restarted.configuration.thinking, "high");
			assert.equal(restarted.configuration.cwd, currentCwd);
			// The child resolves its own skills; the parent's selection is not inherited.
			assert.deepEqual(restarted.configuration.skills, []);
			assert.deepEqual(restarted.configuration.extensions, [inheritedExtension]);
			// Neither the earlier nor the current parent surface becomes a child rule;
			// only the captured preset carries an exclusion.
			assert.deepEqual(restarted.configuration.excludeTools, expectedExcludeTools);
			assert.equal(restarted.configuration.systemPrompt?.body, "Fixed rules.");
			assert.equal(restarted.configuration.loadContextFiles, false);
		}
	} finally {
		await host.runtime.dispose();
	}
});

test("ordinary production spawn runs in a real child process over Owner participant RPC", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async (t) => {
	const broker = await createProcessModelBroker({
		providerId: "process-child-cutover-test",
		modelId: "process-child-cutover-model",
	});
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: false,
		additionalExtensionPaths: [broker.extensionPath],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const effectiveCwd = join(host.cwd, "process-child-cwd");
	await mkdir(effectiveCwd);
	const templateDirectory = join(host.services.agentDir, "agents");
	await mkdir(templateDirectory, { recursive: true });
	await writeFile(join(templateDirectory, "process-delegate.md"), [
		"---",
		"name: process-delegate",
		"useWhen: Use from a freshly prepared process Runtime.",
		"---",
		"Process child context.",
	].join("\n"), "utf8");
	const pidEvidence = join(effectiveCwd, "child-pid.txt");
	let childSystemPrompt = "";
	broker.setResponses([
		(context) => {
			childSystemPrompt = getCurrentSystemPrompt(context.messages);
			return fauxAssistantMessage(
				fauxToolCall("bash", { command: `printf '%s' "$PPID" > ${JSON.stringify(pidEvidence)}` }, {
					id: "real-child-bash",
				}),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(
			fauxToolCall("agent_observe", { operation: "status" }, {
				id: "proxied-child-observe",
			}),
			{ stopReason: "toolUse" },
		),
		(context) => fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer", requestId: latestRequestFromContext(context).requestMessageId,
				answer: "Process child answer crossed the Owner RPC boundary.",
			}, { id: "proxied-child-message" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Real process child completed after proxied observation."),
	]);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	try {
		const owner = coordinator.forAgent(identity.agentId);
		const input = {
			title: "Fixture request",
			request: "Prove the process Runtime and inspect your coordinated status.",
			template: "process-delegate",
			config: {
				cwd: effectiveCwd,
				model: { id: `${broker.providerId}/${broker.modelId}`, thinking: "inherit" as const },
			},
		};
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_spawn", input, { id: "spawn-real-process-child" }),
				{ stopReason: "toolUse" },
			),
		);
		const receipt = await owner.spawn("spawn-real-process-child", input);
		assert.equal(receipt.spawnStatus, "created");
		assert.equal("messageStatus" in receipt && receipt.messageStatus, "sent");
		assert.ok("agentId" in receipt);
		const child = owner.children()[0];
		assert.equal(child?.agentId, receipt.agentId);
		assert.equal(child?.run.phase, "live");
		const sessionPath = child?.primaryEvidence.transcriptPath;
		assert.ok(sessionPath);

		const initialTranscript = SessionManager.open(sessionPath);
		assert.equal(initialTranscript.getHeader()?.cwd, effectiveCwd);
		const initialEntries = initialTranscript.getEntries();
		assert.equal(initialEntries[0]?.type, "custom");
		assert.deepEqual((initialEntries[0].data as { creationPreset: unknown }).creationPreset, {
			systemPromptMode: "append", loadContextFiles: true, systemPrompt: "Process child context.",
		});
		assert.deepEqual(
			initialEntries.flatMap((entry) => entry.type === "custom" ? [entry.customType] : []),
			["agent-coordination.identity"],
		);

		await waitFor(() => {
			const entries = SessionManager.open(sessionPath).getEntries();
			return entries.some(
				(entry) => entry.type === "message" && entry.message.role === "assistant" &&
					entry.message.content.some(
						(part) => part.type === "text" && part.text.includes("Real process child completed"),
					),
			);
		});
		const childPid = Number(await readFile(pidEvidence, "utf8"));
		assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
		assert.notEqual(childPid, process.pid);
		assert.equal(broker.state.callCount, 4);
		assert.match(childSystemPrompt, /## Available Agent Templates/);
		assert.match(childSystemPrompt, /process-delegate/);

		await waitFor(() => owner.status(receipt.agentId).run.phase === "dormant");
		const entriesBeforeSuccessor = SessionManager.open(sessionPath).getEntries().length;
		await rename(join(templateDirectory, "process-delegate.md"), join(templateDirectory, "renamed.md"));
		await writeFile(join(templateDirectory, "renamed.md"), "---\nname: renamed\n---\nChanged rules.");
		broker.appendResponses([
			(context) => {
				assert.match(getCurrentSystemPrompt(context.messages), /Process child context\./);
				assert.doesNotMatch(getCurrentSystemPrompt(context.messages), /Changed rules\./);
				return fauxAssistantMessage("Dynamically prepared successor used the same transcript.");
			},
		]);
		const successorInput = {
			operation: "send" as const,
			targetAgent: receipt.agentId,
			content: "Start one successor after re-resolving current resources.",
		};
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_message", successorInput, { id: "start-process-successor" }),
				{ stopReason: "toolUse" },
			),
		);
		const successorReceipt = await owner.message(
			"start-process-successor",
			successorInput,
		);
		assert.ok("messageStatus" in successorReceipt);
		assert.equal(successorReceipt.messageStatus, "sent");
		await waitFor(() => {
			const entries = SessionManager.open(sessionPath).getEntries();
			return entries.length > entriesBeforeSuccessor && entries.some(
				(entry) => entry.type === "message" && entry.message.role === "assistant" &&
					entry.message.content.some(
						(part) => part.type === "text" && part.text.includes("Dynamically prepared successor"),
					),
			);
		});
		assert.equal(owner.status(receipt.agentId).primaryEvidence.transcriptPath, sessionPath);
		await waitFor(() => owner.status(receipt.agentId).run.phase === "dormant");
		await waitFor(async () => (await runtimeArtifacts(identity.workflowId)).length === 0);
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
		await broker.close();
	}
});

test("post-Identity process startup failure leaves exact durable evidence and a dormant record", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: false,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	try {
		const owner = coordinator.forAgent(identity.agentId);
		const input = {
			title: "Fixture request",
			request: "Materialize me before deterministic process startup failure.",
			config: {
				model: { id: "coordination-test/deterministic-owner", thinking: "inherit" as const },
				extensions: "none" as const,
			},
		};
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_spawn", input, { id: "spawn-post-identity-failure" }),
				{ stopReason: "toolUse" },
			),
		);

		const receipt = await owner.spawn("spawn-post-identity-failure", input);
		assert.equal(receipt.spawnStatus, "created");
		assert.equal("messageStatus" in receipt && receipt.messageStatus, "not_sent");
		assert.ok("agentId" in receipt);
		assert.ok("failedStage" in receipt);
		assert.equal(receipt.failedStage, "run_start");
		assert.ok("reason" in receipt);
		assert.match(receipt.reason, /coordination-test|provider|model/i);
		const status = owner.status(receipt.agentId);
		assert.equal(status.run.phase, "dormant");
		assert.ok(status.primaryEvidence.transcriptPath);
		const durable = SessionManager.open(status.primaryEvidence.transcriptPath);
		assert.equal(durable.getSessionId(), receipt.agentId);
		assert.deepEqual(
			durable.getEntries().flatMap(
				(entry) => entry.type === "custom" ? [entry.customType] : [],
			),
			["agent-coordination.identity"],
		);
		await waitFor(async () => (await runtimeArtifacts(identity.workflowId)).length === 0);
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});

test("Moderator attempts use process Runtimes and one committed failure creates one linked replacement", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async (t) => {
	const broker = await createProcessModelBroker();
	initTheme("dark");
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	const moderatorWidgetExtension = join(
		broker.runtimeDirectory,
		"moderator-process-widget.mjs",
	);
	await writeFile(moderatorWidgetExtension, [
		"export default function moderatorProcessWidget(pi) {",
		"  pi.on('session_start', (_event, ctx) => {",
		"    if (process.env.PI_DURABLE_SUBAGENTS_BOOTSTRAP) ctx.ui.setTheme('light');",
		"    ctx.ui.setWidget('moderator-process-widget', [",
		"      'PROCESS_RUNTIME_CHILD_WIDGET',",
		"      `PID=${process.pid}`,",
		"      `AGENT_DIR=${String(process.env.PI_CODING_AGENT_DIR)}`,",
		"    ]);",
		"  });",
		"}",
	].join("\n"), { mode: 0o600 });
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: false,
		additionalExtensionPaths: [broker.extensionPath, moderatorWidgetExtension],
	});
	await mkdir(host.services.agentDir, { recursive: true });
	const childSettingsPath = join(host.services.agentDir, "settings.json");
	await writeFile(childSettingsPath, `${JSON.stringify({ theme: "dark" })}\n`);
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	let moderatorTurns = 0;
	// The replacement's turns, pinned later from durable transcript evidence.
	const replacementSettlementReply = "Linked replacement Moderator process settled.";
	broker.setResponses(Array.from({ length: 6 }, () => (context) => {
		if (getCurrentTools(context.messages).some(({ name }) => name === "moderator_control")) {
			moderatorTurns += 1;
			if (moderatorTurns === 1) {
				return fauxAssistantMessage(
					fauxToolCall("moderator_control", {
						operation: "resolve",
						summary: "The replacement inspected the exact failed process Run.",
						rationale: "Exercise the Moderator child-to-Owner process proxy.",
					}, { id: "proxied-moderator-control" }),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage(replacementSettlementReply);
		}
		return fauxAssistantMessage("Settled without answering the Creation Request.");
	}));
	let moderatorRunStarts = 0;
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		incidentBoundaryHooks: {
			// A handling Moderator's provider error now suspends it, so the bounded
			// attempt needs a committed Run Failure: fail the first attempt's Run start.
			beforeModeratorRunStart() {
				return ++moderatorRunStarts === 1 ? "confirmed_failure" : undefined;
			},
		},
	});
	let replacementPid: number | undefined;
	try {
		const owner = coordinator.forAgent(identity.agentId);
		const input = {
			title: "Fixture request",
			request: "Fail this answer-obligated process Run so Moderator retry is required.",
			config: {
				model: { id: `${broker.providerId}/${broker.modelId}`, thinking: "inherit" as const },
			},
		};
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_spawn", input, { id: "spawn-moderated-process-failure" }),
				{ stopReason: "toolUse" },
			),
		);
		const spawned = await owner.spawn("spawn-moderated-process-failure", input);
		assert.equal(spawned.spawnStatus, "created");
		assert.equal("messageStatus" in spawned && spawned.messageStatus, "sent");

		await waitFor(() => moderatorStatuses(owner, identity.agentId).length === 2);
		const moderators = moderatorStatuses(owner, identity.agentId);
		assert.equal(new Set(moderators.map(({ agentId }) => agentId)).size, 2);
		const attempts = moderators.map((status) => {
			assert.ok(status.primaryEvidence.transcriptPath);
			const transcript = SessionManager.open(status.primaryEvidence.transcriptPath);
			const entries = transcript.getEntries();
			assert.equal(
				entries.some((entry) => entry.type === "custom"),
				false,
			);
			const inputEntry = entries.find(
				(entry) => entry.type === "custom_message" &&
					entry.customType === "agent-coordination.moderator-input",
			);
			assert.ok(inputEntry?.type === "custom_message" && typeof inputEntry.content === "string");
			return {
				status,
				input: JSON.parse(inputEntry.content) as {
					previousAttempt?: { agentId: string; entryId: string };
				},
			};
		});
		const replacement = attempts.find(({ input }) => input.previousAttempt !== undefined);
		assert.ok(replacement?.input.previousAttempt);
		assert.notEqual(replacement.input.previousAttempt.agentId, replacement.status.agentId);
		const failedAttempt = attempts.find(
			({ status }) => status.agentId === replacement.input.previousAttempt?.agentId,
		);
		assert.ok(failedAttempt);
		const failedAttemptTranscriptPath = failedAttempt.status.primaryEvidence.transcriptPath;
		assert.ok(failedAttemptTranscriptPath);
		const replacementTranscriptPath = replacement.status.primaryEvidence.transcriptPath;
		assert.ok(replacementTranscriptPath);
		await waitFor(() => {
			const entries = SessionManager.open(replacementTranscriptPath).getEntries();
			return entries.some(
				(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
					entry.message.toolCallId === "proxied-moderator-control",
			);
		});
		const moderatorControlResult = SessionManager.open(replacementTranscriptPath)
			.getEntries()
			.find(
				(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
					entry.message.toolCallId === "proxied-moderator-control",
			);
		assert.ok(
			moderatorControlResult?.type === "message" &&
			moderatorControlResult.message.role === "toolResult",
		);
		assert.equal(
			(moderatorControlResult.message.details as { disposition: string }).disposition,
			"blocked",
		);
		// The replacement's second turn only follows its committed proxied tool result.
		await waitFor(() => moderatorAssistantTurns(replacementTranscriptPath).some(
			(turn) => turn.texts.includes(replacementSettlementReply),
		));
		await waitFor(() => {
			const run = owner.status(replacement.status.agentId).run;
			return run.phase === "live" && run.work === "settled";
		});

		const view = await owner.openAgentView(replacement.status.agentId);
		assert.ok(view);
		// A durable view is a screen consumer: reading this child's parsed presentation
		// requires the same observation the view surface holds while it is mounted.
		await view.projection().screenView.begin();
		await waitFor(() => view.projection().presentation.render(80)
			.map(stripTerminalSequences)
			.join("\n")
			.includes("PROCESS_RUNTIME_CHILD_WIDGET"));
		const frame = view.projection().presentation.render(80)
			.map(stripTerminalSequences)
			.join("\n");
		const pidMatch = frame.match(/PID=(\d+)/);
		assert.ok(pidMatch);
		replacementPid = Number(pidMatch[1]);
		assert.ok(Number.isSafeInteger(replacementPid) && replacementPid > 1);
		assert.notEqual(replacementPid, process.pid);
		const childAgentDirMatch = frame.match(/AGENT_DIR=(.+)/);
		assert.ok(childAgentDirMatch);
		assert.equal(childAgentDirMatch[1]!.trim(), host.services.agentDir);
		assert.equal(
			(globalThis as Record<PropertyKey, unknown>)[THEME_KEY],
			ownerTheme,
			"child-local theme changes must not mutate Owner process globals",
		);
		assert.equal(
			(JSON.parse(await readFile(childSettingsPath, "utf8")) as { theme?: string }).theme,
			"light",
			"child Pi settings must use the same Agent directory as its Owner Runtime",
		);
		await view.close();
		// Durable transcripts pin the replacement's turns instead of a global
		// provider-request count: the proxied `moderator_control` resolve is blocked, so
		// coordination legitimately delivers a later obligation reminder whose extra turn
		// can land at any moment and would race any exact count.
		assert.deepEqual(
			moderatorAssistantTurns(failedAttemptTranscriptPath),
			[],
			"an attempt that fails at its Run start records no assistant turn",
		);
		const [replacementToolTurn, replacementSettlementTurn] =
			moderatorAssistantTurns(replacementTranscriptPath);
		assert.deepEqual(replacementToolTurn, {
			texts: [],
			toolCallIds: ["proxied-moderator-control"],
		});
		assert.deepEqual(replacementSettlementTurn, {
			texts: [replacementSettlementReply],
			toolCallIds: [],
		});
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
		await broker.close();
	}
	assert.ok(replacementPid);
	assert.throws(() => process.kill(replacementPid, 0), hasCode("ESRCH"));
	await waitFor(async () => (await runtimeArtifacts(identity.workflowId)).length === 0);
});

async function runtimeArtifacts(workflowId: string): Promise<string[]> {
	const prefix = `pi-ac-${createHash("sha256").update(workflowId).digest("hex").slice(0, 10)}-`;
	return (await readdir(tmpdir())).filter((name) => name.startsWith(prefix));
}

function moderatorStatuses(
	owner: ReturnType<WorkflowCoordinator["forAgent"]>,
	ownerAgentId: string,
) {
	const roster = owner.selectionRoster();
	return [...roster.live, ...roster.dormant].filter(
		(status) => status.directSpawnerAgentId === null && status.agentId !== ownerAgentId,
	);
}

type ModeratorAssistantTurn = Readonly<{
	texts: readonly string[];
	toolCallIds: readonly string[];
}>;

/** Assistant turns a Moderator transcript durably recorded, in order. */
function moderatorAssistantTurns(transcriptPath: string): readonly ModeratorAssistantTurn[] {
	return SessionManager.open(transcriptPath).getEntries().flatMap((entry) =>
		entry.type === "message" && entry.message.role === "assistant"
			? [{
				texts: entry.message.content.flatMap((part) =>
					part.type === "text" ? [part.text] : []),
				toolCallIds: entry.message.content.flatMap((part) =>
					part.type === "toolCall" ? [part.id] : []),
			}]
			: [],
	);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for process child evidence");
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error &&
		(error as NodeJS.ErrnoException).code === code;
}

test("prefetched selections stay fixed until reload; captured presets outlive that load", { timeout: 5_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-template-load-"));
	const templatePath = join(root, "implementator.md");
	await writeFile(templatePath, "---\nname: implementator\nmodels:\n  - id: unavailable/model\n    thinking: low\n  - id: coordination-test/deterministic-owner\n    thinking: high\nexcludeTools: read\n---\nOriginal rules.");
	const host = await createUnboundTestOwnerHost(t, () => undefined, { persistent: true, processVisibleModel: true });
	await bindTestOwnerHost(host, "tui");
	const ownerIdentity = adoptOrValidateOwnerIdentity(host.runtime);
	const owner: AgentRecord = {
		identity: ownerIdentity, host: AgentRuntimeSupervisor.bindOwner(host.runtime),
		transcript: transcriptFromSessionManager(host.session.sessionManager), children: [],
	};
	const factory = new ProcessChildSessionFactory({
		ownerRuntime: host.runtime, ownerIdentity, entryModulePath: "<inline:pi-durable-subagents>",
		templateRoots: () => [{ scope: "test", path: root }], resolveAgent: () => owner,
		ownerRequestHandlers() { throw new Error("Preparation only"); },
	});
	try {
		const snapshot = await factory.captureTemplateSnapshotFor(owner);
		assert.deepEqual(snapshot.templates.map(({ name }) => name), ["implementator"]);
		await rename(templatePath, join(root, "implementor.md"));
		await writeFile(join(root, "implementor.md"), "---\nname: implementor\nexcludeTools: bash\n---\nNew rules.");
		const input = { title: "Fixture request", request: "Implement", template: "implementator" };
		const first = await factory.prepareOrdinaryRun({ agentId: "first", parent: owner, spawnInput: input });
		assert.equal(first.configuration.systemPrompt?.body, "Original rules.");
		assert.deepEqual(first.creationPreset?.models, [
			{ model: { provider: "unavailable", modelId: "model" }, thinking: "low" },
			{ model: { provider: "coordination-test", modelId: "deterministic-owner" }, thinking: "high" },
		]);
		assert.deepEqual(first.configuration.excludeTools, ["read"]);
		await assert.rejects(factory.prepareOrdinaryRun({
			agentId: "too-early", parent: owner, spawnInput: { title: "Fixture request", request: "Implement", template: "implementor" },
		}), /implementor is missing/);
		const refreshed = await factory.captureTemplateSnapshotFor(owner);
		assert.deepEqual(refreshed.templates.map(({ name }) => name), ["implementor"]);
		const next = await factory.prepareOrdinaryRun({
			agentId: "next", parent: owner, spawnInput: { title: "Fixture request", request: "Implement", template: "implementor" },
		});
		assert.equal(next.configuration.systemPrompt?.body, "New rules.");
		const restarted = await factory.prepareOrdinaryRun({
			agentId: "first", parent: owner, spawnInput: input, creationPreset: first.creationPreset,
		});
		assert.equal(restarted.configuration.systemPrompt?.body, "Original rules.");
		assert.deepEqual(restarted.configuration.excludeTools, ["read"]);
		await assert.rejects(factory.prepareOrdinaryRun({
			agentId: "missing", parent: owner, spawnInput: input,
		}), /implementator is missing/);
	} finally {
		await host.runtime.dispose();
	}
});

test("Moderator creation captures present and absent presets independently of later loads", { timeout: 5_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-moderator-preset-"));
	const host = await createUnboundTestOwnerHost(t, () => undefined, { persistent: true, processVisibleModel: true });
	await bindTestOwnerHost(host, "tui");
	const ownerIdentity = adoptOrValidateOwnerIdentity(host.runtime);
	const owner: AgentRecord = {
		identity: ownerIdentity, host: AgentRuntimeSupervisor.bindOwner(host.runtime),
		transcript: transcriptFromSessionManager(host.session.sessionManager), children: [],
	};
	const factory = new ProcessChildSessionFactory({
		ownerRuntime: host.runtime, ownerIdentity, entryModulePath: "<inline:pi-durable-subagents>",
		templateRoots: () => [{ scope: "test", path: root }], resolveAgent: () => owner,
		ownerRequestHandlers() { throw new Error("Preparation only"); },
	});
	try {
		await factory.captureTemplateSnapshotFor(owner);
		const absent = await factory.prepareModeratorRun({ agentId: "absent" });
		assert.equal(absent.creationPreset, null);
		await writeFile(join(root, "moderator.md"), "---\nname: moderator\nmodels:\n  - id: coordination-test/deterministic-owner\n    thinking: high\n---\nCaptured Moderator.");
		await factory.captureTemplateSnapshotFor(owner);
		const present = await factory.prepareModeratorRun({ agentId: "present" });
		assert.equal(present.configuration.thinking, "high");
		await writeFile(join(root, "moderator.md"), "---\nname: moderator\n---\nReplacement Moderator.");
		await factory.captureTemplateSnapshotFor(owner);
		const restarted = await factory.prepareModeratorRun({ agentId: "present", creationPreset: present.creationPreset });
		assert.equal(restarted.configuration.systemPrompt?.body, "Captured Moderator.");
		assert.equal(restarted.configuration.thinking, "high");
		const restartedAbsent = await factory.prepareModeratorRun({ agentId: "absent", creationPreset: absent.creationPreset });
		assert.equal(restartedAbsent.configuration.systemPrompt, undefined);
		assert.equal(restartedAbsent.configuration.thinking, undefined);
	} finally {
		await host.runtime.dispose();
	}
});
