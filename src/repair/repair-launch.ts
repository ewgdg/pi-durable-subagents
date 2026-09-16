import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { isAgentCreationPreset } from "../protocol/agent-creation-preset.ts";
import type { AgentCreationPreset } from "../templates/agent-templates.ts";

export type RepairLaunch = Readonly<{
	version: 1;
	attemptId: string;
	moderatorAgentId: string;
	owner: { path: string; workflowId: string; sessionId: string; identityEntryId: string };
	admissionFailure: { stage: string; reason: string; transcriptPath: string; agentId: string };
	storageRoot: string;
	participantDirectory: string;
	cwd: string;
	agentDir: string;
	model: { provider: string; modelId: string };
	thinking: string;
	creationPreset: AgentCreationPreset;
}>;

export type RepairArchiveLaunch = Omit<RepairLaunch, "admissionFailure"> & Partial<Pick<RepairLaunch, "admissionFailure">>;

/** Archive-only reader: old journals must remain recoverable, never restartable. */
export async function readRepairArchiveLaunch(path: string): Promise<RepairArchiveLaunch> {
	const value = JSON.parse(await readFile(path, "utf8")) as RepairArchiveLaunch;
	if (!value || value.version !== 1 || !value.owner || !value.model ||
		![value.attemptId, value.moderatorAgentId, value.owner.workflowId, value.owner.identityEntryId,
			value.model.provider, value.model.modelId, value.thinking].every((field) => typeof field === "string" && field.length > 0 && !field.includes("\0")) ||
		value.owner.workflowId !== value.owner.sessionId || value.moderatorAgentId === value.owner.workflowId ||
		![value.owner.path, value.storageRoot, value.participantDirectory, value.cwd, value.agentDir].every((field) => typeof field === "string" && isAbsolute(field)) ||
		!isAgentCreationPreset(value.creationPreset)) {
		throw new Error("Invalid independent repair launch");
	}
	return value;
}

export async function readRepairLaunch(path: string): Promise<RepairLaunch> {
	const value = await readRepairArchiveLaunch(path);
	const failure = value.admissionFailure;
	if (!failure || failure.transcriptPath !== value.owner.path || failure.agentId !== value.owner.workflowId ||
		failure.reason !== "invariant_violation: Message has duplicate Deliveries" ||
		typeof failure.stage !== "string" || !failure.stage.trim()) {
		throw new Error("New repair helper requires a supported actual admission failure binding; archived attempts are recovery-only");
	}
	return value as RepairLaunch;
}

/** Lifecycle metadata is separate from storage's sealed replacement journal. */
export async function writeRepairRecord(path: string, value: unknown, append = false): Promise<void> {
	const file = await open(path, append ? "a" : "wx", 0o600);
	try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
	finally { await file.close(); }
	const directory = await open(dirname(path), "r");
	try { await directory.sync(); } finally { await directory.close(); }
}
