# Yield-based FIFO and visible Request obligations

## Goal and intention

Prevent request-ancestry scheduling from withholding useful clarifications at
cooperative boundaries. Make multiple open incoming Requests easy to identify,
inspect, and answer without turning attention ordering into execution ordering.

## Accepted scope

- Deferred Requests enter at agent_wait or settled work in live admission order,
  irrespective of Request ancestry. Preserve Steer priority, safe boundaries,
  one-at-a-time admission, cancellation, and exactly-once Delivery evidence.
- Require an immutable sender-authored title for ordinary and Creation Requests.
  Titles label work; IDs retain identity/correlation and full bodies retain
  authoritative instructions. No synthesized or compatibility titles.
- Expose a compact list of the caller's open incoming Requests: delivered,
  not answered, and not cancelled. Include ID, requester, and title, not bodies.
- Provide request-only inspection by ID/suffix for the caller's authored or
  delivered incoming Requests, returning the exact full Request. Do not expand
  this into general Message search or add independent task state.
- Use the originating Request title in Answer receipts and presentations,
  including direct delivery and Wait/retry retrieval. Keep canonical IDs.
- Update model guidance, maintained docs, and regression coverage. Remove the
  superseded ancestry eligibility policy and tests, not preserve exceptions.

## Exclusions

- GitHub issue #123 (potential proven-task reservation masking deadlock) remains
  deferred. Do not fold its fix into the scheduling policy change.
- No automatic repair or restart of the affected dotman workflow.
- No general semantic deadlock prevention, incremental Wait result streaming,
  new priority/fairness policies, or mutable Request/task status fields.

## Work plan

1. Add focused failing delivery regressions, then implement yield-based FIFO.
2. Add required title validation and canonical propagation, then surface titles
   in tools, delivery/reminder presentation, and Answer receipts.
3. Add read-only obligation listing and full Request inspection through the
   existing coordination interface, backed by canonical evidence.
4. Update affected fixtures/examples and docs; review integration and contracts.
5. Run typecheck and targeted unit/process regressions, not the full integration
   suite. Commit coherent task-owned boundaries and record checks/hashes.

## Validation

Use existing public protocol, coordination-tool, and real-host test seams.
Cover missing/blank titles, ordinary/Creation Request title fidelity, FIFO sibling
and unrelated delivery during Wait, active-work non-preemption, re-wait without
duplicate delivery, answer/cancellation removing obligations, title-only listing,
exact-body inspection and suffix ambiguity, and direct/Wait/retry Answer titles.
Test assertions should concern observable delivery and canonical evidence rather
than incidental scheduler data structures. Keep process tests tightly scoped.

## Progress

- User accepted yield-based FIFO, required titles, obligation listing, inspection,
  and title-based Answer receipts. Request-only inspection selected as the
  smallest interface meeting the stated need.
- Initial working tree clean. Relevant Pi docs and current messaging contracts
  inspected; native follow-up delivery is not equivalent to parked-Wait delivery.
- Implemented required canonical titles, title-bound Answer receipts and
  reminders, compact obligation context, public obligation listing and exact
  Request inspection, including real child-process transport.
- Removed ancestry eligibility. Deferred uses FIFO at cooperative boundaries;
  Steer retains priority. Updated recovery and real-process sibling/unrelated
  request regressions without retaining the superseded policy.
- Independent review found and corrected passive Owner-parking eligibility and
  partial streamed inspection rendering. Added failing regressions before fixes.
- Updated maintained glossary, messaging/spawning/recovery/reminder docs,
  README, tool guidance, and required-title fixtures.

## Decisions and discoveries

- Deferred remains the mode name: unlike native followUp, it can enter while
  agent_wait is an unfinished tool call.
- The open list is derived from existing Answer obligations, not a separate
  durable aggregate. A title is a label, not proof that an agent read the body.
- Passive Owner parking can leave the native prompt active. Cooperative
  eligibility belongs with the scheduler that owns that parking state, not the
  durable Request evidence module. The regression keeps child work active to
  prove delivery can release parking without relying on progress exhaustion.
- Inspection checks canonical admission and recipient identity. It includes
  closed Requests but never delivers queued work or mutates obligations.

## Outcomes

Completed. Targeted validation only; no full integration suite:

- 93 title/inspection/rendering/schema/lifecycle/eligibility tests pass (~1s).
- 3 real-process Creation inspection, passive Owner Deferred clarification,
  and Steer Wait-preemption tests pass serially (~3.8s).
- 46 obligation/recovery/real-process clarification tests pass (~8.3s).
- Backend fixture migration validation: 122 targeted tests passed.
- Typecheck and git diff --check pass.

Task commits before final integration: 05facf5 (canonical titles), 0b5b114
(title reminders), 894384f (fixtures), a5bdcc3 (parked boundary), and 3380842
(FIFO/recovery regressions). Final integration commits the remaining API,
presentation, scheduling selection, tests, and documentation.

Issue #123 remains deferred; the affected dotman workflow was not recovered,
restarted, or migrated. Runtime reload is not performed by this implementation.
