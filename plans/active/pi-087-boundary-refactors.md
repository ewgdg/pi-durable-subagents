# pi-0.87 boundary refactors

## Goal
Adopt Pi 0.87 agent_before_settle, turn_end drafts, and buildSessionProjection in the three scoped areas without changing protocol semantics.

## Intention
- Settlement continuation becomes a boundary result, not a re-entrant sendMessage(steer).
- turn_end stops re-entering the coordination lane from an awaited boundary.
- Model context and read-only views project from buildSessionProjection; resolved attention is hidden via append-only context_edit, never physical mutation.

## Scope & Constraints
- Only: participant-lifecycle.ts, in-process-hosted-runtime.ts, retained-transcript.ts, owner-fork-context.ts, coordination-history-context.ts, post-mortem-agent-view-surface.ts (+ conformance tests if stale).
- Keep host-shape.ts stable; keep context (no-system) handler; do NOT adopt context_with_system, appendCompaction(null), Model.inputLimits.
- Remove superseded code in scope, no compat shims. Smallest end-to-end steps.

## Work Plan
1. R1 agent_before_settle: replace agent_end + presentRequests(sendMessage steer) + sticky answerDelivered with agent_before_settle returning entries/continue. Keep executionEnded() on agent_end. canContinue==false means entries without continue:true + ui.notify diagnostic. Preserve: answer ends loop, offer once, native input suppresses, never pick next task, no spin.
2. R2 turn_end drafts + commit proof: turn_end sets answerDelivered, returns context_edit drafts (R3), does NOT await lane-admitting safeBoundaryReached (see messages.ts:723 deadlock). Move lane reconciliation to agent_before_settle/agent_end path. in-process-hosted-runtime sendAndConfirmTranscriptCommit: prefer exact entry-ID proof where feasible, keep message_end fallback.
3. R3 projection: RetainedTranscript.context() via buildSessionProjection (keep SessionContext shape); post-mortem buildContextEntries -> projection entries; context_edit drafts at boundary hide resolved REQUEST_ATTENTION snapshots; projectParticipantHistoryContext behavior identical for normal turns.

## Validation
- npm run typecheck
- fast --file=extension-conformance, host-shape, participant-lifecycle-registrar, plus owner-fork-context, retained-transcript/transcript-facts, in-process-hosted-runtime selectors. No full suite.
- Pi-semantics failures: fix impl first; test change only for stale assumptions (document below).

## Progress
- [x] R1 implemented + targeted tests (native lifecycle suite passes against real Pi 0.87)
- [x] R2 implemented + targeted tests (lane-free turn_end; entry-gated commit proof)
- [x] R3 implemented + targeted tests (projection context + viewer; context_edit hides)
- [x] Boundary review must-fix 1: settlement no longer admits execution capacity (safeBoundaryReached drops ensureExecution; per-turn admission stays in toolExecutionStarted) + real-coordinator quota-1 regression test + registrar order corrected to real Pi agent_end-then-before_settle
- [x] Boundary review must-fix 2: context_edit drafts scan transcript.activeBranch only + branched-transcript registrar regression test
- [x] F1 duplicate-hide suppression: resolvedAttentionEdits skips targets with effective null context_edit; registrar repeated-boundaries test
- [x] F2 canContinue==false: chose (b) keep no-continue + reword notify (assistant-message end, not turn limit); registrar Answer-then-wrap-up test
- [x] F3 commit-proof heuristic tightly scoped (message_end is wake-up, proof is inspectCommit; idle triggerTurn falls back to completion); validated via moderator-reminder/resume suites
- [x] F4 per-turn lane reconciliation confirmed via causal/steer preemption suites; no lane admission in turn_end
- [x] Cleanup nits: leading spaces, agent_end-then-before_settle typo, narrowed ordering claim, fixed two boundary-first emitters
- [ ] Full validation + commits + handoff (required suites green; see Outcomes)

