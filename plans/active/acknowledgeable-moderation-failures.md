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
