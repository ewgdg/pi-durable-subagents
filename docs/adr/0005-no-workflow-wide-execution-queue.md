---
status: superseded by ADR-0007
---

# No Workflow-wide execution queue

A Workflow does not limit how many child Agent Runs execute at the same time. We remove `maxConcurrentAgentRuns` and its FIFO execution queue. A queue that a waiting parent can sit in deadlocks unless every wait gives up its slot and takes it back later. That give-up-and-reacquire step ran through Agent Wait, Human Requests, Run Suspension, Run end, and settlement, and it caused repeated slot leaks (`907ab7a`, `aa1002f`, `fd71ca2`). It also added a Progress Verdict waiting reason, a legitimate delivery wait, and an Owner parking exception. The limit protected against load spikes, but Pi's native retry and Run Suspension already cover provider rate limits and quota.

## Considered Options

- **Keep the queue and extract it as an Execution Capacity module.** Rejected: extraction keeps the slot hand-off at every wait, which is the source of the bugs.
- **Reject spawns beyond a cap, like Claude Code.** Claude Code (v2.1.217+) rejects an Agent tool spawn when 20 subagents are running (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). A rejected spawn has no queue, so it cannot deadlock. Deferred, not rejected: it is the layer to add if large fan-outs cause trouble. It would not count a dormant Agent that a Message wakes, so it is approximate by design.
- **Prior art without any limit.** T3 Code's orchestrator v2 has no global, per-project, or per-parent limit on concurrent turns or delegated tasks; it only serializes runs per thread, as this protocol already does per Agent.

## Consequences

- A policy file that still sets `maxConcurrentAgentRuns` is invalid under strict parsing. The Owner warns and uses the default policy until the user deletes that field.
