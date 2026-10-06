---
status: accepted
---

# Approximate concurrency bound by deferring child boots

Supersedes [ADR 0005](0005-no-workflow-wide-execution-queue.md). `maxConcurrentAgentRuns` is back, but only as an approximate bound on concurrent model work. Nothing is rejected, and no tool call waits for capacity. When a spawned child would boot while the count is at the bound, or while earlier boots are still deferred, the boot is deferred: its Delivery stays pending for the dormant Agent, and later checks boot deferred Agents in deferral order. The count is re-derived from current Run state at every check. Nothing is acquired or released, so the slot leaks behind ADR 0005 cannot happen.

A Run counts only while it does model work: starting, or live with no attention and either active work or Delivery Progress. The second case covers a just-spawned child whose Creation Request is still dispatching; without it, a burst of spawns would all see a free slot. Agent Wait, human input, Run Suspension, an Interruption Hold, a settled Run kept live by retention, and a parked Owner do not count. A waiting parent therefore never holds the slot its child needs. No hand-off at wait boundaries is required.

The bound is approximate in both directions, and this is deliberate:

- Concurrent checks can see the same free slot. A parked Run that resumes, a Moderator, the Owner, interactive input, and Workflow recovery all start work without a check. The count can exceed the bound.
- A parked Run still holds its process and memory, so the bound limits concurrent model work, not live child processes.

Only spawned children are deferred. The Owner and Moderators supervise the Workflow, and deferring them could stall the work that would free a slot. Their working Runs still count.

## Re-check trigger

Every Workflow activity notification (Run state change, settlement, attention change, delivery progress) and Owner parking entry queues one coalesced check. The check is level-triggered, so missing a single event is not enough to strand a boot; the next notification repairs it. There is no polling and no age limit on a deferral. A deferral that never ends means the trigger missed a slot-freeing change, which is a bug to fix rather than to mask.

## Observation

A deferred boot is a secondary state of `dormant`, not a new phase: observation reports `{ phase: "dormant", queued: true }`. The host Run is still dormant, so every phase consumer stays correct. A parent polling its child can still tell "queued" from "finished", and `/agents` shows the child as `queued` with the live Agents.

## Progress

A deferred boot counts as Delivery Progress. The dormant child is Progressing, its Delivery wait is legitimate, and the Owner may park behind it. Otherwise a parent waiting on it would appear Stalled and start Moderator handling. Delivery Progress is only reported while a working Run holds the slot, and that Run is real progress.

## Considered Options

- **Restore the exact queue (ADR 0005's removed design).** Rejected for the reasons in ADR 0005.
- **Reject spawns over the bound.** Rejected: rejection turns a load spike into a model-visible failure that the parent must retry.
- **Warn only.** Rejected: it does not bound anything.
- **Add polling or a deferral age limit as a backstop.** Rejected: neither helps a correctly counted full slot, and both would hide a missed trigger.
