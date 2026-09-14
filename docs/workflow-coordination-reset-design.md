# Workflow coordination reset — design discussion

Direction discussed for [#131](https://github.com/ewgdg/pi-durable-subagents/issues/131).
**High-level direction agreed; operation and transaction contracts remain open.
Not implemented.** This document does not authorize runtime changes or implementation tasks.

## Agreed direction

Prefer one explicit Workflow-wide reset over partial admission of damaged
coordination or replacement of the Workflow and its team. Keep verified Agent
identities, Workflow membership, and conversations; allow the Owner to resume
the same Agents after reset with fresh coordination obligations.

Preserve rejected evidence and historical progress. Agents verify actual outcomes
and coordinate remaining work through fresh Requests rather than blindly resending
old work. Reset is not evidence that previous work completed or external effects
were undone. It is distinct from Agent quarantine and from an Owner Fork into a
new Workflow.

This revises the direction originally requested in #131. Its partial-admission
acceptance criteria have not been met or implemented. The separate
[transcript repair proposal](workflow-transcript-repair-design.md) is not amended
by this discussion; repair can remain a separate continuity-preserving option.

## Proposed invariant

All participating Agents use one current coordination scope. Earlier Requests,
Answers, cancellations, and Deliveries remain historical evidence but do not
create current obligations or authorize current scheduling. Reset does not
misrepresent those historical obligations as Answered or cancelled.

The cutoff applies to coordination, not indiscriminately to every protocol fact:
retaining Agents still requires verified identity, membership, and creation
evidence. Merely instructing the model to ignore a tool result cannot enforce
this distinction.

## Contracts still to settle

- Where the authoritative shared reset is recorded and how it identifies each
  transcript's cutoff; no independently advancing per-Agent resets.
- How old Runs, in-flight tools, queued Deliveries, and late results are fenced;
  reset cannot undo external effects of already-started work.
- How interrupted reset, startup, session replacement, and reload reconstruct
  one scope before any Agent resumes.
- What identity and creation evidence is sufficient to retain each Agent, and
  what happens when that evidence is itself invalid.
- How historical obligations and unknown outcomes are inspected without
  reactivating them; how recovery guidance reaches every resumed Agent.
- Whether resumption is explicit per Agent or part of reset, and how dormant
  Agents and Moderators participate.
- Approval, diagnostics, navigation independent of ordinary replay, and focused
  acceptance tests. Implementation tasks follow accepted contracts, not this outline.
