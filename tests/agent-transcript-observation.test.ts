import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { withAgentTranscriptObservations, type AgentRecord } from "../src/coordination/agent-record.ts";
import { AgentTranscript, type TranscriptInspection } from "../src/transcript/agent-transcript.ts";

function record(read: () => TranscriptInspection): AgentRecord {
	// This boundary uses only the record's transcript, not a Runtime or Identity.
	return { transcript: new AgentTranscript({ read }) } as AgentRecord;
}
function inspection(sessionId: string): TranscriptInspection {
	return { sessionId, transcriptPath: null, header: null, entries: [], activeBranch: [], context: { messages: [], thinkingLevel: "off", model: null } };
}

test("workflow observations do not grow the call stack with the Agent roster", { timeout: 5_000 }, () => {
	const view = inspection("shared");
	const records = Array.from({ length: 20_000 }, () => record(() => view));
	assert.equal(withAgentTranscriptObservations(records, () => {
		for (const agent of records) assert.equal(agent.transcript.inspect(), view);
		return "observed";
	}), "observed");
});

test("nested workflow observations restore outer views and fresh reads after callback failure", () => {
	const fresh = inspection("fresh");
	const outer = inspection("outer");
	const inner = inspection("inner");
	let reads = 0;
	const agent = record(() => { reads++; return fresh; });
	withAgentTranscriptObservations([agent], () => {
		assert.equal(agent.transcript.inspect(), outer);
		assert.throws(() => withAgentTranscriptObservations([agent, agent], () => {
			assert.equal(agent.transcript.inspect(), inner);
			throw new Error("consumer failed");
		}, new Map([[agent, inner]])), /consumer failed/);
		assert.equal(agent.transcript.inspect(), outer);
		assert.equal(reads, 0);
	}, new Map([[agent, outer]]));
	assert.equal(agent.transcript.inspect(), fresh);
	assert.equal(reads, 1);
});

test("inspection failure restores previously entered observations", () => {
	let current = inspection("before");
	const first = record(() => current);
	const broken = record(() => { throw new Error("reader failed"); });
	assert.throws(() => withAgentTranscriptObservations([first, broken], () => assert.fail("must not enter consumer")), /reader failed/);
	current = inspection("after");
	assert.equal(first.transcript.inspect(), current);
});

test("a synchronous observation reuses one read and the next operation catches up", () => {
	let current = inspection("before");
	let reads = 0;
	const agent = record(() => { reads++; return current; });
	withAgentTranscriptObservations([agent], () => {
		const observed = agent.transcript.inspect();
		current = inspection("after");
		withAgentTranscriptObservations([agent], () => assert.equal(agent.transcript.inspect(), observed));
		assert.equal(agent.transcript.inspect(), observed);
	});
	assert.equal(reads, 1);
	withAgentTranscriptObservations([agent], () => assert.equal(agent.transcript.inspect(), current));
	assert.equal(reads, 2);
});
