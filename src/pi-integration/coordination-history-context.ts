import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { bootstrapAgent, indexedState } from "../transcript/retained-transcript.ts";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ContextOnlyReason } from "../protocol/replay-rejection.ts";

export type CoordinationHistoryMark = Readonly<{
	reason: ContextOnlyReason;
	record: Readonly<{
		agentId: string;
		entryId: string;
		kind: "tool-call" | "tool-result" | "custom" | "summary";
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

type PhysicalMessage = Readonly<{
	entryId: string;
	message: AgentMessage;
	order: number;
}>;

type VisibleMessage = Readonly<{
	message: AgentMessage;
	physical?: PhysicalMessage;
}>;

/** Non-destructive model projection: marked calls/results form one informational group. */
export function projectCoordinationHistory(options: {
	messages: AgentMessage[];
	transcript: TranscriptInspection;
	marks: readonly CoordinationHistoryMark[];
}): AgentMessage[] {
	if (!options.marks.length) return options.messages;
	const state = indexedState(options.transcript);
	const callMarks = new Map<string, CoordinationHistoryMark[]>();
	const callFallbackMarks = new Map<string, CoordinationHistoryMark[]>();
	const resultMarks = new Map<string, CoordinationHistoryMark[]>();
	const resultFallbackMarks = new Map<string, CoordinationHistoryMark[]>();
	const customMarks = new Map<string, CoordinationHistoryMark[]>();
	const customFallbackMarks = new Map<string, CoordinationHistoryMark[]>();
	const summaryMarks = new Map<string, CoordinationHistoryMark[]>();
	const summaryFallbackMarks = new Map<string, CoordinationHistoryMark[]>();
	const resultOwners = new Map<string, string | undefined>();
	const physicalMessages = physicalMessagesFor(options.transcript);
	const contextPhysicalMessages = contextPhysicalMessagesFor(options.transcript);
	const visibleMessages = mapVisibleMessages(options.messages, physicalMessages, contextPhysicalMessages, options.transcript.context.messages);
	const physicalCallCounts = new Map<string, number>();
	const physicalResultCounts = new Map<string, number>();
	for (const physical of physicalMessages) {
		if (physical.message.role === "assistant") for (const part of physical.message.content) {
			if (part.type === "toolCall") {
				const key = callKey(physical.message.timestamp, part);
				physicalCallCounts.set(key, (physicalCallCounts.get(key) ?? 0) + 1);
			}
		}
		if (physical.message.role === "toolResult") {
			const key = messageKey(physical.message);
			physicalResultCounts.set(key, (physicalResultCounts.get(key) ?? 0) + 1);
		}
	}
	const visibleCallOccurrences = new Set<string>();
	const visibleResultIds = new Set<string>();
	for (const visible of visibleMessages) {
		if (visible.message.role === "assistant") for (const [partIndex, part] of visible.message.content.entries()) {
			if (part.type === "toolCall" && visible.physical) visibleCallOccurrences.add(callOccurrenceKey(visible.physical.entryId, partIndex));
		}
		if (visible.message.role === "toolResult") visibleResultIds.add(visible.message.toolCallId);
	}
	for (const mark of options.marks) {
		const entry = state.byId.get(mark.record.entryId);
		if (mark.record.kind === "summary") {
			if (entry?.type !== "compaction" && entry?.type !== "branch_summary") continue;
			const role = entry.type === "compaction" ? "compactionSummary" : "branchSummary";
			addMark(summaryMarks, entry.id, mark);
			addMark(summaryFallbackMarks, summaryKey(role, Date.parse(entry.timestamp), entry.summary), mark);
			continue;
		}
		if (mark.record.kind === "custom") {
			if (entry?.type !== "custom_message") continue;
			addMark(customMarks, entry.id, mark);
			addMark(customFallbackMarks, customMessageKey({ ...entry, timestamp: Date.parse(entry.timestamp) }), mark);
			continue;
		}
		if (entry?.type !== "message") continue;
		if (entry.message.role === "assistant") {
			const partIndex = entry.message.content.findIndex(part => part.type === "toolCall" && part.id === mark.record.toolCallId);
			const call = partIndex >= 0 ? entry.message.content[partIndex] : undefined;
			if (!call || call.type !== "toolCall") continue;
			const occurrence = callOccurrenceKey(entry.id, partIndex);
			addMark(callMarks, occurrence, mark);
			addMark(callFallbackMarks, callKey(entry.message.timestamp, call), mark);
			// A compacted context can retain the result but omit its rejected call.
			// Match its physical result, not every inherited call sharing a native ID.
			if (visibleCallOccurrences.has(occurrence) || !visibleResultIds.has(call.id)) continue;
			const position = state.positions.get(entry.id)!;
			for (let index = position + 1; index < state.entries.length; index++) {
				const candidate = state.entries[index]!;
				if (bootstrapAgent(candidate)) break;
				if (candidate.type !== "message") continue;
				if (candidate.message.role === "assistant" && candidate.message.content.some(part => part.type === "toolCall" && part.id === call.id)) break;
				if (candidate.message.role === "toolResult" && candidate.message.toolCallId === call.id) {
					addMark(resultMarks, candidate.id, mark);
					addMark(resultFallbackMarks, messageKey(candidate.message), mark);
					resultOwners.set(candidate.id, occurrence);
				}
			}
		} else if (entry.message.role === "toolResult") {
			addMark(resultMarks, entry.id, mark);
			addMark(resultFallbackMarks, messageKey(entry.message), mark);
			resultOwners.set(entry.id, undefined);
			for (let index = state.positions.get(entry.id)! - 1; index >= 0; index--) {
				const candidate = state.entries[index]!;
				if (bootstrapAgent(candidate)) break;
				if (candidate.type !== "message" || candidate.message.role !== "assistant") continue;
				const partIndex = candidate.message.content.findIndex(part => part.type === "toolCall" && part.id === mark.record.toolCallId);
				const call = partIndex >= 0 ? candidate.message.content[partIndex] : undefined;
				if (!call || call.type !== "toolCall") continue;
				resultOwners.set(entry.id, callOccurrenceKey(candidate.id, partIndex));
				break;
			}
		}
	}
	const pendingGroups = new Map<string, CallResultGroup>();
	const calls = new Map<ToolCall, CallResultGroup>();
	const results = new Map<AgentMessage, CallResultGroup>();
	visibleMessages.forEach(({ message, physical }, index) => {
		if (message.role === "assistant") {
			const batch = { endIndex: index };
			for (const [partIndex, part] of message.content.entries()) {
				if (part.type !== "toolCall") continue;
				const occurrence = physical ? callOccurrenceKey(physical.entryId, partIndex) : undefined;
				const key = occurrence ?? callKey(message.timestamp, part);
				const fallbackKey = callKey(message.timestamp, part);
				const marks = occurrence ? callMarks.get(occurrence) : uniqueFallbackMarks(callFallbackMarks.get(fallbackKey), physicalCallCounts.get(fallbackKey));
				const group: CallResultGroup = { call: part, callKey: key, batch, results: [], marks: [...(marks ?? [])] };
				pendingGroups.set(part.id, group);
				calls.set(part, group);
			}
		} else if (message.role === "toolResult") {
			const entryId = physical?.entryId;
			const key = entryId ?? messageKey(message);
			const pending = pendingGroups.get(message.toolCallId);
			// A retained orphan result must not attach to a different inherited call
			// just because both happen to use the same native tool-call ID.
			const owner = entryId === undefined ? undefined : resultOwners.get(entryId);
			const compatible = entryId === undefined || !resultOwners.has(entryId) || pending?.callKey === owner;
			const group: CallResultGroup = (compatible ? pending : undefined) ?? { batch: { endIndex: index }, results: [], marks: [] };
			group.results.push(message);
			group.batch.endIndex = index;
			const fallbackKey = messageKey(message);
			const marks = entryId ? resultMarks.get(entryId) : uniqueFallbackMarks(resultFallbackMarks.get(fallbackKey), physicalResultCounts.get(fallbackKey));
			group.marks.push(...(marks ?? []));
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
	return visibleMessages.flatMap(({ message }, index): AgentMessage[] => {
		let projected: AgentMessage[] = [message];
		if (message.role === "toolResult" && results.get(message)!.marks.length) projected = [];
		if (message.role === "custom") {
			const physical = visibleMessages[index]!.physical;
			const marks = physical ? customMarks.get(physical.entryId) : uniqueFallbackMarks(customFallbackMarks.get(customMessageKey(message)));
			if (marks) projected = [informationMessage(marks, undefined, [message], message.timestamp)];
		}
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			const physical = visibleMessages[index]!.physical;
			const marks = physical ? summaryMarks.get(physical.entryId) : uniqueFallbackMarks(summaryFallbackMarks.get(summaryKey(message.role, message.timestamp, message.summary)));
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

function physicalMessagesFor(transcript: TranscriptInspection): PhysicalMessage[] {
	const messages: PhysicalMessage[] = [];
	let order = 0;
	for (const entry of transcript.activeBranch) {
		for (const message of sessionEntryToContextMessages(entry)) {
			messages.push({ entryId: entry.id, message, order: order++ });
		}
	}
	return messages;
}

function mapVisibleMessages(
	messages: readonly AgentMessage[],
	physical: readonly PhysicalMessage[],
	contextPhysical: readonly PhysicalMessage[],
	contextMessages: readonly AgentMessage[],
): VisibleMessage[] {
	const byIdentity = new Map<AgentMessage, PhysicalMessage[]>();
	const byKey = new Map<string, PhysicalMessage[]>();
	for (const candidate of physical) {
		const identities = byIdentity.get(candidate.message) ?? [];
		identities.push(candidate);
		byIdentity.set(candidate.message, identities);
		const candidates = byKey.get(messageKey(candidate.message)) ?? [];
		candidates.push(candidate);
		byKey.set(messageKey(candidate.message), candidates);
	}
	const contextByKey = new Map<string, PhysicalMessage[]>();
	for (const candidate of contextPhysical) {
		const candidates = contextByKey.get(messageKey(candidate.message)) ?? [];
		candidates.push(candidate);
		contextByKey.set(messageKey(candidate.message), candidates);
	}
	// A caller may defensively clone the native context. In that case object
	// identity is unavailable, but the context's compaction boundary still tells
	// us which physical duplicate is visible. Preparation arrays retain native
	// message references and therefore continue to use the all-entry index.
	const contextPrefixLength = Math.min(messages.length, contextMessages.length);
	const followsContextPrefix = messages.slice(0, contextPrefixLength).every((message, index) =>
		messageKey(message) === messageKey(contextMessages[index]!));
	// A previous pass may have replaced inherited native groups with one
	// informational custom message. Its records identify the physical entries
	// represented by that replacement; reserve those occurrences before mapping
	// the remaining (possibly cloned) native messages. Without this, an exact
	// current duplicate is mapped back to the already projected inherited one.
	const used = reservedProjectedMessages(messages, physical);
	let cursor = -1;
	return messages.map((message, index) => {
		const candidates = byIdentity.get(message) ??
			(followsContextPrefix && index < contextPrefixLength
				? contextByKey.get(messageKey(message))
				: byKey.get(messageKey(message))) ?? [];
		const physicalMessage = candidates.find(candidate => !used.has(candidate) && candidate.order >= cursor) ??
			candidates.find(candidate => !used.has(candidate));
		if (physicalMessage) {
			used.add(physicalMessage);
			cursor = Math.max(cursor, physicalMessage.order);
		}
		return physicalMessage ? { message, physical: physicalMessage } : { message };
	});
}

function reservedProjectedMessages(messages: readonly AgentMessage[], physical: readonly PhysicalMessage[]): Set<PhysicalMessage> {
	const used = new Set<PhysicalMessage>();
	for (const message of messages) {
		if (message.role !== "custom" || message.customType !== CONTEXT_ONLY_CUSTOM_TYPE) continue;
		const details = message.details;
		if (!details || typeof details !== "object" || !Array.isArray((details as { records?: unknown }).records)) continue;
		for (const record of (details as { records: unknown[] }).records) {
			if (!record || typeof record !== "object") continue;
			const source = record as { entryId?: unknown; kind?: unknown; toolCallId?: unknown };
			if (typeof source.entryId !== "string") continue;
			const entryMessages = physical.filter(candidate => candidate.entryId === source.entryId);
			if (source.kind !== "tool-call" || typeof source.toolCallId !== "string") {
				for (const candidate of entryMessages) used.add(candidate);
				continue;
			}
			const call = entryMessages.find(candidate => candidate.message.role === "assistant" && candidate.message.content.some(part => part.type === "toolCall" && part.id === source.toolCallId));
			if (!call) continue;
			used.add(call);
			const callIndex = physical.indexOf(call);
			for (let index = callIndex + 1; index < physical.length; index++) {
				const candidate = physical[index]!;
				if (candidate.message.role === "assistant" && candidate.message.content.some(part => part.type === "toolCall" && part.id === source.toolCallId)) break;
				if (candidate.message.role === "toolResult" && candidate.message.toolCallId === source.toolCallId) used.add(candidate);
			}
		}
	}
	return used;
}

function contextPhysicalMessagesFor(transcript: TranscriptInspection): PhysicalMessage[] {
	const branch = transcript.activeBranch;
	const compactionIndex = branch.findLastIndex(entry => entry.type === "compaction");
	const compaction = branch[compactionIndex];
	const entries = compaction?.type !== "compaction" ? branch : (() => {
		const firstKeptIndex = branch.findIndex(entry => entry.id === compaction.firstKeptEntryId);
		return [
			compaction,
			...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
			...branch.slice(compactionIndex + 1),
		];
	})();
	const messages: PhysicalMessage[] = [];
	let order = 0;
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			messages.push({ entryId: entry.id, message, order: order++ });
		}
	}
	return messages;
}

function uniqueFallbackMarks(marks: readonly CoordinationHistoryMark[] | undefined, physicalCount = 1): readonly CoordinationHistoryMark[] | undefined {
	return marks?.length === 1 && physicalCount === 1 ? marks : undefined;
}

function callOccurrenceKey(entryId: string, partIndex: number): string {
	return `${entryId}\0${partIndex}`;
}

function messageKey(message: AgentMessage): string {
	return JSON.stringify(message);
}

function callKey(timestamp: number, call: ToolCall): string {
	return JSON.stringify([timestamp, call.id, call.name, call.arguments]);
}

function summaryKey(role: string, timestamp: number, summary: string): string {
	return JSON.stringify([role, timestamp, summary]);
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
