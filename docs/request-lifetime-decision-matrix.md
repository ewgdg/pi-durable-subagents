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
using the remaining valid evidence. Skipping a call is not cancellation of an
already established obligation; a valid correlated Answer can still resolve it.
Original rejected evidence and diagnostics remain available.

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

## Replay contract needed before rescoring

- A verified delivered Request plus an unrelated invalid call: reject the invalid
  call and preserve the Request's obligation. A later valid Answer resolves it.
- An invalid attempted operation is not automatically cancellation of an existing
  obligation, nor permission to resend its work.
- If the rejected call is the only available source of a Request's identity or
  correlation, specify what surviving evidence can establish that relationship.
  Changing its display does not provide the missing proof.
- If rejected Answer evidence may have resolved a valid Request, specify whether
  resolution remains provable or the operation is treated as ineffective. Do not
  silently confuse an unknown outcome with an established unanswered Request.
- Define invalidity consistently across replay readers and model projection,
  including dependent Delivery, Answer, cancellation, and Creation evidence.
  This is the actual complexity to compare with A, not presentation cost alone.

These are open design questions, not a claim that replay rejection is infeasible.

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
