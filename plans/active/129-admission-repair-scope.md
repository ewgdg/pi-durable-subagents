# Admission-failure-only repair

## Goal

Retarget PR #143 to the user's actual requirement: repair admission-blocking
transcript damage, not rejected coordination records that skip-and-mark already
handles. PR is draft until this scope and its regression tests are corrected.

## Constraints

- Successful admission means no repair: no helper/model call or transcript edits.
- Rejected historical records retain their existing inert meaning and content.
  No rejected-to-accepted normalization, info-only conversion, stale Requests,
  new obligations, or altered recovery ordering may be introduced by repair.
- Actual transcript admission failure is required; configuration/model/cleanup
  failures are diagnosed, not rewritten as transcript problems.
- Keep same-terminal Node-only lifecycle, one command authorization, strict
  retirement, backups/journal, commit-before-reopen and operator recovery.
- Certification must prove a bounded evidence-preserving correction; unknown
  historical intent or unverifiable identity still refuses.

## Implementation approach

Use an existing real admission failure as the first supported repair class:
duplicate valid Message Delivery envelopes. Exact duplicate evidence can be
collapsed without inventing a Request or choosing between conflicting bodies.
Conflicting duplicates remain unsupported. Validate this approach against normal
admission and reference/ordering semantics before enabling it. Preserve all
unrelated evidence, especially rejected records and later work.

1. Replace the validator's rejected-record restoration with a strict supported
   correction certificate and invariant tests.
2. Gate command/bootstrap on actual failed transcript admission, revise helper
   instructions, and rebuild real CLI acceptance cases around that failure.
3. Verify normal admission with rejected records is a no-op; stale Request
   resurrection is rejected even when another supported fault is repaired.
4. Independently review, update current docs/PR and create a genuine blocked
   real-model test scenario. Do not modify the user's currently open test files.

## Validation

Focused supervised validator/lifecycle/real CLI tests, typecheck, and installed
package smoke. No full suite. The acceptance signal is a real blockage widget and
admission failure before repair, then successful fresh admission afterward—not a
model report, synthetic diagnostic, or a repaired record that never blocked.

## Progress

- PR #143 converted to draft; no code correction is claimed yet.
- Existing Owner-bootstrap tests already demonstrate duplicate valid Deliveries
  causing a real strict protocol admission failure and the warning widget.
- Command preflight now retains the actual OwnerRecoveryError on its native
  manager; healthy/rejected-only admission returns without helper creation,
  input retirement or mutation. Configuration failures refuse separately.
- Added red/green admitted-Owner command tests and real CLI no-op cases. Rebuilt
  positive CLI fixture from strict duplicate-Delivery admission failure; its
  expected successful repair failed against the old validator, then passed
  after integration of the independently reviewed certificate at `9eda9cb`.
- Helper now certifies the sealed full generation before any model call. It
  passes correction constraints, never prewrites the deterministic reference
  into candidate files. Actual Moderator tool calls propose the correction;
  final validation independently recomputes the certificate.
- All 12 actual CLI scenarios pass: healthy/rejected-only/configuration no-op,
  actual blocked admission and correction, preservation of older rejected work
  and dormant child evidence, repeat no-op, bash/cleanup/parking cancellation,
  postcommit admission failure, acknowledged cancellation recovery and killed
  helper recovery. Restoring blocked originals correctly remains unadmitted.
- Strict new helper startup refuses old pre-gate launch records. The separately
  approved archive reader permits only inspection/existing-journal recovery.
- Focused checks pass: 41 validator/native, 30 bootstrap (known capacity baseline
  excluded), 3 helper-process, 8 retirement/lifecycle, 7 diagnostic-surface,
  22 storage, 9 process-factory (known Moderator timeout excluded), 7 package
  contract tests, plus typecheck. No full suite was run.
- Actual npm-packed `node_modules` smoke passed 3 cases: blocked duplicate
  correction, older rejected-history preservation, and rejected-only no-op.
  Independent lifecycle retarget review approved `0c3c14b` with no blockers;
  reviewer reran 16 scoped checks and inspected certificate-before-model order
  and archive isolation. Parent owns final current-document/PR consolidation.

## Decisions

Repairing an old rejected Request can resurrect obsolete work on later recovery.
The prior audit/no-automatic-resume safeguards do not prevent this. Remove that
behavior rather than add another normalization path or confirmation prompt.
