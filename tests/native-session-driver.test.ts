import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
	NativeSessionDriver,
	type NativeSessionEvent,
} from "../src/pi-integration/native-session-driver.ts";
import { disposeSessionStartup, registerSessionStartup } from "../src/pi-integration/session-startup.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createTestOwnerHost, type TestOwnerHost, type TestOwnerHostOptions } from "./support/pi-host.ts";
import { oversizedPngImage } from "./support/test-images.ts";

type RunEnded = Extract<NativeSessionEvent, { type: "run_ended" }>;

async function fixture(t: TestContext, extension?: ExtensionFactory, options?: TestOwnerHostOptions) {
	const host = await createTestOwnerHost(t, pi => {
		registerSessionStartup(pi);
		return extension?.(pi);
	}, { fauxTokensPerSecond: 100_000, ...options });
	const driver = new NativeSessionDriver(host.session);
	t.after(() => driver.dispose());
	const events: NativeSessionEvent[] = [];
	driver.subscribe(event => events.push(event));
	const runEnds = () => events.filter((event): event is RunEnded => event.type === "run_ended");
	return { ...host, driver, events, runEnds };
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(settle => { resolve = settle; });
	return { promise, resolve };
}

function customMessage(id: string, content = "Run the delivered work.") {
	const source = { agentId: "delivery-author", entryId: `${id}-entry`, toolCallId: id };
	return createMessageDelivery([{ source, projection: {
		kind: "message", messageId: deriveMessageIdentity(source), fromAgentId: source.agentId, content,
	} }]);
}

function committedCustomEntries(host: TestOwnerHost, message: ReturnType<typeof customMessage>) {
	return host.session.sessionManager.getEntries().filter(entry =>
		entry.type === "custom_message" && entry.content === message.content);
}

function modelError(errorMessage: string) {
	return fauxAssistantMessage([], { stopReason: "error", errorMessage });
}

const QUOTA_DIAGNOSTIC = '{"error":{"code":"usage_limit_reached"}}';

const runEndRows: ReadonlyArray<Readonly<{
	name: string;
	retry?: boolean;
	respond(host: TestOwnerHost): Parameters<TestOwnerHost["model"]["setResponses"]>[0];
	expected: Readonly<{ outcome: string; willRetry: boolean; failure?: unknown; quotaDiagnostic?: string }>;
}>> = [
	{
		name: "completed",
		respond: () => [fauxAssistantMessage("Done.")],
		expected: { outcome: "completed", willRetry: false },
	},
	{
		name: "aborted stop reason",
		respond: () => [fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "Request was aborted" })],
		expected: { outcome: "aborted", willRetry: false },
	},
	{
		// Pi reports a request setup abandoned by the Run's own abort signal as a
		// model error carrying the abort reason; the deliberate stop owns it.
		name: "error while the Run's own cancellation signal is aborted",
		respond: host => [() => {
			host.session.agent.abort();
			throw new Error("This operation was aborted");
		}],
		expected: { outcome: "aborted", willRetry: false },
	},
	{
		name: "error",
		respond: () => [modelError("400 upstream provider exploded")],
		expected: {
			outcome: "error", willRetry: false,
			failure: { stage: "model", error: "400 upstream provider exploded", provenance: "native-session-driver" },
		},
	},
	{
		name: "quota error",
		respond: () => [modelError(QUOTA_DIAGNOSTIC)],
		expected: {
			outcome: "error", willRetry: false,
			failure: { stage: "model", error: QUOTA_DIAGNOSTIC, provenance: "native-session-driver" },
			quotaDiagnostic: QUOTA_DIAGNOSTIC,
		},
	},
	{
		name: "error that Pi will retry",
		retry: true,
		respond: () => [modelError("429 Too Many Requests"), fauxAssistantMessage("Recovered.")],
		expected: {
			outcome: "error", willRetry: true,
			failure: { stage: "model", error: "429 Too Many Requests", provenance: "native-session-driver" },
		},
	},
];

