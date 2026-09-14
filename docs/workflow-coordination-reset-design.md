# Workflow coordination reset — design discussion

Direction discussed for [#131](https://github.com/ewgdg/pi-durable-subagents/issues/131).
**High-level direction agreed; operation and transaction contracts remain open.
Not implemented.** This document does not authorize runtime changes or implementation tasks.

Later discussion reopened obligation lifetime: see the
[transient Requests versus historical-context marking comparison](request-lifetime-decision-matrix.md).
That comparison has not selected a replacement for the explicit reset design.

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

### Quarantine does not exclude reset coverage

All Agents' old coordination is covered by the same reset, including quarantined
Agents. Coverage must not be limited to the coordinator's currently admitted
Agent roster or depend on successful replay of the damaged protocol evidence.
There is no separate reset or re-entry process for quarantined Agents.

Reset coverage and admission are distinct: capturing a quarantined transcript's
cutoff does not establish its Agent identity or Workflow membership. Invalid
identity or creation evidence can still prevent execution, but later repair must
not resurrect pre-reset Requests, Creation Requests, Answers, or obligations.
The reset representation must cover those historical sources even when their
protocol interpretation is currently unavailable.

### Shared markers and one authoritative commit

Use one reset ID, a passive native boundary marker in every Workflow transcript
candidate, and one authoritative commit in the Owner transcript referencing the
complete marker set. This includes quarantined candidates. Local markers are
inert preparation until the shared commit exists; they are not independent
Agent resets. Write all required markers durably before committing the reset.

Markers are stable anchors rather than byte offsets or line numbers that repair
could shift. Later repair must preserve the committed markers and the division
between historical and current coordination. If a required marker cannot be
safely written, the reset cannot be declared successful. Safe native transcript
access is required, but successful replay of old coordination is not.

The record model is agreed; exact native schemas, exclusive-startup integration,
and crash-durability details remain to be specified.

### Fresh startup is required

Reset must use a fresh host startup, not mutate coordination under running Agent
Runtimes. Retain durable Agents and their conversations, but do not carry their
native execution stacks or scheduler state through the reset. This is a design
requirement, not a fallback if live reset proves difficult.

The fresh host must establish that old affected transcript writers cannot
continue, then capture cutoffs and establish the shared reset before ordinary
coordination admission. A new process alone is not proof that old child writers
have stopped. `/reload` and an in-process session replacement are not the reset
mechanism. Reset remains an explicit action, not a side effect of every startup.

### Reset completes passively

Nothing starts work automatically after reset: no Owner recovery turn, child
continuation, Moderator investigation, or replayed Delivery. The human sends a
new message to start the Owner. Opening the UI and presenting reset diagnostics
are not permission to invoke a model.

Reset guidance must be available to that first user-started Owner turn and to
Agents when subsequently started through fresh input or coordination. Guidance
itself must not trigger execution. Reset ends at ready for input, not at recovery
work in progress.

This revises the direction originally requested in #131. Its partial-admission
acceptance criteria have not been met or implemented. The separate
[transcript repair proposal](workflow-transcript-repair-design.md) is not amended
by this discussion; repair can remain a separate continuity-preserving option.

## Proposed invariant

The whole Workflow uses one current coordination scope. Earlier Requests,
Answers, cancellations, and Deliveries remain historical evidence but do not
create current obligations or authorize current scheduling. Reset does not
misrepresent those historical obligations as Answered or cancelled.

The cutoff applies to coordination, not indiscriminately to every protocol fact:
retaining Agents still requires verified identity, membership, and creation
evidence. Merely instructing the model to ignore a tool result cannot enforce
this distinction.

## Candidate transaction — not yet accepted

Use the agreed append-only boundary markers and shared Owner commit. Do not
rewrite child transcripts, manufacture replacement Answers, or import the
transcript repair proposal's replacement and rollback machinery. The following
startup sequence still has open integration details.

1. Obtain explicit human approval and end the old host and its affected writers.
   Enter the fresh host through explicit reset startup, with ordinary coordination
   admission held closed. The reset-intent transport and exclusive-startup proof
   remain to be specified; requesting reset is not its commit point.
2. Append boundary markers with one reset ID across the Workflow's transcript
   candidates, including quarantined candidates, after the old writers have
   ended and made their final shutdown appends. Coverage must be complete before declaring a
   successful shared reset; do not silently skip a candidate because its
   protocol evidence is invalid.
   An active conversation leaf or timestamp is not a cutoff: coordination reads
   include all branches. Validate retained identity and creation evidence
   separately; a reset does not repair missing or invalid identity.
3. Durably commit one Owner declaration referencing the complete marker set
   before permitting new coordination. The exact native record schemas and
   crash-durability mechanism remain to be specified. Per-Agent explanatory
   messages are derived from that declaration, not independent reset commits.
4. Reconstruct current coordination from that shared declaration. Before its
   commitment, no reset has occurred; after commitment, every admitted Agent
   must use it. Incomplete or uncertain commitment blocks admission until
   resolved rather than letting different Agents choose different scopes.
5. Return to the Owner UI ready for human input, without starting any Agent work.
   Make reset guidance available without triggering a turn. A new human message
   starts the Owner; later Agent work follows fresh input or coordination, with
   reset guidance before execution. Reconciliation checks real outcomes and
   issues fresh Requests for remaining work; reset itself does not replay work.

Old completions and Deliveries committed during shutdown are captured on the
historical side of the cutoffs. Do not support a hot-reset mode that lets old
Runtime writers continue appending alongside fresh execution. If exclusive
startup cannot be established, reset must not commit or admit new coordination.
Post-reset operations must not adopt old sources merely because their native
tool-call IDs match; retained bootstrap evidence grants no current Request,
Answer, or Delivery authority.

Reset cannot undo an external effect or prove that an orphaned external process
stopped. Preserve that uncertainty for reconciliation rather than treating a
closed native Run as proof about the external world.

## Branch-switching contract — proposed

Reset scope follows physical, all-branch transcript history, not the selected
conversation leaf or the ancestry of the next message. Read the latest valid
shared commit and its boundary markers independently of native model context.
A later malformed or uncertain commit cannot be silently skipped in favor of
an older scope.

Selecting a pre-reset branch changes what the model sees, not which coordination
scope governs the Workflow. Pre-reset Requests remain historical even when they
are visible on that branch. A new invocation appended after the committed reset
belongs to current coordination even if its tree parent precedes the marker.
Moving away from a post-reset Request's branch does not undo that Request either.

The reset marker and its explanatory message need not be ancestors of the
selected leaf. Before a later user-started turn, derive the necessary reset
guidance from shared protocol state rather than trusting the selected branch to
contain it. Branch selection itself does not authorize recovery or replay.

In-place `/tree` navigation retains one session file. Owner fork/clone is
different: it creates a new Workflow with fresh Owner Identity under the existing
[Owner Fork contract](owner-workflow.md#owner-fork-and-clone). Copied source reset
records cannot grant authority in the new Workflow.

Pi's coding-agent README (Branching) and `docs/session-format.md` distinguish
in-place branching, `getEntries()` (all entries), `getBranch()` (ancestry), and
`buildContextEntries()` (active model context). Native custom entries persist
without entering model context. This supports the separation above; the reset
reader and guidance are not implemented yet.

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
  reread the native SessionManager from disk. Fresh startup still needs an
  established exclusive-startup and pre-admission seam; a UI pause, marker, or
  second process alone is insufficient. See
  [session replacement research](research/pi-session-replacement.md).

## Focused failure cases for the eventual contract

- A Request was delivered and an Answer is unreadable: reset retains the old
  evidence without creating a fresh unanswered Request or claiming completion.
- A rejected Request might represent performed work: no automatic resend and no
  assertion that its responsibility never existed.
- An old result, Answer, cancellation, or Delivery commits during shutdown:
  capture it before the reset cutoff; no current obligation or resolution.
- An old writer is still able to append: reset cannot commit. A retained old
  native tool-call ID must not bind historical evidence to a new invocation.
- A crash occurs before the shared commit or after it but before one Agent's
  explanatory message: no mixed coordination scopes on restart.
- Select a pre-reset branch whose ancestry lacks the markers: retired Requests
  stay historical and a newly appended Request uses the current scope.
- Select a different branch after authoring a post-reset Request: its obligation
  remains current. Branch switching is not coordination rollback.
- Reload, compaction, and repeated resets preserve the current shared scope;
  active context may omit reset guidance, but the next user-started turn has it.
- An Agent is quarantined at reset and repaired later: it was covered by the
  same reset, and admission cannot revive any pre-reset coordination. Including
  its transcript in reset coverage does not invent identity or membership.
- Successful reset starts no model turn, Delivery, child continuation, or
  Moderator investigation. Reset guidance and UI navigation remain passive;
  a new human message starts the Owner with the guidance available.
- A dormant child requires pre-reset explicit Spawn configuration: identity and
  preparation remain usable without recreating its old Creation Request.
- Fresh Requests, Answers, Wait, cancellation, and Run release operate normally
  after reset; historical relationships provide no current retention reason.

These are proposed behavioral tests, not tests already implemented or run.

## Contracts still to settle

- Exact native marker/commit schemas, complete candidate coverage, and durable
  write ordering for the agreed marker set and authoritative Owner commit.
- How old Runs, in-flight tools, queued Deliveries, and late results are fenced;
  reset cannot undo external effects of already-started work.
- How interrupted reset, startup, session replacement, and reload reconstruct
  one scope before any Agent resumes.
- What identity and creation evidence is sufficient to retain each Agent, and
  what happens when that evidence is itself invalid.
- How historical obligations and unknown outcomes are inspected without
  reactivating them; how recovery guidance reaches every resumed Agent.
- How retained Moderators' historical incident roles interact with later fresh
  work; reset itself starts no Agent, including the Owner or any Moderator.
- Approval, diagnostics, navigation independent of ordinary replay, and focused
  acceptance tests. Implementation tasks follow accepted contracts, not this outline.
