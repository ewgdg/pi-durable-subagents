import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { SessionManager, VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { executeRegisteredTool } from "./support/agent-session.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";
import {
	createProcessModelBroker,
	type ProcessModelBroker,
} from "./support/process-model-broker.ts";

// Black-box tests for issue #220: spawn configuration only supplies the initial
// model selection; a fresh Runtime keeps what the Agent's own session last recorded.

const TEST_TIMEOUT_MS = 90_000;
const MAX_CONDITION_POLL_ATTEMPTS = 10_000;

// Three process-visible providers. The Owner runs on OWNER; children start on
// INITIAL through their Spawn config; MANUAL is the target of a manual switch.
const OWNER = { provider: "coordination-test", modelId: "deterministic-owner" };
const INITIAL = { provider: "sticky-initial", modelId: "initial-model" };
const MANUAL = { provider: "sticky-manual", modelId: "manual-model" };
type ModelRef = { provider: string; modelId: string };
const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

const SWITCH_TOOL = "switch_selection";

type ObservedRequest = { model: string; reasoning: string | undefined; input: string };

type Fixture = {
	brokers: { owner: ProcessModelBroker; initial: ProcessModelBroker; manual: ProcessModelBroker };
	switchExtensionPath: string;
	startLogPath: string;
	requests: ObservedRequest[];
};

/**
 * Every broker answers by script: `SWITCH[steps]` in the current input makes the
 * Agent call the test switch tool, which performs a real Pi model/thinking change
 * (as `/model` or an extension would); everything else gets a plain answer.
 */
function scriptedResponse(
	requests: ObservedRequest[],
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	model: Model<string>,
): AssistantMessage {
	const lastAssistant = context.messages.findLastIndex((message) => message.role === "assistant");
	const input = JSON.stringify(context.messages.slice(lastAssistant + 1));
	requests.push({ model: `${model.provider}/${model.id}`, reasoning: options?.reasoning, input });
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") return fauxAssistantMessage(`Done after ${last.toolName}.`);
	const switchSteps = /SWITCH\[([^\]]*)\]/.exec(input)?.[1];
	if (switchSteps !== undefined) {
		return fauxAssistantMessage(
			fauxToolCall(SWITCH_TOOL, { steps: switchSteps }, { id: `switch-${requests.length}` }),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage("Ack.");
}

// Also logs each Runtime start per session, so a test can prove a Runtime is fresh.
const switchExtensionSource = (startLogPath: string) => `
import { appendFileSync } from "node:fs";
export default function stickySelectionSwitch(pi) {
  pi.on("session_start", (_event, ctx) => {
    appendFileSync(${JSON.stringify(startLogPath)}, ctx.sessionManager.getSessionId() + "\\n");
  });
  pi.registerTool({
    name: ${JSON.stringify(SWITCH_TOOL)},
    label: "Switch selection",
    description: "Test-only manual model and thinking change.",
    parameters: {
      type: "object",
      properties: { steps: { type: "string" } },
      required: ["steps"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      for (const step of params.steps.split(";")) {
        const [name, value] = step.split("=");
        if (name === "model") {
          const slash = value.indexOf("/");
          const model = ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1));
          if (!model) throw new Error("Unknown model " + value);
          if (!(await pi.setModel(model))) throw new Error("Cannot select " + value);
        } else if (name === "thinking") {
          pi.setThinkingLevel(value);
        } else {
          throw new Error("Unknown step " + step);
        }
      }
      return { content: [{ type: "text", text: "Switched." }], details: {} };
    },
  });
}
`;

async function createFixture(t: TestContext): Promise<Fixture> {
	const requests: ObservedRequest[] = [];
	const responseOverride = (context: TranscriptContext, options: SimpleStreamOptions | undefined, model: Model<string>) =>
		scriptedResponse(requests, context, options, model);
	const broker = async (model: ModelRef) => {
		const created = await createProcessModelBroker({
			providerId: model.provider,
			modelId: model.modelId,
			modelName: model.modelId,
			responseOverride,
		});
		t.after(() => created.close());
		return created;
	};
	const directory = await mkdtemp(join(tmpdir(), "sticky-selection-switch-"));
	const switchExtensionPath = join(directory, "sticky-selection-switch.mjs");
	const startLogPath = join(directory, "runtime-starts.log");
	await writeFile(startLogPath, "", "utf8");
	await writeFile(switchExtensionPath, switchExtensionSource(startLogPath), "utf8");
	return {
		brokers: { owner: await broker(OWNER), initial: await broker(INITIAL), manual: await broker(MANUAL) },
		switchExtensionPath,
		startLogPath,
		requests,
	};
}

async function openOwner(
	t: TestContext,
	fixture: Fixture,
	options: {
		previous?: TestOwnerHost;
		sessionFile?: string;
		withManualProvider?: boolean;
		beforeBind?: (host: TestOwnerHost) => Promise<void>;
	} = {},
): Promise<TestOwnerHost> {
	const { brokers } = fixture;
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: false,
		...(options.previous ? {
			cwd: options.previous.cwd,
			agentDir: options.previous.services.agentDir,
			sessionFile: options.sessionFile,
		} : {}),
		// File-backed Owner extensions are inherited by every child process.
		additionalExtensionPaths: [
			brokers.owner.extensionPath,
			brokers.initial.extensionPath,
			...(options.withManualProvider ?? true ? [brokers.manual.extensionPath] : []),
			fixture.switchExtensionPath,
		],
	});
	await options.beforeBind?.(host);
	await bindTestOwnerHost(host, "tui");
	return host;
}

