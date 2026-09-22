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
- Checkpoint 4 (replace-path wiring; planned, backend hardened only): `commitRepairReplace` stays an unwired backend library with zero production callers — NOT wired to a live Owner in this pass. Wiring-time enforcement (not faked here): repaired-Owner idle hold (`openRepairedOwnerIdle` fields), draft preservation, Runtime join/release (never auto-resume or auto view-return), no cross-host adoption.
  - Missing integration test (add at wiring time): Owner-session confirm → `commitRepairReplace` → repaired-Owner idle hold with Runtime join/release and draft preservation, asserting no cross-host adoption.
  - Hardened backend (done, focused suites + typecheck green): same-attempt join enforces snapshot binding + approval identity + revocation (consumed-as-ok only for the identical attempt); approver must equal the Owner-session `OwnerIdentity` agentId with no default authority (approvals constructed only in the future Owner-session command path); persisted approval ledger (`repair-ledger.json`) next to the journal dir with the unwired input path documented; seal order backup → apply → verify → seal → journal; recursive frozen enumeration with the `repair/` guard as filter; manual-repair start-failure orphan release (next trigger creates exactly one Moderator); hosted-Moderator shutdown check after `beforeBootstrapCommit`; required (not optional) ledger in the pre-commit gate; strict attemptId charset `/^[A-Za-z0-9_-]{1,128}$/`; owner-only backup dir (0700) and copies (0600); journal recovery validates files[] entries plus backupDir/manifest presence.
  - Deferred notes (document only): `KNOWN_SPAWN_TOOLS` is an advisory blind spot — unknown tools warn, never block; `restoreFrozenBackup` is inspect-only (never writes live targets; rename to `inspectFrozenBackup` deferred here); remaining test gaps tracked at wiring time.

## Decisions
- Fresh branch over rebase; diagnosis-face over pure tooling; manual over auto.
