import { WORKFLOW_RECOVERY_GUIDANCE, type WorkflowResumeReceipt } from "../protocol/workflow-resume.ts";
import { RuntimeThinkingSchema } from "../protocol/runtime-thinking-schema.ts";
import { boundedToolPreview } from "./bounded-preview.ts";
import { Text } from "@earendil-works/pi-tui";
import type { ReportToUserInput } from "../protocol/moderator-report.ts";
import { transcriptFromSessionManager } from "../pi-integration/session-manager-transcript.ts";
import { resolveCommittedToolCall } from "../protocol/identities.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

import type { AgentStatus } from "../coordination/agent-record.ts";
import type { AgentMessageReceipt } from "../coordination/message-receipts.ts";
import type { AgentLabelResolver } from "../presentation/agent-identity.ts";
import type { AgentSpawnReceipt } from "../coordination/spawning.ts";
import type { AgentMessageInput } from "../protocol/agent-message-input.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { OpenIncomingRequestList, RequestInspection } from "../protocol/request-inspection.ts";
import type {
	AgentWaitInput,
	AgentWaitProgress,
	AgentWaitResult,
} from "../protocol/agent-wait.ts";
import type { HumanAnswer, HumanRequestInput } from "../protocol/human-request.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import type { RunControlInput, RunControlReceipt } from "../protocol/run-control.ts";
import type { AgentTemplateCatalogueSnapshot } from "../templates/agent-templates.ts";
import { COORDINATION_HISTORY_GUIDANCE } from "../presentation/coordination-history-guidance.ts";
import {
	renderWorkflowResumeCall,
	renderWorkflowResumeResult,
	renderAgentControlCall,
	renderAgentControlResult,
	renderAgentObserveCall,
	renderAgentObserveResult,
	renderAgentWaitCall,
	renderAgentWaitResult,
	renderHumanRequestCall,
	renderHumanRequestResult,
	renderModeratorControlCall,
	renderModeratorControlResult,
} from "./coordination-renderers.ts";
import {
	renderAgentMessageCall,
	renderAgentMessageResult,
} from "./message-renderer.ts";
import {
	renderAgentSpawnCall,
	renderAgentSpawnResult,
} from "./spawn-renderer.ts";
import { renderAgentTemplatePromptGuide } from "./agent-template-prompt-guide.ts";

export type ParticipantCoordinationRole = "ordinary" | "moderator" | "owner";

/**
 * Tools this registrar activates for each role. The child bridge merges its own
 * role list at startup completion, so a Spawn exclusion filter can never leave a
 * participant unable to answer.
 */
export const participantCoordinationToolNames = {
	owner: [
		"workflow_resume",
		"agent_message",
		"agent_wait",
		"agent_spawn",
		"agent_observe",
		"agent_control",
	],
	ordinary: [
		"agent_message",
		"agent_wait",
		"agent_spawn",
		"agent_observe",
		"agent_control",
		"ask_user",
	],
	moderator: [
		"agent_message",
		"agent_wait",
		"agent_observe",
		"agent_control",
		"ask_user",
		"report_to_user",
		"moderator_control",
	],
} as const satisfies Record<ParticipantCoordinationRole, readonly string[]>;

