import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { inspectColdWorkflowEvidence } from "../bootstrap/cold-host-discovery.ts";
import type { AgentEvidence } from "../coordination/agent-record.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE, MODERATOR_INPUT_CUSTOM_TYPE } from "../protocol/custom-entry-types.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import { deriveMessageIdentity, ProtocolInvariantError, resolveCommittedSpawnSource, sameToolCallPointer, toolCallPointerKey } from "../protocol/identities.ts";
import { deliveriesAtEntry, inspectMessageDeliveries, MESSAGE_DELIVERY_CUSTOM_TYPE } from "../protocol/message-delivery.ts";
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
	certificate?: DuplicateDeliveryCertificate;
	protocolEffects: Readonly<{
		beforeStatus: "known" | "unknown";
		beforeErrors: readonly EvidenceError[];
		comparisonBasis: "original" | "certified_duplicate_reference";
		certifiedReference?: ProtocolEffectSnapshot;
		changes: readonly ProtocolEffectChange[];
	}>;
}>;

export type DuplicateDeliveryCertificate = Readonly<{
	kind: "exact_duplicate_message_delivery";
	blockages: readonly { path: string; message: string }[];
	removedEntries: readonly { path: string; agentId: string; removedEntryId: string; retainedEntryId: string }[];
	parentRewrites: readonly { path: string; entryId: string; before: string; after: string | null }[];
}>;

/** Offline, lossless reference construction only; never changes live files or infers rejected intent. */
export async function prepareDuplicateDeliveryRepair(options: {
	ownerPath: string; workflowId: string; files: readonly RepairTranscriptFile[];
}): Promise<Readonly<{
	eligible: boolean; errors: readonly EvidenceError[]; files: readonly RepairTranscriptFile[];
	certificate?: DuplicateDeliveryCertificate;
}>> {
	const errors: EvidenceError[] = [];
	const files = manifest(options.files, "original", errors);
	if (errors.length) return { eligible: false, errors, files: options.files };
	try {
		const reference = duplicateDeliveryReference(files, options.ownerPath, options.workflowId);
		const inspected = await inspectGeneration(new Map(reference.files.map(file => [file.path, file])), options.ownerPath, options.workflowId);
		if (inspected.errors.length) return { eligible: false, errors: inspected.errors, files: options.files };
		return { eligible: true, errors: [], ...reference };
	} catch (error) {
		return { eligible: false, errors: [{ code: "unsupported_admission_repair", message: describeError(error) }], files: options.files };
	}
}

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
	const preparation = await prepareDuplicateDeliveryRepair({ ownerPath: options.ownerPath, workflowId: options.workflowId, files: options.before });
	errors.push(...preparation.errors);
	let comparison = before;
	if (preparation.eligible) {
		comparison = await inspectGeneration(new Map(preparation.files.map(file => [file.path, file])), options.ownerPath, options.workflowId);
		for (const [path, reference] of comparison.inspections) {
			const candidate = after.inspections.get(path);
			// Parent splicing is fixed by the reference. Every other native record, including rejected history,
			// conversation and physical order, must remain exactly as observed, not merely project to similar effects.
			if (!candidate || !isDeepStrictEqual(reference.header, candidate.header) || !isDeepStrictEqual(reference.entries, candidate.entries)) {
				errors.push({ path, code: "not_lossless_duplicate_repair", message: "Candidate differs from the exact evidence-preserving duplicate Delivery correction" });
			}
		}
	}
	return {
		valid: errors.length === 0, errors, changes: fileChanges(beforeFiles, afterFiles),
		...(preparation.certificate ? { certificate: preparation.certificate } : {}),
		protocolEffects: { beforeStatus: before.errors.length === 0 ? "known" : "unknown", beforeErrors: before.errors,
			comparisonBasis: preparation.eligible ? "certified_duplicate_reference" : "original",
			...(preparation.eligible ? { certifiedReference: comparison.effects } : {}),
			// The original remains unknown. The explicitly certified reference is not invented historical replay.
			changes: diffProtocolEffects(comparison.effects.facts, after.effects.facts) },
	};
}

