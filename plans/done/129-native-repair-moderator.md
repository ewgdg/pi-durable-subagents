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
- Precommit compaction is explicitly unsupported: cancel it with visible guidance and invalidate any pending proposal. After commit native compaction is available normally. This closes Pi's separate compaction-deferred input queue without pretending the public pending-message list observes that queue.
- The original CLI lifetime owns helper shutdown, independently of native session replacement or resource reload. Actual quit joins pending launches and helper process exit; disconnect alone is never retirement evidence.

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
- Full repair CLI17 passed, followed by added validation-correction/postcommit tool-denial coverage. Actual packed node_modules native-chat, live-navigation, native-esc, followup-complete and idle-human passed.
- Independent milestone review identified required fixes: revoke a proposal on new human input/Esc DURING asynchronous validation, account native compaction-deferred input, and join independent helpers on actual original CLI quit. Reload factory failure also needs fail-closed hooks, not merely a thrown error contained by Pi. Core fixes delegated to helper author; CLI-lifetime join and native regressions owned by main writer.
- New native `/quit` regression failed (helper exit not joined before subsequent shutdown observer). Both normal and corrupt-bootstrap native reload tests failed (helper remained alive). These are open checkpoints, not completion claims.
- Those regressions are now green: actual original CLI quit joins helper exit both during a held model turn and after explicit Owner admission. Normal and corrupt-bootstrap native reload both terminate with restrictions retained. The original CLI lifetime registry survives Owner replacement/reload; a final prelaunch gate prevents helper birth after shutdown completes.
- Validation now retains a revocable input epoch through asynchronous sealing, checked synchronously at the irreversible apply boundary. Configured submit/followup/Esc, manual/automatic compaction and abort require fresh completion. Gate barrier tests, real native compaction-deferred steering/followup, manual/threshold/overflow cancellation, and native conversation regressions pass. The validation-barrier coverage is compositional, not a single end-to-end filesystem-apply race test.
- Independent lifecycle reviewer closed input/compaction/reload/quit findings at `3b7d21a`, except a newly identified prelaunch birth race. That last finding was reproduced with a deterministic preparation barrier and closed at `f008faf`; no remaining scoped finding.
- Final production code `f008faf`: full targeted repair CLI20 passed (prior `3b7d21a`), then narrow lifetime1/CLI quit2 and typecheck passed after the last fix. Final packed node_modules native-chat, live-navigation, native-esc, followup-complete, idle-human, quit-joined and quit-active all passed7. Focused helper5, native compaction queue1, shutdown1, gate/revocation/compaction/input seams and existing human-hold/startup seams passed. No full repository suite, real-model usage or user-artifact writes.
- Parent acceptance at `a8d1d78`: independently reran all 20 real CLI cases, typecheck and diff check successfully. Consolidated the maintained design contract to remove superseded RPC/dashboard behavior. No real-model calls or existing scenario transcript changes.

## Surprises and discoveries

Stock native session replacement retains original CLI resource-discovery flags; cannot safely replace the separate restricted helper with an unrestricted original-process model session. PTY reuses existing production dependencies and physical attachment.

## Outcomes

Implemented genuine interactive native repair Moderator, not a chat dashboard. Durable commit leaves that conversation selected; explicit Owner navigation preserves its draft and opens an idle Owner. Mutation authority cannot reopen after application. Current-CLI conversation and read-only archived evidence remain separate.

Supported restrictions: POSIX storage durability, precommit compaction refused visibly, helper reload terminates rather than restarts, unavailable extension-only providers remain unavailable in restricted helper resources. Original authorization/certificate/retirement/storage rules unchanged. Parent acceptance complete; publication is tracked in PR #143.
