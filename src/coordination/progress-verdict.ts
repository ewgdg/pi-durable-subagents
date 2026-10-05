import type { AgentRetentionReason } from "../runtime/agent-runtime-host.ts";

/**
 * Progress Verdict (GLOSSARY.md): the one classification of Agent progress that
 * every Operational Incident detector, Owner Settlement Parking and the delivery
 * scheduler's recipient wait check share. Pure over a plain snapshot.
 */
export type ProgressVerdict = "progressing" | "waiting" | "stalled" | "inactive";

export type WaitingReason =
	| "input_required"
	| "interactive_selection"
	| "interruption_hold"
	| "run_suspension"
	| "isolated_resumption";

export type AgentProgressFacts = Readonly<{
	agentId: string;
	phase: "dormant" | "starting" | "live" | "ending";
	work?: "active" | "settled";
	attention?: "none" | "input_required" | "agent_wait";
	suspended: boolean;
	currentRunFailed: boolean;
	/** Includes `interactive_selection` and `interruption_hold` when present. */
	retentionReasons: readonly AgentRetentionReason[];
	isolatedResumption: boolean;
	unresolvedOperationReview: boolean;
	deliveryProgress: boolean;
	answerObligationRequestIds: readonly string[];
	/** Outgoing Requests without a committed Answer: the only dependency edges. */
	unansweredRequests: readonly Readonly<{ requestId: string; targetAgentId: string }>[];
}>;

export type BlockedDeliveryFacts = Readonly<{ messageId: string; recipientAgentId: string }>;

export type ProgressSnapshot = Readonly<{
	agents: readonly AgentProgressFacts[];
	blockedDeliveries: readonly BlockedDeliveryFacts[];
}>;

export type DependencyDeadlockComponent = Readonly<{
	agentIds: readonly string[];
	requestIds: readonly string[];
}>;

export type DeliveryStallPath = Readonly<{
	messageId: string;
	recipientAgentId: string;
	/** Every Agent on a qualifying path, from obligated roots to the recipient. */
	affectedAgentIds: readonly string[];
	/** Root Answer Obligations and the unanswered Requests along qualifying paths. */
	requestIds: readonly string[];
	/**
	 * Agents whose own stall *is* this blocked Message: its recipient and its
	 * author. An Agent further upstream reached them through a delivered Request,
	 * so it keeps its own independent Obligation Stall condition.
	 */
	stalledAgentIds: readonly string[];
}>;

export type ProgressAssessment = Readonly<{
	/** Each snapshot Agent's verdict after combining its dependencies. */
	verdicts: ReadonlyMap<string, ProgressVerdict>;
	/** Normalized closed components, sorted by member identities. */
	deadlocks: readonly DependencyDeadlockComponent[];
	/** One entry per blocked delivery that an obligated Agent reaches. */
	deliveryStalls: readonly DeliveryStallPath[];
}>;

/** The single definition of a legitimate wait, shared with the delivery scheduler. */
export function waitingReason(facts: AgentProgressFacts): WaitingReason | undefined {
	if (facts.phase !== "dormant" && facts.attention === "input_required") return "input_required";
	if (facts.retentionReasons.includes("interactive_selection")) return "interactive_selection";
	if (facts.retentionReasons.includes("interruption_hold")) return "interruption_hold";
	if (facts.suspended) return "run_suspension";
	if (facts.isolatedResumption) return "isolated_resumption";
	return undefined;
}

export function assessProgress(snapshot: ProgressSnapshot): ProgressAssessment {
	const localVerdicts = new Map(snapshot.agents.map((facts) => [facts.agentId, localVerdict(facts)]));
	return {
		verdicts: combineDependencies(snapshot.agents, localVerdicts),
		deadlocks: detectDependencyDeadlocks(snapshot.agents, localVerdicts),
		deliveryStalls: traceDeliveryStalls(snapshot, localVerdicts),
	};
}

const DEPENDENCY_RANK = { stalled: 0, waiting: 1, progressing: 2 } as const;
type DependencyVerdict = keyof typeof DEPENDENCY_RANK;

