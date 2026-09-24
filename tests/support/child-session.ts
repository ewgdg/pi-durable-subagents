import { appendFile, writeFile } from "node:fs/promises";

/**
 * A child transcript is indexed by the Identity its Owner commits before launch
 * (src/coordination/spawning.ts). A directly started child needs that same entry,
 * or the bridge cannot bind the child's session to its own Identity.
 */
export async function writeChildSession(options: {
	sessionPath: string;
	sessionId: string;
	cwd: string;
	workflowId: string;
	directSpawnerAgentId: string;
	label: string;
}): Promise<void> {
	const timestamp = new Date().toISOString();
	await writeFile(options.sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: options.sessionId,
		timestamp,
		cwd: options.cwd,
	})}\n`, { mode: 0o600 });
	await appendFile(options.sessionPath, `${JSON.stringify({
		type: "custom",
		id: "child-identity",
		parentId: null,
		timestamp,
		customType: "agent-coordination.identity",
		data: {
			agentId: options.sessionId,
			workflowId: options.workflowId,
			directSpawnerAgentId: options.directSpawnerAgentId,
			creationPreset: null,
			spawnSource: {
				agentId: options.directSpawnerAgentId,
				entryId: "spawn-entry",
				toolCallId: "spawn-call",
			},
			metadata: { label: options.label },
		},
	})}\n`);
}
