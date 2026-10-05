import type { Static } from "typebox";

import type {
	AgentControlMethod,
	agentControlMethods,
} from "../../src/control/agent-control-protocol.ts";
import type { ChildControlLink } from "../../src/process-runtime/pi-child-hosted-runtime.ts";
import { createPiChildProcessProjection } from "../../src/process-runtime/pi-child-process-projection.ts";
import type {
	PiChildRuntimeEvent,
	PiChildRuntimeSnapshot,
} from "../../src/process-runtime/pi-child-process-runtime.ts";
import type { HostedAgentProjection } from "../../src/runtime/hosted-agent-projection.ts";

type MethodRequest<M extends AgentControlMethod> = Static<(typeof agentControlMethods)[M]["request"]>;
type MethodResponse<M extends AgentControlMethod> = Static<(typeof agentControlMethods)[M]["response"]>;

/** Responses a scripted child gives, per Owner→child method. Unscripted methods reject. */
export type ScriptedChildResponders = {
	[M in AgentControlMethod]?: (
		payload: MethodRequest<M>,
		signal: AbortSignal | undefined,
	) => Promise<MethodResponse<M>> | MethodResponse<M>;
};

/** One child event as the scripted child emits it; the link assigns its sequence. */
export type ScriptedChildEvent = PiChildRuntimeEvent extends infer Event
	? Event extends PiChildRuntimeEvent ? Omit<Event, "sequence"> : never
	: never;

export type ScriptedChildControlLink = Readonly<{
	link: ChildControlLink;
	/** Methods in request order, for intention assertions. */
	requests: Array<Readonly<{ method: AgentControlMethod; payload: unknown }>>;
	emit(event: ScriptedChildEvent): void;
	exit(exit: Readonly<{ exitCode: number; signal: number }>): void;
	closeChannel(cause: Error): void;
}>;

/**
 * A Child Control Link whose child is a script, for proxy cases that need precise
 * response and event timing. Everything else uses the Child Control loopback.
 */
export function createScriptedChildControlLink(options: Readonly<{
	snapshot?: Partial<PiChildRuntimeSnapshot>;
	respond?: ScriptedChildResponders;
}> = {}): ScriptedChildControlLink {
	const subscribers = new Set<(event: PiChildRuntimeEvent) => void>();
	const closeHandlers = new Set<(cause: Error) => void>();
	const requests: Array<Readonly<{ method: AgentControlMethod; payload: unknown }>> = [];
	const responders = options.respond ?? {};
	let sequence = 0;
	let settleExit!: (exit: Readonly<{ exitCode: number; signal: number }>) => void;
	const exited = new Promise<Readonly<{ exitCode: number; signal: number }>>((resolve) => {
		settleExit = resolve;
	});
	const snapshot: PiChildRuntimeSnapshot = {
		cwd: "/runtime",
		model: { provider: "test", modelId: "model" },
		thinking: "off",
		tools: [],
		skills: [],
		skillSources: [],
		extensions: [],
		projectTrusted: true,
		sessionId: "scripted-runtime",
		sessionPath: "/sessions/scripted-runtime.jsonl",
		systemPrompt: null,
		loadContextFiles: true,
		...options.snapshot,
	};
	const channel = {
		async request<M extends AgentControlMethod>(
			method: M,
			payload: MethodRequest<M>,
			signal?: AbortSignal,
		): Promise<MethodResponse<M>> {
			requests.push({ method, payload });
			const responder: ScriptedChildResponders[M] = responders[method];
			if (!responder) throw new Error(`scripted_child_unscripted_request: ${method}`);
			return await responder(payload, signal);
		},
		onClose(handler: (cause: Error) => void) {
			closeHandlers.add(handler);
			return () => closeHandlers.delete(handler);
		},
	};
	return {
		link: {
			ready: async () => ({ snapshot, channel }),
			onEvent(handler) {
				subscribers.add(handler);
				return () => subscribers.delete(handler);
			},
			exited,
			dispose: async () => undefined,
		},
		requests,
		emit(event) {
			const sequenced: PiChildRuntimeEvent = { ...event, sequence: ++sequence };
			for (const subscriber of subscribers) subscriber(sequenced);
		},
		exit: (exit) => settleExit(exit),
		closeChannel(cause) {
			for (const handler of closeHandlers) handler(cause);
		},
	};
}

/** A real PTY projection over a scripted link whose terminal is blank and inert. */
export function createScriptedTerminalProjection(link: ChildControlLink): HostedAgentProjection {
	return createPiChildProcessProjection({
		exited: link.exited,
		ready: link.ready,
		onEvent: link.onEvent,
		cancelInitialization: () => undefined,
		dimensions: () => ({ columns: 80, rows: 24 }),
		frame: () => ({
			columns: 80,
			rows: 24,
			buffer: "normal",
			lines: [],
			cursor: { row: 0, column: 0, visible: false, style: "block", blink: false },
		}),
		writeInput() {},
		resize() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler: () => () => undefined,
		beginPhysicalTerminalAttachment: async () => () => undefined,
		beginScreenView: async () => undefined,
		hidePresentation: async () => undefined,
		pauseOutput() {},
		resumeOutput() {},
		dispose: async () => undefined,
	});
}
