# 129 manual repair Moderator — diagnosis face, minimal backend

## Goal
Escape hatch for broken coordination sessions. Manual /agents repair opens a real Moderator in the same workflow dir, switchable via /agents with the Owner. Diagnosis first, explicit user-approved replace only. No auto trigger.

## Intention
Mimic the manual user process as a faithful clone: close Owner writers, fresh separate host, copy-fix-verify-replace-reopen idle. Moderator is the face (native TUI, identity, steering, Dormant after resolve); backend stays minimal (inspect/backup/verify/restore + installed-src diagnosis).

## Scope & Constraints
- Manual /agents repair only. No auto trigger, no background watcher.
- Real Moderator: real record, handling responsibility, ordinary tools + one optional validate tool, resolve to Dormant. No rigid candidate/report tools.
- Same workflow dir, repair namespace excluded from frozen targets. Targets are retired Owner + original inventory.
- One at a time: join-or-refuse on unknown cleanup.
- Pre-commit Owner target is frozen snapshot only. Post-commit Owner is idle until new human message. Switch joins/releases Runtimes, preserves drafts, no auto-resume.
- No upstream Pi changes. Focused tests + typecheck per checkpoint.

## Work Plan
1. Manual trigger to real Moderator hosting stub (record, handling, discovery as Dormant, agents switch, snapshot-only Owner target). No writes.
2. Minimal backend: inspect/backup/verify/restore on frozen copies, installed-src paths, validate advisory only.
3. Explicit replace path behind separate user approval: drift recheck, backup/seal/journal, idle reopen.
4. Old branch feat/129-independent-repair and plans/proposed/129-hosted-moderator-repair.md stay read-only reference.

## Validation
- Red tests first: pre-commit Owner shows snapshot; resolve goes Dormant; second attempt while live refuses/joins; repair namespace excluded from freeze.
- Focused suites + typecheck per checkpoint. Independent review before publish path.

## Progress
- Fresh branch feat/129-manual-repair-moderator cut from origin/main at 7f5e66b.
- Checkpoint 1 (manual trigger to real Moderator stub): manual-only trigger confirmed, no auto-trigger text present.
  - `manual_repair` ModeratorInput trigger (truthful: reason only, no Requests, no incident, no affected Agents).
  - Minimal shared hosted-Moderator core extracted (`src/coordination/hosted-moderator.ts`: commit/verify, real record, moderator_handling, routine-start admission); incident `createModerator` reuses it, behavior preserved.
  - Manual `/agents repair` (Owner only, join-while-live) via `OperationalIncidentCoordinator.requestManualRepair`; repair transcripts live under canonical `repair/` namespace, excluded from frozen targets.
  - Cold discovery scans `repair/` (exact Workflow binding, Moderator-only; alias/dup/conflict quarantined).
  - Preadmission stubs: immutable Owner evidence snapshot, precise unavailable routing for unadmitted originals.
  - Authenticated `moderator_control` resolve releases to Dormant with history retained; selection opens Runtime without admitting a Run or replaying routine-start.
- Checkpoint 2 (minimal inspect/backup/verify backend on frozen copies): frozen-only, advisory validate, no publish path.
  - Frozen enumeration consumes `isRepairManagedPath`: top-level inventory only, `repair/*` never targets; live repairer is writer/host via join-or-refuse (`shouldJoinLiveRepair`), never a target.
  - `src/coordination/repair-freeze.ts`: list/sha256/backup/restore plus read-only inspect (admission readers) and dry-replay verify (pass/fail + warnings, missing-title out-of-scope, replay-pass does not imply safe).
  - `src/coordination/repair-validate.ts`: executing package source path/version plus doc paths plus staged error/stack (no cwd/HEAD assumption); advisory `validateRepairFreezeAdvisory` edits nothing, authorizes nothing, seals nothing, never resolves.
  - Advisory-only `repair_validate` on the manual repair Moderator only (read-only inspectors, effects/startup/model disabled); other moderators refused; prior reports can never authorize changed bytes.
  - Pre-commit Owner stays snapshot-only, post-commit idle-hold, drafts preserved, no auto-resume; unadmitted-original routing stays precisely unavailable.
