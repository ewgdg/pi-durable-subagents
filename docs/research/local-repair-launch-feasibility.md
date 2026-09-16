# Local repair launch integration — feasibility investigation

Investigation for [#129](https://github.com/ewgdg/pi-durable-subagents/issues/129),
2026-09-15. **Design evidence, not implemented repair functionality.**

The user excludes upstream changes and asks to prove the local-launcher idea
before deciding whether its complexity is worthwhile. The earlier weighted
matrix is a hypothesis, not evidence that a launcher already provides safe
writer retirement or crash recovery.

**Follow-up:** the user proposed keeping a repairer independent while the Owner
is stopped. The [clean-handoff experiment](independent-repairer-feasibility.md)
proves a narrower viable lifecycle by committing repair before relaunch and
requiring operator-mediated recovery. It does not reverse the counterexamples
below or make a permanent launcher necessary. This document records the earlier,
stronger contract's evaluation.

## Conclusion

**The small launcher works for clean restart, but fails the complete repair
safety contract. Do not implement a production launcher solely for #129 now.**

Six limited lifecycle assertions passed against the real stock Pi TUI. Two
stronger checks falsified the assumptions that make the simple design attractive:
an actual `node-pty` child did not retain the inherited lease and survived while a
replacement launcher passed preflight; Pi also modified the transcript before
the fixture's admission acknowledgement. Both findings reproduced in a separate
rerun after source review.

These are not proof that safe local integration is impossible. They mean it
requires explicit writer enrollment/containment, startup-path coverage, and a
defined admission/write contract. That is substantial host-lifecycle work, not
an extension plus a small restart script. #131 already removes the ordinary
invalid-record admission problem, reducing the benefit of paying that cost just
for repair. This is a recommendation for the user's decision, not cancellation
of #129 or authorization to replace its requirements with weaker guarantees.

## Question and scope

Can project-owned launch integration around unmodified Pi stop all supported
writers, reconcile an interrupted repair before opening a transcript, and reopen
the same session safely? Separate these claims:

1. A fresh Pi process can read changed bytes after a clean old-process exit.
2. A launcher can serialize cooperating starts and recover a toy transaction.
3. The complete Workflow can satisfy #129's writer-exclusion, approval,
   interrupted-recovery, and admission contracts.

The first two do not prove the third. Disposable probes use scratch transcripts
and isolated configuration, not a live Workflow, model-driven repair, or real
external tool effects. No upstream or production runtime code is changed.

## Source-backed integration costs

### Process ownership is more than waiting for the Owner

Ordinary children and Moderators use stock Pi processes launched through
[`pi-child-cli-launch.ts`](../../src/process-runtime/pi-child-cli-launch.ts) and
[`pty-terminal-projection.ts`](../../src/process-runtime/pty-terminal-projection.ts).
`node-pty` creates separate PTY process groups. An Owner process exit or a signal
to only its process group is not proof that all participants have stopped.

Useful mechanisms already exist:

- [`WorkflowCoordinator`](../../src/coordination/workflow-coordinator.ts) fences
  scheduling and joins pending spawns, moderation, attachments, and Agent
  shutdown work.
- [`PiChildProcessRuntime`](../../src/process-runtime/pi-child-process-runtime.ts)
  requests graceful shutdown, then kills the exact PTY group if its grace period
  expires. PTY disposal also cleans group survivors.
- [`child-runtime-bridge.ts`](../../src/process-runtime/child-runtime-bridge.ts)
  requests native shutdown after losing Owner Control.

These are useful clean-shutdown mechanisms, not a durable exclusion lease. The
public Pi shutdown request waits for idle; loss of Control is not proof of exit.
The project's [test supervisor documentation](../../README.md#compatibility)
already distinguishes cgroup/guardian containment from best-effort process-tree
cleanup. Promoting that test machinery to a repair guarantee would be new product
work, not a one-line launcher reuse.

### Launch preflight must cover more than one CLI invocation

The package currently installs as a Pi extension; there is no production Owner
launcher. Stock Pi can select sessions through explicit paths/IDs, recent-session
selection, a resume picker, and native in-process session switching. A wrapper
around one initial `pi --session PATH` launch does not automatically intercept
the others.

The existing [`session_before_switch` guard](../../src/index.ts) can cancel native
switches, but currently checks coordination admission, not a repair locator or
writer lease. A supported local route must either integrate target preflight
into these paths or explicitly restrict the supported entry routes. It must also
cover child startup and pending bootstrap writes. Launching plain Pi around that
contract remains an unsupported writer, not a case solved by unchanged hashes.

### Reopening is not necessarily write-free until admission

Pi 0.85.1's public SDK lifecycle documentation explains that runtime creation
reconstructs the session before extension `session_start`. Its
[`sdk.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/sdk.ts)
implementation appends a thinking-level entry when an existing session lacks
one; new/empty session initialization can append model and thinking metadata.
These writes precede `session_start`. Configured extensions can also perform
startup work before this project's Owner bootstrap completes.

Therefore replacing in-process switching with a new process does not by itself
meet the proposal's strict requirement that candidate bytes remain unchanged and
all writes stay fenced until the durable `admitted` record. A production solution
must either refuse affected candidates or establish an explicit startup/write
contract, not just create an acknowledgement file. Allowing provisional startup
writes would require a deliberate design change and defined rollback treatment;
it is not an accepted relaxation or a reason to patch private Pi state.

## Executable evidence

### Reproduction and isolation

Prototype branch: `prototype/129-local-repair-lifecycle`, final commit
`47bb58bd7687a69596a217669439bb7a2e964f64` (initial clean-path proof:
`3056bb1c779bd857ecf8d6e96ee2553496098434`). The source and its README live at
`prototypes/129-local-launch/` **on that branch**, not on main.

From a checkout of the prototype branch:

```sh
uv run --no-project prototypes/129-local-launch/run.py
```

The proof uses Linux, Node 22.23.1, stock Pi 0.85.1, and installed `node-pty`
1.1.0. It runs the actual interactive CLI under `script(1)`, not a replacement SDK
host or RPC simulation. Scratch HOME/configuration/session files, an explicitly
loaded fixture, and a private network namespace avoid user configuration,
credentials, live transcripts, or model/network requests. Package locations can
be supplied with `PI_PACKAGE` and `PROOF_NODE_PTY`.

The Linux subreaper harness bounds execution to 100 seconds and descendant
cleanup to 10 seconds. The final independent rerun completed in 6.9 seconds and
reported all owned descendants joined/reaped. This containment is a probe
safety measure, not a production launcher implementation. No full project test
suite was run; no production source changed.

### Results

| Check | Observed outcome | What it establishes |
| --- | --- | --- |
| Clean shutdown, final append, same-path reopen | Passed; distinct Pi PID read the replacement generation, and post-exit snapshot retained shutdown append | Process replacement avoids the old-manager reread ordering hazard on this clean path. |
| Concurrent cooperating launch | Passed; second launch returned lock-busy before preflight | Advisory gate works for processes explicitly participating in it. |
| Supervisor death with explicitly inherited descriptor | Passed; stock Pi and then a detached `child_process.spawn` fixture retained the lease | A deliberately propagated open-file-description lock can outlive the supervisor. |
| Crash after first of two replacements | Passed; preflight restored both originals before Pi opened | The tested toy journal ordering works for that process-crash point. |
| Unknown destination hash | Passed; neither file changed and Pi did not bootstrap | The toy recovery path refuses unrecognized bytes rather than blindly restoring. |
| Missing new acknowledgement | Passed at its narrow scope; failure marker blocked subsequent managed starts | Timeout can fence later launches. It did **not** roll back the applied session or prevent native shutdown writes. |
| No native writes before acknowledgement | **Falsified**; missing `thinking_level_change` was appended before fixture `session_start` captured disk and before ACK | Restart alone does not enforce a write-free admission phase. |
| Lease inheritance through public `node-pty.spawn` | **Falsified**; no child descriptor matched the lease; surviving child kept writing while replacement acquired the gate and ran preflight | The actual PTY launch shape does not inherit the simple supervisor's exclusion guarantee. |

The last two probe assertions deliberately verify the counterexamples; their
machine-readable `pass: true` means the observation succeeded, while
`claimHolds: false` means the proposed safety property failed. Do not summarize
the run as “eight safety checks passed.”

For the PTY counterexample, Pi first verified that its own descriptor referenced
the lock's device/inode. The child enumerated all open descriptors: descriptor 3
was an event-poll handle, and none was the lease. After supervisor death Pi still
held the gate. After Pi exited, the child handled terminal `SIGHUP` and continued
writing its own scratch log; a new launcher returned success from preflight
while those writes continued. The probe uses production-shaped public spawn
options, but the writer is a fixture, not a real recovered Agent. It establishes
the missing ownership mechanism without claiming a production Agent failure.

### Retained evidence and limits

Investigation artifacts are under
`~/.agents/artifacts/outputs/pi-durable-subagents/2026-09-15/129-local-launch-proof/`:

- `run-challenge-final.log` and `challenge-scratch/`: strengthened original run.
- `parent-verification.log` and `parent-verification-scratch/`: independent rerun.
- Each scratch set includes `results.json`, real TUI logs, event order, before
  and at-start transcript snapshots, and the PTY child's descriptor inventory.
- Earlier failed harness runs remain as evidence of the corrected timer and
  terminal-hangup assumptions; they are not successful safety results.

Source review also found an **untested crash window** in the toy normal-repair
path: it replaces the transcript without retaining an applying/reopening journal;
the failure marker is written only after the live supervisor observes ACK
timeout. Killing it before that timeout can leave neither record. Once remaining
lease holders exit, a new launch can pass preflight. Fixing this requires the
real transaction state through admission, not a longer timeout.

The proof does not implement all-writer drain, real Workflow membership or
admission acknowledgement, complete rollback after failed reopening, filesystem
power-loss durability, arbitrary transaction recovery, native navigation
integration, UI restoration, or macOS/Windows support. A bare Pi invocation can
bypass the advisory gate. These omissions are not filled by the six positive
assertions.

## Complexity and value assessment

The executable prototype is 316 lines across supervisor/probes, fixture, PTY
writer, and cleanup harness. That is enough to find the two counterexamples,
not an estimate of production size. Most necessary product behavior is absent.

| Work area | Existing leverage | Remaining work / relative complexity |
| --- | --- | --- |
| Clean stop and exact-path restart | Native shutdown and CLI work; current child shutdown machinery exists | Small, demonstrated core. |
| Complete writer exclusion across host death | PTY lifecycle cleanup and test-only cgroup/guardian machinery | **High:** explicit participation or containment for every supported writer, launch races, survivor recovery, and platform policy. Parent-only lock inheritance failed. |
| Pre-open coverage | Public before-switch cancellation; known child launch path | **Medium–high:** Owner launch modes, native navigation, participant startup, durable locators, and a clear rule for unmanaged hosts. |
| Reopen/admission write contract | Fresh disk reads and project bootstrap validation | **High:** define allowed startup writes, which extensions may run, failure rollback, and when normal execution is released. Acknowledgement alone failed. |
| Durable multi-file repair | Read-only evidence and validation readers | **High, required by either automated apply approach:** backups, sealed candidates, approval, crash phases, durability, recovery before any writable attachment. Toy two-file rollback is not this module. |
| User-facing lifecycle | Existing diagnostics and Agent presentation | **Medium:** progress/approval while Owner Pi is stopped, terminal ownership, configuration-preserving relaunch, and failure escape routes. |

There is no credible calendar estimate until the ownership and startup/write
contracts are selected. Even a Linux-only first version avoids portability work,
not the two demonstrated failures. These findings do not establish that upstream
changes are necessary; alternative local mechanisms would need further design
and executable proof before receiving a positive safety assessment.

### Reassessment of the weighted matrix

The earlier local-launcher score (3.75/5 versus manual offline 3.10/5) assumed
reliable exclusion and nearly complete interrupted recovery. The experiment
does not validate those scores. The demonstrated simple launcher fails a
mandatory safety gate; averaging its convenience and implementation simplicity
against that failure would be misleading. A redesigned, complete managed host
cannot inherit the same low implementation-cost estimate.

Manual offline repair is not a proven drop-in winner either: it gives up
automatic reopening/pre-open recovery and still requires real writer exclusion.
Choosing it would require an explicit scope change, not calling the same unsafe
launcher “manual.”

**Recommendation:** stop at this feasibility result rather than build a
production launcher for repair alone. Retain the proof and proposed repair
contract. Revisit managed launch if the project independently needs that host
lifecycle capability or concrete repair demand justifies it. For an immediate
damaged Workflow, evaluate a bounded operator-assisted offline procedure
separately; do not silently implement it or claim it meets the current #129
automatic-recovery contract.
