# #129 — prove clean handoff to an independent repairer

## Goal

Test the user's narrower alternative to a permanent local launcher: start a
repairer outside Owner-managed cleanup, cleanly stop the Owner and its ordinary
Agents, repair offline, then launch the Owner again while the repairer survives.

The user authorized a disposable proof, not production repair implementation.
No upstream changes or live transcript edits are allowed.

## Intention and narrowed contract

Separate a committed disk repair from successful Owner relaunch. This proof
commits a deterministic candidate before starting a fresh Owner; approval and
semantic repair validation are simulated. Startup writes are normal writes after
commit. Failed relaunch retains repaired files and diagnostics, not an automatic
rollback over potentially new evidence.

Require positive clean-handoff evidence plus observed exact process exits before
snapshot/apply. If cleanup is unverified, refuse rather than infer quiescence from
Owner death, a released lock, or unchanged hashes. During an unfinished repair,
the operator must not reopen affected sessions outside the repairer/recovery
helper. The prototype does not enforce this restriction across arbitrary Pi
launches or introduce a permanent launcher.

## Work plan

1. Audit existing production cleanup and role/lifecycle seams for a narrow
   handoff; distinguish cleanup completion from swallowed Pi shutdown errors.
2. Reuse the disposable prototype branch, keeping the previous failed approach
   intact. Exercise independent repairer survival, a live participant, final
   writes, missing/failed handoff, a surviving PTY writer, interrupted apply,
   committed repair recovery, failed relaunch, and competing repairers.
3. Prefer actual project coordinator/Agent cleanup over a fixture claiming it
   happened. Identify any instrumentation and unproved production integration.
4. Review and reproduce the bounded probe, document the results and revised
   complexity assessment, and update the repair proposal without shipping code.

## Validation and artifacts

Real stock Pi processes, isolated scratch configuration, and local deterministic
fixtures only; no external model/network calls. Use reliable process-exit
observation, bounded deadlines, and cleanup restricted to owned probe processes.
Keep code on `prototype/129-local-repair-lifecycle`; main receives documentation
only. No full integration suite is warranted for this proof.

## Progress

- [x] Delegate the executable proof to the Agent retaining the earlier prototype
  context; parent owns the disjoint source/contract audit and documentation.
- [x] Recheck the Owner bootstrap cleanup closure and participant process handles.
- [x] Review and reproduce executable results.
- [x] Record findings, remaining gaps, and complexity recommendation.

## Source findings

`initializeOwnerWorkflow` retains `prepareOwnerReplacement()` and its cleanup
Promise. It already awaits `WorkflowCoordinator.shutdown`, but exposes no
repair-handoff command/result. A new repair interface must consume that actual
completion or failure, not infer success from a later Pi shutdown handler.
The repairer must not be created as an ordinary managed Agent: Owner shutdown
intentionally stops those participants.

## Decisions

Commit-before-relaunch and operator-mediated reopening are prototype assumptions
chosen to test the narrower idea. They are explicit changes from the previous
design's admission-as-commit and universal pre-open recovery requirements, not
claims that the previous requirements have already been satisfied.

## Outcomes and validation

The narrow lifecycle succeeded. Prototype commits
`1efff1e804a80c65542f2759fc152039bc57a650` and
`c93b54a36181cfc8a34912e919b87bc50b31fca9` remain on
`prototype/129-local-repair-lifecycle`; the earlier failed-launcher prototype is
unchanged. No production source or upstream modifications were made.

Twelve bounded cases passed, including actual coordinator shutdown rejection
from an injected disposal dependency failure, and actual fresh project admission
failure from invalid scratch policy. Reviewed the source and independently reran
all twelve in 16.9 seconds; owned descendants were joined/reaped. No full test
suite was run. Diff and syntax checks passed.

The Owner/fresh Owner use existing SDK test hosts with simulated TUI binding.
The managed Agent is real stock Pi CLI through the project's node-pty runtime.
Test-only observation of the original coordinator Promise is not a public repair
handoff interface. Complete writer accounting, unknown descendants, actual Owner
terminal handoff, repair Moderator membership, human approval, semantic repair
validation, and production transaction durability remain outside the proof.

The proof and current recommendation are documented in
`docs/research/independent-repairer-feasibility.md`. The main proposal explicitly
distinguishes this viable candidate from its earlier full-automatic contract.
Recommendation: pursue the bounded helper after accepting its narrower scope,
not a permanent launcher or silent relaxation of the old requirements.

## Lesson

Moving the commit point before native relaunch removes the write-free-startup
requirement rather than trying to enforce it through late extension callbacks.
Requiring positive cleanup and exact exits replaces guessed lock inheritance;
uncertain handoff stops repair instead of triggering automatic orphan recovery.
