import { Type, type Static, type TSchema } from "typebox";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";

import type { AgentStatus } from "../coordination/agent-record.ts";
import { NATIVE_RUN_OUTCOMES, type NativeRunEnd } from "../pi-integration/native-session-driver.ts";
import { RuntimeThinkingSchema } from "../protocol/runtime-thinking-schema.ts";
import type { AgentControlProtocol, DeepReadonly } from "./agent-control-channel.ts";
import { bindEquivalent, bindPiOwned, bindToolInput } from "./schema-conformance.ts";
import type { AgentMessageReceipt } from "../coordination/message-receipts.ts";
import type { AgentSpawnReceipt } from "../coordination/spawning.ts";
import type { AgentMessageInput } from "../protocol/agent-message-input.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { AgentWaitInput, AgentWaitProgress, AgentWaitResult } from "../protocol/agent-wait.ts";
import type { HumanAnswer, HumanRequestInput } from "../protocol/human-request.ts";
import {
	MODERATOR_ROUTINE_START_CUSTOM_TYPE,
	MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE,
	OBLIGATION_REMINDER_CUSTOM_TYPE,
	RUN_FAILURE_RECOVERY_CUSTOM_TYPE,
	WORKFLOW_CONTINUATION_CUSTOM_TYPE,
	DELIVERY_FAILURE_CUSTOM_TYPE,
	RUN_SUSPENSION_NOTICE_CUSTOM_TYPE,
} from "../protocol/custom-entry-types.ts";
import { MESSAGE_DELIVERY_CUSTOM_TYPE } from "../protocol/message-delivery.ts";
import { MODERATOR_ROUTINE_START_INSTRUCTION } from "../protocol/moderator-input.ts";
import type { ModeratorControlInput, ModeratorControlReceipt } from "../protocol/moderator-control.ts";
import type { ReportToUserInput, ReportToUserReceipt } from "../protocol/moderator-report.ts";
import type { RunControlInput, RunControlReceipt } from "../protocol/run-control.ts";
import { AgentTemplateCatalogueSnapshotSchema } from "./control-protocol-schemas.ts";
import {
	coordinationToolSchemas,
	type AgentObserveInput,
	type AgentObserveResult,
} from "../tools/coordination-tool-catalogue.ts";

const closed = <const P extends Parameters<typeof Type.Object>[0]>(properties: P) =>
	Type.Object(properties, { additionalProperties: false });
// Pi owns message, content, and usage shapes and adds optional fields across
// releases (for example providerThinkingLevel, thinkingLevel, nestedCalls). The
// trust-based protocol checks the fields it relies on and carries the rest, so a
// Pi upgrade cannot fail a child's guard over a field this package never reads.
const piOwned = <const P extends Parameters<typeof Type.Object>[0]>(properties: P) =>
	Type.Object(properties);
