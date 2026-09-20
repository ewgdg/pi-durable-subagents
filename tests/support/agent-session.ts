import assert from "node:assert/strict";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type JsonObject,
	type JsonValue,
} from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	type Component,
} from "@earendil-works/pi-tui";

import type { TestOwnerHost } from "./pi-host.ts";

const SURFACE_WAIT_TIMEOUT_MS = 5_000;
const MAX_SELECTOR_NAVIGATION_STEPS = 1_000;

export async function executeRegisteredTool(
	session: AgentSession,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(toolName, input as JsonObject, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const tool = session.getToolDefinition(toolName);
	assert.ok(tool, toolName);
	return tool.execute(
		toolCallId,
		input as never,
		undefined,
		undefined,
		session.extensionRunner.createContext(),
	);
}

export async function executeAndCommitRegisteredTool(
	session: AgentSession,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
	const result = await executeRegisteredTool(session, toolName, toolCallId, input);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: result.content,
		details: result.details as JsonValue,
		isError: false,
		timestamp: Date.now(),
	});
	return result;
}

export async function openLiveAgentView(
	host: TestOwnerHost,
	agentId: string,
): Promise<Readonly<{ command: Promise<void>; view: Component }>> {
	const { command, surface: selector } = await openAgentsSurface(host);
	if (selector.render(80).some((line) => line.includes("Dormant Agents"))) {
		selector.handleInput?.("\t");
	}
	while (selector.render(80).some((line) => line.includes("Agents / "))) {
		selector.handleInput?.("h");
	}
	if (!selectAgentInCurrentTree(selector, agentId, host.session.sessionId)) {
		selector.handleInput?.("\x1b");
		await command;
		assert.fail(`Agent ${agentId} is absent from the Live selector hierarchy`);
	}
	await waitForCondition(() =>
		host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== selector
	);
	return { command, view: host.ui.customSurfaces[0]! };
}

export async function openDormantAgentView(
	host: TestOwnerHost,
	agentId: string,
): Promise<Readonly<{ command: Promise<void>; view: Component }>> {
	const { command, surface: selector } = await openAgentsSurface(host);
	selector.handleInput?.("\t");
	const firstRender = selector.render(80).join("\n");
	let currentRender = firstRender;
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		if (focusedDetailsShowAgent(selector, agentId)) {
			selector.handleInput?.("\r");
			await waitForCondition(() =>
				host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== selector
			);
			return { command, view: host.ui.customSurfaces[0]! };
		}
		selector.handleInput?.("j");
		currentRender = selector.render(80).join("\n");
		if (currentRender === firstRender) break;
	}
	selector.handleInput?.("\x1b");
	await command;
	assert.fail(`Dormant Agent ${agentId} is absent from the selector`);
}

export async function openAgentsSurface(
	host: TestOwnerHost,
): Promise<Readonly<{ command: Promise<void>; surface: Component }>> {
	const command = host.runtime.session.prompt("/agents");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	return { command, surface: host.ui.customSurfaces[0]! };
}

export async function returnAgentViewToOwner(
	host: TestOwnerHost,
	opened: Readonly<{ command: Promise<void>; view: Component }>,
): Promise<void> {
	for (const character of "/agents") opened.view.handleInput?.(character);
	await waitForCondition(() =>
		stripTerminalSequences(opened.view.render(80).join("\n")).includes("/agents")
	);
	opened.view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(opened.view.render(80).join("\n")).includes("Tab views")
	);
	opened.view.handleInput?.("o");
	await waitForCondition(() => !host.ui.customSurfaces.includes(opened.view));
	await opened.command;
}

function selectAgentInCurrentTree(
	surface: NonNullable<TestOwnerHost["ui"]["customSurfaces"][number]>,
	targetAgentId: string,
	ownerAgentId: string,
): boolean {
	const firstRender = surface.render(80).join("\n");
	let currentRender = firstRender;
	for (let attempt = 0; attempt < MAX_SELECTOR_NAVIGATION_STEPS; attempt += 1) {
		if (focusedDetailsShowAgent(surface, targetAgentId)) {
			surface.handleInput?.("\r");
			return true;
		}
		if (!focusedDetailsShowAgent(surface, ownerAgentId)) {
			const beforeZoom = currentRender;
			surface.handleInput?.("l");
			const afterZoom = surface.render(80).join("\n");
			if (afterZoom !== beforeZoom) {
				if (selectAgentInCurrentTree(surface, targetAgentId, ownerAgentId)) return true;
				surface.handleInput?.("h");
			}
		}
		const beforeMove = surface.render(80).join("\n");
		surface.handleInput?.("j");
		currentRender = surface.render(80).join("\n");
		// Native navigation clamps at the Owner row rather than wrapping.
		if (currentRender === beforeMove || currentRender === firstRender) break;
	}
	return false;
}

function focusedDetailsShowAgent(
	surface: NonNullable<TestOwnerHost["ui"]["customSurfaces"][number]>,
	targetAgentId: string,
): boolean {
	// Pi renders styling even without a TTY; identity matching uses visible text.
	const lines = surface.render(80).map(stripTerminalSequences);
	const selectedRow = lines.findIndex((line) => line.includes("→"));
	if (selectedRow < 0) return false;
	return lines
		.slice(selectedRow + 1, selectedRow + 5)
		.some((line) => line.slice(1, -1).trim() === targetAgentId);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + SURFACE_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for the /agents custom surface");
}
