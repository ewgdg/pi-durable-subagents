import type {
	ControlEvent,
	ControlRequester,
	ControlServeMap,
	FramedAgentControlChannel,
	MethodName,
} from "../control/agent-control-channel.ts";
import type {
	agentControlProtocol,
	ChildToOwnerControl,
	RemoteAgentSelectionResult,
	RemoteAgentSelectorAction,
	RemoteAgentSelectorSnapshot,
} from "../control/agent-control-protocol.ts";
import type { ParticipantLifecycleHandlers } from "../pi-integration/participant-lifecycle.ts";
import type { AgentWaitProgress } from "../protocol/agent-wait.ts";
import type {
	CoordinationRole,
	CoordinationToolHandlers,
} from "../tools/coordination-tools.ts";

type RemoteParticipantRole = Exclude<CoordinationRole, "owner">;
type OwnerControlChannel = FramedAgentControlChannel<typeof agentControlProtocol, "owner">;

/** The child's typed requester: only child→Owner methods with their exact payloads. */
export type ChildParticipantControlRequester = ControlRequester<ChildToOwnerControl>;

/** Agent-scoped Owner behavior; transport and framing stay outside this seam. */
export type OwnerParticipantRequestHandlers<Role extends RemoteParticipantRole> = Readonly<{
	lifecycle: ParticipantLifecycleHandlers;
	coordination: CoordinationToolHandlers<Role>;
	presentation: OwnerParticipantPresentationHandlers;
}>;

export type OwnerParticipantPresentationHandlers = Readonly<{
	snapshot(): Promise<RemoteAgentSelectorSnapshot>;
	setReportRead(reportId: string, read: boolean): Promise<void>;
	select(
		action: RemoteAgentSelectorAction,
		signal: AbortSignal,
	): Promise<RemoteAgentSelectionResult>;
	addChangeHandler(handler: (snapshot: RemoteAgentSelectorSnapshot) => void): () => void;
}>;

export type ControlBackedChildPresentationHandlers = Readonly<{
	addChangeHandler?(handler: (snapshot: RemoteAgentSelectorSnapshot) => void): () => void;
	snapshot(): Promise<RemoteAgentSelectorSnapshot>;
	setReportRead(reportId: string, read: boolean): Promise<void>;
	select(
		action: RemoteAgentSelectorAction,
		signal?: AbortSignal,
	): Promise<RemoteAgentSelectionResult>;
}>;

export type ControlBackedChildParticipantHandlers<Role extends RemoteParticipantRole> = Readonly<{
	lifecycle: ParticipantLifecycleHandlers;
	coordination: CoordinationToolHandlers<Role>;
}>;

export type ChildNativeInputIdentity = Readonly<{
	current(): number | undefined;
	take(): number | undefined;
}>;

export type ChildAgentWaitProgressSource = Readonly<{
	subscribe(
		toolCallId: string,
		handler: (progress: AgentWaitProgress) => void,
	): () => void;
}>;

type CommonChildCoordinationHandlers = Pick<
	CoordinationToolHandlers<"ordinary">,
	"observe" | "message" | "wait" | "control"
>;

export function createControlBackedChildPresentationHandlers(
	request: ChildParticipantControlRequester,
): ControlBackedChildPresentationHandlers {
	return {
		snapshot: () => request("presentation.agents.snapshot", {}),
		setReportRead: async (reportId, read) => { await request("presentation.reports.setRead", { reportId, read }); },
		select: (action, signal) => request("presentation.agents.select", action, signal),
	};
}