async function writePolicy(host: TestOwnerHost, policy: unknown): Promise<void> {
	await mkdir(join(host.services.agentDir, "config"), { recursive: true });
	await writeFile(
		join(host.services.agentDir, "config", "pi-durable-subagents.json"),
		JSON.stringify(policy),
		"utf8",
	);
}

async function executeTool(
	host: TestOwnerHost,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	return (await executeRegisteredTool(host.runtime.session, toolName, toolCallId, input)).details;
}

type SpawnedChild = { agentId: string; sessionFile: string };

/** Spawns a child whose Creation Request may perform a manual switch, and waits for it to settle that work. */
async function spawnChild(
	host: TestOwnerHost,
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<SpawnedChild> {
	const receipt = await executeTool(host, "agent_spawn", toolCallId, {
		title: "Fixture request",
		request: `Work for ${toolCallId}.`,
		...input,
	}) as { spawnStatus: string; agentId?: string };
	assert.equal(receipt.spawnStatus, "created", JSON.stringify(receipt));
	const agentId = receipt.agentId!;
	const sessionFile = await waitForSessionFile(workflowSessionDirectory(host), agentId);
	const switching = String(input.request ?? "").includes("SWITCH[");
	await waitForEntry(sessionFile, (entry) =>
		entry.type === "message" && entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.type === "text" &&
			(switching ? part.text === `Done after ${SWITCH_TOOL}.` : part.text === "Ack.")));
	return { agentId, sessionFile };
}

async function disposeOwner(host: TestOwnerHost): Promise<string> {
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();
	return ownerSessionFile;
}

/** Wakes a dormant Agent into a fresh Runtime and returns the first model request that Runtime makes. */
async function wake(fixture: Fixture, host: TestOwnerHost, child: SpawnedChild): Promise<ObservedRequest> {
	const marker = `WAKE-${child.agentId}`;
	await executeTool(host, "agent_message", `wake-${child.agentId}`, {
		operation: "send",
		targetAgent: child.agentId,
		content: marker,
	});
	let request: ObservedRequest | undefined;
	await waitForCondition(() => {
		request = fixture.requests.find(({ input }) => input.includes(marker));
		return request !== undefined;
	}, `no model request carried ${marker}`);
	// Let the woken Run commit its answer before the session is inspected.
	await waitForEntry(child.sessionFile, (entry, index, entries) =>
		entry.type === "message" && entry.message.role === "assistant" &&
		entries.slice(0, index).some((earlier) => JSON.stringify(earlier).includes(marker)));
	return request!;
}

