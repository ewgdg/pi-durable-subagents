import type { Static } from "typebox";
import { Check } from "typebox/value";

import type { ControlRequest } from "../control/agent-control-channel.ts";
import {
	agentControlMethods,
	agentControlProtocol,
	type AgentControlMethod,
	type RemoteAgentSelectionResult,
	type RemoteAgentSelectorAction,
	type RemoteAgentSelectorSnapshot,
} from "../control/agent-control-protocol.ts";
import type { ParticipantLifecycleHandlers } from "../pi-integration/participant-lifecycle.ts";
import type { AgentWaitProgress } from "../protocol/agent-wait.ts";
import type {
	ParticipantCoordinationRole,
	ParticipantCoordinationToolHandlers,
} from "../tools/participant-coordination-tools.ts";

type RemoteParticipantRole = Exclude<ParticipantCoordinationRole, "owner">;
type MethodRequest<M extends AgentControlMethod> = Static<
	(typeof agentControlMethods)[M]["request"]
>;
type MethodResponse<M extends AgentControlMethod> = Static<
	(typeof agentControlMethods)[M]["response"]
>;

export type ChildParticipantControlRequester = <M extends AgentControlMethod>(
	method: M,
	payload: MethodRequest<M>,
	signal?: AbortSignal,
) => Promise<MethodResponse<M>>;

/** Agent-scoped Owner behavior; transport and framing stay outside this seam. */
export type OwnerParticipantRequestHandlers<Role extends RemoteParticipantRole> = Readonly<{
	lifecycle: ParticipantLifecycleHandlers;
	coordination: ParticipantCoordinationToolHandlers<Role>;
	presentation: OwnerParticipantPresentationHandlers;
}>;

