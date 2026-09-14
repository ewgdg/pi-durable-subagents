# Request lifetime versus replay rejection and context-only marking

Decision support for [#131](https://github.com/ewgdg/pi-durable-subagents/issues/131).
**Alternative B selected; not implemented.** The weights and scores remain
judgment-based decision support. The accepted direction is recorded in the
[skip-and-mark replay design](coordination-replay-rejection-design.md).

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
projection can also complement A; the matrix compares the proposals as defined
above, rather than assuming A already includes B's per-call marking.

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

## Rebuilt weighted comparison

The weights are unchanged from the first comparison and remain provisional and
unapproved. Scores are design judgments, not benchmarks: 1 is poor and 5 is
strong. Higher effort/risk scores mean a cheaper, lower-risk change.

| Criterion | Weight | A: transient | B: reject and mark |
| --- | ---: | ---: | ---: |
| Usable coordination despite invalid historical protocol records | 30% | 4 | 4 |
| Long-term implementation simplicity | 25% | 4 | 3 |
| Continuity of valid obligations across host restarts | 15% | 1 | 5 |
| Model clarity about actionable versus informational history | 15% | 3 | 4 |
| Low implementation effort/risk | 10% | 2 | 3 |
| Live Request/Answer/Wait guarantees with valid records | 5% | 5 | 5 |
| **Weighted score, out of 5** | **100%** | **3.25** | **3.85** |

Weighted score is the sum of each score times its fractional weight. The
arithmetic and interpretation received an independent design cross-check.

## Score rationale and confidence

- **History tolerance, tied:** A excludes previous-host coordination from its
  current ledger; B skips invalid records and handles missing Request references
  without blocking valid Answer commitment. Both can keep coordination usable.
  This criterion does not require preserving the effects of invalid records.
  Neither policy fixes arbitrary unreadable native files or invents Agent identity.
- **Long-term simplicity, modest advantage to A:** A removes cross-host duty
  reconstruction. B retains replay, with explicit rejection and orphan handling,
  but no uncertainty graph. Both retain live Answer/cancel races, Wait, queue
  eligibility, and obligation-based moderation; neither is message-only simplicity.
- **Restart continuity, advantage to B:** A drops every obligation at host exit,
  even with pristine history. B retains obligations supported by valid records.
  Its score does not promise preservation of rejected effects or delivery of an
  orphan Answer; those outcomes are deliberately outside its contract.
- **Model clarity, provisional advantage to B:** A has a uniform previous-host
  lifetime rule but still needs a clear session-boundary presentation. B labels
  individual rejected calls directly. Both need to avoid confusing compacted or
  branched context with current duties. This score is about model presentation,
  not another score for replay tolerance.
- **Implementation effort/risk, low-confidence advantage to B:** B is closer to
  the existing durable model but changes replay, dependent consumers, orphan
  commitment, and context projection. A changes the lifetime contract and startup
  reconstruction more broadly. These are estimates, not measured change sizes.
- **Live guarantees, tied:** Both retain structured live delegation, Answer
  closure, and Wait in an uninterrupted host with valid records. Restart and
  rejected-record cases are evaluated in their own rows, not penalized again here.

## Recommendation and sensitivity

Under these weights, prefer **B: skip invalid records during replay and mark them
informational, while retaining durable valid obligations**. Losing all duties on
every restart is not necessary merely to tolerate malformed historical operations.
The user selected B. Implementation has not been undertaken or approved here.

The decisive tradeoff is intact restart continuity versus removing obligation
reconstruction altogether. If restart continuity has no value, move its 15% weight
to long-term simplicity (40%): **A = 3.70, B = 3.55**, so A wins narrowly. That is
a different product preference, not an error in either design.

The exact scores for clarity, conceptual simplicity, and change risk have limited
confidence until concrete context examples and a bounded implementation change
map exist. Do not interpret the decimal totals as measured precision.

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
  new regression test was run for this comparison. The direction is selected;
  exact interfaces and affected operation contracts precede implementation tasks.
