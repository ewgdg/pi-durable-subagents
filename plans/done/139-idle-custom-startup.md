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
- [x] Commit, push and create PR.

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
- Both selected held-child supervision tests (`a native human editor Message clears its exact Hold for one isolated turn` and `a failed native human resume dispatch leaves its exact Hold retryable`) also fail on the unmodified base during initial child spawn, before reaching native resumption.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| First and subsequent Owner/child Messages and Requests, plus Moderator reminders | `idle-custom-startup.test.ts`, `idle-custom-process-startup.test.ts`; real Pi and process child, actual registered tool execution with deterministic provider |
| Prepared guidance survives tools; custom fields/identity/renderer and one Delivery | Both startup suites assert per-run input/preparation, provider contexts, persisted custom fields and empty kickoff order; process test reads native renderer |
| Handled/auth/cancelled startup and explicit recovery | Owner startup tests, child lifecycle/compaction tests and `delivery-failure-notice.test.ts`; same-ID/mode retry, no automatic replay, no settlement required for failed reservation cleanup |
| Nested and competing prompt/custom entries; active queue ordering | Owner gates at input and late preparation, child compaction/gateway busy race, existing Steer/Wait and Deferred ordering process suites |
| Exact native ownership, compaction, reload/disposal and wrappers | Child authoritative lifecycle plus working-zone replacement matrix; Owner retired-generation gate and prompt/custom wrapper tests; real selected-child `/reload` PTY |
| Plan/tests first, docs and scope | This plan preceded implementation; red evidence recorded above; maintained behavior is in `docs/agent-messaging.md`; only extra repair is the explicitly approved scheduler field correction |

The final repair focused command used Node's test runner with `--import ./tests/support/pi-test-environment.ts --test --test-concurrency=1` over these files in `tests/`: `idle-custom-startup`, `startup-wrapper-composition`, `idle-custom-process-startup`, `child-runtime-compaction-delivery`, `child-authoritative-lifecycle`, `child-turn-compaction-gateway`, `moderator-reminder-admission`, `in-process-hosted-runtime`, `owner-parked-delivery-scheduler`, `stale-moderator-reminder-delivery`, `delivery-failure-notice`, and `control-protocol-schemas` (all `.test.ts`). **160 tests passed in 9.5 seconds**, including all 15 child lifecycle tests. `npm run typecheck` and `git diff --check` passed.

Separate existing process checks passed 5/5 after the guard-first repair across `steer-request-preemption`, `deferred-request-after-answer`, and `child-runtime-settlement-continuation`; selected Owner reload checks and child transformed-input preflight passed; the real selected-child `/reload` PTY was rerun successfully after the repair. The full integration suite was not run. The implementation does not claim renewed live-provider/conversion validation beyond the investigation's external probes.

## Outcomes

Implementation, focused validation and publication complete. [PR #141](https://github.com/ewgdg/pi-durable-subagents/pull/141) contains the committed `codex/139-idle-custom-startup` branch and closes #139. Platform CI results are tracked on the PR.

## Independent review repairs

Reopened after independent review at `9100af8`. The initial review challenged wrappers that captured unguarded Pi methods before startup admission bound. The user explicitly selected a guard-first contract: bind our guard first; callers use current public session methods; later wrappers may capture and delegate their already guarded predecessor. Previously captured unguarded methods are outside this contract. Reload must preserve the guarded wrapper chain.

This ordering makes cancellation enforceable immediately before native Run allocation. An asynchronous outer wrapper may await, but must eventually enter our stable guard before Pi allocates its signal or awaits extension start hooks. Retain invocation and cancellation provenance across reload; reject delayed old-generation forwarding before it starts. If native work already started, cancellation targets only its exact signal.

Retain the public seams: actual Pi sessions through Owner hosted delivery and process-child Control delivery, with committed transcript evidence. Replace the broader compatibility attempt with stable custom/native forwarding entries and synchronous native-start callbacks for child ownership. Remove superseded subscriber and delayed signal inference machinery. No upstream Pi change is required under the accepted contract.

- [x] Record failing guard-first cancellation and reload regressions before implementation.
- [x] Implement stable guards and child cancellation integration.
- [x] Run focused regression/lifecycle checks and typecheck.
- [x] Obtain fresh independent review of the final diff.
- [x] Update documentation/PR, commit and push all repairs, and verify platform CI.

Concrete failure case: abort while a later native wrapper pauses, then release it toward an `agent_start` hook that waits for abort. The cancelled call must never reach that hook, the model, or a committed Delivery. Cover both custom and user delivery. A separate case reloads while that wrapper pauses; the old invocation must be rejected while a fresh delivery still traverses the retained wrapper and succeeds.

Guard-first red evidence: the Owner cancellation probe entered the abort-waiting native hook; both child custom/user probes counted one native start instead of zero; delayed custom forwarding across reload lost its cancelled dispatch attribution. Independent review also reproduced a cloned-message wrapper committing Delivery and then reporting failed startup. Each regression was added before its fix. The stable guard now rejects delayed cancelled forwarding before native entry, shares origin context across reload, and attributes a cloned forwarded argument to its original dispatch.

A module re-evaluation regression reproduced a JavaScript private-method receiver error when delayed old-generation forwarding reached the new guard. Each invocation now carries a checkpoint closure bound to its originating generation. Fresh independent review found no remaining actionable issues under the agreed contract and separately passed cloned-message forwarding, three-generation custom/native wrapper composition, and the module re-evaluation regression.

The accepted repair is committed as `feb554a` (regressions) and `baba060` (implementation), and both Windows and macOS Control transport jobs passed at `baba060`. The final documentation commit records the contract and completed evidence; PR checks track its final head. The four unpublished broader compatibility candidate commits were removed from branch history before publication.