function recordedSelection(sessionFile: string): { model?: string; thinking?: string } {
	const branch = SessionManager.open(sessionFile).getBranch();
	const model = branch.findLast((entry) => entry.type === "model_change");
	const thinking = branch.findLast((entry) => entry.type === "thinking_level_change");
	return {
		...(model?.type === "model_change" ? { model: `${model.provider}/${model.modelId}` } : {}),
		...(thinking?.type === "thinking_level_change" ? { thinking: thinking.thinkingLevel } : {}),
	};
}

function modelWarnings(host: TestOwnerHost): string[] {
	return host.ui.notifications
		.filter(({ type }) => type === "warning")
		.map(({ message }) => message);
}

test("a new child records its initial model and thinking in its own session", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture, {
		// Templates are discovered when the Owner binds.
		async beforeBind(unbound) {
			const templateDirectory = join(unbound.services.agentDir, "agents");
			await mkdir(templateDirectory, { recursive: true });
			await writeFile(
				join(templateDirectory, "candidate.md"),
				`---\nname: candidate-agent\nuseWhen: Use for candidate work.\nmodels:\n  - id: missing/model\n    thinking: low\n  - id: ${key(INITIAL)}\n    thinking: medium\n---\n`,
			);
		},
	});
	host.session.setThinkingLevel("minimal");
	const cases = [
		{ name: "Spawn config", input: { config: { model: { id: key(INITIAL), thinking: "high" } } }, expected: { model: key(INITIAL), thinking: "high" } },
		{ name: "Template candidate", input: { template: "candidate-agent" }, expected: { model: key(INITIAL), thinking: "medium" } },
		{ name: "parent inheritance", input: {}, expected: { model: key(OWNER), thinking: "minimal" } },
	];
	for (const [index, { name, input, expected }] of cases.entries()) {
		const child = await spawnChild(host, `spawn-initial-${index}`, input);
		assert.deepEqual(recordedSelection(child.sessionFile), expected, name);
	}
	await host.runtime.dispose();
});

test("a fresh Runtime launches with the manually changed selection, not the spawn config", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture);
	const initialModel = { model: { id: key(INITIAL), thinking: "low" } };
	const cases = [
		{ name: "model and thinking", steps: `model=${key(MANUAL)};thinking=high`, expected: { model: key(MANUAL), reasoning: "high" } },
		{ name: "thinking only", steps: "thinking=medium", expected: { model: key(INITIAL), reasoning: "medium" } },
		{ name: "model only", steps: `model=${key(MANUAL)}`, expected: { model: key(MANUAL), reasoning: "low" } },
	];
	const children: SpawnedChild[] = [];
	for (const [index, { steps }] of cases.entries()) {
		children.push(await spawnChild(host, `spawn-sticky-${index}`, {
			request: `SWITCH[${steps}]`,
			config: initialModel,
		}));
	}
	const reopened = await openOwner(t, fixture, { previous: host, sessionFile: await disposeOwner(host) });
	for (const [index, { name, expected }] of cases.entries()) {
		const child = children[index]!;
		const request = await wake(fixture, reopened, child);
		assert.deepEqual({ model: request.model, reasoning: request.reasoning }, expected, name);
		assert.deepEqual(
			recordedSelection(child.sessionFile),
			{ model: expected.model, thinking: expected.reasoning },
			`${name}: the session still records the manual selection`,
		);
	}
	assert.deepEqual(modelWarnings(reopened), [], "a usable recorded selection is not a warning");
	await reopened.runtime.dispose();
});

