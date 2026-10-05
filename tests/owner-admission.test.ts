import assert from "node:assert/strict";
import test from "node:test";

import {
	OwnerAdmission,
	type NativeReplacement,
	type NativeReplacementVerdict,
	type OwnerAdmissionOutcome,
	type OwnerViewResolver,
} from "../src/bootstrap/owner-admission.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";

type FakeSessionStart = Readonly<{
	sessionManager: Readonly<{ getSessionId(): string; getSessionFile(): string | undefined }>;
}>;

const sessionStart = (sessionId = "owner-session"): FakeSessionStart => ({
	sessionManager: {
		getSessionId: () => sessionId,
		getSessionFile: () => `/sessions/${sessionId}.jsonl`,
	},
});

const ownerView = { agentLabel: () => "Owner" } as unknown as OrdinaryAgentCoordinatorView;
const resolveOwnerView: OwnerViewResolver = () => ownerView;

type FakeBootstrap = (onOwnerIdentified: () => void) => Promise<OwnerViewResolver | undefined>;

const bootstraps = {
	// The real procedure always identifies the Owner before it can admit.
	admitted: async (onOwnerIdentified) => {
		onOwnerIdentified();
		return resolveOwnerView;
	},
	inactive: async () => undefined,
	blockedAfterIdentification: async (onOwnerIdentified) => {
		onOwnerIdentified();
		throw new Error("conflicting Deliveries");
	},
	blockedBeforeIdentification: async () => {
		throw new Error("child Identity");
	},
	pending: () => new Promise<never>(() => {}),
} satisfies Record<string, FakeBootstrap>;

function ownerAdmission(
	bootstrap: FakeBootstrap,
	present: (outcome: OwnerAdmissionOutcome) => void = () => {},
) {
	const presented: OwnerAdmissionOutcome[] = [];
	const admission = new OwnerAdmission<FakeSessionStart>({
		bootstrapOwner: (_start, onOwnerIdentified) => bootstrap(onOwnerIdentified),
		presentOutcome: (outcome) => {
			presented.push(outcome);
			present(outcome);
		},
	});
	return { admission, presented };
}

const verdictRows: ReadonlyArray<readonly [
	keyof typeof bootstraps,
	Readonly<Record<NativeReplacement, NativeReplacementVerdict>>,
]> = [
	["pending", { fork: "refuse", new_session: "refuse", resume: "refuse" }],
	["admitted", { fork: "allow", new_session: "allow", resume: "allow" }],
	["inactive", { fork: "allow", new_session: "allow", resume: "allow" }],
	["blockedAfterIdentification", { fork: "allow", new_session: "allow", resume: "refuse" }],
	["blockedBeforeIdentification", {
		fork: "refuse_with_identification_notice",
		new_session: "allow",
		resume: "refuse",
	}],
];

for (const [outcome, expected] of verdictRows) {
	test(`native replacement verdicts while ${outcome}`, async () => {
		const { admission } = ownerAdmission(bootstraps[outcome]);
		const started = admission.start(sessionStart());
		if (outcome !== "pending") await started;
		assert.deepEqual({
			fork: admission.nativeReplacementVerdict("fork"),
			new_session: admission.nativeReplacementVerdict("new_session"),
			resume: admission.nativeReplacementVerdict("resume"),
		}, expected);
	});
}

test("native replacement is refused before any session starts", () => {
	const { admission } = ownerAdmission(bootstraps.admitted);
	assert.equal(admission.nativeReplacementVerdict("fork"), "refuse");
});

const settledOutcomes = ["admitted", "inactive", "blockedAfterIdentification", "blockedBeforeIdentification"] as const;

for (const outcome of settledOutcomes) {
	test(`a held turn starts only after the ${outcome} outcome is presented`, async () => {
		const events: string[] = [];
		const { admission } = ownerAdmission(bootstraps[outcome], ({ state }) => {
			events.push(`presented ${state}`);
		});
		const heldTurn = admission.settled().then(() => events.push("turn started"));
		await admission.start(sessionStart());
		await heldTurn;
		assert.equal(events.at(-1), "turn started");
		assert.equal(events.at(-2), `presented ${outcome.startsWith("blocked") ? "blocked" : outcome}`);
	});
}

