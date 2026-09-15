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
- [ ] Record failing regression tests.
- [ ] Implement shared admission and both production adapters.
- [ ] Complete focused validation, documentation and independent review.
- [ ] Commit, push and create PR.

## Decisions and discoveries

- `preflightResult(true)` also means handled/queued; native `agent.prompt` signal identity is required for start ownership.
- The child already owns a compaction admission lane and native signal wrapper. Extend those contracts without replacing them with `isIdle` sampling.
- Pi's current upstream SDK docs still distinguish accepted/handled preflight from completed native work; implementation targets the installed 0.85.1 types and behavior.

## Outcomes

Pending implementation.
