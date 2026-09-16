import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { inspectColdWorkflowEvidence } from "../bootstrap/cold-host-discovery.ts";
import type { AgentEvidence } from "../coordination/agent-record.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE, MODERATOR_INPUT_CUSTOM_TYPE } from "../protocol/custom-entry-types.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import { deriveMessageIdentity, resolveCommittedSpawnSource, sameToolCallPointer } from "../protocol/identities.ts";
import { indexedState } from "../transcript/retained-transcript.ts";
import { AgentTranscript, type TranscriptInspection } from "../transcript/agent-transcript.ts";
import { parseRepairTranscript } from "./native-transcript.ts";
import { describeError, diffProtocolEffects, inspectProtocolEffects, type EvidenceError,
	type ProtocolEffectChange, type ProtocolEffectSnapshot } from "./protocol-effects.ts";

export type RepairTranscriptFile = Readonly<{ path: string; contents: string }>;
export type RepairOwnerIdentity = Readonly<{
	workflowId: string; sessionId: string; ownerPath: string; identityEntryId: string;
}>;

/** A preflight hint, not writer-retirement proof. Caller verifies persistence and the active native session binding. */
export function readRepairOwnerIdentity(contents: string, ownerPath: string): RepairOwnerIdentity {
	if (!isAbsolute(ownerPath) || normalize(ownerPath) !== ownerPath || ownerPath.includes("\0")) {
		throw new Error("Repair Owner path must be canonical absolute");
	}
	// Failed coordination replay must not erase an independently verifiable native Owner identity.
	const transcript = parseRepairTranscript(contents, ownerPath, { projectCoordination: false });
	const { identity, identityEntryId } = verifyOwnerIdentity(transcript, transcript.sessionId);
	return { workflowId: identity.workflowId, sessionId: transcript.sessionId, ownerPath, identityEntryId };
}

export type RepairFileChange = Readonly<{
	path: string; before: string; after: string;
	entries: readonly { entryId: string; before?: string; after?: string }[];
}>;
export type RepairValidationReport = Readonly<{
	valid: boolean;
	errors: readonly EvidenceError[];
	changes: readonly RepairFileChange[];
	protocolEffects: Readonly<{
		beforeStatus: "known" | "unknown";
		beforeErrors: readonly EvidenceError[];
		changes: readonly ProtocolEffectChange[];
	}>;
}>;

/** Certifies one exhaustive, immutable generation. It cannot enumerate directories or authorize/apply bytes. */
export async function validateRepairProposal(options: {
	ownerPath: string; workflowId: string;
	before: readonly RepairTranscriptFile[]; after: readonly RepairTranscriptFile[];
}): Promise<RepairValidationReport> {
	const errors: EvidenceError[] = [];
	const beforeFiles = manifest(options.before, "before", errors);
	const afterFiles = manifest(options.after, "after", errors);
	if (!beforeFiles.has(options.ownerPath) || !afterFiles.has(options.ownerPath)) {
		errors.push({ code: "owner_missing", message: "Both exhaustive generations must contain the exact Owner path" });
	}
	if (!isDeepStrictEqual([...beforeFiles.keys()].sort(), [...afterFiles.keys()].sort())) {
		errors.push({ code: "membership_changed", message: "Repair cannot add, remove or relocate participant files" });
	}
	const before = await inspectGeneration(beforeFiles, options.ownerPath, options.workflowId);
	const after = await inspectGeneration(afterFiles, options.ownerPath, options.workflowId);
	errors.push(...after.errors);
	for (const rejection of after.effects.rejections) errors.push({
		path: after.byId.get(rejection.source.agentId)?.transcriptPath ?? undefined,
		code: "coordination_rejected", message: `${rejection.source.entryId}: ${rejection.diagnostic}`,
	});
	for (const [path, original] of before.inspections) {
		const candidate = after.inspections.get(path);
		if (!candidate) continue;
		if (!isDeepStrictEqual(original.header, candidate.header) ||
			!isDeepStrictEqual(identityEntries(original.entries), identityEntries(candidate.entries))) {
			errors.push({ path, code: "identity_changed", message: "Native header and all Workflow bootstrap/cutoff records must be preserved" });
		}
	}
	// If original bytes cannot even be parsed, authority to preserve their valid evidence is unknown.
	// A model's reconstructed transcript is not sufficient proof of the lost historical intent.
	if (before.inspections.size !== beforeFiles.size) errors.push({ code: "original_unverifiable",
		message: "Original native evidence cannot be parsed completely; automatic certification cannot establish preservation" });
	const beforeKnown = before.errors.length === 0;
	const protocolChanges = diffProtocolEffects(before.effects.facts, after.effects.facts);
	for (const change of protocolChanges) {
		if (change.category === "accepted_source_order" && change.before) {
			const originalKeys = change.before.sourceKeys as readonly string[];
			const originalSources = new Set(originalKeys);
			const candidateKeys = (change.after?.sourceKeys ?? []) as readonly string[];
			// Correcting rejected sources may insert newly accepted evidence, but may not reorder existing authority.
			if (!isDeepStrictEqual(originalKeys, candidateKeys.filter(key => originalSources.has(key)))) {
				errors.push({ path: typeof change.before.path === "string" ? change.before.path : undefined,
					code: "accepted_evidence_reordered", message: `Repair must preserve relative accepted coordination source order: ${change.key}` });
			}
		}
		if (change.category === "record" && change.before?.status === "accepted" &&
			(!change.after || !isDeepStrictEqual(change.before.value, change.after.value))) {
			errors.push({ path: typeof change.before.path === "string" ? change.before.path : undefined,
				code: "accepted_evidence_changed", message: `Repair must not rewrite or discard accepted coordination evidence: ${change.key}` });
		}
		if (change.category === "record" && !change.before && change.after) errors.push({
			code: "invented_evidence", message: `Repair cannot invent a new coordination source: ${change.key}`,
		});
		if (change.category === "answer_duty" && change.before && !change.after) {
			// Correction of an existing rejected resolution may discharge a duty; deleting its Delivery may not.
			const requestId = change.before.requestId;
			const hasResolution = after.effects.facts.some(fact =>
				fact.category === "answer_commitment" && fact.value.requestId === requestId ||
				fact.category === "delivery" && isRecord(fact.value.projection) &&
				fact.value.projection.kind === "request_cancellation" && fact.value.projection.requestMessageId === requestId);
			if (!hasResolution) errors.push({ code: "duty_removed", message: `Delivered Answer duty disappeared without accepted resolution: ${change.key}` });
		}
	}
	return {
		valid: errors.length === 0, errors, changes: fileChanges(beforeFiles, afterFiles),
		protocolEffects: { beforeStatus: beforeKnown ? "known" : "unknown", beforeErrors: before.errors,
			// Partial projections remain useful evidence, but never pretend missing before facts were absent.
			changes: protocolChanges },
	};
}

