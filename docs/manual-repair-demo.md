# Manual repair live demo (trigger-is-approval)

## A. Live, healthy Owner session

1. Launch pi with this build, open any healthy workflow session.
2. Run `/agents repair <reason>` for a Repair Moderator (second trigger joins while live; fresh one after Dormant). The trigger receipt IS the approval: it mints the pending trigger `{moderatorAgentId, approver}` with `owner-session-trigger` provenance.
3. Run `/agents` to see the real Moderator record and switch Owner and Moderator: join and release Runtimes without cross-host adoption, drafts preserved, no auto-resume, pre-commit Owner shows snapshot only.
4. As Moderator, diagnose from installed package source (read-only evidence, never live broken Owner traversal), fix isolated copies with ordinary tools, then `repair_validate` (advisory only, grants zero authority).
5. `repair_freeze` under the current trigger authority (snapshot-only, no writes; auto-mints the trigger approval bound to the exact snapshot; re-freeze replaces pending).
6. `repair_commit` under the same trigger authority (backend gates: drift recheck, validation re-run, backup+seal+journal; single-use per trigger; second commit without a fresh trigger is refused).
7. `moderator_control resolve` sends handling to Dormant, history retained. Repaired Owner reopens idle until a new human message; user returns via `/agents` (`/agents owner`).
8. Esc or a new human message aborts the in-flight commit step only (no partial apply) and preserves trigger authority; retry in the same attempt succeeds WITHOUT a fresh trigger after fresh drift + validation rechecks. Only commit success (single-use), explicit repair cancel, `moderator_control resolve`/Dormant, or supersession by a fresh trigger clears the trigger authority. A commit that races arrived input observes it via the fresh recheck, never via a cleared flag.

## B. Live, broken Owner session (preadmission entry)

One command builds a tempfile broken session and replaces itself with
interactive pi on it (current checkout code; -ne blocks the stale copy):

    npm run demo:repair

Expected: blockage widget plus /agents diagnostics hint, session file untouched. /agents diagnostics offers manual repair; press r (or run /agents repair REASON from the failed surface) to host the Moderator. Same trigger, freeze, commit, idle, and switch flow as healthy; failed-admission data kept.

Do not use print mode against the materialized file (it appends conversation); re-run the smoke test for a fresh tempfile instead.

## D. Repair-host isolation guarantees

- Model policy applies to the repair Moderator on both paths: the preadmission
  host loads the policy file like the admitted host, and an excluded inherited
  or template-default model is refused (never silently selected).
- The repair Moderator's start/view/validate path never traverses live broken
  Owner evidence: RequestEvidence traversals skip the retired Owner record, and
  the repair host runs no automatic incident inspection, reminders, or
  Moderator creation. Diagnosis reads installed package source and frozen copies only
  (readRepairOwnerSnapshot, repair_validate on frozen paths).
- The repair Moderator's /agents switcher shows only itself; spawn, message,
  wait, control, and resume stay repair-only refused.
- Approval is the `/agents repair` trigger receipt (owner-session-trigger provenance,
  bound to the exact snapshot, single commit per trigger; Esc/human-message aborts the
  step only and preserves authority, while explicit cancel, `moderator_control resolve`/
  Dormant, or a fresh trigger clears it). There is no Moderator-driven authority beyond
  the trigger: advisory validate reports grant zero authority, and model tool calls
  plus moderator_control resolve never authorize.

## C. Headless backend and wiring suites

    node tests/support/run-test-suite.ts fast --file=repair-freeze-backend.test.ts
    node tests/support/run-test-suite.ts fast --file=repair-commit.test.ts
    node tests/support/run-test-suite.ts fast --file=repair-wiring.test.ts
    node tests/support/run-test-suite.ts fast --file=repair-trigger-approval.test.ts
    node --test tests/repair-broken-session-smoke.test.ts
    npx tsc --noEmit