function duplicateDeliveryReference(files: ReadonlyMap<string, RepairTranscriptFile>, ownerPath: string, workflowId: string): {
	files: readonly RepairTranscriptFile[]; certificate: DuplicateDeliveryCertificate;
} {
	const inspections = new Map([...files].map(([path, file]) => [path,
		parseRepairTranscript(file.contents, path, { projectCoordination: false })]));
	const owner = inspections.get(ownerPath);
	if (!owner) throw new Error("Original generation must contain the exact Owner path");
	verifyOwnerIdentity(owner, workflowId);
	const removedEntries: DuplicateDeliveryCertificate["removedEntries"][number][] = [];
	const parentRewrites: DuplicateDeliveryCertificate["parentRewrites"][number][] = [];
	const blockages: DuplicateDeliveryCertificate["blockages"][number][] = [];
	const removals = new Map<string, Map<string, SessionEntry>>();
	for (const [path, transcript] of inspections) {
		try {
			inspectMessageDeliveries({ recipientAgentId: transcript.sessionId, transcript });
			continue;
		} catch (error) {
			// Only this real normal-reader invariant admits a correction; no generic fallback projection.
			if (!(error instanceof ProtocolInvariantError) || !/^invariant_violation: Message .+ has duplicate Deliveries$/.test(error.message)) throw error;
			blockages.push({ path, message: error.message });
		}
		const sources = new Map<string, SessionEntry>();
		const removed = new Map<string, SessionEntry>();
		for (const entry of indexedState(transcript).scope(transcript.sessionId)) {
			if (entry.type !== "custom_message" || entry.customType !== MESSAGE_DELIVERY_CUSTOM_TYPE) continue;
			const deliveries = deliveriesAtEntry(transcript, transcript.sessionId, entry.id);
			if (!deliveries.length) continue; // Rejected envelopes stay byte-for-byte inert.
			const sourceKeys = deliveries.map(delivery => toolCallPointerKey(delivery.source));
			const prior = sourceKeys.map(key => sources.get(key)).filter((value): value is SessionEntry => !!value);
			if (!prior.length) {
				for (const key of sourceKeys) sources.set(key, entry);
				continue;
			}
			const retained = prior[0]!;
			if (prior.length !== sourceKeys.length || prior.some(value => value !== retained) ||
				!isDeepStrictEqual(deliveryEnvelope(retained), deliveryEnvelope(entry))) {
				throw new Error(`${path}: conflicting or overlapping Delivery envelopes cannot be repaired`);
			}
			let ancestor = entry.parentId;
			while (ancestor !== null && ancestor !== retained.id) ancestor = indexedState(transcript).byId.get(ancestor)!.parentId;
			if (ancestor === null) throw new Error(`${path}: duplicate Delivery is not on the retained Delivery's native branch`);
			removed.set(entry.id, entry);
			removedEntries.push({ path, agentId: transcript.sessionId, removedEntryId: entry.id, retainedEntryId: retained.id });
		}
		if (!removed.size) throw new Error(`${path}: duplicate Delivery blockage has no exact redundant envelope`);
		removals.set(path, removed);
	}
	if (!removedEntries.length) throw new Error("No supported duplicate Delivery admission failure; healthy and rejected-only history is not repair eligible");
	if (!blockages.some(blockage => blockage.path === ownerPath)) {
		throw new Error("Owner has no supported duplicate Delivery admission failure; child-only quarantine does not authorize repair");
	}
	const removedIds = new Set(removedEntries.map(entry => entry.removedEntryId));
	const repaired = [...files].map(([path, file]) => {
		const transcript = inspections.get(path)!;
		const removed = removals.get(path) ?? new Map<string, SessionEntry>();
		const replacements = new Map<string, SessionEntry>();
		if (containsRemovedReference(transcript.header, removedIds)) throw new Error(`${path}: native header depends on a removed Delivery`);
		let survivingLeaf = transcript.entries.at(-1)?.id ?? null;
		while (survivingLeaf !== null && removed.has(survivingLeaf)) survivingLeaf = removed.get(survivingLeaf)!.parentId;
		// Pi reopens the last physical entry. Removing a branched tail must not select an abandoned conversation.
		if ((transcript.entries.filter(entry => !removed.has(entry.id)).at(-1)?.id ?? null) !== survivingLeaf) {
			throw new Error(`${path}: removing duplicate Delivery would change the reopened native leaf`);
		}
		for (const entry of transcript.entries) {
			if (removed.has(entry.id)) continue;
			const { parentId, ...otherFields } = entry;
			// Unknown extension payloads can contain entry references too. Refuse rather than guess how to migrate them.
			if (containsRemovedReference(otherFields, removedIds)) throw new Error(`${path}: entry ${entry.id} depends on a removed Delivery`);
			let parent = parentId;
			while (parent !== null && removed.has(parent)) parent = removed.get(parent)!.parentId;
			if (parent !== parentId) {
				parentRewrites.push({ path, entryId: entry.id, before: parentId!, after: parent });
				replacements.set(entry.id, { ...entry, parentId: parent });
			}
		}
		if (!removed.size) return file;
		return { path, contents: file.contents.split("\n").flatMap(line => {
			if (!line) return [line];
			const entry = JSON.parse(line) as { id: string };
			return removed.has(entry.id) ? [] : [replacements.has(entry.id) ? JSON.stringify(replacements.get(entry.id)) : line];
		}).join("\n") };
	});
	return { files: repaired, certificate: { kind: "exact_duplicate_message_delivery", blockages, removedEntries, parentRewrites } };
}

function deliveryEnvelope(entry: SessionEntry) {
	const { id: _id, parentId: _parentId, timestamp: _timestamp, ...envelope } = entry;
	return envelope;
}
function containsRemovedReference(value: unknown, removedIds: ReadonlySet<string>): boolean {
	if (typeof value === "string") return [...removedIds].some(id => value.includes(id));
	if (Array.isArray(value)) return value.some(item => containsRemovedReference(item, removedIds));
	return isRecord(value) && Object.entries(value).some(([key, item]) => containsRemovedReference(key, removedIds) || containsRemovedReference(item, removedIds));
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
