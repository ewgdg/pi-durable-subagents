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
Broken shape: duplicate valid Owner Message Deliveries for one committed Request
source. Both pass schema, so cold discovery cannot quarantine them:
WorkflowCoordinator.initialize throws ProtocolInvariantError, bootstrap wraps it
as OwnerRecoveryError. Regenerate with: npx tsx demos/make-broken-session.ts
(one self-contained file under demos/broken-session/, no child files needed).

1. From the repo root, launch with CURRENT checkout code (-ne skips the stale
installed copy, which registers the same tools and conflicts):
pi --session "/home/xian/Projects/pi-durable-subagents/demos/broken-session/2026-09-22T07-41-49-598Z_01a0c810-589e-778f-8836-a5dade9840d3.jsonl" -ne -e "/home/xian/Projects/pi-durable-subagents/src/index.ts"
Portable: pi --session "$PWD/demos/broken-session/<file>.jsonl" -ne -e "$PWD/src/index.ts"
No native rebuild needed (node-pty pty.node present). Print/RPC modes never
admit coordination; the TUI launch above is the live path.
2. First screen: blockage widget "Subagent coordination blocked / Saved
coordination data is invalid / /agents diagnostics". Run /agents diagnostics ->
Summary shows Problem, Reason: invariant_violation: Message has duplicate
Deliveries, Impact, Recovery (Manual repair via /agents repair <reason>;
replace path freeze/confirm/commit; Unadmitted originals stay unavailable).
Footer: q close, Esc close, r repair, t Technical details. t shows Stage: Owner
coordination initialization plus Agent/Transcript (the broken file).
3. Press r (or run /agents repair <reason>) -> notify "Repair Moderator
created: <moderatorId>" (repeat: already active). Real Moderator from verified
Owner identity plus native config; no history replay, no fabricated records;
unadmitted originals stay unavailable; manual only.
4. Same flow as healthy: /agents repair-freeze -> "Repair snapshot: <id>
(<n> targets)"; /agents repair-confirm <snapshotId> -> "Repair approval:
<approvalId> for snapshot <snapshotId>"; /agents repair-commit <snapshotId> ->
"Repair commit <disposition> (snapshot <id>); Owner idle until a new human
message." Esc revokes pending approval via the persisted ledger. /agents
switches Owner <-> Moderator. Failed-admission data kept (no writes on
trigger, originals unchanged); opening may append one native thinking/model
entry, the breakage persists.

## C. Headless backend and wiring suites
- node tests/support/run-test-suite.ts fast --file=repair-freeze-backend.test.ts
- node tests/support/run-test-suite.ts fast --file=repair-commit.test.ts
- node tests/support/run-test-suite.ts fast --file=repair-wiring.test.ts
- npx tsx demos/run-repair-backend-demo.ts
- npx tsc --noEmit
