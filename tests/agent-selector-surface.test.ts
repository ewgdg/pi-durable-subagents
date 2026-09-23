import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	TUI,
} from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import type {
	AgentRosterStatus,
	AgentStatus,
} from "../src/coordination/workflow-coordinator.ts";
import { type AgentSelectorOptions, openAgentSelectorSurface } from "../src/presentation/agent-selector-surface.ts";

test("a long Live roster stays bounded and scrolls from the selected Agent", async () => {
	const live = [
		agentStatus("owner", "Owner", null),
		...Array.from({ length: 19 }, (_, index) =>
			agentStatus(`agent-${index + 1}`, `Agent ${index + 1}`, "owner")
		),
	];
	const tui = {
		terminal: { rows: 15 },
		requestRender() {},
	} as unknown as TUI;
	const theme = plainTheme();
	let component: Component | undefined;
	let overlayOptions: unknown;
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
			options: unknown,
		): Promise<T> {
			overlayOptions = options;
			return new Promise<T>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, resolve);
			});
		},
	} as unknown as ExtensionUIContext;

	const selection = openAgentSelectorSurface(ui, {
		live,
		dormant: [],
		selectedAgentId: "agent-10",
	});
	await Promise.resolve();

	assert.deepEqual(overlayOptions, {
		overlay: true,
		overlayOptions: {
			width: 80,
			maxHeight: "90%",
			anchor: "center",
			margin: { top: 1, bottom: 1 },
		},
	});
	assert.ok(component);
	const rendered = renderPanel(component, 120);
	assert.ok(rendered.length <= 13, `rendered ${rendered.length} rows in a 15-row terminal`);
	assert.ok(rendered.every((line) => visibleWidth(line) <= 80));
	assert.match(rendered.join("\n"), /Agent 10/);
	assert.match(rendered.join("\n"), /\(10\/19\)/);
	assert.match(rendered.find((line) => line.includes("Agent 10")) ?? "", /→ Agent 10/);
	assert.match(rendered[0] ?? "", /^┌─+┐$/);
	assert.match(rendered.at(-1) ?? "", /^└─+┘$/);

	component.handleInput?.("j");
	assert.match(
		renderPanel(component, 120).find((line) => line.includes("Agent 11")) ?? "",
		/→ Agent 11/,
	);
	component.handleInput?.("\x1b[A");
	assert.match(
		renderPanel(component, 120).find((line) => line.includes("Agent 10")) ?? "",
		/→ Agent 10/,
	);
	component.handleInput?.("\x1b[B");
	assert.match(
		renderPanel(component, 120).find((line) => line.includes("Agent 11")) ?? "",
		/→ Agent 11/,
	);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Live remains terminal-bounded across Attention and Agent sections", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			...Array.from({ length: 20 }, (_, index) =>
				agentStatus(`agent-${index + 1}`, `Agent ${index + 1}`, "owner")
			),
		],
		dormant: [],
		selectedAgentId: "owner",
		humanAttention: [{
			requestId: "human-request-id",
			agentId: "agent-1",
			agentLabel: "Agent 1",
			question: "Choose the implementation boundary.",
		}],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = renderPanel(harness.component, 80);
	assert.match(rendered.join("\n"), /Attention Inbox/);
	assert.match(rendered.join("\n"), /Agents/);
	assert.doesNotMatch(rendered.join("\n"), /│\s+Owner\s+│/);
	assert.match(rendered.join("\n"), /Tab views/);
	assert.ok(rendered.length <= 21, `rendered ${rendered.length} rows in a 24-row terminal`);
	for (let move = 0; move < 10; move += 1) harness.component.handleInput?.("j");
	assert.equal(renderPanel(harness.component, 80).length, rendered.length);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("a short terminal keeps both frame edges inside Pi's overlay height", async () => {
	const harness = surfaceHarness(10);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = renderPanel(harness.component, 80);
	assert.ok(rendered.length <= 8, `rendered ${rendered.length} rows in a 10-row terminal`);
	assert.match(rendered[0] ?? "", /^┌─+┐$/);
	assert.match(rendered.at(-1) ?? "", /^└─+┘$/);
	assert.match(rendered.join("\n"), /Agents/);
	assert.match(rendered.join("\n"), /No live Agents/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Agent selection keeps the selector focused until view preparation completes", async () => {
	const harness = surfaceHarness(24);
	let releasePreparation!: () => void;
	const preparation = new Promise<void>((resolve) => {
		releasePreparation = resolve;
	});
	let preparedAgentId: string | undefined;
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("agent", "Agent", "owner"),
		],
		dormant: [],
		selectedAgentId: "agent",
		async prepareSelection(action) {
			assert.equal(action.kind, "select_agent");
			if (action.kind !== "select_agent") return;
			preparedAgentId = action.agentId;
			await preparation;
		},
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const idleAgentRow =
		renderPanel(harness.component, 80).find((line) => line.includes("→ Agent")) ?? "";
	assert.match(idleAgentRow, /→ Agent/);
	harness.component.handleInput?.("\r");
	await Promise.resolve();
	assert.equal(preparedAgentId, "agent");
	assert.equal(harness.resolved, false);
	const pendingAgentRow =
		renderPanel(harness.component, 80).find((line) => line.includes("→")) ?? "";
	assert.match(pendingAgentRow, /→ Agent\*\s+⠋ loading/);
	assert.equal(pendingAgentRow.indexOf("Agent"), idleAgentRow.indexOf("Agent"));
	assert.doesNotMatch(pendingAgentRow, /live\/settled/);
	await waitFor(() =>
		!/→ Agent\*\s+⠋ loading/.test(
			renderPanel(harness.component, 80).find((line) => line.includes("→")) ?? "",
		)
	);
	// Input remains captured by the selector during the asynchronous handoff.
	harness.component.handleInput?.("escape");
	assert.equal(harness.resolved, false);

	releasePreparation();
	assert.deepEqual(await selection, {
		kind: "select_agent",
		agentId: "agent",
	});
});

