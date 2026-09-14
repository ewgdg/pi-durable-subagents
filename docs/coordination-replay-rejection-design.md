# Skip-and-mark coordination replay — selected design

Design for [#131](https://github.com/ewgdg/pi-durable-subagents/issues/131).
**Direction selected; not implemented.** Exact reader interfaces and affected
operation contracts still need a bounded design pass before implementation tasks.

## Decision

Keep durable Requests. Reject records that fail the declared data-shape
validation during replay and render their call/result context as informational.
Invalid records have no protocol effect; there is no uncertainty graph or partial
reconstruction of rejected records.

This replaces the explored Workflow-wide reset and transient-obligation
directions. The [decision matrix](request-lifetime-decision-matrix.md) records the
comparison. The selected mechanism does not discard valid obligations on host
restart, require new Workflow identities, or reset every Agent to handle one
invalid historical call.

## Request and Answer behavior

Obligations established by valid records remain. Skipping an invalid operation
is not cancellation, and does not authorize repeating external work.

A valid recipient-side Request Delivery can establish a responder obligation
even when the requester-side source call is rejected. A valid Answer can commit
against that existing obligation without requiring the missing original Request.
Commitment resolves the obligation. If the corresponding Request is absent,
omit Answer Delivery; do not turn that into failed commitment or claim delivery.

```text
Owner Request source Q fails validation -> skipped, informational
Responder's valid Delivery of Q         -> Answer obligation remains
Responder commits a valid Answer to Q   -> obligation resolved
Original Request Q is absent            -> no Answer Delivery
```

An invalid Answer record contributes no discharge effect. Do not infer effects
from rejected evidence or a previous schema accepting it. Historical information
can still show what work was performed, so an Agent can reuse an existing result
rather than blindly repeating the work.

Existing identity, membership, and role requirements remain. This policy does
not fabricate an Agent or repair arbitrary native transcript-container damage.

## Shared context-only marking

Use compact ASCII markers with distinct structured reasons:

| Mark | Reason | Meaning |
| --- | --- | --- |
| `!` | Invalid | The record failed declared validation; it has no protocol effect. |
| `^` | Inherited | The material belongs to another Agent's inherited scope; it may be entirely valid there. |

Include one legend in the existing coordination guidance:

> History marks: `!` invalid, `^` inherited. Both are informational; neither cancels an existing obligation.

Prefix each projected call/result group once, not every line or field. Keep the
reason structured internally; the symbol is just its compact presentation. Do
not repeat the legend beside each call or append reminder messages.

The mark describes the affected material, not cancellation of a related valid
obligation. Inherited material creates no duties for the new Agent and does not
alter the source Agent's obligations.

Preserve source attribution and useful content. Project related calls and results
consistently, without dangling native tool results, and preserve unrelated text
in mixed assistant entries. Do not rewrite the original evidence merely to
change its model-visible representation. Marking itself starts no model turn.

## Scope split

**#131 owns** invalid-record replay, valid-obligation preservation, Answer
commitment with a missing original Request, and the shared invalid/context-only
presentation contract. It must establish the affected retry, cancellation, Wait,
and delivery outcomes without reintroducing uncertainty reconstruction.

**[#134](https://github.com/ewgdg/pi-durable-subagents/issues/134) owns fork-side projection.**
It applies the shared representation to inherited coordination, including copied
Request Deliveries, and puts verified current identity first in model context. Preserve
the durable Identity cutoff after copied history rather than moving it to the
front of unchanged native protocol records. Classification follows all-branch
scope, not the selected leaf; inherited valid calls must not be called invalid.

That fork change affects prompt-prefix reuse: the current Conversation Fork
preserves the completed parent message prefix. Explicit identity and inherited
marking favor clarity over that cache-affinity property. Keep the source
transcripts and obligations unchanged; exact fork projection and cache behavior
belong in #134, not invalid-record replay.

Warning UX remains with #125 and repair mechanics with #129. This decision does
not redesign either or introduce a general repair engine.

## Focused acceptance cases

- An invalid historical coordination record does not abort admission; valid
  records on every physical branch continue to participate under one rejection
  rule, and original rejected evidence remains available.
- A valid delivered obligation survives rejection of its original Request source;
  a valid Answer closes it without delivery, including after another replay.
- A rejected Answer has no effect; no effects are reconstructed from its text.
- Independently valid operations remain usable; no automatic Request resend.
- Missing-reference cases in retry, cancellation, Wait, and delivery have explicit
  outcomes consistent with the selected rejection policy.
- The model receives clearly invalid/context-only call/result information without
  provider-invalid tool pairing or loss of unrelated assistant content.
- Each call/result group uses one compact marker, with one shared legend instead
  of repeated explanations.
- Branch selection, compaction, or reload cannot turn rejected records into
  current protocol authority.
- Neither marking nor viewing diagnostics starts a model turn.

These are design acceptance cases, not tests already implemented or run.
