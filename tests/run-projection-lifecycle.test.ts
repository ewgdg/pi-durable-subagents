import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { HostedAgentProjection } from "../src/runtime/hosted-agent-projection.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

for (const prepared of [false, true]) test(`shutdown during ${prepared ? "prepared" : "fresh"} relationship catch-up keeps exact startup cleanup`, async () => {
	const resource = createRunResource();
	const host = AgentRuntimeSupervisor.createChild({ agentId: "projection-test-agent", startSession: async () => resource.startedRun });
	if (prepared) await host.lane.run(() => host.prepareInLane());
	const entered = deferredVoid();
	const resume = deferredVoid();
	host.setRunStartInitializer(async () => {
		entered.resolve();
		await resume.promise;
		return { awaitingAnswerRequestIds: ["unpublished-request"], answerOwedRequestIds: [] };
	});
	let started = false;
	const ended: string[] = [];
	host.setRunStartedHandler(() => { started = true; });
	host.addEndedHandler((_handle, cause) => ended.push(cause));
	const starting = host.lane.run(() => host.startInLane());
	await entered.promise;
	assert.equal(host.hasRetentionReason("awaiting_answer", "unpublished-request"), false);
	assert.equal(started, false);
	const shuttingDown = host.beginShutdown();
	resume.resolve();
	await assert.rejects(starting, /shutdown|host_shutting_down/);
	await shuttingDown;
	assert.equal(started, false);
	assert.deepEqual(ended, ["termination"]);
	assert.equal(host.hasRetentionReason("awaiting_answer", "unpublished-request"), false);
});


test("Run input ownership survives settlement and resets only for a successor", { timeout: 5_000 }, async () => {
	const resources = [createRunResource(), createRunResource()];
	let next = 0;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "input-ownership-agent", startSession: async () => resources[next++]!.startedRun,
	});
	const first = resources[0]!;
	first.startedRun.runtime.deliver = () => ({ completion: Promise.resolve() });
	await host.lane.run(() => host.startInLane(["pending_delivery"]));
	assert.equal(host.currentRunHasInput(), false);
	host.deliverInLane({ kind: "user", content: "Continue the foreground" });
	assert.equal(host.currentWorkState(), "settled");
	assert.equal(host.currentRunHasInput(), true, "dispatch owns continuation even before runtime activity publishes");
	await host.lane.run(() => host.discardAndEndInLane("termination"));
	await host.lane.run(() => host.startInLane(["pending_delivery"]));
	assert.equal(host.currentRunHasInput(), false);
	await host.lane.run(() => host.discardAndEndInLane("termination"));
});

test("native Runtime activity owns continuation after it settles", { timeout: 5_000 }, async () => {
	const resource = createRunResource();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "native-input-ownership-agent", startSession: async () => resource.startedRun,
	});
	await host.lane.run(() => host.startInLane(["pending_delivery"]));
	let work: "active" | "settled" = "active";
	resource.startedRun.runtime.workState = () => work;
	resource.emitStateChanged();
	assert.equal(host.currentRunHasInput(), true);
	work = "settled";
	resource.emitStateChanged();
	assert.equal(host.currentRunHasInput(), true);
	await host.lane.run(() => host.discardAndEndInLane("termination"));
});

