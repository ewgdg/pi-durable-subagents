import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import type { ChildAgentIdentity } from "./child-identity.ts";
import {
	deriveMessageIdentity,
	type ToolCallPointer,
} from "./identities.ts";
import type { Message } from "./message.ts";
import {
	inspectStandaloneMessageDelivery,
	deliveriesBySource,
	type DeliveryInspection,
	type MessageDeliveryItem,
} from "./message-delivery.ts";

/** Loaded child records already contain the reconstructed canonical spawn input. */
export function resolveCreationRequest(options: {
	childIdentity: ChildAgentIdentity;
	creationInput: import("./agent-spawn-input.ts").AgentSpawnInput;
}): Extract<Message, { kind: "request" }> {
	const { childIdentity, creationInput } = options;
	return {
		kind: "request",
		origin: "agent_spawn",
		messageId: deriveMessageIdentity(childIdentity.spawnSource),
		workflowId: childIdentity.workflowId,
		fromAgentId: childIdentity.directSpawnerAgentId,
		targetAgentId: childIdentity.agentId,
		deliveryMode: "deferred",
		source: childIdentity.spawnSource,
		title: creationInput.title,
		question: creationInput.request,
	};
}

export function createCreationRequestDeliveryItem(options: {
	requestId: string;
	fromAgentId: string;
	title: string;
	question: string;
	source: ToolCallPointer;
}): MessageDeliveryItem {
	const { requestId, fromAgentId, title, question, source } = options;
	return {
		source,
		projection: {
			kind: "request",
			requestMessageId: requestId,
			fromAgentId,
			title,
			question,
		},
	};
}

export function inspectCreationRequestDelivery(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
	requestId: string;
	fromAgentId: string;
	title: string;
	source: ToolCallPointer;
}): DeliveryInspection {
	const {
		recipientAgentId,
		transcript,
		requestId,
		fromAgentId,
		title,
		source,
	} = options;
	for (const { projection } of deliveriesBySource({ recipientAgentId, transcript, source })) {
		if (projection.kind === "request" && projection.title !== title) {
			throw new Error("invariant_violation: Creation Request Delivery title differs from its source");
		}
	}
	return inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript,
		source,
		identity: {
			kind: "request",
			messageId: requestId,
			fromAgentId,
		},
		subject: `Creation Request ${requestId}`,
	});
}
