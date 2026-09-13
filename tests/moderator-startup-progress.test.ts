import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import piAgentCoordination from "../src/index.ts";
import { OperationalIncidentCoordinator } from "../src/coordination/operational-incidents.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { MODERATOR_STARTUP_GATE_DIRECTORY, STARTED_FILE, RELEASE_FILE } from "./fixtures/moderator-startup-gate.ts";

// Real child bootstrap loads extensions and a model broker; individual waits are bounded.
test("initial Moderator startup counts as progress before native agent.start and until first settlement", { timeout: 15000 }, async t => {
	const gateDirectory = await mkdtemp(join(tmpdir(), "moderator-startup-progress-"));
	const previous = process.env[MODERATOR_STARTUP_GATE_DIRECTORY];
	process.env[MODERATOR_STARTUP_GATE_DIRECTORY] = gateDirectory;
	t.after(() => {
		if (previous === undefined) delete process.env[MODERATOR_STARTUP_GATE_DIRECTORY];
		else process.env[MODERATOR_STARTUP_GATE_DIRECTORY] = previous;
	});
	const firstModelStarted = deferred();
	const finishFirstModel = deferred();
	const reminderModelStarted = deferred();
	let coordinator!: OperationalIncidentCoordinator;
	let generatedReminders = 0;
	const integrate = OperationalIncidentCoordinator.prototype.integrate;
	t.mock.method(OperationalIncidentCoordinator.prototype, "integrate", function (
		this: OperationalIncidentCoordinator, ...args: Parameters<typeof integrate>
	) { coordinator = this; return integrate.apply(this, args); });
	const admit = MessageDeliveryScheduler.prototype.admitCustom;
	t.mock.method(MessageDeliveryScheduler.prototype, "admitCustom", function (
		this: MessageDeliveryScheduler, ...args: Parameters<typeof admit>
	) {
		if (args[1].customMessage.customType === "agent-coordination.moderator-obligation-reminder") generatedReminders++;
		return admit.apply(this, args);
	});
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
		additionalExtensionPaths: [fileURLToPath(new URL("./fixtures/moderator-startup-gate.ts", import.meta.url))],
	});
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "Demonstrate a stalled obligation." },
			{ id: "spawn-for-startup-progress" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Delegated."),
		fauxAssistantMessage("Still owe an Answer."),
		fauxAssistantMessage("Still owe an Answer after reminder."),
		async () => {
			firstModelStarted.resolve();
			await finishFirstModel.promise;
			return fauxAssistantMessage("The first handling attempt settled.");
		},
		context => {
			assert.match(JSON.stringify(context.messages.at(-1)), /Inspect the original Moderator Input/);
			reminderModelStarted.resolve();
			return fauxAssistantMessage("The genuine post-settlement reminder arrived.");
		},
	]);
	const prompt = host.session.prompt("Create the stalled Agent.");
	try {
		const native = await waitForStart(join(gateDirectory, STARTED_FILE));
		assert.equal(native.idle, false);
		// Force a real eligibility inspection while the first native start hook is held.
		coordinator.deliveryProgressChanged();
		await bounded(coordinator.reachSafeBoundary());
		assert.equal(generatedReminders, 0, "pending first startup is progress, not abandoned handling");
		await writeFile(join(gateDirectory, RELEASE_FILE), "");
		await bounded(firstModelStarted.promise);
		coordinator.deliveryProgressChanged();
		await bounded(coordinator.reachSafeBoundary());
		assert.equal(generatedReminders, 0, "the initial model call has not settled");
		finishFirstModel.resolve();
		await bounded(reminderModelStarted.promise);
		assert.equal(generatedReminders, 1, "genuine settled handling still receives its reminder");
	} finally {
		await writeFile(join(gateDirectory, RELEASE_FILE), "");
		finishFirstModel.resolve();
		await host.session.abort();
		await prompt;
	}
});


test("termination queued behind Moderator startup cannot resurrect its Run", { timeout: 15000 }, async t => {
	let coordinator!: OperationalIncidentCoordinator;
	let moderator: AgentRecord | undefined;
	let starts = 0;
	const terminated = deferred();
	const integrate = OperationalIncidentCoordinator.prototype.integrate;
	t.mock.method(OperationalIncidentCoordinator.prototype, "integrate", function (
		this: OperationalIncidentCoordinator, ...args: Parameters<typeof integrate>
	) {
		coordinator = this;
		const record = args[0];
		if (record.identity.metadata.label === "Moderator" && !moderator) {
			moderator = record;
			const start = record.host.startInLane.bind(record.host);
			t.mock.method(record.host, "startInLane", async (...startArgs: Parameters<typeof start>) => {
				const handle = await start(...startArgs);
				starts++;
				if (starts === 1) {
					// Queue a real termination after readiness while startup still owns the lane.
					void record.host.lane.run(async () => {
						await record.host.discardAndEndInLane("termination");
						terminated.resolve();
					});
				}
				return handle;
			});
		}
		return integrate.apply(this, args);
	});
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true, processVisibleModel: true, implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage(fauxToolCall("agent_spawn", { title: "Fixture request", request: "Demonstrate a stalled obligation." },
			{ id: "spawn-for-startup-termination" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Delegated."),
		fauxAssistantMessage("Still owe an Answer."),
		fauxAssistantMessage("Still owe an Answer after reminder."),
		fauxAssistantMessage("Handling."),
	]);
	const prompt = host.session.prompt("Create the stalled Agent.");
	try {
		await bounded(terminated.promise);
		// Drain reconciliation and the host lane, rather than relying on a timing grace period.
		await bounded(coordinator.reachSafeBoundary());
		await bounded(moderator!.host.lane.run(() => undefined));
		assert.equal(starts, 1, "initial delivery must not start a second Run after termination");
		assert.equal(moderator!.host.currentHandle(), undefined);
	} finally {
		await host.session.abort();
		await prompt;
	}
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
async function waitForStart(path: string): Promise<{ idle: boolean }> {
	const signal = AbortSignal.timeout(5000);
	for (;;) {
		signal.throwIfAborted();
		try { return JSON.parse(await readFile(path, "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		await setTimeout(1, undefined, { signal });
	}
}
function bounded<T>(promise: Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = globalThis.setTimeout(() => reject(new Error("Startup progress wait exceeded 5s")), 5000);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}
