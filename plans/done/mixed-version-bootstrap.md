# Mixed-version child bootstrap (#135)

## Goal and intention

Reject incompatible child launch contracts clearly and stop repeated failed child
and diagnostic launches when an installed extension changes under a live Owner.
An incompatible launch is not evidence that a canonical Request should be
replayed, cancelled, or rewritten.

## Scope and constraints

- Version incompatible bootstrap schema changes, including required `tools`.
- Distinguish protocol-version mismatch from same-version schema drift. Report
  expected/received versions and missing/invalid fields without descriptor values
  or connection tokens.
- Check the launch contract before admission where feasible and prevent known
  incompatible paths from launching a Moderator or repeated successor Runs.
- Preserve exact-Run identity and immutable protocol evidence.
- No implicit migration, `allowedTools` alias, quota classification, or report
  presentation redesign.

## Concrete failure case

An Owner retains loaded version-7 producer code while its child bridge is loaded
from an updated installation. An in-memory version comparison in the Owner alone
cannot detect the changed consumer. Admission must account for the consumer that
will actually launch; a startup rejection must also contain later launch churn.
Existing running Owners predating the fix cannot gain new checks retroactively.

## Work plan

1. Add and run targeted failing regressions for schema/version diagnostics and
   repeated resume/cancellation launch containment.
2. Implement versioned bootstrap validation and launch compatibility containment.
3. Document a safe upgrade sequence and first-upgrade limitations.
4. Review the implementation and run targeted regression suites and typecheck.
5. Commit task-owned changes and record outcomes here.

## Validation

- Old producer/new consumer rejects; matching producer/consumer launches.
- Same-version missing/invalid fields differs from a genuine version mismatch.
- Diagnostics do not reveal connection tokens or descriptor contents.
- Repeated resume and cancellation attempts do not create diagnostic launch churn
  or mutate canonical Request evidence.
- Run affected tests only; avoid the full slow integration suite.

## Progress

- Issue scope and existing upgrade/reload guidance inspected.
- Source/test implementation delegated as one unit; documentation and final
  independent review remain with the Owner.
- Safe-upgrade guidance committed in `a14cef9`.
- Initial runtime implementation committed in `068cb65`: protocol 8, a fresh
  Node schema probe, factory-scoped rejection, and checks before preparation and
  low-level launch. Targeted schema, transport, and matching process startup tests
  pass.
- Independent review requested explicit preflight field diagnostics and a test
  through real Request/resume/cancellation calls, beyond shared host admission.
- Typecheck has an independently reproduced baseline failure:
  `message-delivery-scheduler.ts:1170` reads `deliveryCommitted`, absent from
  `ActivePromptDelivery`. The clean HEAD archive fails identically; unrelated
  scheduler work remains outside this issue.

## Decisions and limits

- Probe the installed schema in a fresh Node process rather than trusting a
  cache-busted import with potentially stale transitive dependencies.
- Latch incompatibility for the factory lifetime; successful checks are not
  cached. No implicit repair or migration follows file restoration.
- The preflight is not an atomic installation lock. Already-live Runtimes remain
  untouched, and pre-fix Owners cannot acquire these checks retroactively.

## Outcomes

- Completed in runtime commits `068cb65` and `f418b8e`, plus the upgrade guidance.
  Independent review verified named-field diagnostics and the real coordinator
  acceptance test. A canonical Creation Request survives repeated Workflow resume
  attempts, explicit cancellation, same-identity cancellation retries, and repeated
  cancellation without new process launches, Moderator identities, or fabricated
  child transcript evidence. Only the explicit user cancellation changes its
  cancellation state; failed launch admission is not cancellation authority.
- Final independent checks: 52 passing focused tests and 4 platform skips across
  bootstrap/contract/transport tests, the canonical recovery regression, and five
  real Pi startup cases. `git diff --check` passes. The full suite was not run.
- Commands (from the repository root):

  ```sh
  node --import ./tests/support/pi-test-environment.ts --test \
    tests/child-launch-contract.test.ts \
    tests/child-launch-contract-containment.test.ts \
    tests/control-protocol-schemas.test.ts tests/agent-control-channel.test.ts \
    tests/unix-control-transport.test.ts tests/named-pipe-control-transport.test.ts
  node --import ./tests/support/pi-test-environment.ts --test \
    --test-name-pattern='workflow resume and cancellation retain canonical' \
    tests/run-supervision.test.ts
  node --import ./tests/support/pi-test-environment.ts --test \
    --test-name-pattern='resolves unset Moderator|startup checks exact initial tools' \
    tests/pi-child-process-runtime.test.ts
  npm run typecheck
  ```

- Typecheck remains blocked only by the confirmed baseline scheduler error noted
  above. The implementor also reproduced the existing broader exact-TUI-session
  test's missing `executionStarted` intention on clean HEAD; the targeted matching
  startup cases pass, without expanding this issue into runtime execution work.