test("Live and Dormant are explicit keyboard-accessible tabs", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [
			dormantAgentStatus("recent", "Recent", "owner"),
			dormantAgentStatus("older", "Older", "owner"),
		],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	assert.match(renderPanel(harness.component, 80).join("\n"), / Live .*Dormant/);
	harness.component.handleInput?.("\t");
	const dormant = renderPanel(harness.component, 80).join("\n");
	assert.match(dormant, /Live.* Dormant /);
	assert.match(dormant, /Recent/);
	assert.match(dormant, /Older/);
	assert.doesNotMatch(dormant, /→ Owner/);

	harness.component.handleInput?.("\x1b[Z");
	assert.match(renderPanel(harness.component, 80).join("\n"), / Live .*Dormant/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("o returns to Owner from the flat Dormant roster", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("live", "Live Agent", "owner"),
		],
		dormant: [dormantAgentStatus("dormant", "Dormant Agent", "owner")],
		selectedAgentId: "dormant",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const dormant = renderPanel(harness.component, 80).join("\n");
	assert.match(dormant, / Dormant /);
	assert.match(dormant, /→ Dormant Agent/);
	assert.doesNotMatch(dormant, /→ Owner/);
	harness.component.handleInput?.("o");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

test("reopening preserves the selected Dormant Agent", async () => {
	const harness = surfaceHarness(30);
	const firstSelection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [
			dormantAgentStatus("recent", "Recent", "owner"),
			dormantAgentStatus("selected", "Selected", "owner"),
		],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	harness.component.handleInput?.("\t");
	harness.component.handleInput?.("j");
	harness.component.handleInput?.("\r");
	const selected = await firstSelection;
	assert.deepEqual(selected, { kind: "select_agent", agentId: "selected" });
	if (!selected || selected.kind !== "select_agent") throw new Error("selection missing");

	const reopened = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [
			dormantAgentStatus("recent", "Recent", "owner"),
			dormantAgentStatus("selected", "Selected", "owner"),
		],
		selectedAgentId: selected.agentId,
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = renderPanel(harness.component, 80).join("\n");
	assert.match(rendered, /Live.* Dormant /);
	assert.match(rendered, /→ Selected/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await reopened, undefined);
});

test("Live shows direct children and navigates Agent scopes", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("researcher", "Researcher", "owner"),
			agentStatus("source-scout", "Source Scout", "researcher"),
			agentStatus("synthesizer", "Synthesizer", "researcher"),
			agentStatus("builder", "Builder", "owner"),
			agentStatus("reviewer", "Reviewer", "builder"),
		],
		dormant: [],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const ownerScope = renderPanel(harness.component, 80).join("\n");
	assert.doesNotMatch(ownerScope, /→?\s*Owner\s+live/);
	assert.match(ownerScope, /Researcher.*2 children/);
	assert.match(ownerScope, /Builder.*1 child/);
	assert.doesNotMatch(ownerScope, /Source Scout|Synthesizer|Reviewer/);

	harness.component.handleInput?.("l");
	const researcherScope = renderPanel(harness.component, 80).join("\n");
	assert.match(researcherScope, /Agents › Researcher/);
	assert.match(researcherScope, /Source Scout/);
	assert.match(researcherScope, /Synthesizer/);
	assert.doesNotMatch(researcherScope, /Builder|Reviewer/);
	assert.match(
		renderPanel(harness.component, 80).find((line) => line.includes("Source Scout")) ?? "",
		/→ Source Scout/,
	);

	harness.component.handleInput?.("h");
	assert.match(
		renderPanel(harness.component, 80).find((line) => line.includes("Researcher")) ?? "",
		/→ Researcher/,
	);
	harness.component.handleInput?.("\x1b[C");
	assert.match(renderPanel(harness.component, 80).join("\n"), /Agents › Researcher/);
	harness.component.handleInput?.("\x1b[D");
	assert.match(
		renderPanel(harness.component, 80).find((line) => line.includes("Researcher")) ?? "",
		/→ Researcher/,
	);
	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "researcher" });
});

test("Agent rows show the human-facing work status", async () => {
	const harness = surfaceHarness(30);
	const waitingAgent = {
		...agentStatus("waiting-agent", "Waiting Agent", "owner"),
		run: {
			phase: "live" as const,
			work: "active" as const,
			attention: "input_required" as const,
			retentionReasons: [],
		},
	};
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), waitingAgent],
		dormant: [],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const waitingRow = renderPanel(harness.component, 80).find((line) =>
		line.includes("Waiting Agent")
	) ?? "";
	assert.match(waitingRow, /waiting \(human input\)/);
	assert.doesNotMatch(waitingRow, /live\/active/);

	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("focused Agent details use a stable four-row budget", async () => {
	const harness = surfaceHarness(30);
	const owner = selectorAgent({
		...agentStatus("owner-full-identity", "Owner", null),
		workflowId: "owner-full-identity",
		description: "Workflow Owner",
		run: {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [
				{ reason: "owner_host_binding", count: 1 },
				{ reason: "interactive_selection", count: 1 },
			],
		},
	}, "owner-provider", "owner-model", "high", 0);
	const researcher = selectorAgent({
		...agentStatus("researcher-full-identity", "Researcher", "owner-full-identity"),
		workflowId: "owner-full-identity",
		description: "Investigates focused questions",
		run: {
			phase: "live",
			work: "settled",
			attention: "input_required",
			retentionReasons: [{ reason: "answer_owed", count: 2 }],
		},
	}, "research-provider", "research-model", "medium", 1);
	const builder = selectorAgent({
		...agentStatus("builder-full-identity", "Builder", "owner-full-identity"),
		workflowId: "owner-full-identity",
		description: "Builds the selected design",
	}, "build-provider", "build-model", "low", 0);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, researcher, builder],
		dormant: [],
		selectedAgentId: researcher.agentId,
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const researcherLines = renderPanel(harness.component, 80);
	const researcherRendered = researcherLines.join("\n");
	assert.match(researcherRendered, /Investigates focused questions/);
	assert.match(researcherRendered, /researcher-full-identity/);
	assert.match(
		researcherRendered,
		/Live · settled · input required · answer owed ×2/,
	);
	assert.match(
		researcherRendered,
		/research-provider\/research-model · thinking medium · 1 queued/,
	);

	harness.component.handleInput?.("j");
	const builderLines = renderPanel(harness.component, 80);
	assert.equal(builderLines.length, researcherLines.length);
	assert.match(builderLines.join("\n"), /Builds the selected design/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("focused Agent details show a display-only fallback for missing descriptions", async () => {
	const harness = surfaceHarness(30);
	const owner = agentStatus("owner", "Owner", null);
	const worker = agentStatus("live-worker", "Live Worker", "owner");
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, worker],
		dormant: [dormantAgentStatus("worker", "Worker", "owner")],
		selectedAgentId: worker.agentId,
	});
	await Promise.resolve();
	assert.ok(harness.component);

	assert.match(renderPanel(harness.component, 80).join("\n"), /No description\./);
	assert.equal(worker.description, undefined);
	harness.component.handleInput?.("\t");
	assert.match(renderPanel(harness.component, 80).join("\n"), /No description\./);

	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("the selector uses fixed one-cell horizontal padding", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const owner = renderPanel(harness.component, 80).find((line) => line.includes("Owner"));
	assert.ok(owner);
	assert.equal(owner.slice(1).search(/\S/u), 1);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("long focused descriptions do not change horizontal padding", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [
			{
				...dormantAgentStatus("short", "Short", "owner"),
				description: "Short description",
			},
			{
				...dormantAgentStatus("long", "Long", "owner"),
				description:
					"A particularly long description that previously changed the padding of every row",
			},
		],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);
	harness.component.handleInput?.("\t");

	const shortDescriptionLines = renderPanel(harness.component, 80);
	const shortTabs = shortDescriptionLines.find((line) => line.includes("Live"));
	assert.ok(shortTabs);
	harness.component.handleInput?.("j");
	const longDescriptionLines = renderPanel(harness.component, 80);
	const longTabs = longDescriptionLines.find((line) => line.includes("Live"));
	assert.ok(longTabs);

	assert.equal(longTabs.indexOf("Live"), shortTabs.indexOf("Live"));
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Dormant Moderator rows show its incident kind while details preserve its role description", async () => {
	const harness = surfaceHarness(30);
	const moderator = selectorAgent({
		...dormantAgentStatus("moderator-id", "Moderator", null),
		description: "Incident: obligation stall",
	}, "moderator-provider", "moderator-model", "high", 0);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [moderator],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);
	harness.component.handleInput?.("\t");

	const rendered = renderPanel(harness.component, 80);
	const moderatorRow = rendered.find((line) => line.includes("Moderator")) ?? "";
	assert.match(moderatorRow, /Moderator.*dormant · Incident: obligation stall/);
	assert.match(rendered.join("\n"), /moderator-id/);
	assert.equal(rendered.filter((line) => line.includes("Incident: obligation stall")).length, 2);
	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, {
		kind: "select_agent",
		agentId: "moderator-id",
	});
});

test("Live uses one attention-first list and dispatches the exact Human Request", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("researcher", "Researcher", "owner"),
		],
		dormant: [],
		selectedAgentId: "owner",
		humanAttention: [{
			requestId: "human-request-id",
			agentId: "researcher",
			agentLabel: "Researcher",
			question: "Which boundary should remain authoritative?",
		}],
		operationalAttention: [],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const lines = renderPanel(harness.component, 80);
	const attentionHeader = lines.findIndex((line) => line.includes("Attention Inbox"));
	const decideRow = lines.findIndex((line) => line.includes("DECIDE 1"));
	const agentsHeader = lines.findIndex((line) => /Agents/.test(line));
	assert.ok(attentionHeader < decideRow);
	assert.ok(decideRow < agentsHeader);
	assert.doesNotMatch(lines.join("\n"), /→?\s*Owner\s+live/);
	assert.match(lines[decideRow] ?? "", /→ DECIDE 1/);

	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, {
		kind: "decide",
		requestId: "human-request-id",
		agentId: "researcher",
	});
});