test("an in-host successor Runtime keeps the manually changed selection", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture);
	const child = await spawnChild(host, "spawn-successor", {
		request: `SWITCH[model=${key(MANUAL)};thinking=high]`,
		config: { model: { id: key(INITIAL), thinking: "low" } },
	});
	await waitForCondition(async () => {
		const observe = host.session.getToolDefinition("agent_observe");
		assert.ok(observe);
		const status = (await observe.execute(
			"observe-successor",
			{ operation: "status", agentId: child.agentId },
			undefined,
			undefined,
			host.session.extensionRunner.createToolContext("observe-successor", undefined),
		)).details as { run: { phase: string; work?: string } };
		return status.run.phase === "live" && status.run.work === "settled";
	}, "child Run did not settle");
	await executeTool(host, "agent_control", "abort-successor", { operation: "abort", agentId: child.agentId });
	const request = await wake(fixture, host, child);
	assert.deepEqual({ model: request.model, reasoning: request.reasoning }, { model: key(MANUAL), reasoning: "high" });
	assert.equal(await runtimeStarts(fixture, child.agentId), 2, "the woken Run started a fresh Runtime");
	await host.runtime.dispose();
});

test("an unusable recorded model falls back to the initial values, records them, and warns the Owner", { timeout: TEST_TIMEOUT_MS * 2 }, async (t) => {
	const cases = [
		{
			name: "excluded by policy, or a Virtual Model no longer defined",
			policyBefore: { virtualModels: { fast: [{ id: key(OWNER), thinking: "high" }] } },
			policyAfter: { excludedModels: [`${MANUAL.provider}/*`] },
			withManualProvider: true,
			switches: [
				{ steps: `model=${key(MANUAL)};thinking=high`, recorded: key(MANUAL) },
				{ steps: "model=virtual/fast;thinking=high", recorded: "virtual/fast" },
			],
		},
		{
			name: "unavailable, or a Virtual Model with no usable entry",
			policyBefore: { virtualModels: { slow: [{ id: key(MANUAL), thinking: "high" }] } },
			policyAfter: { virtualModels: { slow: [{ id: key(MANUAL), thinking: "high" }] } },
			withManualProvider: false,
			switches: [
				{ steps: `model=${key(MANUAL)};thinking=high`, recorded: key(MANUAL) },
				{ steps: "model=virtual/slow;thinking=high", recorded: "virtual/slow" },
			],
		},
	];
	for (const scenario of cases) {
		const fixture = await createFixture(t);
		const host = await openOwner(t, fixture);
		await writePolicy(host, scenario.policyBefore);
		const children: SpawnedChild[] = [];
		for (const [index, { steps, recorded }] of scenario.switches.entries()) {
			const child = await spawnChild(host, `spawn-fallback-${index}`, {
				request: `SWITCH[${steps}]`,
				config: { model: { id: key(INITIAL), thinking: "low" } },
			});
			assert.equal(recordedSelection(child.sessionFile).model, recorded, `${scenario.name}: manual switch recorded`);
			children.push(child);
		}
		const sessionFile = await disposeOwner(host);
		await writePolicy(host, scenario.policyAfter);
		const reopened = await openOwner(t, fixture, {
			previous: host, sessionFile, withManualProvider: scenario.withManualProvider,
		});
		for (const [index, { recorded }] of scenario.switches.entries()) {
			const child = children[index]!;
			const label = `${scenario.name}: ${recorded}`;
			const request = await wake(fixture, reopened, child);
			assert.deepEqual({ model: request.model, reasoning: request.reasoning }, { model: key(INITIAL), reasoning: "low" }, label);
			assert.deepEqual(recordedSelection(child.sessionFile), { model: key(INITIAL), thinking: "low" }, `${label}: fallback recorded`);
			assert.ok(
				modelWarnings(reopened).some((message) => message.includes(recorded)),
				`${label}: expected an Owner warning naming the unusable model, got ${JSON.stringify(reopened.ui.notifications)}`,
			);
		}
		await reopened.runtime.dispose();
	}
});