const AGENT_MESSAGE_PROMPT_GUIDE = `<agent_message>
For send and request, targetAgent accepts an exact Agent label, full Agent ID, or unique Agent ID suffix. Full IDs and suffixes resolve Workflow-wide. Labels resolve only among the caller, its Direct Spawner, and its direct children; Owner and Moderator labels resolve Workflow-wide. An ambiguous target is rejected rather than guessed.

When agent_message returns messageStatus "sent", the Message was admitted for asynchronous Delivery and may still be queued; it does not mean delivered. An initial request returning "not_sent" creates no Request or dependency: correct the problem and author a new Request rather than retrying its correlation ID. "unknown" preserves uncertain admission; inspect the same identity. Later retry failures do not withdraw an admitted Request.

A delivered Agent Request, including a Creation Request, creates one Answer obligation. Every Request requires a short, specific title identifying the work; its full body remains authoritative. Request ordering controls attention, not execution order: choose which delivered unresolved Request to work on or answer.

${COORDINATION_HISTORY_GUIDANCE}

While any Answer obligation remains, agent_message operation "send" to its requester is rejected. Keep provisional findings local. Use "answer" for the curated result, or issue a reverse "request" when requester input or a decision is needed. Ordinary "send" to other Agents remains available.

agent_message operation "answer" requires requestId (any delivered unresolved Request ID or a unique case-sensitive suffix) and answer text. Use it as the only tool call in its turn. It resolves only the named obligation and ends the current model/tool loop. Any later continuation leaves the remaining work order to you. Do not add an assistant-message recap or summary.

An Answer receipt with disposition "committed" and delivery "omitted" resolves the local obligation without Answer Delivery because the original Request source is unavailable. It is not failed commitment, Delivery proof, or permission to repeat the work.

In your Answer, summarize completed work with enough context for the requester to avoid repeating it, e.g. relevant artifacts, checks or reviews already performed and their scope and outcomes, and remaining gaps.

agent_message operation "send" creates no Answer expectation. Continue normally and poll only when Delivery proof matters.
For poll/retry messageId and cancel requestMessageId, use the full ID or a unique case-sensitive suffix from your own earlier authored Messages (including Creation Requests). Ambiguous suffixes fail; use a longer suffix or the full ID. Receipts retain full canonical IDs.
</agent_message>`;

const AGENT_DELEGATION_PROMPT_GUIDE = `<agent_delegation>
When agent_message operation "request" or agent_spawn delegates work, partition it into bounded, non-overlapping work units before sending the Request.

Reuse an existing Agent with agent_message operation "request" only when context acquired through its earlier work materially reduces rediscovery. When useful, set contextPreparation with both workScale and contextDependence so the idle recipient can prepare a bounded working zone before Delivery. Omit it to keep ordinary Pi compaction behavior. Spawn a fresh Agent when prior context is not relevant to the new work.

After either tool returns requestMessageId with messageStatus "sent", the responder owns the delegated work until its Answer arrives or the Request is cancelled. Continue only explicitly disjoint work that would still be needed if the responder returned a complete, correct Answer. Otherwise end the turn. The runtime waits for turn-triggering input and continues the existing flow when it arrives. Intentional duplicate investigation is appropriate only when the Request explicitly asks for an independent cross-check.
</agent_delegation>`;

const AGENT_WAIT_PROMPT_GUIDE = `<agent_wait>
Use agent_wait when one next decision needs a set of Answers together. With no arguments it joins all your outstanding outbound Requests. Optional requestMessageIds selects a non-empty list of your authored Requests using full IDs or unique case-sensitive suffixes, not incoming obligations. Choose only dependencies that can progress without an Answer you still owe. If strict fan-in is unnecessary, let ordinary Answer Delivery reactivate you; do not poll or use Wait to monitor ordinary progress. Ordinary Messages do not satisfy Requests.

Primary interactive human input or eligible inbound delivery may preempt agent_wait. If it returns disposition "preempted", consider the new input and choose what needs attention next. Preemption consumes no Answers and creates no Answer Delivery proof. If a join is still needed, call agent_wait again with the desired selection; each call fixes a fresh snapshot.
</agent_wait>`;

const AGENT_SPAWN_PROMPT_GUIDE = `<agent_spawn>
A successful agent_spawn returns spawnStatus "created", confirming that the child exists. Its Creation Request requires its own title, independent of the Agent label, and follows the shared Agent Delegation rules.

Children have isolated context. Pass needed context explicitly in the Creation Request.
</agent_spawn>`;

const AGENT_OBSERVE_PROMPT_GUIDE = `<agent_observe>
For status, agentId accepts a full Agent ID, unique Workflow-wide ID suffix, or exact label within your observation scope. Labels do not grant additional observation authority; ambiguous selectors are rejected. Omit agentId to observe yourself.
To locate the transcript for the caller or an authorized Agent, use primaryEvidence.transcriptPath from an operation "status" result. A null path means the session is not file-backed.
</agent_observe>`;

const AGENT_CONTROL_PROMPT_GUIDE = `<agent_control>
agent_control operation "terminate" ends one exact Agent Run. It does not remove the durable Agent, cancel Agent Requests, affect descendants, or prevent a later successor Run. A terminate receipt's residualRequests reports the unresolved incoming and outgoing Request counts left on that Agent.

If termination abandons work from a Request you authored, use agent_message operation "cancel" with its requestMessageId before delegating replacement work or calling agent_wait. If the work remains needed, reactivate the same Agent with an ordinary Message instead. Do not assume Run termination resolves delegated work.
</agent_control>`;

