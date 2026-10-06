import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { HumanPresentationCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import {
	createAgentSelectionSession,
	createAgentSelectorSnapshot,
	createOwnerAgentPresentationHandlers,
} from "../src/process-runtime/remote-agent-selector.ts";
import type { PostMortemAgentView } from "../src/presentation/post-mortem-agent-view-surface.ts";

const ownerStatus = {
	agentId: "owner",
	workflowId: "owner",
	label: "Owner",
	directSpawnerAgentId: null,
	primaryEvidence: {
		transcriptPath: "/sessions/owner.jsonl",
		inspectedThrough: { agentId: "owner", entryId: "owner-entry" },
	},
	run: {
		phase: "live",
		work: "settled",
		attention: "none",
		retentionReasons: [{ reason: "owner_host_binding", count: 1 }],
	},
	model: { provider: "provider", modelId: "model" },
	thinking: "high",
	compacting: false,
	queuedInputCount: 0,
} as const;
const childStatus = {
	...ownerStatus,
	agentId: "child",
	workflowId: "owner",
	label: "Child",
	directSpawnerAgentId: "owner",
	primaryEvidence: {
		transcriptPath: "/sessions/child.jsonl",
		inspectedThrough: { agentId: "child", entryId: "child-entry" },
	},
	run: {
		phase: "live",
		work: "settled",
		attention: "input_required",
		retentionReasons: [{ reason: "interactive_selection", count: 1 }],
	},
} as const;

function presentationView(options: {
	refreshTranscriptFacts?: HumanPresentationCoordinatorView["refreshTranscriptFacts"];
	status?: HumanPresentationCoordinatorView["status"];
	humanAttention?: () => readonly Readonly<{
		requestId: string;
		agentId: string;
		agentLabel: string;
		question: string;
	}>[];
	openAgentView?: (agentId: string) => Promise<undefined>;
	openAgentPresentation?: HumanPresentationCoordinatorView["openAgentPresentation"];
	focusHumanAnswer?: (agentId: string, requestId: string) => Promise<void>;
} = {}): HumanPresentationCoordinatorView {
	return {
		refreshTranscriptFacts: options.refreshTranscriptFacts ?? (async () => undefined),
		status: options.status ?? (() => childStatus),
		selectionRoster: () => ({ live: [ownerStatus, childStatus], dormant: [], quarantined: [], quarantinedCandidateCount: 0 }),
		humanAttention: options.humanAttention ?? (() => []),
		operationalAttention: () => [],
		reportHistory: () => [],
		setReportRead: () => {},
		openAgentView: options.openAgentView ?? (async () => undefined),
		openAgentPresentation: options.openAgentPresentation ?? (async (agentId) => ({
			kind: "selected",
			view: await (options.openAgentView ?? (async () => undefined))(agentId),
		})),
		focusHumanAnswer: options.focusHumanAnswer ?? (async () => undefined),
		bindPhysicalAgentSurface: () => () => undefined,
	} as unknown as HumanPresentationCoordinatorView;
}

test("selector snapshot is one exact scoped presentation boundary value", () => {
	const attention = [{
		requestId: "request",
		agentId: "child",
		agentLabel: "Child",
		question: "Which path?",
	}] as const;
	const snapshot = createAgentSelectorSnapshot(presentationView({
		humanAttention: () => attention,
	}), "child");

	assert.deepEqual(snapshot, {
		live: [ownerStatus, childStatus],
		dormant: [],
		quarantined: [],
		quarantinedCandidateCount: 0,
		selectedAgentId: "child",
		humanAttention: attention,
		operationalAttention: [], reports: [],
	});
});

test("selector snapshot passes quarantined identities and candidate count through", () => {
	const snapshot = createAgentSelectorSnapshot({
		...presentationView(),
		selectionRoster: () => ({
			live: [ownerStatus],
			dormant: [],
			quarantined: ["zx-9", "ab-1"],
			quarantinedCandidateCount: 3,
		}),
	}, "owner");

	assert.deepEqual(snapshot.quarantined, ["zx-9", "ab-1"]);
	assert.equal(snapshot.quarantinedCandidateCount, 3);
});

test("remote presentation navigates existing Owner and Moderator identities without transcript refresh", async () => {
	const opened: string[] = [];
	const moderatorStatus = { ...childStatus, agentId: "moderator", label: "Moderator" };
	const view = { ...presentationView({
		refreshTranscriptFacts: async () => { throw new Error("transcript refresh unavailable"); },
		openAgentPresentation: async (agentId) => {
			opened.push(agentId);
			return { kind: "selected" };
		},
	}), selectionRoster: () => ({ live: [ownerStatus, moderatorStatus], dormant: [], quarantined: [], quarantinedCandidateCount: 0 }) };
	const presentation = createOwnerAgentPresentationHandlers(() => view, "moderator");
	const snapshot = await presentation.snapshot();
	assert.deepEqual(snapshot.live.map(({ agentId }) => agentId), ["owner", "moderator"]);
	assert.deepEqual(opened, []);
	await presentation.select({ kind: "select_agent", agentId: "owner" }, new AbortController().signal);
	const ownerPresentation = createOwnerAgentPresentationHandlers(() => view, "owner");
	await ownerPresentation.select({ kind: "select_agent", agentId: "moderator" }, new AbortController().signal);
	assert.deepEqual(opened, ["owner", "moderator"]);
});

test("stale Human Attention after view preparation restores the previous child", async () => {
	let pending = true;
	const opened: string[] = [];
	const session = createAgentSelectionSession(presentationView({
		humanAttention: () => pending ? [{
			requestId: "request",
			agentId: "target",
			agentLabel: "Target",
			question: "Proceed?",
		}] : [],
		openAgentView: async (agentId) => {
			opened.push(agentId);
			pending = false;
			return undefined;
		},
	}), "child");

	await assert.rejects(
		session.prepare({ kind: "decide", requestId: "request", agentId: "target" }),
		/stale_request/,
	);
	assert.deepEqual(opened, ["target", "child"]);
});

test("Human Answer focus failure restores the exact previous selection", async () => {
	const opened: string[] = [];
	const view = presentationView({
		humanAttention: () => [{
			requestId: "request",
			agentId: "target",
			agentLabel: "Target",
			question: "Proceed?",
		}],
		openAgentView: async (agentId) => {
			opened.push(agentId);
			return undefined;
		},
		focusHumanAnswer: async () => {
			throw new Error("focus failed");
		},
	});
	const session = createAgentSelectionSession(view, "child");
	const action = { kind: "decide", requestId: "request", agentId: "target" } as const;
	await session.prepare(action);

	await assert.rejects(session.complete(action), /focus failed/);
	assert.deepEqual(opened, ["target", "child"]);
});

test("failed Dormant preparation returns a post-mortem selection without replacing the previous Agent", async () => {
	const opened: string[] = [];
	const presented: PostMortemAgentView[] = [];
	const view = presentationView({
		openAgentPresentation: async (agentId) => {
			opened.push(agentId);
			return {
				kind: "post_mortem",
				agentId,
				label: "Failed Agent",
				transcript: {
					sessionId: agentId,
					transcriptPath: `/sessions/${agentId}.jsonl`,
					header: null,
					entries: [],
					activeBranch: [],
					context: { messages: [], thinkingLevel: "off" as const, model: null },
				},
				preparationError: "Configured model is unavailable",
			};
		},
	});
	const handlers = createOwnerAgentPresentationHandlers(() => view, "child", {
		bindPhysicalSurface: () => () => undefined,
		async present(postMortem) {
			presented.push(postMortem);
			return "back";
		},
	});

	assert.deepEqual(
		await handlers.select(
			{ kind: "select_agent", agentId: "target" },
			new AbortController().signal,
		),
		{
			kind: "post_mortem",
			agentId: "target",
			label: "Failed Agent",
			preparationError: "Configured model is unavailable",
			outcome: "back",
		},
	);
	assert.deepEqual(opened, ["target"]);
	assert.equal(presented.length, 1);
	assert.equal(presented[0]?.transcript.transcriptPath, "/sessions/target.jsonl");
});

test("post-mortem agents outcome propagates without transcript contents", async () => {
	const view = presentationView({
		openAgentPresentation: async (agentId) => ({
			kind: "post_mortem",
			agentId,
			label: "Failed Agent",
			transcript: {
				sessionId: agentId,
				transcriptPath: `/sessions/${agentId}.jsonl`,
				header: null,
				entries: [],
				activeBranch: [],
				context: { messages: [], thinkingLevel: "off", model: null },
			},
			preparationError: "Unavailable",
		}),
	});
	const handlers = createOwnerAgentPresentationHandlers(() => view, "child", {
		bindPhysicalSurface: () => () => undefined,
		async present() { return "agents"; },
	});

	assert.deepEqual(await handlers.select(
		{ kind: "select_agent", agentId: "target" },
		new AbortController().signal,
	), {
		kind: "post_mortem",
		agentId: "target",
		label: "Failed Agent",
		preparationError: "Unavailable",
		outcome: "agents",
	});
});

test("selecting the already-mounted participant closes without reopening its view", async () => {
	let opens = 0;
	const session = createAgentSelectionSession(presentationView({
		openAgentPresentation: async () => {
			opens += 1;
			throw new Error("already-mounted participant was reopened");
		},
	}), "target");

	const action = { kind: "select_agent", agentId: "target" } as const;
	await session.prepare(action);
	await session.complete(action);

	assert.equal(opens, 0);
});

test("deciding on the already-mounted participant still focuses its Human Request", async () => {
	let opens = 0;
	let focused: readonly [string, string] | undefined;
	const view = presentationView({
		humanAttention: () => [{
			requestId: "request",
			agentId: "target",
			agentLabel: "Target",
			question: "Proceed?",
		}],
		openAgentPresentation: async () => {
			opens += 1;
			return { kind: "selected" };
		},
		focusHumanAnswer: async (agentId, requestId) => {
			focused = [agentId, requestId];
		},
	});
	const session = createAgentSelectionSession(view, "target");
	const action = { kind: "decide", requestId: "request", agentId: "target" } as const;

	await session.prepare(action);
	await session.complete(action);

	assert.equal(opens, 1);
	assert.deepEqual(focused, ["target", "request"]);
});

test("a successful Dormant selection acquires its Runtime exactly once", async () => {
	let acquisitions = 0;
	const session = createAgentSelectionSession(presentationView({
		openAgentPresentation: async () => {
			acquisitions += 1;
			return { kind: "selected" };
		},
	}), "child");

	await session.prepare({ kind: "select_agent", agentId: "target" });
	assert.equal(acquisitions, 1);
});

test("Owner selection handler is awaited and does not resurrect the previous child after Control cancellation", async () => {
	let finishPreparation!: () => void;
	const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
	const opened: string[] = [];
	const view = presentationView({
		openAgentView: async (agentId) => {
			opened.push(agentId);
			if (agentId === "target") await preparation;
			return undefined;
		},
	});
	const handlers = createOwnerAgentPresentationHandlers(() => view, "child");
	const cancellation = new AbortController();
	const pending = handlers.select(
		{ kind: "select_agent", agentId: "target" },
		cancellation.signal,
	);
	cancellation.abort();
	finishPreparation();

	await assert.rejects(pending, (error: unknown) =>
		error instanceof Error && error.name === "AbortError"
	);
	assert.deepEqual(opened, ["target"]);
});
