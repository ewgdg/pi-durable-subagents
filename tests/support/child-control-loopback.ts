import type { ExtensionAPI, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

import { FramedAgentControlChannel } from "../../src/control/agent-control-channel.ts";
import { agentControlProtocol, type AgentControlMethod } from "../../src/control/agent-control-protocol.ts";
import { AGENT_CONTROL_PROTOCOL_VERSION } from "../../src/control/control-protocol-schemas.ts";
import { createInMemoryControlTransportPair } from "../../src/control/in-memory-control-transport.ts";
import { registerParticipantLifecycle } from "../../src/pi-integration/participant-lifecycle.ts";
import { registerSessionStartup } from "../../src/pi-integration/session-startup.ts";
import { registerChildBindingHooks } from "../../src/process-runtime/child-binding-hooks.ts";
import {
	ChildControlConnection,
	type ChildControlChannel,
	type ChildRuntimeBinding,
} from "../../src/process-runtime/child-control-connection.ts";
import {
	PiChildHostedRuntime,
	type ChildControlLink,
	type ChildControlLinkAdmission,
} from "../../src/process-runtime/pi-child-hosted-runtime.ts";
import type { PiChildRuntimeEvent } from "../../src/process-runtime/pi-child-process-runtime.ts";
import {
	createControlBackedChildParticipantHandlers,
	serveOwnerParticipant,
	type OwnerParticipantRequestHandlers,
} from "../../src/process-runtime/remote-participant-control.ts";
import {
	createTestOwnerHost,
	type TestCleanupRegistrar,
	type TestOwnerHost,
	type TestOwnerHostOptions,
} from "./pi-host.ts";

const LOOPBACK_WORKFLOW_ID = "loopback-workflow";
const LOOPBACK_AGENT_ID = "loopback-child";

type ChildExit = Readonly<{ exitCode: number; signal: number }>;

export type ChildControlLoopbackOptions = Readonly<{
	/** The Owner's participant handlers the child's requests reach. */
	owner?: OwnerParticipantRequestHandlers<"ordinary"> | OwnerParticipantRequestHandlers<"moderator">;
	/** Register the participant lifecycle hooks the bridge registers (execution begin/end, tool guards). */
	participantLifecycleHooks?: boolean;
	/** Inherited extension hooks, which load after the bridge hooks and before the input tail. */
	configure?: (pi: ExtensionAPI) => void;
	/** Holds one Owner→child request before transmission, for in-flight ordering cases. */
	beforeOwnerRequest?: (method: AgentControlMethod) => Promise<void>;
	host?: TestOwnerHostOptions;
}>;

export type ChildControlLoopback = Readonly<{
	host: TestOwnerHost;
	/** The real Owner-side child proxy over the loopback link. */
	proxy: PiChildHostedRuntime;
	/** The Owner end of the Control channel, for raw wire requests. */
	ownerChannel: ChildControlChannel;
	/** Every child event in arrival order. */
	events: ReadonlyArray<PiChildRuntimeEvent>;
	hostShell: Readonly<{
		readonly notices: ReadonlyArray<Readonly<{ message: string; type: "warning" | "error" }>>;
		readonly visibility: readonly boolean[];
		readonly shutdowns: number;
	}>;
	readonly binding: ChildRuntimeBinding;
	exited: Promise<ChildExit>;
	/** Submit native input the way the interactive loop does after a physical submit key. */
	submitNativeInput(text: string): Promise<void>;
	/** Pi ends the current extension generation; a reload keeps the connection. */
	endGeneration(reason: SessionShutdownEvent["reason"]): Promise<void>;
	/** Bind a fresh generation over the same session and connection. */
	bindGeneration(): Promise<ChildRuntimeBinding>;
	/** Pi /reload: end this generation and bind the next. */
	reload(): Promise<ChildRuntimeBinding>;
	closeTransport(): Promise<void>;
	emitFault(code: string, message: string): Promise<void>;
	/** The child process exits without an orderly shutdown. */
	exit(exit: ChildExit): Promise<void>;
}>;

/**
 * The Child Control loopback: the real Owner-side proxy and Owner participant
 * serving connected to a real child connection and binding over the in-memory
 * transport pair and a faux Pi session. No hello or admission broker.
 */
export async function createChildControlLoopback(
	t: TestCleanupRegistrar,
	options: ChildControlLoopbackOptions = {},
): Promise<ChildControlLoopback> {
	const identity = {
		protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION,
		workflowId: LOOPBACK_WORKFLOW_ID,
		agentId: LOOPBACK_AGENT_ID,
	};
	const [ownerTransport, childTransport] = createInMemoryControlTransportPair();
	const ownerChannel = new FramedAgentControlChannel({ identity, protocol: agentControlProtocol, transport: ownerTransport });
	const connection = new ChildControlConnection(new FramedAgentControlChannel({
		identity, protocol: agentControlProtocol, transport: childTransport,
	}));
	const events: PiChildRuntimeEvent[] = [];
	const subscribers = new Set<(event: PiChildRuntimeEvent) => void>([(event) => events.push(event)]);
	serveOwnerParticipant(ownerChannel, options.owner ?? loopbackOwnerHandlers(), subscribers);
	const participantLifecycle = createControlBackedChildParticipantHandlers(
		"ordinary", connection.request, connection.nativeInputIdentity, connection.waitProgress,
	).lifecycle;

	const host = await createTestOwnerHost(t, (pi) => {
		registerSessionStartup(pi);
		registerChildBindingHooks(pi, () => connection);
		if (options.participantLifecycleHooks) {
			registerParticipantLifecycle(pi, participantLifecycle, { registerInput: false });
		}
		options.configure?.(pi);
		// The bridge entry's input tail: the binding's input handler runs after every extension.
		pi.on("input", (event, context) => requireBinding(connection).handleInput(event, context));
	}, { ...options.host, persistent: true });

	const notices: Array<Readonly<{ message: string; type: "warning" | "error" }>> = [];
	const visibility: boolean[] = [];
	let shutdowns = 0;
	let settleExit!: (exit: ChildExit) => void;
	const exited = new Promise<ChildExit>((resolve) => { settleExit = resolve; });
	let hostShutdown: Promise<void> | undefined;
	// Mirrors Pi quitting the child process: the session shuts down, the process
	// exits, and its end of Control closes.
	const shutDownHost = () => hostShutdown ??= (async () => {
		await connection.endGeneration("quit");
		await host.dispose();
		await connection.channel.close();
		settleExit({ exitCode: 0, signal: 0 });
	})();
	const bindGeneration = async () => connection.bind({
		runtime: host.runtime,
		launchFacts: {
			agentId: LOOPBACK_AGENT_ID,
			systemPrompt: null,
			loadContextFiles: true,
			bridgeExtensionPath: undefined,
		},
		participantLifecycle,
		hostShell: {
			notify: (message, type) => notices.push({ message, type }),
			setPresentationVisible: (visible) => visibility.push(visible),
			shutDown() {
				shutdowns++;
				void shutDownHost();
			},
		},
	});
	const firstBinding = await bindGeneration();

	const beforeOwnerRequest = options.beforeOwnerRequest;
	const proxyChannel: ChildControlLinkAdmission["channel"] = beforeOwnerRequest === undefined ? ownerChannel : {
		async request(method, payload, signal) {
			await beforeOwnerRequest(method);
			return ownerChannel.request(method, payload, signal);
		},
		onClose: (handler) => ownerChannel.onClose(handler),
	};
	let disposed: Promise<void> | undefined;
	const link: ChildControlLink = {
		ready: async () => ({ snapshot: await firstBinding.runtimeSnapshot(), channel: proxyChannel }),
		onEvent(handler) {
			subscribers.add(handler);
			return () => subscribers.delete(handler);
		},
		exited,
		// An orderly shutdown request; a child that cannot serve it is stopped directly.
		dispose: () => disposed ??= (async () => {
			await ownerChannel.request("runtime.shutdown", {}).catch(() => shutDownHost());
			await exited;
		})(),
	};
	const proxy = new PiChildHostedRuntime({ link });
	t.after(() => proxy.dispose());
	await proxy.ready;

	return {
		host,
		proxy,
		ownerChannel,
		events,
		hostShell: {
			notices,
			visibility,
			get shutdowns() { return shutdowns; },
		},
		get binding() { return requireBinding(connection); },
		exited,
		async submitNativeInput(text) {
			const binding = requireBinding(connection);
			binding.terminalInput("\r");
			const sequence = await binding.inputStarted();
			try {
				await host.session.prompt(text);
			} finally {
				await binding.inputCompleted(sequence);
			}
		},
		endGeneration: (reason) => connection.endGeneration(reason),
		bindGeneration,
		async reload() {
			await connection.endGeneration("reload");
			return bindGeneration();
		},
		closeTransport: () => ownerChannel.close(),
		emitFault: (code, message) => connection.reportFault(code, new Error(message)),
		async exit(exit) {
			await connection.channel.close();
			settleExit(exit);
		},
	};
}

/** Permissive Owner lifecycle; coordination and presentation fail loudly unless a test supplies them. */
export function loopbackOwnerHandlers(): OwnerParticipantRequestHandlers<"ordinary"> {
	const unscripted = (name: string) => () => Promise.reject(new Error(`loopback_owner_unscripted: ${name}`));
	return {
		lifecycle: {
			executionStarted: async () => [],
			humanInputSubmitted: async () => "continue",
			primaryInputQueued: async () => undefined,
			humanInputMode: async () => "agent",
			toolResultCommitting: async () => undefined,
			rootToolExecutionStarted: async () => undefined,
			safeBoundaryReached: async () => undefined,
			executionEnded: async () => undefined,
		},
		coordination: {
			agentTemplateSnapshot: unscripted("agentTemplateSnapshot"),
			observe: unscripted("observe"),
			message: unscripted("message"),
			wait: unscripted("wait"),
			control: unscripted("control"),
			spawn: unscripted("spawn"),
			askUser: unscripted("askUser"),
		},
		presentation: {
			snapshot: unscripted("presentation.snapshot"),
			setReportRead: unscripted("presentation.setReportRead"),
			select: unscripted("presentation.select"),
		},
	};
}

function requireBinding(connection: ChildControlConnection): ChildRuntimeBinding {
	const binding = connection.currentBinding;
	if (!binding) throw new Error("child_runtime_control_unavailable: no generation is bound");
	return binding;
}
