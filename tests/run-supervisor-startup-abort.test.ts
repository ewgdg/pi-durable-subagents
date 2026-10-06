import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../src/coordination/agent-record.ts";
import type { MessageCoordinator } from "../src/coordination/messages.ts";
import { RunSupervisor } from "../src/coordination/run-supervision.ts";
import type { TerminalProjection } from "../src/presentation/terminal-projection.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import type {
	AgentRuntimeHost,
	RuntimeInitializationAbort,
} from "../src/runtime/agent-runtime-host.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { AgentTranscript, type TranscriptInspection } from "../src/transcript/agent-transcript.ts";

const ABORT_WAIT_MS = 100;

test("abort cancels a selected starting Run before its occupied lane", async () => {
	const targetAgentId = "starting-target";
	const toolCallId = "abort-starting-target";
	const input = { operation: "abort" as const, agentId: targetAgentId };
	const ownerTranscript = transcriptWithRunControl("owner", toolCallId, input);
	const lane = new SerialLane();
	let releaseStartup!: () => void;
	const startupGate = new Promise<void>((resolve) => {
		releaseStartup = resolve;
	});
	const occupiedLane = lane.run(() => startupGate);
	let phase: "starting" | "live" | "dormant" = "starting";
	let currentHandle: Readonly<{ sequence: number }> | undefined = { sequence: 1 };
	let cancellationRequests = 0;
	let ordinaryAborts = 0;
	let pendingAbort: RuntimeInitializationAbort | undefined;
	let successorStarts = 0;
	const projection = {} as TerminalProjection;
	const targetHost = {
		lane,
		observe: () => phase === "dormant"
			? { phase: "dormant", retentionReasons: [] }
			: { phase, attention: "none", retentionReasons: [] },
		currentProjection: () => projection,
		currentHandle: () => currentHandle,
		residualRequestCounts: () => phase === "dormant"
			? { incoming: 0, outgoing: 0 }
			: { incoming: 1, outgoing: 2 },
		requestRuntimeInitializationAbort(exactProjection: TerminalProjection) {
			assert.equal(exactProjection, projection);
			cancellationRequests += 1;
			const cancellation = Promise.resolve().then(() => {
				phase = "dormant";
				currentHandle = undefined;
				releaseStartup();
				return true;
			});
			pendingAbort = { cancellation };
			return pendingAbort;
		},
		completeRuntimeInitializationAbortInLane(request: RuntimeInitializationAbort) {
			if (pendingAbort !== request) return false;
			pendingAbort = undefined;
			return true;
		},
		async discardAndEndInLane() {
			ordinaryAborts += 1;
			phase = "dormant";
			currentHandle = undefined;
		},
	} as unknown as AgentRuntimeHost;
	let discardedScheduling = 0;
	const messages = {
		discardSchedulingInLane() {
			discardedScheduling += 1;
		},
		outstandingRequestsTo: () => [],
	} as unknown as MessageCoordinator;
	const agents = new Map<string, AgentRecord>([
		["owner", record({
			agentId: "owner",
			workflowId: "owner",
			directSpawnerAgentId: null,
			metadata: { label: "Owner", description: "Workflow Owner" },
		}, {} as AgentRuntimeHost, ownerTranscript)],
		[targetAgentId, record({
			agentId: targetAgentId,
			workflowId: "owner",
			directSpawnerAgentId: "owner",
			creationPreset: null,
			spawnSource: { agentId: "owner", entryId: "spawn-entry", toolCallId: "spawn-call" },
			metadata: { label: "Starting Target" },
		}, targetHost, emptyTranscript(targetAgentId))],
	]);
	const supervisor = new RunSupervisor({
		agents,
		ownerAgentId: "owner",
		messages,
	});

	const earlierAdmission = lane.run(() => {
		if (pendingAbort) return "fenced" as const;
		successorStarts += 1;
		phase = "live";
		currentHandle = { sequence: 2 };
		return "started" as const;
	});
	const abortReceipt = supervisor.execute("owner", toolCallId, input);
	const outcome = await Promise.race([
		abortReceipt.then((receipt) => ({ kind: "aborted" as const, receipt })),
		new Promise<Readonly<{ kind: "blocked" }>>((resolve) =>
			setTimeout(() => resolve({ kind: "blocked" }), ABORT_WAIT_MS)
		),
	]);
	if (outcome.kind === "blocked") {
		releaseStartup();
		await abortReceipt;
	}
	await occupiedLane;
	assert.equal(await earlierAdmission, "fenced");

	assert.equal(outcome.kind, "aborted");
	if (outcome.kind !== "aborted") return;
	assert.deepEqual(outcome.receipt, {
		agentId: targetAgentId,
		disposition: "aborted",
		residualRequests: { incoming: 1, outgoing: 2 },
		callerOutstandingRequests: [],
	});
	assert.equal(cancellationRequests, 1);
	assert.equal(ordinaryAborts, 0);
	assert.equal(discardedScheduling, 1);
	assert.equal(successorStarts, 0);
	assert.equal(pendingAbort, undefined);
});

function record(
	identity: AgentRecord["identity"],
	host: AgentRuntimeHost,
	transcript: AgentTranscript,
): AgentRecord {
	return { identity, host, transcript, children: [] };
}

function transcriptWithRunControl(
	agentId: string,
	toolCallId: string,
	input: Readonly<{ operation: "abort"; agentId: string }>,
): AgentTranscript {
	const sessionManager = SessionManager.inMemory(process.cwd(), { id: agentId });
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId });
	sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	return transcriptFromSessionManager(sessionManager);
}

function emptyTranscript(agentId: string): AgentTranscript {
	return new AgentTranscript({ read: () => emptyInspection(agentId) });
}

function emptyInspection(agentId: string): TranscriptInspection {
	return {
		sessionId: agentId,
		transcriptPath: null,
		header: null,
		entries: [],
		activeBranch: [],
		context: {} as TranscriptInspection["context"],
	};
}
