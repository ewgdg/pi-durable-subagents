import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createTestOwnerHost } from "./support/pi-host.ts";

const DELIVERY_TYPE = "agent-coordination.conformance-delivery";
const DELIVERY_CONTENT = "model-visible conformance Delivery";
const DELIVERY_DETAILS = "local-details-must-not-reach-model";
const IDLE_DELIVERY_TYPE = "agent-coordination.idle-conformance-delivery";
const BRANCH_MARKER_TYPE = "agent-coordination.conformance-branch-selection";

type Snapshot = Readonly<{
	hook: string;
	subject?: string;
	entries: readonly string[];
	toolStarts: readonly string[];
}>;

test("the concrete Pi host satisfies transcript, Delivery, compaction, and branch semantics", async (t) => {
	const snapshots: Snapshot[] = [];
	const toolStarts: string[] = [];
	const completionOrder: string[] = [];
	let releaseSlowTool!: () => void;
	const slowToolGate = new Promise<void>((resolve) => {
		releaseSlowTool = resolve;
	});
	let deliveryQueued = false;
	let modelContextJson = "";
	let compactionObserved = false;
	let branchMarker: { id: string; parentId: string | null } | undefined;
	const extension: ExtensionFactory = (pi) => {
		const parameters = Type.Object({}, { additionalProperties: false });
		pi.registerTool({
			name: "slow_conformance_tool",
			label: "Slow conformance tool",
			description: "Complete after the paired fast tool.",
			executionMode: "parallel",
			parameters,
			async execute() {
				toolStarts.push("slow");
				await slowToolGate;
				completionOrder.push("slow");
				return {
					content: [{ type: "text", text: "slow result" }],
					details: undefined,
				};
			},
		});
		pi.registerTool({
			name: "fast_conformance_tool",
			label: "Fast conformance tool",
			description: "Release the paired slow tool after completing first.",
			executionMode: "parallel",
			parameters,
			async execute() {
				toolStarts.push("fast");
				completionOrder.push("fast");
				releaseSlowTool();
				return {
					content: [{ type: "text", text: "fast result" }],
					details: undefined,
				};
			},
		});
		pi.on("message_end", (event, ctx) => {
			const subject = event.message.role === "assistant"
				? "assistant"
				: event.message.role === "toolResult"
					? event.message.toolCallId
					: event.message.role;
			record(snapshots, toolStarts, "message_end", ctx, subject);
		});
		pi.on("tool_call", (event, ctx) => {
			record(snapshots, toolStarts, "tool_call", ctx, event.toolCallId);
			if (deliveryQueued) return;
			deliveryQueued = true;
			pi.sendMessage(
				{
					customType: DELIVERY_TYPE,
					content: DELIVERY_CONTENT,
					display: false,
					details: { sentinel: DELIVERY_DETAILS },
				},
				{ deliverAs: "steer" },
			);
			record(snapshots, toolStarts, "delivery_enqueued", ctx);
		});
		pi.on("tool_result", (event, ctx) => {
			record(snapshots, toolStarts, "tool_result", ctx, event.toolCallId);
		});
		pi.on("turn_end", (_event, ctx) => {
			record(snapshots, toolStarts, "turn_end", ctx);
		});
		pi.on("agent_settled", (_event, ctx) => {
			record(snapshots, toolStarts, "agent_settled", ctx);
		});
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "Conformance compaction summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { source: "host-conformance" },
			},
		}));
		pi.on("session_compact", (_event, ctx) => {
			compactionObserved = ctx.sessionManager.getLeafEntry()?.type === "compaction";
		});
		pi.on("session_tree", (event, ctx) => {
			pi.appendEntry(BRANCH_MARKER_TYPE, { selectedLeafId: event.newLeafId });
			const marker = ctx.sessionManager.getLeafEntry();
			if (marker?.type === "custom" && marker.customType === BRANCH_MARKER_TYPE) {
				branchMarker = { id: marker.id, parentId: marker.parentId };
			}
		});
	};
	const host = await createTestOwnerHost(t, extension, {
		persistent: true,
		settings: {
			compaction: {
				enabled: true,
				reserveTokens: 64,
				keepRecentTokens: 24,
			},
		},
	});
	host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("slow_conformance_tool", {}, { id: "slow-call" }),
				fauxToolCall("fast_conformance_tool", {}, { id: "fast-call" }),
			],
			{ stopReason: "toolUse" },
		),
		(context) => {
			modelContextJson = JSON.stringify(context);
			return fauxAssistantMessage("Conformance Delivery processed.");
		},
	]);

	await host.session.prompt("Run the host behavior conformance turn.");
	await host.session.waitForIdle();

	const assistantEnd = snapshots.find(
		(snapshot) => snapshot.hook === "message_end" && snapshot.subject === "assistant",
	);
	assert.ok(assistantEnd);
	assert.equal(assistantEnd.entries.some((entry) => entry === "assistant:slow-call,fast-call"), false);
	const toolCalls = snapshots.filter((snapshot) => snapshot.hook === "tool_call");
	assert.equal(toolCalls.length, 2);
	assert.equal(
		toolCalls.every(
			(snapshot) =>
				snapshot.entries.includes("assistant:slow-call,fast-call") &&
				snapshot.toolStarts.length === 0,
		),
		true,
	);
	const toolResults = snapshots.filter((snapshot) => snapshot.hook === "tool_result");
	assert.equal(
		toolResults.every(
			(snapshot) => !snapshot.entries.includes(`toolResult:${snapshot.subject}`),
		),
		true,
	);
	assert.deepEqual(completionOrder, ["fast", "slow"]);
	const resultTurn = snapshots.find(
		(snapshot) =>
			snapshot.hook === "turn_end" &&
			snapshot.entries.filter((entry) => entry.startsWith("toolResult:")).length === 2,
	);
	assert.ok(resultTurn);
	assert.deepEqual(
		resultTurn.entries.filter((entry) => entry.startsWith("toolResult:")),
		["toolResult:slow-call", "toolResult:fast-call"],
	);
	const deliveryEnqueued = snapshots.find(({ hook }) => hook === "delivery_enqueued");
	assert.ok(deliveryEnqueued);
	assert.equal(deliveryEnqueued.entries.includes(`custom:${DELIVERY_TYPE}`), false);
	assert.equal(modelContextJson.includes(DELIVERY_CONTENT), true);
	assert.equal(modelContextJson.includes(DELIVERY_DETAILS), false);
	assert.equal(snapshots.at(-1)?.hook, "agent_settled");

	await host.session.sendCustomMessage({
		customType: IDLE_DELIVERY_TYPE,
		content: "Idle Delivery survives normal restart.",
		display: false,
		details: {},
	});
	const sessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(sessionFile);
	assert.equal(
		SessionManager.open(sessionFile).getLeafEntry()?.type,
		"custom_message",
	);

	await host.session.compact();
	assert.equal(compactionObserved, true);
	const compactionId = host.session.sessionManager.getLeafId();
	assert.ok(compactionId);
	const assistantEntry = host.session.sessionManager.getEntries().find(
		(entry) => labelEntry(entry) === "assistant:slow-call,fast-call",
	);
	assert.ok(assistantEntry);
	await host.session.navigateTree(assistantEntry.id, { summarize: false });
	assert.ok(branchMarker);
	const marker = branchMarker as { id: string; parentId: string | null };
	assert.equal(marker.parentId, assistantEntry.id);
	assert.equal(
		host.session.sessionManager.getEntries().some(({ id }) => id === compactionId),
		true,
	);
	assert.equal(
		host.session.sessionManager.getBranch().some(({ id }) => id === compactionId),
		false,
	);
	const reopened = SessionManager.open(sessionFile);
	assert.equal(reopened.getLeafId(), marker.id);
	assert.equal(reopened.getLeafEntry()?.parentId, assistantEntry.id);
	await host.runtime.dispose();
});

function record(
	snapshots: Snapshot[],
	toolStarts: readonly string[],
	hook: string,
	ctx: ExtensionContext,
	subject?: string,
): void {
	snapshots.push({
		hook,
		...(subject === undefined ? {} : { subject }),
		entries: ctx.sessionManager.getEntries().map(labelEntry),
		toolStarts: [...toolStarts],
	});
}

function labelEntry(entry: SessionEntry): string {
	if (entry.type === "message") {
		if (entry.message.role === "assistant") {
			const toolCallIds = entry.message.content.flatMap((part) =>
				part.type === "toolCall" ? [part.id] : [],
			);
			return `assistant:${toolCallIds.join(",") || "text"}`;
		}
		if (entry.message.role === "toolResult") {
			return `toolResult:${entry.message.toolCallId}`;
		}
		return entry.message.role;
	}
	if (entry.type === "custom_message") return `custom:${entry.customType}`;
	return entry.type;
}
