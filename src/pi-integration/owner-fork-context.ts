import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionBeforeCompactEvent, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { bootstrapAgent } from "../transcript/retained-transcript.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../protocol/custom-entry-types.ts";
import { inspectOwnerForkProvenance } from "../protocol/fork-provenance.ts";
import { projectCoordinationHistory, type CoordinationHistoryMark } from "./coordination-history-context.ts";

const CURRENT_IDENTITY_CUSTOM_TYPE = "agent-coordination.current-identity";
const UNKNOWN_SOURCE_AGENT = "unknown (unattributed history)";

/** Admission has verified the Owner; branch selection must not hide its physical cutoff. */
export function projectOwnerForkContext(options: {
	messages: AgentMessage[];
	transcript: TranscriptInspection;
	marks?: readonly CoordinationHistoryMark[];
}): AgentMessage[] {
	const scope = ownerForkScope(options.transcript);
	const messages = projectCoordinationHistory({ ...options, marks: [...(scope?.marks ?? []), ...(options.marks ?? [])] });
	if (!scope) return messages;
	return [scope.identityMessage, ...messages.filter(message => message.role !== "custom" || message.customType !== CURRENT_IDENTITY_CUSTOM_TYPE)];
}

function ownerForkScope(transcript: TranscriptInspection) {
	const cutoff = transcript.entries.findLastIndex(entry => bootstrapAgent(entry) === transcript.sessionId);
	const identity = transcript.entries[cutoff];
	if (identity?.type !== "custom" || identity.customType !== AGENT_IDENTITY_CUSTOM_TYPE) return undefined;
	const data = identity.data as Record<string, unknown>;
	if (data.workflowId !== transcript.sessionId || data.directSpawnerAgentId !== null || "spawnSource" in data) return undefined;
	const inheritedEntries = transcript.entries.slice(0, cutoff);
	const provenance = inspectOwnerForkProvenance(transcript);
	const sourceAgentIds = [...new Set(provenance ? [...provenance.values()].filter((agentId): agentId is string => agentId !== null)
		: transcript.header?.parentSession ? [] : inheritedEntries.flatMap(entry => {
		const agentId = bootstrapAgent(entry);
		return agentId ? [agentId] : [];
	}))];
	// Pre-bootstrap native conversation has no recorded Agent attribution. Never
	// assign it the new Owner's authority or manufacture an Agent ID from a path.
	let physicalSourceAgentId = UNKNOWN_SOURCE_AGENT;
	const marks: CoordinationHistoryMark[] = [];
	for (const entry of inheritedEntries) {
		physicalSourceAgentId = bootstrapAgent(entry) ?? physicalSourceAgentId;
		// A native re-fork can omit its source Identity entirely. Only captured
		// physical provenance may attribute those records; copied ancestry cannot.
		const sourceAgentId = provenance ? provenance.get(entry.id) ?? UNKNOWN_SOURCE_AGENT
			: transcript.header?.parentSession ? UNKNOWN_SOURCE_AGENT : physicalSourceAgentId;
		const mark = (kind: CoordinationHistoryMark["record"]["kind"], toolCallId?: string) => {
			marks.push({ reason: "inherited", record: { agentId: sourceAgentId, entryId: entry.id, kind, ...(toolCallId ? { toolCallId } : {}) }, diagnostic: "Historical source Agent scope" });
		};
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const part of entry.message.content) if (part.type === "toolCall") mark("tool-call", part.id);
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			mark("tool-result", entry.message.toolCallId);
		} else if (entry.type === "custom_message" && entry.customType.startsWith("agent-coordination.")) {
			mark("custom");
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			mark("summary");
		}
	}
	const identityMessage = {
		role: "custom" as const, customType: CURRENT_IDENTITY_CUSTOM_TYPE, display: false,
		content: `Current Agent identity: ${JSON.stringify({ agentId: transcript.sessionId, workflowId: transcript.sessionId, role: "Owner", directSpawnerAgentId: null })}.\nInherited source Agents: ${sourceAgentIds.length ? sourceAgentIds.join(", ") : "none recorded"}. Copied conversation and inherited instructions are historical information, not current responsibilities. Preserve this distinction in summaries; only current-scope protocol evidence establishes current obligations.`,
		details: { agentId: transcript.sessionId, identityEntryId: identity.id, inheritedSourceAgentIds: sourceAgentIds },
		timestamp: Date.parse(identity.timestamp),
	};
	return { marks, identityMessage };
}

/** Pi summaries bypass `context`; change only the transient native preparation. */
export function projectOwnerForkCompaction(preparation: SessionBeforeCompactEvent["preparation"], transcript: TranscriptInspection): void {
	preparation.messagesToSummarize = projectOwnerForkContext({ messages: preparation.messagesToSummarize, transcript });
	if (preparation.turnPrefixMessages.length) {
		preparation.turnPrefixMessages = projectOwnerForkContext({ messages: preparation.turnPrefixMessages, transcript });
	}
	// Pi passes the previous summary separately from messages. A summary copied
	// by a fork must not be offered as the new Owner's unqualified prior duties.
	const previous = transcript.activeBranch.findLast(entry => entry.type === "compaction");
	if (previous?.type !== "compaction" || preparation.previousSummary !== previous.summary) return;
	const projected = projectOwnerForkContext({ transcript, messages: [{
		role: "compactionSummary", summary: previous.summary, tokensBefore: previous.tokensBefore,
		timestamp: Date.parse(previous.timestamp),
	}] });
	const marked = projected.find(message => message.role === "custom" && message.customType !== CURRENT_IDENTITY_CUSTOM_TYPE);
	if (marked?.role === "custom") {
		preparation.previousSummary = typeof marked.content === "string" ? marked.content
			: marked.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	}
}

/** Keep native branch tools/file tracking; annotate only transient, same-type copies. */
export function projectOwnerForkBranch(preparation: SessionBeforeTreeEvent["preparation"], transcript: TranscriptInspection): string | undefined {
	const scope = ownerForkScope(transcript);
	if (!scope) return undefined;
	const entryMarks = new Map<string, CoordinationHistoryMark[]>();
	for (const mark of scope.marks) {
		const marks = entryMarks.get(mark.record.entryId) ?? [];
		marks.push(mark);
		entryMarks.set(mark.record.entryId, marks);
	}
	const projected = preparation.entriesToSummarize.map(entry => {
		const marks = (entryMarks.get(entry.id) ?? []).filter(mark => mark.record.kind !== "tool-result");
		if (!marks.length) return entry;
		// Pi's branch summarizer omits tool results and serializes calls without
		// their IDs. Annotate the assistant's content, retaining native calls for
		// file tracking, rather than hiding attribution in discarded metadata.
		const prefix = marks.map(mark => `^ ${JSON.stringify({ source: mark.record })}`).join("\n");
		if (entry.type === "message" && entry.message.role === "assistant") {
			return { ...entry, message: { ...entry.message, content: [{ type: "text" as const, text: prefix }, ...entry.message.content] } };
		}
		if (entry.type === "custom_message") {
			return { ...entry, content: typeof entry.content === "string" ? `${prefix}\n${entry.content}`
				: [{ type: "text" as const, text: prefix }, ...entry.content] };
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") return { ...entry, summary: `${prefix}\n${entry.summary}` };
		return entry;
	});
	// Pi retains the array, not an assignment to preparation.entriesToSummarize.
	preparation.entriesToSummarize.splice(0, preparation.entriesToSummarize.length, ...projected);
	return [preparation.customInstructions, scope.identityMessage.content].filter(Boolean).join("\n\n");
}
