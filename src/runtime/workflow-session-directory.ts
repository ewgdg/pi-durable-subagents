import { join } from "node:path";

const WORKFLOW_SESSION_DIRECTORY = "pi-durable-subagents";

export function workflowSessionDirectory(
	ownerSessionDirectory: string,
	workflowId: string,
): string {
	if (ownerSessionDirectory.length === 0) {
		throw new Error("Owner has no durable Pi session directory");
	}
	const encodedWorkflowId = Buffer.from(workflowId, "utf8").toString("base64url");
	return join(
		ownerSessionDirectory,
		WORKFLOW_SESSION_DIRECTORY,
		encodedWorkflowId,
	);
}
