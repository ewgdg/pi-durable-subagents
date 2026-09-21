import { fauxAssistantMessage, fauxToolCall, type JsonObject, type JsonValue } from "@earendil-works/pi-ai";
import {
	InteractiveMode,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import piAgentCoordination from "../../src/index.ts";
import { createManuallyManagedUnboundTestOwnerHost } from "../support/pi-host.ts";

const OWNER_EDITOR_TEXT = "Owner input survives child UI failure";
const FAILURE_EXTENSION = fileURLToPath(
	new URL("./process-agent-view-failure-extension.ts", import.meta.url),
);
const failureKind = process.env.PTY_AGENT_VIEW_FAILURE;
if (
	failureKind !== "input" &&
	failureKind !== "render" &&
	failureKind !== "initialization" &&
	failureKind !== "run" &&
	failureKind !== "noninteractive"
) {
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

host.model.setResponses([
	fauxAssistantMessage("Failure PTY child is ready."),
]);
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
const childTranscriptPath = childAgentId
	? await transcriptPathFor(childAgentId)
	: undefined;
if (failureKind === "run") {
	const transcriptPath = childTranscriptPath!;
	await waitForEvidenceCondition(() =>
		readFileText(transcriptPath).includes("Failure PTY child is ready.")
	);
	host.model.setResponses([
		fauxAssistantMessage("Deterministic PTY terminal Run failure.", {
			stopReason: "error",
			errorMessage: "deterministic PTY terminal Run failure",
		}),
	]);
}
if (failureKind === "noninteractive") {
	await host.runtime.dispose();
	mode.stop();
	const childShutdowns = (await readEvidence()).filter(({ kind }) => kind === "session_shutdown");
	if (childShutdowns.length !== 1) {
		throw new Error(`Expected one non-interactive child shutdown, received ${childShutdowns.length}`);
	}
	process.stdout.write("\n__PTY_NONINTERACTIVE_DISPOSAL_COMPLETE__\n");
} else {
	await finishInteractiveFailure();
}

async function finishInteractiveFailure(): Promise<void> {
	process.stdout.write(`\n__PTY_AGENT_VIEW_FAILURE_SETUP__${JSON.stringify({
		failureKind,
		childAgentId,
		initializationReleasePath,
		ownerEditorText: OWNER_EDITOR_TEXT,
	})}\n`);
	await openAgents(ownerSession);
	if (failureKind === "input" || failureKind === "render") {
		await waitForEvidence((entries) => entries.some(
			(entry) => entry.kind === "failure_trigger" && entry.failureKind === failureKind,
		));
		await waitForDiagnostic((message) =>
			message.startsWith("Agent view failed: child_runtime_unexpected_exit:")
		);
	} else if (failureKind === "run") {
		await waitForEvidenceCondition(
			() => readFileText(childTranscriptPath!).includes("trigger selected Run failure"),
			20_000,
		);
		// The terminal error retains the exact Run as a stop; the selected view only reaches
		// its durable Dormant Agent through explicit termination.
		await waitForAgentSuspension(childAgentId as string);
		await executeCommittedTool(
			ownerSession,
			appendToolSource(ownerSession, "agent_control", "pty-terminate-stopped-run", {
				operation: "terminate",
				agentId: childAgentId,
			}),
		);
		await waitForAgentPhase(childAgentId as string, "dormant");
		process.stdout.write("\n__PTY_SELECTED_RUN_STOPPED__\n");
		await waitForEvidenceCondition(() =>
			ownerSession.extensionRunner.createContext().ui.getEditorText()
				.endsWith("Owner input confirms selected Run closure")
		);
		return finishRestoredFailure();
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
	if (failureKind === "input" || failureKind === "render") {
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
		// notice lands. Announce restoration after that cascade, like the input and
		// render kinds do, so the assertion reads a settled Owner screen.
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
}

async function openAgents(session: AgentSession): Promise<void> {
	const command = session.extensionRunner.getCommand("agents");
	if (!command) throw new Error("PTY /agents command is unavailable");
	await command.handler("", session.extensionRunner.createCommandContext());
}

async function waitForAgentPhase(agentId: string, phase: string): Promise<void> {
	const observe = ownerSession.getToolDefinition("agent_observe");
	if (!observe) throw new Error("PTY agent_observe is unavailable");
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const status = await observe.execute(
			`observe-phase-${agentId}`,
			{ operation: "status", agentId },
			undefined,
			undefined,
			ownerSession.extensionRunner.createContext(),
		);
		if ((status.details as { run: { phase: string } }).run.phase === phase) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`PTY Agent ${agentId} did not enter ${phase}`);
}

async function waitForAgentSuspension(agentId: string): Promise<void> {
	const observe = ownerSession.getToolDefinition("agent_observe");
	if (!observe) throw new Error("PTY agent_observe is unavailable");
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const status = await observe.execute(
			`observe-suspension-${agentId}`,
			{ operation: "status", agentId },
			undefined,
			undefined,
			ownerSession.extensionRunner.createContext(),
		);
		if ((status.details as { run: { suspension?: { reason: string } } }).run.suspension?.reason === "runtime_error") return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`PTY Agent ${agentId} did not stop its Run`);
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

async function transcriptPathFor(agentId: string): Promise<string> {
	const observe = ownerSession.getToolDefinition("agent_observe");
	if (!observe) throw new Error("PTY agent_observe is unavailable");
	const status = await observe.execute(
		`observe-${agentId}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		ownerSession.extensionRunner.createContext(),
	);
	const transcriptPath = (status.details as {
		primaryEvidence: { transcriptPath: string | null };
	}).primaryEvidence.transcriptPath;
	if (!transcriptPath) throw new Error(`PTY Agent ${agentId} has no transcript path`);
	return transcriptPath;
}

function readFileText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function waitForEvidenceCondition(
	predicate: () => boolean,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Child process transcript evidence did not become durable");
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
		session.extensionRunner.createContext(),
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