test("single-Agent Operational ATTENTION opens the affected Agent", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		selectedAgentId: "owner",
		operationalAttention: [{
			trigger: {
				kind: "run_failure",
				agentId: "affected-agent",
				runSequence: 2,
				obligations: {
					total: 1,
					sources: [{
						agentId: "requester-agent",
						entryId: "request-entry",
						toolCallId: "request-call",
					}],
				},
			},
			affectedAgents: [{ agentId: "affected-agent", label: "Affected Agent" }],
			diagnostics: [{ agentId: "moderator", entryId: "diagnostic-entry" }],
		}],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = renderPanel(harness.component, 80).join("\n");
	assert.match(rendered, /→ ATTENTION 1 · Run Failure · Affected Agent/);
	assert.match(rendered, /Affected Affected Agent/);
	assert.match(rendered, /Request requester-agent\/request-entry\/request-call/);
	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, {
		kind: "select_agent",
		agentId: "affected-agent",
	});
});

test("multi-Agent Operational ATTENTION keeps the overlay open when Enter has no action", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		selectedAgentId: "owner",
		operationalAttention: [{
			trigger: {
				kind: "dependency_deadlock",
				agentIds: ["first-agent", "second-agent"],
				requests: { total: 0, sources: [] },
			},
			affectedAgents: [
				{ agentId: "first-agent", label: "First Agent" },
				{ agentId: "second-agent", label: "Second Agent" },
			],
			diagnostics: [],
		}],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	harness.component.handleInput?.("\r");
	assert.equal(harness.resolved, false);
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ ATTENTION 1 · Dependency Deadl/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Live breadcrumbs pin Agents and keep the newest three Agent scopes", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("alpha", "Alpha", "owner"),
			agentStatus("beta", "Beta", "alpha"),
			agentStatus("gamma", "Gamma", "beta"),
			agentStatus("delta", "Delta", "gamma"),
			agentStatus("leaf", "Leaf", "delta"),
		],
		dormant: [],
		selectedAgentId: "leaf",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = renderPanel(harness.component, 80).join("\n");
	assert.match(rendered, /Agents › … › Beta › Gamma › Delta/);
	assert.doesNotMatch(rendered, /› Owner|› Alpha/);
	const narrow = renderPanel(harness.component, 27).join("\n");
	assert.match(narrow, /Agents › … › Delta/);
	assert.doesNotMatch(narrow, /Beta/);
	for (const width of [24, 20]) {
		const veryNarrow = renderPanel(harness.component, width);
		assert.match(veryNarrow.join("\n"), /Delta/);
		assert.ok(veryNarrow.every((line) => visibleWidth(line) <= width));
	}
	const truncatedCurrentScope = renderPanel(harness.component, 15);
	assert.match(truncatedCurrentScope.join("\n"), /Agents › D…/);
	assert.doesNotMatch(truncatedCurrentScope.join("\n"), /… \/ /);
	assert.ok(truncatedCurrentScope.every((line) => visibleWidth(line) <= 15));
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

function agentStatus(
	agentId: string,
	label: string,
	directSpawnerAgentId: string | null,
): AgentRosterStatus {
	return {
		agentId,
		workflowId: "owner",
		label,
		directSpawnerAgentId,
		primaryEvidence: {
			transcriptPath: null,
			inspectedThrough: { agentId, entryId: `entry-${agentId}` },
		},
		run: {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [],
		},
		model: { provider: "test-provider", modelId: "test-model" },
		thinking: "off",
		compacting: false,
		queuedInputCount: 0,
	};
}

function dormantAgentStatus(
	agentId: string,
	label: string,
	directSpawnerAgentId: string | null,
): AgentRosterStatus {
	return {
		...agentStatus(agentId, label, directSpawnerAgentId),
		run: { phase: "dormant", retentionReasons: [] },
	};
}

function selectorAgent<T extends AgentRosterStatus>(
	status: T,
	provider: string,
	modelId: string,
	thinking: string,
	queuedInputCount: number,
): T & {
	model: { provider: string; modelId: string };
	thinking: string;
	compacting: boolean;
	queuedInputCount: number;
} {
	return {
		...status,
		model: { provider, modelId },
		thinking,
		queuedInputCount,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for selector animation");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

function surfaceHarness(terminalRows: number, styledBold = false): {
	ui: ExtensionUIContext;
	component: Component | undefined;
	resolved: boolean;
} {
	const harness: { component: Component | undefined; resolved: boolean } = {
		component: undefined,
		resolved: false,
	};
	const tui = {
		terminal: { rows: terminalRows },
		requestRender() {},
	} as unknown as TUI;
	// Styling must not add visible cells: pointer geometry uses terminal columns.
	const theme = {
		...plainTheme(),
		bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
		getBgAnsi: () => "\x1b[44m",
		bold: (text: string) => styledBold ? `\x1b[1m${text}\x1b[22m` : text,
	} as unknown as Theme;
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
		): Promise<T> {
			return new Promise<T>((resolve) => {
				harness.component = factory(
					tui,
					theme,
					{} as KeybindingsManager,
					(result) => {
						harness.resolved = true;
						resolve(result);
					},
				);
			});
		},
	} as unknown as ExtensionUIContext;
	return {
		ui,
		get component() {
			return harness.component;
		},
		get resolved() {
			return harness.resolved;
		},
	};
}

function plainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		getBgAnsi: () => "",
		bold: (text: string) => text,
	} as unknown as Theme;
}

test("an open selector refreshes compaction and restores current work without moving focus", async () => {
 const harness = surfaceHarness(24);
 const owner = agentStatus("owner", "Owner", null);
 const child = agentStatus("child", "Child", "owner");
 let publish!: (snapshot: { live: AgentRosterStatus[]; dormant: AgentRosterStatus[] }) => void;
 let removed = false;
 const selection = openAgentSelectorSurface(harness.ui, {
  live: [owner, child], dormant: [], selectedAgentId: "child",
  addChangeHandler(handler) { publish = handler; return () => { removed = true; }; },
 });
 await Promise.resolve();
 publish({ live: [owner, { ...child, compacting: true }], dormant: [] });
 assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Child.*compacting/);
 publish({ live: [owner, { ...child, compacting: false, run: { phase: "live", work: "active", attention: "none", retentionReasons: [] } }], dormant: [] });
 assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Child.*active/);
 harness.component!.handleInput?.("\x1b");
 await selection;
 (harness.component as Component & { dispose(): void }).dispose();
 assert.equal(removed, true);
});

test("Owner-default focus stays on the resolved child when attention arrives", async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const child = agentStatus("child", "Child", "owner");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, child], dormant: [], selectedAgentId: "owner",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Child/);
	publish({
		live: [owner, child], dormant: [],
		humanAttention: [{ requestId: "request", agentId: "child", agentLabel: "Child", question: "Proceed?" }],
	});
	assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Child/);
	harness.component!.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "child" });
});

