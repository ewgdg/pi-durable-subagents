# Review and bug-fix round

## Goal and constraints

Fix reproducible correctness problems found in a project review, preferring small
changes and deletion of obsolete behavior over new abstractions. Preserve the
trust-based protocol. Do not redesign architecture or make style-only changes.

Use read-only reviewers in disjoint areas and one implementation writer at a time.
Write failing regressions before production fixes, run bounded targeted tests, and
commit each coherent batch. Do not run the full integration suite.

## Findings and work plan

1. Child runtime: terminal non-quota errors can consume queued native work before
   Owner suspension arrives; request-setup cancellation is misclassified as failure.
   Reuse the existing synchronous queue capture and exact-run cancellation signal.
2. Coordination replay: malformed native Message receipts bypass record rejection
   while resolving targets and can poison unrelated relationship refreshes.
   Reuse the existing result validators and rejection boundary.
3. Human attention: cold recovery recreates historical questions without a live
   native tool call to accept an Answer. Confirm and preserve the documented
   distinction between retained live reload and volatile state lost with the host.
4. Tool results: Spawn, Wait, Control and Moderator Control hide final native
   errors behind pending or successful summaries. Use their existing error context.
5. Model policy: concurrent replacement saves lose bans. Prevent overlapping saves
   and closing the surface while a save is pending; retain explicit error feedback.
6. Selector: quarantines consisting solely of unreadable candidates hide their
   informational tab. Base visibility on candidate count as well as recovered IDs.

## Validation

- Confirm each failure with a regression before its fix.
- Exercise native child failure, cancellation, retry, and explicit-resume behavior.
- Test rejected versus accepted replay evidence, cold Human attention versus live
  reload, renderer errors, deferred/rejected policy writes, and quarantine access.
- Run affected test files and typechecking; independently review the resulting diff.
- Stop when accepted fixes are verified and no substantive review issue remains.

## Progress

- Initial working tree clean; baseline `npm run typecheck` passed.
- Four read-only reviews completed: coordination/transcripts, runtime/control,
  presentation/tools, and bootstrap/integration/config/protocol.
- Seven reproducible bugs reported across the first three areas. The fourth review
  found no actionable issue in its inspected scope; this is not exhaustive proof.
- Runtime fix committed (`adfdcef`).
- Coordination delegate stalled on an unsupported model; replay fix reclaimed by
  the parent and committed (`4cd59d6`).
- Presentation fixes committed: selector `c7afb1d`, model policy `0c1e544`,
  tool error rendering `d34914f`. Each regression failed before its fix.
- Steer regression from ff5a480 (boundary moved to agent_before_settle) fixed in
  `828a2a7`; later limited to turns with tool results after it widened a
  native-busy window ("Agent is already processing") for human retries.
- Parking tests realigned with plan 141 (suspension, no Moderator) and volatile
  Human attention (`31ae7be`, `24e6c56`).
- agent-view suite hang: terminating a suspended Run deadlocked because
  observe() reported it live while ending; fixed with a supervisor regression.

## Decisions

- No new scheduler, durable Human Answer protocol, security layer, or persistence
  queue. Fix the existing boundaries instead.
- A concrete child failure case defeated the asynchronous Owner suspension guard;
  queue capture must happen synchronously in the child before transport awaits.

## Outcomes

- Findings 1, 2, 4, 5 and 6 fixed with red-then-green regressions, targeted test
  files and typecheck. No full suite run.
- Finding 3: user chose volatile lifetime. Cold recovery of Human Requests
  removed (`cc8f5d6`); live reload around a retained coordinator unchanged.
- Independent review of `adfdcef~1..HEAD`: no P1/P2. Two P3 leftovers removed
  (dead target check, single-use constants module). Round complete.
- Full process suite, per file: remaining failures are pre-existing (identical at
  `26ab783`): child-runtime-settlement-continuation, execution-scheduler child
  Wait capacity, operational-incidents (Owner suspension hang + 2), pi-child-
  process-runtime hidden child, process-model-broker, quota-lifecycle-integration
  hang. run-supervision human-retry test flakes ~2/30 on baseline and now alike.
- Follow-up: all of those now pass (`9c39414..b1012b7`); fast suite and every
  process file green. Two were product deadlocks: an in-process delivery commit
  proof read its entry-count gate before Pi persisted the entry (`60c63d4`), and a
  human resume carrying an image never matched Pi's normalized content (`1ed1355`);
  both stalled the Owner's first resume while it held the Agent lane. The rest were
  fixtures stale against Pi 0.87, plan 141 suspension, the tool withhold filter,
  terminating Answers, and Identity seeding. The hang had masked one more stale
  fixture (orderly shutdown with exhausted Attention), and a pre-existing quota
  race (4/20) now waits for the owed Answer (0/20).
- Possible follow-up (not built): read-only reminder for questions lost on reload.
