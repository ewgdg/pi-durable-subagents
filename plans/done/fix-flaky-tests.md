# Fix failing and flaky tests

## Goal

Every test in `npm run typecheck`, `npm run test:fast` and `npm run test:process` passes reliably, landed as one PR that closes #195.

## Intention

The user asked for all tests fixed autonomously overnight. Flakes must be fixed at their cause (a race in the test or a product bug), not by retries or longer sleeps.

## Scope & Constraints

- Test fixes by default. A product change only when the evidence shows a product bug; record it under Decisions.
- Product semantics stay as specified in `GLOSSARY.md`. Open product question (not changed): should a Creation Request rejected at admission, already reported `not_sent`, still qualify as a Delivery Stall scheduling loss?
- Branch `fix/flaky-stall-suppression-test`.

## Work Plan

1. Run typecheck, fast suite and process suite; record every failure.
2. For each failure: reproduce, capture the cause, fix, verify the single test repeatedly.
3. Re-run the affected suites; repeat until clean.
4. Push, open PR, link it in T3.

## Validation

- Each fixed test passes repeatedly on its own.
- Full fast and process suites pass.

## Progress

- [x] #195 "an outgoing Request suppresses a Stall": fixed in 625ad04 (safe boundary + Obligation Stall-only check).
- [x] "one failed provider request suspends…": fixed in 625ad04 (read retention at safe boundary).
- [x] Full-suite sweep: typecheck; fast ×1; test:ci ×5; conformance ×1; process ×4 (~417s each). All passed; no further failures surfaced.
- [x] PR #196 opened; GitHub CI (Node 22, 24) passed.

## Surprises & Discoveries

- #195 was not a timer: the fixture's rejected Creation Request always starts a Delivery Stall Moderator (scheduling loss); the 50-tick yield only decided whether the check saw it.
- `reachSafeBoundary()` on an Agent view is the existing deterministic "incident evaluation done" signal.
- Request relationship retention (`answer_owed`) lags a Run's visible settlement by one lane hop; it is current at safe boundaries.
- Three orphaned `child-runtime-compaction-delivery` test processes from Oct 4 spun at ~110% CPU each; spawned outside the suite supervisor (whose cgroup cleanup worked in every run today).

## Decisions

- Rejected: lengthening the yield in #195. It only moves the race, and the old check could not detect broken suppression anyway.

## Outcomes & Retrospective

- Two flaky process tests fixed, test-only; both read outcomes at the affected Agent's safe boundary.
- No other failures across repeated sweeps of every suite.
- The deterministic-boundary guidance moved to `docs/development.md` ("Asserting after incident evaluation").
- Open product question left to the user (see Scope & Constraints).