for (const withSibling of [false, true]) test(`focused ending Agent stays in Live after becoming Dormant (sibling=${withSibling})`, async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const child = { ...agentStatus("child", "Child", "owner"), run: { phase: "ending" as const, attention: "none" as const, retentionReasons: [] } };
	const siblings = withSibling ? [agentStatus("sibling", "Sibling", "owner")] : [];
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, child, ...siblings], dormant: [], selectedAgentId: "owner",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	const before = renderPanel(harness.component, 80);
	const childRow = before.findIndex(line => line.includes("→ Child"));
	assert.ok(childRow >= 0);
	for (const compacting of [false, true, false]) {
		publish({ live: [owner, ...siblings], dormant: [{ ...dormantAgentStatus("child", "Child", "owner"), compacting }] });
		const after = renderPanel(harness.component, 80);
		assert.match(after[childRow]!, /→ Child.*dormant/);
		if (withSibling) assert.ok(after.findIndex(line => line.includes("Sibling")) > childRow);
	}
	harness.component!.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "child" });
});

for (const navigation of ["j", "k", "pointer"] as const) test(`leaving a migrated focused row releases it without changing the ${navigation} destination`, async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const previous = agentStatus("previous", "Previous", "owner");
	const child = agentStatus("child", "Child", "owner");
	const next = agentStatus("next", "Next", "owner");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, previous, child, next], dormant: [], selectedAgentId: "child",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	publish({ live: [owner, previous, next], dormant: [dormantAgentStatus("child", "Child", "owner")] });
	const component = harness.component!;
	const before = renderPanel(component, 80);
	assert.ok(before.findIndex(line => line.includes("Previous")) < before.findIndex(line => line.includes("→ Child")));
	assert.ok(before.findIndex(line => line.includes("→ Child")) < before.findIndex(line => line.includes("Next")));
	if (navigation === "pointer") {
		const lines = component.render(80).map(stripTerminalSequences);
		const y = lines.findIndex(line => line.includes("Next"));
		const x = lines[y]!.indexOf("Next");
		component.handleMouse?.({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: 24, shift: false, alt: false, ctrl: false });
	} else {
		component.handleInput?.(navigation);
		assert.match(renderPanel(component, 80).join("\n"), navigation === "j" ? /→ Next/ : /→ Previous/);
	}
	assert.doesNotMatch(renderPanel(component, 80).join("\n"), /Child/);
	if (navigation !== "pointer") component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: navigation === "k" ? "previous" : "next" });
});

test("changing tabs releases a migrated row and returning restores normal membership", async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const child = agentStatus("child", "Child", "owner");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, child], dormant: [], selectedAgentId: "owner",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	publish({ live: [owner], dormant: [dormantAgentStatus("child", "Child", "owner")] });
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ Child.*dormant/);
	harness.component!.handleInput?.("\t");
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ Child.*dormant/);
	harness.component!.handleInput?.("\x1b[Z");
	assert.doesNotMatch(renderPanel(harness.component, 80).join("\n"), /Child/);
	harness.component!.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("focused Dormant Agent becoming Live keeps its row until focus leaves", async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const child = dormantAgentStatus("child", "Child", "owner");
	const sibling = dormantAgentStatus("sibling", "Sibling", "owner");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner], dormant: [child, sibling], selectedAgentId: "child",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	publish({ live: [owner, agentStatus("child", "Child", "owner")], dormant: [sibling] });
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ Child\*.*idle/);
	harness.component!.handleInput?.("j");
	assert.doesNotMatch(renderPanel(harness.component, 80).join("\n"), /Child/);
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ Sibling/);
	harness.component!.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "sibling" });
});

test("changing scope releases a migrated focused row", async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const branch = agentStatus("branch", "Branch", "owner");
	const child = agentStatus("child", "Child", "branch");
	const sibling = agentStatus("sibling", "Sibling", "branch");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, branch, child, sibling], dormant: [], selectedAgentId: "child",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	publish({ live: [owner, branch, sibling], dormant: [dormantAgentStatus("child", "Child", "branch")] });
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ Child\*.*dormant/);
	harness.component!.handleInput?.("h");
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ Branch/);
	harness.component!.handleInput?.("l");
	assert.doesNotMatch(renderPanel(harness.component, 80).join("\n"), /Child/);
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ Sibling/);
	harness.component!.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "sibling" });
});

test("a mounted but unfocused Agent is not retained when it migrates", async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const child = agentStatus("child", "Child", "owner");
	const sibling = agentStatus("sibling", "Sibling", "owner");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, child, sibling], dormant: [], selectedAgentId: "child",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	harness.component!.handleInput?.("j");
	publish({ live: [owner, sibling], dormant: [dormantAgentStatus("child", "Child", "owner")] });
	assert.doesNotMatch(renderPanel(harness.component, 80).join("\n"), /Child/);
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ Sibling/);
	harness.component!.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "sibling" });
});

test("a disappeared selection's fallback stays focused on subsequent refreshes", async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const child = agentStatus("child", "Child", "owner");
	const sibling = agentStatus("sibling", "Sibling", "owner");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, child, sibling], dormant: [], selectedAgentId: "child",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	publish({ live: [owner, sibling], dormant: [] });
	assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Sibling/);
	publish({ live: [owner, child, sibling], dormant: [] });
	assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Sibling/);
	harness.component!.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "sibling" });
});

test("Owner footer is the final non-wrapping focus destination", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), agentStatus("child", "Child", "owner")],
		dormant: [], selectedAgentId: "child",
	});
	const component = harness.component!;
	component.handleInput?.("k");
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("j");
	component.handleInput?.("j");
	assert.doesNotMatch(renderPanel(component, 80).join("\n"), /→ /);
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

test("Agents heading returns to root and preserves the top-level ancestor", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("first", "First", "owner"),
			agentStatus("branch", "Branch", "owner"),
			agentStatus("nested", "Nested", "branch"),
			agentStatus("leaf", "Leaf", "nested"),
		], dormant: [], selectedAgentId: "leaf",
	});
	const component = harness.component!;
	clickLabel(component, "Agents");
	assert.equal(harness.resolved, false);
	assert.match(renderPanel(component, 80).join("\n"), /→ Branch/);
	assert.doesNotMatch(renderPanel(component, 80).join("\n"), /\[›\] Nested/);
	clickLabel(component, "Agents");
	assert.match(renderPanel(component, 80).join("\n"), /→ Branch/);
	component.handleInput?.("k");
	assert.match(renderPanel(component, 80).join("\n"), /→ First/);
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "first" });
});

test("Attention, Agents and Owner form one non-circular order", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), agentStatus("child", "Child", "owner")],
		dormant: [], selectedAgentId: "child",
		humanAttention: [{ requestId: "request", agentId: "child", agentLabel: "Child", question: "Proceed?" }],
	});
	const component = harness.component!;
	component.handleInput?.("j");
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("j");
	assert.doesNotMatch(renderPanel(component, 80).join("\n"), /→ /);
	component.handleInput?.("k");
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("k");
	component.handleInput?.("k");
	assert.match(renderPanel(component, 80).join("\n"), /→ DECIDE/);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Dormant has an Agents heading and a final Owner action", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [dormantAgentStatus("child", "Child", "owner")], selectedAgentId: "child",
	});
	const component = harness.component!;
	assert.match(renderPanel(component, 80).join("\n"), /Agents/);
	component.handleInput?.("j");
	component.handleInput?.("l");
	assert.doesNotMatch(renderPanel(component, 80).join("\n"), /→ /);
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

test("nested Agents path stays visible while scrolling and children remain a trailing action", async () => {
	const harness = surfaceHarness(15);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("branch", "Branch", "owner"),
			...Array.from({ length: 20 }, (_, index) => agentStatus("child-" + index, "Child " + index, "branch")),
			agentStatus("grandchild", "Grandchild", "child-10"),
		], dormant: [], selectedAgentId: "child-10",
	});
	const component = harness.component!;
	let rendered = renderPanel(component, 80);
	assert.match(rendered.join("\n"), /Agents › Branch/);
	assert.match(rendered.join("\n"), /→ Child 10.*1 child ›\s+│/);
	component.handleInput?.("j");
	rendered = renderPanel(component, 80);
	assert.match(rendered.join("\n"), /Agents › Branch/);
	assert.match(rendered.join("\n"), /→ Child 11/);
	assert.ok(rendered.length <= 13);
	component.handleInput?.("k");
	component.handleInput?.("\x1b[C");
	assert.match(renderPanel(component, 80).join("\n"), /→ Grandchild/);
	component.handleInput?.("h");
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "child-10" });
});

