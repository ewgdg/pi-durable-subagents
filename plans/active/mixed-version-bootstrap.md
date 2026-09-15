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

## Outcomes

Pending implementation and validation.
