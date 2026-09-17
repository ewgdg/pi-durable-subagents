# Quota-exhausted Run suspension

Historical implementation record: the command-only human resumption, cold read-only quota view, suspension notice, and durable cold-restored suspension described below are superseded; suspension now publishes no Runtime Report and is process-local. Current supported behavior is documented in `docs/run-supervision.md`.

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
- Normalized quota evidence now crosses native, child Control, and hosted-runtime seams; terminal adapters synchronously remove and retain queued native input before transport can lag behind native continuation.
- Durable stop, explicit resume, execution-capacity release, dependency-path moderation suppression, acknowledgeable reports, and cold read-only views implemented. `/quota-resume` is a human-only Owner escape path, not broader Moderator authority.
- Native/process integration exposed a closed status schema omission: suspended roster responses blocked unrelated child startup. Schema and regression fixed.
- Independent review found retained OpenAI/Azure formatter and Codex code-only evidence gaps; both fixed against actual installed provider formatter behavior.
- Cold shutdown/reopen integration passes, including unchanged read notice, intact Requests, no navigation/recovery wakeup, and exact-Run explicit resume.
- Final review found resume outcomes arriving before transcript confirmation. One captured outcome now handles success, renewed quota, ordinary failure, and aborted pre-confirmation attempts; all regression tests pass.

## Decisions and outcomes

Retain a quota suspension as a distinct exact-Run stop, not terminal failure or a human-issued Interruption Hold. Preserve configured native recovery and fail conservatively when provider formatting has discarded evidence. Provider structured code/type/reset retention still needs an upstream improvement; installed dependencies remain untouched.

Final validation after the race fixes:

- Typecheck and `git diff --check` pass.
- 33 targeted quota host/store/incident/report/native-adapter/Control tests pass.
- 94 presentation and Control tests pass (overlaps the focused group).
- All 7 native/process Workflow lifecycle cases pass, including independent child execution at capacity one, repeated quota and notice acknowledgement, native retry, native editor fences, original Requests, and unrelated failure progress.
- Persistent cold-recovery integration passes. Native/real-child adapter tests also exercise terminal queue retention and configured retries.
- No full integration suite run. Selected legacy workflow-resume, deadlock/reconciliation, and run-supervision cases failed during investigation; delegates reproduced them on unchanged baselines. These are not claimed fixed by #137. A separate configured fallback fixture was not added; configured retry and untouched native fallback delegation are covered.

Implementation commits: `402c916`, `bf487d5`, `167d547`, `d85e433`, `856533e`, `2f0d9af`, `94da6a6`, `a5cf961`, `fdf40dc`, `0edf2c3`, `f34e4f3`, `11ba6ce`.

## Retrospective

The important failures were not classifier-only: closed presentation schemas could stop unrelated startup, and resume confirmation could lag all three terminal outcomes. Real process tests and independent review caught both classes. Suspension is now a retained execution permission decision, while notice acknowledgement remains a separate human-facing fact.
