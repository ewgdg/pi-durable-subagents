# Workflow reload revalidation

## Goal and seam
Replace the coordinator on Owner resource reload, after awaited shutdown of the previous coordinator. Never validate through a retained coordinator or its transcript projections. The newly loaded bootstrap performs cold discovery and constructs fresh protocol projections. Pi retains the native Owner session; only coordination is replaced.

## Safety and constraints
Shutdown closes admission synchronously, fences queued/preparing child starts, drains lanes, terminates child and Moderator runtimes, and discards volatile delivery scheduling before fresh discovery. Cleanup failure must prevent replacement and must remain retry-blocking: there is no repair-safe snapshot when cleanup failed. Retain prior valid policy when a reload policy is invalid. No unrelated lifecycle policy changes.

Repair-only coordination (#129) and safe blocked Owner fork (#130) are separate work; this change leaves those unavailable exactly as cold recovery does.

## Work plan
1. Add regression for healthy Owner becoming invalid on reload; run red.
2. Replace coordinator at bootstrap seam, await cleanup and retain failure fencing.
3. Validate active participant shutdown, stale admission, valid reload and immediate blockage diagnostics.
4. Update supported behavior docs, focused tests/typecheck and commit.

## Evidence
Pi 0.85.1 AgentSession.reload awaits session_shutdown, invalidates old runner, reloads resources/builds runtime, then emits session_start(reason=reload). Current Owner handler skips shutdown on reload. Existing global WeakMap reuses an old coordinator, bypassing fresh validation.

## Progress
- Design selected before implementation. Reviewed Owner bootstrap, shutdown, cold discovery, transcript reader and Pi reload implementation.

## Implementation checkpoints
- Red regression confirmed: a healthy Owner with newly invalid saved Request remained admitted on its first reload.
- Reload now awaits shutdown, constructs a new coordinator and explicitly recreates Owner/file transcript projections, even when dependency modules remain cached.
- Independent shutdown audit found that closing Control connections does not join host-side spawn handlers. Coordinator now tracks and joins admitted spawn operations outside Agent lanes and joins Moderator reconciliation after fencing pending starts, then snapshots all committed participants for cleanup. Activity callbacks are fenced during shutdown.
- Native Owner abort is awaited without disposing the retained session. Existing shutdown handles child processes, ordinary Moderators, volatile scheduling and runtime operations. Cleanup rejection retains the registry handoff and prevents replacement on subsequent reloads.
- Valid reload restores tools but deliberately does not replay interrupted work: recovered participants remain dormant; Owner receives a warning to inspect effects before `workflow_resume`. Approved as safer than automatic successor startup.
- Tests cover first-reload diagnostics, cache-preserving changed historical Request data, active child and Moderator shutdown, stale tool rejection, dormant pending Request retention, policy preservation and admitted spawn preparation draining.

## Validation and limitations
- `node --test tests/owner-bootstrap.test.ts`: 23 focused bootstrap cases pass (final run recorded below).
- `node --test --test-name-pattern='Owner reload stops' tests/operational-incidents.test.ts`: passes active Moderator regression.
- `node --test tests/owner-diagnostics-surface.test.ts`: 6 pass.
- Cold child rediscovery focused case passes.
- Typecheck has an unchanged baseline error in `message-delivery-scheduler.ts:1164`: `ActivePromptDelivery.deliveryCommitted` does not exist.
- Two selected cold-recovery cases fail unchanged on a clean HEAD archive: standalone Moderator assertion expects obsolete label wording; delivered workflow_resume test reads an undefined receipt field. No unrelated fixes included.
- Full slow suite intentionally not run. Repair-only Coordinator and blocked Owner fork remain separate #129/#130 dependencies.

## Outcome
Final bootstrap run: 23/23 pass in approximately 3 seconds. Active Moderator and diagnostics focused checks pass; `git diff --check` is clean. Implementation and supported behavior documentation are complete for #127's replacement/revalidation seam, with the explicitly separate fork/repair dependencies noted above.
