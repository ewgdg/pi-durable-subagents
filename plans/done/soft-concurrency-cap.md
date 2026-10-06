# Soft concurrency cap

## Goal and intention

Bring back `maxConcurrentAgentRuns` as an approximate bound on concurrent model work. Never reject or block a tool call: over the bound, a child's boot is deferred and re-driven when capacity frees. Overshoot is accepted. ADR 0005's exactness protocol (permits, release, FIFO capacity queue, wait-boundary hand-off) must not come back.

## Design

- **Count, derived per check.** A Run counts when it is starting, or live/ending with active work, no attention, no Interruption Hold, and not a parked Owner. Agent Wait, suspension (reported settled), human input, and settled-but-retained Runs do not count. Boots this scheduler has issued but that have not reached `starting` count separately, so one re-check cannot overshoot.
- **One gate.** Delivery admission to a dormant ordinary child (`directSpawnerAgentId !== null`) defers when the count is at the cap: the Delivery stays in `#pendingByAgent` without a boot. Spawn skips its own boot when there is no capacity, so its Creation Request reaches that gate. Owner, Moderator, interactive, and recovery boots are not gated.
- **Deferred = pending Delivery for a dormant Agent.** No new durable state; cold recovery already re-drives it.
- **Re-check trigger.** The coordinator's existing coalesced activity notification (state change, settlement, attention, delivery progress) plus Owner parking entry. No polling, no age bound.
- **Progress.** A deferred boot is Delivery progress: the deferred child is Progressing, Owner parking sees autonomous progress, and the Delivery wait is legitimate. Otherwise a parent waiting on it would look Stalled and summon the Moderator.

## Work plan

1. Failing tests: policy field; scheduler deferral, re-check after a slot frees, non-counting states, exemptions, in-flight boots, deferred child progress.
2. Policy field (default 8) → scheduler count/gate/re-check → spawn capacity check → coordinator trigger → verdict.
3. ADR 0007 superseding 0005; `docs/workflow-policy.md`; GLOSSARY.
4. Typecheck, targeted tests, commit, PR.

## Progress

- Red: the policy tests (field rejected), the deferral tests in `tests/deferred-agent-boot.test.ts`, and the new verdict row failed before implementation. All green after it.
- Found during design: the handoff's predicate (`phase !== dormant && attention === none`) counted settled Runs kept live by retention. A parent that ended its turn while awaiting an Answer would hold its child's slot. The count now requires active work.
- Found during design: a deferred child is dormant, so it was Inactive. A parent waiting on it would be Stalled and summon the Moderator. A deferred boot is now Delivery Progress.
- `workflow-continuation.test.ts` "continuation crosses runtime transport…" fails on `main` too; unrelated.
- Process tests: `agent-spawn`, `owner-settlement-parking` pass.
- Process `operational-incidents` "a settled answer-obligated Agent is reminded once…" times out in its PTY display on `main` too; unrelated. `message` passes.
- Fast suite: all pass except the pre-existing `workflow-continuation` failure.

## Outcome

Spawned-child boots defer over `maxConcurrentAgentRuns` (default 8) and start from the coordinator's activity notification once a slot frees. No permits, no rejection, no tool-call blocking. Not done: a model-visible "queued" marker on the spawn receipt or status; a deferred child currently shows as dormant.
