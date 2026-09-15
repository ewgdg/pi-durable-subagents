# Terminal Run failure reports

## Goal

Implement issue #136: retain an acknowledgeable explanation of every unexpected terminal Run failure, independently of whether it qualifies for moderation.

## Scope and constraints

- Reuse the Owner report store, read state, history, and copy surfaces.
- Preserve exact Run identity, original error/stage/provenance, affected work, and recovery uncertainty.
- Group failed Moderator attempts with their originating incident; do not recursively moderate them.
- Keep immutable evidence and link later findings without rewriting the original report.
- Reading a report must not clear live conditions or change Requests or recovery.
- Preserve existing moderation eligibility and native Owner transcript persistence; exclude deliberate termination, successful native retries, and recognized quota suspension.
- Do not expand into general lifecycle-hook containment.

## Work plan

1. Trace existing runtime failures, moderation, and report retention.
2. Add focused regressions and implement failure capture, reporting/grouping, and later findings.
3. Independently review evidence boundaries, duplicate observations, read/live separation, and native cold reconstruction.
4. Update maintained documentation, run targeted tests and typecheck, and commit task-owned changes.

## Design challenge

A startup failure may occur before the child can append any transcript error. A pointer to the child's tail cannot explain this failure. Preserve the host-observed error at the failure boundary and retain that evidence in the Owner report path. Likewise, a report read before a recovery attempt fails must remain acknowledged: later findings need an explicit linked-history policy, not another unacknowledgeable attention row.

## Validation

Target failures with and without obligations; startup without child-side evidence; grouped Moderator failures; repeated observations versus distinct Runs; read while unresolved; recovery after publication; native persisted Owner cold reconstruction. Run focused runtime/report/moderation/presentation suites and TypeScript checking, not the full integration suite.

## Progress

- Inspected issue #136 and existing report/coordinator interfaces. Source and test implementation delegated as one bounded unit; parent owns documentation, independent review, and commit.
- Implemented host-side failure details, pre-runtime startup Run identity, immediate reports independent of obligations, grouped Moderator attempts, append-only findings, and cold historical linkage.
- Independent review caught a dock-only competing ATTENTION row. Fixed and covered both read/unread states, preserving separate live status.
- Reproduced same-Request-set recurrence reusing a read report. Separated current handling source from historical snapshot ownership; late old Moderator failures stay with their original report.
- Updated maintained moderation, supervision, and selector documentation. Added a process-schema roundtrip regression for findings and live report linkage.
- Validation passed: 98 focused runtime/report/protocol/surface tests; 24 additional parent-run compatibility tests; 17 dock tests; six selected operational regressions, three additional exclusion/recurrence cases, and two cold grouping cases. Some selections overlap. Typecheck and whitespace checks passed. No full suite was run.

## Decisions and outcomes

- Reports and dated findings are immutable separate Owner custom entries; findings do not change read state. Reopening/copying a report includes retained findings.
- Cold Moderator linkage uses validated committed Input and retained incident identity, not reconstructed timers, attempt budgets, or live handling.
- Native persistence is unchanged: before the first real Owner assistant entry, custom report/read/finding entries share Pi's in-memory lifetime.
- Installed Pi has no structured terminal quota-suspension discriminator. Preserve retry/termination signals and active provider recovery; do not guess from provider error strings. This external limitation is documented.
- Existing failing shutdown test reports `stale_run: native-run-2`; four existing deadlock/reconciliation cases also fail on pristine HEAD. Kept unrelated baseline failures out of scope. A separate existing Owner-failure fixture hit a thinking-level roster invariant and was not claimed as independently baseline-verified.
- Verification logs, including pristine baseline evidence, are retained under `~/.agents/artifacts/outputs/pi-durable-subagents/2026-09-15/136-run-failure-reports/`.

Final successor-after-clearance regression passes: recovery observations use the failed Run's retained source even after live handling is released. Final handoff check passed TypeScript checking, whitespace checks, and 107 focused tests. Implementation and documentation are ready for commit; unrelated baseline failures remain unchanged.
