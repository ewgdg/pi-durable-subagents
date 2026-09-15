# Fork context clarity and child-fork removal

## Goal and intention

Implement #134 on top of #131's shared context-only projection. Owner fork/clone must retain clear current identity and inherited provenance across branches without changing durable evidence or obligations. Remove the child Conversation Fork mode whose prefix-preservation advantage this projection supersedes.

## Scope and constraints

- Preserve native Owner fork/clone and source transcripts, Workflow relationships, and the durable post-copy Identity cutoff.
- Classify inherited material by physical scope before current Identity, not selected tree ancestry. A new call appended under an old branch remains current.
- Project identity first and inherited groups with the existing structured `inherited` reason and compact `^` legend. Preserve mixed text and call/result pairing; projection is passive.
- Remove child-fork creation and public guidance, rejecting removed mode without side effects. Historical records follow #131 validation, not a hidden migration path.
- No invalid replay redesign, warning UX changes, or full integration suite.

## Work plan

1. Delegate child-fork removal, focused tests, and spawning documentation as a separate commit.
2. Inspect shared projection and native context/compaction hooks; add failing Owner projection regressions.
3. Implement verified identity and physical-scope inherited projection through existing hooks; document cache impact and behavior.
4. Review both changes together, run focused validation and typecheck, commit all task-owned changes.

## Validation

Test old-branch selection omitting handoff, current calls appended on old branches, inherited calls/results and coordination deliveries, mixed assistant text, reload/compaction/re-fork handling, passive unchanged source evidence, and removed child-spawn rejection with ordinary spawning retained. Run bounded focused tests rather than the full integration suite.

## Progress

- #131 implementation confirmed at `1527385`; shared structured projection contract is available.
- Child removal committed at `8c31959`; focused spawn/schema/launch tests and removed-mode cold recovery checks pass.
- Owner identity/inherited projection, native compaction (including previous summaries and split turns), and native branch summarization implemented and verified through native model-input checks.
- Durable fork provenance committed at `5f4f3f5`; the re-fork regression now preserves A/B attribution even when B's Identity is absent from copied ancestry, and destination-only reload preserves the capture.
- Exact duplicate native-message occurrence fixes committed at `a13284e` and `ab4f10a`, including cloned/compacted/reprojected contexts and combined inherited/invalid marks. Lifecycle combines both reasons in one projection pass.

## Surprises and discoveries

- Pi 0.85.1's native compaction and branch summarizers bypass the normal `context` hook. Compaction accepts transient message projection; branch summarization needs same-type ephemeral entry annotations and returned custom instructions. Its serializer drops tool results entirely, so inherited call attribution must be on assistant content while native calls remain for file tracking.
- A native re-fork copies selected ancestry, not the physical Identity cutoff. Correct origin attribution therefore needs captured entry-source evidence, not copied Identity order. Persist it in the destination once; missing source evidence before capture must be reported as unknown, never guessed from an older copied Identity.
- Faux model callback assertions can become assistant errors without rejecting a normal prompt. Native projection assertions are evaluated outside those callbacks so regressions genuinely fail the test.
- Clean baseline archive reproduced the pre-existing `ActivePromptDelivery.deliveryCommitted` type error, two registrar assertions requiring removed `Choose` wording, and two blocked-Owner tests expecting malformed history to deactivate tools despite #131. They are not part of #134 and remain unchanged.

## Decisions and concrete failure case

Tree ancestry cannot define inherited scope: after switching before the fork handoff, a newly appended Request has an old parent but belongs to the current Owner. Use the current verified Identity's physical cutoff to avoid turning that valid Request into historical information.

## Outcomes and validation

- Final focused validation: 60 unit/schema/provenance cases, four lifecycle hook cases, and eight native Owner fork/clone/summary cases pass (72 total). Delegate additionally verified removed-mode spawn refusal, ordinary/default/Template+config child spawning, and saved historical-fork quarantine with untouched source files.
- Typecheck has only the baseline `src/coordination/message-delivery-scheduler.ts:1164` error. The four baseline test failures above remain; no full integration suite was run.
- `git diff --check` passes. Maintained behavior and native summary-hook/cache consequences are documented in `docs/owner-workflow.md`; spawning documentation no longer advertises child forks.
- No source transcripts are rewritten, no hidden fork-spawn compatibility remains, and projection creates no model turn or protocol obligation. Provenance capture is presentation metadata only; unrecoverable pre-capture source loss is explicitly unknown rather than falsely attributed.

Focused commands:

```sh
node --import ./tests/support/pi-test-environment.ts --test --test-timeout=5000 tests/agent-spawn-input.test.ts tests/participant-tool-registrar.test.ts tests/pi-child-cli-launch.test.ts tests/coordination-history-context.test.ts tests/owner-fork-context.test.ts tests/fork-provenance.test.ts
node --import ./tests/support/pi-test-environment.ts --test --test-timeout=5000 --test-name-pattern='Owner context|context hook marks invalid|participant lifecycle registrar routes' tests/participant-lifecycle-registrar.test.ts
npm run test:process -- --file=owner-fork.test.ts --test-name-pattern='Owner fork projection survives|native Owner compaction receives|native branch summary distinguishes|native Owner clone|native Owner fork|native fork is cancelled|offline fork'
npm run typecheck
```
