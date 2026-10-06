import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
	CONTEXT_DEPENDENCE_COST_TOKENS,
	CONTINUATION_WORK_SCALE_RUNWAY_TOKENS,
	THINKING_RUNWAY_MULTIPLIER,
	workingZonePreparationThreshold,
} from "../src/policy/working-zone-preparation.ts";
import {
	RUNTIME_THINKING_LEVELS,
	type RuntimeThinkingLevel,
} from "../src/protocol/runtime-configuration.ts";

const workScales = ["small", "medium", "large"] as const;
const contextDependences = ["low", "medium", "high"] as const;

function expectedThreshold(options: {
	workScale: (typeof workScales)[number];
	contextDependence: (typeof contextDependences)[number];
	thinking: RuntimeThinkingLevel;
	contextWindow: number;
	incomingRequestTokens: number;
}): number {
	const cost = CONTEXT_DEPENDENCE_COST_TOKENS[options.contextDependence];
	const desiredRunway = CONTINUATION_WORK_SCALE_RUNWAY_TOKENS[options.workScale] *
		THINKING_RUNWAY_MULTIPLIER[options.thinking];
	const runwayThreshold = Math.max(
		0,
		options.contextWindow - options.incomingRequestTokens - desiredRunway,
	);
	const runwayWeight = runwayThreshold < cost ? 0.3 : 0.15;
	return (1 - runwayWeight) * cost + runwayWeight * runwayThreshold;
}

test("working-zone threshold implements every work, dependence, and thinking combination", () => {
	for (const workScale of workScales) {
		for (const contextDependence of contextDependences) {
			for (const thinking of RUNTIME_THINKING_LEVELS) {
				const options = {
					workScale,
					contextDependence,
					thinking,
					contextWindow: 200_000,
					incomingRequestTokens: 3_000,
				};
				assert.equal(
					workingZonePreparationThreshold(options),
					expectedThreshold(options),
					`${workScale}/${contextDependence}/${thinking}`,
				);
			}
		}
	}
});

test("working-zone threshold stays between its anchors and monotonic across the full matrix", () => {
	for (const contextWindow of [128_000, 200_000, 1_000_000]) {
		for (const incomingRequestTokens of [0, 4_000, 100_000]) {
			for (const contextDependence of contextDependences) {
				const cost = CONTEXT_DEPENDENCE_COST_TOKENS[contextDependence];
				for (const workScale of workScales) {
					let previousThinkingThreshold = Number.POSITIVE_INFINITY;
					for (const thinking of RUNTIME_THINKING_LEVELS) {
						const desiredRunway = CONTINUATION_WORK_SCALE_RUNWAY_TOKENS[workScale] *
							THINKING_RUNWAY_MULTIPLIER[thinking];
						const runwayThreshold = Math.max(
							0,
							contextWindow - incomingRequestTokens - desiredRunway,
						);
						const threshold = workingZonePreparationThreshold({
							workScale,
							contextDependence,
							thinking,
							contextWindow,
							incomingRequestTokens,
						});
						assert.ok(threshold >= Math.min(cost, runwayThreshold));
						assert.ok(threshold <= Math.max(cost, runwayThreshold));
						assert.ok(threshold <= previousThinkingThreshold);
						previousThinkingThreshold = threshold;
					}
				}
			}

			for (const thinking of RUNTIME_THINKING_LEVELS) {
				for (const contextDependence of contextDependences) {
					let previousWorkThreshold = Number.POSITIVE_INFINITY;
					for (const workScale of workScales) {
						const threshold = workingZonePreparationThreshold({
							workScale,
							contextDependence,
							thinking,
							contextWindow,
							incomingRequestTokens,
						});
						assert.ok(threshold <= previousWorkThreshold);
						previousWorkThreshold = threshold;
					}
				}

				let previousDependenceThreshold = Number.NEGATIVE_INFINITY;
				for (const contextDependence of contextDependences) {
					const threshold = workingZonePreparationThreshold({
						workScale: "medium",
						contextDependence,
						thinking,
						contextWindow,
						incomingRequestTokens,
					});
					assert.ok(threshold >= previousDependenceThreshold);
					previousDependenceThreshold = threshold;
				}
			}
		}
	}
});

test("working-zone threshold uses the dependence cost when runway inputs are unavailable", () => {
	for (const contextDependence of contextDependences) {
		const cost = CONTEXT_DEPENDENCE_COST_TOKENS[contextDependence];
		assert.equal(workingZonePreparationThreshold({
			workScale: "large",
			contextDependence,
		}), cost);
		assert.equal(workingZonePreparationThreshold({
			workScale: "large",
			contextDependence,
			thinking: "max",
			contextWindow: 200_000,
		}), cost);
	}
});

test("working-zone threshold handles representative 128k, 200k, and 1M windows", () => {
	assert.equal(workingZonePreparationThreshold({
		workScale: "large",
		contextDependence: "low",
		thinking: "max",
		contextWindow: 128_000,
		incomingRequestTokens: 0,
	}), 66_500);
	assert.equal(workingZonePreparationThreshold({
		workScale: "medium",
		contextDependence: "medium",
		thinking: "max",
		contextWindow: 200_000,
		incomingRequestTokens: 1_000,
	}), 119_800);
	assert.equal(workingZonePreparationThreshold({
		workScale: "large",
		contextDependence: "high",
		thinking: "max",
		contextWindow: 1_000_000,
		incomingRequestTokens: 100_000,
	}), 241_350);
});
