import assert from "node:assert/strict";
import test from "node:test";

import {
	assessProgress,
	waitingReason,
	type AgentProgressFacts,
	type ProgressSnapshot,
} from "../src/coordination/progress-verdict.ts";

/** A live, settled Agent with no progress source: locally Stalled. */
function agent(agentId: string, facts: Partial<AgentProgressFacts> = {}): AgentProgressFacts {
	return {
		agentId,
		phase: "live",
		work: "settled",
		attention: "none",
		suspended: false,
		currentRunFailed: false,
		retentionReasons: [],
		isolatedResumption: false,
		unresolvedOperationReview: false,
		deliveryProgress: false,
		answerObligationRequestIds: [],
		unansweredRequests: [],
		...facts,
	};
}

function request(requestId: string, targetAgentId: string) {
	return { requestId, targetAgentId };
}

function verdicts(snapshot: Partial<ProgressSnapshot> & Pick<ProgressSnapshot, "agents">) {
	return Object.fromEntries(assessProgress({ blockedDeliveries: [], ...snapshot }).verdicts);
}

test("local facts map to one verdict with Inactive, Waiting, Progressing, Stalled precedence", () => {
	const rows: [string, AgentProgressFacts, string, string | undefined][] = [
		["dormant", agent("a", { phase: "dormant", work: undefined, attention: undefined }), "inactive", undefined],
		["failed current Run", agent("a", { currentRunFailed: true, work: "active" }), "inactive", undefined],
		["failed Run under human attention", agent("a", { currentRunFailed: true, attention: "input_required" }), "inactive", "input_required"],
		["human input during active work", agent("a", { work: "active", attention: "input_required" }), "waiting", "input_required"],
		["interactive selection", agent("a", { work: "active", retentionReasons: ["interactive_selection"] }), "waiting", "interactive_selection"],
		["Interruption Hold", agent("a", { retentionReasons: ["interruption_hold"] }), "waiting", "interruption_hold"],
		["suspended starting Run", agent("a", { phase: "starting", work: undefined, suspended: true }), "waiting", "run_suspension"],
		["settled isolated resumption", agent("a", { isolatedResumption: true }), "waiting", "isolated_resumption"],
		["resumed execution in isolation", agent("a", { work: "active", isolatedResumption: true }), "progressing", "isolated_resumption"],
		["starting", agent("a", { phase: "starting", work: undefined }), "progressing", undefined],
		["ending", agent("a", { phase: "ending" }), "progressing", undefined],
		["active work", agent("a", { work: "active" }), "progressing", undefined],
		["Delivery Progress", agent("a", { deliveryProgress: true }), "progressing", undefined],
		["unresolved Operation Review call", agent("a", { unresolvedOperationReview: true }), "progressing", undefined],
		["settled in Agent Wait", agent("a", { attention: "agent_wait" }), "stalled", undefined],
		["live and settled", agent("a"), "stalled", undefined],
	];
	for (const [scenario, facts, verdict, reason] of rows) {
		assert.equal(verdicts({ agents: [facts] }).a, verdict, scenario);
		assert.equal(waitingReason(facts), reason, scenario);
	}
});

