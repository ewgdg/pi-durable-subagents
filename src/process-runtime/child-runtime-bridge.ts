import * as hostPi from "@earendil-works/pi-coding-agent";
import type {
	AgentSession,
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { FramedAgentControlChannel } from "../control/agent-control-channel.ts";
import { agentControlProtocol } from "../control/agent-control-protocol.ts";
import { connectControlTransport } from "../control/control-platform.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	childLaunchBlockGuidance,
	type ChildProcessBootstrap,
	validateChildProcessBootstrap,
} from "../control/control-protocol-schemas.ts";
import { installInteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import { transcriptFromSessionManager } from "../pi-integration/session-manager-transcript.ts";
import { registerSessionStartup } from "../pi-integration/session-startup.ts";
import { VirtualModelRegistrar } from "../pi-integration/virtual-model-registration.ts";
import { installAgentActivityDock } from "../presentation/agent-activity-surface.ts";
import {
	type ParticipantLifecycleHandlers,
	registerParticipantLifecycle,
} from "../pi-integration/participant-lifecycle.ts";
import { registerParticipantNativeSessionPolicy } from "../pi-integration/participant-native-session-policy.ts";
import {
	coordinationToolActivation,
	registerCoordinationTools,
} from "../tools/coordination-tools.ts";
import { registerMessageDeliveryRenderer } from "../tools/message-delivery-renderer.ts";
import { registerAgentsCommand } from "../tools/agents-command.ts";
import { answerCallTargetAgentId } from "../protocol/request-resolution.ts";
import {
	CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_LOAD_CONTEXT_FILES_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_SYSTEM_PROMPT_MODE_ENVIRONMENT_VARIABLE,
	CHILD_PROCESS_SYSTEM_PROMPT_PATH_ENVIRONMENT_VARIABLE,
} from "./child-process-environment.ts";
import { registerChildBindingHooks } from "./child-binding-hooks.ts";
import { ChildControlConnection } from "./child-control-connection.ts";
import { bindChildInteractiveInputLifecycle } from "./child-runtime-interactive-mode.ts";
import { childRuntimeInputs } from "./child-runtime-input-registry.ts";
import {
	canonicalFilePath,
	type ChildExplicitSystemPrompt,
	type ChildLaunchFacts,
} from "./child-runtime-snapshot.ts";
import {
	createControlBackedChildParticipantHandlers,
	createControlBackedChildPresentationHandlers,
	type ChildParticipantControlRequester,
} from "./remote-participant-control.ts";
import { extensionCommandAction } from "../pi-integration/extension-command-action.ts";

const ENTRY_MODULE_PATH = import.meta.filename;

const CHILD_CONTROL_REGISTRY_KEY = "__piAgentCoordinationChildControls";
const globalChildControlRegistry = globalThis as typeof globalThis & {
	[CHILD_CONTROL_REGISTRY_KEY]?: WeakMap<AgentSession, ChildControlConnection>;
};
// Pi retains the exact AgentSession across /reload. Preserve its authenticated
// Control connection; every extension generation binds a fresh Runtime binding.
const childControls = (
	globalChildControlRegistry[CHILD_CONTROL_REGISTRY_KEY] ??= new WeakMap()
);

/**
 * The bridge extension shell: everything that touches Pi extension registration,
 * the terminal, the bootstrap descriptor, or process globals. Child Runtime
 * behaviour lives in the Child Control Connection and its bindings.
 */
const childRuntimeBridge: ExtensionFactory = async (pi) => {
	let connection: ChildControlConnection | undefined;
	registerSessionStartup(pi);
	registerChildBindingHooks(pi, () => connection);
	// The Owner launches children with PI_CODING_AGENT_DIR set to its own agent
	// directory, and only this bridge is loaded, so the child registers its own.
	await VirtualModelRegistrar.create(pi, hostPi.getAgentDir());
	const resolveAgentLabel = (agentId: string) =>
		connection?.currentBinding?.activity.agentLabel(agentId);
	registerMessageDeliveryRenderer(pi, resolveAgentLabel);
	const bootstrap = await readBootstrapDescriptor();
	let boundRuntime: AgentSessionRuntime | undefined;
	const resolveAnswerTargetAgent = (toolCallId: string) => boundRuntime === undefined
		? undefined
		: answerCallTargetAgentId({
			responderAgentId: bootstrap.agentId,
			transcript: transcriptFromSessionManager(boundRuntime.session.sessionManager).inspect(),
			toolCallId,
		});
	const interactiveBridge = installInteractiveHostBridge(hostPi);
	const requireConnection = () => {
		if (!connection) throw new Error("child_runtime_control_unavailable: Runtime is not connected");
		return connection;
	};
	const participantRequest: ChildParticipantControlRequester = (method, payload, signal) =>
		requireConnection().request(method, payload, signal);
	const waitProgress = {
		subscribe: (toolCallId: string, handler: Parameters<ChildControlConnection["waitProgress"]["subscribe"]>[1]) =>
			requireConnection().waitProgress.subscribe(toolCallId, handler),
	};
	const nativeInputIdentity = {
		current: () => connection?.nativeInputIdentity.current(),
		take: () => connection?.nativeInputIdentity.take(),
	};
	registerAgentsCommand(pi, {
		kind: "participant",
		presentation: {
			...createControlBackedChildPresentationHandlers(participantRequest),
			addChangeHandler(handler) {
				const binding = connection?.currentBinding;
				if (!binding) throw new Error("child_runtime_not_initialized");
				const activity = binding.activity;
				return activity.addChangeHandler(() => handler(activity.selectorSnapshot()));
			},
		},
	});
	let participantLifecycle: ParticipantLifecycleHandlers;
	let refreshSpawnGuidance: ((refresh?: boolean) => Promise<void>) | undefined;
	// Pi stops terminal input handling together with a hidden TUI. A blocked ask_user
	// therefore has to keep this Agent's native editor live to receive the human's
	// keystrokes, which the Owner forwards into this process's PTY.
	let setNativeEditorRequired: (required: boolean) => void = () => undefined;
	const holdNativeEditorWhileAsking = () => {
		setNativeEditorRequired(true);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			setNativeEditorRequired(false);
		};
	};
	if (bootstrap.role === "ordinary") {
		const participant = createControlBackedChildParticipantHandlers(
			"ordinary",
			participantRequest,
			nativeInputIdentity,
			waitProgress,
		);
		const coordination = { ...participant.coordination, holdNativeEditorWhileAsking };
		participantLifecycle = participant.lifecycle;
		registerParticipantLifecycle(pi, participant.lifecycle, { registerInput: false });
		const coordinationTools = registerCoordinationTools(pi, "ordinary", coordination, { resolveAgentLabel, resolveAnswerTargetAgent });
		refreshSpawnGuidance = async (refresh = false) =>
			coordinationTools.refreshSpawnGuidance(await coordination.agentTemplateSnapshot(refresh));
	} else {
		const participant = createControlBackedChildParticipantHandlers(
			"moderator",
			participantRequest,
			nativeInputIdentity,
			waitProgress,
		);
		const coordination = { ...participant.coordination, holdNativeEditorWhileAsking };
		participantLifecycle = participant.lifecycle;
		registerParticipantLifecycle(pi, participant.lifecycle, { registerInput: false });
		registerCoordinationTools(pi, "moderator", coordination, { resolveAgentLabel, resolveAnswerTargetAgent });
	}
	registerParticipantNativeSessionPolicy(pi);
	// Terminal wiring belongs to this extension generation; Pi reload replaces it.
	let disposeTerminalWiring = () => undefined as void;

	pi.on("session_start", async (event, ctx) => {
		if (connection) throw new Error("child_runtime_bridge_rebound: session replacement is not supported");
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			throw new Error("child_runtime_bridge_requires_tui: expected mode=tui and hasUI=true");
		}
		const capture = await interactiveBridge.capture(
			ctx.sessionManager as hostPi.SessionManager,
			ctx.ui,
		);
		const { runtime } = capture;
		assertExpectedSession(runtime, bootstrap);
		setNativeEditorRequired = capture.setNativeEditorRequired;
		const retained = childControls.get(runtime.session);
		if (retained && event.reason !== "reload") {
			throw new Error("child_runtime_bridge_rebound: session replacement is not supported");
		}
		const currentConnection = retained ?? new ChildControlConnection(new FramedAgentControlChannel({
			identity: {
				protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION,
				workflowId: bootstrap.workflowId,
				agentId: bootstrap.agentId,
			},
			protocol: agentControlProtocol,
			side: "child",
			transport: await connectControlTransport(bootstrap.endpoint),
		}));
		if (!retained) childControls.set(runtime.session, currentConnection);
		connection = currentConnection;
		boundRuntime = runtime;
		const channel = currentConnection.channel;
		let binding;
		try {
			binding = currentConnection.bind({
				runtime,
				launchFacts: await readChildLaunchFacts(runtime, bootstrap.agentId),
				participantLifecycle,
				hostShell: {
					notify: (message, type) => ctx.ui.notify(message, type),
					setPresentationVisible: capture.setPresentationVisible,
					shutDown: () => ctx.shutdown(),
				},
			});
		} catch (error) {
			await currentConnection.reportFault("runtime_startup_failed", error);
			await channel.close().catch(() => undefined);
			throw error;
		}
		const exactBinding = binding;
		const removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			exactBinding.terminalInput(data);
			return undefined;
		});
		const removeInputLifecycleObserver = bindChildInteractiveInputLifecycle(runtime.session, {
			started: () => exactBinding.inputStarted(),
			completed: (sequence) => exactBinding.inputCompleted(sequence),
		});
		disposeTerminalWiring = () => {
			removeInputLifecycleObserver();
			removeTerminalInputListener();
		};
		// The entry's inline input tail loads after every Pi extension. Replace its delegates
		// on every bridge generation while keeping lifecycle and Control available first.
		childRuntimeInputs.set(ctx.sessionManager, {
			input: exactBinding.handleInput,
			async completeStartup() {
				try {
					applyStartupToolFilter(pi, bootstrap, retained !== undefined);
					await exactBinding.publishRuntimeSnapshot();
					// Reload reports current state but does not re-enforce the initial selection.
					if (!retained) {
						await channel.sendEvent("runtime.startupComplete", await exactBinding.runtimeSnapshot());
					}
				} catch (error) {
					await currentConnection.reportFault("runtime_startup_failed", error);
					await channel.close().catch(() => undefined);
					throw error;
				}
			},
		});
		try {
			if (!retained) {
				await channel.sendHello({
					connectionToken: bootstrap.connectionToken,
					expectedSessionId: bootstrap.expectedSessionId,
				});
			}
			if (bootstrap.ownerPresentation) {
				await refreshSpawnGuidance?.(event.reason === "reload");
				exactBinding.activity.update(
					await participantRequest("presentation.agents.snapshot", {}),
				);
				installAgentActivityDock(ctx.ui, exactBinding.activity, {
					openAgentsMenu: extensionCommandAction(pi, "/agents"),
				});
			}
			await exactBinding.publishRuntimeSnapshot();
			if (retained) return;
			await channel.sendEvent("runtime.ready", {
				sessionId: ctx.sessionManager.getSessionId(),
				mode: "tui",
				hasUI: true,
			});
		} catch (error) {
			await currentConnection.reportFault("runtime_startup_failed", error);
			await channel.close().catch(() => undefined);
			throw error;
		}
	});

	pi.on("session_shutdown", async (event) => {
		disposeTerminalWiring();
		// Reload invalidates this extension runner but retains the exact AgentSession
		// and process. The fresh session_start evaluation rebinds the same connection.
		await connection?.endGeneration(event.reason);
	});
};

