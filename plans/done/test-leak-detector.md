# Fail test files that leave handles open

## Goal and intention

Name what keeps a test file's process alive after its tests finish, and fail that file, so leaks are fixed with test-owned cleanup instead of being hidden by `--test-force-exit` (PR #201).

## Scope and constraints

- Detector lives with the supervised-run guard, which every test file imports first.
- Must be visible under `--test-reporter=dot`: dot hides child stderr, so report through a failing hook, not `console.error`.
- Fix each leak it reports with `t.after(...)` or `t.signal`.
- Slow-test pruning is a separate follow-up PR.

## Work plan

1. Regression test: a leaking fixture file fails naming the creation site; a file cleaning up in `t.after` or a `describe`-level `after` passes.
2. Implement the detector.
3. Fix reported leaks: `interactive-host-conformance` (faux stream timer); probe `quota-lifecycle-integration` failure path.
4. Document under "Deadlines and containment" in `docs/development.md`.

## Validation

- Focused runs of the regression test and each fixed file.
- Full `test:fast`, `test:process`, `test:conformance` once before the PR.

## Progress

- [x] Probes (Node v26.10.0) and design decisions.
- [x] Regression test, detector, conformance fix, docs.
- [x] Full fast, conformance, and process runs.

## Decisions

- Fail the file, not report-only: user choice. Only one file leaked on passing runs.
- Register the check as a root `after` hook directly from the guard, so it runs before any file-level `after` hook, and require cleanup owned by a test or `describe` suite. Deferring registration past the file's own hooks has no reliable moment: from `setImmediate` a file of synchronous tests finished first and silently skipped the check (caught by the regression test); from `queueMicrotask` a top-level await in `cold-host-recovery`'s imports ran it before the file's body, so its file-level broker cleanup ran after the check. That file now closes each broker with `t.after`.
- Rejected `process.on("exit")`: it can't wait, so in-flight `FSReqPromise`/`Immediate` work and handles still closing flagged ~25 clean fast-suite files; and dot hides its output.
- Poll up to a short grace for resources to drop back to the baseline captured at guard import (the runner's stdio pipes). Async closes (`server.close()`, `child.kill()`) finish within it.
- Always record creation sites with `async_hooks.createHook` (user choice). The Node docs discourage the API, but it is test-only and showed no measurable overhead (fast suite 13.4 s vs 13.35 s, mean of two runs each). Only ref'd handles are reported, since unref'd ones don't keep the process alive. A resource created from a Node callback (a server bound after a host lookup) has no frames of its own, so it inherits its trigger resource's stack; the fast suite went from 13.4 s to 13.6 s with this, and a full process run took 441 s, within the 434–444 s of earlier runs.

## Surprises and discoveries

- `getActiveResourcesInfo()` lists only resources keeping the loop alive, so the baseline under the runner is just `PipeWrap, PipeWrap`.
- Root `after` hooks run in registration order; one registered inside a root `before` attaches to the running subtest.
- First full process run: `quota-lifecycle-integration` "a child suspended on a runtime error…" timed out at 20 s but reported 140 s, and leaked `TCPServerWrap, PipeWrap, TTYWrap, PipeWrap`; `quota-cold-recovery` failed an assertion once. Neither reproduced on the next run.

- `interactive-host-conformance` leaked fake-model chunk timers: `pi-ai` 1.0.4's faux provider checks the abort signal only after each chunk's `setTimeout`, so at `fauxTokensPerSecond: 1` a chunk outlives disposal by seconds. Fixed by holding the response until aborted (`heldUntilAborted`).
- The `quota-lifecycle-integration` leak is a symptom: resuming a child just stopped on a runtime error sometimes never returns (2 of 6 runs with a 4 s timeout), and `host.dispose()` then waits on it until the file timeout. Evidence: `quota-resume-hang-steps.txt` in the task artifacts.

## Outcomes and retrospective

- Passing runs now report no leaks; a leak fails its file and names the creating line.
- Follow-ups: the quota resume race (separate bug-fix PR); slow-test pruning, removals and merges only (separate PR). Pruning reviews: `~/.agents/artifacts/outputs/pi-durable-subagents/2026-10-06/test-leak-hunt/`.
