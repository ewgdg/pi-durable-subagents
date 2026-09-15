# Skip-and-mark coordination replay — selected design

Design for [#131](https://github.com/ewgdg/pi-durable-subagents/issues/131).
**Implemented with explicit user authorization beyond the design-only issue.**
Execution and validation are recorded in
`plans/done/131-coordination-replay-rejection.md`.

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

Skipping invalid coordination records is not a Workflow admission failure and
must not mark the Workflow unavailable or emit an admission-failure warning.
Missing Request references handled by the selected rejection policy are not
Workflow admission failures either. A rejection summary, if presented, is
non-blocking. Genuine Owner/bootstrap failures, such as inability to establish
required identity or invalid required startup configuration, still fail admission
and retain their diagnostics. This is failure classification, not a redesign of
warning presentation.

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

Fork projection changes prompt-prefix reuse: identity-first context and inherited
marking favor clarity over the former prefix-preservation advantage. Child
Conversation Fork is removed; Owner fork/clone remain supported. Source
transcripts and obligations stay unchanged. See [Owner fork and clone](owner-workflow.md#owner-fork-and-clone)
for the projection and summary behavior; these remain separate from invalid-record replay.

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
- Invalid-record rejection and its handled missing Request references do not
  mark the Workflow unavailable or emit admission-failure warnings; genuine
  Owner/bootstrap failures still do.
- Missing-reference cases in retry, cancellation, Wait, and delivery have explicit
  outcomes consistent with the selected rejection policy.
- The model receives clearly invalid/context-only call/result information without
  provider-invalid tool pairing or loss of unrelated assistant content.
- Each call/result group uses one compact marker, with one shared legend instead
  of repeated explanations.
- Branch selection, compaction, or reload cannot turn rejected records into
  current protocol authority.
- Neither marking nor viewing diagnostics starts a model turn.

## Final reader and operation contracts

Replay validates each ordinary coordination record before applying any effects.
One native call, one native result, or one complete custom Delivery envelope is
the rejection unit; a malformed batch is rejected atomically. A shared reader
boundary returns accepted data or a structured Invalid rejection with physical
Agent/entry/call attribution and the validator diagnostic. Rejections are derived,
read-only, deduplicated, all-branch evidence; they are not durable tombstones.
Only declared record validation failures are caught. Unexpected implementation
errors, identity/bootstrap failures, role/membership failures, and contradictions
between otherwise valid canonical records remain errors. Missing ordinary Request
references follow the explicit contracts below, not a catch-all exception policy.

| Operation | Missing authored Request contract |
| --- | --- |
| Incoming inspection, obligation listing, reminders | Use independently valid recipient Delivery metadata, without reconstructing an authored Request. |
| Answer | Commit against the delivered unresolved obligation. Preserve same-source idempotency; reject a second distinct Answer. When the authored Request is absent, return `disposition: committed`, `delivery: omitted`, `reason: request_source_unavailable` with Answer/Request identity and title. Do not enqueue Delivery, wake the requester, fabricate proof, or report delivery failure. |
| Poll, retry, cancellation | A fresh operation targeting an absent authored Request fails locally with `unknown_identity`; no scheduling or cancellation effect. Historical orphan references cannot recreate the Request. |
| Wait | Unselected snapshots include only valid authored outstanding Requests. An explicit missing selector fails locally with `unknown_identity`; never silently shrink an explicit join. Historical Wait intent is not replayed as a new Wait. |
| Recovery and Delivery | Keep valid local obligations, but do not redeliver a missing source. A locally committed Answer remains resolved after restart and is not an outgoing Delivery candidate when its Request is absent. Independently valid delivered Cancellation remains local evidence. |

Rejected Answer calls and results cannot discharge obligations through receipt
text, focus snapshots, or earlier schema acceptance. A record's rejection never
cascades into rejection of independently valid recipient Delivery. In particular,
existence of the requester Agent does not imply existence of its Request source.

Historical focus snapshots have no obligation authority: they cannot introduce,
rewrite, remove, or resurrect a Request duty. On each execution, the coordinator
verifies the outstanding set across retained transcripts. The context hook keeps
a volatile exclusion of locally retained duties already resolved by that verified
evidence (including requester Answer Delivery before the local result). This
exclusion is refreshed at startup, applies to attention/continuation only, and
does not suppress newly delivered Requests. No new durable focus snapshot is
written, and no snapshot is used as a substitute for accepted source evidence.

The shared presentation interface accepts a structured `invalid` or `inherited`
reason; #131 produces only `invalid`. For each affected native call/result group,
project one informational group preserving source, call arguments, result content,
and diagnostics. Remove both native sides of that group from model input, retain
unrelated assistant content and valid sibling calls/results, and leave the source
transcript untouched. A result surviving without its call in compacted context
must also be informational, never a dangling tool result. Custom rejected records
are similarly informational. Preserve image content as typed image blocks, not
base64 text. Emit each informational group after its complete native tool batch
so valid sibling results remain adjacent to their native call message. Resolve
marked results against physical source ownership, not merely a tool ID that could
also occur in copied history. Apply projection at the existing non-triggering
model-context hook; do not add reminder turns. #134 owns inherited classification,
fork context ordering, and cache-prefix changes.

If removing rejected calls leaves only signed native thinking, preserve that
material inside the informational group instead of emitting a provider-invalid
thinking-only assistant message. Valid sibling calls and ordinary assistant text
keep their native representation.

Regression seams are the existing public transcript readers, coordinator
operations/recovery, and participant model-context hook. Tests exercise observable
authority, obligations, receipts, pairing, and restart behavior rather than private
projection state.
