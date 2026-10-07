# Drop the provider quota suspension reason

## Goal

Every unexpected terminal error from a still-usable Runtime suspends the Run as `runtime_error`. The `provider_quota` reason, its classifier, and its quota-only presentation are removed.

## Intention

Quota detection cannot be reliable. Each provider reports exhausted quota differently. Pi's `AssistantMessage.errorMessage` keeps only formatted text, and the HTTP formatter merges quota, throttling and other 429 responses. The classifier therefore recognizes only a few exact codes and one Codex diagnostic, and every other provider already falls through to `runtime_error`.

The suspension contract is identical for both reasons: hold, resume, and the incident and reminder quieting. What only quota has is the "Usage limit reached" label and a reset time, which only Codex/OpenAI supply. The provider's error text stays visible in the transcript and in the `runtime_error` evidence, so a human still sees why the Run stopped.

## Scope & Constraints

- Keep the `run.suspension` contract and its `reason` field, with `"runtime_error"` as the only variant. Status consumers and Run detail keep their shape, and the diff stays small.
- Remove:
  - `src/runtime/quota-evidence.ts`;
  - `RunEnd.quota`, together with the driver's call to `classifyQuotaEvidence`;
  - the `QuotaEvidenceSchema` / `provider_quota` wire schemas;
  - the supervisor's quota branch;
  - the quota label and Run-detail rendering.
- Behavior change: a quota error now displays as **Suspended · Runtime error**, with the provider's error text as evidence. Native retry/fallback is unchanged: throttling is still Pi's native recovery.
- Do not bump `AGENT_CONTROL_PROTOCOL_VERSION`. Owner and child always come from the same installed package, and earlier schema changes did not bump it.
- Do not add compatibility handling for `provider_quota`. Suspension is process-local and never persisted, so no stored state needs migrating.
- Tests:
  - Delete the classifier-only tests: the `quota-evidence.test.ts` diagnostic tables, the per-diagnostic process loop, and the exact-Codex case.
  - Convert the tests that use quota only as the trigger for a generic suspension behavior (cold recovery, human input provenance, incident quieting, parent quieting, hosted-runtime event forwarding, progress verdict, headless notice) to trigger a `runtime_error` instead. Drop "quota" from their file and test names.
  - Keep "temporary throttle uses native retry" (it covers native retry, not quota), renamed accordingly.
- Docs:
  - `docs/run-supervision.md`: one suspension reason. Replace "Provider quota evidence and upstream limitation" with a short statement that terminal errors are not classified by provider and the error text is the evidence.
  - Update `GLOSSARY.md` (Run Suspension), `docs/operational-incident-moderation.md`, `docs/workflow-policy.md`, `docs/cold-host-recovery.md`, and `docs/adr/0005` only if its wording is stale.
  - Add an ADR `docs/adr/0008-no-provider-quota-classification.md`.

## Work Plan

1. Source: remove the classifier, wire fields, supervisor branch and presentation. `npx tsc --noEmit -p .` drives the remaining edits.
2. Tests: delete or convert as above, and rename the `quota-*` test files (`tests/support/run-test-suite.ts` references quota files; update that too).
3. Docs and ADR.
4. Validation, then close this plan into `plans/done/`.

## Validation

- `npx tsc --noEmit -p .` is clean.
- `npm run test:fast` passes.
- Each touched or renamed process file passes in full with `npm run test:process -- --file=<name>.test.ts`.
- `grep -rni quota src tests docs GLOSSARY.md` leaves only intentional mentions (ADR, docs, the restore-quota advice).

## Decisions

- **Rejected: keep quota classification as a best-effort label.** A misleading or missing label is worse than a uniform one, and every addition (new provider codes) means maintaining provider-specific string matching against formatted text.
- **Rejected: fall back to Run Failure instead of suspension.** That ends the Run and turns its waiting Requests into failures, losing the resume path for a condition (quota) that a human can fix.
- **Rejected: remove the `reason` field.** That breaks the status shape for no gain, and the field still names the stop.

## Progress

- [x] Source (`bf90ace`)
- [x] Tests (`bf90ace`; they had to change with the wire types to keep `tsc` clean)
- [x] Docs and ADR (`28bf4a7`)
- [x] Validation

## Surprises & Discoveries

- With one reason, `formatSuspensionLabel(reason)` became a constant, `SUSPENSION_LABEL`. The headless suspension notice never depended on the reason, so it needed no change.
- Some tests collapsed into an existing `runtime_error` test after conversion. They were merged, and each one's distinct assertions were kept:
  - The process "retains quota Run and admits independent progress" loop, run once per quota diagnostic, became a single test. "a child suspended on a runtime error resumes through explicit supervisor input" was folded into it (no Moderator, resumed output in the same transcript).
  - "an unrelated terminal failure suspends the exact Run instead of reporting it" was folded into the converted native Owner test (exact evidence, no report).
  - Unit: "quota suspension precedes Run failure…" was folded into "a terminal error from a live Runtime retains the exact Run…". "an immediate renewed quota before resume transcript confirmation…" was merged with "ordinary terminal error before resume confirmation…".
  - Child bridge: `nonquota-terminal-queue` and `nonquota-native-retry` became the only `terminal-queue` and `native-retry` scenarios.
- The process "exact Codex diagnostic" test was the only process-level check that a renewed stop survives resume commitment. That behavior stays covered by the unit test "a renewed terminal error before resume confirmation replaces the stop with its own evidence". Review found that test had no queued input. It now also asserts that held native input stays queued after the renewed stop, so it covers the deleted test's "queued input must not start another model call".
- The fixture extension now registers its own `terminal-error-fixture` provider instead of impersonating `openai-codex`. The process integration harness no longer loads it.
- Quota errors now pass the `runtime_error` branch's guards, which the old quota branch skipped: the interruption guard, the already-failed guard, and the usable-Runtime guard. In practice only one case changes. A quota error from a Runtime that is already unavailable now ends as a terminal Run Failure, as the documented "still-usable Runtime" contract says. Before, it became a suspension that could never resume.
- `docs/adr/0005` and `docs/workflow-policy.md` say Run Suspension covers quota. That is still true, so both were left unchanged.

## Outcomes & Retrospective

- `provider_quota`, `QuotaEvidence`, `RunEnd.quota`, the classifier, the quota supervisor branch, and the quota label and Run detail are gone. `run.suspension` keeps its shape, and `runtime_error` is its only reason.
- Deleted: `tests/quota-evidence.test.ts` (3 tests); the child bridge `evidence` scenario; the native driver "quota error" rows; the process "exact Codex diagnostic" test.
- Renamed:
  - `quota-lifecycle-integration` → `run-suspension-integration`
  - `quota-cold-recovery` → `run-suspension-cold-recovery`
  - `quota-operational-incidents` → `run-suspension-operational-incidents`
  - `quota-human-input-source` → `human-input-source`
  - `fixtures/quota-evidence-extension` → `fixtures/terminal-error-extension`
- Process time, measured as full-file wall time before → after:
  - `run-suspension-integration`: 9.0 s → 5.3 s
  - `pi-child-hosted-runtime`: 10.4 s → 8.6 s
  - `run-suspension-cold-recovery` and `headless-workflow`: unchanged
  - Deleted or merged process tests summed to about 5.5 s.
