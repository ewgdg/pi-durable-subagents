# Background delivery

## Goal and intention

Allow optional Messages and Requests to wait until the recipient has completed
its current obligations, without reintroducing ancestry-based delivery gates.

## Scope and constraints

- Add explicit `deliveryMode: "background"` to ordinary Message and Request input.
- Admit at settlement (including passive Owner settlement parking), never at
  Agent Wait, only with no Answer obligations owed and no eligible higher-mode
  delivery. Preserve FIFO within Background and existing Steer/Deferred behavior.
- No automatic mode inheritance or ancestry exemptions. Creation stays Deferred.
- Preserve immutable retry/recovery identity, cancellation, and normal Answer
  obligations after delivery. Starvation is allowed; this is not execution order.
- Do not change issue #123 reservation cleanup, recover dotman, or reload runtimes.

## Work plan

1. Add failing protocol and coordination tests for Background admission, ordering,
   obligation gating, Wait exclusion, cancellation, and recovery.
2. Extend input/schema contracts and serialized scheduler eligibility; keep native
   Pi delivery mappings unchanged and use canonical obligation evidence.
3. Update maintained docs and concise tool guidance without repeating schema text.
4. Run targeted unit/process regressions and typecheck; commit completed changes.

## Validation

Test Messages and Requests, higher-priority bypass, FIFO and no duplicates,
Answer/Cancellation release, recovery of queued mode, and no mode inheritance.
Use real transcript evidence and one bounded real-process public-tool regression.
No full test suite.

## Progress and discoveries

- Inspected Pi extension lifecycle/delivery documentation and send-user-message
  example: native followUp is not Agent Wait preemption. Existing scheduler owns
  passive Owner settlement parking, so Background must use that same boundary.
- Added failing Background input/scheduling tests before enabling the mode;
  rendered-policy tests also failed before the renderer update.
- Extended immutable input validation and shared control/tool schemas. Existing
  canonical source reconstruction carries the mode through retry and recovery.
- Generalized the delivery blockage callback so both Background Messages and
  Requests consult canonical Answer-obligation evidence. Runtime boundary checks
  remain scheduler-owned; no new durable state or ancestry logic was introduced.
- Added one Background FIFO behind eligible Steer/Deferred deliveries. Existing
  recovery-continuation readiness reservations and dispatch-proof fences remain.
- Updated the renderer, tool guidance, README, glossary, and recovery/messaging
  docs. The Background process regression is registered in the process suite.

## Outcomes

Completed. Creation remains fixed Deferred; Answers and Cancellations retain
their fixed Steer delivery. Background is opt-in and may starve indefinitely.

Validation completed without running the full suite:

- 150 targeted unit tests passed (~1s): Background contract, runtime boundaries,
  Wait/recovery, message tool/rendering/delivery, registrar/control schemas,
  Request evidence/resolution, transcript facts, and parked Owner scheduling.
- 10 targeted real-process tests passed serially (~12s): Background Creation
  obligation release and Message/Request FIFO, passive Owner Deferred delivery,
  Steer preemption, and unrelated/sibling Request preemption regressions.
- Typecheck and git diff --check passed.

Coverage includes all-obligation Answer/Cancellation release, no Wait preemption,
higher-priority bypass, Background FIFO and no duplicates, canonical mode on
recovery/retry, queued Request cancellation, and no implicit mode inheritance.

No runtime reload, dotman recovery, or issue #123 reservation fix was performed.