export type AgentObservePhase = "starting" | "live" | "ending" | "dormant";

export type AgentObserveScope =
	| "authorized"
	| "direct_children"
	| Readonly<{ directSpawnerAgentId: string }>;

export type AgentSearchInput = Readonly<{
	operation: "search";
	scope: AgentObserveScope;
	query?: string;
	agentIdSuffix?: string;
	phase?: AgentObservePhase;
	limit?: number;
}>;

export type AgentObserveInput =
	| Readonly<{
		operation: "status";
		agentId?: string;
	}>
	| Readonly<{ operation: "obligations" }>
	| Readonly<{ operation: "request"; requestId: string }>
	| AgentSearchInput;

export type AgentSearchResult = Readonly<{
	matches: readonly AgentStatus[];
	hasMore: boolean;
}>;

export type AgentObserveResult = AgentStatus | AgentSearchResult | OpenIncomingRequestList | RequestInspection;

type CommonParticipantCoordinationToolHandlers = Readonly<{
	message(
		toolCallId: string,
		input: AgentMessageInput,
	): Promise<AgentMessageReceipt>;
	wait(
		toolCallId: string,
		input: AgentWaitInput,
		signal: AbortSignal | undefined,
		onProgress?: (progress: AgentWaitProgress) => void,
	): Promise<AgentWaitResult>;
	observe(input: AgentObserveInput): Promise<AgentObserveResult>;
	control(
		toolCallId: string,
		input: RunControlInput,
	): Promise<RunControlReceipt>;
}>;

type SpawnParticipantCoordinationToolHandler = Readonly<{
	spawn(toolCallId: string, input: AgentSpawnInput): Promise<AgentSpawnReceipt>;
	agentTemplateSnapshot(
		refresh?: boolean,
	): AgentTemplateCatalogueSnapshot | Promise<AgentTemplateCatalogueSnapshot>;
}>;

type HumanParticipantCoordinationToolHandler = Readonly<{
	askUser(
		toolCallId: string,
		input: HumanRequestInput,
		signal: AbortSignal | undefined,
	): Promise<HumanAnswer>;
}>;

export type ReportToUserReceipt = Readonly<{ reportId: string; createdAt: string }>;

type ModeratorParticipantCoordinationToolHandler = Readonly<{
	reportToUser(toolCallId: string, input: ReportToUserInput): Promise<ReportToUserReceipt>;
	moderatorControl(
		toolCallId: string,
		input: ModeratorControlInput,
	): Promise<ModeratorControlReceipt>;
}>;

export type ParticipantCoordinationToolHandlers<
	Role extends ParticipantCoordinationRole,
> = CommonParticipantCoordinationToolHandlers & (
	Role extends "ordinary"
		? SpawnParticipantCoordinationToolHandler & HumanParticipantCoordinationToolHandler
		: Role extends "moderator"
			? HumanParticipantCoordinationToolHandler & ModeratorParticipantCoordinationToolHandler
			: SpawnParticipantCoordinationToolHandler & Readonly<{ resumeWorkflow(toolCallId: string): Promise<WorkflowResumeReceipt> }>
);

const contextPreparationParameters = Type.Object(
	{
		workScale: Type.Union([
			Type.Literal("small"),
			Type.Literal("medium"),
			Type.Literal("large"),
		]),
		contextDependence: Type.Union([
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
		]),
	},
	{ additionalProperties: false },
);

const requestTitleParameters = Type.String({
	minLength: 1,
	pattern: "\\S",
	description: "Short, specific title identifying the Request. The full Request body remains authoritative.",
});

