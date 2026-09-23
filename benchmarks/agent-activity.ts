/** Run: node --test benchmarks/agent-activity.ts. Fixtures live in temporary directories; no child Agent Runs start. */
import test from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { activityWorkflow } from "../tests/support/activity-workflow.ts";
import type { HumanPresentationCoordinatorView } from "../src/coordination/workflow-coordinator.ts";

const SAMPLES = 20;
for (const dormantAgents of [10, 100, 400]) {
	test(`activity work with ${dormantAgents} dormant Agents`, { timeout: 30_000 }, async t => {
		const workflow = await activityWorkflow(t, Array.from({ length: dormantAgents }, (_, index) => ({ id: `worker-${index}` })));
		const source = workflow.coordinator.forAgent("worker-0");
		for (let index = 0; index < 3; index++) await activityChange(source);
		await yieldTurn();
		const before = workflow.coordinator.presentationDiagnostics();
		const refreshTimes: number[] = [];
		for (let index = 0; index < SAMPLES; index++) {
			await yieldTurn();
			const started = performance.now();
			await activityChange(source);
			refreshTimes.push(performance.now() - started);
		}
		const afterRefresh = workflow.coordinator.presentationDiagnostics();
		const rosterTimes: number[] = [];
		for (let index = 0; index < SAMPLES; index++) {
			await yieldTurn();
			const started = performance.now();
			workflow.owner.selectionRoster();
			rosterTimes.push(performance.now() - started);
		}
		const afterRoster = workflow.coordinator.presentationDiagnostics();
		console.log(JSON.stringify({
			node: process.version,
			dormantAgents,
			samples: SAMPLES,
			activityRefresh: {
				...summarize(refreshTimes),
				passes: afterRefresh.activityRefreshPasses - before.activityRefreshPasses,
				sourcesScheduled: afterRefresh.activitySourcesScheduled - before.activitySourcesScheduled,
			},
			selectorRoster: {
				...summarize(rosterTimes),
				authorityOrderBuilds: afterRoster.authorityOrderBuilds - afterRefresh.authorityOrderBuilds,
			},
		}));
	});
}

function activityChange(source: HumanPresentationCoordinatorView): Promise<void> {
	return new Promise(resolve => {
		let publications = 0;
		const remove = source.addAgentActivityChangeHandler(() => {
			// Existing contract: immediate host status, then refreshed transcript status.
			if (++publications !== 2) return;
			remove();
			resolve();
		});
		source.refreshAgentActivity();
	});
}

function summarize(times: number[]) {
	times.sort((left, right) => left - right);
	return { medianMs: (times[SAMPLES / 2 - 1]! + times[SAMPLES / 2]!) / 2, maxMs: times.at(-1) };
}
