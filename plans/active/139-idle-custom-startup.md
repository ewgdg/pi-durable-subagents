# Prepare idle custom-message Runs

## Goal and intention

Implement #139: first and later idle custom deliveries prepare the native Pi input and before-start lifecycle, preserving canonical Delivery metadata and prepared tools through continuations. Both Owner and process child use the same bounded preparation ownership. Active custom queues retain their existing ordering.

## Scope and constraints

- Use Pi 0.85.1 public session/Agent entrypoints; no private prompt fields, durable queue, new Message identity, or conversion dependency.
- Scope pending custom injection to one prompt invocation. Reject conflicting/reentrant prompt or idle custom startup before preparation. Release ownership before model execution, using exact invocation/native signal evidence.
- Retain child working-zone/compaction admission, cancellation, native-input wrappers, Moderator reminder episode ordering, and Owner parked-wait behavior.
- Handled or rejected kickoff commits no Delivery. Explicit retry retains the original Message and mode. Never abort/fence unrelated work or replay committed evidence.
- Investigation: `~/.agents/artifacts/outputs/pi-durable-subagents/2026-09-15/startup-solution-matrix/decision.md` and its linked actual-Pi probes. These are design evidence, not production validation.

## Work plan

1. Add regression tests at the acceptance criteria's public seams: real Pi session plus Owner hosted adapter; child Control delivery and real process runtime; scheduler Delivery/retry and existing wait/compaction behavior. Record red results before the corresponding fixes.
2. Introduce shared session-bound startup admission and one registered before-start injection hook; compose public wrappers and invalidate them on generation shutdown.
3. Integrate Owner and child custom dispatch, exact cancellation/preflight/native-start evidence, and the child Moderator reminder path.
4. Exercise adversarial preparation overlap, nested text/empty calls, handled/auth rejection/cancellation and retry, active queues, compaction, reload/disposal, and wrapper composition.
5. Document supported behavior and recovery. Run typecheck and focused suites, review the acceptance matrix, commit at meaningful boundaries, push and create a PR closing #139.

## Validation

The essential tracer starts a canonical Message or Request through the production hosted adapter, executes a real registered tool with a deterministic provider, settles, and repeats. Assert one input/preparation per idle start, guidance on both provider calls, exact custom metadata/identity and one Delivery per input. Preparation gates create deterministic overlap and cancellation windows. Existing process-child and parked-wait suites establish ordering at production boundaries. No full integration suite is planned.

Concrete design challenge: while delivery awaits a late before-start hook, another startup could change Pi's retained prompt even if final preflight later rejects. The guard must reject that competitor at both public startup entrypoints before any preparation handler executes. Nested empty prompts must not consume the outer custom delivery.

## Progress

- [x] Read issue, investigation and installed Pi lifecycle; created isolated worktree from `origin/main` at `382817a`.
- [x] Wrote ExecPlan before tests and implementation.
- [x] Record failing regression tests.
- [x] Implement shared admission and both production adapters.
- [x] Complete focused validation, documentation and independent review.
- [ ] Commit, push and create PR.

## Decisions and discoveries

- `preflightResult(true)` also means handled/queued; native `agent.prompt` signal identity is required for start ownership.
- The child already owns a compaction admission lane and native signal wrapper. Extend those contracts without replacing them with `isIdle` sampling.
- Pi's current upstream SDK docs still distinguish accepted/handled preflight from completed native work; implementation targets the installed 0.85.1 types and behavior.
- Owner first/second Message and Request regressions failed with zero input preparations instead of two before implementation. Real process-child Message, Request and Moderator-reminder tests failed on missing guidance on baseline and passed after integration, including real registered tool execution and native rendering.
- Child compaction tracer (`node --test --test-name-pattern='deferred, optional working zone.*finishes before rejection' tests/child-runtime-compaction-delivery.test.ts`) failed with one preparation instead of three before integration. Existing extension-owned replacement Runs remain supported.
- Review tests exposed busy-wait cancellation, reminder queueing, custom-wrapper bypass, and late preparation crossing reload; each failed before the corresponding correction. Keep an old generation's exclusion until its paused preparation actually exits, even after disposal/rebind.
- The user explicitly approved repair of the baseline scheduler type error (`deliveryCommitted` was removed). A public progress regression failed before switching to `committedMessageIds`.
- Process validation exposed a real native-input forwarding regression: selected-child first input forwards through the coordinator while its original input handler awaits. The correction correlates the handoff to the exact transient input submission and forces the original input handled, including failed acknowledgment. The real selected-child `/reload` test now passes through transformed native input on both generations. Owner forwarding and mismatched child sequences have focused coverage; arbitrary nested input remains rejected.
- Three selected Owner parking assertions also fail on the unmodified base; two fixtures omit required Spawn titles. Keep those unrelated repairs out of this PR and report the validation limits.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| First and subsequent Owner/child Messages and Requests, plus Moderator reminders | `idle-custom-startup.test.ts`, `idle-custom-process-startup.test.ts`; real Pi and process child, actual registered tool execution with deterministic provider |
| Prepared guidance survives tools; custom fields/identity/renderer and one Delivery | Both startup suites assert per-run input/preparation, provider contexts, persisted custom fields and empty kickoff order; process test reads native renderer |
| Handled/auth/cancelled startup and explicit recovery | Owner startup tests, child lifecycle/compaction tests and `delivery-failure-notice.test.ts`; same-ID/mode retry, no automatic replay, no settlement required for failed reservation cleanup |
| Nested and competing prompt/custom entries; active queue ordering | Owner gates at input and late preparation, child compaction/gateway busy race, existing Steer/Wait and Deferred ordering process suites |
| Exact native ownership, compaction, reload/disposal and wrappers | Child authoritative lifecycle plus working-zone replacement matrix; Owner retired-generation gate and prompt/custom wrapper tests; real selected-child `/reload` PTY |
| Plan/tests first, docs and scope | This plan preceded implementation; red evidence recorded above; maintained behavior is in `docs/agent-messaging.md`; only extra repair is the explicitly approved scheduler field correction |

Final focused command used Node's test runner with `--import ./tests/support/pi-test-environment.ts --test --test-concurrency=1` over these files in `tests/`: `idle-custom-startup`, `idle-custom-process-startup`, `child-runtime-compaction-delivery`, `child-authoritative-lifecycle`, `child-turn-compaction-gateway`, `moderator-reminder-admission`, `in-process-hosted-runtime`, `owner-parked-delivery-scheduler`, `stale-moderator-reminder-delivery`, `delivery-failure-notice`, and `control-protocol-schemas` (all `.test.ts`). **144 tests passed in 7.8 seconds.** Later hardening of handoff assertions passed all 9 child lifecycle tests. `npm run typecheck` and `git diff --check` passed.

Separate existing process checks passed 5/5 across `steer-request-preemption`, `deferred-request-after-answer`, and `child-runtime-settlement-continuation`; selected Owner reload checks, child transformed-input preflight, and the selected-child `/reload` PTY also passed. The full integration suite was not run. The implementation does not claim renewed live-provider/conversion validation beyond the investigation's external probes.

## Outcomes

Implementation and focused validation complete. Publishing the committed branch and PR is the remaining handoff step.
