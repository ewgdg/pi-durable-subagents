# Independent repairer with clean Owner handoff

Follow-up for [#129](https://github.com/ewgdg/pi-durable-subagents/issues/129),
2026-09-15. **Disposable proof, not implemented repair functionality.** No
upstream, production-runtime, dependency, or live-transcript changes.

## Conclusion

**The narrower lifecycle works and is worth pursuing:** start a repairer outside
Owner-managed cleanup, require a verified clean handoff, commit the offline disk
repair, and only then relaunch the Owner. A failed relaunch leaves the committed
repair and the independent repairer available for diagnosis.

Twelve bounded cases passed, including real coordinator cleanup rejection and
real fresh-Owner admission rejection. Source review and an independent rerun
reproduced all twelve in 16.9 seconds, with owned descendants joined/reaped.

The Owner uses the existing SDK-backed test host with simulated TUI binding;
the managed Agent is an actual stock Pi CLI process launched through the project's
`node-pty` runtime. This proves more than a fixture claiming cleanup succeeded,
but does **not** prove the interactive Owner CLI/editor handoff or an implemented
repair command. The repairer is an independent Python helper, not yet a
Workflow-authenticated, model-driven repair Moderator.

## What changed from the rejected launcher approach

The [earlier proof](local-repair-launch-feasibility.md) remains valid: plain
descriptor inheritance did not protect a surviving PTY child, and Pi could
write native metadata before extension admission. This experiment removes the
need for those two assumptions instead of trying to patch around them.

```text
independent helper monitors the still-live Owner and participant roster
    -> actual coordinator cleanup succeeds
    -> exact monitored processes exit
    -> snapshot includes their final writes
    -> prepare/review candidate (simulated in this proof)
    -> journal, replace, commit disk repair
    -> fresh Owner admission succeeds OR helper retains failure diagnostics
```

| Original full-automatic proposal | Narrow contract exercised here |
| --- | --- |
| Repair safety follows from a host-wide writer fence | Require actual cleanup success plus observed exits of the known writer roster. Unverified handoff means refusal, not takeover. |
| Native startup remains write-free until admission commits the repair | Disk repair commits **before** native startup; startup writes are ordinary post-commit changes. |
| Failed fresh admission rolls back the repair | Keep committed repaired bytes and diagnose admission separately. Do not erase later startup evidence. |
| Every supported writable startup discovers interrupted repair automatically | During an unfinished transaction, the operator must use the repair/recovery helper before reopening affected sessions. Bare Pi is not intercepted. |
| Repair process participates in ordinary Owner-managed lifecycle | The helper survives independently; eventual repair Moderator membership must remain tied to the verified Workflow through a separate repair bootstrap. |

These are explicit changes in scope, not claims that the narrower proof meets
every requirement of the earlier full-automatic proposal. The user authorized
trying this contract; production implementation and final scope acceptance remain
separate decisions.

## Actual integration and trust assumptions

The proof imports the real project extension and uses `agent_spawn` with a
deterministic, local process-model broker. A test-only wrapper observes the
original `WorkflowCoordinator.shutdown` Promise; it does not replace normal
cleanup with a synthetic success. An inherited observer records each participant
and appends through native Pi persistence during shutdown.

Before handoff, the helper opens Linux pidfds for the still-live Owner and
observed participants. Before touching originals it requires:

- Successful actual coordinator cleanup and a positive Owner-bound handoff ACK.
- Exact process-exit observation for every monitored participant.
- No late additions to the observed participant roster.
- Post-exit snapshots containing the final native shutdown appends.

The helper has its own lock against duplicate helpers; that lock does not claim
to fence ordinary Pi processes. Unknown/unregistered writers are not discovered.
The complete supported writer roster is a production contract still to establish.
Opening another Pi session against these paths during unfinished repair violates
the explicit operator restriction; this design does not prevent it silently.

The source has useful leverage: `initializeOwnerWorkflow` already retains
`prepareOwnerReplacement()` and its cleanup Promise, and the coordinator closes
admission before joining managed shutdown. It exposes no public repair-handoff
result yet. Production integration must consume that actual result and preserve
failure, including when ordinary admission failed; a later `session_shutdown`
handler running is not cleanup proof because Pi contains handler exceptions.

## Executable results

| Case | Result |
| --- | --- |
| Clean handoff and relaunch | Owner and real managed Agent exited; both final appends were snapshotted; helper committed before a distinct new Owner admitted the repaired generation. |
| Missing handoff ACK | Refused; no repair journal or repair writes. |
| Negative handoff ACK | Refused even though actual cleanup could otherwise finish. |
| Actual coordinator cleanup rejection | Injected failure in its native-disposal dependency made the original shutdown Promise reject. Pi contained the handler error, but the helper still refused. |
| Early Owner death | Refused without verified handoff; no inference that child death or safe repair followed. |
| Registered surviving PTY writer | A scratch PTY process survived terminal hangup and kept writing. Its live pidfd blocked repair despite a positive coordinator result. |
| Crash after first replacement | Helper recovery restored both preimages before any relaunch. |
| Unknown destination hash | Recovery refused without overwriting either destination. |
| Crash after durable repair commit | Recovery retained the repaired pair rather than rolling it back. |
| Injected process failure after fresh admission | Helper remained available for diagnosis; committed repair and new native metadata were retained. |
| Actual fresh-Owner admission rejection | Invalid scratch Workflow Policy rejected real project admission and left coordination tools unavailable. The helper retained the committed repair and diagnostic. |
| Duplicate helper, cancellation, new attempt | Duplicate received lock-busy; pre-repair cancellation made no repair writes; a subsequent helper completed handoff and commit. |

The cleanup fault is an explicitly injected dependency error, not a discovered
production bug: the original coordinator aggregated it into `Workflow shutdown
failed`. The fresh-admission fault uses an invalid scratch
`config/pi-agent-coordination.json` with `maxConcurrentAgentRuns: 0`; the real
diagnostic is `Workflow Policy maxConcurrentAgentRuns must be a positive safe
integer`. It does not corrupt the already committed repaired transcript.

All relaunch cases assert three distinct old-Owner/helper/new-Owner PIDs and that
the repair-commit event precedes new admission observation. Native startup adds
thinking metadata deliberately omitted from the candidate. Those post-commit
writes remain, including after failed admission. There is no admission-as-commit
hash check or automatic rollback over them.

## Reproduction and evidence

Prototype branch: `prototype/129-local-repair-lifecycle`.
Initial narrow proof: `1efff1e804a80c65542f2759fc152039bc57a650`.
Stronger rejection coverage: `c93b54a36181cfc8a34912e919b87bc50b31fca9`.
The previous `prototypes/129-local-launch/` experiment is unchanged.

From a checkout of that branch:

```sh
uv run --no-project prototypes/129-independent-repairer/proof.py
```

Requires Linux pidfds and user/network namespaces, `ip`, Node 22, Python/uv, and
the existing repository dependencies. Set `PROOF_REPO` to the repository checkout
providing source/test helpers and dependencies. The proof uses scratch HOME,
configuration and transcripts, and a network namespace with loopback only for the
local deterministic broker. No external model calls or network access are needed.
Waits are bounded, and a subreaper cleans/reaps only owned processes.

Durable artifacts are under
`~/.agents/artifacts/outputs/pi-durable-subagents/2026-09-15/129-independent-repairer-proof/`:

- `run-rejections.log` and `rejection-scratch/`: strengthened run.
- `parent-verification.log` and `parent-verification-scratch/`: independent rerun.
- Each case retains actual process observations, cleanup results, snapshots,
  journal, helper events, and fresh-Owner admission/diagnostic observations.

Only the scoped proof was executed; no full project suite was run. Syntax and
diff checks passed. Prototype source stays off main; main contains this evidence
and proposal/plan updates only.

## Complexity and remaining work

The final prototype is 329 executable lines, including fixtures and harness.
That count is not a production estimate. The simplification comes from removing
requirements, not from making the code shorter than the previous proof.

**Removed from this path:** permanent launch interception, automatic recovery of
unverified orphan writers, inherited child-lock lifetime, write-free native
startup, and rollback after committed-repair admission failure.

**Still required before implementation:**

1. A narrow production clean-handoff interface exposing actual cleanup outcome,
   complete supported writer accounting, and verified identity independently of
   ordinary admission. The test-only prototype wrapper is not that interface.
2. Repair-only Moderator bootstrap, task/report authority, and an independent
   UI/process lifetime. The helper's Owner ID binding is not membership validation.
3. Real whole-Workflow validation, protocol-effect review, and human approval.
   The probe changes a generation marker, reconnects parents around removed
   thinking metadata, and edits a toy sidecar; approval and semantic validation
   are simulated, not an autonomous repair engine.
4. Production backups, immutable candidates, durable transaction/recovery rules,
   and clear recovery instructions after helper death. The two-file journal
   tests process crashes with fsync; it is not a power-loss or arbitrary-filesystem
   durability proof.
5. Actual Owner CLI/terminal handoff and relaunch UX, platform scope, and refusal
   behavior for pre-existing admission/cleanup failures. The tested SDK Owner
   does not settle those presentation and deployment questions.

**Recommendation:** continue #129 around this bounded independent-repairer
contract rather than a permanent launcher. Preserve strict refusal when clean
handoff cannot be established and explicitly accept the operator-mediated
recovery rule and commit-before-relaunch semantics before implementing it.