## Decisions
- Decided: lane work (safeBoundaryReached) runs at agent_before_settle, after Pi drains queues; turn_end keeps only the Answer flag + context_edit drafts. Registrar safe-boundary-on-turn_end expectation was a stale assumption and was updated.
- Decided: canContinue==false uses ctx.ui.notify warning (the available diagnostics channel) and returns entries without continue.
- Decided: exact turn_end entry IDs are not visible on the AgentSession subscribe surface, so precise proof is entry-count-gated message_end + completion fallback (no new event plumbing).
- Decided: owner-fork-context.ts and coordination-history-context.ts needed no code change (they consume transcript.context / projectParticipantHistoryContext, behavior identical for normal turns); post-mortem viewer and RetainedTranscript.context moved to buildSessionProjection.
- Decided (must-fix 1): settlement reconciliation must not admit model-execution capacity. Real Pi order is agent_end before agent_before_settle, so the permit is already released; safeBoundaryReached drops ensureExecution (per-turn sibling admission stays in toolExecutionStarted). Registrar ordering test corrected to agent_end-then-before_settle so the fake bus matches Pi where permit order matters.
- Decided (must-fix 2): settlement drafts scan transcript.activeBranch, not transcript.entries. Pi validates drafts against [header, ...getBranch()]; an off-branch context_edit target discards the whole proposal with continue, so branch-excluded snapshots must never be drafted.
- Follow-ups done in F1-F4 batch (see below); no unrelated cleanup beyond listed nits.
- Decided (F1): skip already-hidden targets (effective last context_edit with replacement null). Model context unchanged (last wins) but session file no longer grows per turn. turn_end + before_settle both use the same skip.
- Decided (F2): chose (b) keep no-continue + reword. (a) queue-as-steer is not feasible at before_settle: ctx has no sendMessage, and non-streaming sendMessage appends directly without setting hasQueuedMessages, so canContinue would stay false; triggerTurn would be re-entrant. Preserve offer-once / never-spin; presentation retained for next native input.
- Decided (F3): entry-count gate stands as wake-up only. Turn-level IDs are not on the AgentSession surface; per-delivery proof is inspectCommit itself. Concurrent append may open the gate but still needs inspectCommit true; idle triggerTurn message_end can precede persistence so proof falls back to completion. Safe both directions, cost is delayed transcriptCommit.
- Decided (F4): mid-run steer freeze/dispatch stays at tool boundaries + settle only. causal-request-preemption / steer-request-preemption green confirms no gap; do NOT reintroduce lane admission into awaited turn_end (deadlock, see messages.ts).

## Surprises & Discoveries
- messages.reachSafeBoundary already guards ending/interrupting lanes, but still enters host.lane otherwise; awaited turn_end therefore still risks deadlock with disposal waiting for the same turn.
- AgentSession subscribe surface exposes agent_end/agent_settled, not turn_end IDs; exact-ID proof needs sessionManager leaf/entry comparison, not a new event.

## Outcomes & Retrospective
- Implemented R1+R2+R3 in scope files + registrar test updates; presentRequests/sendMessage-steer continuation removed.
- Validation (all exit 0): typecheck; fast extension-conformance, host-shape, participant-lifecycle-registrar, owner-fork-context, transcript-facts, in-process-hosted-runtime (+failure), agent-transcript, post-mortem-agent-view-surface, workflow-continuation, causal-obligation-stack; process participant-lifecycle-native (9/9, real Pi 0.87 continuation semantics).
- F1-F4 batch (all exit 0): typecheck; fast participant-lifecycle-registrar (incl. 2 new tests), transcript-facts, settlement-permit-boundary, causal-obligation-stack, moderator-reminder-admission, stale-moderator-reminder-delivery, workflow-continuation; process steer-request-preemption, causal-request-preemption; git diff --check clean.
- Pre-existing/unrelated failures (baseline-verified, do not block): owner-settlement-parking 1/10 fails identically on baseline (stashed); quota-lifecycle-integration unstable in this env (with-changes 3 pass/4 fail fast; baseline passes 2 then hangs 699s; reruns hit the 125s supervisor deadline). Both outside the required validation list.
- apply_patch format note: Update hunks need @@ <immediately-preceding-line> anchor plus -/+ body lines (space-prefixed context); pure-addition hunks without - lines land at EOF, use replace-style hunks instead.
- Remaining gaps/risks: willRetry/canContinue edge (canContinue==false returns entries without continue + notify; willRetry untouched); per-turn lane reconciliation no longer runs at turn_end (mid-run delivery advancement now relies on tool/agent boundaries + before_settle); answerDelivered flag fully removed from agent_end path (consumed at before_settle; user message_end still clears it); context-hook REQUEST_ATTENTION filter retained as safety alongside context_edit hides.
- Remaining gaps/risks (F1-F4 update): canContinue==false now reworded (assistant-message end, not turn limit; willRetry untouched); per-turn lane reconciliation confirmed via preemption suites (tool/agent boundaries + before_settle, no turn_end admission); answerDelivered consumed at before_settle; context-hook filter retained alongside hides.
