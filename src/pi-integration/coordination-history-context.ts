import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { bootstrapAgent, indexedState } from "../transcript/retained-transcript.ts";
import type { ContextOnlyReason } from "../protocol/replay-rejection.ts";

export type CoordinationHistoryMark = Readonly<{
	reason: ContextOnlyReason;
	record: Readonly<{
		agentId: string;
		entryId: string;
		kind: "tool-call" | "tool-result" | "custom";
		toolCallId?: string;
	}>;
	diagnostic: string;
}>;

const HISTORY_MARKS: Record<ContextOnlyReason, string> = { invalid: "!", inherited: "^" };
const CONTEXT_ONLY_CUSTOM_TYPE = "agent-coordination.context-only";

type CallResultGroup = {
	call?: ToolCall;
	callKey?: string;
	assistantContext?: ThinkingContent[];
	batch: { endIndex: number };
	results: AgentMessage[];
	marks: CoordinationHistoryMark[];
};

/** Non-destructive model projection: marked calls/results form one informational group. */
export function projectCoordinationHistory(options: {
	messages: AgentMessage[];
	transcript: TranscriptInspection;
	marks: readonly CoordinationHistoryMark[];
}): AgentMessage[] {
	if (!options.marks.length) return options.messages;
	const state = indexedState(options.transcript);
	const callMarks = new Map<string, CoordinationHistoryMark[]>();
	const resultMarks = new Map<string, CoordinationHistoryMark[]>();
	const customMarks = new Map<string, CoordinationHistoryMark[]>();
	const resultOwners = new Map<string, string | undefined>();
	const visibleCallKeys = new Set<string>();
	const visibleResultIds = new Set<string>();
	for (const message of options.messages) {
		if (message.role === "assistant") for (const part of message.content) {
			if (part.type === "toolCall") visibleCallKeys.add(callKey(message.timestamp, part));
		}
		if (message.role === "toolResult") visibleResultIds.add(message.toolCallId);
	}
	for (const mark of options.marks) {
		const entry = state.byId.get(mark.record.entryId);
		if (mark.record.kind === "custom") {
			if (entry?.type !== "custom_message") continue;
			const key = customMessageKey({ ...entry, timestamp: Date.parse(entry.timestamp) });
			addMark(customMarks, key, mark);
			continue;
		}
		if (entry?.type !== "message") continue;
		if (entry.message.role === "assistant") {
			const call = entry.message.content.find(part => part.type === "toolCall" && part.id === mark.record.toolCallId);
			if (!call || call.type !== "toolCall") continue;
			const key = callKey(entry.message.timestamp, call);
			addMark(callMarks, key, mark);
			// A compacted context can retain the result but omit its rejected call.
			// Match its physical result, not every inherited call sharing a native ID.
			if (visibleCallKeys.has(key) || !visibleResultIds.has(call.id)) continue;
			const position = state.positions.get(entry.id)!;
			for (let index = position + 1; index < state.entries.length; index++) {
				const candidate = state.entries[index]!;
				if (bootstrapAgent(candidate)) break;
				if (candidate.type !== "message") continue;
				if (candidate.message.role === "assistant" && candidate.message.content.some(part => part.type === "toolCall" && part.id === call.id)) break;
				if (candidate.message.role === "toolResult" && candidate.message.toolCallId === call.id) {
					const resultKey = JSON.stringify(candidate.message);
					addMark(resultMarks, resultKey, mark);
					resultOwners.set(resultKey, key);
				}
			}
		} else if (entry.message.role === "toolResult") {
			const key = JSON.stringify(entry.message);
			addMark(resultMarks, key, mark);
			resultOwners.set(key, undefined);
			for (let index = state.positions.get(entry.id)! - 1; index >= 0; index--) {
				const candidate = state.entries[index]!;
				if (bootstrapAgent(candidate)) break;
				if (candidate.type !== "message" || candidate.message.role !== "assistant") continue;
				const call = candidate.message.content.find(part => part.type === "toolCall" && part.id === mark.record.toolCallId);
				if (call?.type !== "toolCall") continue;
				resultOwners.set(key, callKey(candidate.message.timestamp, call));
				break;
			}
		}
	}
	const pendingGroups = new Map<string, CallResultGroup>();
	const calls = new Map<ToolCall, CallResultGroup>();
	const results = new Map<AgentMessage, CallResultGroup>();
	options.messages.forEach((message, index) => {
		if (message.role === "assistant") {
			const batch = { endIndex: index };
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				const key = callKey(message.timestamp, part);
				const group: CallResultGroup = { call: part, callKey: key, batch, results: [], marks: [...(callMarks.get(key) ?? [])] };
				pendingGroups.set(part.id, group);
				calls.set(part, group);
			}
		} else if (message.role === "toolResult") {
			const key = JSON.stringify(message);
			const pending = pendingGroups.get(message.toolCallId);
			// A retained orphan result must not attach to a different inherited call
			// just because both happen to use the same native tool-call ID.
			const compatible = !resultOwners.has(key) || pending?.callKey === resultOwners.get(key);
			const group: CallResultGroup = (compatible ? pending : undefined) ?? { batch: { endIndex: index }, results: [], marks: [] };
			group.results.push(message);
			group.batch.endIndex = index;
			group.marks.push(...(resultMarks.get(key) ?? []));
			pendingGroups.set(message.toolCallId, group);
			results.set(message, group);
		}
	});
	const informationAfter = new Map<number, CallResultGroup[]>();
	for (const group of new Set([...calls.values(), ...results.values()])) {
		if (!group.marks.length) continue;
		const groups = informationAfter.get(group.batch.endIndex) ?? [];
		groups.push(group);
		informationAfter.set(group.batch.endIndex, groups);
	}
	return options.messages.flatMap((message, index): AgentMessage[] => {
		let projected: AgentMessage[] = [message];
		if (message.role === "toolResult" && results.get(message)!.marks.length) projected = [];
		if (message.role === "custom") {
			const marks = customMarks.get(customMessageKey(message));
			if (marks) projected = [informationMessage(marks, undefined, [message], message.timestamp)];
		}
		if (message.role === "assistant") {
			const content = message.content.filter(part => part.type !== "toolCall" || !calls.get(part)!.marks.length);
			const markedGroup = message.content.flatMap(part => part.type === "toolCall" && calls.get(part)!.marks.length ? [calls.get(part)!] : [])[0];
			if (markedGroup && content.length && content.every(part => part.type === "thinking")) {
				// Signed thinking cannot be a provider-visible assistant's terminal
				// content. Preserve it as history when its only action was rejected.
				markedGroup.assistantContext = content;
				projected = [];
			} else if (markedGroup) projected = content.length ? [{ ...message, content }] : [];
		}
		// Keep informational custom messages after the whole native tool batch so
		// providers still receive uninterrupted valid sibling call/result pairs.
		return [...projected, ...(informationAfter.get(index) ?? []).map(group =>
			informationMessage(group.marks, group.call, group.results, message.timestamp, group.assistantContext))];
	});
}

