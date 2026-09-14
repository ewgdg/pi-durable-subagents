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

## Candidate transaction — not yet accepted

Prefer an append-only declaration in the Owner transcript. Do not rewrite child
transcripts, manufacture replacement Answers, or import the transcript repair
proposal's multi-file replacement and rollback machinery.

1. Obtain explicit human approval. Close ordinary coordination admission and
   fence the old Runs and writers before choosing cutoffs. Preserve durable
   Agents, not their executing native call stacks. A stale Runtime must not be
   able to author a new call that appears to belong to the new scope.
2. Capture a complete physical cutoff for each retained Agent, after fencing.
   An active conversation leaf or timestamp is not a cutoff: coordination reads
   include all branches. Validate retained identity and creation evidence
   separately; a reset does not repair missing or invalid identity.
3. Commit one declaration containing the shared scope and its participant
   cutoffs before permitting new coordination. The physical representation and
   crash-durability mechanism remain to be specified. Per-Agent explanatory
   messages are derived from that declaration, not independent reset commits.
4. Reconstruct current coordination from that shared declaration. Before its
   commitment, no reset has occurred; after commitment, every admitted Agent
   must use it. Incomplete or uncertain commitment blocks admission until
   resolved rather than letting different Agents choose different scopes.
5. Give the Owner recovery guidance. Leave ordinary children dormant until
   deliberately resumed, and provide each resumed Agent with reset guidance
   before it starts new work. Reconciliation checks real outcomes and issues
   fresh Requests for remaining work; reset itself does not replay old work.

The cutoffs classify source invocations, not merely where their results land.
A late result or Delivery for a pre-reset source remains historical even when
appended after the declaration. Conversely, source classification cannot stop
a stale Runtime from authoring a brand-new post-cutoff invocation: retiring or
generation-fencing those writers is mandatory. If a late result cannot be
unambiguously tied to its original source, it cannot authorize current work.

Reset cannot undo an external effect or prove that an orphaned external process
stopped. Preserve that uncertainty for reconciliation rather than treating a
closed native Run as proof about the external world.

## Repository constraints

- [Transcript consumption](transcript-consumption.md) distinguishes all-branch
  physical history from the active model-context branch. Existing scope changes
  at matching Identity bootstrap; a shared reset declaration has no behavior yet.
- Child Identity and captured preset do not contain all explicit Spawn
  configuration. Retain the original verified Spawn source as identity and
  configuration evidence without reactivating its Creation Request. See
  [Agent spawning](agent-spawning.md) and
  [`cold-host-discovery.ts`](../src/bootstrap/cold-host-discovery.ts).
- Moderator Input is its separate identity bootstrap. Its historical incident
  references are not new obligations; Moderator resumption policy remains open.
- Existing result matching often uses the Agent and native tool-call ID rather
  than the complete source pointer. Reset must not allow an old completion to
  bind to a new invocation with a reused tool-call ID. See
  [`request-resolution.ts`](../src/protocol/request-resolution.ts).
- Current shutdown closes coordination admissions and discards scheduling, but
  does not prove every native transcript writer has ended. `/reload` does not
  reread the native SessionManager from disk. The reset needs an established
  writer/admission seam; a UI pause or marker alone is insufficient. See
  [session replacement research](research/pi-session-replacement.md).

## Focused failure cases for the eventual contract

- A Request was delivered and an Answer is unreadable: reset retains the old
  evidence without creating a fresh unanswered Request or claiming completion.
- A rejected Request might represent performed work: no automatic resend and no
  assertion that its responsibility never existed.
- An old result, Answer, cancellation, or Delivery arrives after commitment:
  preserve it as history; no new obligation, resolution, or scheduler action.
- A stale Runtime authors a new invocation after the cutoff, or a native
  tool-call ID is reused: no stale work is accepted as current.
- A crash occurs before the shared commit or after it but before one Agent's
  explanatory message: no mixed coordination scopes on restart.
- Branch selection, reload, and repeated resets cannot revive retired work.
- A dormant child requires pre-reset explicit Spawn configuration: identity and
  preparation remain usable without recreating its old Creation Request.
- Fresh Requests, Answers, Wait, cancellation, and Run release operate normally
  after reset; historical relationships provide no current retention reason.

These are proposed behavioral tests, not tests already implemented or run.

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
