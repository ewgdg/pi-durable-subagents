# Child launch probe and permanent-block reporting

## Goal

Restore child and Moderator launches from a normal Pi-managed installation and make permanent launch rejection visible to the human without relying on an Owner model following tool-result prose.

## Intention

Keep fresh on-disk contract verification and factory-lifetime rejection. Share one dependency-free bootstrap contract between validation and the probe. Publish one durable Runtime Report when the launch guard first blocks, using the existing unread-report attention surface.

## Scope and constraints

No dependency installation workaround, host-loader reimplementation, automatic Owner abort, or changes to active Runs. A report informs the user; it does not grant recovery authority or retry launches. Preserve sanitized diagnostics and avoid descriptor/connection-token disclosure. Commit task-owned changes after focused validation.

## Work plan

1. Write an installed-layout regression that fails because the probe resolves host-owned TypeBox as a physical package.
2. Extract a dependency-free canonical contract and point the fresh probe at it, preserving runtime validation types and drift detection.
3. Add exactly-once blocked notification to the guard, wire it through the child factory to a durable Runtime Report, and notify existing report presentation.
4. Test permanent launch failure through real coordinator/spawn behavior: immediate unread report, no child creation, retry deduplication, read state and cold persistence.
5. Update maintained docs, run focused probe/report/containment/schema tests and typecheck, review, and commit.

## Concrete failure cases

A retry or concurrent failed probe must not publish duplicate reports. A low-level recheck failing after preparation must still report. Reading a report must not unlock the guard. A normal managed installation without local TypeBox must pass, while on-disk version/schema changes still reject.

## Progress

- Diagnosis confirmed: workspace and managed installation share commit 4b25976; only installed plain-Node schema import fails with ERR_MODULE_NOT_FOUND for TypeBox. Two repeated public guard probes confirmed the differential.
- Installed-layout test reproduced the exact probe error through Pi's public extension loader before the fix, then passed with the canonical dependency-free contract.
- Public coordinator/spawn test reproduced zero reports before the reporting fix, then verified immediate unread attention, no child creation, retry deduplication, acknowledgement, and cold persistence.
- Independent review found that unsaved Owners lack report provenance. A second public test reproduced the reporting exception masking the original failure; the fix now sends one native UI notification with the preserved diagnostic in that mode.
- Shared recovery guidance now requests package alignment only when incompatible; probe failures include bounded safe classifications.

## Validation

- Passed all 11 launch guard/containment cases, including installed layout, version/schema drift, concurrent latching, a real five-second probe deadline, durable reports, and unsaved-host notification.
- Passed 28 control-schema and report storage/validation/presentation cases.
- Passed two existing operational-report regressions and the real subprocess ordinary production spawn case.
- Whole-project typecheck and whitespace check passed. Full integration suite was not run.

## Surprises and decisions

The existing malformed-bootstrap test fixture lacked Pi's startup event registration method; adding its no-op `on` lets the test reach descriptor validation again.

Saved sessions use the existing durable Runtime Report and Attention Inbox. `--no-session` explicitly preserves nonpersistence and sends a direct native UI error notification, with an in-memory diagnostic, instead of inventing a transcript path. No automatic Owner interruption was added.

## Outcomes

Child preflight no longer requires physical copies of host-supplied peer dependencies. The runtime itself alerts the human on permanent rejection. Existing version/schema compatibility checks, secrecy, and blocked launch behavior remain intact. Changes are validated in the workspace and isolated installed-layout harness; the user's installed extension and running Pi hosts have not been modified.
