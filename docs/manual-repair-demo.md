# Manual repair live demo

## A. Live, healthy Owner session

1. Launch pi with this build, open any healthy workflow session.
2. Run /agents repair triage test for a Repair Moderator (second call joins while live; fresh one after Dormant).
3. Run /agents to see the real Moderator record and switch Owner and Moderator: join and release Runtimes without cross-host adoption, drafts preserved, no auto-resume, pre-commit Owner shows snapshot only.
4. Run /agents repair-freeze for a snapshot id; review advisory via repair_validate (frozen copies only, advisory, no authority).
5. Run /agents repair-confirm SNAPSHOT for explicit Owner approval.
6. Run /agents repair-commit SNAPSHOT: drift recheck, backup, seal, journal; repaired Owner reopens idle until a new human message.
7. Esc or a new human message revokes pending approval via the persisted ledger.
8. moderator_control resolve sends handling to Dormant, history retained.

## B. Live, broken Owner session (preadmission entry)

Materialize a tempfile broken session with the smoke test (duplicate valid Owner Deliveries fail admission). Nothing is committed; the test prints the absolute path plus the exact launch command:

    node --test tests/repair-broken-session-smoke.test.ts

Then launch pi with the printed path (loads current checkout code; -ne blocks the stale installed copy):

    pi --session PRINTED_PATH -ne -e REPO/src/index.ts

Expected: blockage widget plus /agents diagnostics hint, session file untouched. /agents diagnostics offers manual repair; press r (or run /agents repair REASON from the failed surface) to host the Moderator. Same freeze, confirm, commit, idle, and switch flow as healthy; failed-admission data kept.

Do not use print mode against the materialized file (it appends conversation); re-run the smoke test for a fresh tempfile instead.

## C. Headless backend and wiring suites

    node tests/support/run-test-suite.ts fast --file=repair-freeze-backend.test.ts
    node tests/support/run-test-suite.ts fast --file=repair-commit.test.ts
    node tests/support/run-test-suite.ts fast --file=repair-wiring.test.ts
    node --test tests/repair-broken-session-smoke.test.ts
    npx tsc --noEmit