function addMark(index: Map<string, CoordinationHistoryMark[]>, key: string, mark: CoordinationHistoryMark): void {
	const marks = index.get(key) ?? [];
	marks.push(mark);
	index.set(key, marks);
}

function callKey(timestamp: number, call: ToolCall): string {
	return JSON.stringify([timestamp, call.id, call.name, call.arguments]);
}

function customMessageKey(message: { customType: string; content: unknown; details?: unknown; timestamp: number }): string {
	// Pi's context messages omit entry IDs but retain these exact native fields.
	return JSON.stringify([message.customType, message.timestamp, message.content, message.details]);
}

function informationMessage(marks: readonly CoordinationHistoryMark[], call: ToolCall | undefined, results: AgentMessage[], timestamp: number, assistantContext?: ThinkingContent[]): AgentMessage {
	const first = marks[0]!;
	const source = first.record;
	const images: ImageContent[] = [];
	const preservedResults = results.map(message => !("content" in message) ? message : ({ ...message, content: typeof message.content === "string" ? message.content
		: message.content.map(part => {
			if (part.type !== "image") return part;
			images.push(part);
			return { type: "image", mimeType: part.mimeType, attachment: images.length };
		}) }));
	const text = `${HISTORY_MARKS[first.reason]} ${JSON.stringify({
		source: { agentId: source.agentId, entryId: source.entryId, toolCallId: source.toolCallId },
		call, assistantContext, results: preservedResults, diagnostics: [...new Set(marks.map(mark => mark.diagnostic))],
	})}`;
	return { role: "custom", customType: CONTEXT_ONLY_CUSTOM_TYPE,
		content: [{ type: "text", text }, ...images], display: false,
		details: { reason: first.reason, records: marks.map(mark => mark.record) }, timestamp };
}