const messageDeliveryModeParameters = Type.Union([
	Type.Literal("deferred"),
	Type.Literal("steer"),
	Type.Literal("background"),
], {
	description: "deferred (default): Messages enter at settlement; Requests also enter at agent_wait, one at a time in FIFO order. steer: delivers an admission-ordered batch at the next safe boundary, after active generation and its tool batch finish, ahead of Deferred. Steer Messages, Requests, or Cancellations preempt agent_wait with the eligible Steer batch. background: enters only at settlement with no Answers owed and no eligible higher-priority delivery; never preempts agent_wait. Background Messages and Requests share FIFO order and may starve.",
});
// Project policy: tool declarations carry no resolution keywords ($id, $ref, $defs).
// Gemini rejects a reference inside a schema that declares $id, transports that strip
// definitions would leave references dangling, and strict constrained sampling rejects
// references outright. Inlining costs nothing on Gemini, which expands references per
// use site anyway.
const agentMessageParameters = objectRootUnion(Type.Union([
	Type.Object(
		{
			operation: Type.Literal("send"),
			targetAgent: Type.String({
				minLength: 1,
				description: "Exact Agent label, full Agent ID, or unique Agent ID suffix",
			}),
			content: Type.String({ minLength: 1 }),
			deliveryMode: Type.Optional(messageDeliveryModeParameters),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("request"),
			title: requestTitleParameters,
			targetAgent: Type.String({
				minLength: 1,
				description: "Exact Agent label, full Agent ID, or unique Agent ID suffix",
			}),
			question: Type.String({ minLength: 1 }),
			deliveryMode: Type.Optional(messageDeliveryModeParameters),
			contextPreparation: Type.Optional(contextPreparationParameters),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("answer"),
			requestId: Type.String({ minLength: 1 }),
			answer: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("cancel"),
			requestMessageId: Type.String({ minLength: 1, description: "Full Request Message ID or unique suffix among your earlier authored Messages." }),
			reason: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("poll"),
			messageId: Type.String({ minLength: 1, description: "Full Message ID or unique suffix among your earlier authored Messages." }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("retry"),
			messageId: Type.String({ minLength: 1, description: "Full Message ID or unique suffix among your earlier authored Messages." }),
		},
		{ additionalProperties: false },
	),
]));

const agentWaitParameters = Type.Object({
	requestMessageIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		description: "Select your outstanding authored Requests by full ID or unique case-sensitive suffix. Omit to wait for all.",
	})),
}, { additionalProperties: false });

const agentSpawnConfigurationParameters = Type.Object(
	{
		model: Type.Optional(
			Type.Object(
				{
					id: Type.Optional(Type.Union([
						Type.String({ pattern: "^[^/]+/.+$" }),
						Type.Literal("inherit"),
					], { description: 'Omit to use the selected Template model, else the parent model. "inherit" always uses the parent model.' })),
					thinking: Type.Optional(Type.Union([
						RuntimeThinkingSchema,
						Type.Literal("inherit"),
					], { description: 'Omit to use the selected Template thinking level, else the parent thinking level. "inherit" always uses the parent thinking level.' })),
				},
				{ additionalProperties: false },
			),
		),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		excludeTools: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				uniqueItems: true,
				description: "Names removed from the child's own default tool surface, after any Template exclusion. Absent names change nothing, and the child keeps its role tools.",
			}),
		),
		excludeSkills: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				uniqueItems: true,
				description: "Names removed from the skills the child discovers for its own working directory and agent directory, after any Template exclusion.",
			}),
		),
		extensions: Type.Optional(
			Type.Union([
				Type.Literal("inherit"),
				Type.Literal("none"),
			]),
		),
		systemPrompt: Type.Optional(Type.String()),
		systemPromptMode: Type.Optional(
			Type.Union([Type.Literal("append"), Type.Literal("replace")]),
		),
		loadContextFiles: Type.Optional(Type.Boolean({
			description: "Load trusted project instruction files such as AGENTS.md and CLAUDE.md; this does not inherit the parent conversation.",
		})),
	},
	{ additionalProperties: false },
);

const agentSpawnParameters = Type.Object(
	{
		title: requestTitleParameters,
		request: Type.String({ minLength: 1 }),
		template: Type.Optional(
			Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
		),
		label: Type.Optional(Type.String({ minLength: 1 })),
		description: Type.Optional(Type.String({
			minLength: 1,
			description: "Brief scope summary for display and Agent search; not task instructions.",
		})),
		config: Type.Optional(agentSpawnConfigurationParameters),
	},
	{ additionalProperties: false },
);

