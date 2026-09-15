# Quota-exhausted Run suspension

## Goal and intention

Implement #137: known exhausted quota pauses the affected Run instead of treating it as terminal Run Failure and spending more model calls on moderation. Keep unrelated Workflow work runnable.

## Scope and constraints

- Classify only evidence-backed quota codes or the exact known provider diagnostic, never generic HTTP 429 or arbitrary limit text.
- Let Pi's configured retry/fallback finish first. Preserve Run identity, transcript, Requests, Answer Obligations, and queued work without replaying effects.
- Suspension is distinct from an Interruption Hold. Only explicit resume releases it; reading its notice does not.
- Persist suspension for cold recovery. Define capacity, cancellation, termination, dependency moderation, and native input behavior.
- Do not modify installed provider packages. Record any necessary upstream structured-error improvement explicitly.

## Work plan

1. Evidence adapter slice: normalized evidence through native session, child Control, and hosted runtime events, with targeted tests.
2. Lifecycle slice: supervisor suspension, durable recovery, explicit controls, scheduling/capacity and dependency moderation gates, with regression tests.
3. Presentation slice: selected status, one acknowledgeable Runtime Report per continuous suspension, user-facing documentation.
4. Integration review: exercise native/process-hosted paths and focused existing regressions, typecheck, commit all task-owned work.

## Validation

The issue specifies the seams: native and process-hosted lifecycle admission, coordination observation/control, and notice acknowledgement. Test exact observed Codex text, structured quota codes, temporary throttling, and unrelated terminal errors. Assert no implicit wakeups or reminder/Moderator loops, preserved Requests, unrelated progress, explicit resume, and unchanged suspension after notice read. Avoid the full slow integration suite.

## Concrete failure cases

- A parent awaiting a suspended child must not attract a Moderator, but a separate stalled child must still do so.
- Native automatic retries must not be prematurely converted to suspension.
- Cold recovery and human notice acknowledgement must not become implicit permission to run the model.
- A suspended child must release execution capacity without ending its Run.

## Progress

- Initial issue and current hosted-runtime seams inspected. Current code already carries terminal failure diagnostics; implementation must extend that evidence instead of duplicating it.
- Evidence and lifecycle slices assigned separate ownership; parent owns presentation, documentation, and final review.

## Decisions and outcomes

Pending implementation and verification.
