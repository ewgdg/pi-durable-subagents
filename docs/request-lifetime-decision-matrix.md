# Request lifetime versus historical-context marking

Decision support for [#131](https://github.com/ewgdg/pi-durable-subagents/issues/131).
**Provisional weights and scores; no alternative selected or implemented.** This
comparison reopens the lifetime question behind the
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

**B — Mark historical calls informational.** Keep durable Request semantics and
verified obligations, but render invalid or out-of-scope historical Request
call/result pairs as informational model context. Presentation alone does not
cancel an obligation; a valid Answer can still resolve it. This comparison does
not silently include new partial-admission rules for invalid canonical evidence.

These are different layers, not mutually exclusive features. A can also use
informational projection. To expose that distinction, the matrix scores A
without assuming that projection has already been added.

## Weighted comparison

Scores are design judgments, not benchmarks: 1 is poor and 5 is strong. Higher
scores for effort/risk mean a cheaper, lower-risk change. The provisional weights
put 55% on tolerance of broken history and long-term simplicity, reflecting the
discussion's emphasis on avoiding fragile recovery machinery.

| Criterion | Weight | A: transient | B: marking only |
| --- | ---: | ---: | ---: |
| Tolerance of broken historical Request evidence | 30% | 4 | 1 |
| Long-term implementation simplicity | 25% | 4 | 2 |
| Continuity across host restarts | 15% | 1 | 5 |
| Clarity of historical context to the model | 15% | 2 | 4 |
| Low implementation effort/risk | 10% | 2 | 4 |
| Live Request/Answer/Wait guarantees | 5% | 5 | 5 |
| **Weighted score, out of 5** | **100%** | **3.10** | **2.80** |

Weighted score is the sum of each score times its fractional weight.

## Why these scores

- **History tolerance:** A removes the need to reconstruct old duties, but cannot
  fix unreadable native transcripts or invalid identity/creation evidence. B's
  model projection occurs after native context construction and does not change
  protocol admission; malformed historical proof can still block coordination.
- **Simplicity:** A removes cross-host obligation recovery, not live Answer/cancel
  races, Wait, queue rules, or obligation-driven moderation. B retains that live
  machinery and durable replay, and adds a presentation transformation.
- **Restart continuity:** A deliberately loses runtime tracking of unfinished
  responsibility on restart, including a healthy restart. B retains it when the
  underlying evidence is verifiable; a score of 5 here is not a promise of
  recovery from arbitrary corruption.
- **Model clarity:** Lifetime changes alone do not identify each historical call
  to the model. B directly addresses that confusion, but call/result pairing,
  source identification, mixed assistant messages, and compaction summaries
  prevent treating the projection as trivial or perfectly comprehensive.
- **Change cost:** A changes an architectural guarantee and many consumers. B
  has a narrower model-context seam, though it still requires careful provenance
  handling and regression coverage.
- **Live guarantees:** Both can retain explicit live obligations and joins. This
  row does not credit A with guarantees across a host restart.

## Sensitivity and recommendation

The result is a modest preference, not a decisive numerical verdict. Move five
weight points from history tolerance to restart continuity and the ranking flips:
**A = 2.95, B = 3.00**. The important decision is whether cross-restart obligation
tracking is a product requirement, not the second decimal place.

For the current emphasis on simplifying broken-history recovery, prefer A as the
protocol direction and consider B as complementary model presentation for
out-of-scope history. Do not automatically repeat historical work. If preserving
responsibility across ordinary restarts is essential, retain durable Requests;
B improves their presentation but still needs repair or explicit reset for
unverifiable protocol evidence.

No weight can make presentation-only marking satisfy a requirement to admit work
despite failed protocol replay: that needs a separate recovery mechanism or a
change to what evidence the protocol depends on.

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