test("clean release disposes the exact projection and session once", async () => {
	const resource = createRunResource();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => resource.startedRun,
	});
	const handle = await host.lane.run(() => host.startInLane());
	assert.equal(host.currentHandle(), handle);

	assert.equal(
		await host.lane.run(() => host.releaseIfEligibleInLane(handle)),
		"released",
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("public Runtime activity settlement receives a grace period before disposal", async () => {
	const resource = createRunResource();
	resource.setPendingActivity(true);
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "activity-grace-period-agent",
		startSession: async () => resource.startedRun,
	});
	const handle = await host.lane.run(() => host.startInLane());
	let releaseRechecks = 0;
	let settleRelease!: () => void;
	const released = new Promise<void>((resolve) => {
		settleRelease = resolve;
	});
	host.setProjectionInputSettledHandler(() => {
		releaseRechecks += 1;
		void host.lane.run(async () => {
			await host.releaseIfEligibleInLane(handle);
			settleRelease();
		});
	});

	assert.equal(
		await host.lane.run(() => host.releaseIfEligibleInLane(handle)),
		"retained",
	);
	resource.setPendingActivity(false);
	resource.emitStateChanged();

	assert.equal(releaseRechecks, 0);
	assert.equal(resource.counts().sessionDisposals, 0);
	assert.equal(
		await host.lane.run(() => host.releaseIfEligibleInLane(handle)),
		"retained",
	);
	let releaseTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			released,
			new Promise<never>((_resolve, reject) => {
				releaseTimeout = setTimeout(
					() => reject(new Error("release grace period did not settle")),
					1_000,
				);
			}),
		]);
	} finally {
		if (releaseTimeout) clearTimeout(releaseTimeout);
	}
	assert.equal(releaseRechecks, 1);
	assert.equal(resource.counts().sessionDisposals, 1);
});

test("selected clean Runs release inside one retained Runtime", async () => {
	const resource = createRunResource();
	let runtimePreparations = 0;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => {
			runtimePreparations += 1;
			return resource.startedRun;
		},
	});
	const ended: Array<{ sequence: number; cause: string }> = [];
	host.addEndedHandler((handle, cause) => {
		ended.push({ sequence: handle.sequence, cause });
	});

	await host.lane.run(() => host.prepareInLane(["interactive_selection"]));
	const preparedProjection = host.currentProjection();
	await host.lane.run(() => host.startInLane());
	const firstHandle = host.currentHandle();
	assert.ok(firstHandle);
	assert.equal(
		await host.lane.run(() => host.releaseIfEligibleInLane(firstHandle)),
		"released",
	);
	assert.equal(host.observe().phase, "dormant");
	assert.equal(host.currentProjection(), preparedProjection);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 0,
		sessionDisposals: 0,
		unsubscriptions: 0,
	});

	const secondHandle = await host.lane.run(() => host.startInLane());
	assert.equal(host.currentHandle(), secondHandle);
	assert.notEqual(secondHandle, firstHandle);
	assert.equal(secondHandle.sequence, firstHandle.sequence + 1);
	assert.equal(host.currentProjection(), preparedProjection);
	assert.equal(runtimePreparations, 1);

	host.removeRetentionReason("interactive_selection");
	assert.equal(
		await host.lane.run(() => host.releaseIfEligibleInLane(secondHandle)),
		"released",
	);
	assert.deepEqual(ended, [
		{ sequence: firstHandle.sequence, cause: "clean" },
		{ sequence: secondHandle.sequence, cause: "clean" },
	]);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
});

test("failure, termination, and Workflow shutdown each dispose their exact projection and session once", async () => {
	for (const cause of ["failure", "termination", "shutdown"] as const) {
		const resource = createRunResource();
		const host = AgentRuntimeSupervisor.createChild({
			agentId: "projection-test-agent",
			startSession: async () => resource.startedRun,
		});
		await host.lane.run(() => host.startInLane(["pending_delivery"]));

		await host.lane.run(() => host.discardAndEndInLane(cause));
		assert.deepEqual(
			resource.counts(),
			{
				projectionDisposals: 1,
				sessionDisposals: 1,
				unsubscriptions: 1,
			},
			cause,
		);
		assert.equal(host.observe().phase, "dormant", cause);
	}
});

test("native-host clean release retains the borrowed Runtime and Owner binding", async (t) => {
	const owner = await createTestOwnerHost(t, () => undefined);
	const host = AgentRuntimeSupervisor.bindOwner(owner.runtime);
	const firstHandle = host.currentHandle();
	assert.ok(firstHandle);

	assert.equal(
		await host.lane.run(() => host.releaseIfEligibleInLane(firstHandle)),
		"retained",
	);
	assert.equal(host.currentHandle(), firstHandle);
	assert.equal(host.hasRetentionReason("owner_host_binding"), true);
	await owner.runtime.dispose();
});

