/** Run: node --expose-gc benchmarks/relationship-refresh.ts. No model calls or Agent Runs. */
import { setImmediate as yieldTurn } from "node:timers/promises";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { participant } from "../tests/support/request-history.ts";

const WARMUPS = 5;
const SAMPLES = 10;

// Isolate the bookkeeping measured in #147: identity-only dormant Agents,
// no Requests, and no appends. This is not an interactive latency benchmark.
for (const size of [10, 50, 100, 200, 400]) {
	global.gc?.();
	const heapBefore = process.memoryUsage().heapUsed;
	const participants = Array.from({ length: size }, (_, index) => participant(`agent-${index}`));
	const evidence = new RequestEvidence(new Map(participants.map(({ record }) => [record.identity.agentId, record])));
	let inspections = 0;
	let sourceRefreshes = 0;
	for (const { record } of participants) {
		const inspect = record.transcript.inspect.bind(record.transcript);
		const refresh = record.transcript.refresh.bind(record.transcript);
		record.transcript.inspect = () => { inspections++; return inspect(); };
		record.transcript.refresh = async () => { sourceRefreshes++; return refresh(); };
	}
	for (let index = 0; index < WARMUPS; index++) await evidence.refreshRelationships();
	global.gc?.();
	const warmedHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
	inspections = 0;
	sourceRefreshes = 0;
	const consumedBefore = participants.reduce((sum, p) => sum + p.record.transcript.diagnostics()!.entriesConsumed, 0);
	const times: number[] = [];
	const turnDelays: number[] = [];
	for (let index = 0; index < SAMPLES; index++) {
		await yieldTurn();
		const started = performance.now();
		const turn = yieldTurn().then(() => turnDelays.push(performance.now() - started));
		await evidence.refreshRelationships();
		times.push(performance.now() - started);
		await turn;
	}
	const consumedAfter = participants.reduce((sum, p) => sum + p.record.transcript.diagnostics()!.entriesConsumed, 0);
	times.sort((left, right) => left - right);
	console.log(JSON.stringify({
		node: process.version, agents: size, samples: SAMPLES,
		medianMs: (times[SAMPLES / 2 - 1]! + times[SAMPLES / 2]!) / 2,
		maxMs: times.at(-1), maxTurnDelayMs: Math.max(...turnDelays),
		sourceRefreshesPerPass: sourceRefreshes / SAMPLES,
		transcriptInspectionsPerPass: inspections / SAMPLES,
		newEntriesConsumed: consumedAfter - consumedBefore,
		warmedHeapDeltaBytes: global.gc ? warmedHeapDeltaBytes : null,
	}));
}