test("Agents root browsing preserves its Dormant ancestor", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("root", "Root", "owner"),
			agentStatus("leaf", "Leaf", "sleeping"),
		], dormant: [dormantAgentStatus("sleeping", "Sleeping", "owner")],
		selectedAgentId: "leaf",
		humanAttention: [{ requestId: "request", agentId: "leaf", agentLabel: "Leaf", question: "Proceed?" }],
	});
	const component = harness.component!;
	clickLabel(component, "Agents");
	assert.match(renderPanel(component, 80).join("\n"), /→ Sleeping/);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("focused Owner keeps preparation feedback and input ownership until selection completes", async () => {
	const harness = surfaceHarness(24);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [], selectedAgentId: "owner",
		prepareSelection: () => pending,
	});
	const component = harness.component!;
	component.handleInput?.("\r");
	try {
		assert.match(renderPanel(component, 80).join("\n"), /Owner.*loading/);
		component.handleInput?.("\x1b");
		assert.equal(harness.resolved, false);
	} finally {
		release();
	}
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

test("short Attention view retains its focused summary and Owner footer", async () => {
	const harness = surfaceHarness(10);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), agentStatus("child", "Child", "owner")],
		dormant: [], selectedAgentId: "owner",
		humanAttention: [{ requestId: "request", agentId: "child", agentLabel: "Child", question: "Proceed?" }],
	});
	const rendered = renderPanel(harness.component!, 80);
	assert.ok(rendered.length <= 8);
	assert.match(rendered.join("\n"), /→ DECIDE/);
	assert.match(rendered.join("\n"), /Agents/);
	harness.component!.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("primary pointer controls separate browsing, opening, and informational details", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			{ ...agentStatus("branch", "Branch", "owner"), description: "Informational detail" },
			agentStatus("leaf", "Leaf", "branch"),
		], dormant: [dormantAgentStatus("sleeping", "Sleeping", "owner")],
		selectedAgentId: "owner",
	});
	const component = harness.component!;
	const click = (text: string, offset = 0) => {
		const lines = component.render(80).map(stripTerminalSequences);
		const y = lines.findIndex((line) => line.includes(text));
		assert.ok(y >= 0, text);
		const x = lines[y]!.indexOf(text) + offset;
		component.handleMouse?.({
			type: "click", button: "left", x, y, screenX: x, screenY: y,
			width: 80, height: 30, shift: false, alt: false, ctrl: false,
		});
	};
	click("Dormant");
	assert.match(component.render(80).join("\n"), /→ Sleeping/);
	click("Live");
	click("Informational detail");
	assert.equal(harness.resolved, false);
	click("1 child ›", 5);
	assert.match(component.render(80).join("\n"), /→ Leaf/);
	assert.equal(harness.resolved, false);
	click("Agents");
	assert.match(component.render(80).join("\n"), /→ Branch/);
	click("Branch");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "branch" });
});

function renderPanel(component: Component | undefined, width: number): string[] {
	const lines = (component?.render(width) ?? []).map(stripTerminalSequences);
	const top = lines.findIndex((line) => line.includes("┌"));
	const bottom = lines.findIndex((line) => line.includes("└"));
	const left = lines[top]?.indexOf("┌") ?? 0;
	return lines.slice(top, bottom + 1).map((line) => line.slice(left).trimEnd());
}

test("Live browsing traverses Dormant ancestors without opening them and keeps fully Dormant branches separate", async () => {
	const harness = surfaceHarness(30);
	const prepared: unknown[] = [];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), agentStatus("leaf", "Leaf", "middle")],
		dormant: [
			dormantAgentStatus("root", "Sleeping root", "owner"),
			dormantAgentStatus("middle", "Sleeping middle", "root"),
			dormantAgentStatus("quiet", "Quiet branch", "root"),
			dormantAgentStatus("quiet-leaf", "Quiet leaf", "quiet"),
		],
		selectedAgentId: "owner",
		prepareSelection: async (action) => { prepared.push(action); },
	});
	const component = harness.component!;
	assert.match(renderPanel(component, 80).join("\n"), /→ Sleeping root.*1 child/);
	assert.match(renderPanel(component, 80).join("\n"), /dormant/);
	component.handleInput?.("l");
	assert.match(renderPanel(component, 80).join("\n"), /→ Sleeping middle.*1 child/);
	component.handleInput?.("l");
	assert.match(renderPanel(component, 80).join("\n"), /→ Leaf/);
	component.handleInput?.("h");
	assert.match(renderPanel(component, 80).join("\n"), /→ Sleeping middle/);
	component.handleInput?.("h");
	assert.match(renderPanel(component, 80).join("\n"), /→ Sleeping root/);
	component.handleInput?.("\t");
	const dormant = renderPanel(component, 80).join("\n");
	assert.match(dormant, /Quiet branch/);
	assert.match(dormant, /Quiet leaf/);
	assert.doesNotMatch(dormant, /Sleeping root|Sleeping middle|Leaf/);
	assert.deepEqual(prepared, []);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

for (const phase of ["starting", "live", "ending"] as const) {
	test(`a selected Dormant ancestor opens in Live with a ${phase} descendant`, async () => {
		const harness = surfaceHarness(24);
		const parent = dormantAgentStatus("parent", "Sleeping parent", "owner");
		const child = { ...agentStatus("child", "Child", "parent"),
			run: { phase, attention: "none" as const, retentionReasons: [] } };
		const selection = openAgentSelectorSurface(harness.ui, {
			live: [agentStatus("owner", "Owner", null), child],
			dormant: [parent], selectedAgentId: "parent",
		});
		const component = harness.component!;
		assert.match(renderPanel(component, 80).join("\n"), /→ Sleeping parent.*1 child/);
		component.handleInput?.("l");
		assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
		component.handleInput?.("h");
		component.handleInput?.("\r");
		assert.deepEqual(await selection, { kind: "select_agent", agentId: "parent" });
		assert.equal(parent.run.phase, "dormant");
	});
}

test("roster refresh retains a newly Dormant parent until its last live descendant becomes Dormant", async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const parent = agentStatus("parent", "Parent", "owner");
	const child = agentStatus("child", "Child", "parent");
	const sleepingParent = dormantAgentStatus("parent", "Parent", "owner");
	const sleepingChild = dormantAgentStatus("child", "Child", "parent");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, parent, child], dormant: [], selectedAgentId: "owner",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	const component = harness.component!;
	publish({ live: [owner, child], dormant: [sleepingParent] });
	assert.match(renderPanel(component, 80).join("\n"), /→ Parent.*dormant.*1 child/);
	component.handleInput?.("l");
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("h");
	publish({ live: [owner], dormant: [sleepingParent, sleepingChild] });
	assert.match(renderPanel(component, 80).join("\n"), /→ Parent.*dormant/);
	component.handleInput?.("j"); // Leaving the focused row releases its presentation-only pin.
	assert.match(renderPanel(component, 80).join("\n"), /No live Agents/);
	component.handleInput?.("\t");
	assert.match(renderPanel(component, 80).join("\n"), /Parent/);
	assert.match(renderPanel(component, 80).join("\n"), /Child/);
	publish({ live: [owner, child], dormant: [sleepingParent] });
	assert.match(renderPanel(component, 80).join("\n"), /→ Parent.*dormant/);
	component.handleInput?.("j");
	assert.match(renderPanel(component, 80).join("\n"), /No dormant Agents/);
	component.handleInput?.("\x1b[Z");
	assert.match(renderPanel(component, 80).join("\n"), /Parent.*1 child/);
	component.handleInput?.("k"); // Return from the footer to the repopulated list.
	component.handleInput?.("l");
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "child" });
});

