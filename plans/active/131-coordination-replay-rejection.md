# #131 — skip-and-mark coordination replay

## Goal and intention

Admit valid coordination history despite rejected ordinary records, preserve
independent durable obligations, and make rejected evidence informational to the
model. The user explicitly authorizes implementation beyond the issue's original
design-only phase. Source: latest #131 description read with `gh issue view 131`
and `docs/coordination-replay-rejection-design.md`.

## Scope and constraints

- Preserve identity, membership, role, native-container, and genuine bootstrap
  validation. Only declared record-shape failures are skip-and-mark.
- No uncertainty graph, migration, automatic resend, reset, repair engine, or
  warning UX redesign. Keep #134 fork integration out; share `!`/`^` reasons.
- Validate before mutation; retain raw evidence and source attribution.
- Do not reconstruct authored Requests from recipient Deliveries.
- Commit task-owned changes at meaningful boundaries; run focused tests only.

## Decisions and failure cases

The final reader/operation/presentation contracts are in the design document.
Answering an orphaned but delivered obligation returns a successful local
commitment with omitted Delivery, rather than misleading `sent` or failed commit.
Fresh missing selectors fail locally; replay does not reschedule orphan intent.

Concrete failure cases: a rejected Answer plus an old success receipt must not
erase a duty; a Delivery-derived fake Request must not become retry authority;
one malformed record must not poison a retained projection's valid suffix; a
rejected sibling call must not strand valid native tool-result pairs.

## Work plan

1. Finalize contracts and this plan before implementation. **Complete.**
2. Reader slice: add focused failing tests; implement shared record rejection,
   accepted-only protocol readers, and all-branch diagnostics. Audit secondary
   coordination record readers while keeping bootstrap strict.
3. Operation slice: add failing orphan-source tests; separate local obligation
   evidence from authored Requests; implement Answer commitment/receipt and
   missing-reference behavior across inspection, retry, cancel, Wait, recovery.
4. Presentation slice: add failing projection tests; implement shared reasons,
   one group marker, paired native-to-information transformation, and one legend
   in existing guidance. Integrate the non-triggering context hook.
5. Review the combined change independently, fix scoped findings, run typecheck
   and focused regression suites, update docs/plan, and commit all owned changes.

## Validation

- Test seams: public transcript readers, coordinator operations/recovery, and
  participant context projection. Red before green in each implementation slice.
- Rejected Request + valid recipient Delivery survives admission, accepts Answer
  without Delivery, and stays resolved after fresh replay.
- Rejected Answer has no effect; missing-reference retry/cancel/Wait/delivery
  cases remain local/non-blocking; independent valid Requests still work.
- All-branch incremental/cold replay parity, branch/compaction/reload invariance,
  immutable evidence, deterministic diagnostics, atomic invalid Delivery batches.
- Model input preserves source/content and valid sibling pairs, uses one `!` per
  affected group and one shared legend, and starts no turn. No inherited/fork
  behavior changes.
- Genuine bootstrap failures retain existing diagnostics. Avoid full integration
  suite; select files/cases and use bounded test timeouts.

## Progress

- Read latest issue, selected design, repository domain vocabulary, plan rules,
  and Pi extension context-hook documentation.
- Completed disjoint design inspections for reader and operation contracts.
- Finalized operation contracts and shared marking interface before tests/code.

## Surprises and discoveries

- Obligation focus currently consumes raw Answer receipts; accepted-source
  validation must prevent old success receipts from reviving rejected Answers.
- Requester membership and Request source availability are distinct facts.
- Pi's `context` event explicitly supports non-destructive message projection;
  no scheduling or transcript mutation is needed for marking.

## Outcomes and retrospective

Pending implementation and focused validation.
