import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const REPAIR_HOST_TYPE = "agent-coordination.repair-host";
export type RepairHost = Readonly<{
	version: 1;
	hostSessionId: string;
	attemptId: string;
	ownerPath: string;
	bootstrapPath: string;
}>;

export async function createRepairHost(options: {
	directory: string; cwd: string; attemptId: string; ownerPath: string; bootstrapPath: string;
}): Promise<string> {
	const hostSessionId = randomUUID();
	const timestamp = new Date().toISOString();
	const path = join(options.directory, "repair-host.jsonl");
	const data: RepairHost = { version: 1, hostSessionId, attemptId: options.attemptId,
		ownerPath: options.ownerPath, bootstrapPath: options.bootstrapPath };
	await mkdir(options.directory, { recursive: true, mode: 0o700 });
	// SessionManager defers a new file's persistence until an assistant message.
	// This deliberately non-conversational session needs only a header and tag.
	await writeFile(path, [
		{ type: "session", version: 3, id: hostSessionId, timestamp, cwd: options.cwd },
		{ type: "custom", id: randomUUID().slice(0, 8), parentId: null, timestamp, customType: REPAIR_HOST_TYPE, data },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
	return path;
}

export function readRepairHost(manager: { getSessionId(): string; getEntries(): SessionEntry[] }): RepairHost | undefined {
	const candidates = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === REPAIR_HOST_TYPE);
	for (const entry of candidates) {
		if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) continue;
		const data = entry.data as Partial<RepairHost>;
		if (data.hostSessionId !== manager.getSessionId()) continue;
		if (data.version !== 1 || typeof data.attemptId !== "string" || !data.attemptId ||
			typeof data.ownerPath !== "string" || !isAbsolute(data.ownerPath) ||
			typeof data.bootstrapPath !== "string" || !isAbsolute(data.bootstrapPath)) {
			throw new Error("Invalid repair-host bootstrap");
		}
		return data as RepairHost;
	}
	return undefined;
}
