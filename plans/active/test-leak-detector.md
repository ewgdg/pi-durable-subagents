# Fail test files that leave handles open

## Goal and intention

Name what keeps a test file's process alive after its tests finish, and fail that file, so leaks are fixed with test-owned cleanup instead of being hidden by `--test-force-exit` (PR #201).

## Scope and constraints

- Detector lives with the supervised-run guard, which every test file imports first.
- Must be visible under `--test-reporter=dot`: dot hides child stderr, so report through a failing hook, not `console.error`.
- Fix each leak it reports with `t.after(...)` or `t.signal`.
- Slow-test pruning is a separate follow-up PR.

## Work plan

1. Regression test: a leaking fixture file fails naming the creation site; a file cleaning up in `t.after` or file-level `test.after` passes.
2. Implement the detector.
3. Fix reported leaks: `interactive-host-conformance` (faux stream timer); probe `quota-lifecycle-integration` failure path.
4. Document under "Deadlines and containment" in `docs/development.md`.

## Validation

- Focused runs of the regression test and each fixed file.
- Full `test:fast`, `test:process`, `test:conformance` once before the PR.

## Progress

- [x] Probes (Node v26.10.0) and design decisions.

## Decisions

- Fail the file, not report-only: user choice. Only one file leaked on passing runs.
- Check in a root `after` hook registered from `setImmediate`, so it runs after the file's own file-level `test.after` cleanup. Registering it directly from the guard ran it first and falsely flagged `cold-host-recovery`'s brokers.
- Rejected `process.on("exit")`: it can't wait, so in-flight `FSReqPromise`/`Immediate` work and handles still closing flagged ~25 clean fast-suite files; and dot hides its output.
- Poll up to a short grace for resources to drop back to the baseline captured at guard import (the runner's stdio pipes). Async closes (`server.close()`, `child.kill()`) finish within it.
- Always record creation sites with `async_hooks.createHook` (user choice). The Node docs discourage the API, but it is test-only and showed no measurable overhead (fast suite 13.4 s vs 13.35 s, mean of two runs each). Only ref'd handles are reported, since unref'd ones don't keep the process alive.

## Surprises and discoveries

- `getActiveResourcesInfo()` lists only resources keeping the loop alive, so the baseline under the runner is just `PipeWrap, PipeWrap`.
- Root `after` hooks run in registration order; one registered inside a root `before` attaches to the running subtest.
- First full process run: `quota-lifecycle-integration` "a child suspended on a runtime error…" timed out at 20 s but reported 140 s, and leaked `TCPServerWrap, PipeWrap, TTYWrap, PipeWrap`; `quota-cold-recovery` failed an assertion once. Neither reproduced on the next run.

## Outcomes and retrospective