/**
 * Best branch wins: a Stalled Agent takes the best verdict reachable through its
 * unanswered Requests (Progressing > Waiting > Stalled). Inactive and unknown
 * targets are no progress source. Verdicts only ever improve, so iterating to a
 * fixed point resolves chains and leaves cycles without a better exit Stalled.
 */
function combineDependencies(
	agents: readonly AgentProgressFacts[],
	localVerdicts: ReadonlyMap<string, ProgressVerdict>,
): ReadonlyMap<string, ProgressVerdict> {
	const verdicts = new Map(localVerdicts);
	const dependent = agents.filter(({ agentId }) => localVerdicts.get(agentId) === "stalled");
	const asDependency = (agentId: string): DependencyVerdict => {
		const verdict = verdicts.get(agentId);
		return verdict === undefined || verdict === "inactive" ? "stalled" : verdict;
	};
	for (let changed = true; changed;) {
		changed = false;
		for (const { agentId, unansweredRequests } of dependent) {
			const current = asDependency(agentId);
			const best = unansweredRequests.map(({ targetAgentId }) => asDependency(targetAgentId))
				.reduce((left, right) => DEPENDENCY_RANK[right] > DEPENDENCY_RANK[left] ? right : left, current);
			if (best === current) continue;
			verdicts.set(agentId, best);
			changed = true;
		}
	}
	return verdicts;
}

function localVerdict(facts: AgentProgressFacts): ProgressVerdict {
	if (facts.phase === "dormant" || facts.currentRunFailed) return "inactive";
	const reason = waitingReason(facts);
	if (reason !== undefined && reason !== "isolated_resumption") return "waiting";
	if (
		facts.phase === "starting" || facts.phase === "ending" || facts.work === "active" ||
		facts.deliveryProgress || facts.unresolvedOperationReview
	) return "progressing";
	// Isolated resumption only blocks ordinary Delivery, so it is a weaker wait than
	// the reasons above and ranks below Progressing: resumed execution is real work,
	// and a parked Owner must not wake while a resumed child is still executing.
	if (reason === "isolated_resumption") return "waiting";
	return "stalled";
}

function traceDeliveryStalls(
	snapshot: ProgressSnapshot,
	localVerdicts: ReadonlyMap<string, ProgressVerdict>,
): readonly DeliveryStallPath[] {
	const factsById = new Map(snapshot.agents.map((facts) => [facts.agentId, facts]));
	// A running model is a progress source, not a timed obligation.
	const roots = snapshot.agents.filter((facts) =>
		facts.phase === "live" && facts.work !== "active" &&
		facts.answerObligationRequestIds.length > 0
	);
	return snapshot.blockedDeliveries.flatMap(({ messageId, recipientAgentId }) => {
		const affected = new Set<string>();
		const requests = new Set<string>();
		for (const root of roots) {
			const visit = (facts: AgentProgressFacts, path: readonly string[], edges: readonly string[]): void => {
				const { agentId } = facts;
				// Human attention, selection, Holds and suspensions exclude the path.
				if (path.includes(agentId) || waitingReason(facts) !== undefined) return;
				const isIntermediate = path.length > 0 && agentId !== recipientAgentId;
				if (isIntermediate && localVerdicts.get(agentId) === "progressing") return;
				const nextPath = [...path, agentId];
				if (agentId === recipientAgentId) {
					for (const id of nextPath) affected.add(id);
					for (const id of [...root.answerObligationRequestIds, ...edges]) requests.add(id);
				}
				for (const { requestId, targetAgentId } of facts.unansweredRequests) {
					const target = factsById.get(targetAgentId);
					if (target) visit(target, nextPath, [...edges, requestId]);
				}
			};
			visit(root, [], []);
		}
		if (requests.size === 0) return [];
		const authors = snapshot.agents.filter(({ unansweredRequests }) =>
			unansweredRequests.some(({ requestId }) => requestId === messageId)
		).map(({ agentId }) => agentId);
		return [{
			messageId,
			recipientAgentId,
			affectedAgentIds: [...affected].sort(),
			requestIds: [...requests].sort(),
			stalledAgentIds: [...new Set([recipientAgentId, ...authors])].sort(),
		}];
	});
}

