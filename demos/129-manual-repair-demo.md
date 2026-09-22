# Demo: manual repair face (checkpoint-4 wired)

## A. Live, healthy Owner session
1. Launch pi with this build, open any healthy workflow session.
2. Run: /agents repair triage test -> Repair Moderator created (second call: already active, joins while live; after Dormant, fresh Moderator).
3. Run: /agents -> real Moderator record/Run visible; switch Owner <-> Moderator; join/release Runtimes without cross-host adoption; drafts preserved in respective editors; no auto-resume/return; pre-commit Owner shows snapshot only.
4. Run: /agents repair-freeze -> snapshot id; review advisory via repair_validate (frozen copies only, advisory, no authority).
5. Run: /agents repair-confirm <snapshotId> -> explicit Owner approval (approver equals Owner, provenance owner-session-confirm, bound to exact snapshot).
6. Prepare repaired copies, commit via Owner replace path (drift recheck, backup/seal/journal, single-use approval); repaired Owner reopens idle until new human message (no turn without human msg).
7. Esc or new human message revokes pending approval through the persisted ledger; never auto-retries.
8. moderator_control resolve -> Dormant, history retained.

## B. Admission-failed Owner session (preadmission entry)
1. Open a broken coordination session (admission failed).
2. Run: /agents diagnostics -> recovery offers manual repair (diagnosis first, explicit approval, backup/verify, idle reopen); press r for repair, Esc revokes pending approval via persisted ledger.
3. Run: /agents repair <reason> from the failed surface -> real Moderator hosted from verified Owner identity plus native config (no history replay, no fabricated records, unadmitted originals stay unavailable, manual only).
4. Same freeze/confirm/commit/idle/switch flow as healthy; failed-admission data kept (no writes on trigger, originals unchanged).

## C. Headless backend and wiring suites
- node tests/support/run-test-suite.ts fast --file=repair-freeze-backend.test.ts
- node tests/support/run-test-suite.ts fast --file=repair-commit.test.ts
- node tests/support/run-test-suite.ts fast --file=repair-wiring.test.ts
- npx tsx demos/run-repair-backend-demo.ts
- npx tsc --noEmit
