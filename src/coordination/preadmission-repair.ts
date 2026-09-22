import { isAbsolute, join, dirname } from "node:path";
import { workflowSessionDirectory } from "../runtime/workflow-session-directory.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";

/** Verified Owner identity + native config source only. No history replay. */
export type PreadmissionRepairEvidence = Readonly<{
  ownerId: string;
  workflowId: string;
  sessionDir: string;
  workflowDirectory: string;
  agentDir: string;
  transcriptPath: string | undefined;
  stage: string;
}>;

/**
 * Capture preadmission repair evidence from already-verified Owner identity
 * plus captured native config (sessionDir, agentDir). Never replays broken
 * coordination history: no transcript refresh, no SessionManager entry scan,
 * no fabricated Owner AgentRecord, no recovered relationships, no Request
 * titles, no live originals. Unadmitted-original routing stays
 * precise-unavailable via assertRepairTargetAdmitted.
 *
 * Manual only: this module exposes no watcher and no auto trigger. The human
 * must run /agents repair (or the diagnostics repair action) explicitly.
 */
export function capturePreadmissionRepairEvidence(options: Readonly<{
  ownerIdentity: OwnerIdentity;
  sessionDir: string;
  agentDir: string;
  transcriptPath?: string;
  stage?: string;
}>): PreadmissionRepairEvidence {
  const identity = options.ownerIdentity;
  if (!identity || typeof identity.agentId !== "string" || identity.agentId.length === 0) {
    throw new Error("invalid_input: preadmission repair needs a verified Owner identity");
  }
  if (identity.workflowId !== identity.agentId) {
    throw new Error("invalid_input: preadmission Owner identity must have workflowId === agentId");
  }
  if (identity.directSpawnerAgentId !== null) {
    throw new Error("invalid_input: preadmission Owner identity must have no spawner");
  }
  if (identity.metadata?.label !== "Owner") {
    throw new Error("invalid_input: preadmission repair Owner identity label must be Owner");
  }
  const sessionDir = (options as { sessionDir?: unknown }).sessionDir;
  const agentDir = (options as { agentDir?: unknown }).agentDir;
  if (typeof sessionDir !== "string" || !isAbsolute(sessionDir)) {
    throw new Error("invalid_input: preadmission repair needs an absolute native session dir");
  }
  if (typeof agentDir !== "string" || !isAbsolute(agentDir)) {
    throw new Error("invalid_input: preadmission repair needs an absolute native agent dir (config source)");
  }
  const workflowDirectory = workflowSessionDirectory(sessionDir, identity.workflowId);
  const transcriptPath = (options as { transcriptPath?: unknown }).transcriptPath;
  if (transcriptPath !== undefined && (typeof transcriptPath !== "string" || transcriptPath.length === 0)) {
    throw new Error("invalid_input: preadmission transcript path must be a non-empty string when present");
  }
  const stage = (options as { stage?: unknown }).stage;
  const resolvedStage = typeof stage === "string" && stage.length > 0 ? stage : "Owner coordination initialization";
  return Object.freeze({
    ownerId: identity.agentId,
    workflowId: identity.workflowId,
    sessionDir,
    workflowDirectory,
    agentDir,
    transcriptPath,
    stage: resolvedStage,
  });
}

/** Truthful manual-repair scope for diagnostics and confirm prompts. */
export function describePreadmissionRepairScope(): string {
  return [
    "Manual repair opens a real Moderator for diagnosis first.",
    "Replace needs your explicit approval, then backup/verify, then idle reopen.",
    "Unadmitted originals stay unavailable; no auto trigger, no watcher.",
  ].join(" ");
}

/** Journal dir for repair approvals/receipts: sibling of the workflow dir, never inside it. */
export function preadmissionRepairJournalDir(workflowDirectory: string): string {
  if (!isAbsolute(workflowDirectory)) throw new Error("invalid_input: workflow directory must be an absolute path");
  return join(dirname(workflowDirectory), "repair-journal");
}

/** Backup root for frozen-target backups: sibling of the workflow dir, never inside it. */
export function preadmissionRepairBackupRoot(workflowDirectory: string): string {
  if (!isAbsolute(workflowDirectory)) throw new Error("invalid_input: workflow directory must be an absolute path");
  return join(dirname(workflowDirectory), "repair-backups");
}

