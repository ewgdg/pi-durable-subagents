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

## Decisions

Repairing an old rejected Request can resurrect obsolete work on later recovery.
The prior audit/no-automatic-resume safeguards do not prevent this. Remove that
behavior rather than add another normalization path or confirmation prompt.
