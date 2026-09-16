import { isAbsolute } from "node:path";
import { CURRENT_SESSION_VERSION, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { initializeCoordinationProjections } from "../protocol/coordination-projections.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { RetainedTranscript } from "../transcript/retained-transcript.ts";

/** Parse without Pi's tolerant loader, migration, or filesystem side effects. */
export function parseRepairTranscript(contents: string, path: string,
	options: { projectCoordination?: boolean } = {}): TranscriptInspection {
	const lines = contents.split("\n");
	if (lines.at(-1) === "") lines.pop();
	let header: SessionHeader | undefined;
	const entries: SessionEntry[] = [];
	const byId = new Map<string, SessionEntry>();
	for (const [index, line] of lines.entries()) {
		let value: unknown;
		try {
			value = JSON.parse(line);
			const record = object(value, "record");
			if (index === 0) {
				if (record.type !== "session" || record.version !== CURRENT_SESSION_VERSION) fail("expected current-version session header");
				for (const key of Object.keys(record)) {
					if (!["type", "version", "id", "timestamp", "cwd", "parentSession"].includes(key)) fail(`unsupported session header field ${key}`);
				}
				strings(record, ["id", "timestamp", "cwd"]);
				if (!isAbsolute(record.cwd as string)) fail("header.cwd must be an absolute path");
				identifier(record.id, "header.id");
				date(record.timestamp);
				optional(record, "parentSession", string);
				header = record as unknown as SessionHeader;
				continue;
			}
			strings(record, ["type", "id", "timestamp"]);
			identifier(record.id, "id");
			date(record.timestamp);
			if (byId.has(record.id as string)) fail("duplicate entry id");
			if (record.parentId !== null) reference(record.parentId, "parentId", byId);
			validateEntry(record);
			if (record.type === "compaction") {
				reference(record.firstKeptEntryId, "firstKeptEntryId", byId);
				let ancestor = record.parentId as string | null;
				while (ancestor !== null && ancestor !== record.firstKeptEntryId) ancestor = byId.get(ancestor)!.parentId;
				if (ancestor === null) fail("firstKeptEntryId must be on the compaction's parent branch");
			}
			if (record.type === "label") reference(record.targetId, "targetId", byId);
			// Pi uses "root" when summarizing a reset leaf. Fork extraction also
			// preserves summary origins on omitted branches in the parent session.
			if (record.type === "branch_summary" && record.fromId !== "root" && !header?.parentSession) reference(record.fromId, "fromId", byId);
			const entry = record as unknown as SessionEntry;
			entries.push(entry);
			byId.set(entry.id, entry);
		} catch (error) {
			const id = value && typeof value === "object" && "id" in value ? ` entry ${String(value.id)}` : "";
			throw new Error(`${path}: line ${index + 1}${id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!header) throw new Error(`${path}: line 1: missing session header`);
	const retained = new RetainedTranscript(header, path,
		options.projectCoordination === false ? undefined : initializeCoordinationProjections);
	for (const entry of entries) retained.append(entry);
	retained.setLeaf(entries.at(-1)?.id ?? null);
	return retained.inspection;
}

type RecordValue = Record<string, unknown>;
function fail(message: string): never { throw new Error(message); }
function object(value: unknown, field: string): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
	return value as RecordValue;
}
function string(value: unknown, field: string): void { if (typeof value !== "string") fail(`${field} must be a string`); }
function identifier(value: unknown, field: string): void {
	string(value, field);
	if (value === "") fail(`${field} must not be empty`);
	if ((value as string).includes("\0")) fail(`${field} must not contain NUL`);
}
function number(value: unknown, field: string): void { if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a finite number`); }
function boolean(value: unknown, field: string): void { if (typeof value !== "boolean") fail(`${field} must be a boolean`); }
function date(value: unknown): void { if (!Number.isFinite(Date.parse(value as string))) fail("timestamp must be a valid date string"); }
function strings(record: RecordValue, fields: string[]): void { for (const field of fields) string(record[field], field); }
function optional(record: RecordValue, field: string, validate: (value: unknown, field: string) => void): void { if (field in record) validate(record[field], field); }
function array(value: unknown, field: string, validate: (value: unknown, field: string) => void): void {
	if (!Array.isArray(value)) fail(`${field} must be an array`);
	value.forEach((item, index) => validate(item, `${field}[${index}]`));
}
function reference(value: unknown, field: string, byId: Map<string, SessionEntry>): void {
	identifier(value, field);
	if (!byId.has(value as string)) fail(`${field} references a missing or later entry: ${value}`);
}
function usage(value: unknown): void {
	const record = object(value, "usage");
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) number(record[key], `usage.${key}`);
	for (const key of ["cacheWrite1h", "reasoning"]) optional(record, key, number);
	const cost = object(record.cost, "usage.cost");
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) number(cost[key], `usage.cost.${key}`);
}
function content(value: unknown, allowString: boolean, assistant = false): void {
	if (allowString && typeof value === "string") return;
	array(value, "content", (item, field) => {
		const block = object(item, field);
		switch (block.type) {
			case "text": string(block.text, `${field}.text`); optional(block, "textSignature", string); break;
			case "image": if (assistant) fail(`${field}: image is not assistant content`); strings(block, ["data", "mimeType"]); break;
			case "thinking":
				if (!assistant) fail(`${field}: thinking requires assistant role`);
				string(block.thinking, `${field}.thinking`); optional(block, "thinkingSignature", string); optional(block, "redacted", boolean); break;
			case "toolCall":
				if (!assistant) fail(`${field}: toolCall requires assistant role`);
				strings(block, ["id", "name"]); object(block.arguments, `${field}.arguments`);
				optional(block, "thoughtSignature", string); optional(block, "namespace", string); break;
			default: fail(`${field}: unsupported content type ${String(block.type)}`);
		}
	});
}
function message(value: unknown): void {
	const record = object(value, "message");
	number(record.timestamp, "message.timestamp");
	switch (record.role) {
		case "user": content(record.content, true); break;
		case "assistant":
			content(record.content, false, true); strings(record, ["api", "provider", "model"]); usage(record.usage);
			if (!["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(record.stopReason as string)) fail("unsupported persisted assistant stopReason");
			for (const key of ["responseModel", "responseId", "providerThinkingLevel", "errorMessage", "rawStopReason"]) optional(record, key, string);
			optional(record, "endTurn", boolean);
			optional(record, "diagnostics", value => array(value, "diagnostics", (value, field) => {
				const diagnostic = object(value, field);
				string(diagnostic.type, `${field}.type`); number(diagnostic.timestamp, `${field}.timestamp`);
				optional(diagnostic, "details", object);
				optional(diagnostic, "error", value => {
					const error = object(value, `${field}.error`);
					string(error.message, `${field}.error.message`);
					optional(error, "name", string); optional(error, "stack", string);
					optional(error, "code", (value, field) => typeof value === "number" ? number(value, field) : string(value, field));
				});
			}));
			optional(record, "deferred", value => {
				const handle = object(value, "deferred"); strings(handle, ["provider", "modelId", "api", "id"]);
				optional(handle, "expiresAt", number); optional(handle, "pollAfterMs", number);
			});
			break;
		case "toolResult":
			strings(record, ["toolCallId", "toolName"]); content(record.content, false); boolean(record.isError, "isError");
			optional(record, "usage", usage); optional(record, "addedToolNames", value => array(value, "addedToolNames", string)); break;
		case "bashExecution":
			strings(record, ["command", "output"]); optional(record, "exitCode", number); boolean(record.cancelled, "cancelled"); boolean(record.truncated, "truncated");
			optional(record, "fullOutputPath", string); optional(record, "excludeFromContext", boolean); break;
		case "custom": strings(record, ["customType"]); content(record.content, true); boolean(record.display, "display"); break;
		case "branchSummary": string(record.summary, "summary"); if (record.fromId !== null) identifier(record.fromId, "fromId"); break;
		case "compactionSummary": string(record.summary, "summary"); number(record.tokensBefore, "tokensBefore"); break;
		default: fail(`unsupported message role ${String(record.role)}`);
	}
}
function validateEntry(record: RecordValue): void {
	switch (record.type) {
		case "message": message(record.message); break;
		case "model_change": strings(record, ["provider", "modelId"]); break;
		case "thinking_level_change": string(record.thinkingLevel, "thinkingLevel"); break;
		case "compaction":
			// The installed session-manager types/runtime use reference-based
			// compaction only; accepting newer checkpoints would rebuild the wrong context.
			if ("retainedTail" in record) fail("retainedTail compactions are unsupported by the installed Pi runtime");
			strings(record, ["summary", "firstKeptEntryId"]); number(record.tokensBefore, "tokensBefore"); optional(record, "usage", usage); optional(record, "fromHook", boolean); break;
		case "branch_summary": string(record.summary, "summary"); identifier(record.fromId, "fromId"); optional(record, "usage", usage); optional(record, "fromHook", boolean); break;
		case "custom": string(record.customType, "customType"); break;
		case "custom_message": string(record.customType, "customType"); content(record.content, true); boolean(record.display, "display"); break;
		case "label": string(record.targetId, "targetId"); optional(record, "label", string); break;
		case "session_info": optional(record, "name", string); break;
		default: fail(`unsupported entry type ${String(record.type)}`);
	}
}