test("an Agent whose session records no model launches with its initial values and records them", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture);
	// The live switch leaves the latest assistant messages on MANUAL, so neither the
	// Owner's model nor the last answering model can pass for the initial values.
	const child = await spawnChild(host, "spawn-unrecorded", {
		request: `SWITCH[model=${key(MANUAL)};thinking=high]`,
		config: { model: { id: key(INITIAL), thinking: "low" } },
	});
	const sessionFile = await disposeOwner(host);
	await removeRecordedSelection(child.sessionFile);
	assert.deepEqual(recordedSelection(child.sessionFile), {});

	const reopened = await openOwner(t, fixture, { previous: host, sessionFile });
	const request = await wake(fixture, reopened, child);
	assert.deepEqual({ model: request.model, reasoning: request.reasoning }, { model: key(INITIAL), reasoning: "low" });
	assert.deepEqual(recordedSelection(child.sessionFile), { model: key(INITIAL), thinking: "low" });
	assert.deepEqual(modelWarnings(reopened), [], "a missing record is not a warning");
	await reopened.runtime.dispose();
});

test("a Virtual Model's preset thinking survives a fresh Runtime until the Agent switches to explicit", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture);
	const policy = (level: string) => ({ virtualModels: { fast: [{ id: key(INITIAL), thinking: level }] } });
	await writePolicy(host, policy("low"));
	const cases = [
		// Preset routes at the serving entry's current level, which changes below.
		{ name: "preset stays preset", request: "Preset work.", expected: "high" },
		{ name: "manual thinking change is explicit", request: "SWITCH[thinking=minimal]", expected: "minimal" },
		// Leaving the Virtual Model and selecting it again through /model is explicit,
		// so the level the child held (the preset start level, low) stays selected.
		{ name: "reselecting through /model is explicit", request: `SWITCH[model=${key(OWNER)};model=virtual/fast]`, expected: "low" },
	];
	const children: SpawnedChild[] = [];
	for (const [index, { request }] of cases.entries()) {
		const child = await spawnChild(host, `spawn-preset-${index}`, {
			request,
			config: { model: { id: "virtual/fast", thinking: "preset" } },
		});
		children.push(child);
	}
	assert.ok(
		SessionManager.open(children[0]!.sessionFile).getBranch()
			.some((entry) => entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY),
		"a preset child records its thinking mode as Virtual Model router state",
	);
	const sessionFile = await disposeOwner(host);
	await writePolicy(host, policy("high"));
	const reopened = await openOwner(t, fixture, { previous: host, sessionFile });
	for (const [index, { name, expected }] of cases.entries()) {
		const request = await wake(fixture, reopened, children[index]!);
		assert.deepEqual({ model: request.model, reasoning: request.reasoning }, { model: key(INITIAL), reasoning: expected }, name);
		assert.equal(recordedSelection(children[index]!.sessionFile).model, "virtual/fast", name);
	}
	await reopened.runtime.dispose();
});

