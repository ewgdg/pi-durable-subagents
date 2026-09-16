import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Close supported native input entrypoints; already-started work is joined separately. */
export function closeRepairInput(session: AgentSession): void {
	const refuse = () => { throw new Error("Workflow repair has retired this session's input; use the repair host for diagnostics"); };
	// The guard survives coordination cleanup restoring its own startup wrappers.
	// No restoration is correct: successful repair always uses a NEW native session.
	session.agent.prompt = async () => refuse();
	session.executeBash = async () => refuse();
}