test("a Stalled Agent takes the best verdict among its unanswered Request targets", () => {
	const rows: [string, AgentProgressFacts[], Record<string, string>][] = [
		["Progressing branch beats a Stalled one", [
			agent("parent", { unansweredRequests: [request("r1", "busy"), request("r2", "idle")] }),
			agent("busy", { work: "active" }),
			agent("idle"),
		], { parent: "progressing", busy: "progressing", idle: "stalled" }],
		["Waiting branch beats a Stalled one", [
			agent("parent", { unansweredRequests: [request("r1", "asking"), request("r2", "idle")] }),
			agent("asking", { attention: "input_required" }),
			agent("idle"),
		], { parent: "waiting", asking: "waiting", idle: "stalled" }],
		["Progressing beats Waiting", [
			agent("parent", { unansweredRequests: [request("r1", "held"), request("r2", "busy")] }),
			agent("held", { retentionReasons: ["interruption_hold"] }),
			agent("busy", { phase: "starting", work: undefined }),
		], { parent: "progressing", held: "waiting", busy: "progressing" }],
		["Run Suspension and human input are the same Waiting", [
			agent("on-quota", { unansweredRequests: [request("r1", "suspended")] }),
			agent("suspended", { suspended: true }),
			agent("on-human", { unansweredRequests: [request("r2", "asking")] }),
			agent("asking", { attention: "input_required" }),
		], { "on-quota": "waiting", suspended: "waiting", "on-human": "waiting", asking: "waiting" }],
		["the verdict propagates through settled intermediates", [
			agent("root", { attention: "agent_wait", unansweredRequests: [request("r1", "middle")] }),
			agent("middle", { unansweredRequests: [request("r2", "leaf")] }),
			agent("leaf", { work: "active" }),
		], { root: "progressing", middle: "progressing", leaf: "progressing" }],
		["a dormant or failed target is no progress source", [
			agent("to-dormant", { unansweredRequests: [request("r1", "dormant")] }),
			agent("dormant", { phase: "dormant", work: undefined, attention: undefined }),
			agent("to-failed", { unansweredRequests: [request("r2", "failed")] }),
			agent("failed", { currentRunFailed: true }),
		], { "to-dormant": "stalled", dormant: "inactive", "to-failed": "stalled", failed: "inactive" }],
		["a target outside the snapshot is no progress source", [
			agent("parent", { unansweredRequests: [request("r1", "moderator")] }),
		], { parent: "stalled" }],
		["a cycle stays Stalled", [
			agent("a", { unansweredRequests: [request("r1", "b")] }),
			agent("b", { unansweredRequests: [request("r2", "a")] }),
		], { a: "stalled", b: "stalled" }],
		["a self-cycle stays Stalled", [
			agent("a", { unansweredRequests: [request("r1", "a")] }),
		], { a: "stalled" }],
		["a cycle with an exit takes the exit's verdict", [
			agent("a", { unansweredRequests: [request("r1", "b")] }),
			agent("b", { unansweredRequests: [request("r2", "a"), request("r3", "c")] }),
			agent("c", { suspended: true }),
		], { a: "waiting", b: "waiting", c: "waiting" }],
		["a non-Stalled Agent keeps its own verdict", [
			agent("asking", { attention: "input_required", unansweredRequests: [request("r1", "busy")] }),
			agent("busy", { work: "active" }),
		], { asking: "waiting", busy: "progressing" }],
	];
	for (const [scenario, agents, expected] of rows) {
		assert.deepEqual(verdicts({ agents }), expected, scenario);
	}
});

/** A settled Agent retained only by its Request relationships: a Deadlock candidate. */
function waiter(agentId: string, requests: ReturnType<typeof request>[], facts: Partial<AgentProgressFacts> = {}) {
	return agent(agentId, {
		retentionReasons: ["awaiting_answer", "answer_owed"],
		answerObligationRequestIds: [`owed-${agentId}`],
		unansweredRequests: requests,
		...facts,
	});
}

function deadlocks(agents: AgentProgressFacts[]) {
	return assessProgress({ agents, blockedDeliveries: [] }).deadlocks;
}

test("closed dependency cycles normalize independently of input order", () => {
	assert.deepEqual(deadlocks([
		waiter("delta", [request("request-delta-external", "external")]),
		waiter("charlie", [request("request-charlie-self", "charlie")]),
		waiter("bravo", [request("request-bravo-alpha", "alpha")]),
		waiter("alpha", [request("request-alpha-bravo", "bravo")]),
	]), [
		{ agentIds: ["alpha", "bravo"], requestIds: ["request-alpha-bravo", "request-bravo-alpha"] },
		{ agentIds: ["charlie"], requestIds: ["request-charlie-self"] },
	]);
});

test("only outgoing external dependencies open a waiting cycle", () => {
	const cycle = [
		waiter("alpha", [request("alpha-bravo", "bravo")]),
		waiter("bravo", [request("bravo-alpha", "alpha")]),
	];
	assert.deepEqual(deadlocks([...cycle, agent("upstream", { work: "active", unansweredRequests: [request("upstream-alpha", "alpha")] })]),
		[{ agentIds: ["alpha", "bravo"], requestIds: ["alpha-bravo", "bravo-alpha"] }]);
	assert.deepEqual(deadlocks([
		waiter("alpha", [request("alpha-bravo", "bravo"), request("alpha-external", "external")]),
		cycle[1]!,
	]), []);
});

