import type { ToolCallPointer } from "../protocol/identities.ts";

export type MessageStatus = "sent" | "not_sent" | "unknown";

export type MessageSendRejectionReason =
	| "target_unavailable"
	| "host_shutting_down"
	| "capacity_exhausted";

type MessageSendOutcome<
	RejectionReason extends string = MessageSendRejectionReason,
	UnknownReason extends string = "confirmation_lost",
> =
	| Readonly<{ messageStatus: "sent" }>
	| Readonly<{
		messageStatus: "not_sent";
		reason: RejectionReason;
	}>
	| Readonly<{
		messageStatus: "unknown";
		reason: UnknownReason;
	}>;

type MessageDeliveryReceipt = Readonly<{
	messageId: string;
	targetAgentId: string;
}> & MessageSendOutcome;

export type AgentMessageSendReceipt =
	| (Readonly<{ messageId: string; targetAgentId: string }> & MessageSendOutcome)
	| Readonly<{
		disposition: "rejected";
		reason: "answer_required";
		requestMessageId: string;
	}>;

export type AgentRequestReceipt =
	Readonly<{ requestMessageId: string; targetAgentId: string }> & MessageSendOutcome;

export type AgentAnswerReceipt =
	| (Readonly<{
		messageId: string;
		requestMessageId: string;
		requestTitle: string;
	}> & MessageSendOutcome)
	| Readonly<{
		messageId: string;
		requestMessageId: string;
		requestTitle: string;
		answerId: string;
		disposition: "already_answered";
	}>;

export type RequestCancellationReceipt =
	| MessageDeliveryReceipt
	| Readonly<{
		disposition: "already_cancelled";
		cancellationMessageId: string;
	}>
	| Readonly<{
		disposition: "already_answered";
		answerMessageId: string;
	}>;

export type AgentMessagePollReceipt =
	| Readonly<{
		disposition: "delivered";
		messageId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "not_observed";
		messageId: string;
		inspectedThrough: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "indeterminate";
		messageId: string;
		reason: "inspection_incomplete";
	}>;

export type AgentMessageRetryReceipt =
	| Readonly<{
		disposition: "delivered";
		messageId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| (Readonly<{ messageId: string; targetAgentId: string }> & MessageSendOutcome<
		| MessageSendRejectionReason
		| "evidence_unavailable"
		| "policy_rejected",
		"confirmation_lost" | "inspection_incomplete"
	>);

export type AgentRequestRetryReceipt =
	| Readonly<{
		disposition: "answer_delivered";
		requestMessageId: string;
		requestTitle: string;
		answerId: string;
		fromAgentId: string;
		answer: string;
		answerSource: ToolCallPointer;
	}>
	| Readonly<{
		disposition: "answer_already_delivered";
		requestMessageId: string;
		requestTitle: string;
		answerId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "request_delivered";
		requestMessageId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| (Readonly<{ requestMessageId: string; targetAgentId: string }> & MessageSendOutcome<
		| MessageSendRejectionReason
		| "evidence_unavailable"
		| "policy_rejected",
		"confirmation_lost" | "inspection_incomplete"
	>);

export type AgentMessageReceipt =
	| AgentMessageSendReceipt
	| AgentRequestReceipt
	| AgentAnswerReceipt
	| RequestCancellationReceipt
	| AgentMessagePollReceipt
	| AgentMessageRetryReceipt
	| AgentRequestRetryReceipt;
