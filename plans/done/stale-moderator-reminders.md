# Prevent stale Moderator handling reminders (#113)

## Goal and scope
Keep a conditional Moderator reminder out of Pi's irreversible queues until its handling episode can commit it. Preserve ordinary Messages/Requests, valid reminders, and normal dormant release. No rollover, continuation, compaction-policy, or global reminder-count changes.

## Design and ordering
Pi 0.85.1 has no public per-item queue retraction or precommit custom-message predicate. Use a scoped child prepare/finish handshake, not queue cancellation. Preparation holds the existing native turn-admission gate only while the child is truly idle; busy leaves the reminder scheduler-owned. After preparation, commit revalidates the episode and predicate on the existing operational reconciliation lane. Hold that lane through native transcript acknowledgement, ordering release/resolve against commitment. A clearance that acquires the lane first suppresses; a successful commit that acquires it first precedes clearance. Raw evidence writers are not distributed-locked. Enqueueing behind an active Run is never commitment.

The acknowledgement must observe child-local transcript persistence directly, without calling reconciliation or requiring the scheduler lane. Release reservations on suppression, busy, cancellation, disposal, and failure. Do not hold the reconciliation lane during preparation or model completion.

## Work plan
1. Add a regression using the actual scheduler and native Pi session; capture red.
2. Implement scoped idle preparation/commit and scheduler ownership through its outcome.
3. Exercise native child transport, clear-first/commit-first ordering, busy and failure cleanup.
4. Document supported behavior, run targeted tests and typecheck, commit.

## Validation
Deterministic gates, not timing sleeps. Native transcript and model inputs are the delivery oracle. Targeted scheduler, moderation, runtime and transport tests only; no full integration suite.

## Progress
- Inspected existing scheduler, moderation, runtime adapter and child control seams.
- Confirmed native Pi only supports whole-queue clearing; context filtering is after transcript commitment.
- Owner approved serialized handling-episode ordering and scoped handshake.
- Native scheduler regression failed before production changes: cleared reminder reached native transcript (1 failed, ~0.46s). Evidence: disposable native-red output captured outside repository.
- Same regression passes through the in-process adapter. Real child validation confirms active native work returns busy without queueing, clear-first suppresses before transcript/model input, and commit-first proves persistence before releasing the authoritative lane. Ordinary Message and Request delivery remains usable afterward.
- Verified custom reminder agent_start and message_end participant hooks do not await operational reconciliation. Native proof is observed before turn_end/safeBoundary reconciliation. Scheduler does not hold its lane while preparing or committing.

## Decisions
Two-phase preparation is limited to Moderator handling reminders. Existing ordinary delivery remains unchanged. Parent owns final review, push and PR.

## Outcomes
Implemented the scoped handshake and documented supported ordering. Reminder preparation/commit does not hold the scheduler lane. Busy reminders remain scheduler-owned; suppression/failure completes reservation cleanup and requests dormant release without waiting for another native settlement. Child cancellation fences delayed callbacks, releases pending admission even before native gate entry, and never clears unrelated queues. Run identity is admitted only for native commitment, not speculative preparation.

Additional red-first lifecycle tests exposed premature busy completion, cancellation rejection before admission, synchronous admission failure, missing release evaluation, and failed finish transport retaining a reservation; each now passes. Real operational-coordinator tests cover both valid handling reminder/dormant release and clearing an actual incident while native reminder admission is prepared.

Validation (all targeted, no full integration suite):
- `node --test --test-concurrency=1 tests/control-protocol-schemas.test.ts tests/moderator-obligation-reminder.test.ts tests/moderator-reminder-admission.test.ts tests/stale-moderator-reminder-delivery.test.ts tests/in-process-hosted-runtime.test.ts tests/hosted-runtime-async-queue.test.ts tests/pi-child-hosted-runtime-fault.test.ts`: 33 passed.
- `node --test --test-concurrency=1 tests/pi-child-hosted-runtime.test.ts tests/pi-child-moderator-reminder.test.ts`: 19 passed.
- `node --test --test-name-pattern 'a settled Moderator receives one handling reminder|clearing the incident before native reminder' tests/operational-incidents.test.ts`: 2 passed.
- `node --test --test-name-pattern 'hosted child reminder' tests/pi-child-hosted-runtime.test.ts`: final six lifecycle tests passed after explicit per-test bounds.
- `npm run typecheck` and `git diff --check`: passed.
- Existing `tests/owner-parked-delivery-scheduler.test.ts` fails because its mock lacks `addEndedHandler`. Reproduced unchanged in a disposable checkout of base `11a1746`; not changed in this task.