for (const row of runEndRows) {
	test(`Run end classifies ${row.name}`, { timeout: 5000 }, async t => {
		const host = await fixture(t, undefined, row.retry
			? { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } }
			: undefined);
		host.model.setResponses(row.respond(host));
		await host.session.prompt("Start the Run.");
		await host.driver.waitForIdle();
		const [ended] = host.runEnds();
		assert.ok(ended);
		assert.deepEqual({
			outcome: ended.outcome,
			willRetry: ended.willRetry,
			...(ended.failure ? { failure: ended.failure } : {}),
			...(ended.quota ? { quotaDiagnostic: ended.quota.diagnostic } : {}),
		}, row.expected);
	});
}

const queueCaptureRows = [
	{ name: "error", captured: true, responses: [modelError("400 upstream provider exploded")] },
	{ name: "quota error", captured: true, responses: [modelError(QUOTA_DIAGNOSTIC)] },
	{ name: "aborted stop reason", captured: false, responses: [fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "Request was aborted" })] },
	{ name: "error that Pi will retry", captured: false, retry: true, responses: [modelError("429 Too Many Requests"), fauxAssistantMessage("Recovered.")] },
] as const;

for (const row of queueCaptureRows) {
	test(`${row.name} ${row.captured ? "retains" : "leaves"} native queued input before the Run-end listener runs`, { timeout: 5000 }, async t => {
		const host = await fixture(t, undefined, "retry" in row
			? { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } }
			: undefined);
		const queuedAtRunEnd: number[] = [];
		host.driver.subscribe(event => {
			if (event.type === "run_ended" && queuedAtRunEnd.length === 0) queuedAtRunEnd.push(host.driver.queuedInputCount());
		});
		const [first, ...rest] = row.responses;
		host.model.setResponses([
			async () => {
				await host.session.prompt("Queued follow-up.", { streamingBehavior: "followUp" });
				return first;
			},
			...rest,
			fauxAssistantMessage("Queued follow-up handled."),
		]);
		await host.session.prompt("Start the Run.");
		await host.driver.waitForIdle();
		assert.deepEqual(queuedAtRunEnd, [row.captured ? 0 : 1]);
		const followUpReachedModel = host.session.messages.some(message =>
			message.role === "user" && JSON.stringify(message.content).includes("Queued follow-up."));
		assert.equal(followUpReachedModel, !row.captured);
		assert.deepEqual(host.driver.clearQueue(), row.captured
			? { steering: [], followUp: ["Queued follow-up."] }
			: { steering: [], followUp: [] });
		assert.deepEqual(host.driver.clearQueue(), { steering: [], followUp: [] }, "retained input is returned once");
	});
}

test("commit proof confirms an exact custom Delivery", { timeout: 5000 }, async t => {
	const host = await fixture(t);
	host.model.setResponses([fauxAssistantMessage("Custom handled.")]);
	const message = customMessage("exact");
	const dispatch = host.driver.deliver({ kind: "custom", message, triggerTurn: true }, { proveCommit: true });
	assert.equal(await dispatch.transcriptCommit, true);
	await dispatch.completion;
	assert.equal(committedCustomEntries(host, message).length, 1);
});

test("commit proof confirms a user Delivery before its Run completes", { timeout: 5000 }, async t => {
	const host = await fixture(t);
	const release = deferred();
	t.after(() => release.resolve());
	host.model.setResponses([async () => { await release.promise; return fauxAssistantMessage("Resumed."); }]);
	const dispatch = host.driver.deliver({ kind: "user", content: "Resume the Run." }, { proveCommit: true });
	assert.equal(await dispatch.transcriptCommit, true);
	assert.equal(host.session.isIdle, false, "proof does not wait for the Run it started");
	release.resolve();
	await dispatch.completion;
});

test("commit proof accepts Pi's normalized form of a user Delivery with an image", { timeout: 5000 }, async t => {
	const host = await fixture(t);
	host.model.setResponses([fauxAssistantMessage("Image received.")]);
	const image = oversizedPngImage();
	const dispatch = host.driver.deliver(
		{ kind: "user", content: [{ type: "text", text: "Look at this screenshot." }, image] },
		{ proveCommit: true },
	);
	assert.equal(await dispatch.transcriptCommit, true);
	await dispatch.completion;
	const [committed] = host.session.messages.filter(message => message.role === "user");
	assert.ok(committed && Array.isArray(committed.content));
	assert.ok(committed.content[1]?.type === "image" && committed.content[1].data !== image.data, "Pi persisted a resized image");
});

