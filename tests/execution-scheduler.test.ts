import { latestRequestFromContext } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";
import { WorkflowExecutionScheduler } from "../src/coordination/workflow-execution-scheduler.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import {
	WorkflowPolicyStore,
	parseWorkflowPolicy,
} from "../src/policy/workflow-policy.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

test("maxConcurrentAgentRuns counts child executions only in FIFO order", async () => {
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 2}'),
	);
	const scheduler = new WorkflowExecutionScheduler(policy);
	const admitted: string[] = [];
	const first = scheduler.admit("child").then((permit) => {
		admitted.push("first");
		return permit;
	});
	const second = scheduler.admit("child").then((permit) => {
		admitted.push("second");
		return permit;
	});
	const third = scheduler.admit("child").then((permit) => {
		admitted.push("third");
		return permit;
	});
	const fourth = scheduler.admit("child").then((permit) => {
		admitted.push("fourth");
		return permit;
	});
	const [firstPermit, secondPermit] = await Promise.all([first, second]);
	await Promise.resolve();
	assert.deepEqual(admitted, ["first", "second"]);

	secondPermit?.release();
	const thirdPermit = await third;
	assert.deepEqual(admitted, ["first", "second", "third"]);
	firstPermit?.release();
	const fourthPermit = await fourth;
	assert.deepEqual(admitted, ["first", "second", "third", "fourth"]);

	thirdPermit?.release();
	fourthPermit?.release();
});

test("queued executions keep captured limits across prospective policy reload", async () => {
	const initial = parseWorkflowPolicy('{"maxConcurrentAgentRuns": 2}');
	const policy = new WorkflowPolicyStore(initial);
	const scheduler = new WorkflowExecutionScheduler(policy);
	const first = await scheduler.admit("child");
	const second = await scheduler.admit("child");

	const reduced = parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}');
	policy.publish(reduced);
	let reducedAdmitted = false;
	const underReducedLimit = scheduler.admit("child").then((permit) => {
		reducedAdmitted = true;
		return permit;
	});
	const raised = parseWorkflowPolicy('{"maxConcurrentAgentRuns": 3}');
	policy.publish(raised);
	let raisedAdmitted = false;
	const afterRaise = scheduler.admit("child").then((permit) => {
		raisedAdmitted = true;
		return permit;
	});

	first?.release();
	await Promise.resolve();
	assert.equal(reducedAdmitted, false);
	assert.equal(raisedAdmitted, false);
	second?.release();
	const reducedPermit = await underReducedLimit;
	const raisedPermit = await afterRaise;
	assert.equal(reducedAdmitted, true);
	assert.equal(raisedAdmitted, true);

	reducedPermit?.release();
	raisedPermit?.release();
});

test("an aborted queued execution leaves FIFO without consuming capacity", async () => {
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	const scheduler = new WorkflowExecutionScheduler(policy);
	const active = await scheduler.admit("child");
	const aborted = new AbortController();
	const removed = scheduler.admit("child", aborted.signal);
	let followingAdmitted = false;
	const following = scheduler.admit("child").then((permit) => {
		followingAdmitted = true;
		return permit;
	});

	aborted.abort();
	assert.equal(await removed, undefined);
	assert.equal(followingAdmitted, false);
	active?.release();
	const followingPermit = await following;
	assert.equal(followingAdmitted, true);
	followingPermit?.release();
});

test("Owner execution bypasses full child capacity and the FIFO child backlog", async () => {
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	const scheduler = new WorkflowExecutionScheduler(policy);
	const activeChild = await scheduler.admit("child");
	let waitingChildAdmitted = false;
	const waitingChild = scheduler.admit("child").then((permit) => {
		waitingChildAdmitted = true;
		return permit;
	});

	let ownerPermit: Awaited<ReturnType<typeof scheduler.admit>>;
	void scheduler.admit("owner").then((permit) => {
		ownerPermit = permit;
	});
	await Promise.resolve();
	assert.ok(ownerPermit);
	ownerPermit.release();
	ownerPermit.release();
	await Promise.resolve();
	assert.equal(waitingChildAdmitted, false);

	activeChild?.release();
	const waitingChildPermit = await waitingChild;
	assert.equal(waitingChildAdmitted, true);
	waitingChildPermit?.release();
});