test("native-host Run Failure retains the borrowed Runtime for a successor Run", async (t) => {
	const owner = await createTestOwnerHost(t, () => undefined);
	const host = AgentRuntimeSupervisor.bindOwner(owner.runtime);
	const firstHandle = host.currentHandle();
	assert.ok(firstHandle);
	const originalDispose = owner.session.dispose.bind(owner.session);
	let sessionDisposals = 0;
	owner.session.dispose = () => {
		sessionDisposals += 1;
		originalDispose();
	};

	await host.lane.run(() => host.discardAndEndInLane("failure"));

	assert.equal(sessionDisposals, 0);
	assert.deepEqual(host.observe(), { phase: "dormant", retentionReasons: [] });
	assert.equal(host.hasRetentionReason("owner_host_binding"), true);
	assert.doesNotThrow(() => owner.session.extensionRunner.createContext());

	const successorHandle = await host.lane.run(() => host.startInLane());
	assert.equal(successorHandle.sequence, firstHandle.sequence + 1);
	assert.equal(host.hasRetentionReason("owner_host_binding"), true);
	assert.deepEqual(host.observe().retentionReasons, [
		{ reason: "owner_host_binding", count: 1 },
	]);

	await owner.runtime.dispose();
	assert.equal(sessionDisposals, 1);
});

test("failed successor admission also preserves the native-host Runtime", async (t) => {
	const owner = await createTestOwnerHost(t, () => undefined);
	const host = AgentRuntimeSupervisor.bindOwner(owner.runtime);
	await host.lane.run(() => host.discardAndEndInLane("failure"));
	const originalDispose = owner.session.dispose.bind(owner.session);
	let sessionDisposals = 0;
	owner.session.dispose = () => {
		sessionDisposals += 1;
		originalDispose();
	};
	host.setRunStartedHandler(() => {
		throw new Error("successor admission rejected");
	});

	await assert.rejects(
		() => host.lane.run(() => host.startInLane()),
		/successor admission rejected/,
	);

	assert.equal(sessionDisposals, 0);
	assert.equal(host.hasRetentionReason("owner_host_binding"), true);
	assert.doesNotThrow(() => owner.session.extensionRunner.createContext());
	host.setRunStartedHandler(() => undefined);
	const recoveredHandle = await host.lane.run(() => host.startInLane());
	assert.equal(recoveredHandle.sequence, 3);
	await owner.runtime.dispose();
});

test("Workflow shutdown leaves native Owner disposal to its host after its Run already ended", async (t) => {
	const owner = await createTestOwnerHost(t, () => undefined);
	const host = AgentRuntimeSupervisor.bindOwner(owner.runtime);
	await host.lane.run(() => host.discardAndEndInLane("failure"));

	let nativeDisposals = 0;
	await host.lane.run(() => host.discardAndEndInLane("shutdown", async () => {
		nativeDisposals += 1;
	}));

	assert.equal(nativeDisposals, 1);
	assert.doesNotThrow(() => owner.session.extensionRunner.createContext());
	await owner.runtime.dispose();
});

test("failed startup after Run binding rolls back the projection and session once", async () => {
	const resource = createRunResource();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => resource.startedRun,
	});
	host.setRunStartedHandler(() => {
		throw new Error("confirmed post-projection startup failure");
	});

	await assert.rejects(
		() => host.lane.run(() => host.startInLane()),
		/confirmed post-projection startup failure/,
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("failed startup emits the exact Run terminal lifecycle before disposal", async () => {
	const resource = createRunResource();
	const events: string[] = [];
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => ({
			...resource.startedRun,
			ready: Promise.reject(new Error("session_start rejected")),
		}),
	});
	host.setRunEndingHandler((_handle, cause) => {
		events.push(`ending:${cause}`);
		assert.equal(resource.counts().projectionDisposals, 0);
	});
	host.addEndedHandler((_handle, cause) => {
		events.push(`ended:${cause}`);
		assert.equal(host.observe().phase, "dormant");
	});

	await assert.rejects(
		() => host.lane.run(() => host.startInLane()),
		/session_start rejected/,
	);
	assert.deepEqual(events, ["ending:failure", "ended:failure"]);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
});