function manifest(files: readonly RepairTranscriptFile[], name: string, errors: EvidenceError[]) {
	const map = new Map<string, RepairTranscriptFile>();
	for (const file of files) {
		if (!isAbsolute(file.path) || normalize(file.path) !== file.path || file.path.includes("\0") || map.has(file.path)) {
			errors.push({ path: file.path, code: "invalid_manifest", message: `${name} manifest has a duplicate or noncanonical absolute path` });
		}
		map.set(file.path, file);
	}
	return map;
}

async function inspectGeneration(files: ReadonlyMap<string, RepairTranscriptFile>, ownerPath: string, workflowId: string) {
	const errors: EvidenceError[] = [];
	const inspections = new Map<string, TranscriptInspection>();
	const byId = new Map<string, TranscriptInspection>();
	let effects: ProtocolEffectSnapshot = { facts: [], rejections: [], errors: [] };
	for (const file of files.values()) {
		try {
			const inspection = parseRepairTranscript(file.contents, file.path);
			inspections.set(file.path, inspection);
			if (byId.has(inspection.sessionId)) throw new Error(`Duplicate native Agent ID ${inspection.sessionId}`);
			byId.set(inspection.sessionId, inspection);
		} catch (error) { errors.push({ path: file.path, code: "native_invalid", message: describeError(error) }); }
	}
	if (errors.length) return { inspections, byId, errors, effects };
	try {
		const owner = inspections.get(ownerPath);
		if (!owner) throw new Error("Owner transcript is absent");
		const { identity: ownerIdentity } = verifyOwnerIdentity(owner, workflowId);
		const transcripts = new Map([...inspections].map(([path, inspection]) =>
			[path, new AgentTranscript({ read: () => inspection })]));
		const recovery = await inspectColdWorkflowEvidence({ ownerIdentity,
			ownerTranscript: transcripts.get(ownerPath)!,
			candidates: [...transcripts].filter(([path]) => path !== ownerPath).map(([path, transcript]) => ({ path, transcript })) });
		if (recovery.quarantinedCandidateCount !== 0) {
			throw new Error(`Workflow membership audit quarantines ${recovery.quarantinedCandidateCount} candidate(s); none may be omitted`);
		}
		const agents = new Map<string, AgentEvidence>([[workflowId,
			{ identity: ownerIdentity, transcript: transcripts.get(ownerPath)!, children: [] }]]);
		for (const recovered of recovery.agents) agents.set(recovered.identity.agentId, {
			identity: recovered.identity, transcript: transcripts.get(recovered.sessionPath)!, children: [],
			...(recovered.role === "ordinary" ? { creationInput: recovered.creationInput } : {}),
		});
		for (const agent of agents.values()) {
			if (agent.identity.directSpawnerAgentId) agents.get(agent.identity.directSpawnerAgentId)!.children.push(agent.identity.agentId);
		}
		validateSpawnClaims(agents);
		effects = inspectProtocolEffects(agents);
		errors.push(...effects.errors);
	} catch (error) { errors.push({ code: "workflow_unverifiable", message: describeError(error) }); }
	return { inspections, byId, errors, effects };
}

