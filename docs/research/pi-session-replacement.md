# Pi session replacement: repair feasibility

Research for [#129](https://github.com/ewgdg/pi-durable-subagents/issues/129),
2026-09-13. Installed `@earendil-works/pi-coding-agent` **0.85.1**; the project
also pins 0.85.1 for development. This is evidence, not an implementation contract.

## Conclusion

Native same-path `AgentSessionRuntime.switchSession(path)` does reopen disk and
create fresh runtime state, but **reads the destination before shutting down the
old writer**. It is not a safe quiesce-and-reread primitive. `/reload` does not
reopen the transcript at all. In this project a blocked Owner also cancels native
resume, so repair needs an explicit narrow authorization and a host lifecycle
capability, not merely a call to the existing method.

## Sources and versions

Read the installed package README session-command table, `docs/sdk.md` runtime
replacement guidance, and `docs/extensions.md` lifecycle guidance before tracing
their implementations. Paths below are relative to the installed package;
published source counterparts are linked for portable review:

- [0.85.1 README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/README.md),
  [SDK guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md),
  [extension guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md).
- [Runtime replacement](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session-runtime.ts):
  installed `dist/core/agent-session-runtime.js`, especially `switchSession`,
  `teardownCurrent`, `finishSessionReplacement`, and `setBeforeSessionInvalidate`.
- [Native session lifecycle](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts):
  installed `dist/core/agent-session.js`, `abort`, `dispose`, `reload`, and
  `recordBashResult`.
- [Persistence](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/session-manager.ts):
  installed `dist/core/session-manager.js`, `_persist` and `_rewriteFile`.
- [Extension runner](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/extensions/runner.ts)
  and [interactive mode](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/modes/interactive/interactive-mode.ts):
  installed counterparts under `dist/`, `emit`, `emitSessionShutdownEvent`, and
  `handleResumeSession`.

Also fetched current upstream `main` through GitHub's API, pinned at
[`71dca871bc80b6bc97be37f0ca3189399d651fff`](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/src/core/agent-session-runtime.ts).
That source retains the same `SessionManager.open`-before-`teardownCurrent`
ordering (lines 196–212). This comparison covers that method, not every current
upstream lifecycle behavior.

## Source-inspected behavior

### Reopening and cancellation

The runtime method emits `session_before_switch` with reason `resume` and the
target path. Cancellation returns before opening or teardown. Otherwise it
opens a new `SessionManager`, checks cwd, then calls `teardownCurrent`, which
awaits native abort and `session_shutdown`, invokes the synchronous host UI
invalidation callback, and disposes the old session. Only then does the runtime
create/apply the replacement, rebind, and call `withSession`. There is no same-path
short circuit. Creation failure propagates after teardown; this method contains
no rollback. The invalidation callback is documented for synchronous UI cleanup,
not asynchronous snapshot replacement or destination rereading.

The extension command delegates through interactive `handleResumeSession` to
the runtime. The wrapper handles missing cwd interactively and other errors via
its fatal-runtime-error path. A repair module needs explicit failure ownership;
it must not assume an old command context remains valid after replacement.

The extension runner catches handler exceptions and emits extension errors rather
than propagating them from ordinary `emit`. Before-event cancellation requires a
returned cancel result. Awaiting `session_shutdown` is consequently **not proof
that every cleanup handler succeeded**. Likewise, a successful native switch does
not certify successful project admission. An explicit retained cleanup result
and new-bootstrap admission acknowledgment are required for repair.

Project [`src/index.ts`](../../src/index.ts) cancels `session_before_switch`
resume in TUI whenever Owner admission is pending or failed; failed admission
permits reason `new` only. It separately keeps safe fork available after verified
Owner identification. Same-path repair cannot bypass those guards implicitly.

### Reload and writers

`AgentSession.reload` emits resource-reload shutdown, reloads settings/resources,
rebuilds tools/extensions, and emits reload start. It does not replace its
`SessionManager` or reread agent conversation from disk. This matches the README's
resource-reload description and differs from the SDK runtime replacement methods.

`abort()` aborts retry, compaction, branch summary, and the agent, then awaits
native idle. `dispose()` requests aborts including bash, invalidates extensions,
disconnects listeners, and cleans resources synchronously; it does not await all
of that work. `abort()` itself does not call `abortBash`. Session code can flush
pending bash/custom messages at settlement and record a bash result while not
streaming. These methods alone do not establish a complete writer-exclusion
contract for background work, native session operations, or other processes.

Persistence uses synchronous appends and whole-file rewrites of cached entries;
the inspected methods contain no `fsync`. A cached old `SessionManager` can still
append to a replaced path or rewrite it from stale memory. Settings-manager flush
is unrelated to transcript persistence. An external atomic rename does not
invalidate existing native session objects.

## Targeted executable probe

Ran a 20-second-bounded Node probe against the **real installed runtime method and
SessionManager**, using temporary JSONL files and a stubbed session lifecycle.
No model, real TUI, live Workflow, or user transcript was involved. Assertions
passed in all four cases:

| Case | Result |
| --- | --- |
| Same-path switch, quiet old session | Switch succeeds, creates a distinct manager, disposes old session. |
| Old session appends in `abort()` | New disk tail exists, but reopened manager does not contain it. |
| Old session appends in `session_shutdown` | Same stale reopened-manager result. |
| Before-switch handler returns cancel | No new manager and no old-session disposal. |

The two stale-manager cases reproduce the ordering hazard, not merely a source
inference. To reproduce: open a temporary native transcript with `SessionManager`,
construct `AgentSessionRuntime` with a session stub whose awaited abort or shutdown
appends a custom entry through that manager, then call `switchSession` on the same
path. Capture the manager passed to the runtime factory and compare its entries
with a fresh disk open after switching. The new tail appears only in the latter.

Probe and JSON output are retained as investigation evidence under
`~/.agents/artifacts/outputs/pi-durable-subagents/2026-09-13/129-repair-design/`
(`same-path-probe.mjs`, `same-path-probe-result.json`). Run the probe with
`PI_PACKAGE` set to the installed package directory. It writes disposable native
session files only under the system temporary directory.

## Remaining proof required before live repair

- A supported pre-open host fence and restart locator for interrupted transactions,
  including cold startup before the extension's Owner bootstrap runs.
- Complete Owner/native/extension/background writer retirement, and a reopening
  route that cannot read before final shutdown writes or allow stale cached writes
  after replacement. The current UI teardown callback is not that interface.
- An explicit project admission acknowledgment that survives lifecycle replacement
  and distinguishes native switch success from swallowed extension failures.
- Real TUI tests for blocked admission, same-path replacement, cancellation,
  missing cwd, failure after teardown, and safe diagnostics/new/fork recovery.
- Crash/fault-injection tests for multi-file transactions and post-apply admission.

The probe does not verify these capabilities. The [repair design](../workflow-transcript-repair-design.md)
therefore makes them prerequisites, not claimed existing functionality.
