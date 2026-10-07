import { fauxAssistantMessage, fauxToolCall, type Context, type JsonObject, type JsonValue } from "@earendil-works/pi-ai";
import {
	InteractiveMode,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import piAgentCoordination from "../../src/index.ts";
import { createManuallyManagedUnboundTestOwnerHost } from "../support/pi-host.ts";

const OWNER_EDITOR_TEXT = "Owner input survives child UI failure";
const UNVIEWED_CHILD_REQUEST = "Remain unviewed until the Owner runtime is disposed.";
const FAILURE_EXTENSION = fileURLToPath(
	new URL("./process-agent-view-failure-extension.ts", import.meta.url),
);
const failureKind = process.env.PTY_AGENT_VIEW_FAILURE;
if (failureKind !== "input" && failureKind !== "initialization") {
	throw new Error(`Unsupported PTY Agent-view failure: ${failureKind ?? "missing"}`);
}

const evidencePath = join(tmpdir(), `.pty-agent-view-failure-${process.pid}.jsonl`);
const initializationReleasePath = join(
	tmpdir(),
	`.pty-agent-view-failure-${process.pid}.release`,
);
process.env.PTY_AGENT_VIEW_FAILURE_EVIDENCE = evidencePath;
process.env.PTY_AGENT_VIEW_FAILURE_RELEASE = initializationReleasePath;
const host = await createManuallyManagedUnboundTestOwnerHost(piAgentCoordination, {
	persistent: true,
	processVisibleModel: true,
	additionalExtensionPaths: [FAILURE_EXTENSION],
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
	fauxAssistantMessage("Owner failure baseline remains mounted."),
]);
await ownerSession.prompt("Owner transcript before child UI failure.");
await ownerSession.waitForIdle();
const ownerEditorFactory = ownerSession.extensionRunner.createContext().ui.getEditorComponent();
ownerSession.extensionRunner.createContext().ui.setEditorText(OWNER_EDITOR_TEXT);

// Children ask the shared model independently, so route by Creation Request
// instead of assuming which child's model turn arrives first.
host.model.setResponses(Array.from({ length: 8 }, () => (context: Context) =>
	JSON.stringify(context.messages).includes(UNVIEWED_CHILD_REQUEST)
		? fauxAssistantMessage("Unviewed PTY child is ready.")
		: fauxAssistantMessage("Failure PTY child is ready.")
));
const spawning = executeCommittedTool(
	ownerSession,
	appendToolSource(ownerSession, "agent_spawn", `pty-${failureKind}-failure-child`, {
		title: "Fixture request",
		request: "Remain live until the deterministic child UI failure.",
		label: "PTY Failure Worker",
	}),
);
if (failureKind === "initialization") {
	await waitForEvidence((entries) => entries.some(({ kind }) => kind === "initialization_paused"));
}
const spawn = failureKind === "initialization" ? undefined : await spawning;
const childAgentId = spawn ? detailString(spawn.details, "agentId") : undefined;
// The input failure run also owns a child that is never viewed, so its one
// non-interactive mode disposal is checked without booting a separate fixture.
const unviewedChild = failureKind === "input"
	? await executeCommittedTool(
		ownerSession,
		appendToolSource(ownerSession, "agent_spawn", "pty-unviewed-child", {
			title: "Fixture request",
			request: UNVIEWED_CHILD_REQUEST,
			label: "PTY Unviewed Worker",
		}),
	)
	: undefined;
const unviewedChildAgentId = unviewedChild
	? detailString(unviewedChild.details, "agentId")
	: undefined;
await finishInteractiveFailure();

async function finishInteractiveFailure(): Promise<void> {
	process.stdout.write(`\n__PTY_AGENT_VIEW_FAILURE_SETUP__${JSON.stringify({
		failureKind,
		childAgentId,
		initializationReleasePath,
		ownerEditorText: OWNER_EDITOR_TEXT,
	})}\n`);
	await openAgents(ownerSession);
	if (failureKind === "input") {
		await waitForEvidence((entries) => entries.some(
			(entry) => entry.kind === "failure_trigger" && entry.failureKind === failureKind,
		));
		await waitForDiagnostic((message) =>
			message.startsWith("Agent view failed: child_runtime_unexpected_exit:")
		);
	}
	const settledSpawn = spawn ?? await spawning;
	if (
		failureKind === "initialization" &&
		detailString(settledSpawn.details, "spawnStatus") !== "created"
	) throw new Error(`Process initialization failure was not admitted before the native TUI failed: ${JSON.stringify(settledSpawn.details)}`);
	if (host.runtime.session !== ownerSession) {
		throw new Error("Child UI failure changed the Owner runtime session");
	}
	if (ownerSession.extensionRunner.createContext().ui.getEditorText() !== OWNER_EDITOR_TEXT) {
		throw new Error("Child UI failure changed Owner editor text");
	}
	if (ownerSession.extensionRunner.createContext().ui.getEditorComponent() !== ownerEditorFactory) {
		throw new Error("Child UI failure changed Owner editor implementation");
	}
	if (failureKind === "input") {
		const exactTriggers = (await readEvidence()).filter(
			(entry) => entry.kind === "failure_trigger" && entry.failureKind === failureKind,
		);
		if (exactTriggers.length !== 1) {
			throw new Error(`Expected one exact child ${failureKind} trigger, received ${exactTriggers.length}`);
		}
		const boundedDiagnostics = host.services.diagnostics.filter(
			({ message }) => message.startsWith("Agent view failed: child_runtime_unexpected_exit:"),
		);
		if (boundedDiagnostics.length !== 1) {
			throw new Error(`Expected one bounded Owner process-exit diagnostic; received ${JSON.stringify(host.services.diagnostics)}`);
		}
	}
	if (failureKind === "initialization") {
		// The restored baseline only stays on screen until the Owner's delivery-failure
		// notice lands. Announce restoration after that cascade, like the input kind
		// does, so the assertion reads a settled Owner screen.
		await waitForDiagnostic((message) => message.startsWith("Agent view failed: "));
	}
	await finishRestoredFailure();
}

async function finishRestoredFailure(): Promise<void> {
	process.stdout.write(`\n__PTY_AGENT_VIEW_FAILURE_RESTORED__${failureKind}\n`);
	(mode as unknown as { renderer: { renderNow(force?: boolean): void } }).renderer.renderNow(true);
	await new Promise<void>((resolve) => setImmediate(resolve));

	await host.runtime.dispose();
	mode.stop();
	if (unviewedChildAgentId) {
		const unviewedShutdowns = (await readEvidence()).filter(
			({ kind, sessionId }) => kind === "session_shutdown" && sessionId === unviewedChildAgentId,
		);
		if (unviewedShutdowns.length !== 1) {
			throw new Error(`Expected one unviewed child shutdown, received ${unviewedShutdowns.length}`);
		}
		process.stdout.write("\n__PTY_UNVIEWED_CHILD_DISPOSED_ONCE__\n");
	}
}

async function openAgents(session: AgentSession): Promise<void> {
	const command = session.extensionRunner.getCommand("agents");
	if (!command) throw new Error("PTY /agents command is unavailable");
	await command.handler("", session.extensionRunner.createCommandContext());
}

async function waitForDiagnostic(
	predicate: (message: string) => boolean,
): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (host.services.diagnostics.some(({ message }) => predicate(message))) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("PTY Owner diagnostic did not become available");
}

async function readEvidence(): Promise<Array<Record<string, unknown>>> {
	try {
		return (await readFile(evidencePath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function waitForEvidence(
	predicate: (entries: readonly Record<string, unknown>[]) => boolean,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (predicate(await readEvidence())) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Child process failure evidence did not become durable");
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
			fauxToolCall(toolName, input as JsonObject, { id: toolCallId }),
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
		session.extensionRunner.createToolContext(source.toolCallId, undefined),
	);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: source.toolCallId,
		toolName: source.toolName,
		content: result.content,
		details: result.details as JsonValue,
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