const agentObservePhase = Type.Union([
	Type.Literal("starting"),
	Type.Literal("live"),
	Type.Literal("ending"),
	Type.Literal("dormant"),
]);
// The pattern only rejects whitespace-only inputs; search matching remains substring-based.
const agentSearchNonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
const agentSearchQuery = Type.String({
	...agentSearchNonBlankString,
	description: "Case-insensitive literal substring matched against Agent label or description. No wildcard or regex matching. Omit to search using other filters; authorized scope requires at least one of query, agentIdSuffix, or phase.",
});
const agentSearchOptionalProperties = {
	query: Type.Optional(agentSearchQuery),
	agentIdSuffix: Type.Optional(agentSearchNonBlankString),
	phase: Type.Optional(agentObservePhase),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
const agentSearchDirectChildrenParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Literal("direct_children"),
		...agentSearchOptionalProperties,
	},
	{ additionalProperties: false },
);
const agentSearchNamedSpawnerParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Object(
			{ directSpawnerAgentId: agentSearchNonBlankString },
			{ additionalProperties: false },
		),
		...agentSearchOptionalProperties,
	},
	{ additionalProperties: false },
);
const agentSearchAuthorizedQueryParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Literal("authorized"),
		...agentSearchOptionalProperties,
		query: agentSearchQuery,
	},
	{ additionalProperties: false },
);
const agentSearchAuthorizedSuffixParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Literal("authorized"),
		...agentSearchOptionalProperties,
		agentIdSuffix: agentSearchNonBlankString,
	},
	{ additionalProperties: false },
);
const agentSearchAuthorizedPhaseParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Literal("authorized"),
		...agentSearchOptionalProperties,
		phase: agentObservePhase,
	},
	{ additionalProperties: false },
);
const agentObserveParameters = objectRootUnion(Type.Union([
	Type.Object(
		{ operation: Type.Literal("obligations") },
		{ additionalProperties: false, description: "List the caller's outstanding Requests by ID, requester, and title." },
	),
	Type.Object(
		{
			operation: Type.Literal("request"),
			requestId: Type.String({ minLength: 1, pattern: "\\S", description: "Full Request ID or unique suffix among Requests you authored or received, including closed Requests. Returns the complete Request body." }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("status"),
			agentId: Type.Optional(Type.String({
				minLength: 1,
				description: "Full Agent ID, unique Workflow-wide ID suffix, or exact label within your observation scope. Omit to observe the calling Agent.",
			})),
		},
		{ additionalProperties: false },
	),
	agentSearchDirectChildrenParameters,
	agentSearchNamedSpawnerParameters,
	agentSearchAuthorizedQueryParameters,
	agentSearchAuthorizedSuffixParameters,
	agentSearchAuthorizedPhaseParameters,
]));

const agentControlParameters = objectRootUnion(Type.Union([
	Type.Object(
		{
			operation: Type.Literal("interrupt"),
			agentId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("resume"),
			agentId: Type.String({ minLength: 1 }),
			content: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("terminate"),
			agentId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]));

const askUserParameters = Type.Object(
	{
		question: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const evidencePointer = Type.Union([
	Type.Object(
		{
			agentId: Type.String({ minLength: 1 }),
			entryId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			agentId: Type.String({ minLength: 1 }),
			entryId: Type.String({ minLength: 1 }),
			toolCallId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

const moderatorControlParameters = objectRootUnion(Type.Union([
	Type.Object(
		{
			operation: Type.Literal("renew_review_deadline"),
			toolCall: Type.Object(
				{
					agentId: Type.String({ minLength: 1 }),
					entryId: Type.String({ minLength: 1 }),
					toolCallId: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
			nextReviewInMs: Type.Integer({ minimum: 1 }),
			rationale: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("resolve"),
			summary: Type.String({ minLength: 1 }),
			rationale: Type.String({ minLength: 1 }),
			evidencePointers: Type.Optional(Type.Array(evidencePointer)),
		},
		{ additionalProperties: false },
	),
]));

const reportToUserParameters = Type.Object({
	symptom: Type.String({ minLength: 1, description: "Observed runtime malfunction." }),
	suspectedDefect: Type.String({ minLength: 1, description: "Why the evidence suggests a runtime defect rather than expected behavior." }),
	uncertainty: Type.String({ minLength: 1, description: "What remains unknown or unproven." }),
	recoveryActions: Type.String({ minLength: 1, description: "Investigation and autonomous recovery actions attempted." }),
	recoveryOutcome: Type.String({ minLength: 1, description: "Observed recovery outcome, including unresolved work." }),
	evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Exact transcript, entry, tool-call, diagnostic or other preserved evidence references." }),
}, { additionalProperties: false });

const workflowResumeParameters = Type.Object({}, { additionalProperties: false });

export const participantCoordinationToolSchemas = {
	workflow_resume: workflowResumeParameters,
	agent_message: agentMessageParameters,
	agent_wait: agentWaitParameters,
	agent_spawn: agentSpawnParameters,
	agent_observe: agentObserveParameters,
	agent_control: agentControlParameters,
	ask_user: askUserParameters,
	moderator_control: moderatorControlParameters,
	report_to_user: reportToUserParameters,
} as const;

type AvailableHandlers = CommonParticipantCoordinationToolHandlers &
	Partial<SpawnParticipantCoordinationToolHandler> &
	Partial<HumanParticipantCoordinationToolHandler> &
	Partial<ModeratorParticipantCoordinationToolHandler> &
	Readonly<{ resumeWorkflow?(toolCallId: string): Promise<WorkflowResumeReceipt> }>;

export function registerParticipantCoordinationTools<
	Role extends ParticipantCoordinationRole,
>(
	pi: ExtensionAPI,
	role: Role,
	handlers: ParticipantCoordinationToolHandlers<Role>,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
	agentTemplateSnapshot?: AgentTemplateCatalogueSnapshot,
	resolveAnswerTargetAgent?: (toolCallId: string) => string | undefined,
): void {
	const availableHandlers = handlers as AvailableHandlers;
	if (role === "owner") {
		pi.registerTool({
			name: "workflow_resume",
			label: "Resume Workflow",
			description: "Owner only: resume the current Workflow from a verified durable snapshot, scheduling eligible pending Messages and continuing dormant responders with unanswered Requests.",
			promptSnippet: "Resume unfinished coordination after restart.",
			promptGuidelines: [
				WORKFLOW_RECOVERY_GUIDANCE,
				"Interrupted tools and volatile Wait calls are not restored; inspect side effects before repeating interrupted work.",
			],
			executionMode: "sequential",
			parameters: workflowResumeParameters,
			renderCall: renderWorkflowResumeCall,
			renderResult: renderWorkflowResumeResult,
			async execute(toolCallId) {
				return toolResult(await availableHandlers.resumeWorkflow!(toolCallId));
			},
		});
	}

	pi.registerTool<typeof agentMessageParameters, AgentMessageReceipt>({
		name: "agent_message",
		label: "Message Agent",
		description:
			"Send one immutable Message or correlated Request to a known Agent in this Workflow.",
		promptSnippet: "Send, request, answer, cancel, poll, or retry direct Agent communication.",
		promptGuidelines: [
			AGENT_MESSAGE_PROMPT_GUIDE,
			AGENT_DELEGATION_PROMPT_GUIDE,
		],
		executionMode: "sequential",
		parameters: agentMessageParameters,
		renderCall: (args, _theme, context) =>
			renderAgentMessageCall(
				args,
				_theme,
				resolveAgentLabel,
				context.expanded,
				args.operation === "answer"
					? resolveAnswerTargetAgent?.(context.toolCallId)
					: undefined,
			),
		renderResult: renderAgentMessageResult,
		async execute(toolCallId, parameters, _signal, _onUpdate, ctx) {
			if (parameters.operation !== "answer") return toolResult(await availableHandlers.message(toolCallId, parameters));
			const transcript = transcriptFromSessionManager(ctx.sessionManager).inspect();
			const agentId = ctx.sessionManager.getSessionId();
			const { source } = resolveCommittedToolCall({ agentId, transcript, toolCallId, toolName: "agent_message" });
			const entry = transcript.entries.find(entry => entry.id === source.entryId);
			// Pi's terminate hint ends a batch only when every result requests it.
			// A standalone Answer prevents a redundant follow-up summary after the final result.
			if (entry?.type === "message" && entry.message.role === "assistant" &&
				entry.message.content.filter(part => part.type === "toolCall").length !== 1) {
				throw new Error("invalid_input: Answer must be the only tool call in its turn");
			}
			const receipt = await availableHandlers.message(toolCallId, parameters);
			if (!("messageStatus" in receipt) || !("requestMessageId" in receipt)) return toolResult(receipt);
			return { ...toolResult(receipt), terminate: true };
		},
	});
	pi.registerTool<typeof agentWaitParameters, AgentWaitResult | AgentWaitProgress>({
		name: "agent_wait",
		label: "Wait for Answers",
		description:
			"Join all or selected outstanding outbound Requests' Answers. Renew missing Request delivery scheduling without duplicates; primary human input or eligible inbound delivery may preempt.",
		promptSnippet:
			"Wait for all your outstanding outbound Requests, or select requestMessageIds by full ID or unique suffix.",
		promptGuidelines: [AGENT_WAIT_PROMPT_GUIDE],
		executionMode: "sequential",
		parameters: agentWaitParameters,
		renderCall: (args, theme, context) => renderAgentWaitCall(args, theme, context.expanded),
		renderResult: (result, options, theme, context) =>
			renderAgentWaitResult(
				result,
				options,
				theme,
				context,
				resolveAgentLabel,
			),
		async execute(toolCallId, parameters, signal, onUpdate) {
			return toolResult(
				await availableHandlers.wait(
					toolCallId,
					parameters,
					signal,
					(progress) => onUpdate?.({
						content: [{
							type: "text",
							text: `Waiting for ${progress.waitingFor.length} Agent Answer${
								progress.waitingFor.length === 1 ? "" : "s"
							}.`,
						}],
						details: progress,
					}),
				),
			);
		},
	});
	if (role !== "moderator") {
		pi.registerTool<typeof agentSpawnParameters, AgentSpawnReceipt>({
			name: "agent_spawn",
			label: "Spawn Agent",
			description:
				"Create one fresh durable child Agent with isolated context, then deliver its initial Creation Request.",
			promptSnippet: "Create a fresh child Agent with isolated context.",
			promptGuidelines: [
				AGENT_SPAWN_PROMPT_GUIDE,
				AGENT_DELEGATION_PROMPT_GUIDE,
				...(agentTemplateSnapshot === undefined
					? []
					: [renderAgentTemplatePromptGuide(agentTemplateSnapshot)]),
			],
			executionMode: "sequential",
			parameters: agentSpawnParameters,
			renderCall: (args, theme, context) =>
				renderAgentSpawnCall(args, theme, context.expanded),
			renderResult: renderAgentSpawnResult,
			async execute(toolCallId, parameters) {
				return toolResult(await availableHandlers.spawn!(toolCallId, parameters));
			},
		});
	}

	pi.registerTool<typeof agentObserveParameters, AgentObserveResult>({
		name: "agent_observe",
		label: "Observe Agent",
		description: role === "moderator"
			? "Passively observe Workflow Agents, search authorized Agent scopes, or inspect your Request obligations."
			: "Passively observe authorized Agents, search their metadata, or inspect your Request obligations.",
		promptSnippet: role === "moderator"
			? "Pull Agent status/search results and inspect Request obligations."
			: "Observe Agent status/search and inspect Request obligations.",
		promptGuidelines: [AGENT_OBSERVE_PROMPT_GUIDE],
		executionMode: "sequential",
		parameters: agentObserveParameters,
		renderCall: (args, theme, context) =>
			renderAgentObserveCall(args, theme, resolveAgentLabel, context.expanded),
		renderResult: (result, options, theme, context) =>
			renderAgentObserveResult(result, options, theme, context, resolveAgentLabel),
		async execute(_toolCallId, parameters) {
			return toolResult(await availableHandlers.observe(parameters));
		},
	});
	pi.registerTool<typeof agentControlParameters, RunControlReceipt>({
		name: "agent_control",
		label: "Control Agent Run",
		description:
			"Interrupt, explicitly resume, or terminate one authorized exact Agent Run.",
		promptSnippet: role === "moderator"
			? "Supervise any current non-Owner Run needed to restore safe progress."
			: "Supervise an immediate child Run, or any non-Owner Run when acting as Workflow Owner.",
		promptGuidelines: [AGENT_CONTROL_PROMPT_GUIDE],
		executionMode: "sequential",
		parameters: agentControlParameters,
		renderCall: (args, theme, context) =>
			renderAgentControlCall(args, theme, resolveAgentLabel, context.expanded),
		renderResult: (result, options, theme) =>
			renderAgentControlResult(result, options, theme, resolveAgentLabel),
		async execute(toolCallId, parameters) {
			return toolResult(await availableHandlers.control(toolCallId, parameters));
		},
	});
	if (role !== "owner") {
		pi.registerTool<typeof askUserParameters, HumanAnswer>({
			name: "ask_user",
			label: "Ask User",
			description:
				"Ask the human one nonblank free-form question and wait for one nonblank free-form Answer.",
			promptSnippet:
				"Block until the human supplies judgment through this Agent's native editor.",
			executionMode: "sequential",
			parameters: askUserParameters,
			renderShell: "self",
			renderCall: renderHumanRequestCall,
			renderResult: renderHumanRequestResult,
			async execute(toolCallId, parameters, signal) {
				return toolResult(
					await availableHandlers.askUser!(toolCallId, parameters, signal),
				);
			},
		});
	}

	if (role === "moderator") {
		pi.registerTool<typeof reportToUserParameters, ReportToUserReceipt>({
			name: "report_to_user",
			label: "Report to User",
			description: "Preserve an immutable suspected runtime defect report in the human Attention Inbox. Returns immediately without human acknowledgment; does not close an incident or settle an Answer obligation.",
			promptSnippet: "Report suspected runtime defects nonblocking after investigation and autonomous recovery attempts.",
			promptGuidelines: [
				"Before report_to_user, investigate, preserve exact evidence, and attempt safe autonomous recovery. Distinguish suspected defects from uncertainty and record recovery outcomes.",
				"Before claiming a missing result or crash, obtain current Agent status and read its primaryEvidence.transcriptPath. Match the exact toolCallId to its matching toolResult across the physical transcript, and verify the current physical transcript tail, including entry ID and timestamp. inspectedThrough is an earlier observation, not a current end-of-file guarantee; a selected branch or truncated excerpt is not the full transcript.",
				"Record the exact call/result and verified tail references and what was actually inspected. A missing result alone does not prove a crash. State claims as unverified when current primary evidence is unavailable; do not convert an earlier report or scheduling diagnostic into a confirmed runtime cause.",
				"Use report_to_user, not ask_user, for end-of-investigation runtime defect reporting. Reporting never resolves an unresolved incident or discharges an Answer obligation; use moderator_control only when its resolution predicates clear.",
			],
			executionMode: "sequential",
			parameters: reportToUserParameters,
			renderCall: (args, theme) => new Text(theme.fg("toolTitle", "Report to User") + " " + boundedToolPreview(args.symptom ?? ""), 0, 0),
			renderResult: (result, _options, theme, context) => new Text(theme.fg(
				context.isError ? "error" : result.details ? "success" : "muted",
				!context.isError && result.details
					? `Report retained · ${result.details.reportId}`
					: boundedToolPreview(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")),
			), 0, 0),
			async execute(toolCallId, parameters) {
				return toolResult(await availableHandlers.reportToUser!(toolCallId, parameters));
			},
		});
		pi.registerTool<typeof moderatorControlParameters, ModeratorControlReceipt>({
			name: "moderator_control",
			label: "Control Moderation",
			description:
				"Renew an exact Operation Review interval or resolve handling after every mechanically checkable predicate clears. A Run Failure clears as soon as a successor Run starts; any remaining Answer Obligation is ordinary Workflow work.",
			promptSnippet:
				"Renew an exact reviewed call deliberately, or resolve immediately when the original condition clears.",
			executionMode: "sequential",
			parameters: moderatorControlParameters,
			renderCall: renderModeratorControlCall,
			renderResult: renderModeratorControlResult,
			async execute(toolCallId, parameters) {
				return toolResult(
					await availableHandlers.moderatorControl!(toolCallId, parameters),
				);
			},
		});
	}
}

function toolResult<Details>(details: Details): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
	};
}

function objectRootUnion<T extends TSchema>(schema: T): T {
	// DeepSeek validates the function schema root before evaluating its variants.
	// Keep TypeBox's discriminated union for Pi validation while exposing the
	// object root required by OpenAI-compatible providers.
	return Object.assign(schema, { type: "object" as const });
}