function validateSpawnClaims(agents: ReadonlyMap<string, AgentEvidence>): void {
	for (const author of agents.values()) {
		const transcript = author.transcript.inspect(), agentId = author.identity.agentId;
		for (const entry of indexedState(transcript).scope(agentId)) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "agent_spawn" || entry.message.isError) continue;
			const result = entry.message.details;
			if (!isRecord(result) || !["created", "not_created", "unknown"].includes(String(result.spawnStatus))) {
				throw new Error(`unverifiable_spawn_result: ${agentId}:${entry.id}`);
			}
			const { source } = resolveCommittedSpawnSource({ agentId, transcript, toolCallId: entry.message.toolCallId });
			const children = [...agents.values()].filter(child => "spawnSource" in child.identity && sameToolCallPointer(child.identity.spawnSource, source));
			if (result.spawnStatus === "not_created") {
				if (children.length) throw new Error(`contradictory_spawn_result: ${agentId}:${entry.id}`);
				continue;
			}
			// Ordinary discovery tolerates missing files. A full repair audit cannot certify that partial roster.
			if (children.length !== 1) throw new Error(`missing_or_unverified_spawn_participant: ${agentId}:${entry.id}`);
			const claimedId = result.spawnStatus === "created" ? result.agentId : result.candidateAgentId;
			const claimedRequest = result.spawnStatus === "created" ? result.requestMessageId : result.candidateRequestMessageId;
			if ((result.spawnStatus === "created" || claimedId !== undefined) && claimedId !== children[0]!.identity.agentId ||
				(result.spawnStatus === "created" || claimedRequest !== undefined) && claimedRequest !== deriveMessageIdentity(source)) {
				throw new Error(`contradictory_spawn_identity: ${agentId}:${entry.id}`);
			}
		}
	}
}

function verifyOwnerIdentity(transcript: TranscriptInspection, workflowId: string): { identity: OwnerIdentity; identityEntryId: string } {
	if (transcript.sessionId !== workflowId) throw new Error("Owner native ID does not match the verified Workflow");
	if (transcript.entries.some(entry => entry.type === "custom_message" && entry.customType === MODERATOR_INPUT_CUSTOM_TYPE &&
		isRecord(entry.details) && entry.details.agentId === workflowId)) throw new Error("Owner transcript claims Moderator identity");
	const current = transcript.entries.filter(entry => entry.type === "custom" && entry.customType === AGENT_IDENTITY_CUSTOM_TYPE &&
		isRecord(entry.data) && entry.data.agentId === workflowId).at(-1);
	const identity: OwnerIdentity = { agentId: workflowId, workflowId, directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" } };
	if (current?.type !== "custom" || !isDeepStrictEqual(current.data, identity)) {
		throw new Error("Persisted canonical Owner identity cannot be verified without adoption or rewriting");
	}
	return { identity, identityEntryId: current.id };
}

function identityEntries(entries: readonly SessionEntry[]) {
	return entries.filter(entry => (entry.type === "custom" && entry.customType === AGENT_IDENTITY_CUSTOM_TYPE) ||
		(entry.type === "custom_message" && entry.customType === MODERATOR_INPUT_CUSTOM_TYPE));
}

function fileChanges(before: ReadonlyMap<string, RepairTranscriptFile>, after: ReadonlyMap<string, RepairTranscriptFile>): RepairFileChange[] {
	return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
		const oldContents = before.get(path)?.contents ?? "", nextContents = after.get(path)?.contents ?? "";
		if (oldContents === nextContents) return [];
		const old = physicalLines(oldContents), next = physicalLines(nextContents);
		const entries = [...new Set([...old.keys(), ...next.keys()])].flatMap(entryId =>
			old.get(entryId) === next.get(entryId) ? [] : [{ entryId,
				...(old.has(entryId) ? { before: old.get(entryId)! } : {}),
				...(next.has(entryId) ? { after: next.get(entryId)! } : {}) }]);
		return [{ path, before: oldContents, after: nextContents, entries }];
	});
}
function physicalLines(contents: string): Map<string, string> {
	const lines = new Map<string, string>();
	const physical = contents.split("\n");
	for (const [index, line] of physical.entries()) {
		if (!line && index === physical.length - 1) continue;
		let entryId = `line:${index + 1}`;
		try { const value: unknown = JSON.parse(line); if (isRecord(value) && typeof value.id === "string") entryId = value.id; } catch { /* Malformed originals still need a complete textual audit. */ }
		if (lines.has(entryId)) entryId = `${entryId}:line:${index + 1}`;
		lines.set(entryId, line);
	}
	return lines;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