test("an upstream dependant cannot provide progress to a closed waiting cycle", () => {
	assert.deepEqual(deadlocks([
		waiter("owner", [request("root", "child")]),
		waiter("child", [request("work", "grandchild")]),
		waiter("grandchild", [request("reverse", "child")]),
	]), [{ agentIds: ["child", "grandchild"], requestIds: ["reverse", "work"] }]);
});

test("Deadlock membership requires a locally Stalled Agent retained only by Request relationships", () => {
	const cycleWith = (facts: Partial<AgentProgressFacts>) => deadlocks([
		waiter("alpha", [request("alpha-bravo", "bravo")]),
		waiter("bravo", [request("bravo-alpha", "alpha")], facts),
	]);
	const closed = [{ agentIds: ["alpha", "bravo"], requestIds: ["alpha-bravo", "bravo-alpha"] }];
	const rows: [string, Partial<AgentProgressFacts>, typeof closed | []][] = [
		["parked in Agent Wait", { attention: "agent_wait" }, closed],
		["pending Delivery without Delivery Progress", { retentionReasons: ["awaiting_answer", "pending_delivery"] }, closed],
		["pending Delivery that can still advance", { retentionReasons: ["awaiting_answer", "pending_delivery"], deliveryProgress: true }, []],
		["Moderator handling retention", { retentionReasons: ["awaiting_answer", "moderator_handling"] }, []],
		["Owner host binding", { retentionReasons: ["awaiting_answer", "owner_host_binding"] }, []],
		["no retention", { retentionReasons: [] }, []],
		["interactive selection", { retentionReasons: ["awaiting_answer", "interactive_selection"] }, []],
		["Interruption Hold", { retentionReasons: ["awaiting_answer", "interruption_hold"] }, []],
		["human input", { attention: "input_required" }, []],
		["Run Suspension", { suspended: true }, []],
		["settled isolated resumption", { isolatedResumption: true }, []],
		["unresolved Operation Review call", { unresolvedOperationReview: true }, []],
		["failed current Run", { currentRunFailed: true }, []],
		["ending Run", { phase: "ending" }, []],
		["active work", { work: "active" }, []],
	];
	for (const [scenario, facts, expected] of rows) assert.deepEqual(cycleWith(facts), expected, scenario);
});

function deliveryStalls(agents: AgentProgressFacts[], messageId = "blocked", recipientAgentId = "leaf") {
	return assessProgress({ agents, blockedDeliveries: [{ messageId, recipientAgentId }] }).deliveryStalls;
}

test("a Delivery Stall path runs from an obligated root through unanswered Requests to the blocked recipient", () => {
	assert.deepEqual(deliveryStalls([
		agent("root", { answerObligationRequestIds: ["owed"], unansweredRequests: [request("delegated", "middle")] }),
		agent("middle", { unansweredRequests: [request("blocked", "leaf")] }),
		agent("leaf", { phase: "dormant", work: undefined, attention: undefined }),
		agent("bystander", { answerObligationRequestIds: ["other"] }),
	]), [{
		messageId: "blocked",
		recipientAgentId: "leaf",
		affectedAgentIds: ["leaf", "middle", "root"],
		requestIds: ["blocked", "delegated", "owed"],
		// The blocked Message's own participants: its recipient and its author.
		stalledAgentIds: ["leaf", "middle"],
	}]);
});

test("Delivery Stall roots are live obligated Agents without ordinary active work", () => {
	const fromRoot = (facts: Partial<AgentProgressFacts>) => deliveryStalls([
		agent("root", { answerObligationRequestIds: ["owed"], unansweredRequests: [request("blocked", "leaf")], ...facts }),
		agent("leaf", { phase: "starting", work: undefined }),
	]).length;
	const rows: [string, Partial<AgentProgressFacts>, number][] = [
		["settled", {}, 1],
		["parked in Agent Wait", { attention: "agent_wait" }, 1],
		["with Delivery Progress of its own", { deliveryProgress: true }, 1],
		["without an Answer Obligation", { answerObligationRequestIds: [] }, 0],
		["doing active work", { work: "active" }, 0],
		["starting", { phase: "starting", work: undefined }, 0],
		["dormant", { phase: "dormant", work: undefined, attention: undefined }, 0],
		["Waiting on human input", { attention: "input_required" }, 0],
	];
	for (const [scenario, facts, count] of rows) assert.equal(fromRoot(facts), count, scenario);
});

