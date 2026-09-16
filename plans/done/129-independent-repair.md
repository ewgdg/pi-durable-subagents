# Independent Workflow repair

Scope correction: this is historical implementation evidence. Its rejected-record
restoration and successful-admission repeat behavior were superseded by the
admission-failure-only correction; see `129-admission-repair-scope.md` when complete
and `docs/workflow-transcript-repair-design.md` for the current contract.

## Goal

Implement the clean-handoff repair flow accepted after the #129 feasibility
probe, in a separate worktree and reviewable PR. No upstream Pi change or
permanent Owner launcher is permitted.

## Scope and constraints

- A repair Moderator belongs to the verified affected Workflow but runs outside
  the ordinary Owner-managed shutdown lifecycle.
- Actual coordinator cleanup success and observed retirement of supported
  transcript writers precede snapshots. Missing or failed handoff refuses repair;
  Owner death, quiet files, or an unlocked helper lease alone are insufficient.
- Invoking the repair command authorizes this repair attempt, including clean
  handoff, validated replacement, and Owner relaunch. Do not ask for a second
  confirmation of handoff or of the eventual changeset.
- Repair candidates are separate from immutable post-shutdown snapshots. Validate
  the whole Workflow and retain textual and protocol-effect changes as an audit
  report, not a human approval gate. Bind application to the exact validated
  generation and authorized attempt; changed candidates require revalidation.
  Authorization does not waive writer retirement, validation, or freshness checks,
  authorize unrelated edits, or authorize inventing ambiguous historical intent.
- Back up and journal replacement. Interrupted, uncommitted application restores
  the whole preimage only when destination hashes are known. Unknown state refuses.
- Commit validated disk repair before opening a fresh Owner session. Failed fresh
  admission retains committed repair and later native writes for diagnosis.
- The operator uses the helper/recovery path before reopening affected sessions
  while repair is unfinished. No interception of arbitrary bare Pi launches,
  automatic orphan takeover, or automatic resumption of participant work.
- Trust-based protocol, not an adversarial filesystem sandbox. No general
  autonomous repair engine or bundled historical migration.

## Work plan

1. Map production integration gaps and settle narrow interfaces/platform scope.
2. Consolidate the accepted design; retain earlier feasibility evidence as history.
3. Implement behavior-tested vertical slices for handoff, independent repair
   bootstrap, validation/review, durable application/recovery, and terminal relaunch.
4. Exercise actual CLI handoff plus refusal/recovery paths with targeted supervised
   tests. Independently review safety and scope; fix blocking findings.
5. Commit task-owned changes, push, and open a PR with precise verification and
   platform/operating restrictions.

## Validation

Public behavior, not prototype monkeypatches, is the acceptance surface:

- Real managed writer cleanup, final native writes, and exact retirement before
  snapshot; cleanup rejection and abrupt Owner death cannot authorize repair.
- Verified Workflow membership independent of ordinary replay, with refusal when
  identity cannot be established.
- A repair command authorizes a valid in-scope attempt without another confirmation.
  Candidate edits invalidate validation; source changes and validation failures
  prevent replacement. The audit includes changed obligations and recovery effects.
- Interrupted multi-file application restores all preimages or refuses unknown
  hashes without partial recovery. A committed repair is never rolled back over
  fresh Owner writes.
- Repair helper survives old Owner session retirement and fresh admission failure.
  Same-terminal operation is exercised; no upstream/private Pi patch or test-only cleanup
  observer substitutes for a production interface.

Use targeted repository-supervised test entrypoints and typecheck; avoid the full
integration suite. Record exact commands and outcomes at completion.

## Progress

- 2026-09-16: Resumed implementation after user-requested context pause. Created
  `.worktrees/129-independent-repair` on `feat/129-independent-repair` from
  `0af464b`; main remains unchanged. Production architecture review is underway.
- User explicitly superseded the proposal's per-changeset approval requirement:
  the repair command itself is authorization, with no further confirmation.
  Production code is not yet implemented.
- User rejected the proposed Linux/Python/second-terminal operating burden.
  Pause production implementation while reassessing a same-terminal, Node-only
  lifecycle. The original request was to stop the Owner session: reconsider
  whether full Owner process exit is necessary, without assuming native session
  disposal proves all final writes and callbacks are retired. The prior proof
  establishes only its tested process-exit topology, not the required UX.
- A read-only source review identified a candidate: retain the original CLI/TUI,
  replace the Owner session with an unrelated temporary repair-host session,
  then reopen Owner from disk only after an independent Node helper commits.
  A real CLI proof completed separately from production code. In particular,
  native user bash must be aborted and joined explicitly: native session abort
  and disposal alone do not establish its final transcript write has completed.
  Noncooperative stale raw SessionManager references remain outside the
  trust-based writer contract; no claim of filesystem write revocation is made.
- Same-terminal prototype `cd7a4fa` passed six bounded cases, independently rerun
  in 7.902 seconds: clean, native user bash, actual cleanup rejection, parking
  cancellation, actual fresh admission failure, and an expected unsupported raw
  writer counterexample. No Python, pidfds, or second terminal. Full portability,
  production writer inventory/bootstrap, and transaction/recovery remain unproved.
  See `docs/research/same-terminal-repair-feasibility.md` for evidence and limits.