test("pending reports open from Attention as distinct actions; read reports remain in history", async () => {
	const harness = surfaceHarness(24);
	const report = {
		reportId: "report-1", createdAt: "2026-01-01T00:00:00Z",
		reporter: { agentId: "moderator", label: "Moderator" },
		source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/report.jsonl" },
		symptom: "Delivery stalled", suspectedDefect: "Dispatch race", uncertainty: "Not reproduced",
		recoveryActions: "Retried", recoveryOutcome: "Recovered", evidence: ["receipt-1"],
	};
	let prepared = false;
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)], dormant: [], selectedAgentId: "owner",
		reports: [{ report }], prepareSelection() { prepared = true; },
	});
	assert.match(harness.component!.render(80).join("\n"), /Attention Inbox/);
	assert.match(harness.component!.render(80).join("\n"), /REPORT.*Moderator/);
	harness.component!.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "open_report", reportId: report.reportId });
	assert.equal(prepared, true);

	const history = surfaceHarness(24);
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const historySelection = openAgentSelectorSurface(history.ui, {
		live: [agentStatus("owner", "Owner", null)], dormant: [], selectedAgentId: "owner",
		reports: [{ report }],
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	publish({ live: [agentStatus("owner", "Owner", null)], dormant: [], reports: [{ report, readAt: "2026-01-02T00:00:00Z" }] });
	assert.doesNotMatch(history.component!.render(80).join("\n"), /REPORT.*Moderator/);
	history.component!.handleInput?.("\t");
	history.component!.handleInput?.("\t");
	assert.match(history.component!.render(80).join("\n"), /│ History(?:\s|\x1b)/);
	assert.match(history.component!.render(80).join("\n"), /Read/);
	history.component!.handleInput?.("\r");
	assert.deepEqual(await historySelection, { kind: "open_report", reportId: report.reportId });
});

test("Shift Tab reaches report history and safely displays report summaries", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)], dormant: [], selectedAgentId: "owner",
		reports: [{ report: {
			reportId: "report", createdAt: "now", reporter: { agentId: "moderator", label: "Mod\x1b]52;c;attack\x07" },
			source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/report.jsonl" },
			symptom: "Safe\x1b[2J symptom", suspectedDefect: "Defect", uncertainty: "Unknown",
			recoveryActions: "None", recoveryOutcome: "Pending", evidence: ["ref"],
		} }],
	});
	harness.component!.handleInput?.("\x1b[Z");
	const rendered = harness.component!.render(80).join("\n");
	assert.match(rendered, /│ History(?:\s|\x1b)/);
	assert.doesNotMatch(rendered, /\x1b\]52|\x1b\[2J|attack/);
	harness.component!.handleInput?.("\x1b");
	await selection;
});

test("Reports pointer tab opens report summaries and keeps Owner available", async () => {
	const harness = surfaceHarness(24);
	const report = {
		reportId: "report", createdAt: "now", reporter: { agentId: "moderator", label: "Moderator" },
		source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/report.jsonl" },
		symptom: "Delivery stalled", suspectedDefect: "Race", uncertainty: "Unknown",
		recoveryActions: "Retried", recoveryOutcome: "Recovered", evidence: ["receipt"],
	};
	const click = (component: Component, label: string) => {
		const lines = component.render(80).map(stripTerminalSequences);
		const y = lines.findIndex((line) => line.includes(label));
		assert.ok(y >= 0, label);
		const x = lines[y]!.indexOf(label);
		component.handleMouse?.({
			type: "click", button: "left", x, y, screenX: x, screenY: y,
			width: 80, height: 24, shift: false, alt: false, ctrl: false,
		});
	};
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)], dormant: [], selectedAgentId: "owner",
		reports: [{ report, readAt: "later" }],
	});
	click(harness.component!, "Reports");
	const rendered = renderPanel(harness.component!, 80).join("\n");
	assert.match(rendered, /│ History(?:\s|\x1b)/);
	assert.doesNotMatch(rendered, /Attention Inbox|No dormant Agents/);
	click(harness.component!, "REPORT");
	assert.deepEqual(await selection, { kind: "open_report", reportId: "report" });

	const empty = surfaceHarness(24);
	const ownerSelection = openAgentSelectorSurface(empty.ui, {
		live: [agentStatus("owner", "Owner", null)], dormant: [], selectedAgentId: "owner",
	});
	// The Reports tab hides while empty.
	const emptyTabs = renderPanel(empty.component!, 80).find((line) => line.includes("Live")) ?? "";
	assert.doesNotMatch(emptyTabs, /Reports/);
	assert.doesNotMatch(renderPanel(empty.component!, 80).join("\n"), /History|No reports/);
	click(empty.component!, "Owner");
	assert.deepEqual(await ownerSelection, { kind: "select_agent", agentId: "owner" });
});

