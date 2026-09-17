# Transient quota suspension

## Goal

Make a quota stop process-local: it stops its exact Run for the lifetime of the host,
and a host restart leaves the affected Agent as ordinary dormant work.

## Intention

A host restart already discards every other part of a Run: handles, execution fences,
native queues, in-flight tools, waits, incidents, and schedules. Only the quota stop
survived, through an Owner-transcript journal written solely to re-establish it during
cold recovery. Keeping that exception costs a durable schema with a fail-closed reader
(`evidence_unavailable` can block an Agent's recovery), a run-identity restoration path
that exists for no other lifecycle state, and a documented exception in the cold-recovery
contract. Its value is limited to suppressing post-restart wake attempts and preserving
typed native input until the next explicit human action.

## Scope and constraints

- Keep the live behavior unchanged: detection, exact-Run stop, execution-capacity release,
  dependency-path moderation suppression, queued-input retention, and explicit human or
  supervisory resume.
- Remove only persistence: the journal store, the restore path, and the cold-prepared
  editor branch for a restored stop.
- Host loss drops any captured native input together with every other volatile queue.
- No compatibility path for records written by earlier versions; the journal entry type
  becomes unknown coordination data and is ignored.

## Work plan

1. Delete `src/coordination/quota-suspensions.ts` and its store test.
2. Remove `restoreQuotaSuspension`, `#restoredQuotaRun`, `#preparingQuotaResumption`, and
   the restored branch of `prepareQuotaResumptionInLane` from the runtime supervisor.
3. Remove the journal from the coordinator and delete the cold-only Agent-view preparation
   branch in `#prepareAgentViewTarget`.
4. Rework quota tests that used restored suspensions to build live suspensions through a
   real Run and terminal quota event; assert the restart contract in the cold-recovery
   scenario; cover the run-scoped clear invariant where it now lives.
5. Rewrite the quota paragraphs in `docs/run-supervision.md` and
   `docs/cold-host-recovery.md`, the `CONTEXT.md` definitions, and the superseded banner in
   `plans/done/137-quota-suspension.md`.

## Validation

- `npm run typecheck`
- `tests/quota-suspension.test.ts`, `tests/quota-cold-recovery.test.ts`,
  `tests/quota-lifecycle-integration.test.ts`, `tests/quota-operational-incidents.test.ts`
- Agent-view and selector tests that exercise a suspended Agent
- `npm run test:process` only for the touched process files if the targeted runs pass

## Progress

- [x] Journal and restore path removed
- [x] Tests reworked around live suspensions
- [x] Docs and plan banner rewritten

## Decisions

- Restart is not consent to retry: after host loss the Agent is dormant, so the next
  explicit admission (`workflow_resume`, a Message, or editor input) may start a successor
  Run. While quota remains exhausted, that attempt re-suspends on the same retained
  provider evidence without producing model output.
- The run-scoped clear invariant stays: a stop may be cleared only by its own Run's
  explicit resumption or termination. With restoration gone it is structural (one retained
  Run per supervisor) rather than a `runSequence` guard, and it gets explicit coverage.

## Surprises & Discoveries

- The journal's `clear(agentId, runSequence)` guard and the removed `entryId` both existed
  only because a stop could be restored ahead of its Runtime, so a *different* Run could be
  live while the stop was keyed to an absent one. A single retained Run per supervisor
  removes that whole class of mismatch.
- An explicit post-restart recovery re-admits the stopped Agent's captured undelivered
  Messages, so the successor Run is reached through ordinary admission rather than a
  special resume path. The cold-recovery test now asserts that: the message arrives, the
  Run re-suspends on the same evidence, and a human editor message is still the deliberate
  retry.
- Deleting the store removed the fail-closed reader for quota records: unknown
  `agent-coordination.quota-suspension` entries written by older versions are now ignored as
  coordination data instead of failing an Agent's recovery.

## Outcomes & Retrospective

Delivered. `quota-suspensions.ts` (90 lines) and its test are gone; the supervisor lost
`restoreQuotaSuspension`, `#restoredQuotaRun`, `#preparingQuotaResumption`, and the restored
branch of `prepareQuotaResumptionInLane`; the coordinator lost the store, the recovery-time
relationship initialization loop, and the cold selection branch. Net `src` change is 14 insertions and 172 deletions with the live behavior untouched.

Verification: typecheck clean; `quota-suspension.test.ts` 9/9 (rewritten around live
suspensions, plus a new "only the exact Run and its resumption hold can clear a quota stop"
case), `quota-lifecycle-integration.test.ts` 7/7, `quota-cold-recovery.test.ts` 8/8 under
repeat runs, and `cold-host-recovery.test.ts` / `agent-view.test.ts` compared against a
clean base worktree with identical pre-existing failure sets. `npm run test:fast` reproduces
the same 10 pre-existing failures as base.

Follow-ups not taken here: the two process test files that fail identically at base
(`cold-host-recovery.test.ts`, `agent-view.test.ts`) remain failing and are unrelated to
quota.
