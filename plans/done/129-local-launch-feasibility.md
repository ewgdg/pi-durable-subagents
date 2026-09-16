# #129 — prove local repair launch integration before choosing it

## Goal and intention

Determine whether project-owned launch integration around unmodified Pi can
support safe transcript replacement at a cost worth accepting. This is a
disposable feasibility investigation, not authorization to implement repair.

The user excludes upstream changes and asks for executable evidence before
deciding whether the local-launcher proposal is worth its complexity.

## Scope and constraints

- Use stock installed Pi 0.85.1 and disposable sessions/configuration only.
- No model calls, live transcript replacement, upstream modifications, or
  production runtime changes.
- Keep executable probes on `prototype/129-local-repair-lifecycle`, outside the
  main branch; retain durable source findings and the evaluation in `docs/`.
- Exercise real process/file behavior rather than an HTML state simulation.
- A toy journal and fixture participant may prove mechanisms, not the real
  Workflow's complete admission or writer ownership.
- Do not turn an unproved case into a silent fallback or a positive safety claim.

## Work plan

1. Inventory current launch, shutdown, native navigation, and bootstrap write
   paths. Separate reusable mechanisms from new requirements.
2. Build a bounded executable probe covering final shutdown writes, same-path
   fresh reopen, managed-start exclusion, surviving writers after supervisor
   death, interrupted two-file replacement, unknown bytes, and failed bootstrap
   acknowledgement. Establish each assertion before exercising it.
3. Review the probe's guarantees against the actual project process topology and
   the existing repair proposal. Distinguish clean-path success from crash safety.
4. Record observed outcomes, remaining gaps, complexity by work area, and a
   revised recommendation. Do not create implementation issues or implement the
   launcher before the user decides.

## Validation

Only run the scoped disposable probes, with bounded process deadlines and cleanup
limited to their own processes. No full integration suite is needed for a
documentation/prototype investigation. Check documentation diffs and commit all
task-owned main-branch documentation separately from prototype code.

## Progress

- [x] Read the existing repair and Pi replacement research, public Pi lifecycle
  documentation, and current project launch/shutdown paths.
- [x] Create isolated prototype branch/worktree and delegate executable proof.
- [x] Review executable evidence and identify unsupported claims.
- [x] Record complexity evaluation and recommendation.

## Initial findings to test

- Real project participants use separate PTY process groups. Waiting for the
  Owner process alone does not establish that every participant is gone.
- The repository already has graceful participant shutdown and process-group
  cleanup. Test-only cgroup/guardian infrastructure shows why supervisor death
  cannot be treated as an ordinary clean shutdown.
- A launcher-only startup check does not cover native in-process `/resume` or
  other entry routes automatically.
- Stock Pi may append a missing thinking-level entry during runtime creation,
  before `session_start`. Cold restart therefore does not itself prove the
  original proposal's no-writes-before-admission condition.

## Decisions

No production design selected. The prior weighted matrix's strong recovery
scores are not validated: the small launcher fails mandatory safety conditions.
Recommendation is to defer a production launcher for repair alone rather than
silently relax #129. Manual offline repair would be a separate scope decision.

## Outcomes and retrospective

- Prototype commits `3056bb1c779bd857ecf8d6e96ee2553496098434` and
  `47bb58bd7687a69596a217669439bb7a2e964f64` remain on
  `prototype/129-local-repair-lifecycle`; 316 executable lines, no production
  runtime changes. The real Pi TUI was used, not an SDK/RPC substitution.
- Six limited positive assertions passed. Two stronger checks **falsified**
  no-native-writes-before-ACK and lease inheritance through actual public
  `node-pty.spawn`. A surviving fixture PTY writer continued after Owner exit
  while a replacement launcher acquired the lock and passed preflight.
- Reviewed the strengthened source and independently reran all eight assertions
  in 6.9 seconds. The two falsification assertions reproduced; all owned probe
  descendants were joined/reaped. No live transcripts, model calls, or network
  requests were used. No full test suite was run.
- The failed-ACK test only fences subsequent starts; it does not provide complete
  rollback. Source review identified an untested replacement-to-ACK crash window
  in the toy implementation. These remain explicit gaps, not claimed features.
- Findings, reproduction, evidence locations, integration costs, and recommendation
  are in `docs/research/local-repair-launch-feasibility.md`. The repair proposal
  now records the no-upstream constraint and this feasibility result.

The useful result was not the clean restart demo; it was discovering that its
explicitly propagated descriptor did not represent real PTY child launch. A
passing fixture is insufficient when its ownership mechanism differs from the
production launch shape.