for (const tabKeys of [[], ["\t"], ["\x1b[Z"]]) {
	test("Owner footer is above help and reachable after list: " + JSON.stringify(tabKeys), async () => {
		const harness = surfaceHarness(24);
		const selection = openAgentSelectorSurface(harness.ui, {
			live: [agentStatus("owner", "Owner", null), agentStatus("child", "Child", "owner")],
			dormant: [dormantAgentStatus("sleeping", "Sleeping", "owner")], selectedAgentId: "child",
			reports: [{ readAt: "later", report: {
				reportId: "report", createdAt: "now", reporter: { agentId: "mod", label: "Moderator" },
				source: { agentId: "mod", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/report.jsonl" },
				symptom: "Stalled", suspectedDefect: "Race", uncertainty: "Unknown",
				recoveryActions: "None", recoveryOutcome: "Pending", evidence: [],
			} }],
		});
		const component = harness.component!;
		for (const key of tabKeys) component.handleInput?.(key);
		const lines = renderPanel(component, 80);
		const footer = lines.findIndex(line => line.includes("Go to Owner [o]"));
		assert.ok(footer > 0);
		assert.match(lines[footer + 1]!, /Tab views/);
		assert.equal(lines.filter(line => /Owner/.test(line)).length, 1);
		component.handleInput?.("j");
		assert.doesNotMatch(renderPanel(component, 80).join("\n"), /→ /);
		assert.equal(renderPanel(component, 80).findIndex(line => line.includes("Go to Owner [o]")), footer);
		component.handleInput?.("k");
		assert.match(renderPanel(component, 80).join("\n"), /→ /);
		component.handleInput?.("j");
		component.handleInput?.("\r");
		assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
	});
}

function clickLabel(component: Component, label: string): void {
	const lines = renderPanel(component, 80);
	const y = lines.findIndex(line => line.includes(label));
	assert.ok(y >= 0);
	const x = lines[y]!.indexOf(label);
	component.handleMouse?.({
		type: "click", button: "left", x, y, screenX: x, screenY: y,
		width: 80, height: 30, shift: false, alt: false, ctrl: false,
	});
}

for (const dormant of [false, true]) {
	test(`mounted participant label stays marked independently of focus and tab (dormant=${dormant})`, async () => {
		const harness = surfaceHarness(30, true);
		const builder = dormant
			? dormantAgentStatus("builder", "Builder", "owner")
			: agentStatus("builder", "Builder", "owner");
		const peer = dormant
			? dormantAgentStatus("peer", "Peer", "owner")
			: agentStatus("peer", "Peer", "owner");
		const selection = openAgentSelectorSurface(harness.ui, {
			live: [agentStatus("owner", "Owner", null), ...(dormant ? [] : [builder, peer])],
			dormant: dormant ? [builder, peer] : [],
			selectedAgentId: "builder",
		});
		const component = harness.component!;
		const markedRow = () => component.render(80).find(line => line.includes("Builder*")) ?? "";
		assert.match(markedRow(), /→ \x1b\[1mBuilder\*\x1b\[22m/);
		assert.match(markedRow(), /\x1b\[44m/);
		assert.match(stripTerminalSequences(markedRow()), dormant ? /dormant/ : /idle/);
		component.handleInput?.("j");
		assert.match(markedRow(), /\x1b\[1mBuilder\*\x1b\[22m/);
		assert.doesNotMatch(markedRow(), /→|\x1b\[44m/);
		assert.match(renderPanel(component, 80).join("\n"), /→ Peer/);
		assert.doesNotMatch(renderPanel(component, 80).join("\n"), /Peer\*|Owner\*/);
		component.handleInput?.("\t");
		assert.doesNotMatch(renderPanel(component, 80).join("\n"), /\*/);
		component.handleInput?.("\x1b[Z");
		assert.match(markedRow(), /\x1b\[1mBuilder\*\x1b\[22m/);
		component.handleInput?.("\x1b");
		assert.equal(await selection, undefined);
	});
}

test("mounted participant marker does not follow scope into breadcrumbs", async () => {
	const harness = surfaceHarness(30, true);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), agentStatus("builder", "Builder", "owner"),
			agentStatus("child", "Child", "builder")],
		dormant: [], selectedAgentId: "builder",
	});
	const component = harness.component!;
	component.handleInput?.("l");
	const nested = renderPanel(component, 80).join("\n");
	assert.match(nested, /Agents › Builder/);
	assert.doesNotMatch(nested, /\*/);
	component.handleInput?.("h");
	assert.match(renderPanel(component, 80).join("\n"), /→ Builder\*/);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("mounted Owner marks only its action label across all tabs and focus", async () => {
	const harness = surfaceHarness(30, true);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), agentStatus("builder", "Builder", "owner")],
		dormant: [], selectedAgentId: "owner",
	});
	const component = harness.component!;
	for (const key of ["", "j", "\t", "\t"]) {
		if (key) component.handleInput?.(key);
		const lines = component.render(80);
		assert.match(lines.join("\n"), /Go to \x1b\[1mOwner\*\x1b\[22m \[o\]/);
		assert.equal(stripTerminalSequences(lines.join("\n")).split("*").length - 1, 1);
	}
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

test("a Dormant Owner still opens the selector and remains the single Owner destination", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [],
		dormant: [
			dormantAgentStatus("owner", "Owner", null),
			dormantAgentStatus("worker", "Worker", "owner"),
		],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component, "the selector opens while the Owner Run is Dormant");

	const live = renderPanel(harness.component, 80).join("\n");
	assert.match(live, /Go to Owner\* \[o\]/);
	assert.doesNotMatch(live, /→ Owner/);

	harness.component.handleInput?.("\t");
	const dormant = renderPanel(harness.component, 80).join("\n");
	assert.match(dormant, /→ Worker/);
	assert.match(dormant, /Go to Owner\* \[o\]/);
	assert.doesNotMatch(dormant, /→ Owner/);

	harness.component.handleInput?.("o");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

for (const tab of ["live", "reports"] as const) {
	test(`m marks the selected report read in ${tab} without leaving the menu`, { timeout: 5_000 }, async () => {
		const harness = surfaceHarness(30);
		const reports = ["first", "second", "third"].map((id) => ({ report: {
			reportId: id, createdAt: "2026-01-01T00:00:00Z",
			reporter: { agentId: "moderator", label: id },
			source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/report.jsonl" },
			symptom: "Delivery stalled", suspectedDefect: "Dispatch race", uncertainty: "Unknown",
			recoveryActions: "Retried", recoveryOutcome: "Recovered", evidence: [],
		} }));
		let finish!: (reports: readonly import("../src/protocol/moderator-report.ts").ReportHistoryItem[]) => void;
		const marked: [string, boolean][] = [];
		const errors: unknown[] = [];
		let fail = true;
		let closed = false;
		const selection = openAgentSelectorSurface(harness.ui, {
			live: [agentStatus("owner", "Owner", null)], dormant: [], selectedAgentId: "owner", reports,
			setReportRead(reportId, read) {
				marked.push([reportId, read]);
				if (fail) throw new Error("Read failed");
				return new Promise((resolve) => { finish = resolve; });
			},
			onSelectionError(error) { errors.push(error); },
		}).then((result) => { closed = true; return result; });
		const component = harness.component!;
		if (tab === "reports") component.handleInput?.("\x1b[Z");
		component.handleInput?.("j");
		assert.match(component.render(80).join("\n"), /m Toggle read/);
		component.handleInput?.("m");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(errors.length, 1);
		assert.match(component.render(80).join("\n"), /→ REPORT · second/);
		fail = false;
		component.handleInput?.("m");
		component.handleInput?.("m");
		component.handleInput?.("\r");
		assert.deepEqual(marked, [["second", true], ["second", true]]);
		assert.equal(closed, false);
		finish(reports.map((item) => item.report.reportId === "second" ? { ...item, readAt: "2026-01-02T00:00:00Z" } : item));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(closed, false);
		const rendered = component.render(80).join("\n");
		if (tab === "live") {
			assert.doesNotMatch(rendered, /REPORT · second/);
			assert.match(rendered, /→ REPORT · third/);
		} else {
			assert.match(rendered, /→ REPORT · second.*Read/);
			assert.match(rendered, /m Toggle read/);
			component.handleInput?.("m");
			assert.deepEqual(marked, [["second", true], ["second", true], ["second", false]]);
			finish(reports);
			await new Promise((resolve) => setImmediate(resolve));
			assert.match(component.render(80).join("\n"), /→ REPORT · second.*Unread/);
			component.handleInput?.("\t");
			assert.match(component.render(80).join("\n"), /REPORT · second/);
			component.handleInput?.("\x1b[Z");
		}
		component.handleInput?.("\r");
		assert.deepEqual(await selection, { kind: "open_report", reportId: tab === "live" ? "third" : "second" });
	});
}

for (const terminalRows of [10, 24, 40]) {
	for (const populated of [false, true]) {
		test(`tab switching preserves panel height (rows=${terminalRows}, populated=${populated})`, { timeout: 5_000 }, async () => {
			const harness = surfaceHarness(terminalRows);
			const selection = openAgentSelectorSurface(harness.ui, {
				live: [agentStatus("owner", "Owner", null), ...(populated
					? Array.from({ length: 12 }, (_, index) => agentStatus(`live-${index}`, `Live ${index}`, "owner")) : [])],
				dormant: populated ? [dormantAgentStatus("sleeping", "Sleeping", "owner")] : [],
				humanAttention: populated ? [{ requestId: "decision", agentId: "live-0", agentLabel: "Live 0", question: "Choose" }] : [],
				selectedAgentId: "owner",
			});
			const component = harness.component!;
			const panels: string[][] = [];
			for (let tab = 0; tab < 3; tab += 1) {
				const panel = renderPanel(component, 80);
				panels.push(panel);
				assert.ok(panel.length <= Math.min(Math.floor(terminalRows * 0.9), terminalRows - 2));
				assert.match(panel[0]!, /^┌─+┐$/);
				assert.match(panel.at(-1)!, /^└─+┘$/);
				assert.match(panel.join("\n"), /Go to Owner/);
				component.handleInput?.("\t");
			}
			assert.deepEqual(panels.map(panel => panel.length), Array(3).fill(panels[0]!.length));
			if (populated && terminalRows === 40) {
				assert.equal(panels[0]!.filter(line => /→ DECIDE|  Live \d/.test(line)).length, 10);
			}
			component.handleInput?.("\x1b");
			assert.equal(await selection, undefined);
		});
	}
}

for (const readAt of [undefined, "2026-06-11T00:00:00Z"]) test(`linked incident uses report notification only (read=${!!readAt})`, async () => {
	const harness = surfaceHarness(30);
	const source = { kind: "runtime_diagnostic" as const, agentId: "owner", entryId: "incident-diagnostic", transcriptPath: "/tmp/owner.jsonl" };
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)], dormant: [], selectedAgentId: "owner",
		operationalAttention: [{
			trigger: { kind: "run_failure", agentId: "worker", runSequence: 1, obligations: { total: 0, sources: [] } },
			affectedAgents: [{ agentId: "worker", label: "Worker" }], diagnostics: [source], reportSource: source,
		}],
		reports: [{ readAt, report: {
			reportId: "incident-report", createdAt: "2026-06-11T00:00:00Z", source,
			symptom: "Recovery exhausted", suspectedDefect: "Unknown", uncertainty: "Unknown",
			recoveryActions: "Retried", recoveryOutcome: "Failed", evidence: ["diagnostic"],
		} }],
	});
	const rendered = harness.component!.render(100).join("\n");
	assert.doesNotMatch(rendered, /ATTENTION/);
	assert.match(rendered, /Operational incident unresolved · live status/);
	if (readAt) assert.doesNotMatch(rendered, /REPORT/);
	else assert.match(rendered, /REPORT · Runtime/);
	harness.component!.handleInput?.("\x1b");
	await selection;
});

test("runtime report read toggle removes only inbox notification and preserves history and live status", async () => {
	const harness = surfaceHarness(30);
	const report = {
		reportId: "failure", createdAt: "2026-06-11T00:00:00Z",
		source: { kind: "runtime_diagnostic" as const, agentId: "owner", entryId: "diagnostic", transcriptPath: "/tmp/owner.jsonl" },
		symptom: "Inspection blocked", suspectedDefect: "Unknown", uncertainty: "No incident established",
		recoveryActions: "None", recoveryOutcome: "Unknown", evidence: ["diagnostic"],
	};
	const marked: boolean[] = [];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)], dormant: [], selectedAgentId: "owner",
		operationalAttention: [{ trigger: { kind: "moderation_unavailable" }, affectedAgents: [], diagnostics: [] }], reports: [{ report }],
		setReportRead(_id, read) { marked.push(read); return [{ report, ...(read ? { readAt: report.createdAt } : {}) }]; },
	});
	const component = harness.component!;
	assert.match(component.render(100).join("\n"), /REPORT · Runtime/);
	assert.doesNotMatch(component.render(100).join("\n"), /ATTENTION/);
	component.handleInput?.("m"); await new Promise(resolve => setImmediate(resolve));
	assert.doesNotMatch(component.render(100).join("\n"), /REPORT/);
	assert.match(component.render(100).join("\n"), /Moderation Unavailable · live status/);
	component.handleInput?.("\x1b[Z");
	assert.match(component.render(100).join("\n"), /REPORT · Runtime.*Read/);
	component.handleInput?.("m"); await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(marked, [true, false]);
	component.handleInput?.("\t");
	assert.match(component.render(100).join("\n"), /REPORT · Runtime.*Unread/);
	component.handleInput?.("k");
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "open_report", reportId: "failure" });
});