test("post-binding startup failure cancels and observes pending exact readiness", async () => {
	const resource = createRunResource();
	const handlerFailure = new Error("post-binding handler failed before readiness");
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((_resolve, reject) => {
		rejectReady = reject;
	});
	const nativeProjection = resource.projection;
	const projection: HostedAgentProjection = {
		...nativeProjection,
		ready: () => ready,
		cancelInitialization(error) {
			rejectReady(error);
			return Promise.resolve();
		},
	};
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => ({
			...resource.startedRunWithProjection(projection),
			ready,
		}),
	});
	const lifecycle: string[] = [];
	host.setRunStartedHandler(() => {
		throw handlerFailure;
	});
	host.setRunEndingHandler((_handle, cause) => {
		lifecycle.push(`ending:${cause}`);
	});
	host.addEndedHandler((_handle, cause) => lifecycle.push(`ended:${cause}`));

	await assert.rejects(
		() => host.lane.run(() => host.startInLane()),
		handlerFailure,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(lifecycle, ["ending:failure", "ended:failure"]);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("shutdown fencing prevents a prepared Runtime from admitting a Run", async () => {
	const resource = createRunResource();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => resource.startedRun,
	});
	let relationshipInitializations = 0;
	host.setRunStartInitializer(() => {
		relationshipInitializations += 1;
		return {
			awaitingAnswerRequestIds: [],
			answerOwedRequestIds: [],
		};
	});

	await host.lane.run(() => host.prepareInLane(["interactive_selection"]));
	assert.equal(host.observe().phase, "dormant");
	assert.equal(host.latestStartedRunSequence(), 0);
	assert.equal(await host.beginShutdown(), false);

	await assert.rejects(
		() => host.lane.run(() => host.startInLane(["pending_delivery"])),
		/host_shutting_down: Agent Run startup is closed/,
	);
	assert.equal(host.observe().phase, "dormant");
	assert.equal(host.hasRetentionReason("pending_delivery"), false);
	assert.equal(host.latestStartedRunSequence(), 0);
	assert.equal(relationshipInitializations, 0);

	host.removeRetentionReason("interactive_selection");
	assert.equal(
		await host.lane.run(() => host.releasePreparedRuntimeInLane()),
		"released",
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
});

