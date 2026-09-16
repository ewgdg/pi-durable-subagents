# Independent Workflow repair

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

## Decisions and evidence

The accepted lifecycle and twelve bounded proof cases are recorded in
`docs/research/independent-repairer-feasibility.md`. The prototype is not a shipped
repair feature: its Python helper, test-only cleanup observer, simulated review,
and SDK-backed Owner do not satisfy the production acceptance criteria above.

Implementation interfaces and platform support remain to be recorded after the
production integration review. Do not silently weaken a safety requirement to
fit the prototype.
