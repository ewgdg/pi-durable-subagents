import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
	initTheme,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
	coordinationToolActivation,
	registerCoordinationTools,
	type CoordinationToolHandlers,
	type SpawnGuidanceRefresh,
} from "../src/tools/coordination-tools.ts";
import type { AgentTemplateCatalogueSnapshot } from "../src/templates/agent-templates.ts";
import { createTestOwnerHost, type TestCleanupRegistrar } from "./support/pi-host.ts";

const ownerTools = [
	"agent_control",
	"agent_message",
	"agent_observe",
	"agent_spawn",
	"agent_wait",
	"workflow_resume",
];
const ordinaryTools = [
	"agent_control",
	"agent_message",
	"agent_observe",
	"agent_spawn",
	"agent_wait",
	"ask_user",
];
const moderatorTools = [
	"agent_control",
	"agent_message",
	"agent_observe",
	"agent_wait",
	"ask_user",
	"moderator_control",
	"report_to_user",
];
const withoutAskUser = (tools: readonly string[]) => tools.filter((name) => name !== "ask_user");

test("activation gives each role exactly its coordination tools, withholding Ask User headless", () => {
	const table = [
		["owner", "terminal", ownerTools, ownerTools],
		["owner", "headless", ownerTools, ownerTools],
		["ordinary", "terminal", ordinaryTools, ordinaryTools],
		["ordinary", "headless", ordinaryTools, withoutAskUser(ordinaryTools)],
		["moderator", "terminal", moderatorTools, moderatorTools],
		["moderator", "headless", moderatorTools, withoutAskUser(moderatorTools)],
	] as const;
	for (const [role, interaction, roleTools, activeTools] of table) {
		const activation = coordinationToolActivation(role, interaction);
		assert.deepEqual([...activation.roleTools].sort(), roleTools, `${role} ${interaction} role tools`);
		assert.deepEqual([...activation.activeTools].sort(), activeTools, `${role} ${interaction} active tools`);
	}
});

const roles = ["owner", "ordinary", "moderator"] as const;

// Contract and rendering checks register real tools, but no handler may run.
const unavailableHandlers = new Proxy({}, {
	get: () => () => {
		throw new Error("Catalogue contract tests do not execute coordination behavior");
	},
}) as CoordinationToolHandlers<"owner"> & CoordinationToolHandlers<"ordinary"> & CoordinationToolHandlers<"moderator">;

const taggedTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("every role registers its catalogue tools model-only, sequential, closed, and rendered", async (t) => {
	for (const role of roles) {
		await t.test(role, async (t) => {
			const host = await createTestOwnerHost(t, (pi) => {
				registerCoordinationTools(pi, role, unavailableHandlers);
			});
			const { roleTools, activeTools } = coordinationToolActivation(role, "terminal");
			assert.deepEqual(host.session.getActiveToolNames().sort(), [...activeTools].sort());
			const callable = host.session.getCallableToolNames();
			for (const toolName of roleTools) {
				const tool = host.session.getToolDefinition(toolName);
				assert.ok(tool, toolName);
				assert.equal(tool.exposure, "model-only", toolName);
				assert.equal(callable.includes(toolName), false, `${toolName} must not be callable from codemode`);
				assert.equal(tool.executionMode, "sequential", toolName);
				assertClosedTypeBoxObjects(tool.parameters, toolName);
				assert.equal(typeof tool.renderCall, "function", toolName);
				assert.equal(typeof tool.renderResult, "function", toolName);
			}
			await host.runtime.dispose();
		});
	}
});

test("every coordination tool renders a final native error as its error text", async (t) => {
	initTheme("dark");
	const shortError = "invalid_input: requested operation rejected";
	const longError = `admission_closed: ${"the Workflow is shutting down and refused this call ".repeat(4)}end of error`;
	for (const [toolName, tool] of await registeredCatalogueTools(t)) {
		for (const expanded of [false, true]) {
			const output = renderToolResult(tool, shortError, { expanded, isPartial: false, isError: true });
			assert.match(output, new RegExp(`<error>[^<]*${shortError}`), `${toolName} expanded=${expanded}`);
			assert.doesNotMatch(output, /<success>|<accent>|<warning>|…|undefined/, `${toolName} expanded=${expanded}`);
		}
		const expandedLongError = renderToolResult(tool, longError, { expanded: true, isPartial: false, isError: true });
		assert.match(expandedLongError.replaceAll(/<\/?error>|\s+/g, ""), new RegExp(longError.replaceAll(/\s+/g, "")), toolName);
	}
});

