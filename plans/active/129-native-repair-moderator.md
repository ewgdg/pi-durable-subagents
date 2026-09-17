# Native interactive repair Moderator

## Goal and intention

Replace the read-only repair dashboard with a genuine stock Pi interactive session, attached through the existing child PTY/physical terminal seam. Human conversation, steering, follow-up and Esc belong to Pi. The original `/agents repair` remains the only application authorization.

## Scope and constraints

Preserve actual blocked-admission eligibility, cooperative writer retirement, immutable snapshots, exact duplicate Delivery certification, durable replacement/recovery and the repaired Owner's explicit-human gate. No ordinary AgentRecord or delivery routes for this independent Moderator. No upstream edits, new dependency, second terminal, real model calls or user artifact edits. Keep archived processes read-only.

Concrete failure case: a Moderator emits `repair_report(complete)` and then the human steers or aborts before settlement. Applying that earlier proposal would disregard new human input. Bind completion to its input/candidate generation and successful settled state; abort/queued input invalidates completion. Once application begins, mutation authority closes permanently.

## Decisions

- Stock Pi TUI process on the existing PTY, separate typed control transport, never RPC-rendered chat.
- Commit automatically after independent validation; stay in Moderator. Only explicit Owner navigation performs fresh admission, without an approval prompt.
- Native Esc aborts a turn, not the attempt. Explicit repair cancellation remains separate.
- After commit the current live Moderator remains conversational with read-only evidence. Its process cannot reapply. Archived processes are inspect-only.

## Work plan

1. Add failing native helper conversation/attachment tests, then replace RPC launch/control with PTY and prove native interaction before transaction refinements.
2. Implement successful-generation proposal settlement, persistent conversation, scoped tools and native session restrictions.
3. Integrate attempt-owned physical attachment and `/agents` navigation; split commit from explicit idle Owner admission. Remove superseded stream dashboard.
4. Exercise real CLI navigation, drafts, steering/abort/commit races, failure/recovery and installed package. Independent review before final polish.
5. Update operations guidance, commit all task-owned changes and record evidence.

## Validation

Use supervised targeted fast/process runner only. Reasoning-enabled local scripted providers exercise real production CLI, native transcript/provider input and actual PTY, no production lifecycle bypass. Preserve admission and recovery regressions. Typecheck and packed node_modules smoke at completion.

## Progress

- Plan created before implementation. Existing native child reattachment test passed during assessment; no new repair-native behavior claimed yet.
- Pure proposal-settlement module/tests delegated in isolated worktree; main writer owns transport/helper/host UI and real CLI integration.
- Native editor/attachment regression first failed against RPC helper (`dimensions` missing), now passes against production native helper. Native bash and session replacement restrictions checked in the same test.
- First native conversation checkpoint passed: real CLI `native-chat` persists a human message after a no-proposal assistant response, then independently validates/commits and waits for explicit Owner navigation.
- Real CLI `native-esc`, `followup-complete`, `idle-human`, and `live-navigation` pass: abort after completion report, queued human input, retained Owner hold, native steering, precommit snapshot inspection, postcommit reattachment/discussion. Live-navigation test initially incorrectly expected a deliberately Ctrl-U-cleared draft to survive; corrected to distinguish explicit editor deletion from attachment retention.
- No-op CLI3, lifecycle5, proposal gate7, archive inspection1 and launcher refusal2 pass. Typecheck passes. Full targeted safety/installed-package checks and independent review remain pending.

## Surprises and discoveries

Stock native session replacement retains original CLI resource-discovery flags; cannot safely replace the separate restricted helper with an unrestricted original-process model session. PTY reuses existing production dependencies and physical attachment.

## Outcomes

Pending implementation and verification.