test("shutdown fenced before projection binding observes accepted startup cancellation", async () => {
	const resource = createRunResource();
	let markPreparationStarted!: () => void;
	const preparationStarted = new Promise<void>((resolve) => {
		markPreparationStarted = resolve;
	});
	let releasePreparation!: () => void;
	const preparationGate = new Promise<void>((resolve) => {
		releasePreparation = resolve;
	});
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((_resolve, reject) => {
		rejectReady = reject;
	});
	let disposal: Promise<void> | undefined;
	const nativeProjection = resource.projection;
	const projection: HostedAgentProjection = {
		...nativeProjection,
		ready: () => ready,
		cancelInitialization(error) {
			rejectReady(error);
			disposal ??= nativeProjection.dispose();
			return disposal;
		},
		dispose() {
			disposal ??= nativeProjection.dispose();
			return disposal;
		},
	};
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => {
			markPreparationStarted();
			await preparationGate;
			return { ...resource.startedRunWithProjection(projection), ready };
		},
	});
	const endedCauses: string[] = [];
	host.addEndedHandler((_handle, cause) => endedCauses.push(cause));
	const startup = host.lane.run(() => host.startInLane());
	await preparationStarted;
	assert.equal(await host.beginShutdown(), false);
	releasePreparation();

	await assert.rejects(startup, /Workflow shutdown during Agent Run initialization/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(endedCauses, ["termination"]);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("starting-Run termination fences its projection and queued successor admission", async () => {
	const resource = createRunResource();
	const successorResource = createRunResource();
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((_resolve, reject) => {
		rejectReady = reject;
	});
	let inputFenced = false;
	let disposal: Promise<void> | undefined;
	const nativeProjection = resource.projection;
	const projection: HostedAgentProjection = {
		...nativeProjection,
		ready: () => ready,
		fenceInputSubmissions() {
			inputFenced = true;
		},
		inputSubmissionIsFenced: () => inputFenced,
		cancelInitialization(error) {
			rejectReady(error);
			disposal ??= nativeProjection.dispose();
			return disposal;
		},
		dispose() {
			disposal ??= nativeProjection.dispose();
			return disposal;
		},
	};
	let runtimeStarts = 0;
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "starting-termination-fence-agent",
		startSession: async () => {
			runtimeStarts += 1;
			return runtimeStarts === 1
				? { ...resource.startedRunWithProjection(projection), ready }
				: successorResource.startedRun;
		},
	});
	const startup = host.lane.run(() => host.startInLane());
	void startup.catch(() => undefined);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(host.currentProjection(), projection);
	const inputSubmission = host.captureProjectionInputSubmission(1);
	assert.ok(inputSubmission);
	const terminationError = new Error("terminate exact starting Run");
	const termination = host.requestRuntimeInitializationTermination(
		projection,
		terminationError,
	);
	assert.ok(termination);
	const queuedSuccessor = host.lane.run(() => host.startInLane());

	assert.equal(await termination.cancellation, true);
	await assert.rejects(startup, terminationError);
	await assert.rejects(queuedSuccessor, /run_termination_pending/);
	assert.equal(host.projectionInputSubmissionIsFenced(inputSubmission), true);
	assert.equal(
		host.completeRuntimeInitializationTerminationInLane(termination),
		true,
	);
	assert.equal(host.observe().phase, "dormant");

	const successor = await host.lane.run(() => host.startInLane());
	assert.equal(successor.sequence, 2);
	assert.equal(runtimeStarts, 2);
});

test("a naturally rejected startup remains Run Failure after a pre-binding shutdown fence", async () => {
	const resource = createRunResource();
	let markPreparationStarted!: () => void;
	const preparationStarted = new Promise<void>((resolve) => {
		markPreparationStarted = resolve;
	});
	let releasePreparation!: () => void;
	const preparationGate = new Promise<void>((resolve) => {
		releasePreparation = resolve;
	});
	const naturalFailure = new Error("natural startup failure won before shutdown cancellation");
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((_resolve, reject) => {
		rejectReady = reject;
	});
	const nativeProjection = resource.projection;
	const projection: HostedAgentProjection = {
		...nativeProjection,
		ready: () => ready,
		cancelInitialization() {
			rejectReady(naturalFailure);
			return undefined;
		},
	};
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => {
			markPreparationStarted();
			await preparationGate;
			return { ...resource.startedRunWithProjection(projection), ready };
		},
	});
	const endedCauses: string[] = [];
	host.addEndedHandler((_handle, cause) => endedCauses.push(cause));
	const startup = host.lane.run(() => host.startInLane());
	await preparationStarted;
	assert.equal(await host.beginShutdown(), false);
	releasePreparation();

	await assert.rejects(startup, naturalFailure);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(endedCauses, ["failure"]);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("native subscription failure rolls back the already-created projection and session", async () => {
	const resource = createRunResource({
		subscribeError: new Error("native subscription unavailable"),
	});
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => resource.startedRun,
	});

	await assert.rejects(
		() => host.lane.run(() => host.startInLane()),
		/native subscription unavailable/,
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 0,
	});
	assert.equal(host.observe().phase, "dormant");
});