- Checkpoint 3 (explicit user-approved replace path): approval-gated commit with drift recheck, backup/seal/journal, idle reopen. No new model tools, no auto-resume/retry.
  - `src/coordination/repair-commit.ts`: `approveRepairReplace` (provenance exactly `owner-session-confirm`, advisory/model/moderator_control rejected `unauthorized`); ledger consumed+revoked with `notifyRepairHumanInputBeforeCommit` esc/human-message revoke (`revoked`, never auto-retries); `assertRepairApprovalFresh` refuses stale snapshot (`stale_approval`).
  - `freezeRepairTargets` snapshot {snapshotId, createdAt, workflowDirectory, sorted entries} via list+sha256; `runRepairPreCommitGate` order approval-freshness, live-writer retirement (`join_live_repair`), re-enumerate, drift membership+sha256 (`drift`), exact-bytes `verifyFrozenCopy` replay (`replay_failed`, warnings + missing-title outOfScope); audit backupLocation undefined.
  - `commitRepairReplace`: same-attempt journal join (`joined-committed`, no reapply/backup/generation bump); gate-first (no writes on failure); exact repaired-set match; repaired verify; `backupFrozenTargets` + manifest; generation seal `repair-generation.json` mode 600; copyFile apply + hash verify (never rolls back after); journal `repair-journal-<attemptId>.json` mode 600 status committed; ledger consumed single-use; `crash_simulated` throw after disk commit; admission failure returns `committed-admission-failed` with truthful error, data kept.
  - `recoverRepairCommitFromJournal` returns `committed-awaiting-admission` read-only (second call identical); `openRepairedOwnerIdle` idle-until-human-message hold (no autoResume/autoViewReturn); stopped-writer recovery instructions + preconditions (`recovery_blocked`), `selectRepairHistory` never restarts, `isRepairTransactionClosed` for committed states.
  - `tests/repair-commit.test.ts` (7 fast tests, no models/PTY): stale/advisory rejection, esc+human-message revoke + fresh pass, added/changed drift + live repair/* exclusion + live-gate refuse, happy-path (backup+manifest, generation 1, journal approver/provenance, audit diffSummary/warnings/outOfScope/backupLocation, single-use consumed, same-attempt join no bump), crash recovery (hash+mtime stable, identical second recover), admission-failure data retention + idle fields, recovery/closed-transaction checks.
- Checkpoint 4 (replace-path wiring; done, focused suites + typecheck green): preadmission trigger from failed admission, Owner confirm, Esc/human-message revoke via persisted ledger, idle hold by host, join/release without adoption.
- CP4 review fix pass (5 majors + safety minors + test-honesty, test-first, focused suites + typecheck green): preadmission host is repair-only at coordinator level (spawn/message/wait/control/resume throw repair_only); /agents repair-commit <snapshotId> (Owner-only, sealed exact-bytes commit with idle hold) wired for healthy + preadmission with completions/usage/diagnostics text; preadmission setup failures surface via notify with data untouched (extracted testable setupPreadmissionRepairHost + identity/dir asserts); idle hold releases only on admissible submitted/continue (discarded duplicates keep it); live two-trigger join test on a real coordinator (mock rescoped disposition-only); ledger rethrow on corrupt at confirm; confirm-while-pending rejects; Esc persist failures notify; notifyRepairHumanInput Owner-only; idle covers committed-admission-failed; Esc ledger-on-disk + beginExecution refuse/release + sealed-commit + moderator-refusal + repair_only + discarded-hold + corrupt-ledger + diagnostics r/Esc tests.
  - Preadmission entry: verified Owner identity plus native config (sessionDir/agentDir/workflowDirectory) via capturePreadmissionRepairEvidence, no history replay, no fabricated Owner record/relationships/Request titles/live originals; unadmitted routing stays precise-unavailable; manual only, no watcher. Diagnostics offers repair (r) with truthful scope; Esc revokes via persisted ledger; /agents repair/confirm/freeze work from failed admission via preadmission host (WorkflowCoordinator empty recovery plus initializePreadmissionRepair).
  - Owner confirm: WorkflowCoordinator freezeRepairSnapshot (snapshot-only) plus confirmRepairReplace (agentId equals ownerIdentity, approver equals ownerId, provenance owner-session-confirm, exact snapshot id) is the only production approval site; /agents repair-confirm plus repair-freeze wired for healthy and preadmission; recovery text drops unavailable-in-this-build.
  - Revoke: coordinator notifyRepairHumanInput plus handleHumanInput (human-message) plus diagnostics Esc (onEsc) revoke pending approvalId through revokeRepairApprovalPersisted (repair-ledger.json); never auto-retries; fresh confirm works after revoke.
  - Runtime and idle: openAgentPresentation join/release keeps separate hosts (no cross-host adoption), drafts preserved in respective editors, no auto-resume/return; pre-commit Owner stays snapshot-only; commit sets repairedOwnerIdleHold, beginExecution refuses idle_until_human_message, handleHumanInput releases on new message.
  - Integration: tests/repair-wiring.test.ts (13 fast tests, some with live Moderator Run, no full suite): preadmission evidence/no-replay, repair-confirm parsing, drift-removed, crash repaired-bytes, persisted consumed, inside-workflow refusal, inspect-only review, Owner confirm binding, Esc revoke via persisted ledger, human-message revoke plus idle release, second-trigger joins plus fresh after Dormant, failed-admission keeps data plus no fabricated records, full chain trigger/validate/approve/commit/idle/switch with drafts and no auto-resume.
  - Deferred closed where cheap: KNOWN_SPAWN_TOOLS blind-spot doc, restoreFrozenBackup renamed to inspectFrozenBackup (callers updated), drift-removed test, crash repaired-bytes assertion, persisted consumed assertion, second-trigger-after-Dormant test, backupRoot/journalDir inside-workflow rejection plus tests.

## Decisions
- Fresh branch over rebase; diagnosis-face over pure tooling; manual over auto.
