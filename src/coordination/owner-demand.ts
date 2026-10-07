/**
 * Owner Demand (GLOSSARY.md): the Requests someone upstream still awaits. An
 * unanswered Request is demanded when its requester is a demand root (the
 * Workflow Owner or a Moderator acting for it) or is the target of a demanded
 * Request. Incident detection scopes to demanded obligations, so a requester's
 * Cancellation also releases the work orphaned beneath it, even where an Agent
 * can never act again.
 */
export type UnansweredRequestEdge = Readonly<{
	requestId: string;
	requesterAgentId: string;
	targetAgentId: string;
}>;

export function demandedRequestIds(
	demandRootAgentIds: Iterable<string>,
	unansweredRequests: readonly UnansweredRequestEdge[],
): ReadonlySet<string> {
	const demandedAgentIds = new Set(demandRootAgentIds);
	const demanded = new Set<string>();
	// Demand only ever grows, so iterating to a fixed point handles chains and cycles.
	for (let changed = true; changed;) {
		changed = false;
		for (const { requestId, requesterAgentId, targetAgentId } of unansweredRequests) {
			if (demanded.has(requestId) || !demandedAgentIds.has(requesterAgentId)) continue;
			demanded.add(requestId);
			demandedAgentIds.add(targetAgentId);
			changed = true;
		}
	}
	return demanded;
}
