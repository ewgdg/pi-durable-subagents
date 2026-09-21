import {
	deriveHumanRequestIdentity,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "../protocol/identities.ts";
import {
	inspectCommittedHumanRequestResult,
	validateHumanRequestInput,
	type HumanRequest,
} from "../protocol/human-request.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { HUMAN_REQUEST_FENCED_MESSAGE } from "./human-request-messages.ts";

/**
 * Rebuild the committed Human Requests of one Agent that have no committed
 * result yet. Cold recovery re-admits Agents from physical transcripts, so the
 * in-memory pending set of a previous host generation is gone; the committed
 * `ask_user` call plus the absence of a valid result is the durable evidence.
 */
export function discoverOpenHumanRequests(options: {
	agentId: string;
	transcript: TranscriptInspection;
}): readonly HumanRequest[] {
	const { agentId, transcript } = options;
	const requests: HumanRequest[] = [];
	for (const entry of transcript.entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (part.type !== "toolCall" || part.name !== "ask_user") continue;
			const source: ToolCallPointer = { agentId, entryId: entry.id, toolCallId: part.id };
			let request: HumanRequest;
			try {
				const committed = resolveCommittedToolCall({
					agentId,
					transcript,
					toolCallId: part.id,
					toolName: "ask_user",
				});
				request = {
					requestId: deriveHumanRequestIdentity(committed.source),
					requesterAgentId: agentId,
					source: committed.source,
					question: validateHumanRequestInput(committed.input).question,
				};
			} catch {
				// Uncommitted or ambiguous call evidence is not a recoverable Request;
				// admission of the Agent already owns reporting that defect.
				continue;
			}
			const inspection = inspectCommittedHumanRequestResult({ request, transcript });
			if (inspection.state === "answered") continue;
			if (inspection.state === "interrupted" && !fencedByRun(inspection.resultEntryId, transcript)) continue;
			requests.push(request);
		}
	}
	return requests;
}

/**
 * A non-user Run fence records a native error result for the pending call. The
 * question itself was never answered, so a retained workflow still owes one: the
 * human cancelled nothing. Only the canonical user-interruption text resolves it.
 */
function fencedByRun(resultEntryId: string, transcript: TranscriptInspection): boolean {
	const entry = transcript.entries.find((candidate) => candidate.id === resultEntryId);
	if (entry?.type !== "message" || entry.message.role !== "toolResult") return false;
	return entry.message.content.some((part) =>
		part.type === "text" && part.text.includes(HUMAN_REQUEST_FENCED_MESSAGE)
	);
}
