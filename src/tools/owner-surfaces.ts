import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { OrdinaryAgentCoordinatorView } from "../coordination/workflow-coordinator.ts";
import {
	coordinationToolActivation,
	registerCoordinationTools,
	type SpawnGuidanceRefresh,
} from "./coordination-tools.ts";
import { createViewBackedParticipantHandlers } from "../coordination/view-backed-participant-handlers.ts";
import type { WorkflowInteraction } from "../pi-integration/workflow-interaction.ts";

/** Give an admitted Owner exactly its active coordination tools, or none when not admitted. */
export function setOwnerAgentToolsActive(
	pi: ExtensionAPI,
	interaction: WorkflowInteraction,
	admitted: boolean,
): void {
	const { roleTools, activeTools } = coordinationToolActivation("owner", interaction);
	const otherTools = pi.getActiveTools().filter((name) => !(roleTools as readonly string[]).includes(name));
	pi.setActiveTools(admitted ? [...otherTools, ...activeTools] : otherTools);
}

export function registerOwnerAgentTools(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView,
): SpawnGuidanceRefresh {
	return registerCoordinationTools(
		pi,
		"owner",
		createViewBackedParticipantHandlers("owner", resolveView).coordination,
		{
			resolveAgentLabel: (agentId) => resolveView().agentLabel(agentId),
			resolveAnswerTargetAgent: (toolCallId) => resolveView().answerTargetAgent(toolCallId),
		},
	);
}