const DEADLOCK_RETENTION_REASONS: ReadonlySet<AgentRetentionReason> = new Set([
	"awaiting_answer", "answer_owed", "pending_delivery",
]);

/**
 * A member is locally Stalled and retained only by Request relationships. Pending
 * Delivery qualifies because Delivery Progress already makes an Agent Progressing.
 */
function isDeadlockEligible(facts: AgentProgressFacts, verdict: ProgressVerdict | undefined): boolean {
	return verdict === "stalled" && facts.retentionReasons.length > 0 &&
		facts.retentionReasons.every((reason) => DEADLOCK_RETENTION_REASONS.has(reason));
}

function detectDependencyDeadlocks(
	agents: readonly AgentProgressFacts[],
	localVerdicts: ReadonlyMap<string, ProgressVerdict>,
): readonly DependencyDeadlockComponent[] {
	const eligibleAgentIds = agents
		.filter((facts) => isDeadlockEligible(facts, localVerdicts.get(facts.agentId)))
		.map(({ agentId }) => agentId)
		.sort();
	const eligible = new Set(eligibleAgentIds);
	const requests = agents.flatMap(({ agentId, unansweredRequests }) =>
		unansweredRequests.map(({ requestId, targetAgentId }) => ({ requestId, fromAgentId: agentId, targetAgentId }))
	);
	const targetsByAgentId = new Map(
		eligibleAgentIds.map((agentId) => [agentId, new Set<string>()]),
	);
	for (const request of requests) {
		if (eligible.has(request.fromAgentId) && eligible.has(request.targetAgentId)) {
			targetsByAgentId.get(request.fromAgentId)!.add(request.targetAgentId);
		}
	}

	return stronglyConnectedComponents(eligibleAgentIds, targetsByAgentId).flatMap((agentIds) => {
		const members = new Set(agentIds);
		// Upstream dependants cannot supply progress to the component they await.
		const incidentRequests = requests.filter((request) => members.has(request.fromAgentId));
		const isCycle = agentIds.length > 1 || incidentRequests.some(
			(request) => request.targetAgentId === agentIds[0],
		);
		const isClosed = incidentRequests.length > 0 &&
			incidentRequests.every((request) => members.has(request.targetAgentId));
		if (!isCycle || !isClosed) return [];
		return [{
			agentIds,
			requestIds: incidentRequests.map(({ requestId }) => requestId).sort(),
		}];
	}).sort((left, right) => compareStringArrays(left.agentIds, right.agentIds));
}

function stronglyConnectedComponents(
	agentIds: readonly string[],
	targetsByAgentId: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
	let nextIndex = 0;
	const indexByAgentId = new Map<string, number>();
	const lowLinkByAgentId = new Map<string, number>();
	const stack: string[] = [];
	const stacked = new Set<string>();
	const components: string[][] = [];

	const visit = (agentId: string): void => {
		const index = nextIndex;
		nextIndex += 1;
		indexByAgentId.set(agentId, index);
		lowLinkByAgentId.set(agentId, index);
		stack.push(agentId);
		stacked.add(agentId);

		for (const targetAgentId of targetsByAgentId.get(agentId) ?? []) {
			if (!indexByAgentId.has(targetAgentId)) {
				visit(targetAgentId);
				lowLinkByAgentId.set(agentId, Math.min(lowLinkByAgentId.get(agentId)!, lowLinkByAgentId.get(targetAgentId)!));
			} else if (stacked.has(targetAgentId)) {
				lowLinkByAgentId.set(agentId, Math.min(lowLinkByAgentId.get(agentId)!, indexByAgentId.get(targetAgentId)!));
			}
		}

		if (lowLinkByAgentId.get(agentId) !== index) return;
		const component: string[] = [];
		while (stack.length > 0) {
			const member = stack.pop()!;
			stacked.delete(member);
			component.push(member);
			if (member === agentId) break;
		}
		components.push(component.sort());
	};

	for (const agentId of agentIds) {
		if (!indexByAgentId.has(agentId)) visit(agentId);
	}
	return components;
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const order = left[index]!.localeCompare(right[index]!);
		if (order !== 0) return order;
	}
	return left.length - right.length;
}
