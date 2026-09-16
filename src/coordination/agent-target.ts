export type AgentTargetCandidate = Readonly<{
	agentId: string;
	label: string;
}>;

/** Identity precedence is shared; each operation supplies its own label scope. */
export function resolveAgentTarget<Candidate extends AgentTargetCandidate>(
	identityCandidates: Iterable<Candidate>,
	labelCandidates: Iterable<Candidate>,
	targetAgent: string,
): Candidate {
	const selector = targetAgent.trim();
	if (!selector) throw new Error("invalid_input: Agent selector must not be blank");
	const identity = resolveIdentityCandidate([...identityCandidates], selector);
	if (identity) return identity;
	const labelMatches = [...labelCandidates].filter(({ label }) => label === selector);
	if (labelMatches.length === 1) return labelMatches[0]!;
	if (labelMatches.length > 1) {
		throw new Error(
			`ambiguous_target: Agent label ${selector} matches ${labelMatches.length} addressable Agents`,
		);
	}
	throw new Error(`unknown_identity: Agent target ${selector}`);
}

export function resolveIdentityCandidate<Candidate extends AgentTargetCandidate>(
	candidates: readonly Candidate[],
	selector: string,
): Candidate | undefined {
	const exactIdentity = candidates.find(({ agentId }) => agentId === selector);
	if (exactIdentity) return exactIdentity;
	const suffixMatches = candidates.filter(({ agentId }) => agentId.endsWith(selector));
	if (suffixMatches.length === 1) return suffixMatches[0]!;
	if (suffixMatches.length > 1) {
		throw new Error(
			`ambiguous_target: Agent ID suffix ${selector} matches ${suffixMatches.length} Agents`,
		);
	}
	return undefined;
}