- 2026-09-16: Production lifecycle committed in `d357d88`, isolated helper/host
  launcher in `33e750b`, and end-to-end commands/Moderator/recovery in `192bceb`.
  Integrated storage and validator implementation plus independent-review fixes
  through original commits `d0e52ce` and `c7f591b`. These are actual production
  call sites, not the disposable prototype's observer or environment bypass.
- Focused `repair-cli.test.ts` covers eleven real stock-CLI scenarios:
  clean, managed child final writes, actual missing-title candidate correction
  with protocol-effect audit, native user bash, actual cleanup rejection, parking
  cancellation, fresh and initial failed admission, Esc cancellation, repeat
  attempts with archived-host binding, and helper
  SIGKILL followed by explicit operator-attested recovery. Same CLI PID and a
  fresh native manager are checked; no participant Runs automatically resume.
- Native replacement waits for `withSession` before accepting another slash
  command. Production therefore provides a raw Esc cancellation listener and
  consumes other input while the repair callback waits. This is now exercised
  by the real CLI test, not inferred from the earlier prototype.
- Packed npm package under an actual `node_modules` path passed clean repair,
  including the independent helper loading shipped TypeScript through stock Pi.
  Installed managed-child scenario exposed a pre-existing direct-Node `.ts`
  contract probe failure under `node_modules`. Parent-approved enabling fix
  `f25d41c` uses built-in Node stripping only for the known dependency-free schema
  probe. Packed clean and managed repair-edit scenarios now both pass.
- Independent lifecycle review found that ordinary recovery could mistake a
  no-intent journal for successful writer retirement. Fixed in `4e6674e`: only an
  actual consumed retired IPC acknowledges cleanup, and ordinary recovery requires
  it. The CLI regression proves missing-handoff refusal, explicit operator
  recovery, positive post-handoff cancellation recovery, and a subsequent attempt.
  The same commit binds archived hosts to exact attempt IDs and permits new
  repair authorization after successful admission. Independent targeted closure
  review approved both fixes and reran the three selected real-CLI regressions;
  no remaining required findings in that bounded review.
- Final bootstrap check reproduced another false-success edge after extension
  upgrade: an ordinary cleanup registry could exist without the later-added
  repair-evidence registry. `4fefc02` retains the existing real cleanup callback
  before any no-coordinator declaration. The focused regression went red then
  green; independent bounded closure review approved it and reran all three
  selected retirement/bootstrap cases. Final Owner-bootstrap verification now
  passes 28 cases with only the independently reproduced capacity case skipped.
- Existing `Owner reload publishes one prospective policy or preserves the
  prior snapshot` fails its capacity assertion on the unchanged baseline too
  (verified with pre-change source). It is not silently repaired by this task.
  Existing `Moderator attempts use process Runtimes and one committed failure
  creates one linked replacement` also times out unchanged at 45 seconds on
  detached baseline `cb39445`; it is not repaired by this task.
- Final focused verification passed: typecheck; all repair-specific fast files;
  helper-process, child-contract probe and eleven-case real CLI files; existing
  Owner bootstrap and process factory files with only the two independently
  reproduced baseline failures explicitly skipped. Packed-package clean and
  managed repair-edit smoke both passed using an actual `node_modules` location.
  Read-only diagnostics tabs and terminal-size bounds are tested. Final
  README/design/PR consolidation and final acceptance belong to the parent.

## Decisions and evidence

The accepted lifecycle and twelve bounded proof cases are recorded in
`docs/research/independent-repairer-feasibility.md`. The prototype is not a shipped
repair feature: its Python helper, test-only cleanup observer, simulated review,
and SDK-backed Owner do not satisfy the production acceptance criteria above.

The implemented contract is now recorded in
`docs/workflow-transcript-repair-design.md`, with operator commands in
`docs/workflow-repair-operations.md`. Historical process-exit/Python proposals are
not alternate runtime paths. The shipped implementation is Node-only and
same-terminal; durable storage currently refuses Windows. Cross-restart recovery
uses an explicit operator-stopped attestation, distinct from actual observed
process exit, and never fabricates missing initial handoff evidence.

## Final acceptance

- Parent independently reran `npm run typecheck` and
  `npm run test:process -- --file=repair-cli.test.ts` against integrated code at
  `3d653ae`: both passed, including all eleven CLI cases (19.031 seconds for the
  CLI invocation). No full suite was run.
- Independent core review closed the recovery-report dependency and accepted
  evidence ordering findings; lifecycle review closed missing-handoff recovery,
  repeat/archived attempt binding, and earlier-bootstrap cleanup retention.
- README and maintained recovery documentation now describe implemented behavior;
  the superseded full-automatic design has been removed from the current contract.
- Additional focused reader checks reproduced two unchanged baseline failures:
  Workflow resume expects `continuation_admitted` instead of `already_running`,
  and a cold recovery test reads the obsolete `activations` receipt field. These
  are recorded in the PR alongside the two process-test baseline failures above,
  not reported as passing.
- Published ready-for-review [PR #143](https://github.com/ewgdg/pi-durable-subagents/pull/143)
  from `feat/129-independent-repair` against `main`. Code, tests, documentation,
  independent review, and installed-package verification are complete; CI was
  queued at publication, not claimed passing.

## Outcome

The feature uses the existing terminal and Node runtime without upstream changes
or a second approval. The production implementation is larger than the disposable
proof because identity, complete validation/audit, durable recovery, and operator
controls are real interfaces now. Supported scope and refusal conditions remain
explicit rather than relying on the prototype's test-only observers.