export type OwnerParticipantPresentationHandlers = Readonly<{
	snapshot(): Promise<RemoteAgentSelectorSnapshot>;
	setReportRead(reportId: string, read: boolean): Promise<void>;
	select(
		action: RemoteAgentSelectorAction,
		signal: AbortSignal,
	): Promise<RemoteAgentSelectionResult>;
	addChangeHandler?(handler: (snapshot: RemoteAgentSelectorSnapshot) => void): () => void;
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
	coordination: ParticipantCoordinationToolHandlers<Role>;
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
	ParticipantCoordinationToolHandlers<"ordinary">,
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
		async toolExecutionStarted(input) {
			await request("runtime.toolExecutionStart", input);
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
		const coordination: ParticipantCoordinationToolHandlers<"ordinary"> = {
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
	const coordination: ParticipantCoordinationToolHandlers<"moderator"> = {
		...common,
		askUser: (toolCallId, input, signal) =>
			request("coordination.askHuman", { toolCallId, input }, signal),
		reportToUser: (toolCallId, input) => request("coordination.reportToUser", { toolCallId, input: { ...input, evidence: [...input.evidence] } }),
		moderatorControl: (toolCallId, input) =>
			request("coordination.moderatorControl", { toolCallId, input }),
	};
	return { lifecycle, coordination };
}

/** Dispatch one authenticated child intention into its scoped Owner handlers. */
export async function dispatchParticipantRequestToOwner(
	handlers:
		| OwnerParticipantRequestHandlers<"ordinary">
		| OwnerParticipantRequestHandlers<"moderator">
		| undefined,
	request: ControlRequest<typeof agentControlProtocol>,
	events?: Readonly<{
		waitProgress(toolCallId: string, progress: AgentWaitProgress): void;
	}>,
): Promise<unknown> {
	if (!handlers) throw new Error("child_runtime_owner_request_unavailable");
	assertValidRequest(request);
	let response: unknown;
	switch (request.method) {
		case "runtime.executionBegin":
			response = { frames: await handlers.lifecycle.executionStarted(request.payload.submissionSequence) };
			break;
		case "runtime.humanInput":
			response = {
				disposition: await handlers.lifecycle.humanInputSubmitted({
					text: request.payload.text,
					images: request.payload.images,
					submissionSequence: request.payload.submissionSequence,
				}),
			};
			break;
		case "runtime.primaryInputQueued":
			await handlers.lifecycle.primaryInputQueued();
			response = {};
			break;
		case "runtime.humanInputMode":
			response = { mode: await handlers.lifecycle.humanInputMode() };
			break;
		case "runtime.guardToolResult":
			response = {
				result: await handlers.lifecycle.toolResultCommitting({
					message: request.payload.message,
				}) ?? null,
			};
			break;
		case "runtime.toolExecutionStart":
			await handlers.lifecycle.toolExecutionStarted(request.payload);
			response = {};
			break;
		case "runtime.safeBoundary":
			await handlers.lifecycle.safeBoundaryReached();
			response = {};
			break;
		case "runtime.executionEnd":
			await handlers.lifecycle.executionEnded();
			response = {};
			break;
		case "coordination.observe":
			response = await handlers.coordination.observe(request.payload);
			break;
		case "coordination.message":
			response = await handlers.coordination.message(
				request.payload.toolCallId,
				request.payload.input,
			);
			break;
		case "coordination.wait":
			response = await handlers.coordination.wait(
				request.payload.toolCallId,
				request.payload.input,
				request.signal,
				(progress) => events?.waitProgress(request.payload.toolCallId, progress),
			);
			break;
		case "coordination.control":
			response = await handlers.coordination.control(
				request.payload.toolCallId,
				request.payload.input,
			);
			break;
		case "coordination.spawn":
			if (!("spawn" in handlers.coordination)) throw unavailableForRole(request.method);
			response = await handlers.coordination.spawn(
				request.payload.toolCallId,
				request.payload.input,
			);
			break;
		case "coordination.templateSnapshot":
			if (!("agentTemplateSnapshot" in handlers.coordination)) {
				throw unavailableForRole(request.method);
			}
			response = await handlers.coordination.agentTemplateSnapshot(request.payload.refresh);
			break;
		case "coordination.askHuman":
			if (!("askUser" in handlers.coordination)) throw unavailableForRole(request.method);
			response = await handlers.coordination.askUser(
				request.payload.toolCallId,
				request.payload.input,
				request.signal,
			);
			break;
		case "coordination.reportToUser":
			if (!("reportToUser" in handlers.coordination)) throw unavailableForRole(request.method);
			response = await handlers.coordination.reportToUser(request.payload.toolCallId, request.payload.input);
			break;
		case "presentation.reports.setRead":
			await handlers.presentation.setReportRead(request.payload.reportId, request.payload.read);
			response = {};
			break;
		case "coordination.moderatorControl":
			if (!("moderatorControl" in handlers.coordination)) throw unavailableForRole(request.method);
			response = await handlers.coordination.moderatorControl(
				request.payload.toolCallId,
				request.payload.input,
			);
			break;
		case "presentation.agents.snapshot":
			response = await handlers.presentation.snapshot();
			break;
		case "presentation.agents.select":
			response = await handlers.presentation.select(request.payload, request.signal);
			break;
		default:
			throw new Error(`child_runtime_owner_request_unavailable: ${request.method}`);
	}
	assertValidResponse(request.method, response);
	return response;
}

function assertValidRequest(request: ControlRequest<typeof agentControlProtocol>): void {
	const definition = agentControlMethods[request.method];
	if (!definition || !Check(definition.request, request.payload)) {
		throw new Error(`child_runtime_owner_request_invalid: ${request.method}`);
	}
}

function assertValidResponse(method: AgentControlMethod, response: unknown): void {
	if (!Check(agentControlMethods[method].response, response)) {
		throw new Error(`child_runtime_owner_response_invalid: ${method}`);
	}
}

function unavailableForRole(method: string): Error {
	return new Error(`child_runtime_owner_request_forbidden: ${method}`);
}
