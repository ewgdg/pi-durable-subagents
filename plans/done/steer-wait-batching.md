# Steer batches at Agent Wait

## Goal and intention
Make Steer delivery batching consistent at cooperative Wait boundaries without
allowing ordinary Messages alone to preempt Agent Wait.

## Scope and constraints
A Steer Request or eligible Cancellation triggers one preemption and reserves
one immutable batch of all eligible Steer deliveries. Ordinary Steer Messages
may join but do not trigger it. Deferred still preempts with one Request;
Background stays queued. Preserve complete Answer aggregate precedence,
cancellation suppression, exactly-once proof, safe boundaries and later-arrival
exclusion. No issue #123 reservation fix or affected-workflow recovery.

## Work plan
1. Add failing mixed-batch, late-arrival/reservation and cancellation regressions.
2. Generalize prompt-owned reservation bookkeeping to a delivery batch and use
   existing Steer eligibility/suppression selection at Wait reservation.
3. Run focused unit and real-process regressions, update shared parameter
   description and maintained docs, typecheck and commit.

## Validation
Use the existing canonical transcript + real Wait coordinator harness for
mixed Messages/Requests, ordinary-only non-preemption, completed aggregate,
cancellation suppression, deferred single delivery, background exclusion and
proof/re-Wait behavior. Real-process test covers model-visible batch.
No full integration suite.

## Progress
Inspected installed Pi delivery documentation and scheduler/wait implementation.
Pi native steering defaults to one queued input at a time; a single custom
message can contain a batch of protocol deliveries. Wait already performs its
complete aggregate check before invoking the synchronous reservation callback.

Implemented one batch reservation at that callback and generalized prompt-owned
delivery bookkeeping from one item to an immutable item list with per-item proof
tracking. Deferred continues to use a one-item reservation. Reused existing
Steer filtering and cancellation suppression without altering normal batching.

Three focused mixed/ordinary-trigger regressions failed on the single-Request
implementation, then passed. Added cancellation suppression, complete-aggregate
precedence, late-arrival/re-Wait, and real-process mixed-envelope coverage.

## Decisions
Reuse existing Steer eligibility and cancellation suppression; do not loop the
single-Request preemption API. A batch reservation releases only when every
member has proof; each callback remains exactly once.

Answers are excluded from Wait-triggered batches. Parent confirmed that the
agreed scope covers ordinary Messages, Requests and Cancellations, not Answers.
An incomplete-aggregate regression failed when an Answer joined the batch, then
passed after filtering: preemption creates no requester-side Answer Delivery
proof, and a fresh Wait still retrieves the complete selected aggregate.

## Outcomes and validation
- 125 targeted unit/schema/delivery/Wait tests pass (~0.85s).
- 11 serial process tests pass (~13.5s): Steer preemption, Background, passive
  Owner parking and causal Request preemption. The new mixed-envelope case uses
  actual Owner/child/grandchild runtimes and completes both delegated Answers.
- Typecheck and git diff --check pass.
- Updated the shared deliveryMode description once and maintained messaging
  docs. No repeated prompt-guide paragraph added.
- No full suite, live API call, runtime reload, issue #123 fix or dotman recovery.

Validation logs: /tmp/steer-wait-red.log, /tmp/steer-answer-red.log,
/tmp/steer-wait-final-unit.log, /tmp/steer-wait-final-process.log,
/tmp/steer-wait-final-typecheck.log (disposable local evidence).