test("quarantined tab stays hidden while empty and Tab skips it", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [dormantAgentStatus("sleeper", "Sleeper", "owner")],
		quarantined: [],
		quarantinedCandidateCount: 0,
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);
	const tabs = renderPanel(harness.component, 80).find((line) => line.includes("Live")) ?? "";
	assert.doesNotMatch(tabs, /Quarantined/);
	assert.doesNotMatch(tabs, /Reports/);
	for (let press = 0; press < 2; press += 1) {
		harness.component.handleInput?.("\t");
		assert.doesNotMatch(renderPanel(harness.component, 80).join("\n"), /Quarantined/);
		assert.doesNotMatch(renderPanel(harness.component, 80).find((line) => line.includes("Live")) ?? "", /Reports/);
	}
	assert.match(renderPanel(harness.component, 80).join("\n"), /No live Agents/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("reports tab stays hidden while empty and Tab skips it", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [dormantAgentStatus("sleeper", "Sleeper", "owner")],
		reports: [],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);
	const tabs = renderPanel(harness.component, 80).find((line) => line.includes("Live")) ?? "";
	assert.doesNotMatch(tabs, /Reports/);
	for (let press = 0; press < 2; press += 1) {
		harness.component.handleInput?.("\t");
		assert.doesNotMatch(renderPanel(harness.component, 80).find((line) => line.includes("Live")) ?? "", /Reports/);
	}
	assert.match(renderPanel(harness.component, 80).join("\n"), /No live Agents/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("quarantined tab lists excluded identities as informational rows", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		quarantined: ["zx-9", "ab-1"],
		quarantinedCandidateCount: 2,
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	const component = harness.component!;
	assert.match(renderPanel(component, 80).join("\n"), /Quarantined/);
	assert.doesNotMatch(renderPanel(component, 80).find((line) => line.includes("Live")) ?? "", /Reports/);
	component.handleInput?.("\t");
	component.handleInput?.("\t");
	const quarantined = renderPanel(component, 80).join("\n");
	assert.match(quarantined, /Quarantined/);
	assert.match(quarantined, /zx-9/);
	assert.match(quarantined, /ab-1/);
	assert.match(quarantined, /transcript excluded from recovery/);
	assert.doesNotMatch(quarantined, /Attention Inbox/);
	component.handleInput?.("\r");
	assert.equal(harness.resolved, false);
	component.handleInput?.("l");
	component.handleInput?.("h");
	assert.match(renderPanel(component, 80).join("\n"), /zx-9/);
	clickLabel(component, "Dormant");
	assert.doesNotMatch(renderPanel(component, 80).join("\n"), /zx-9/);
	clickLabel(component, "Quarantined");
	assert.match(renderPanel(component, 80).join("\n"), /zx-9/);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("quarantined overflow counts candidates without recoverable IDs", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		quarantined: ["zx-9"],
		quarantinedCandidateCount: 3,
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	const component = harness.component!;
	component.handleInput?.("\t");
	component.handleInput?.("\t");
	assert.match(renderPanel(component, 80).join("\n"), /zx-9/);
	assert.match(renderPanel(component, 80).join("\n"), /unreadable candidates/);
	component.handleInput?.("j");
	const rendered = renderPanel(component, 80).join("\n");
	assert.match(rendered, /2 candidates without recoverable ID/);
	component.handleInput?.("\r");
	assert.equal(harness.resolved, false);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("a quarantine with only unreadable candidates still shows its tab", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		quarantined: [],
		quarantinedCandidateCount: 3,
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	const component = harness.component!;
	component.handleInput?.("\t");
	component.handleInput?.("\t");
	assert.match(renderPanel(component, 80).join("\n"), /3 candidates without recoverable ID/);
	component.handleInput?.("\r");
	assert.equal(harness.resolved, false);
	clickLabel(component, "Dormant");
	clickLabel(component, "Quarantined");
	assert.match(renderPanel(component, 80).join("\n"), /3 unreadable candidates/);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("a live refresh publishes quarantined identities to the selector", async () => {
	const harness = surfaceHarness(30);
	const owner = agentStatus("owner", "Owner", null);
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner], dormant: [], selectedAgentId: "owner",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	await Promise.resolve();
	assert.doesNotMatch(renderPanel(harness.component!, 80).join("\n"), /Quarantined/);
	publish({ live: [owner], dormant: [], quarantined: ["zx-9"], quarantinedCandidateCount: 1 });
	assert.match(renderPanel(harness.component!, 80).join("\n"), /Quarantined/);
	harness.component!.handleInput?.("\t");
	harness.component!.handleInput?.("\t");
	assert.match(renderPanel(harness.component!, 80).join("\n"), /zx-9/);
	harness.component!.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});