const EmptySchema = closed({});
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const PreparationErrorSchema = Type.String({ minLength: 1, maxLength: 2_000 });
const StringListSchema = Type.Array(NonEmptyStringSchema, { uniqueItems: true });
const StringQueueSchema = Type.Array(Type.String());
const AcknowledgementSchema = closed({ accepted: Type.Boolean() });
const QueuedInputCountSchema = Type.Integer({ minimum: 0 });
const RunOutcomeSchema = Type.Enum(NATIVE_RUN_OUTCOMES);
const DeliveryModeSchema = Type.Union([
	Type.Literal("steer"),
	Type.Literal("followUp"),
]);
const TextContentSchema = piOwned({
	type: Type.Literal("text"),
	text: Type.String(),
	textSignature: Type.Optional(Type.String()),
});
const ImageContentSchema = piOwned({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: NonEmptyStringSchema,
});
const ImageListSchema = Type.Array(ImageContentSchema);
const EmptyResponseSchema = closed({});
const EntryPointerSchema = closed({
	agentId: NonEmptyStringSchema,
	entryId: NonEmptyStringSchema,
});
const ToolCallPointerSchema = closed({
	agentId: NonEmptyStringSchema,
	entryId: NonEmptyStringSchema,
	toolCallId: NonEmptyStringSchema,
});
const ToolContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
const ThinkingContentSchema = piOwned({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	thinkingSignature: Type.Optional(Type.String()),
	redacted: Type.Optional(Type.Boolean()),
});
const NativeToolCallSchema = piOwned({
	type: Type.Literal("toolCall"),
	id: NonEmptyStringSchema,
	name: NonEmptyStringSchema,
	arguments: Type.Record(Type.String(), Type.Unknown()),
	thoughtSignature: Type.Optional(Type.String()),
});
const UsageSchema = piOwned({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	cacheWrite1h: Type.Optional(Type.Number()),
	reasoning: Type.Optional(Type.Number()),
	totalTokens: Type.Number(),
	cost: piOwned({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		total: Type.Number(),
	}),
});
// Pi 0.86 carries a leading system message plus mid-conversation prompt and tool
// updates in the transcript, so `message_end` fires for role "system" too.
const ToolDeclarationSchema = piOwned({
	name: NonEmptyStringSchema,
	description: Type.String(),
	parameters: Type.Record(Type.String(), Type.Unknown()),
	constrainedSampling: Type.Optional(Type.Unknown()),
});
const ToolReferenceSchema = piOwned({ name: NonEmptyStringSchema });
const PromptSectionsSchema = Type.Record(
	Type.String(),
	Type.Union([Type.String(), Type.Null()]),
);
const AgentMessageSchema = bindPiOwned<MessageEndEvent["message"]>()(Type.Union([
	piOwned({
		role: Type.Literal("system"),
		content: Type.Union([Type.String(), Type.Array(TextContentSchema)]),
		sections: Type.Optional(PromptSectionsSchema),
		toolsAdded: Type.Optional(Type.Array(ToolDeclarationSchema)),
		toolsRemoved: Type.Optional(Type.Array(ToolReferenceSchema)),
		timestamp: Type.Number(),
	}),
	piOwned({
		role: Type.Literal("user"),
		content: Type.Union([Type.String(), Type.Array(ToolContentSchema)]),
		timestamp: Type.Number(),
	}),
	piOwned({
		role: Type.Literal("assistant"),
		content: Type.Array(Type.Union([TextContentSchema, ThinkingContentSchema, NativeToolCallSchema])),
		api: NonEmptyStringSchema,
		provider: NonEmptyStringSchema,
		model: NonEmptyStringSchema,
		responseModel: Type.Optional(Type.String()),
		responseId: Type.Optional(Type.String()),
		diagnostics: Type.Optional(Type.Array(Type.Unknown())),
		usage: UsageSchema,
		stopReason: Type.Union([
			Type.Literal("pending"), Type.Literal("stop"), Type.Literal("length"),
			Type.Literal("toolUse"), Type.Literal("error"), Type.Literal("aborted"),
			Type.Literal("deferred"),
		]),
		deferred: Type.Optional(Type.Unknown()),
		errorMessage: Type.Optional(Type.String()),
		rawStopReason: Type.Optional(Type.String()),
		timestamp: Type.Number(),
	}),
	piOwned({
		role: Type.Literal("toolResult"),
		toolCallId: NonEmptyStringSchema,
		toolName: NonEmptyStringSchema,
		content: Type.Array(ToolContentSchema),
		details: Type.Optional(Type.Unknown()),
		usage: Type.Optional(UsageSchema),
		addedToolNames: Type.Optional(StringListSchema),
		isError: Type.Boolean(),
		timestamp: Type.Number(),
	}),
	piOwned({
		role: Type.Literal("bashExecution"),
		command: Type.String(),
		output: Type.String(),
		exitCode: Type.Optional(Type.Integer()),
		cancelled: Type.Boolean(),
		truncated: Type.Boolean(),
		fullOutputPath: Type.Optional(Type.String()),
		timestamp: Type.Number(),
		excludeFromContext: Type.Optional(Type.Boolean()),
	}),
	piOwned({
		role: Type.Literal("custom"),
		customType: NonEmptyStringSchema,
		content: Type.Union([Type.String(), Type.Array(ToolContentSchema)]),
		display: Type.Boolean(),
		details: Type.Optional(Type.Unknown()),
		timestamp: Type.Number(),
	}),
	piOwned({
		role: Type.Literal("branchSummary"),
		summary: Type.String(),
		fromId: Type.Union([NonEmptyStringSchema, Type.Null()]),
		timestamp: Type.Number(),
	}),
	piOwned({
		role: Type.Literal("compactionSummary"),
		summary: Type.String(),
		tokensBefore: Type.Number(),
		timestamp: Type.Number(),
	}),
]));
const GuardedHumanToolResultSchema = closed({
	message: Type.Optional(AgentMessageSchema),
	rejectedAnswer: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
});
const RetentionReasonSchema = Type.Union([
	Type.Literal("owner_host_binding"), Type.Literal("pending_delivery"),
	Type.Literal("awaiting_answer"), Type.Literal("answer_owed"),
	Type.Literal("interruption_hold"), Type.Literal("moderator_handling"),
	Type.Literal("interactive_selection"),
]);
const RetentionSchema = closed({ reason: RetentionReasonSchema, count: Type.Integer({ minimum: 1 }) });
const RunFailureEvidenceSchema = closed({
	stage: Type.String(),
	error: Type.String(),
	provenance: Type.String(),
});
// The native session driver defines the Run-outcome vocabulary; the wire carries it as-is.
const RunEndSchema = bindEquivalent<NativeRunEnd & Readonly<{ runId: string; queuedInputCount: number }>>()(closed({
	runId: NonEmptyStringSchema,
	outcome: RunOutcomeSchema,
	willRetry: Type.Boolean(),
	queuedInputCount: QueuedInputCountSchema,
	failure: Type.Optional(RunFailureEvidenceSchema),
}));
const AgentRunSuspensionSchema = closed({
	reason: Type.Literal("runtime_error"),
	evidence: RunFailureEvidenceSchema,
});
const AgentRunStateSchema = Type.Union([
	closed({
		phase: Type.Literal("dormant"),
		retentionReasons: Type.Tuple([]),
		queued: Type.Optional(Type.Literal(true)),
	}),
	closed({
		phase: Type.Union([Type.Literal("starting"), Type.Literal("live"), Type.Literal("ending")]),
		work: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("settled")])),
		attention: Type.Union([
			Type.Literal("none"),
			Type.Literal("input_required"),
			Type.Literal("agent_wait"),
		]),
		retentionReasons: Type.Array(RetentionSchema),
		suspension: Type.Optional(AgentRunSuspensionSchema),
	}),
]);
const AgentStatusProperties = {
	agentId: NonEmptyStringSchema,
	workflowId: NonEmptyStringSchema,
	label: NonEmptyStringSchema,
	description: Type.Optional(Type.String()),
	directSpawnerAgentId: Type.Union([NonEmptyStringSchema, Type.Null()]),
	primaryEvidence: closed({
		transcriptPath: Type.Union([NonEmptyStringSchema, Type.Null()]),
		inspectedThrough: EntryPointerSchema,
	}),
	run: AgentRunStateSchema,
} as const;
const AgentStatusSchema = bindEquivalent<AgentStatus>()(closed(AgentStatusProperties));
const AgentRosterStatusSchema = closed({
	...AgentStatusProperties,
	model: closed({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }),
	thinking: RuntimeThinkingSchema,
	compacting: Type.Boolean(),
	queuedInputCount: QueuedInputCountSchema,
});
const OpenIncomingRequestProperties = {
	requestMessageId: NonEmptyStringSchema,
	requesterAgentId: NonEmptyStringSchema,
	title: Type.String({ minLength: 1, pattern: "\\S" }),
} as const;
const AgentObserveResultSchema = bindEquivalent<AgentObserveResult>()(Type.Union([
	AgentStatusSchema,
	closed({ requests: Type.Array(closed(OpenIncomingRequestProperties)) }),
	closed({
		...OpenIncomingRequestProperties,
		responderAgentId: NonEmptyStringSchema,
		question: Type.String(),
	}),
	closed({
		matches: Type.Array(AgentStatusSchema, { maxItems: 50 }),
		hasMore: Type.Boolean(),
	}),
]));
const EffectiveConfigurationSchema = closed({
	cwd: NonEmptyStringSchema,
	model: closed({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }),
	thinking: RuntimeThinkingSchema,
	excludeTools: StringListSchema,
	excludeSkills: StringListSchema,
	skills: StringListSchema,
	extensions: StringListSchema,
	systemPrompt: Type.Optional(closed({
		mode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
		body: Type.String(),
	})),
	loadContextFiles: Type.Boolean(),
});
const AgentSpawnReceiptSchema = bindEquivalent<AgentSpawnReceipt>()(Type.Union([
	closed({
		spawnStatus: Type.Literal("created"), agentId: NonEmptyStringSchema,
		requestMessageId: NonEmptyStringSchema, messageStatus: Type.Literal("sent"),
		effectiveConfiguration: EffectiveConfigurationSchema,
	}),
	closed({
		spawnStatus: Type.Literal("created"), agentId: NonEmptyStringSchema,
		requestMessageId: NonEmptyStringSchema, messageStatus: Type.Literal("not_sent"),
		failedStage: Type.Union([Type.Literal("run_start"), Type.Literal("delivery_admission")]),
		reason: NonEmptyStringSchema,
		effectiveConfiguration: EffectiveConfigurationSchema,
	}),
	closed({
		spawnStatus: Type.Literal("not_created"),
		failedStage: Type.Union([
			Type.Literal("configuration"),
			Type.Literal("identity_commit"),
		]),
		reason: NonEmptyStringSchema,
	}),
	closed({
		spawnStatus: Type.Literal("unknown"),
		candidateAgentId: Type.Optional(NonEmptyStringSchema),
		candidateRequestMessageId: Type.Optional(NonEmptyStringSchema),
		lastConfirmedStage: Type.Optional(Type.Union([Type.Literal("identity"), Type.Literal("run_start")])),
		effectiveConfiguration: Type.Optional(EffectiveConfigurationSchema),
	}),
]));
const MessageSendRejectionReasonSchema = Type.Union([
	Type.Literal("target_unavailable"), Type.Literal("host_shutting_down"),
	Type.Literal("capacity_exhausted"),
]);
const MessageNotSentReasonSchema = Type.Union([
	MessageSendRejectionReasonSchema,
	Type.Literal("evidence_unavailable"),
	Type.Literal("policy_rejected"),
]);
const MessageUnknownReasonSchema = Type.Union([
	Type.Literal("confirmation_lost"),
	Type.Literal("inspection_incomplete"),
]);
const AgentMessageReceiptSchema = bindEquivalent<AgentMessageReceipt>()(Type.Union([
	closed({
		disposition: Type.Literal("rejected"),
		reason: Type.Literal("answer_required"),
		requestMessageId: NonEmptyStringSchema,
	}),
	closed({
		messageId: NonEmptyStringSchema,
		targetAgentId: NonEmptyStringSchema,
		messageStatus: Type.Literal("sent"),
	}),
	closed({
		messageId: NonEmptyStringSchema,
		targetAgentId: NonEmptyStringSchema,
		messageStatus: Type.Literal("not_sent"),
		reason: MessageNotSentReasonSchema,
	}),
	closed({
		messageId: NonEmptyStringSchema,
		targetAgentId: NonEmptyStringSchema,
		messageStatus: Type.Literal("unknown"),
		reason: MessageUnknownReasonSchema,
	}),
	closed({
		requestMessageId: NonEmptyStringSchema,
		targetAgentId: NonEmptyStringSchema,
		messageStatus: Type.Literal("sent"),
	}),
	closed({
		requestMessageId: NonEmptyStringSchema,
		targetAgentId: NonEmptyStringSchema,
		messageStatus: Type.Literal("not_sent"),
		reason: MessageNotSentReasonSchema,
	}),
	closed({
		requestMessageId: NonEmptyStringSchema,
		targetAgentId: NonEmptyStringSchema,
		messageStatus: Type.Literal("unknown"),
		reason: MessageUnknownReasonSchema,
	}),
	closed({
		messageId: NonEmptyStringSchema, requestMessageId: NonEmptyStringSchema, requestTitle: NonEmptyStringSchema,
		messageStatus: Type.Literal("sent"),
	}),
	closed({
		messageId: NonEmptyStringSchema, requestMessageId: NonEmptyStringSchema, requestTitle: NonEmptyStringSchema,
		messageStatus: Type.Literal("not_sent"), reason: MessageSendRejectionReasonSchema,
	}),
	closed({
		messageId: NonEmptyStringSchema, requestMessageId: NonEmptyStringSchema, requestTitle: NonEmptyStringSchema,
		messageStatus: Type.Literal("unknown"), reason: Type.Literal("confirmation_lost"),
	}),
	closed({
		messageId: NonEmptyStringSchema, requestMessageId: NonEmptyStringSchema, requestTitle: NonEmptyStringSchema,
		answerId: NonEmptyStringSchema, disposition: Type.Literal("already_answered"),
	}),
	closed({
		messageId: NonEmptyStringSchema, requestMessageId: NonEmptyStringSchema, requestTitle: NonEmptyStringSchema,
		disposition: Type.Literal("committed"), delivery: Type.Literal("omitted"), reason: Type.Literal("request_source_unavailable"),
	}),
	closed({
		disposition: Type.Literal("already_answered"),
		answerMessageId: NonEmptyStringSchema,
	}),
	closed({
		disposition: Type.Literal("already_cancelled"),
		cancellationMessageId: NonEmptyStringSchema,
	}),
	closed({
		disposition: Type.Literal("delivered"), messageId: NonEmptyStringSchema,
		deliveryEvidence: EntryPointerSchema,
	}),
	closed({
		disposition: Type.Literal("not_observed"), messageId: NonEmptyStringSchema,
		inspectedThrough: EntryPointerSchema,
	}),
	closed({
		disposition: Type.Literal("indeterminate"), messageId: NonEmptyStringSchema,
		reason: Type.Literal("inspection_incomplete"),
	}),
	closed({
		disposition: Type.Literal("answer_delivered"), requestMessageId: NonEmptyStringSchema, requestTitle: NonEmptyStringSchema,
		answerId: NonEmptyStringSchema,
		fromAgentId: NonEmptyStringSchema, answer: Type.String(), answerSource: ToolCallPointerSchema,
	}),
	closed({
		disposition: Type.Literal("answer_already_delivered"), requestMessageId: NonEmptyStringSchema, requestTitle: NonEmptyStringSchema,
		answerId: NonEmptyStringSchema,
		deliveryEvidence: EntryPointerSchema,
	}),
	closed({
		disposition: Type.Literal("request_delivered"), requestMessageId: NonEmptyStringSchema,
		deliveryEvidence: EntryPointerSchema,
	}),
]));
const RunControlReceiptSchema = bindEquivalent<RunControlReceipt>()(Type.Union([
	closed({
		agentId: NonEmptyStringSchema,
		disposition: Type.Union([Type.Literal("held"), Type.Literal("already_held"), Type.Literal("not_running")]),
	}),
	closed({ agentId: NonEmptyStringSchema, messageId: NonEmptyStringSchema, messageStatus: Type.Literal("sent") }),
	closed({
		agentId: NonEmptyStringSchema, messageId: NonEmptyStringSchema, delivery: Type.Literal("rejected"),
		rejectionReason: Type.Union([
			Type.Literal("not_held"), Type.Literal("resume_slot_occupied"), Type.Literal("target_unavailable"),
		]),
	}),
	closed({
		agentId: NonEmptyStringSchema,
		disposition: Type.Union([Type.Literal("aborted"), Type.Literal("not_running")]),
		residualRequests: closed({ incoming: Type.Integer({ minimum: 0 }), outgoing: Type.Integer({ minimum: 0 }) }),
		callerOutstandingRequests: Type.Array(closed({ requestMessageId: NonEmptyStringSchema, title: NonEmptyStringSchema })),
	}),
]));
const AgentWaitAnswerSchema = Type.Union([
	closed({
		disposition: Type.Literal("answer_delivered"),
		requestMessageId: NonEmptyStringSchema,
		requestTitle: NonEmptyStringSchema,
		answerId: NonEmptyStringSchema,
		fromAgentId: NonEmptyStringSchema,
		answer: Type.String(),
		answerSource: ToolCallPointerSchema,
	}),
	closed({
		disposition: Type.Literal("answer_already_delivered"),
		requestMessageId: NonEmptyStringSchema,
		requestTitle: NonEmptyStringSchema,
		answerId: NonEmptyStringSchema,
		deliveryEvidence: EntryPointerSchema,
	}),
]);
const AgentWaitResultSchema = bindEquivalent<AgentWaitResult>()(Type.Union([
	closed({ answers: Type.Array(AgentWaitAnswerSchema, { minItems: 1 }) }),
	closed({ disposition: Type.Literal("preempted") }),
]));
const AgentWaitProgressSchema = bindEquivalent<AgentWaitProgress>()(closed({
	waitingFor: Type.Array(closed({
		requestMessageId: NonEmptyStringSchema,
		requestTitle: NonEmptyStringSchema,
		responderAgentId: NonEmptyStringSchema,
	}), { minItems: 1 }),
}));
const HumanAnswerSchema = bindEquivalent<HumanAnswer>()(
	closed({ requestId: NonEmptyStringSchema, answer: NonEmptyStringSchema }),
);
const ReportToUserReceiptSchema = bindEquivalent<ReportToUserReceipt>()(
	closed({ reportId: NonEmptyStringSchema, createdAt: NonEmptyStringSchema }),
);
const ModeratorControlReceiptSchema = bindEquivalent<ModeratorControlReceipt>()(Type.Union([
	closed({
		disposition: Type.Literal("renewed"), toolCall: ToolCallPointerSchema,
		nextReviewInMs: Type.Integer({ minimum: 1 }),
	}),
	closed({ disposition: Type.Literal("stale"), toolCall: ToolCallPointerSchema }),
	closed({ disposition: Type.Literal("resolved") }),
	closed({ disposition: Type.Literal("already_cleared") }),
	closed({
		disposition: Type.Literal("blocked"),
		predicates: Type.Array(Type.Union([
			Type.Literal("incoming_requests"), Type.Literal("outgoing_requests"),
			Type.Literal("obligation_stall"), Type.Literal("run_failure"),
			Type.Literal("dependency_deadlock"), Type.Literal("operation_review"), Type.Literal("delivery_stall"),
		])),
	}),
]));
const ToolIntention = <T extends TSchema>(input: T) => closed({
	toolCallId: NonEmptyStringSchema,
	input,
});
const AgentMessageInputSchema = bindToolInput<AgentMessageInput>()(coordinationToolSchemas.agent_message);
const AgentWaitInputSchema = bindToolInput<AgentWaitInput>()(coordinationToolSchemas.agent_wait);
const AgentObserveInputSchema = bindToolInput<AgentObserveInput>()(coordinationToolSchemas.agent_observe);
const RunControlInputSchema = bindToolInput<RunControlInput>()(coordinationToolSchemas.agent_control);
const AgentSpawnInputSchema = bindToolInput<AgentSpawnInput>()(coordinationToolSchemas.agent_spawn);
const HumanRequestInputSchema = bindToolInput<HumanRequestInput>()(coordinationToolSchemas.ask_user);
const ReportToUserInputSchema = bindToolInput<ReportToUserInput>()(coordinationToolSchemas.report_to_user);
const ModeratorControlInputSchema = bindToolInput<ModeratorControlInput>()(coordinationToolSchemas.moderator_control);
const ContextPreparationSchema = closed({
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
});
const ProspectiveRequestSchema = closed({
	kind: Type.Literal("request"),
	requestMessageId: NonEmptyStringSchema,
	fromAgentId: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	question: Type.String(),
});
const WorkingZonePreparationSchema = closed({
	intent: ContextPreparationSchema,
	prospectiveRequest: ProspectiveRequestSchema,
});
const AgentRuntimeDeliverySchema = Type.Union([
	closed({
		kind: Type.Literal("custom"),
		message: Type.Union([
			closed({
				customType: Type.Literal(MESSAGE_DELIVERY_CUSTOM_TYPE),
				content: Type.String(),
				display: Type.Literal(true),
				details: closed({
					messages: Type.Array(ToolCallPointerSchema, { minItems: 1, uniqueItems: true }),
				}),
			}),
			closed({
				customType: Type.Literal(MODERATOR_ROUTINE_START_CUSTOM_TYPE),
				content: Type.Literal(MODERATOR_ROUTINE_START_INSTRUCTION),
				display: Type.Literal(false),
			}),
			closed({
				customType: Type.Literal(MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE),
				content: Type.String(),
				display: Type.Literal(true),
			}),
			closed({
				customType: Type.Literal(OBLIGATION_REMINDER_CUSTOM_TYPE),
				content: Type.String(),
				display: Type.Literal(true),
			}),
			closed({
				customType: Type.Literal(RUN_FAILURE_RECOVERY_CUSTOM_TYPE),
				content: Type.String(),
				display: Type.Literal(true),
			}),
			closed({
				customType: Type.Literal(WORKFLOW_CONTINUATION_CUSTOM_TYPE),
				content: Type.String(),
				display: Type.Literal(true),
			}),
			closed({
				customType: Type.Literal(DELIVERY_FAILURE_CUSTOM_TYPE),
				content: Type.String(),
				display: Type.Literal(true),
			}),
			closed({
				customType: Type.Literal(RUN_SUSPENSION_NOTICE_CUSTOM_TYPE),
				content: Type.String(),
				display: Type.Literal(true),
			}),
		]),
		triggerTurn: Type.Boolean(),
		deliverAs: Type.Optional(DeliveryModeSchema),
		workingZonePreparation: Type.Optional(WorkingZonePreparationSchema),
	}),
	closed({
		kind: Type.Literal("user"),
		content: Type.Union([
			Type.String(),
			Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
		]),
		deliverAs: Type.Optional(DeliveryModeSchema),
		forwardedInput: Type.Optional(closed({
			submissionSequence: Type.Optional(Type.Integer({ minimum: 1 })),
		})),
	}),
]);