Evidence lives outside the repo in the agent artifact output for project `pi-agent-coordination`, date `2026-09-09`, task `stale-moderator-reminders`. The native stale-delivery red output is retained there alongside final validation and the baseline-only failure.

The ordering contract is authoritative handling clearance/Resolution versus native transcript commitment, not atomic distributed locking of raw evidence writers. No rollover/continuation/compaction policy changes. Windows real-process cases use the existing platform skip; validation ran on Linux.

## Independent-review follow-up
Review found that failed reminder preparation released its reservation but did not advance ordinary deliveries admitted behind it. No native turn had started, so no later settlement was guaranteed. Added deterministic actual-scheduler regressions for both an ordinary Message and Request admitted while preparation is held. Both failed first with zero dispatches after failure cleanup; failure now drains eligible pending delivery before release evaluation. No external scheduling boundary is used by either regression.

Follow-up validation: `node --test tests/stale-moderator-reminder-delivery.test.ts` passed all 5 tests; `npm run typecheck` passed. Red/green evidence is retained with the task artifacts.

## Upstream startup progress correction
Actual generation probes on233080f and11a1746 found an earlier root cause: Moderator Input is precommitted, and initial routine-start bypasses scheduler progress while the child still projects settled. Represent that initial delivery through the existing scheduler, preserving its progress until native proof/settlement. Add a real generation-seam regression before production changes, preserve valid post-settlement reminder behavior, then run focused checks and commit separately. No timing grace period or compaction changes.

The generation regression failed before the production change with one reminder generated during the held first native startup (expected zero). The fix routes the initial Moderator routine-start through existing Deferred custom Delivery admission, with durable routine-start proof. No new time delay, no-progress exception, native work-state mutation, or compaction logic was added. The same regression now confirms zero generation through first-start admission and the first active model call, followed by exactly one valid reminder after genuine settlement.

Validation:
- `node --test --test-concurrency=1 tests/moderator-startup-progress.test.ts tests/stale-moderator-reminder-delivery.test.ts`: 6 passed.
- `node --test --test-name-pattern 'post-commit Moderator startup failure|terminal Moderator Run failure|two committed Moderator failures|a settled Moderator receives one handling reminder|clearing the incident before native reminder' tests/operational-incidents.test.ts`: 5 passed, including failure replacement, handling clearance and dormant release (`post-commit Moderator startup failure` and `two committed Moderator failures` since merged into `two committed Moderator startup failures link the replacement and publish bounded Owner Attention until clearance`).
- `npm run typecheck` and whitespace check: passed.
- New real-process test is classified in the process suite. It uses a native first-start hook gate and actual operational reconciliation; observing generation does not alter admission or Runtime state. The native gate's file publication is atomic, and polling/operation waits are bounded.

## Queued startup termination correction
Independent review found that separate host-lane acquisitions for initial startup and scheduler admission allowed a queued termination to finish between them; routine-start admission then resurrected the same Moderator as Run 2. Added a real-process regression first: it queues actual termination after first-start readiness while startup owns the lane, drains reconciliation and the host lane, and asserts one start and no current handle. Red failed with two starts instead of one.

Startup and initial custom-delivery admission now share one host-lane transaction. The custom scheduler exposes an in-lane admission counterpart, matching ordinary delivery admission; scheduler ownership and first-turn progress remain unchanged. No Run fencing, replacement policy, timing delay, or unrelated cleanup was added.

Validation:
- Startup progress and stale-reminder delivery tests: 7 passed, including the queued-termination regression and zero reminders before first settlement/one afterward.
- Targeted operational incidents tests: 5 passed (startup failure replacement, terminal failure replacement, bounded repeated failures, valid reminders/dormant release, and clearance before commitment).
- `npm run typecheck` and `git diff --check`: passed.
