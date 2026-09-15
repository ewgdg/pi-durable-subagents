# Recover Agents independently of rejected Spawn input

## Goal and constraints

Cold discovery must recover independently valid durable Agents even when their
historical `agent_spawn` input fails current declared record validation. This is
the existing skip-and-mark policy, not a migration or relaxed live-call schema.
Keep identity, root bootstrap, physical source attribution, unique claims, and
Owner-rooted ancestry checks. Never rewrite user transcripts or automatically
resume their work during verification.

## Failure case and decision

A valid child Identity can reference a now-rejected Spawn while its own valid
Delivery still establishes an Answer obligation. Quarantining that child loses
independent evidence; reconstructing its Creation Request or config from the
rejected call gives invalid evidence authority. Recover membership separately,
omit the authored Creation Request, and prepare later Runtimes from current
ancestry and the independently valid captured preset without rejected overrides.
Valid Spawn input keeps its metadata consistency checks.

## Work plan

1. Add regression coverage at existing discovery, request/recovery, and Runtime
   preparation boundaries; observe failure before each implementation slice.
2. Separate accepted Spawn input from independently verified membership and
   carry its absence through record creation, ancestry preparation, and evidence.
3. Update the recovery and replay contracts; review the source/test changes.
4. Run focused tests and typecheck, then the read-only real-session discovery
   probe. Commit, push, and open the requested new PR.

## Validation

- Rejected Spawn inputs preserve valid children and descendants, without using
  their config or reconstructing the authored Creation Request.
- Valid recipient obligations survive and retain orphan-Answer behavior.
- Dormant children remain selectable/resumable through current ancestry.
- Bad bootstrap, conflicting identities/source claims, and bad ancestry remain
  quarantined; discovery neither starts Runs nor edits transcripts.
- The original real-session probe must report 11 recovered, zero quarantined,
  and unchanged transcript hashes. Do not run the full integration suite.

## Progress

- Existing handoff records the original red probe: zero recovered, 11 quarantined,
  unchanged transcript hashes.
- Rebased the clean task worktree onto `origin/main` at `188821e`.
- Delegated source and test changes; documentation and final verification remain
  with the parent Agent. No real-session continuation is authorized by this fix.
- Implemented optional accepted Spawn input across discovery and Runtime
  preparation; missing authored Creation Requests no longer poison evidence lookup.
- Regression tests first reproduced missing-title/invalid-config quarantine,
  unavailable dormant-ancestor input, and missing Creation Request evidence errors.
  Focused validation is green: 30 discovery/evidence/replay cases, 4 factory cases,
  2 cold-host safety cases, and `npm run typecheck`.
- Original read-only probe passed: 11 recovered, zero quarantined, all transcript
  hashes unchanged. No Agent was resumed.
- Independent review found no blockers after tracing all production input
  consumers, source/identity/bootstrap checks, coordinator recovery, dormant
  ancestry, and orphan evidence. Readability-only test cleanup passed 6 focused
  cases and `git diff --check`.

## Outcome and validation limits

The original reproduction is fixed without transcript repair or relaxed live
validation. Captured identity and accepted operation input now retain separate
authority through discovery, request evidence, and Runtime preparation.

Tests cover preparation and dormant observation, not a fresh child-process
launch after rejected-source recovery; that launch closure was inspected by the
implementer and independent reviewer. No full integration suite was run.
