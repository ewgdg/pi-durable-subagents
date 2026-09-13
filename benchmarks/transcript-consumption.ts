import { requestHistory } from "../tests/support/request-history.ts";
import { MessageCoordinator } from "../src/coordination/messages.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
/** Run with node --expose-gc benchmarks/transcript-consumption.ts. Uses /tmp copies only. */
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	transcriptFromSessionFile,
	transcriptFromSessionManager,
} from "../src/pi-integration/session-manager-transcript.ts";
import { findAuthoredRequestSources } from "../src/protocol/request-resolution.ts";
import { inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import type { AgentTranscript, TranscriptDiagnostics } from "../src/transcript/agent-transcript.ts";

const HISTORY_SIZES = [2_000, 20_000];
const BACKLOG_ENTRIES = 10_000;
const UNCHANGED_READS = 100;
const results = [];
// Keep earlier cases alive so later forced collections do not skew their heap deltas.
const retainedInputs: unknown[] = [];
for (const size of HISTORY_SIZES) {
	for (const role of ["Owner", "Agent"] as const) {
		const root = await mkdtemp(join(tmpdir(), "pi-transcript-benchmark-"));
		const file = join(root, "history.jsonl");
		const manager = SessionManager.inMemory(root, { id: "benchmark" });
		manager.appendCustomEntry("agent-coordination.identity", { agentId: "benchmark" });
		const history = Array.from({ length: size }, (_, i) =>
			entry(i, i ? `history-${i - 1}` : manager.getLeafId()),
		);
		await writeFile(
			file,
			`${[manager.getHeader(), ...manager.getEntries(), ...history].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		const local = role === "Owner" ? SessionManager.open(file) : undefined;
		global.gc?.();
		const initialHeap = process.memoryUsage().heapUsed;
		const transcript = local
			? transcriptFromSessionManager(local)
			: transcriptFromSessionFile(file);
		retainedInputs.push({ local, transcript });
		const localEnumeration = local
			? await measure(async () => {
					for (let i = 0; i < UNCHANGED_READS; i++) local.getEntries();
				})
			: undefined;
		const reconstruction = await measure(async () => {
			await transcript.refresh();
			query(transcript);
		});
		global.gc?.();
		const retainedHeapBytes = process.memoryUsage().heapUsed - initialHeap;
		const before = transcript.diagnostics()!;
		const unchanged = await measure(async () => {
			for (let i = 0; i < UNCHANGED_READS; i++) query(transcript);
		});
		const unchangedWork = delta(before, transcript.diagnostics()!);
		global.gc?.();
		const unchangedHeapGrowthBytes =
			process.memoryUsage().heapUsed - initialHeap - retainedHeapBytes;
		await append(1, size);
		const beforeAppend = transcript.diagnostics()!;
		const appendOne = await measure(async () => {
			await transcript.refresh();
			query(transcript);
		});
		const appendWork = delta(beforeAppend, transcript.diagnostics()!);
		await append(BACKLOG_ENTRIES, size + 1);
		const beforeBacklog = transcript.diagnostics()!;
		const backlog = await measure(async () => {
			await transcript.refresh();
			query(transcript);
		});
		results.push({
			role,
			historyEntries: size,
			reconstruction,
			localEnumeration,
			retainedHeapBytes,
			unchangedHeapGrowthBytes,
			unchanged,
			unchangedWork,
			appendOne,
			appendWork,
			backlog,
			backlogWork: delta(beforeBacklog, transcript.diagnostics()!),
		});

		async function append(count: number, offset: number) {
			if (local) {
				for (let i = 0; i < count; i++) {
					const next = entry(offset + i, local.getLeafId());
					if (next.type === "message") local.appendMessage(next.message);
					else local.appendCustomEntry(next.customType, next.data);
				}
			} else {
				await appendFile(
					file,
					`${Array.from({ length: count }, (_, i) => JSON.stringify(entry(offset + i, `history-${offset + i - 1}`))).join("\n")}\n`,
				);
			}
		}
	}
}
const relationships = [];
for (const settledRequests of [200, 2_000]) {
	const history = requestHistory();
	for (let i = 0; i < settledRequests; i++) history.answer(history.request());
	const messages = new MessageCoordinator({
		agents: history.agents,
		workflowPolicy: new WorkflowPolicyStore(),
		isShuttingDown: () => false,
	});
	retainedInputs.push({ history, messages });
	global.gc?.();
	const initialHeap = process.memoryUsage().heapUsed;
	const reconstruction = await measure(() => messages.refreshTranscriptFacts());
	global.gc?.();
	const retainedHeapBytes = process.memoryUsage().heapUsed - initialHeap;
	const before = [...history.agents.values()].map((a) => a.transcript.diagnostics()!);
	const unchanged = await measure(async () => {
		for (let i = 0; i < UNCHANGED_READS; i++) {
			await messages.refreshTranscriptFacts();
			if (messages.outstandingRequestIdsFor(history.requester.record).length)
				throw new Error("Unexpected outstanding Request");
		}
	});
	const unchangedWork = [...history.agents.values()].map((a, i) =>
		delta(before[i]!, a.transcript.diagnostics()!),
	);
	history.request();
	const appendRequest = await measure(async () => {
		await messages.refreshTranscriptFacts();
		if (messages.outstandingRequestIdsFor(history.requester.record).length !== 1)
			throw new Error("Missing outstanding Request");
	});
	for (let i = 0; i < 2_000; i++) history.answer(history.request());
	const backlog = await measure(() => messages.refreshTranscriptFacts());
	relationships.push({
		settledRequests,
		reconstruction,
		retainedHeapBytes,
		unchanged,
		unchangedWork,
		appendRequest,
		backlog,
	});
}
console.log(
	JSON.stringify(
		{ unchangedReads: UNCHANGED_READS, backlogEntries: BACKLOG_ENTRIES, results, relationships },
		null,
		2,
	),
);

function entry(index: number, parentId: string | null) {
	if (index % 50 === 0)
		return {
			type: "message" as const,
			id: `history-${index}`,
			parentId,
			timestamp: "2026-09-04T00:00:00.000Z",
			message: fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{ title: "Fixture request", operation: "request", targetAgent: "benchmark", question: `Request ${index}` },
					{ id: `request-${index}` },
				),
				{ stopReason: "toolUse" },
			),
		};
	return {
		type: "custom" as const,
		id: `history-${index}`,
		parentId,
		timestamp: "2026-09-04T00:00:00.000Z",
		customType: "benchmark-marker",
		data: { index, text: "x".repeat(512) },
	};
}
function query(transcript: AgentTranscript) {
	const inspection = transcript.inspect();
	findAuthoredRequestSources({ authorAgentId: "benchmark", transcript: inspection });
	inspectMessageDeliveries({ recipientAgentId: "benchmark", transcript: inspection });
	if (!inspection.entries.at(-1)) throw new Error("Missing physical evidence");
}
async function measure(work: () => Promise<void>) {
	const start = performance.now();
	let last = start,
		maximumGapMs = 0,
		heartbeatCount = 0,
		finished = false;
	const heartbeat = new Promise<void>((resolve) => {
		const tick = () => {
			const now = performance.now();
			maximumGapMs = Math.max(maximumGapMs, now - last);
			last = now;
			heartbeatCount++;
			if (finished) resolve();
			else setImmediate(tick);
		};
		setImmediate(tick);
	});
	try {
		await work();
	} finally {
		finished = true;
	}
	const elapsedMs = performance.now() - start;
	await heartbeat;
	return { elapsedMs, maximumGapMs, heartbeatCount };
}
function delta(before: TranscriptDiagnostics, after: TranscriptDiagnostics) {
	return Object.fromEntries(
		Object.keys(before).map((key) => [
			key,
			after[key as keyof TranscriptDiagnostics] - before[key as keyof TranscriptDiagnostics],
		]),
	);
}