test("a held turn starts and the session is Blocked when presenting admission fails", async () => {
	const { admission, presented } = ownerAdmission(bootstraps.admitted, ({ state }) => {
		if (state === "admitted") throw new Error("tool activation failed");
	});
	await admission.start(sessionStart());
	await admission.settled();
	const blocked = presented.at(-1);
	assert.equal(blocked?.state, "blocked");
	assert.equal(blocked.failure.stage, "Owner admission");
	assert.equal(admission.ownerView(), undefined);
	assert.equal(admission.nativeReplacementVerdict("fork"), "allow");
});

test("a held turn starts even when presenting the Blocked outcome fails", async () => {
	const { admission } = ownerAdmission(bootstraps.blockedBeforeIdentification, ({ state }) => {
		if (state === "blocked") throw new Error("widget failed");
	});
	await assert.rejects(admission.start(sessionStart()), /widget failed/);
	await admission.settled();
});

test("a repeated start for the same session admits once", async () => {
	let bootstrapRuns = 0;
	const { admission } = ownerAdmission(async () => {
		bootstrapRuns++;
		return resolveOwnerView;
	});
	const start = sessionStart();
	await admission.start(start);
	await admission.start(start);
	assert.equal(bootstrapRuns, 1);
	assert.equal(admission.ownerView(), ownerView);
});

test("a different session in the same attachment fails fast", async () => {
	const { admission } = ownerAdmission(bootstraps.admitted);
	await admission.start(sessionStart("first"));
	await assert.rejects(admission.start(sessionStart("second")), /second session/);
	assert.equal(admission.ownerView(), ownerView);
});

test("Blocked evidence names the failed stage and the session transcript", async () => {
	const { ProtocolInvariantError } = await import("../src/protocol/identities.ts");
	const { OwnerRecoveryError } = await import("../src/bootstrap/owner-recovery-error.ts");
	const existingEvidence = new OwnerRecoveryError("Owner coordination initialization", "owner", undefined, new Error("x"));
	const cases = [
		[new ProtocolInvariantError("bad Identity"), "Owner transcript recovery"],
		[new Error("policy unreadable"), "Owner admission"],
	] as const;
	for (const [error, stage] of cases) {
		const { presented, admission } = ownerAdmission(async () => { throw error; });
		await admission.start(sessionStart("blocked-session"));
		const blocked = presented.at(-1);
		assert.equal(blocked?.state, "blocked");
		assert.equal(blocked.failure.stage, stage);
		assert.equal(blocked.failure.agentId, "blocked-session");
		assert.equal(blocked.failure.transcriptPath, "/sessions/blocked-session.jsonl");
		assert.equal(blocked.failure.admissionError, error);
	}
	const { presented, admission } = ownerAdmission(async () => { throw existingEvidence; });
	await admission.start(sessionStart());
	const blocked = presented.at(-1);
	assert.equal(blocked?.state, "blocked");
	assert.equal(blocked.failure, existingEvidence);
});

test("the presenter sees Pending, then the settled outcome", async () => {
	const presentedStates = async (bootstrap: FakeBootstrap) => {
		const { admission, presented } = ownerAdmission(bootstrap);
		await admission.start(sessionStart());
		return presented.map((outcome) => outcome.state === "blocked"
			? `blocked identified=${outcome.ownerIdentified}`
			: outcome.state);
	};
	assert.deepEqual(await presentedStates(bootstraps.admitted), ["pending", "admitted"]);
	assert.deepEqual(await presentedStates(bootstraps.inactive), ["pending", "inactive"]);
	assert.deepEqual(await presentedStates(bootstraps.blockedAfterIdentification), ["pending", "blocked identified=true"]);
	assert.deepEqual(await presentedStates(bootstraps.blockedBeforeIdentification), ["pending", "blocked identified=false"]);

	const { admission, presented } = ownerAdmission(bootstraps.admitted);
	await admission.start(sessionStart());
	const admitted = presented.at(-1);
	assert.equal(admitted?.state, "admitted");
	assert.equal(admitted.ownerView(), ownerView);
	assert.equal(admission.admittedOwnerView(), ownerView);
});

test("an unadmitted Owner view is unavailable", async () => {
	const { admission } = ownerAdmission(bootstraps.inactive);
	await admission.start(sessionStart());
	assert.equal(admission.ownerView(), undefined);
	assert.throws(() => admission.admittedOwnerView(), /not admitted/);
});
