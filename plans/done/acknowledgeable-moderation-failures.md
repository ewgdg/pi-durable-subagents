# Acknowledgeable moderation failure reports

## Goal and intention
Replace unavailable moderation's unacknowledgeable inbox row with one durable runtime-authored Report, preserving a separate live unavailable status. Reading acknowledges a notification, never operational recovery.

## Scope and constraints
Reuse the retained report store, read events, selector/history, report surface and Control snapshot. Preserve native Moderator report tool-call provenance and bounded handling. No installed-extension or live Workflow changes. Exhausted handling remains unchanged. Reports carry runtime diagnostic-entry provenance, not an invented Agent or tool call.

## Work plan
1. Extend retained report provenance and Control schema for runtime diagnostics; test cold reopen and source idempotence.
2. Publish a captured failure explanation at the existing fault transition; test initial inspection uncertainty, creation before first Moderator, read during fault, delayed completion and recurrence.
3. Separate live status from inbox, expose runtime reports without reporter navigation, verify read/copy/history behavior and remote snapshots.
4. Document supported behavior and domain terms; run focused checks, record outcomes, commit task changes.

## Validation seams
User-authorized real seams: report publication/history/read via store; Workflow Owner report/attention interfaces with existing incident boundary hooks; report and selector TUI input/render; Control snapshot validation. Use one red/green slice at a time. Targeted tests only, not the slow integration suite.

## Concrete failure challenges and decisions
- Reading during a continuing fault must not dismiss live status or reset creationFailed/attempt count; dedup remains keyed to the active fault, not unread reports.
- Inspection before any established incident must explicitly say trigger and Request graph unknown, with no invented affected Owner. Owner is only the diagnostic/report host.
- Creation can fail before a Moderator Identity commits; retain original captured trigger, request references, stage, zero attempts and no known Moderator.
- Deadline observation is not terminal failure. A delayed successful creation can clear live status while its immutable report truthfully records the earlier uncertainty.
- Clearance then recurrence gets a new diagnostic source and report. Cold recovery retains reports/read state, not transient incident handling.
- Runtime reports must validate and render through process Control and offer no fake reporter navigation.

## Progress
- Read codebase-design, tdd (and tests/mocking), domain-modeling and context-format skills; inspected report, incident, presentation and Control seams.
- Initial shell-tool discovery was misleading; direct tools.exec_command through exec works. No changes outside repository.
- First vertical slice: runtime diagnostic reports reuse report/read records and source-idempotent publication. Red test failed on missing publishRuntime, then all 8 protocol/store tests passed; report surface runtime-navigation regression was red, then all 10 surface tests passed. Control schemas exercise runtime/native provenance separation.
- Baseline typecheck failure: message-delivery-scheduler.ts:1170 references missing ActivePromptDelivery.deliveryCommitted. Task-owned type errors have been resolved; baseline left untouched.
- Fault transition slice: targeted runtime tests are green for original Delivery trigger before first Moderator commit, acknowledgement during fault, recurrence after clearance, initially unknown incident, and delayed replacement completion with prior-attempt evidence. Existing handling is also included when a later evidence inspection fails; captured facts are explicitly not revalidated.
- Live status is now separate from inbox rows in activity and selector surfaces; runtime Reports share existing read/history operations and have no reporter navigation. Focused UI red/green verifies inbox removal and history toggle without hiding live status.
- Persistence discovery and decision: a cold-reopen test before any Owner assistant message exposed Pi's deliberate delayed persistence. Preserve native Owner persistence semantics: no private flush, synthetic assistant, or materialization adapter. Runtime report/read entries before the first assistant share native in-memory lifetime. Cold recovery is tested with an already persisted Owner transcript that has no established incident. A separate early-publication test confirms acknowledgement works in memory and persists with the first real assistant response; documentation states this limitation.
- Worker continuation was blocked by an installed child/bootstrap protocol mismatch. Parent reviewed and finished the existing changes without touching the live installation.
- Review added plain-language explanations of why each incident triggers moderation, alongside captured trigger evidence. Two regression assertions failed without that explanation and passed afterward. A missed replacement-bootstrap attention assertion was updated to check the Report and its independent live status.
- Review preserved the Control contract that an established incident must identify an affected Agent; only unavailable inspection may have none. Its regression failed against the initially broadened schema, then passed with distinct schema branches.

## Validation and outcomes
- Foundational provenance/read-state implementation committed as `c35c54a`.
- `node --test tests/moderator-report.test.ts tests/moderator-reports.test.ts tests/moderator-report-surface.test.ts tests/moderator-report-integration.test.ts tests/control-protocol-schemas.test.ts tests/agent-selector-surface.test.ts tests/agent-activity-surface.test.ts tests/remote-agent-selector.test.ts tests/operational-incident-surface.test.ts`: 118 passed.
- Focused `operational-incidents.test.ts` selection covering original-incident reporting, continuous-fault acknowledgement and recurrence, inspection timeout, blocked replacement completion, and failed replacement bootstrap: 5 passed.
- Broader `operational-incidents.test.ts` selection (`blocked Delivery|moderation evidence|moderation inspection|replacement|exhausted Operational Attention`): 18 passed, 1 pre-existing failure. The leaf-termination test's expected parent `agent_wait` state also fails on pristine `eecdc2a`.
- Adjacent answered/deferred-deadlock and reconciliation tests have 7 pre-existing failures across 8 tests, independently reproduced on pristine `eecdc2a`. Reconciliation diagnostics identify missing reconstructed Creation Request spawn input. No unrelated fixture/runtime repairs included.
- `npm run typecheck` reports only the existing scheduler `ActivePromptDelivery.deliveryCommitted` error; reproduced on pristine `eecdc2a`. `git diff --check` passes. No full integration suite run.
- Reports now capture runtime diagnostic provenance, known incident/Agent/Request and Moderator-attempt evidence, failed stage, uncertainty and observed outcome. They share explicit read/unread and history with native Moderator reports without impersonating a reporter or adding invalid navigation.
- Acknowledgement never retries, clears live faults, changes attempt bounds or claims recovery. Deduplication survives acknowledgement within the continuous fault; clearance then recurrence creates a new unread Report.
- Live installation and existing Workflow alerts were not migrated, reloaded or repaired. Native Owner persistence remains the documented prerequisite for cold history.
