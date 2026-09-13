import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/coordination/agent-record.ts";
import { transcriptFromSessionManager } from "../../src/pi-integration/session-manager-transcript.ts";
import { createMessageDelivery } from "../../src/protocol/message-delivery.ts";
import { deriveMessageIdentity, type ToolCallPointer } from "../../src/protocol/identities.ts";
import { AgentRuntimeSupervisor } from "../../src/runtime/agent-runtime-supervisor.ts";

/** Committed two-Agent conversations, independent of a model or live Run. */
export function requestHistory() {
	const requester = participant("requester");
	const responder = participant("responder");
	const agents = new Map(
		[requester.record, responder.record].map((record) => [record.identity.agentId, record]),
	);
	let sequence = 0;
	return { requester, responder, agents, request, answer };

	function request(from = requester, to = responder, delivered = true) {
		const question = `Question ${++sequence}`;
		const source = appendCall(from, `request-${sequence}`, {
			title: "Fixture request",
			operation: "request",
			targetAgent: to.record.identity.agentId,
			question,
		});
		const requestId = deriveMessageIdentity(source);
		appendResult(from.manager, source, {
			requestMessageId: requestId,
			targetAgentId: to.record.identity.agentId,
			messageStatus: "sent",
		});
		if (delivered) appendDelivery(to.manager, {
			source,
			projection: {
				title: "Fixture request",
				kind: "request",
				requestMessageId: requestId,
				fromAgentId: from.record.identity.agentId,
				question,
			},
		});
		return requestId;
	}
	function answer(requestId: string, from = responder, to = requester) {
		const source = appendCall(from, `answer-${++sequence}`, {
			operation: "answer",
			requestId,
			answer: "Completed.",
		});
		appendResult(from.manager, source, {
			requestTitle: "Fixture request",
			messageId: deriveMessageIdentity(source),
			requestMessageId: requestId,
			messageStatus: "sent",
		});
		appendDelivery(to.manager, {
			source,
			projection: {
				requestTitle: "Fixture request",
				kind: "answer",
				answerId: deriveMessageIdentity(source),
				requestMessageId: requestId,
				fromAgentId: from.record.identity.agentId,
				answer: "Completed.",
			},
		});
	}
}

export function participant(agentId: string) {
	const manager = SessionManager.inMemory(process.cwd(), { id: agentId });
	manager.appendCustomEntry("agent-coordination.identity", { agentId });
	const record: AgentRecord = {
		identity: {
			agentId,
			workflowId: "requester",
			directSpawnerAgentId: null,
			metadata: { label: "Owner", description: "Workflow Owner" },
		},
		transcript: transcriptFromSessionManager(manager),
		children: [],
		host: AgentRuntimeSupervisor.createChild({
			agentId,
			async startSession() {
				throw new Error("History fixture cannot start a Run");
			},
		}),
	};
	return { record, manager };
}
function appendCall(
	author: ReturnType<typeof participant>,
	toolCallId: string,
	input: Record<string, unknown>,
): ToolCallPointer {
	const entryId = author.manager.appendMessage(
		fauxAssistantMessage(fauxToolCall("agent_message", input, { id: toolCallId }), {
			stopReason: "toolUse",
		}),
	);
	return { agentId: author.record.identity.agentId, entryId, toolCallId };
}
function appendResult(
	manager: SessionManager,
	source: ToolCallPointer,
	details: Record<string, unknown>,
) {
	manager.appendMessage({
		role: "toolResult",
		toolCallId: source.toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Committed." }],
		details,
		isError: false,
		timestamp: Date.now(),
	});
}
function appendDelivery(
	manager: SessionManager,
	item: Parameters<typeof createMessageDelivery>[0][number],
) {
	const delivery = createMessageDelivery([item]);
	manager.appendCustomMessageEntry(
		delivery.customType,
		delivery.content,
		delivery.display,
		delivery.details,
	);
}
