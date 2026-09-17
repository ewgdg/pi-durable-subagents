import assert from "node:assert/strict";
import test from "node:test";

import {
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";

import {
	createAgentBoundExtension,
	createModeratorBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import type {
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../src/coordination/workflow-coordinator.ts";
import {
	renderAgentControlCall,
	renderAgentControlResult,
	renderAgentObserveCall,
	renderAgentObserveResult,
} from "../src/tools/coordination-renderers.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const ordinaryTools = [
	"agent_control",
	"agent_message",
	"agent_observe",
	"agent_spawn",
	"agent_wait",
	"ask_user",
] as const;
const moderatorTools = [
	"agent_control",
	"agent_message",
	"agent_observe",
	"agent_wait",
	"ask_user",
	"moderator_control",
	"report_to_user",
] as const;
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("child session surfaces cancel native session replacement", async (t) => {
	const unavailableView = () => {
		throw new Error("Child session command conformance does not execute coordination behavior");
	};
	const extension = createAgentBoundExtension(
		unavailableView as () => OrdinaryAgentCoordinatorView,
	);
	const host = await createTestOwnerHost(t, extension, { persistent: true });
	const sessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(sessionFile);
	assert.deepEqual(
		await host.runtime.switchSession(sessionFile),
		{ cancelled: true },
	);
	assert.deepEqual(await host.runtime.fork("unused-entry"), { cancelled: true });
	assert.deepEqual(host.ui.notifications.slice(-2), [
		{
			message: "Return to Owner before replacing or forking the native session.",
			type: "error",
		},
		{
			message: "Return to Owner before replacing or forking the native session.",
			type: "error",
		},
	]);
	await host.runtime.dispose();
});

test("role-bound extensions expose strict sequential tools with compact native renderers", async (t) => {
	for (const role of ["ordinary", "moderator"] as const) {
		await t.test(role, async (t) => {
			const unavailableView = () => {
				throw new Error("Role conformance does not execute coordination behavior");
			};
			const extension = role === "ordinary"
				? createAgentBoundExtension(
					unavailableView as () => OrdinaryAgentCoordinatorView,
				)
				: createModeratorBoundExtension(
					unavailableView as () => ModeratorAgentCoordinatorView,
				);
			const host = await createTestOwnerHost(t, extension, {
				processVisibleModel: false,
			});
			const expectedTools = role === "ordinary" ? ordinaryTools : moderatorTools;
			assert.deepEqual(host.session.getActiveToolNames().sort(), [...expectedTools].sort());
			for (const toolName of expectedTools) {
				const tool = host.session.getToolDefinition(toolName);
				assert.ok(tool, toolName);
				assert.equal(tool.executionMode, "sequential", toolName);
				assert.equal(typeof tool.renderCall, "function", toolName);
				assert.equal(typeof tool.renderResult, "function", toolName);
				assertProviderCompatibleObjectSchema(tool.parameters, toolName);
			}
			assert.equal(
				host.services.resourceLoader.getExtensions().extensions.length,
				1,
			);
			await host.runtime.dispose();
		});
	}
});

test("coordination renderers keep routine receipts compact", async (t) => {
	const rendererView = {
		agentLabel: (agentId: string) =>
			agentId === "child-agent" ? "Researcher" : undefined,
	};
	const ordinaryHost = await createTestOwnerHost(t,
		createAgentBoundExtension(
			() => rendererView as unknown as OrdinaryAgentCoordinatorView,
		),
	);
	const moderatorHost = await createTestOwnerHost(t,
		createModeratorBoundExtension(
			() => rendererView as unknown as ModeratorAgentCoordinatorView,
		),
	);
	const cases = [
		{
			host: ordinaryHost,
			toolName: "agent_observe",
			args: { operation: "status", agentId: "child-agent" },
			details: {
				agentId: "child-agent",
				label: "Researcher",
				run: {
					phase: "live",
					work: "settled",
					attention: "none",
					retentionReasons: [],
				},
			},
			callLines: 1,
			collapsedLines: 2,
			summary: /Researcher · ld-agent.*idle/s,
			expandedDetail: /Researcher/,
		},
		{
			host: ordinaryHost,
			toolName: "agent_observe",
			args: {
				operation: "search",
				scope: "direct_children",
				query: "review",
				phase: "dormant",
				limit: 20,
			},
			details: { matches: [{}, {}], hasMore: true },
			callLines: 1,
			collapsedLines: 1,
			summary: /2 matches · more/s,
			expandedDetail: /hasMore/,
		},
		{
			host: ordinaryHost,
			toolName: "agent_control",
			args: { operation: "interrupt", agentId: "child-agent" },
			details: { agentId: "child-agent", disposition: "held" },
			callLines: 1,
			collapsedLines: 1,
			summary: /held .* Researcher · ld-agent/,
			expandedDetail: /disposition/,
		},
		{
			host: moderatorHost,
			toolName: "moderator_control",
			args: {
				operation: "resolve",
				summary: "Progress restored.",
				rationale: "The blocked Run can continue.",
			},
			details: { disposition: "resolved" },
			callLines: 1,
			collapsedLines: 1,
			summary: /resolved/,
			expandedDetail: /disposition/,
		},
	] as const;

	for (const sample of cases) {
		const tool = sample.host.session.getToolDefinition(sample.toolName);
		assert.ok(tool?.renderCall, sample.toolName);
		assert.ok(tool.renderResult, sample.toolName);
		const context = {
			args: sample.args,
			toolCallId: `render-${sample.toolName}`,
			invalidate() {},
			lastComponent: undefined,
			state: {},
			cwd: sample.host.cwd,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
			executionStarted: true,
		};
		const call = tool.renderCall(sample.args, plainTheme, context).render(120);
		assert.equal(call.length, sample.callLines, sample.toolName);
		const collapsed = tool.renderResult(
			{
				content: [{ type: "text", text: JSON.stringify(sample.details) }],
				details: sample.details,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			context,
		).render(120);
		assert.equal(collapsed.length, sample.collapsedLines, sample.toolName);
		assert.match(collapsed.join("\n"), sample.summary, sample.toolName);
		assert.equal(collapsed.join("\n").includes("{"), false, sample.toolName);

		const expanded = tool.renderResult(
			{
				content: [{ type: "text", text: JSON.stringify(sample.details) }],
				details: sample.details,
			},
			{ expanded: true, isPartial: false },
			plainTheme,
			context,
		).render(120).join("\n");
		assert.match(expanded, sample.expandedDetail, sample.toolName);
	}

	await ordinaryHost.runtime.dispose();
	await moderatorHost.runtime.dispose();
});

test("Agent Observe rendering consistently shows labels with compact identities", () => {
	const dimmed: string[] = [];
	const trackingTheme = {
		fg(color: string, text: string) {
			if (color === "dim") dimmed.push(text);
			return text;
		},
		bold: (text: string) => text,
	} as unknown as Theme;
	const agentId = "019fa1ff-6e95-761e-b4ce-7415983c81e3";
	const resolveAgentLabel = (candidateAgentId: string) =>
		candidateAgentId === agentId ? "Researcher" : undefined;
	const details = {
		agentId,
		label: "Researcher",
		run: {
			phase: "live" as const,
			work: "settled" as const,
			attention: "none" as const,
			retentionReasons: [],
		},
	};
	const explicitArgs = { operation: "status" as const, agentId };
	const call = renderAgentObserveCall(
		explicitArgs,
		trackingTheme,
		resolveAgentLabel,
	)
		.render(120)
		.map((line) => line.trimEnd());
	assert.deepEqual(call, ["observe status · Researcher · 983c81e3"]);
	assert.ok(dimmed.includes("Researcher · 983c81e3"));

	const result = {
		content: [{ type: "text" as const, text: JSON.stringify(details) }],
		details,
	};
	const explicitResult = renderAgentObserveResult(
		result,
		{ expanded: false, isPartial: false },
		trackingTheme,
		{ args: explicitArgs },
	).render(120).map((line) => line.trimEnd());
	assert.deepEqual(explicitResult, ["Researcher · 983c81e3", "idle"]);
	const expandedResult = renderAgentObserveResult(
		result,
		{ expanded: true, isPartial: false },
		trackingTheme,
		{ args: explicitArgs },
	).render(160).join("\n");
	assert.match(expandedResult, new RegExp(`Researcher · ${agentId}`));

	const selfResult = renderAgentObserveResult(
		result,
		{ expanded: false, isPartial: false },
		trackingTheme,
		{ args: { operation: "status" } },
	).render(120).map((line) => line.trimEnd());
	assert.deepEqual(selfResult, ["Researcher · 983c81e3", "idle"]);
});

test("Agent Control rendering shows compact identities while collapsed and full ones on expansion", () => {
	const agentId = "019fa1ff-6e95-761e-b4ce-7415983c81e3";
	const resolveAgentLabel = (candidateAgentId: string) =>
		candidateAgentId === agentId ? "Researcher" : undefined;
	const args = { operation: "interrupt" as const, agentId };
	const call = renderAgentControlCall(args, plainTheme, resolveAgentLabel)
		.render(120)
		.join("\n");
	assert.match(call, /control interrupt · Researcher · 983c81e3/);
	assert.doesNotMatch(call, new RegExp(agentId));
	assert.match(
		renderAgentControlCall(args, plainTheme, resolveAgentLabel, true).render(160).join("\n"),
		new RegExp(`control interrupt · Researcher · ${agentId}`),
	);

	const result = renderAgentControlResult(
		{
			content: [{ type: "text", text: "held" }],
			details: { agentId, disposition: "held" },
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		resolveAgentLabel,
	).render(120).join("\n");
	assert.match(result, /held · Researcher · 983c81e3/);
	assert.doesNotMatch(result, new RegExp(agentId));

	const expandedResult = renderAgentControlResult(
		{
			content: [{ type: "text", text: "held" }],
			details: { agentId, disposition: "held" },
		},
		{ expanded: true, isPartial: false },
		plainTheme,
		resolveAgentLabel,
	).render(160).join("\n");
	assert.match(expandedResult, new RegExp(`held · Researcher · ${agentId}`));
});

test("Agent Control renders a sent Resume receipt in the Message receipt language", () => {
	const colors: Array<[string, string]> = [];
	const trackingTheme = {
		fg(color: string, text: string) {
			colors.push([color, text]);
			return text;
		},
		bold: (text: string) => text,
	} as unknown as Theme;
	const agentId = "019fa1ff-6e95-761e-b4ce-7415983c81e3";
	const rendered = renderAgentControlResult(
		{
			content: [{ type: "text", text: "sent" }],
			details: { agentId, messageId: "resume-message", messageStatus: "sent" },
		},
		{ expanded: false, isPartial: false },
		trackingTheme,
		() => "Researcher",
	).render(120).join("\n");

	assert.match(rendered, /sent · Researcher · 983c81e3/);
	assert.ok(colors.some(([color, text]) => color === "success" && text === "sent"));
});

test("Human Request owns a transcript-native question and Answer shell", async (t) => {
	initTheme("dark");
	const unavailableView = () => {
		throw new Error("Renderer conformance does not execute coordination behavior");
	};
	const host = await createTestOwnerHost(t,
		createAgentBoundExtension(
			unavailableView as () => OrdinaryAgentCoordinatorView,
		),
	);
	const tool = host.session.getToolDefinition("ask_user");
	assert.ok(tool?.renderCall);
	assert.ok(tool.renderResult);
	assert.equal(tool.renderShell, "self");
	const args = { question: "Choose the **authoritative** boundary." };
	const pendingContext = {
		args,
		toolCallId: "render-ask-user",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: host.cwd,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		showImages: false,
		isError: false,
		executionStarted: true,
	};
	const waiting = tool.renderCall(args, plainTheme, pendingContext).render(60).join("\n");
	assert.match(waiting, /\[Ask User\].*waiting/s);
	assert.match(waiting, /Choose the authoritative boundary\./);

	const answer = { requestId: "human-request", answer: "Keep native Pi." };
	const terminalContext = { ...pendingContext, isPartial: false };
	const answeredCall = tool.renderCall(args, plainTheme, terminalContext).render(60).join("\n");
	assert.doesNotMatch(answeredCall, /waiting/);
	const answeredResult = tool.renderResult(
		{
			content: [{ type: "text", text: JSON.stringify(answer) }],
			details: answer,
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		terminalContext,
	).render(60).join("\n");
	assert.match(answeredResult, /\[Answer\]/);
	assert.match(answeredResult, /Keep native Pi\./);

	const interrupted = tool.renderResult(
		{
			content: [{ type: "text", text: "Exact Run was fenced." }],
			details: undefined,
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		{ ...terminalContext, isError: true },
	).render(60).join("\n");
	assert.match(interrupted, /\[Interrupted\]/);
	assert.match(interrupted, /Exact Run was fenced\./);

	await host.runtime.dispose();
});

function assertProviderCompatibleObjectSchema(schema: unknown, toolName: string): void {
	assert.ok(typeof schema === "object" && schema !== null, toolName);
	const record = schema as {
		type?: unknown;
		additionalProperties?: unknown;
		anyOf?: Array<{ additionalProperties?: unknown }>;
	};
	assert.equal(record.type, "object", toolName);
	const variants = record.anyOf ?? [record];
	assert.ok(variants.length > 0, toolName);
	for (const variant of variants) {
		assert.equal(variant.additionalProperties, false, toolName);
	}
}

test("report publication failure remains visible instead of claiming pending or retained", async (t) => {
	const host = await createTestOwnerHost(t, createModeratorBoundExtension(() => ({} as ModeratorAgentCoordinatorView)));
	const tool = host.session.getToolDefinition("report_to_user");
	assert.ok(tool?.renderResult);
	const lines = tool.renderResult({
		content: [{ type: "text", text: "Report persistence failed" }], details: undefined,
	}, { expanded: false, isPartial: false }, plainTheme, {
		args: {}, toolCallId: "report-failure", invalidate() {}, lastComponent: undefined,
		state: {}, cwd: host.cwd, argsComplete: true, isPartial: false, expanded: false,
		showImages: false, isError: true, executionStarted: true,
	}).render(120);
	assert.match(lines.join("\n"), /Report persistence failed/);
	assert.doesNotMatch(lines.join("\n"), /Report retained|Report pending/);
	await host.runtime.dispose();
});

test("Moderator report guidance requires current exact primary evidence", async (t) => {
	const host = await createTestOwnerHost(t, createModeratorBoundExtension(() => ({} as ModeratorAgentCoordinatorView)));
	const guidance = host.session.getToolDefinition("report_to_user")?.promptGuidelines?.join("\n") ?? "";
	assert.match(guidance, /exact toolCallId/);
	assert.match(guidance, /matching toolResult/);
	assert.match(guidance, /current physical transcript tail/);
	assert.match(guidance, /inspectedThrough.*earlier observation/);
	assert.match(guidance, /unverified.*unavailable/);
	await host.runtime.dispose();
});