test("every in-flight coordination tool renders in accent, never as needing action", async (t) => {
	// Ask User shows its waiting question in the call block instead.
	const inFlightShownByCall = new Set(["ask_user"]);
	for (const [toolName, tool] of await registeredCatalogueTools(t)) {
		const output = renderToolResult(tool, "", { expanded: false, isPartial: true, isError: false });
		if (inFlightShownByCall.has(toolName)) {
			assert.equal(output.trim(), "", toolName);
			continue;
		}
		assert.match(output, /<accent>[^<]*…<\/accent>/, toolName);
		assert.doesNotMatch(output, /<warning>|<success>|<error>/, toolName);
	}
});

test("refreshing Spawn guidance lists the new Templates without re-activating filtered tools", async (t) => {
	let pi: ExtensionAPI | undefined;
	let tools: SpawnGuidanceRefresh | undefined;
	const host = await createTestOwnerHost(t, (extensionPi) => {
		pi = extensionPi;
		tools = registerCoordinationTools(extensionPi, "ordinary", unavailableHandlers);
	});
	assert.ok(pi && tools);
	const systemPromptForNextTurn = async () => {
		let systemPrompt = "";
		host.model.setResponses([(context) => {
			systemPrompt = getCurrentSystemPrompt(context.messages);
			return fauxAssistantMessage("Done.");
		}]);
		await host.session.prompt("Inspect the Agent Spawn guidance.");
		return systemPrompt;
	};

	tools.refreshSpawnGuidance(templateSnapshot("first-delegate"));
	pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user"));
	tools.refreshSpawnGuidance(templateSnapshot("second-delegate"));

	const systemPrompt = await systemPromptForNextTurn();
	assert.equal(host.session.getActiveToolNames().includes("ask_user"), false);
	assert.match(systemPrompt, /## Available Agent Templates Snapshot/);
	assert.match(systemPrompt, /- name: second-delegate\n  useWhen: "Use second-delegate\."\n  model: anthropic\/claude-sonnet-4-5\n  thinking: high/);
	assert.doesNotMatch(systemPrompt, /first-delegate/);
	for (const tag of ["agent_spawn", "agent_delegation"]) {
		assert.equal(systemPrompt.match(new RegExp(`<${tag}>`, "g"))?.length, 1, tag);
	}

	pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "agent_spawn"));
	tools.refreshSpawnGuidance(templateSnapshot("third-delegate"));
	assert.equal(host.session.getActiveToolNames().includes("agent_spawn"), false);
	assert.match(host.session.getToolDefinition("agent_spawn")?.promptGuidelines?.join("\n") ?? "", /third-delegate/);
	await host.runtime.dispose();
});

function templateSnapshot(name: string): AgentTemplateCatalogueSnapshot {
	return {
		templates: [{
			name,
			useWhen: `Use ${name}.`,
			models: [{ model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinking: "high" }],
			systemPromptMode: "append",
			loadContextFiles: true,
		}],
	};
}

async function registeredCatalogueTools(t: TestCleanupRegistrar): Promise<Map<string, ToolDefinition>> {
	const tools = new Map<string, ToolDefinition>();
	for (const role of roles) {
		const host = await createTestOwnerHost(t, (pi) => {
			registerCoordinationTools(pi, role, unavailableHandlers);
		});
		for (const toolName of coordinationToolActivation(role, "terminal").roleTools) {
			const tool = host.session.getToolDefinition(toolName);
			assert.ok(tool, toolName);
			if (!tools.has(toolName)) tools.set(toolName, tool);
		}
		await host.runtime.dispose();
	}
	return tools;
}

function renderToolResult(
	tool: ToolDefinition,
	text: string,
	state: Readonly<{ expanded: boolean; isPartial: boolean; isError: boolean }>,
): string {
	assert.ok(tool.renderResult, tool.name);
	return tool.renderResult(
		{ content: text ? [{ type: "text", text }] : [], details: undefined },
		{ expanded: state.expanded, isPartial: state.isPartial },
		taggedTheme,
		{
			args: {}, lastComponent: undefined, toolCallId: tool.name, invalidate() {}, state: {}, cwd: process.cwd(),
			argsComplete: true, executionStarted: true, durationMs: undefined, outputPad: 0, showImages: false, ...state,
		},
	).render(240).join("\n");
}

function assertClosedTypeBoxObjects(schema: unknown, path: string): void {
	if (typeof schema !== "object" || schema === null) return;
	const node = schema as {
		type?: unknown;
		additionalProperties?: unknown;
		anyOf?: unknown[];
		properties?: Record<string, unknown>;
		items?: unknown;
	};
	if (node.type === "object" && !node.anyOf) assert.equal(node.additionalProperties, false, path);
	for (const [index, variant] of (node.anyOf ?? []).entries()) {
		assertClosedTypeBoxObjects(variant, `${path}.anyOf[${index}]`);
	}
	for (const [property, child] of Object.entries(node.properties ?? {})) {
		assertClosedTypeBoxObjects(child, `${path}.${property}`);
	}
	if (node.items) assertClosedTypeBoxObjects(node.items, `${path}.items`);
}