test("commit proof refuses a user Delivery Pi may queue: only a started Run proves it by position", { timeout: 5000 }, async t => {
	const host = await fixture(t);
	for (const deliverAs of ["steer", "followUp"] as const) {
		assert.throws(
			() => host.driver.deliver({ kind: "user", content: "Queued input.", deliverAs }, { proveCommit: true }),
			/queued_user_commit_unprovable/,
		);
	}
});

type UserContent = Extract<Parameters<NativeSessionDriver["deliver"]>[0], { kind: "user" }>["content"];

/** Commits a user message with the given text the way another submission would, without Pi's Run. */
function commitUnrelatedUserMessage(host: TestOwnerHost, text: string): void {
	host.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

// A started user Delivery is the first user message its own Run emits, so the
// proof follows Pi's message object, never its text: input transforms may append
// or rewrite it, and another message with the same text never confirms it.
const userCommitRows: ReadonlyArray<Readonly<{
	name: string;
	content: UserContent;
	input?: (text: string, host: TestOwnerHost) => { action: "transform"; text: string } | { action: "handled" };
	committed: boolean;
}>> = [
	{ name: "an image Delivery", content: [{ type: "text", text: "See image." }, oversizedPngImage()], committed: true },
	{ name: "an image-only Delivery", content: [oversizedPngImage()], committed: true },
	{ name: "text an input handler appends to", content: "Submitted text.", input: text => ({ action: "transform", text: `${text}\n\nAppended context.` }), committed: true },
	{ name: "text an input handler rewrites", content: "Submitted text.", input: () => ({ action: "transform", text: "Different text." }), committed: true },
	{
		name: "handled input while another message with the same text commits",
		content: "ok",
		input: (text, host) => { commitUnrelatedUserMessage(host, text); return { action: "handled" }; },
		committed: false,
	},
	{
		name: "a handled image-only Delivery while an unrelated message commits",
		content: [oversizedPngImage()],
		input: (_text, host) => { commitUnrelatedUserMessage(host, "Unrelated input."); return { action: "handled" }; },
		committed: false,
	},
];

for (const row of userCommitRows) {
	test(`user commit proof ${row.committed ? "confirms" : "rejects"} ${row.name}`, { timeout: 5000 }, async t => {
		let host!: Awaited<ReturnType<typeof fixture>>;
		host = await fixture(t, pi => {
			pi.on("input", event => row.input?.(event.text, host));
		});
		host.model.setResponses([fauxAssistantMessage("Input handled.")]);
		const dispatch = host.driver.deliver({ kind: "user", content: row.content }, { proveCommit: true });
		await dispatch.completion;
		assert.equal(await dispatch.transcriptCommit, row.committed);
		await host.session.waitForIdle();
	});
}

test("user commit proof follows a Delivery that a startup generation retired mid-preparation cancels", { timeout: 5000 }, async t => {
	let host!: Awaited<ReturnType<typeof fixture>>;
	host = await fixture(t, pi => {
		// An extension reload disposes the startup admission of the retired generation.
		pi.on("input", () => { disposeSessionStartup(host.session); });
	});
	const dispatch = host.driver.deliver({ kind: "user", content: "Prepared across a reload." }, { proveCommit: true });
	await assert.rejects(dispatch.completion, /startup_admission_cancelled/);
	await assert.rejects(dispatch.transcriptCommit!, /startup_admission_cancelled/);
	assert.equal(host.session.messages.length, 0);
});

test("commit proof settles false at its own message end when nothing persisted, before the Run settles", { timeout: 5000 }, async t => {
	// A lane-holding caller awaits this proof while the Run's own agent_end hook
	// waits on that lane (a forwarded human resume), so settlement never comes first.
	const runSettlement = deferred();
	t.after(() => runSettlement.resolve());
	const host = await fixture(t, pi => {
		pi.on("agent_end", () => runSettlement.promise);
	});
	const appendMessage = host.session.sessionManager.appendMessage.bind(host.session.sessionManager);
	host.session.sessionManager.appendMessage = message =>
		message.role === "user" ? "dropped-user-entry" : appendMessage(message);
	host.model.setResponses([fauxAssistantMessage("The dropped input ran.")]);
	const dispatch = host.driver.deliver({ kind: "user", content: "Never persisted." }, { proveCommit: true });
	assert.equal(await dispatch.transcriptCommit, false);
	assert.equal(host.session.isIdle, false, "proof does not wait for the Run to settle");
	runSettlement.resolve();
	await dispatch.completion;
});

test("commit proof settles false when dispatch completes without a commit", { timeout: 5000 }, async t => {
	const host = await fixture(t, pi => {
		pi.on("input", event => event.text === "Handled elsewhere." ? { action: "handled" } : undefined);
	});
	const dispatch = host.driver.deliver({ kind: "user", content: "Handled elsewhere." }, { proveCommit: true });
	await dispatch.completion;
	assert.equal(await dispatch.transcriptCommit, false);
});

test("commit proof rejects on dispatch failure and on driver disposal", { timeout: 5000 }, async t => {
	// Pi swallows input-handler errors, so the failing dispatch is a Delivery
	// cancelled while Pi prepares it: the preflight fence rejects the prompt.
	const preparing = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const host = await fixture(t, pi => {
		pi.on("input", async () => { preparing.resolve(); await release.promise; });
	});
	const cancellation = new AbortController();
	const failed = host.driver.deliver(
		{ kind: "user", content: "Cancelled in preflight." },
		{ proveCommit: true, signal: cancellation.signal },
	);
	await preparing.promise;
	cancellation.abort(new Error("delivery cancelled"));
	release.resolve();
	await assert.rejects(failed.completion, /delivery cancelled/);
	await assert.rejects(failed.transcriptCommit!, /delivery cancelled/);

	const disposablePreparing = deferred();
	const disposableRelease = deferred();
	t.after(() => disposableRelease.resolve());
	const disposable = await fixture(t, pi => {
		pi.on("input", async () => { disposablePreparing.resolve(); await disposableRelease.promise; });
	});
	const pending = disposable.driver.deliver({ kind: "user", content: "Outlives its driver." }, { proveCommit: true });
	void pending.completion.catch(() => {});
	await disposablePreparing.promise;
	disposable.driver.dispose();
	await assert.rejects(pending.transcriptCommit!, /native_session_driver_disposed/);
});

/** Serializes holders the way the child's Turn Compaction Gateway does. */
function createGate() {
	let tail = Promise.resolve();
	return {
		async hold<T>(work: () => Promise<T>): Promise<T> {
			const previous = tail;
			let release!: () => void;
			tail = new Promise(resolve => { release = resolve; });
			await previous;
			try { return await work(); } finally { release(); }
		},
	};
}

test("a busy custom startup retries outside its turn admission and keeps its queue mode", { timeout: 5000 }, async t => {
	const gate = createGate();
	const humanPreparing = deferred();
	const admissionHoldsGate = deferred();
	const customQueued = deferred();
	t.after(() => { admissionHoldsGate.resolve(); customQueued.resolve(); });
	// The preparing human input needs the gate the custom Delivery's admission holds.
	const host = await fixture(t, pi => {
		pi.on("input", async () => {
			humanPreparing.resolve();
			await admissionHoldsGate.promise;
			await gate.hold(async () => undefined);
		});
	});
	const followUps: string[] = [];
	const nativeFollowUp = host.session.agent.followUp.bind(host.session.agent);
	host.session.agent.followUp = message => {
		if (message.role === "custom") followUps.push(message.customType);
		nativeFollowUp(message);
	};
	host.model.setResponses([
		async () => { await customQueued.promise; return fauxAssistantMessage("Human handled."); },
		fauxAssistantMessage("Custom handled."),
	]);
	const human = host.session.prompt("Human input.");
	await humanPreparing.promise;

	const message = customMessage("busy-retry");
	let admissions = 0;
	const dispatch = host.driver.deliver(
		{ kind: "custom", message, triggerTurn: true, deliverAs: "followUp" },
		{
			proveCommit: true,
			admission: {
				admit: attempt => gate.hold(() => {
					admissions += 1;
					admissionHoldsGate.resolve();
					return attempt(() => undefined);
				}),
			},
		},
	);
	assert.deepEqual(await dispatch.preflight, { runActive: true });
	customQueued.resolve();
	assert.equal(await dispatch.transcriptCommit, true);
	await Promise.all([dispatch.completion, human]);
	await host.driver.waitForIdle();
	assert.equal(admissions, 2, "the retry re-entered admission after the human preparation released");
	assert.deepEqual(followUps, [message.customType]);
	assert.equal(committedCustomEntries(host, message).length, 1);
});

test("idle custom commit starts and proves one Run while idle", { timeout: 5000 }, async t => {
	const host = await fixture(t);
	host.model.setResponses([fauxAssistantMessage("Reminder handled.")]);
	const message = customMessage("idle-commit");
	assert.equal(await host.driver.commitIdleCustom(message), "committed");
	await host.driver.waitForIdle();
	assert.equal(committedCustomEntries(host, message).length, 1);
});

test("idle custom commit is busy while a native Run is active", { timeout: 5000 }, async t => {
	const host = await fixture(t);
	const modelStarted = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	host.model.setResponses([async () => { modelStarted.resolve(); await release.promise; return fauxAssistantMessage("Done."); }]);
	const run = host.session.prompt("Long work.");
	await modelStarted.promise;
	const message = customMessage("active-run");
	assert.equal(await host.driver.commitIdleCustom(message), "busy");
	release.resolve();
	await run;
	await host.driver.waitForIdle();
	assert.equal(committedCustomEntries(host, message).length, 0, "a busy commit never enters Pi's queue");
});

test("idle custom commit is busy while another input prepares its startup", { timeout: 5000 }, async t => {
	const preparing = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const host = await fixture(t, pi => {
		pi.on("input", async () => { preparing.resolve(); await release.promise; });
	});
	host.model.setResponses([fauxAssistantMessage("Human handled.")]);
	const human = host.session.prompt("Human input.");
	await preparing.promise;
	assert.equal(host.session.isIdle, true, "preparation has not started a native Run");
	const message = customMessage("preparing");
	assert.equal(await host.driver.commitIdleCustom(message), "busy");
	release.resolve();
	await human;
	assert.equal(committedCustomEntries(host, message).length, 0);
});

test("idle custom commit fails when the transcript lacks the exact Delivery", { timeout: 5000 }, async t => {
	const host = await fixture(t);
	// A forwarding wrapper installed after binding enriches what Pi persists.
	const sendCustomMessage = host.session.sendCustomMessage.bind(host.session);
	host.session.sendCustomMessage = (message, options) =>
		sendCustomMessage({ ...message, content: `${String(message.content)} (enriched)` }, options);
	host.model.setResponses([fauxAssistantMessage("Enriched reminder handled.")]);
	await assert.rejects(host.driver.commitIdleCustom(customMessage("enriched")), /idle_custom_commit_missing/);
});

test("compaction follows Pi's edges, not its controller flag that outlives threshold compaction", { timeout: 5000 }, async t => {
	// A reserve near the faux model's whole context window puts every Run past Pi's threshold.
	const host = await fixture(t, undefined, {
		settings: { compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 1 } },
	});
	host.model.setResponses([fauxAssistantMessage("Turn fills the context."), fauxAssistantMessage("Compaction summary.")]);
	const edges: Array<Readonly<{ compacting: boolean; driver: boolean; nativeFlag: boolean }>> = [];
	host.driver.subscribe(event => {
		if (event.type === "compaction_changed") {
			edges.push({ compacting: event.compacting, driver: host.driver.isCompacting(), nativeFlag: host.session.isCompacting });
		}
	});
	await host.session.prompt("Fill the context.");
	await host.driver.waitForIdle();
	assert.deepEqual(edges, [
		{ compacting: true, driver: true, nativeFlag: true },
		{ compacting: false, driver: false, nativeFlag: true },
	]);
});
