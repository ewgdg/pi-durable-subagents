import {
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type Context,
} from "@earendil-works/pi-ai";
import {
	InteractiveMode,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import piAgentCoordination from "../../src/index.ts";
import { createManuallyManagedUnboundTestOwnerHost } from "../support/pi-host.ts";

const OWNER_EDITOR_TEXT = "unfinished Owner editor text";
const DIRECT_AGENT_INPUT = "direct input through child editor";
const CONDITION_TIMEOUT_MS = 10_000;
const LONG_CHILD_RESPONSE = [
	"Viewed child is ready for direct editor input.",
	...Array.from(
		{ length: 60 },
		(_value, index) => `Viewed child transcript line ${String(index).padStart(2, "0")}`,
	),
].join("\n");
const STREAMING_CHILD_RESPONSE = [
	"Viewed child handled direct editor input.",
	...Array.from(
		{ length: 40 },
		(_value, index) => `Streaming child update ${String(index).padStart(2, "0")}`,
	),
].join("\n");

const requestedColumns = Number(process.env.PTY_TEST_COLUMNS);
const requestedRows = Number(process.env.PTY_TEST_ROWS);
if (
	Number.isInteger(requestedColumns) && requestedColumns > 0 &&
	Number.isInteger(requestedRows) && requestedRows > 0
) {
	const resized = spawnSync(
		"stty",
		["cols", String(requestedColumns), "rows", String(requestedRows)],
		{ stdio: "inherit" },
	);
	if (resized.status !== 0) throw new Error("PTY fixture could not resize its terminal");
}

const host = await createManuallyManagedUnboundTestOwnerHost(piAgentCoordination, {
	persistent: true,
	processVisibleModel: true,
	fauxTokensPerSecond: 20_000,
});
const ownerSession = host.session;
const mode = new InteractiveMode(host.runtime, {
	verbose: false,
	tuiMode: "fullscreen",
});
await mode.init();
void mode.run().catch((error: unknown) => {
	process.nextTick(() => {
		throw error;
	});
});

host.model.setResponses([
	fauxAssistantMessage("Owner baseline response remains mounted behind the Agent view."),
]);
await ownerSession.prompt("Owner baseline transcript before opening /agents.");
await ownerSession.waitForIdle();

// The viewed child resumes from its tool call before the nested child asks the
// process-visible model. Route by Creation Request evidence instead of assuming
// an ordering between model requests from independent child processes.
host.model.setResponses([
	routeNestedProcessResponse,
	routeNestedProcessResponse,
	routeNestedProcessResponse,
]);
const spawn = await executeCommittedTool(
	ownerSession,
	appendToolSource(ownerSession, "agent_spawn", "pty-spawn-viewed-agent", {
		title: "Fixture request",
		request: "Remain active while the Owner inspects this Agent view.",
		label: "PTY Viewed Worker",
	}),
);
const childAgentId = detailString(spawn.details, "agentId");
const childTranscriptPath = await transcriptPathFor(childAgentId);
await waitFor(() =>
	readFileSync(childTranscriptPath, "utf8").includes(
		"Viewed child is ready for direct editor input.",
	)
);
// Let the automatic obligation reminder finish before exposing the PTY setup
// marker; otherwise the first physical input can race its model turn.
await waitFor(
	() => readFileSync(childTranscriptPath, "utf8").includes(
		"I remain settled after the automatic Answer reminder.",
	),
	20_000,
	"automatic Answer reminder response",
);
await waitForAsync(async () => {
	const status = await observeAgent(childAgentId);
	const run = (status.details as {
		run: {
			phase: string;
			work?: string;
			retentionReasons?: readonly { reason: string }[];
		};
	}).run;
	return run.phase === "live" && run.work === "settled" &&
		!run.retentionReasons?.some(({ reason }) => reason === "pending_delivery");
}, 20_000, "automatic Answer reminder settlement");
host.model.setResponses([
	fauxAssistantMessage("Second PTY child remains independently interactive."),
]);
const secondSpawn = await executeCommittedTool(
	ownerSession,
	appendToolSource(ownerSession, "agent_spawn", "pty-spawn-second-viewed-agent", {
		title: "Fixture request",
		request: "Remain available as the second Agent-to-Agent switch target.",
		label: "PTY Second Worker",
	}),
);
const secondChildAgentId = detailString(secondSpawn.details, "agentId");
const secondChildTranscriptPath = await transcriptPathFor(secondChildAgentId);
await waitFor(() =>
	readFileSync(secondChildTranscriptPath, "utf8").includes(
		"Second PTY child remains independently interactive.",
	)
);
host.model.setResponses([
	fauxAssistantMessage(STREAMING_CHILD_RESPONSE),
	fauxAssistantMessage("Second attachment accepted direct input."),
]);
const ownerEntryIds = ownerSession.sessionManager.getEntries().map(({ id }) => id);
const ownerEditorFactory = ownerSession.extensionRunner.createContext().ui.getEditorComponent();
const repeatAgentViewReadyPath = process.env.PTY_REPEAT_VIEW_READY_PATH;
const repeatAgentViewReleasePath = process.env.PTY_REPEAT_VIEW_RELEASE_PATH;
const ownerEditorText = repeatAgentViewReadyPath ? "" : OWNER_EDITOR_TEXT;
ownerSession.extensionRunner.createContext().ui.setEditorText(ownerEditorText);
const ownerEditor = (mode as unknown as {
	editor: {
		getCursor(): Readonly<{ line: number; col: number }>;
		handleInput(data: string): void;
	};
}).editor;
for (let offset = 0; offset < 7; offset += 1) ownerEditor.handleInput("\x1b[D");
const ownerEditorCursor = ownerEditor.getCursor();
const firstAgentViewCommandReturnedPath = process.env.PTY_FIRST_VIEW_COMMAND_RETURNED_PATH;
const firstAgentViewCommandReleasePath = process.env.PTY_FIRST_VIEW_COMMAND_RELEASE_PATH;

process.stdout.write(`\n__PTY_AGENT_VIEW_SETUP__${JSON.stringify({
	ownerId: ownerSession.sessionId,
	childAgentId,
	secondChildAgentId,
	cwd: host.cwd,
	ownerEditorText,
	ownerEditorCursor,
	terminalColumns: process.stdout.columns,
	terminalRows: process.stdout.rows,
})}\n`);
void (async () => {
	await waitFor(
		() => readFileSync(childTranscriptPath, "utf8").includes(DIRECT_AGENT_INPUT),
		20_000,
		"direct child input commit",
	);
	await waitFor(
		() => readFileSync(childTranscriptPath, "utf8").includes("Streaming child update 39"),
		CONDITION_TIMEOUT_MS,
		"streamed child response transcript commit",
	);
	await waitForAsync(async () => {
		const status = await observeAgent(childAgentId);
		const run = (status.details as { run: { phase: string; work?: string } }).run;
		return run.phase === "live" && run.work === "settled";
	}, CONDITION_TIMEOUT_MS, "streamed child Run settlement");
	process.stdout.write("\n__PTY_CHILD_INPUT_SETTLED__\n");
})();
if (repeatAgentViewReadyPath) {
	await waitForAsync(async () => {
		const status = await observeAgent(childAgentId);
		const run = (status.details as {
			run: { retentionReasons?: readonly { reason: string }[] };
		}).run;
		return run.retentionReasons?.some(
			({ reason }) => reason === "interactive_selection",
		) ?? false;
	}, 20_000, "first typed physical Agent view attachment");
} else {
	await openAgents(ownerSession);
}
if (firstAgentViewCommandReturnedPath) {
	await import("node:fs/promises").then(({ writeFile }) =>
		writeFile(firstAgentViewCommandReturnedPath, "returned\n")
	);
	if (!firstAgentViewCommandReleasePath) {
		throw new Error("PTY command-return gate has no release path");
	}
	await waitFor(
		() => readFileIfExists(firstAgentViewCommandReleasePath) === "release\n",
		20_000,
		"command-return release",
	);
}
await waitForAsync(async () => {
	const statuses = await Promise.all([
		observeAgent(childAgentId),
		observeAgent(secondChildAgentId),
	]);
	return statuses.every((status) => {
		const run = (status.details as {
			run: { retentionReasons?: readonly { reason: string }[] };
		}).run;
		return !run.retentionReasons?.some(
			({ reason }) => reason === "interactive_selection",
		);
	});
}, 20_000, "physical Agent view closure");
if (repeatAgentViewReadyPath) {
	if (!repeatAgentViewReleasePath) {
		throw new Error("PTY repeated-view gate has no release path");
	}
	await import("node:fs/promises").then(({ writeFile }) =>
		writeFile(repeatAgentViewReadyPath, "ready\n")
	);
	await waitFor(
		() => readFileIfExists(repeatAgentViewReleasePath) === "release\n",
		20_000,
		"repeated-view release",
	);
	await waitForAsync(async () => {
		const status = await observeAgent(childAgentId);
		const run = (status.details as {
			run: { retentionReasons?: readonly { reason: string }[] };
		}).run;
		return !run.retentionReasons?.some(
			({ reason }) => reason === "interactive_selection",
		);
	}, 20_000, "repeated physical Agent view closure");
}
if (host.runtime.session !== ownerSession) {
	throw new Error(`Agent view rebound runtime to ${host.runtime.session.sessionId}`);
}
if (ownerSession.extensionRunner.createContext().ui.getEditorText() !== ownerEditorText) {
	throw new Error("Agent view changed Owner editor text");
}
if (ownerSession.extensionRunner.createContext().ui.getEditorComponent() !== ownerEditorFactory) {
	throw new Error("Agent view changed Owner editor implementation");
}
if (
	JSON.stringify(ownerEditor.getCursor()) !==
	JSON.stringify(ownerEditorCursor)
) {
	throw new Error("Agent view changed Owner editor cursor");
}
if (
	JSON.stringify(ownerSession.sessionManager.getEntries().map(({ id }) => id)) !==
	JSON.stringify(ownerEntryIds)
) {
	throw new Error("Agent view changed Owner transcript entries");
}
if (
	readFileSync(childTranscriptPath, "utf8").includes(DIRECT_AGENT_INPUT) === false
) {
	throw new Error("Interactive Agent view did not commit direct child input");
}
if (
	readFileSync(childTranscriptPath, "utf8").includes("Streaming child update 39") === false
) {
	throw new Error("Interactive Agent view did not complete direct child input");
}
process.stdout.write("\n__PTY_AGENT_VIEW_CLOSED__\n");
(mode as unknown as {
	renderer: { renderNow(force?: boolean): void };
}).renderer.renderNow(true);

await host.runtime.dispose();
mode.stop();

async function openAgents(session: AgentSession): Promise<void> {
	const command = session.extensionRunner.getCommand("agents");
	if (!command) throw new Error("PTY /agents command is unavailable");
	await command.handler("", session.extensionRunner.createCommandContext());
}

type ToolSource = Readonly<{
	entryId: string;
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}>;

function appendToolSource(
	session: AgentSession,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
): ToolSource {
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(toolName, input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const entry = session.sessionManager.getLeafEntry();
	if (!entry) throw new Error(`PTY ${toolName} source did not commit`);
	return { entryId: entry.id, toolCallId, toolName, input };
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

async function observeAgent(agentId: string) {
	const observe = ownerSession.getToolDefinition("agent_observe");
	if (!observe) throw new Error("PTY agent_observe tool is unavailable");
	return observe.execute(
		`pty-observe-${agentId}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		ownerSession.extensionRunner.createContext(),
	);
}

async function transcriptPathFor(agentId: string): Promise<string> {
	const status = await observeAgent(agentId);
	const transcriptPath = (status.details as {
		primaryEvidence: { transcriptPath: string | null };
	}).primaryEvidence.transcriptPath;
	if (!transcriptPath) throw new Error(`PTY Agent ${agentId} has no transcript path`);
	return transcriptPath;
}

function routeNestedProcessResponse(context: Context): AssistantMessage {
	const transcript = JSON.stringify(context.messages);
	if (
		transcript.includes('"role":"toolResult"') &&
		transcript.includes("pty-spawn-nested-agent")
	) return fauxAssistantMessage(LONG_CHILD_RESPONSE);
	if (transcript.includes("Remain available as nested activity for PTY ordering.")) {
		return fauxAssistantMessage("Nested PTY child remains live for activity ordering.");
	}
	return fauxAssistantMessage(
		fauxToolCall("agent_spawn", {
			title: "Fixture request",
			request: "Remain available as nested activity for PTY ordering.",
			label: "PTY Nested Worker",
		}, { id: "pty-spawn-nested-agent" }),
		{ stopReason: "toolUse" },
	);
}

function detailString(details: unknown, key: string): string {
	if (
		typeof details !== "object" ||
		details === null ||
		typeof (details as Record<string, unknown>)[key] !== "string"
	) throw new Error(`PTY receipt is missing ${key}`);
	return (details as Record<string, string>)[key]!;
}

function readFileIfExists(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (
			typeof error === "object" && error !== null &&
			"code" in error && error.code === "ENOENT"
		) return undefined;
		throw error;
	}
}

async function waitForAsync(
	predicate: () => Promise<boolean>,
	timeoutMs: number,
	description: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`PTY ${description} did not become true`);
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = CONDITION_TIMEOUT_MS,
	description = "fixture condition",
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`PTY ${description} did not become true`);
}