test("Moderator execution is exempt and does not release a child waiter", async () => {
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	const scheduler = new WorkflowExecutionScheduler(policy);
	const active = await scheduler.admit("child");
	let waitingAdmitted = false;
	const waiting = scheduler.admit("child").then((permit) => {
		waitingAdmitted = true;
		return permit;
	});

	const moderator = await scheduler.admit("moderator");
	assert.ok(moderator);
	moderator.release();
	moderator.release();
	await Promise.resolve();
	assert.equal(waitingAdmitted, false);

	active?.release();
	const waitingPermit = await waiting;
	assert.equal(waitingAdmitted, true);
	waitingPermit?.release();
});

test("the coordinator derives Owner and child roles from canonical Workflow identity", { timeout: 5_000 }, async (t) => {
	let firstGenerationStarted!: () => void;
	const firstGenerationStart = new Promise<void>((resolve) => {
		firstGenerationStarted = resolve;
	});
	let releaseFirstGeneration!: () => void;
	const firstGenerationRelease = new Promise<void>((resolve) => {
		releaseFirstGeneration = resolve;
	});
	let secondGenerationStarted!: () => void;
	const secondGenerationStart = new Promise<void>((resolve) => {
		secondGenerationStarted = resolve;
	});
	let generations = 0;

	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	let coordinator: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		workflowPolicy: policy,
	});
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		async () => {
			generations += 1;
			firstGenerationStarted();
			await firstGenerationRelease;
			return fauxAssistantMessage("First execution completed.");
		},
		() => {
			generations += 1;
			secondGenerationStarted();
			return fauxAssistantMessage("Second execution completed.");
		},
	]);

	await spawnChild(owner, host, "first-capacity-child");
	await firstGenerationStart;
	await spawnChild(owner, host, "second-capacity-child");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(generations, 1);

	await owner.beginExecution();
	assert.equal(generations, 1);
	releaseFirstGeneration();
	await secondGenerationStart;
	assert.equal(generations, 2);
	owner.endExecution();
	await waitForCondition(() => owner.children().every(
		({ run }) => "work" in run && run.work === "settled",
	));
	const policyDirectory = join(host.services.agentDir, "config");
	await mkdir(policyDirectory, { recursive: true });
	await writeFile(
		join(policyDirectory, "pi-durable-subagents.json"),
		'{"maxConcurrentAgentRuns": 7}',
		"utf8",
	);
	const [firstChild] = owner.children();
	assert.ok(firstChild);
	const childSessionFile = await waitForChildSessionFile(host, firstChild.agentId);
	const childTranscript = structuredClone(SessionManager.open(childSessionFile).getEntries());
	assert.equal(policy.current().maxConcurrentAgentRuns, 1);
	assert.deepEqual(SessionManager.open(childSessionFile).getEntries(), childTranscript);

});

test("a child Agent Wait releases and reacquires child execution capacity", { timeout: 5_000 }, async (t) => {
	let secondChildHoldingCapacity!: () => void;
	const secondChildCapacityHeld = new Promise<void>((resolve) => {
		secondChildHoldingCapacity = resolve;
	});
	let releaseSecondChild!: () => void;
	const secondChildRelease = new Promise<void>((resolve) => {
		releaseSecondChild = resolve;
	});
	let firstChildResumed = false;
	let firstChildDidResume!: () => void;
	const firstChildResume = new Promise<void>((resolve) => {
		firstChildDidResume = resolve;
	});
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		workflowPolicy: new WorkflowPolicyStore(
			parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
		),
	});
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ title: "Fixture request", request: "Answer after starting your Run." },
				{ id: "spawn-wait-responder" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("agent_wait", {}, { id: "wait-for-responder" }),
			{ stopReason: "toolUse" },
		),
		// A committed Answer ends the responder's model loop, so it holds the only
		// execution slot before answering.
		async (context) => {
			secondChildHoldingCapacity();
			await secondChildRelease;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "The responder committed its Answer." },
					{ id: "answer-waiting-child" },
				),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			firstChildResumed = true;
			firstChildDidResume();
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "The delegated work completed." },
					{ id: "answer-parent-after-wait" },
				),
				{ stopReason: "toolUse" },
			);
		},
	]);

	await spawnChild(owner, host, "spawn-capacity-waiter");
	await secondChildCapacityHeld;
	const [firstChild] = owner.children();
	assert.ok(firstChild);
	assert.equal(firstChildResumed, false);

	releaseSecondChild();
	await firstChildResume;
	await waitForCondition(() => {
		const descendants = [firstChild, ...owner.children(firstChild.agentId)];
		return descendants.every(({ agentId }) => {
			const run = owner.status(agentId).run;
			return run.phase === "dormant" || ("work" in run && run.work === "settled");
		});
	});
});