/** Build the child registrars' process-neutral proxies over one Control requester. */
export function createControlBackedChildParticipantHandlers(
	role: "ordinary",
	request: ChildParticipantControlRequester,
	nativeInputIdentity?: ChildNativeInputIdentity,
	waitProgress?: ChildAgentWaitProgressSource,
): ControlBackedChildParticipantHandlers<"ordinary">;
export function createControlBackedChildParticipantHandlers(
	role: "moderator",
	request: ChildParticipantControlRequester,
	nativeInputIdentity?: ChildNativeInputIdentity,
	waitProgress?: ChildAgentWaitProgressSource,
): ControlBackedChildParticipantHandlers<"moderator">;
export function createControlBackedChildParticipantHandlers(
	role: RemoteParticipantRole,
	request: ChildParticipantControlRequester,
	nativeInputIdentity?: ChildNativeInputIdentity,
	waitProgress?: ChildAgentWaitProgressSource,
): ControlBackedChildParticipantHandlers<"ordinary"> | ControlBackedChildParticipantHandlers<"moderator"> {
	const lifecycle: ParticipantLifecycleHandlers = {
		async executionStarted() {
			const submissionSequence = nativeInputIdentity?.take();
			return (await request("runtime.executionBegin", {
				...(submissionSequence === undefined ? {} : { submissionSequence }),
			})).frames;
		},
		async humanInputSubmitted(input) {
			const submissionSequence = nativeInputIdentity?.current();
			if (submissionSequence === undefined) {
				throw new Error("child_runtime_active_input_identity_unavailable");
			}
			return (await request("runtime.humanInput", {
				text: input.text,
				...(input.images === undefined ? {} : { images: input.images }),
				submissionSequence,
			})).disposition;
		},
		async primaryInputQueued() {
			await request("runtime.primaryInputQueued", {});
		},
		async humanInputMode() {
			return (await request("runtime.humanInputMode", {})).mode;
		},
		async toolResultCommitting(input) {
			return (await request("runtime.guardToolResult", input)).result ?? undefined;
		},
		async rootToolExecutionStarted(input) {
			await request("runtime.rootToolExecutionStart", input);
		},
		async safeBoundaryReached() {
			await request("runtime.safeBoundary", {});
		},
		async executionEnded() {
			await request("runtime.executionEnd", {});
		},
	};
	const common: CommonChildCoordinationHandlers = {
		observe: (input) => request("coordination.observe", input),
		message: (toolCallId, input) =>
			request("coordination.message", { toolCallId, input }),
		async wait(toolCallId, input, signal, onProgress) {
			const removeProgressHandler = onProgress && waitProgress
				? waitProgress.subscribe(toolCallId, onProgress)
				: () => undefined;
			try {
				return await request("coordination.wait", { toolCallId, input }, signal);
			} finally {
				removeProgressHandler();
			}
		},
		control: (toolCallId, input) =>
			request("coordination.control", { toolCallId, input }),
	};
	if (role === "ordinary") {
		const coordination: CoordinationToolHandlers<"ordinary"> = {
			...common,
			agentTemplateSnapshot: (refresh = false) => request(
				"coordination.templateSnapshot",
				{ refresh },
			),
			spawn: (toolCallId, input) =>
				request("coordination.spawn", { toolCallId, input }),
			askUser: (toolCallId, input, signal) =>
				request("coordination.askHuman", { toolCallId, input }, signal),
		};
		return { lifecycle, coordination };
	}
	const coordination: CoordinationToolHandlers<"moderator"> = {
		...common,
		askUser: (toolCallId, input, signal) =>
			request("coordination.askHuman", { toolCallId, input }, signal),
		reportToUser: (toolCallId, input) => request("coordination.reportToUser", { toolCallId, input }),
		moderatorControl: (toolCallId, input) =>
			request("coordination.moderatorControl", { toolCallId, input }),
	};
	return { lifecycle, coordination };
}

/**
 * Attach the Owner's participant serving to one admitted child channel: child
 * requests reach the Owner's handlers, Wait progress and selector changes return as
 * events, and every child event fans out to the current subscribers. Without
 * handlers the channel serves nothing and refuses every request.
 */
