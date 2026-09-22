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

## Decisions
- Fresh branch over rebase; diagnosis-face over pure tooling; manual over auto.