test("Runtime Host confirms user and custom Delivery transcript commits", async (t) => {
	const ownerHost = await createTestOwnerHost(t, () => undefined, { persistent: true });
	ownerHost.model.setResponses([
		fauxAssistantMessage("User Delivery completed."),
		fauxAssistantMessage("Custom Delivery completed."),
	]);
	const runtimeHost = AgentRuntimeSupervisor.bindOwner(ownerHost.runtime);
	const userContent = [{ type: "text" as const, text: "Commit this user Delivery." }];
	const userDelivery = runtimeHost.deliverInLane(
		{ kind: "user", content: userContent },
		{
			inspectCommit: () => {
				const tail = ownerHost.session.sessionManager.getEntries().at(-1);
				return tail?.type === "message" &&
					tail.message.role === "user" &&
					JSON.stringify(tail.message.content) === JSON.stringify(userContent);
			},
		},
	);
	assert.equal(await userDelivery.transcriptCommit, true);
	await userDelivery.completion;

	const customMessage = createMessageDelivery([{
		source: {
			agentId: ownerHost.session.sessionId,
			entryId: "host-delivery-source",
			toolCallId: "host-delivery-tool-call",
		},
		projection: {
			kind: "message",
			messageId: "host-delivery-message",
			fromAgentId: ownerHost.session.sessionId,
			content: "Commit this custom Delivery.",
		},
	}]);
	const customDelivery = runtimeHost.deliverInLane(
		{ kind: "custom", message: customMessage, triggerTurn: true },
		{
			inspectCommit: () => {
				const tail = ownerHost.session.sessionManager.getEntries().at(-1);
				return tail?.type === "custom_message" &&
					tail.customType === customMessage.customType;
			},
		},
	);
	assert.equal(await customDelivery.transcriptCommit, true);
	await customDelivery.completion;
	await ownerHost.runtime.dispose();
});

test("Runtime Host exposes process-neutral effective state and exact Run intentions", async () => {
	const resource = createRunResource();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => resource.startedRun,
	});

	await host.lane.run(() => host.startInLane());
	const handle = host.currentHandle();
	assert.ok(handle);
	assert.deepEqual(host.effectiveRuntimeSnapshot(), {
		cwd: "/runtime/project",
		model: { provider: "test", modelId: "runtime-model" },
		thinking: "high",
		tools: ["read", "sequential_tool"],
		skills: ["runtime-skill"],
		skillSources: [{ name: "runtime-skill", filePath: "/runtime/skill/SKILL.md" }],
		fileExtensionPaths: ["/runtime/extension.ts"],
		projectTrusted: true,
		sessionId: "projected-run",
	});
	assert.equal(host.currentWorkState(), "settled");
	assert.equal(host.classifyToolBatch(["read"]), "asynchronous");
	assert.equal(host.classifyToolBatch(["read", "sequential_tool"]), "blocking");
	assert.equal(host.exactRunCancellationSignal(handle), resource.signal);
	assert.throws(
		() => host.exactRunCancellationSignal({ sequence: handle.sequence + 1 }),
		/stale_run/,
	);
});

test("a prepared Runtime does not expose an effective Run snapshot before admission", async () => {
	const resource = createRunResource();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "prepared-runtime-agent",
		startSession: async () => resource.startedRun,
	});

	await host.lane.run(() => host.prepareInLane(["interactive_selection"]));
	assert.ok(host.currentProjection());
	assert.equal(host.currentHandle(), undefined);
	assert.equal(host.effectiveRuntimeSnapshot(), undefined);
	assert.deepEqual(host.observe(), { phase: "dormant", retentionReasons: [] });
	await host.lane.run(() => host.discardAndEndInLane("termination"));
});

test("cleanup continues through projection failure and still disposes the exact session", async () => {
	const resource = createRunResource({
		projectionDisposeError: new Error("projection cleanup failed"),
	});
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "projection-test-agent",
		startSession: async () => resource.startedRun,
	});
	await host.lane.run(() => host.startInLane());

	await assert.rejects(
		() => host.lane.run(() => host.discardAndEndInLane("shutdown")),
		(error: unknown) =>
			error instanceof AggregateError &&
			error.errors.some((nested) =>
				nested instanceof Error && nested.message === "projection cleanup failed"
			),
	);
	assert.deepEqual(resource.counts(), {
		projectionDisposals: 1,
		sessionDisposals: 1,
		unsubscriptions: 1,
	});
	assert.equal(host.observe().phase, "dormant");
});