export function serveOwnerParticipant(
	channel: OwnerControlChannel,
	handlers:
		| OwnerParticipantRequestHandlers<"ordinary">
		| OwnerParticipantRequestHandlers<"moderator">
		| undefined,
	subscribers: ReadonlySet<(event: ControlEvent<ChildToOwnerControl>) => void>,
): void {
	if (handlers) {
		channel.serve(ownerParticipantServeMap(handlers, (toolCallId, progress) => {
			void channel.sendEvent("coordination.wait.progress", { toolCallId, progress })
				.catch(() => undefined);
		}));
		const removePresentationChangeHandler = handlers.presentation.addChangeHandler((snapshot) => {
			void channel.sendEvent("presentation.agents.changed", snapshot).catch(() => undefined);
		});
		channel.onClose(() => removePresentationChangeHandler());
	}
	channel.onEvent((event) => {
		for (const subscriber of subscribers) subscriber(event);
	});
}

/**
 * One entry per child→Owner method. A coordination method the role's handler
 * contract lacks answers `forbidden`; the contract is the only role list.
 */
function ownerParticipantServeMap(
	{ lifecycle, coordination, presentation }:
		| OwnerParticipantRequestHandlers<"ordinary">
		| OwnerParticipantRequestHandlers<"moderator">,
	publishWaitProgress: (toolCallId: string, progress: AgentWaitProgress) => void,
): ControlServeMap<ChildToOwnerControl> {
	return {
		"runtime.executionBegin": async ({ submissionSequence }) =>
			({ frames: await lifecycle.executionStarted(submissionSequence) }),
		"runtime.humanInput": async ({ text, images, submissionSequence }) =>
			({ disposition: await lifecycle.humanInputSubmitted({ text, images, submissionSequence }) }),
		"runtime.primaryInputQueued": async () => {
			await lifecycle.primaryInputQueued();
			return {};
		},
		"runtime.humanInputMode": async () => ({ mode: await lifecycle.humanInputMode() }),
		"runtime.guardToolResult": async ({ message }) =>
			({ result: await lifecycle.toolResultCommitting({ message }) ?? null }),
		"runtime.rootToolExecutionStart": async (input) => {
			await lifecycle.rootToolExecutionStarted(input);
			return {};
		},
		"runtime.safeBoundary": async () => {
			await lifecycle.safeBoundaryReached();
			return {};
		},
		"runtime.executionEnd": async () => {
			await lifecycle.executionEnded();
			return {};
		},
		"coordination.observe": (input) => coordination.observe(input),
		"coordination.message": ({ toolCallId, input }) => coordination.message(toolCallId, input),
		"coordination.wait": ({ toolCallId, input }, signal) => coordination.wait(
			toolCallId,
			input,
			signal,
			(progress) => publishWaitProgress(toolCallId, progress),
		),
		"coordination.control": ({ toolCallId, input }) => coordination.control(toolCallId, input),
		"coordination.spawn": async ({ toolCallId, input }) => {
			if (!("spawn" in coordination)) throw forbiddenForRole("coordination.spawn");
			return coordination.spawn(toolCallId, input);
		},
		"coordination.templateSnapshot": async ({ refresh }) => {
			if (!("agentTemplateSnapshot" in coordination)) throw forbiddenForRole("coordination.templateSnapshot");
			return coordination.agentTemplateSnapshot(refresh);
		},
		"coordination.askHuman": ({ toolCallId, input }, signal) => coordination.askUser(toolCallId, input, signal),
		"coordination.reportToUser": async ({ toolCallId, input }) => {
			if (!("reportToUser" in coordination)) throw forbiddenForRole("coordination.reportToUser");
			return coordination.reportToUser(toolCallId, input);
		},
		"coordination.moderatorControl": async ({ toolCallId, input }) => {
			if (!("moderatorControl" in coordination)) throw forbiddenForRole("coordination.moderatorControl");
			return coordination.moderatorControl(toolCallId, input);
		},
		"presentation.agents.snapshot": () => presentation.snapshot(),
		"presentation.agents.select": (action, signal) => presentation.select(action, signal),
		"presentation.reports.setRead": async ({ reportId, read }) => {
			await presentation.setReportRead(reportId, read);
			return {};
		},
	};
}

function forbiddenForRole(method: MethodName<ChildToOwnerControl>): Error {
	return new Error(`child_runtime_owner_request_forbidden: ${method}`);
}