test("a Waiting Agent anywhere on the path excludes it; a Progressing intermediate ends it", () => {
	const through = (middle: Partial<AgentProgressFacts>, leaf: Partial<AgentProgressFacts> = {}) => deliveryStalls([
		agent("root", { answerObligationRequestIds: ["owed"], unansweredRequests: [request("delegated", "middle")] }),
		agent("middle", { unansweredRequests: [request("blocked", "leaf")], ...middle }),
		agent("leaf", leaf),
	]).length;
	const rows: [string, Partial<AgentProgressFacts>, Partial<AgentProgressFacts>, number][] = [
		["settled path", {}, {}, 1],
		["intermediate Interruption Hold", { retentionReasons: ["interruption_hold"] }, {}, 0],
		["intermediate interactive selection", { retentionReasons: ["interactive_selection"] }, {}, 0],
		["intermediate Run Suspension", { suspended: true }, {}, 0],
		["recipient waiting on human input", {}, { attention: "input_required" }, 0],
		["recipient isolated resumption", {}, { isolatedResumption: true }, 0],
		["active intermediate", { work: "active" }, {}, 0],
		["starting intermediate", { phase: "starting", work: undefined }, {}, 0],
		["ending intermediate", { phase: "ending" }, {}, 0],
		["active recipient is always included", {}, { work: "active" }, 1],
	];
	for (const [scenario, middle, leaf, count] of rows) assert.equal(through(middle, leaf), count, scenario);
});

test("Moderator scope comes from which Agents the snapshot holds", () => {
	const moderator = waiter("moderator", [], { work: "active" });
	const requester = waiter("requester", [request("to-moderator", "moderator")]);
	// A Moderator's own reminder check sees every Agent; ordinary detection omits Moderators.
	assert.equal(verdicts({ agents: [requester, moderator] }).requester, "progressing");
	assert.equal(verdicts({ agents: [requester] }).requester, "stalled");
});

test("one snapshot classifies each Agent the same way for every detector", () => {
	const assessment = assessProgress({
		agents: [
			waiter("alpha", [request("alpha-bravo", "bravo")]),
			waiter("bravo", [request("bravo-alpha", "alpha")]),
			waiter("quota-parent", [request("to-suspended", "suspended")]),
			agent("suspended", { suspended: true, answerObligationRequestIds: ["owed-suspended"], unansweredRequests: [request("from-suspended", "quota-leaf")] }),
			agent("quota-leaf", { phase: "dormant", work: undefined, attention: undefined }),
			waiter("stalled-parent", [request("to-leaf", "leaf")]),
			agent("leaf", { phase: "dormant", work: undefined, attention: undefined }),
		],
		blockedDeliveries: [{ messageId: "to-leaf", recipientAgentId: "leaf" }, { messageId: "from-suspended", recipientAgentId: "quota-leaf" }],
	});
	assert.deepEqual(Object.fromEntries(assessment.verdicts), {
		alpha: "stalled",
		bravo: "stalled",
		"quota-parent": "waiting",
		suspended: "waiting",
		"quota-leaf": "inactive",
		"stalled-parent": "stalled",
		leaf: "inactive",
	});
	// Deadlock members are Stalled; the Waiting parent is neither a member nor a path root.
	assert.deepEqual(assessment.deadlocks, [{ agentIds: ["alpha", "bravo"], requestIds: ["alpha-bravo", "bravo-alpha"] }]);
	assert.deepEqual(assessment.deliveryStalls, [{
		messageId: "to-leaf",
		recipientAgentId: "leaf",
		affectedAgentIds: ["leaf", "stalled-parent"],
		requestIds: ["owed-stalled-parent", "to-leaf"],
		stalledAgentIds: ["leaf", "stalled-parent"],
	}]);
});