/**
 * Capture what this process was launched with, once per extension generation:
 * the environment declares the explicit system prompt and context-file choice, and
 * Pi's resource loader must hold exactly that file-backed prompt.
 */
async function readChildLaunchFacts(
	runtime: AgentSessionRuntime,
	agentId: string,
): Promise<ChildLaunchFacts> {
	const loadContextFilesValue = process.env[CHILD_PROCESS_LOAD_CONTEXT_FILES_ENVIRONMENT_VARIABLE];
	if (loadContextFilesValue !== "0" && loadContextFilesValue !== "1") {
		throw new Error("child_runtime_load_context_files_mismatch: load-context-files marker is invalid");
	}
	return {
		agentId,
		systemPrompt: await readExplicitSystemPrompt(runtime),
		loadContextFiles: loadContextFilesValue === "1",
		bridgeExtensionPath: await canonicalFilePath(ENTRY_MODULE_PATH, runtime.cwd),
	};
}

async function readExplicitSystemPrompt(
	runtime: AgentSessionRuntime,
): Promise<ChildExplicitSystemPrompt | null> {
	const mode = process.env[CHILD_PROCESS_SYSTEM_PROMPT_MODE_ENVIRONMENT_VARIABLE];
	if (mode !== undefined && mode !== "append" && mode !== "replace") {
		throw new Error("child_runtime_system_prompt_mismatch: mode is invalid");
	}
	const path = process.env[CHILD_PROCESS_SYSTEM_PROMPT_PATH_ENVIRONMENT_VARIABLE];
	if ((mode === undefined) !== (path === undefined)) {
		throw new Error("child_runtime_system_prompt_mismatch: mode and path must be provided together");
	}
	if (mode === undefined) return null;
	const resourceLoader = runtime.services.resourceLoader;
	if (mode === "append") {
		const appendPrompt = resourceLoader.getAppendSystemPrompt();
		const appendSources = resourceLoader.getAppendSystemPromptSources();
		if (appendPrompt.length !== 1 || appendSources.length !== 1) {
			throw new Error("child_runtime_system_prompt_mismatch: expected one file-backed append prompt");
		}
		return {
			mode,
			filePath: await canonicalFilePath(appendSources[0]!.path, runtime.cwd),
			body: appendPrompt[0]!,
		};
	}
	const source = resourceLoader.getSystemPromptSource();
	if (source === undefined) {
		throw new Error("child_runtime_system_prompt_mismatch: expected one file-backed system prompt");
	}
	const body = resourceLoader.getSystemPrompt();
	if (body === undefined) {
		throw new Error("child_runtime_system_prompt_mismatch: prompt body is unavailable");
	}
	return { mode, filePath: await canonicalFilePath(source.path, runtime.cwd), body };
}

