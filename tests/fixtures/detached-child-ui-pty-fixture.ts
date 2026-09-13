import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	InteractiveMode,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import piAgentCoordination from "../../src/index.ts";
import { createManuallyManagedUnboundTestOwnerHost } from "../support/pi-host.ts";

const PROBE_EXTENSION = fileURLToPath(
	new URL("./detached-child-ui-probe-extension.ts", import.meta.url),
);
const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-detached-child-ui-"));
const probeEvidencePath = join(fixtureRoot, "session-start.jsonl");
process.env.PROCESS_DETACHED_UI_PROBE_PATH = probeEvidencePath;

const host = await createManuallyManagedUnboundTestOwnerHost(piAgentCoordination, {
	cwd: fixtureRoot,
	persistent: true,
	processVisibleModel: true,
	implicitModeratorResponses: false,
	additionalExtensionPaths: [PROBE_EXTENSION],
});
const ownerId = host.session.sessionId;
const mode = new InteractiveMode(host.runtime, { verbose: false });
await mode.init();
void mode.run().catch((error: unknown) => {
	process.nextTick(() => {
		throw error;
	});
});
process.stdout.write("\n__PTY_OWNER_BOUND__\n");

host.model.setResponses([
	fauxAssistantMessage("The detached child settles after its startup banner."),
]);
const spawnResult = await executeTool(host.session, "agent_spawn", "pty-detached-spawn", {
	title: "Fixture request",
	request: "Remain live after your detached session_start.",
	label: "Detached Child",
});
const childId = detailString(spawnResult.details, "agentId");

await waitFor(async () => (await startedSessionIds()).includes(childId));
process.stdout.write(`\n__PTY_SETUP__${JSON.stringify({ ownerId, childId })}\n`);
// Hold the PTY open briefly so the test can poll the screen for a leaked banner.
await new Promise<void>((resolve) => setTimeout(resolve, 600));

mode.stop();
await host.runtime.dispose();
process.stdout.write("\n__PTY_DONE__\n");

type ToolSource = Readonly<{
	entryId: string;
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}>;

function executeTool(
	session: AgentSession,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
) {
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(toolName, input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const entry = session.sessionManager.getLeafEntry();
	if (!entry) throw new Error(`PTY ${toolName} source did not commit`);
	return executeCommittedTool(session, { entryId: entry.id, toolCallId, toolName, input });
}

async function executeCommittedTool(session: AgentSession, source: ToolSource) {
	const tool = session.getToolDefinition(source.toolName);
	if (!tool) throw new Error(`PTY tool ${source.toolName} is unavailable`);
	const result = await tool.execute(
		source.toolCallId,
		source.input as never,
		undefined,
		undefined,
		session.extensionRunner.createContext(),
	);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: source.toolCallId,
		toolName: source.toolName,
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
	return result;
}

function detailString(details: unknown, key: string): string {
	if (
		typeof details !== "object" ||
		details === null ||
		typeof (details as Record<string, unknown>)[key] !== "string"
	) throw new Error(`PTY receipt is missing ${key}`);
	return (details as Record<string, string>)[key]!;
}

async function startedSessionIds(): Promise<string[]> {
	const evidence = await readFile(probeEvidencePath, "utf8").catch(
		(error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error),
	);
	return evidence.trim().split("\n").filter(Boolean).map((line) => {
		const parsed = JSON.parse(line) as { sessionId?: unknown };
		if (typeof parsed.sessionId !== "string") {
			throw new Error("Detached child UI probe wrote malformed session evidence");
		}
		return parsed.sessionId;
	});
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("PTY condition did not become true");
}