test("a child of a dormant parent inherits the parent's recorded selection, not its spawn config", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture);
	const parent = await spawnChild(host, "spawn-dormant-parent", {
		request: `SWITCH[model=${key(MANUAL)};thinking=high]`,
		config: { model: { id: key(INITIAL), thinking: "low" } },
	});
	const ownerSessionFile = await disposeOwner(host);

	// A pre-existing grandchild with no Template and no recorded selection: its
	// initial values come from its now-dormant parent.
	const parentTranscript = SessionManager.open(parent.sessionFile);
	const spawnEntryId = parentTranscript.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_spawn", {
			title: "Fixture request",
			request: "Inherit the parent's current selection.",
			label: "inheriting-grandchild",
		}, { id: "spawn-inheriting-grandchild" }),
		{ stopReason: "toolUse" },
	));
	const grandchildTranscript = SessionManager.create(host.cwd, workflowSessionDirectory(host, ownerSessionFile));
	const grandchildAgentId = grandchildTranscript.getSessionId();
	grandchildTranscript.appendCustomEntry("agent-coordination.identity", {
		agentId: grandchildAgentId,
		workflowId: SessionManager.open(ownerSessionFile).getSessionId(),
		directSpawnerAgentId: parent.agentId,
		creationPreset: null,
		spawnSource: { agentId: parent.agentId, entryId: spawnEntryId, toolCallId: "spawn-inheriting-grandchild" },
		metadata: { label: "inheriting-grandchild" },
	});
	grandchildTranscript.appendMessage(fauxAssistantMessage("Persist the grandchild."));
	const grandchild = { agentId: grandchildAgentId, sessionFile: grandchildTranscript.getSessionFile()! };

	const reopened = await openOwner(t, fixture, { previous: host, sessionFile: ownerSessionFile });
	const request = await wake(fixture, reopened, grandchild);
	assert.deepEqual({ model: request.model, reasoning: request.reasoning }, { model: key(MANUAL), reasoning: "high" });
	assert.deepEqual(recordedSelection(grandchild.sessionFile), { model: key(MANUAL), thinking: "high" });
	await reopened.runtime.dispose();
});

async function runtimeStarts(fixture: Fixture, agentId: string): Promise<number> {
	return (await readFile(fixture.startLogPath, "utf8")).split("\n").filter((line) => line === agentId).length;
}

/** Rewrites a session as one created before Recorded Model Selection existed. */
async function removeRecordedSelection(sessionFile: string): Promise<void> {
	const lines = (await readFile(sessionFile, "utf8")).split("\n").filter((line) => line.length > 0);
	const isSelection = (entry: { type?: string; customType?: string }) =>
		entry.type === "model_change" || entry.type === "thinking_level_change" ||
		(entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY);
	const parsed = lines.map((line) => JSON.parse(line) as { type?: string; customType?: string; id?: string; parentId?: string | null });
	const removedParents = new Map<string, string | null>();
	for (const entry of parsed) {
		if (entry.id !== undefined && isSelection(entry)) removedParents.set(entry.id, entry.parentId ?? null);
	}
	const survivingParent = (parentId: string | null | undefined): string | null | undefined => {
		while (parentId !== undefined && parentId !== null && removedParents.has(parentId)) parentId = removedParents.get(parentId);
		return parentId;
	};
	const rewritten = parsed
		.filter((entry) => !isSelection(entry))
		.map((entry) => "parentId" in entry ? { ...entry, parentId: survivingParent(entry.parentId) } : entry);
	await writeFile(sessionFile, `${rewritten.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function workflowSessionDirectory(host: TestOwnerHost, ownerSessionFile?: string): string {
	if (ownerSessionFile === undefined) {
		return join(host.session.sessionManager.getSessionDir(), "pi-durable-subagents", host.session.sessionId);
	}
	const owner = SessionManager.open(ownerSessionFile);
	return join(owner.getSessionDir(), "pi-durable-subagents", owner.getSessionId());
}

async function waitForSessionFile(directory: string, agentId: string): Promise<string> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		for (const filename of await readdir(directory).catch(() => [] as string[])) {
			if (!filename.endsWith(".jsonl")) continue;
			const path = join(directory, filename);
			if (SessionManager.open(path).getSessionId() === agentId) return path;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Expected persisted session ${agentId}`);
}

type SessionEntry = ReturnType<SessionManager["getEntries"]>[number];

async function waitForEntry(
	sessionFile: string,
	predicate: (entry: SessionEntry, index: number, entries: SessionEntry[]) => boolean,
): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (SessionManager.open(sessionFile).getEntries().some(predicate)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Expected transcript evidence did not commit in ${sessionFile}`);
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(message);
}