/**
 * Applies the Spawn and Template exclusion filter to the child surface after
 * inherited startup handlers ran, and keeps the role coordination tools active so
 * a filtered or rewired child can still answer. Reload preserves native changes
 * and only re-asserts participation. Absent names are ignored.
 */
function applyStartupToolFilter(
	pi: ExtensionAPI,
	bootstrap: Pick<ChildProcessBootstrap, "role" | "excludedTools" | "interaction">,
	retained: boolean,
): void {
	const { roleTools, activeTools } = coordinationToolActivation(bootstrap.role, bootstrap.interaction);
	const withheldTools = new Set<string>(roleTools.filter((name) => !activeTools.includes(name)));
	const excludedNames = new Set(retained ? [] : bootstrap.excludedTools);
	pi.setActiveTools([...new Set([
		...pi.getActiveTools().filter((name) => !excludedNames.has(name)),
		...activeTools,
	])].filter((name) => !withheldTools.has(name)));
}

function assertExpectedSession(runtime: AgentSessionRuntime, bootstrap: ChildProcessBootstrap): void {
	if (runtime.session.sessionId !== bootstrap.expectedSessionId) {
		throw new Error(
			`child_runtime_session_mismatch: expected ${bootstrap.expectedSessionId}, received ${runtime.session.sessionId}`,
		);
	}
}

