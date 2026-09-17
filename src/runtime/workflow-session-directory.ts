import { join } from "node:path";

const WORKFLOW_SESSION_DIRECTORY = "pi-durable-subagents";

/**
 * Pi enforces this shape when it creates a session, but copies a loaded session
 * header's id verbatim. The Workflow id is that session id, and this path is the
 * only place it becomes a directory segment, so re-assert the shape here instead
 * of assuming every loaded header is well formed.
 */
const SAFE_WORKFLOW_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function workflowSessionDirectory(
	ownerSessionDirectory: string,
	workflowId: string,
): string {
	if (ownerSessionDirectory.length === 0) {
		throw new Error("Owner has no durable Pi session directory");
	}
	if (!SAFE_WORKFLOW_ID.test(workflowId)) {
		throw new Error(
			`Workflow id cannot be used as a directory segment: ${JSON.stringify(workflowId)}`,
		);
	}
	return join(ownerSessionDirectory, WORKFLOW_SESSION_DIRECTORY, workflowId);
}
