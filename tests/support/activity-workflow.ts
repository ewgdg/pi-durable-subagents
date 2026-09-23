import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpawnBoundaryHooks } from "../../src/coordination/spawning.ts";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ColdWorkflowRecovery, RecoveredOrdinaryAgent } from "../../src/bootstrap/cold-host-discovery.ts";
import { transcriptFromSessionFile, transcriptFromSessionManager } from "../../src/pi-integration/session-manager-transcript.ts";
import { adoptOrValidateOwnerIdentity } from "../../src/protocol/owner-identity.ts";
import { toolCallPointerKey } from "../../src/protocol/identities.ts";
import { createTestOwnerHost, type TestCleanupRegistrar } from "./pi-host.ts";
import { createTestWorkflowCoordinator } from "./workflow-coordinator.ts";

/** Source-complete dormant Agents: no child processes, providers, or synthetic private coordinator state. */
export async function activityWorkflow(
	cleanup: TestCleanupRegistrar,
	children: readonly { id: string; parent?: string }[],
	spawnBoundaryHooks?: SpawnBoundaryHooks,
) {
	const host = await createTestOwnerHost(cleanup, () => {}, { persistent: true });
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const managers = new Map([[identity.agentId, host.session.sessionManager]]);
	const agents: RecoveredOrdinaryAgent[] = [];
	const transcriptPathByAgentId = new Map<string, string>();
	const agentIdBySpawnSource = new Map<string, string>();
	for (const child of children) {
		const parentId = child.parent ?? identity.agentId;
		const parent = managers.get(parentId);
		if (!parent) throw new Error(`Fixture parent is missing: ${parentId}`);
		const creationInput = { title: `Work for ${child.id}`, request: "Retain this request.", label: child.id };
		const toolCallId = `spawn-${child.id}`;
		const entryId = parent.appendMessage(fauxAssistantMessage(
			fauxToolCall("agent_spawn", creationInput, { id: toolCallId }),
			{ stopReason: "toolUse" },
		));
		const spawnSource = { agentId: parentId, entryId, toolCallId };
		const childIdentity = {
			agentId: child.id,
			workflowId: identity.workflowId,
			directSpawnerAgentId: parentId,
			spawnSource,
			metadata: { label: child.id },
			creationPreset: null,
		};
		const manager = SessionManager.inMemory(host.cwd, { id: child.id });
		manager.appendCustomEntry("agent-coordination.identity", childIdentity);
		managers.set(child.id, manager);
		const sessionPath = join(host.cwd, `${child.id}.jsonl`);
		agents.push({ role: "ordinary", identity: childIdentity, creationInput, sessionPath });
		transcriptPathByAgentId.set(child.id, sessionPath);
		agentIdBySpawnSource.set(toolCallPointerKey(spawnSource), child.id);
	}
	async function persist(agentId: string): Promise<void> {
		const manager = managers.get(agentId)!;
		await writeFile(transcriptPathByAgentId.get(agentId)!,
			[manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	}
	for (const child of children) await persist(child.id);
	const recoveredWorkflow: ColdWorkflowRecovery = {
		agents, transcriptPathByAgentId, agentIdBySpawnSource,
		quarantinedAgentIds: new Set(), quarantinedWorkflowAgentIds: new Set(), quarantinedCandidateCount: 0,
	};
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
		recoveredWorkflow, spawnBoundaryHooks,
	});
	const owner = coordinator.forAgent(identity.agentId);
	await owner.reachSafeBoundary();
	await yieldTurn();
	const transcripts = new Map([
		[identity.agentId, transcriptFromSessionManager(host.session.sessionManager)],
		...children.map(child => [child.id, transcriptFromSessionFile(transcriptPathByAgentId.get(child.id)!)] as const),
	]);
	return { host, identity, coordinator, owner, managers, transcripts, persist };
}