async function readBootstrapDescriptor(): Promise<ChildProcessBootstrap> {
	const path = process.env[CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE];
	if (!path || !isAbsolute(path) || path.includes("\0")) {
		throw new Error(`control_bootstrap_invalid: descriptor path must be absolute. ${childLaunchBlockGuidance("retry_agent_launch")}`);
	}
	const descriptorStats = await stat(path);
	if (!descriptorStats.isFile()) {
		throw new Error(`control_bootstrap_invalid: descriptor path is not a regular file. ${childLaunchBlockGuidance("retry_agent_launch")}`);
	}
	// Windows stat modes do not expose ACL ownership and report synthesized
	// group/other bits even for files created with mode 0600. The artifact lives
	// in a unique current-user temporary directory there; POSIX keeps the exact
	// owner-only mode check.
	if (process.platform !== "win32" && (descriptorStats.mode & 0o077) !== 0) {
		throw new Error(`control_bootstrap_invalid: descriptor must be owner-only. ${childLaunchBlockGuidance("retry_agent_launch")}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch {
		// JSON parser errors can quote descriptor text, including the connection token.
		throw new Error(`control_bootstrap_invalid: descriptor could not be read as JSON. ${childLaunchBlockGuidance("retry_agent_launch")}`);
	}
	return validateChildProcessBootstrap(value);
}

export default childRuntimeBridge;