const ModeratorRequestSetSchema = closed({
	total: Type.Integer({ minimum: 0 }),
	sources: Type.Array(ToolCallPointerSchema, { uniqueItems: true }),
});
const ModeratorTriggerSchema = Type.Union([
	closed({
		kind: Type.Literal("delivery_stall"),
		agentIds: Type.Array(NonEmptyStringSchema, { minItems: 1, uniqueItems: true }),
		requests: ModeratorRequestSetSchema,
		delivery: closed({ messageId: NonEmptyStringSchema, recipientAgentId: NonEmptyStringSchema }),
		reason: Type.Union([
			closed({ kind: Type.Literal("scheduling_failure"), diagnostic: Type.String() }),
			closed({ kind: Type.Literal("progress_deadline"),
				stage: Type.Union([Type.Literal("eligible"), Type.Literal("reserved"), Type.Literal("dispatched")]),
				intervalMs: Type.Integer({ minimum: 1 }),
			}),
		]),
	}),
	closed({
		kind: Type.Literal("obligation_stall"),
		agentId: NonEmptyStringSchema,
		obligations: ModeratorRequestSetSchema,
	}),
	closed({
		kind: Type.Literal("run_failure"),
		agentId: NonEmptyStringSchema,
		runSequence: Type.Integer({ minimum: 1 }),
		obligations: ModeratorRequestSetSchema,
	}),
	closed({
		kind: Type.Literal("dependency_deadlock"),
		agentIds: Type.Array(NonEmptyStringSchema, { minItems: 1, uniqueItems: true }),
		requests: ModeratorRequestSetSchema,
	}),
	closed({
		kind: Type.Literal("operation_review"),
		toolCall: ToolCallPointerSchema,
		reviewIntervalMs: Type.Integer({ minimum: 1 }),
	}),
]);
const HumanAttentionItemSchema = closed({
	requestId: NonEmptyStringSchema,
	agentId: NonEmptyStringSchema,
	agentLabel: NonEmptyStringSchema,
	question: Type.String(),
});
const OperationalIncidentAgentSchema = closed({
	agentId: NonEmptyStringSchema,
	label: NonEmptyStringSchema,
});
const OperationalIncidentAttentionFields = {
	summary: Type.Optional(Type.String()),
	diagnostics: Type.Array(EntryPointerSchema, { uniqueItems: true }),
	reportSource: Type.Optional(EntryPointerSchema),
};
const OperationalIncidentAttentionSchema = Type.Union([closed({
	...OperationalIncidentAttentionFields,
	trigger: ModeratorTriggerSchema,
	affectedAgents: Type.Array(OperationalIncidentAgentSchema, { minItems: 1, uniqueItems: true }),
}), closed({
	...OperationalIncidentAttentionFields,
	trigger: closed({ kind: Type.Literal("moderation_unavailable") }),
	// Failed inspection may establish no incident; do not invent an affected Owner.
	affectedAgents: Type.Array(OperationalIncidentAgentSchema, { uniqueItems: true }),
})]);
const ReportFields = {
	...coordinationToolSchemas.report_to_user.properties,
	reportId: NonEmptyStringSchema,
	createdAt: NonEmptyStringSchema,
};
const ModeratorReportSchema = Type.Union([closed({
	...ReportFields,
	reporter: OperationalIncidentAgentSchema,
	source: closed({ ...ToolCallPointerSchema.properties, transcriptPath: NonEmptyStringSchema }),
}), closed({
	...ReportFields,
	source: closed({ ...EntryPointerSchema.properties, kind: Type.Literal("runtime_diagnostic"), transcriptPath: NonEmptyStringSchema, incidentKey: Type.Optional(NonEmptyStringSchema) }),
})]);
const ReportHistoryItemSchema = closed({
	report: ModeratorReportSchema,
	readAt: Type.Optional(NonEmptyStringSchema),
	findings: Type.Optional(Type.Array(closed({
		reportId: NonEmptyStringSchema,
		key: NonEmptyStringSchema,
		summary: NonEmptyStringSchema,
		evidence: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		createdAt: NonEmptyStringSchema,
	}))),
});
export const AgentSelectorActionSchema = Type.Union([
	closed({ kind: Type.Literal("open_report"), reportId: NonEmptyStringSchema }),
	closed({ kind: Type.Literal("select_agent"), agentId: NonEmptyStringSchema }),
	closed({
		kind: Type.Literal("decide"),
		requestId: NonEmptyStringSchema,
		agentId: NonEmptyStringSchema,
	}),
]);
export const AgentSelectorSnapshotSchema = closed({
	live: Type.Array(AgentRosterStatusSchema, { uniqueItems: true }),
	dormant: Type.Array(AgentRosterStatusSchema, { uniqueItems: true }),
	selectedAgentId: NonEmptyStringSchema,
	humanAttention: Type.Array(HumanAttentionItemSchema, { uniqueItems: true }),
	operationalAttention: Type.Array(OperationalIncidentAttentionSchema, { uniqueItems: true }),
	reports: Type.Array(ReportHistoryItemSchema),
	// Optional for wire tolerance: older snapshots validate; the surface treats absence as empty.
	quarantined: Type.Optional(Type.Array(NonEmptyStringSchema, { uniqueItems: true })),
	quarantinedCandidateCount: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type RemoteAgentSelectorAction = DeepReadonly<Static<typeof AgentSelectorActionSchema>>;
export type RemoteAgentSelectorSnapshot = DeepReadonly<Static<typeof AgentSelectorSnapshotSchema>>;
const AgentSelectionResultSchema = Type.Union([
	closed({ kind: Type.Literal("selected") }),
	closed({
		kind: Type.Literal("post_mortem"),
		agentId: NonEmptyStringSchema,
		label: NonEmptyStringSchema,
		preparationError: PreparationErrorSchema,
		outcome: Type.Union([Type.Literal("agents"), Type.Literal("back")]),
	}),
]);
export type RemoteAgentSelectionResult = DeepReadonly<Static<typeof AgentSelectionResultSchema>>;

export const RuntimeSnapshotSchema = closed({
	cwd: NonEmptyStringSchema,
	model: closed({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }),
	thinking: RuntimeThinkingSchema,
	tools: StringListSchema,
	skills: StringListSchema,
	skillSources: Type.Array(closed({ name: NonEmptyStringSchema, filePath: NonEmptyStringSchema })),
	extensions: StringListSchema,
	projectTrusted: Type.Boolean(),
	sessionId: NonEmptyStringSchema,
	sessionPath: NonEmptyStringSchema,
	systemPrompt: Type.Union([
		Type.Null(),
		closed({
			mode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
			filePath: NonEmptyStringSchema,
			body: Type.String(),
		}),
	]),
	loadContextFiles: Type.Boolean(),
});

/**
 * The Control protocol, once, by direction. A channel sends only its side's
 * outbound group and accepts only the inbound one.
 */
export const agentControlProtocol = {
	childToOwner: {
		methods: {
			"runtime.executionBegin": {
				request: closed({
					submissionSequence: Type.Optional(Type.Integer({ minimum: 1 })),
				}),
				response: closed({
					frames: Type.Array(closed({
						requestId: NonEmptyStringSchema,
						requesterAgentId: NonEmptyStringSchema,
						title: NonEmptyStringSchema,
						question: NonEmptyStringSchema,
					})),
				}),
			},
			"runtime.humanInput": {
				request: closed({
					text: Type.String(),
					images: Type.Optional(ImageListSchema),
					submissionSequence: Type.Integer({ minimum: 1 }),
				}),
				response: closed({
					disposition: Type.Union([
						Type.Literal("continue"),
						Type.Literal("submitted"),
						Type.Literal("discarded"),
					]),
				}),
			},
			"runtime.primaryInputQueued": {
				request: EmptySchema,
				response: EmptyResponseSchema,
			},
			"runtime.humanInputMode": {
				request: EmptySchema,
				response: closed({ mode: Type.Union([Type.Literal("agent"), Type.Literal("answer"), Type.Literal("run_suspended")]) }),
			},
			"runtime.guardToolResult": {
				request: closed({ message: AgentMessageSchema }),
				response: closed({ result: Type.Union([GuardedHumanToolResultSchema, Type.Null()]) }),
			},
			"runtime.rootToolExecutionStart": {
				request: closed({ toolCallId: NonEmptyStringSchema, toolName: NonEmptyStringSchema }),
				response: EmptyResponseSchema,
			},
			"runtime.safeBoundary": { request: EmptySchema, response: EmptyResponseSchema },
			"runtime.executionEnd": { request: EmptySchema, response: EmptyResponseSchema },
			"coordination.observe": {
				request: AgentObserveInputSchema,
				response: AgentObserveResultSchema,
			},
			"coordination.message": {
				request: ToolIntention(AgentMessageInputSchema),
				response: AgentMessageReceiptSchema,
			},
			"coordination.wait": {
				request: ToolIntention(AgentWaitInputSchema),
				response: AgentWaitResultSchema,
			},
			"coordination.control": {
				request: ToolIntention(RunControlInputSchema),
				response: RunControlReceiptSchema,
			},
			"coordination.spawn": {
				request: ToolIntention(AgentSpawnInputSchema),
				response: AgentSpawnReceiptSchema,
			},
			"coordination.templateSnapshot": {
				request: Type.Object({
					refresh: Type.Boolean(),
				}, { additionalProperties: false }),
				response: AgentTemplateCatalogueSnapshotSchema,
			},
			"coordination.askHuman": {
				request: ToolIntention(HumanRequestInputSchema),
				response: HumanAnswerSchema,
			},
			"coordination.reportToUser": {
				request: ToolIntention(ReportToUserInputSchema),
				response: ReportToUserReceiptSchema,
			},
			"coordination.moderatorControl": {
				request: ToolIntention(ModeratorControlInputSchema),
				response: ModeratorControlReceiptSchema,
			},
			"presentation.agents.snapshot": {
				request: EmptySchema,
				response: AgentSelectorSnapshotSchema,
			},
			"presentation.agents.select": {
				request: AgentSelectorActionSchema,
				response: AgentSelectionResultSchema,
			},
			"presentation.reports.setRead": {
				request: closed({ reportId: NonEmptyStringSchema, read: Type.Boolean() }),
				response: EmptyResponseSchema,
			},
		},
		events: {
			// Early Control/presentation availability; inherited startup hooks may still await UI.
			"runtime.ready": {
				payload: closed({ sessionId: NonEmptyStringSchema, mode: Type.Literal("tui"), hasUI: Type.Literal(true) }),
			},
			"runtime.startupComplete": { payload: RuntimeSnapshotSchema },
			"runtime.snapshot.changed": { payload: RuntimeSnapshotSchema },
			"runtime.input.submissionAcknowledged": {
				payload: closed({ sequence: Type.Integer({ minimum: 1 }) }),
			},
			"runtime.input.started": {
				payload: closed({ sequence: Type.Integer({ minimum: 1 }) }),
			},
			"runtime.input.completed": {
				payload: closed({ sequence: Type.Integer({ minimum: 1 }) }),
			},
			"runtime.compaction.started": { payload: EmptySchema },
			"runtime.compaction.completed": { payload: EmptySchema },
			"agent.start": {
				payload: closed({
					runId: NonEmptyStringSchema,
					queuedInputCount: QueuedInputCountSchema,
				}),
			},
			"agent.end": { payload: RunEndSchema },
			"agent.settled": {
				payload: closed({
					runId: NonEmptyStringSchema,
					queuedInputCount: QueuedInputCountSchema,
				}),
			},
			"message.dispatch.completed": {
				payload: closed({
					deliveryId: NonEmptyStringSchema,
					error: Type.Optional(Type.String()),
				}),
			},
			"session.shutdown": { payload: closed({ reason: Type.Optional(Type.String()) }) },
			"runtime.fault": {
				payload: closed({ code: NonEmptyStringSchema, message: Type.String() }),
			},
		},
	},
	ownerToChild: {
		methods: {
			"runtime.snapshot": { request: EmptySchema, response: RuntimeSnapshotSchema },
			"message.deliver": {
				request: closed({
					deliveryId: NonEmptyStringSchema,
					delivery: AgentRuntimeDeliverySchema,
					proveCommit: Type.Boolean(),
				}),
				response: closed({
					accepted: Type.Boolean(),
					/** Present exactly when the request asked to prove the commit. */
					transcriptCommitted: Type.Optional(Type.Boolean()),
					modelCycleStarted: Type.Boolean(),
					queuedInputCount: QueuedInputCountSchema,
				}),
			},
			"message.cancel": {
				request: closed({ deliveryId: NonEmptyStringSchema }),
				response: AcknowledgementSchema,
			},
			"moderatorReminder.prepare": {
				request: closed({ reservationId: NonEmptyStringSchema }),
				response: closed({ prepared: Type.Boolean() }),
			},
			"moderatorReminder.finish": {
				request: closed({ reservationId: NonEmptyStringSchema, commit: Type.Boolean() }),
				response: closed({ outcome: Type.Union([Type.Literal("committed"), Type.Literal("busy"), Type.Literal("suppressed")]) }),
			},
			"queue.clear": {
				request: closed({ runId: NonEmptyStringSchema }),
				response: closed({
					steering: StringQueueSchema,
					followUp: StringQueueSchema,
					queuedInputCount: QueuedInputCountSchema,
				}),
			},
			"run.interrupt": {
				request: closed({ runId: NonEmptyStringSchema }),
				response: AcknowledgementSchema,
			},
			"presentation.setVisible": {
				request: closed({ visible: Type.Boolean() }),
				response: EmptyResponseSchema,
			},
			"runtime.shutdown": {
				request: closed({ reason: Type.Optional(Type.String()) }),
				response: AcknowledgementSchema,
			},
		},
		events: {
			"presentation.agents.changed": { payload: AgentSelectorSnapshotSchema },
			"coordination.wait.progress": {
				payload: closed({
					toolCallId: NonEmptyStringSchema,
					progress: AgentWaitProgressSchema,
				}),
			},
		},
	},
} as const satisfies AgentControlProtocol;

export type ChildToOwnerControl = typeof agentControlProtocol.childToOwner;
export type OwnerToChildControl = typeof agentControlProtocol.ownerToChild;
