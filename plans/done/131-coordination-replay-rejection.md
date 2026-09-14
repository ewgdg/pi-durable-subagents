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

All five steps are complete. The implementation commit follows the contract/plan
commit; baseline validation failures below remain explicitly out of scope.

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
- Committed contracts/plan as `4b00f7d` before implementation.
- Presentation regressions demonstrated red, then green for mixed call/result
  groups, compacted result-only context, custom Delivery marking, source-scope
  isolation, and the shared inherited symbol. Context-hook and guidance tests
  also demonstrated red then green without scheduling or transcript mutation.
- Reader and coordinator slices were implemented independently under the
  finalized contracts and independently reviewed with the presentation slice.
- Coordinator operation slice passes 84 focused tests, including missing-source
  Answer commitment/replay, orphan operation behavior, wire receipt schema, and
  rendering. Native admission classification was then covered separately.
- Presentation review found compacted result ownership and image preservation
  defects. Both gained failing regressions before correction; all seven shared
  projection tests now pass. Informational groups preserve typed media and follow
  the complete native batch rather than interrupting valid sibling result pairs.
- Follow-up review caught signed-thinking-only provider history and focus-snapshot
  authority leaks. Added regressions before fixes: signed thinking is preserved
  as information, and snapshots now have no obligation effect. Startup attention
  reconciliation is volatile and backed by the coordinator's verified set, so
  existing remote Answer proof suppresses stale local attention without durable
  snapshot authority. Local committed/omitted Answers also retain the ordinary
  one-shot continuation behavior when other valid obligations remain.
- Native Owner admission/reload and genuine bootstrap/strict-failure cases pass
  11 focused cases; the new invalid off-branch admission case fails on baseline
  HEAD and passes with the implementation. Source bytes remain unchanged.
- A gated startup regression caught the cross-process reconciliation race:
  local exclusion candidates must be frozen before awaiting verified coordinator
  frames, so Delivery during that await is never hidden by an older snapshot.
  The regression passed after moving that snapshot before the await.
- Actual RequestEvidence Answer-proof reconstruction now feeds lifecycle
  context tests across fresh replay/re-registration, including rejected-source
  negative control. Native lifecycle fixtures use valid Delivery and Answer
  evidence rather than focus snapshots; nine native cases pass.

## Surprises and discoveries

- Previously, obligation focus consumed raw Answer receipts and focus snapshots;
  accepted-source validation and removal of snapshot authority prevent rejected
  history from reviving or discharging duties.
- Requester membership and Request source availability are distinct facts.
- Pi's `context` event explicitly supports non-destructive message projection;
  no scheduling or transcript mutation is needed for marking.
- A clean archive of baseline HEAD reproduces an unrelated typecheck error:
  `message-delivery-scheduler.ts:1164` reads nonexistent `deliveryCommitted`.
  It also reproduces two lifecycle tests expecting `Choose` in unchanged Request
  presentation text. These pre-existing issues are not included in #131 fixes.
- The operation implementation also reproduced a pre-existing Workflow Resume
  expectation mismatch (`continuation_admitted` versus `already_running`) in the
  clean baseline archive; it remains outside this change.

## Outcomes and retrospective

Implemented shared typed record rejection, accepted-only readers and diagnostics,
local orphan-obligation Answer commitment, operation-local missing-reference
handling, wire receipts, and non-destructive model projection. Identity/bootstrap
and canonical contradiction checks remain strict. No #134 fork classification,
identity-ordering, branch behavior, or prompt-cache changes were implemented.

Final validation:

- 219/219 focused cases across 21 protocol, operation, projection, schema,
  transcript, and native-lifecycle test files passed (about 2.8 seconds).
- 11/11 selected Owner admission/reload and genuine bootstrap failure cases
  passed (about 1.9 seconds).
- Lifecycle registrar: 21 passed; its two previously reproduced `Choose` wording
  assertions remain failing. No new registrar failures.
- Typecheck reports only the independently reproduced baseline scheduler error;
  no introduced TypeScript errors. `git diff --check` passes.
- The full integration suite was not run, per repository guidance.

Evidence logs are retained under
`~/.agents/artifacts/outputs/pi-durable-subagents/2026-09-14/131-coordination-replay-rejection/`.
Key final logs: `pi131-final-focused.log`, `pi131-final-admission.log`,
`pi131-final-lifecycle.log`, and `pi131-current-typecheck.log`. Baseline logs and
review red/green evidence are retained alongside them.

Secondary-reader audit: declared Human Answer, supervisory Resume, reminder,
run-failure and Moderator report/read-state schemas share rejection. Workflow
continuation and delivery-failure exact-content matchers have no declared parse
schema and already ignore nonmatching content; no speculative schema was added.

The reusable lesson is to separate durable evidence from attention snapshots:
recipient obligations do not depend on successful replay of requester authorship,
and context reconciliation must not become a second source of protocol authority.