test("an exact Run ending releases capacity without a participant execution-end boundary", async (t) => {
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		(context) => fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId: latestRequestFromContext(context).requestMessageId, answer: "Creation work is complete." },
				{ id: "answer-before-capacity-termination" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The initial child Run completed normally."),
	]);

	await spawnChild(owner, host, "spawn-capacity-termination-child");
	const [child] = owner.children();
	assert.ok(child);
	await waitForCondition(() => owner.status(child.agentId).run.phase === "dormant");
	const childView = coordinator.forAgent(child.agentId);
	await childView.beginExecution();

	const terminationInput = { operation: "terminate" as const, agentId: child.agentId };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", terminationInput, { id: "terminate-capacity-holder" }),
			{ stopReason: "toolUse" },
		),
	);
	const termination = await owner.control("terminate-capacity-holder", terminationInput);
	assert.equal("disposition" in termination && termination.disposition, "terminated");
	assert.equal(owner.status(child.agentId).run.phase, "dormant");

	await assert.doesNotReject(() => childView.beginExecution());
	childView.endExecution();
});

test("an input-required child Run releases capacity until work can resume", async (t) => {
	let secondGenerationStarted!: () => void;
	const secondGenerationStart = new Promise<void>((resolve) => {
		secondGenerationStarted = resolve;
	});
	let releaseSecondGeneration!: () => void;
	const secondGenerationRelease = new Promise<void>((resolve) => {
		releaseSecondGeneration = resolve;
	});
	const host = await createUnboundTestOwnerHost(t, () => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	let coordinator: WorkflowCoordinator;
	coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
		workflowPolicy: policy,
	});
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user",
				{ question: "May this Run resume after the other child finishes?" },
				{ id: "input-required-capacity" },
			),
			{ stopReason: "toolUse" },
		),
		async () => {
			secondGenerationStarted();
			await secondGenerationRelease;
			return fauxAssistantMessage("The second child completed first.");
		},
		fauxAssistantMessage("The Human Answer resumed the first child."),
	]);

	await spawnChild(owner, host, "input-required-child");
	await waitForCondition(() => owner.humanAttention().length === 1);
	const [waitingChild] = owner.children();
	assert.ok(waitingChild);
	await spawnChild(owner, host, "execution-while-input-required");
	await secondGenerationStart;
	const selected = await owner.openAgentView(waitingChild.agentId);
	assert.ok(selected);
	selected.projection().dispatchInput("Yes\r");
	releaseSecondGeneration();
	await waitForCondition(() => owner.children().every(
		({ run }) => "work" in run && run.work === "settled",
	));
	await selected.close();

});

async function spawnChild(
	owner: ReturnType<WorkflowCoordinator["forAgent"]>,
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	toolCallId: string,
): Promise<void> {
	const input = { title: "Fixture request", request: `Creation Request for ${toolCallId}` } as const;
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await owner.spawn(toolCallId, input);
	assert.equal(receipt.spawnStatus, "created");
	assert.equal("messageStatus" in receipt && receipt.messageStatus, "sent");
}

async function waitForChildSessionFile(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	childId: string,
): Promise<string> {
	const sessionDirectory = host.session.sessionManager.getSessionDir();
	if (!sessionDirectory) throw new Error("Persistent Owner session directory unavailable");
	const workflowDirectory = join(
		sessionDirectory,
		"pi-durable-subagents",
		host.session.sessionId,
	);
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const sessions = await SessionManager.list(host.cwd, workflowDirectory);
		const child = sessions.find(({ id }) => id === childId);
		if (child) return child.path;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Child Pi session file was not created");
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected execution scheduler condition was not reached");
}
