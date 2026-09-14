# Request lifetime versus replay rejection and context-only marking

Decision support for [#131](https://github.com/ewgdg/pi-durable-subagents/issues/131).
**Scoring paused: the first matrix compared the wrong interpretation of B. No
alternative selected or implemented.** This comparison reopens the lifetime question behind the
[explicit Workflow reset design](workflow-coordination-reset-design.md).

## Alternatives

**A — Transient Requests.** Keep durable Agent identities and conversation history,
but keep Request obligations in one live Workflow host's ledger. Quit or host
failure ends that ledger; startup does not reconstruct obligations or replay old
Requests. Branch selection and individual child Runtime recreation do not end
the live Workflow's obligations. Continuing unfinished work after host restart
requires verified progress and fresh Requests, not automatic resend. Resource
reload must not accidentally reset just one participant; its exact host-lifetime
contract still needs design.

**B — Reject invalid replay inputs and mark them informational.** Keep durable
Request semantics, reject invalid historical calls as protocol-authoring inputs,
and expose them as context-only information to the model. Continue admission
using records that pass the declared data-shape validation. Rejected records
have no protocol effect; do not reconstruct partial facts from them or introduce
an uncertainty graph. Skipping a call is not cancellation of an already
established obligation. An Answer can commit against an existing obligation even
when the original Request was rejected; commitment resolves that obligation,
without Answer Delivery when there is no corresponding Request. Original
rejected evidence and diagnostics remain available as information.

B changes protocol replay as well as presentation. It is not the narrower
model-context-only transformation scored in the first matrix. Informational
projection can also complement A, but B's replay policy needs its own evaluation.

## Correction to the first comparison

The earlier claim that marking cannot help admission was true only for a
presentation-only transformation: current protocol readers would still inspect
the unchanged invalid evidence before the model runs. The user intended replay
to skip the invalid call as well. Under that proposal, admission can succeed;
the first matrix's history-tolerance score and resulting ranking do not apply.
The superseded scores and recommendation have therefore been removed rather
than presented as a decision about the user's actual proposal.

## Clarified replay contract for B

- Validate records against the defined data shapes. Skip invalid records during
  replay and mark them context-only for the model. Rejection is not uncertainty
  to propagate through the Workflow; invalid records simply contribute no effect.
- Obligations established by valid records remain. An invalid attempted
  operation neither cancels an obligation nor authorizes repeated external work.
- A missing original Request does not invalidate a responder obligation already
  established by a valid recipient-side Request Delivery.
- Admit a valid Answer against that existing obligation without requiring the
  skipped original Request. Answer commitment resolves the obligation. If there
  is no corresponding Request, omit Answer Delivery rather than failing the
  commitment or fabricating delivery proof.
- A rejected Answer record has no discharge effect. Do not infer protocol facts
  from the rejected record's apparent intent or from a previous schema accepting
  it; model-visible history can still inform what work was performed.

Concrete replay example:

```text
Owner Request source Q fails validation -> skipped, displayed as information
Responder's valid Delivery of Q         -> existing Answer obligation
Responder commits a valid Answer to Q   -> obligation resolved
Original Request Q is absent            -> no Answer Delivery
```

This defines the intended alternative for comparison; it is not implemented.
It differs from the original #131 requirement to preserve uncertainty about
rejected historical effects. Do not silently reimpose that earlier requirement
when evaluating this simpler rejection policy. Other orphan operation kinds and
exact validator/reader interfaces still need implementation-contract design, not
an investigation into facts supposedly recoverable from rejected records.

## Proposed comparison weights

Weights remain provisional and unapproved. Scores will be design judgments,
not benchmarks: 1 is poor and 5 is strong. Higher effort/risk scores mean a
cheaper, lower-risk change.

| Criterion | Weight |
| --- | ---: |
| Tolerance of broken historical Request evidence | 30% |
| Long-term implementation simplicity | 25% |
| Continuity across host restarts | 15% |
| Clarity of historical context to the model | 15% |
| Low implementation effort/risk | 10% |
| Live Request/Answer/Wait guarantees | 5% |
| **Total** | **100%** |

Neither A nor B can manufacture missing Agent identity or fix arbitrary unreadable
native transcript containers. A removes cross-host duty reconstruction but keeps
live Request machinery; B aims to preserve durable duties while refusing invalid
operations. Compare those actual policies before selecting a direction.

## Evidence and limits

- [Current Request semantics and recovery](agent-messaging.md) and
  [cold host recovery](cold-host-recovery.md) describe durable obligations, Wait,
  cancellation, and targeted continuation that A would change.
- [Transcript consumption](transcript-consumption.md) separates all-branch
  protocol evidence from active model context.
- Pi coding-agent `docs/extensions.md`, the `context` event, supports a
  non-destructive message transformation before each model call. The existing
  [`participant-lifecycle.ts`](../src/pi-integration/participant-lifecycle.ts)
  uses it for current Request-attention presentation. This demonstrates a seam,
  not a completed historical-call projection.
- Runtime code and documentation were inspected; no prototype, timing study, or
  new regression test was run for this comparison. Implementation tasks remain
  premature until lifetime and projection contracts are selected.
