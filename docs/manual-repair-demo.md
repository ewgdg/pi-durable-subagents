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

One command builds a tempfile broken session and replaces itself with
interactive pi on it (current checkout code; -ne blocks the stale copy):

    npm run demo:repair

Expected: blockage widget plus /agents diagnostics hint, session file untouched. /agents diagnostics offers manual repair; press r (or run /agents repair REASON from the failed surface) to host the Moderator. Same freeze, confirm, commit, idle, and switch flow as healthy; failed-admission data kept.

Do not use print mode against the materialized file (it appends conversation); re-run the smoke test for a fresh tempfile instead.

## D. Repair-host isolation guarantees

- Model policy applies to the repair Moderator on both paths: the preadmission
  host loads the policy file like the admitted host, and an excluded inherited
  or template-default model is refused (never silently selected).
- The repair Moderator's start/view/validate path never traverses live broken
  Owner evidence: RequestEvidence traversals skip the retired Owner record, and
  the repair host runs no automatic incident inspection, reminders, or
  Moderator creation. Diagnosis reads frozen copies only
  (readRepairOwnerSnapshot, repair_validate on frozen paths).
- The repair Moderator's /agents switcher shows only itself; spawn, message,
  wait, control, and resume stay repair-only refused.
- Approval and commit stay explicitly human-driven through /agents
  repair-freeze, repair-confirm, and repair-commit (Owner-session provenance,
  exact snapshot binding, persisted-ledger revocation, no model-granted
  authority). There is no Moderator-driven approve/commit path by design.

## C. Headless backend and wiring suites

    node tests/support/run-test-suite.ts fast --file=repair-freeze-backend.test.ts
    node tests/support/run-test-suite.ts fast --file=repair-commit.test.ts
    node tests/support/run-test-suite.ts fast --file=repair-wiring.test.ts
    node --test tests/repair-broken-session-smoke.test.ts
    npx tsc --noEmit
