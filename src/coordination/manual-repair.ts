import { relative, sep } from "node:path";

import { AGENT_IDENTITY_CUSTOM_TYPE } from "../protocol/owner-identity.ts";
import { transcriptFromSessionFile } from "../pi-integration/session-manager-transcript.ts";
import { workflowSessionDirectory } from "../runtime/workflow-session-directory.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Canonical namespace for live repair Moderator/report files under the workflow directory. */
export const MANUAL_REPAIR_NAMESPACE = "repair";

export const DEFAULT_MANUAL_REPAIR_REASON = "Manual repair requested from /agents repair.";

export type ManualRepairReceipt = Readonly<{
	disposition: "created" | "joined";
	moderatorAgentId: string;
}>;

/**
 * Frozen targets are the retired Owner plus the original inventory. The repair
 * namespace is explicitly excluded: checkpoint 2 freeze enumeration must refuse
 * repair-managed paths through isRepairManagedPath.
 */
export function repairSessionDirectory(ownerSessionDirectory: string, workflowId: string): string {
	return [workflowSessionDirectory(ownerSessionDirectory, workflowId), MANUAL_REPAIR_NAMESPACE].join(sep);
}

export function isRepairManagedPath(sessionPath: string, workflowDirectory: string): boolean {
	const scope = relative(workflowDirectory, sessionPath);
	return scope === MANUAL_REPAIR_NAMESPACE || scope.startsWith(MANUAL_REPAIR_NAMESPACE + sep);
}

export function validateManualRepairReason(value: unknown): string {
	if (value === undefined) return DEFAULT_MANUAL_REPAIR_REASON;
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new Error("invalid_input: manual repair reason must be non-empty text");
	}
	return value.trim();
}

export type RepairOwnerSnapshot = Readonly<{
	agentId: string;
	workflowId: string;
	header: Readonly<Record<string, unknown>>;
	entries: readonly SessionEntry[];
}>;

/**
 * Pre-commit Owner target as an immutable snapshot. Reads frozen evidence only:
 * no host, no Run admission, no replay, no writes. The returned value is deeply
 * frozen, so later mutation cannot leak into a fresh read.
 */
export async function readRepairOwnerSnapshot(transcriptPath: string): Promise<RepairOwnerSnapshot> {
	// Discovery-style fresh read: never continue cached validation.
	const transcript = transcriptFromSessionFile(transcriptPath, { fresh: true });
	const inspection = await transcript.refresh();
	const header = inspection.header;
	if (!isRecord(header) || typeof header.id !== "string" || header.id.length === 0) {
		throw new Error(`evidence_unavailable: repair Owner snapshot has no native session header: ${transcriptPath}`);
	}
	const identityEntry = [...inspection.entries].reverse().find(
		(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
			entry.type === "custom" &&
			entry.customType === AGENT_IDENTITY_CUSTOM_TYPE &&
			isRecord(entry.data) &&
			entry.data.agentId === header.id,
	);
	if (!identityEntry || !isRecord(identityEntry.data) || typeof identityEntry.data.workflowId !== "string") {
		throw new Error(`evidence_unavailable: repair Owner snapshot has no verified Owner identity: ${transcriptPath}`);
	}
	return deepFreeze({
		agentId: header.id,
		workflowId: identityEntry.data.workflowId as string,
		header: structuredClone(header) as Record<string, unknown>,
		entries: structuredClone(inspection.entries),
	});
}

/**
 * Preadmission repair-host routing guard. Only admitted records may be routed
 * or controlled; unadmitted originals get a precise unavailable refusal with no
 * writes and no scheduling. The preadmission host otherwise holds verified
 * Owner identity/config source only, never fabricated live participants.
 */
export function assertRepairTargetAdmitted(
	admittedAgentIds: ReadonlySet<string>,
	targetAgentId: string,
): void {
	if (admittedAgentIds.has(targetAgentId)) return;
	throw new Error(
		`unavailable: Agent ${targetAgentId} has no admitted record in the repair host; ` +
		"routing and control are refused without writes or scheduling.",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const entry of Object.values(value)) deepFreeze(entry);
		Object.freeze(value);
	}
	return value;
}

