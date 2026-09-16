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
