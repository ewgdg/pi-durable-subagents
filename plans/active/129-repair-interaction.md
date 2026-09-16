# Repair interaction and explicit Owner resumption

## Goal

Fix three issues observed in the user's real-model repair run: the repair view
appears frozen, the reopened Owner starts a turn without new human input, and
the Workflow-owned repair Moderator is absent from `/agents` navigation.

## Constraints

- The restored Owner must stay idle until a new user message explicitly resumes
  it. No startup/reminder/native continuation may silently start that turn.
- Repair progress must be visible and navigation/inspection usable while the
  independent repairer works. Showing a new empty native session is insufficient.
- Show this Workflow's repair Moderator through `/agents`, without adding it to
  ordinary routing, spawning, scheduling, or cold participant discovery.
- Retain admission-only eligibility, unchanged rejected history, exact-duplicate
  certification, strict retirement, commit-before-reopen, and one authorization.
- Do not modify the user's live test files or run real model requests during
  diagnosis. Keep logs redacted and create test fixtures separately.

## Work

1. Capture the actual saved run timeline read-only and reproduce each symptom at
   an observable seam before changing production behavior.
2. Identify and fence the actual automatic-turn cause; preserve pending evidence
   without dispatch until explicit human input, not an arbitrary sleep/abort race.
3. Make the repair presentation responsive and integrate a repair-only selector
   row/view. Navigation must not resume Owner or grant ordinary Agent authority.
4. Exercise delayed real-CLI model progress, navigation during repair, idle return,
   and one explicit human prompt afterward; review and update PR/docs.

## Validation

Use bounded supervised tests and typecheck; avoid full suite. Verify zero Owner
model calls between fresh admission and a new user prompt, including delayed
startup/reminder opportunities. Verify repair Moderator visibility before/after
completion and no hidden coordination membership. Capture failures before fixes.

## Progress

- User-reported behavior at `5711af6`; read-only run evidence extraction started.
- PR is being returned to draft while these acceptance gaps are corrected.
- Reproduced native command freeze with a held helper: the awaited full repair
  inside `withSession` and blanket raw-input consumption blocked the editor.
  The callback now contains only verified handoff; retained helper completion
  uses the fresh context after native replacement returns.
- Reproduced Owner auto-turn with a reasoning-enabled real CLI model and an
  actual thinking-level change: runtime state change triggers operational
  reconciliation, Obligation Stall reminder, then startup's empty extension
  prompt and model call. Earlier reasoning-disabled fixtures did not emit that
  event and falsely appeared idle. New supervisor awaiting-human state is set
  before coordinator integration, preserving obligations while fencing delivery
  and incident generation. New human input, not navigation, releases it.
- Live helper text/thinking/tool activity and completed persisted messages now
  refresh in read-only inspection. `/agents` supplies a presentation-only Repair
  Moderator row and Owner snapshot during repair and archived rows afterward.
  No ordinary Agent identity/lifecycle route is fabricated.
- Added red/green regression for uncommitted native reopening newly exposed by
  responsive input: switch authority is now exact to the active controlled
  transition, not the whole attempt. Open menu/view teardown is joined and
  editor drafts survive the final replacement.
- Independently reviewed at `30676b4`; one required stale-live-transcript issue
  was reproduced in a supervised test and fixed at `85de5d0`. Additional
  approved command-completion fix `53e2b3d` removes the spurious cancellation
  toast without relaxing actual model cancellation. Review closure approved
  `53e2b3d` after 14 focused checks; no required findings remain.
- Fifteen real CLI cases pass, including delayed helper inspection, newly
  completed tool result in an already-open view, command cancellation, native
  setting-change hold/no empty user entry, and explicit human prompt release.
  Direct gate/startup/selector/lifecycle tests and typecheck pass. Actual packed
  node_modules smoke passes idle-human, live-navigation and command-cancel.
  No real model calls or changes to the user's live repair artifacts were made.

## Final acceptance

- Parent independently reran typecheck, all 15 real CLI cases (22.836 seconds),
  and the deterministic repaired-Owner human-input test on integrated `3b1b20c`;
  all passed. Whole-branch whitespace check passed; no full suite was run.
- A separate repeatable real-model launcher creates a fresh blocked input on
  each run and prints its Owner path. It uses the current feature extension,
  normal user auth/model settings and an isolated working directory; no scripted
  repair or model calls were used in preparation. The old user run is untouched.
- Current operations and architecture documents describe responsive navigation,
  presentation-only Moderator history, exact switch permission, and explicit
  human resumption. PR publication update remains the final handoff step.