function createRunResource(options?: {
	projectionDisposeError?: Error;
	subscribeError?: Error;
}): {
	startedRun: Readonly<{ runtime: InProcessHostedRuntime }>;
	startedRunWithProjection(
		projection: HostedAgentProjection,
	): Readonly<{ runtime: InProcessHostedRuntime }>;
	projection: HostedAgentProjection;
	session: AgentSession;
	signal: AbortSignal;
	counts(): Readonly<{
		projectionDisposals: number;
		sessionDisposals: number;
		unsubscriptions: number;
	}>;
	setPendingActivity(pending: boolean): void;
	emitStateChanged(): void;
} {
	let projectionDisposals = 0;
	let sessionDisposals = 0;
	let unsubscriptions = 0;
	let pendingActivity = false;
	const sessionListeners = new Set<(event: unknown) => void>();
	const component: Component = {
		render: () => [],
		invalidate() {},
	};
	const projection: HostedAgentProjection = {
		presentation: component,
		physicalTerminal: {
			async beginAttachment() { return () => undefined; },
			async endAttachment() {},
			pauseOutput() {},
			resumeOutput() {},
		},
		resize() {},
		dispatchInput() {},
		focusEditor() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler: () => () => undefined,
		addExitRequestHandler: () => () => undefined,
		isProcessingInput: () => false,
		fenceInputSubmissions() {},
		inputSubmissionIsFenced: () => false,
		whenInputIdle: async () => undefined,
		async ready() {},
		cancelInitialization() {
			return undefined;
		},
		async dispose() {
			projectionDisposals += 1;
			if (options?.projectionDisposeError) throw options.projectionDisposeError;
		},
	};
	const cancellation = new AbortController();
	const session = {
		isIdle: true,
		isStreaming: false,
		pendingMessageCount: 0,
		agent: { signal: cancellation.signal },
		getToolDefinition(name: string) {
			if (name === "read") return { executionMode: "parallel" };
			if (name === "sequential_tool") return { executionMode: "sequential" };
			return undefined;
		},
		subscribe(listener: (event: unknown) => void) {
			if (options?.subscribeError) throw options.subscribeError;
			sessionListeners.add(listener);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				sessionListeners.delete(listener);
				unsubscriptions += 1;
			};
		},
		clearQueue: () => ({ steering: [], followUp: [] }),
		abort: async () => undefined,
		waitForIdle: async () => undefined,
		dispose() {
			sessionDisposals += 1;
		},
	} as unknown as AgentSession;
	const inspectSnapshot = () => ({
		cwd: "/runtime/project",
		model: { provider: "test", modelId: "runtime-model" },
		thinking: "high" as const,
		tools: ["read", "sequential_tool"],
		skills: ["runtime-skill"],
		skillSources: [{ name: "runtime-skill", filePath: "/runtime/skill/SKILL.md" }],
		fileExtensionPaths: ["/runtime/extension.ts"],
		projectTrusted: true,
		sessionId: "projected-run",
	});
	const startedRunWithProjection = (hostedProjection: HostedAgentProjection) => {
		const runtime = new InProcessHostedRuntime({
			session,
			projection: hostedProjection,
			inspectSnapshot,
		});
		runtime.hasPendingActivity = () => pendingActivity;
		return { runtime };
	};
	return {
		startedRun: startedRunWithProjection(projection),
		startedRunWithProjection,
		projection,
		session,
		signal: cancellation.signal,
		counts: () => ({
			projectionDisposals,
			sessionDisposals,
			unsubscriptions,
		}),
		setPendingActivity: (pending) => {
			pendingActivity = pending;
		},
		emitStateChanged: () => {
			for (const listener of sessionListeners) {
				listener({ type: "queue_update", steering: [], followUp: [] });
			}
		},
	};
}

function deferredVoid() {
 let resolve!: () => void;
 const promise = new Promise<void>(done => { resolve = done; });
 return { promise, resolve };
}
