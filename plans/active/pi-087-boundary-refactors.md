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
- [ ] Full validation + commits + handoff (required suites green; see Outcomes)

## Decisions
- Decided: lane work (safeBoundaryReached) runs at agent_before_settle, after Pi drains queues; turn_end keeps only the Answer flag + context_edit drafts. Registrar safe-boundary-on-turn_end expectation was a stale assumption and was updated.
- Decided: canContinue==false uses ctx.ui.notify warning (the available diagnostics channel) and returns entries without continue.
- Decided: exact turn_end entry IDs are not visible on the AgentSession subscribe surface, so precise proof is entry-count-gated message_end + completion fallback (no new event plumbing).
- Decided: owner-fork-context.ts and coordination-history-context.ts needed no code change (they consume transcript.context / projectParticipantHistoryContext, behavior identical for normal turns); post-mortem viewer and RetainedTranscript.context moved to buildSessionProjection.

## Surprises & Discoveries
- messages.reachSafeBoundary already guards ending/interrupting lanes, but still enters host.lane otherwise; awaited turn_end therefore still risks deadlock with disposal waiting for the same turn.
- AgentSession subscribe surface exposes agent_end/agent_settled, not turn_end IDs; exact-ID proof needs sessionManager leaf/entry comparison, not a new event.

## Outcomes & Retrospective
- Implemented R1+R2+R3 in scope files + registrar test updates; presentRequests/sendMessage-steer continuation removed.
- Validation (all exit 0): typecheck; fast extension-conformance, host-shape, participant-lifecycle-registrar, owner-fork-context, transcript-facts, in-process-hosted-runtime (+failure), agent-transcript, post-mortem-agent-view-surface, workflow-continuation, causal-obligation-stack; process participant-lifecycle-native (9/9, real Pi 0.87 continuation semantics).
- Pre-existing/unrelated failures (baseline-verified, do not block): owner-settlement-parking 1/10 fails identically on baseline (stashed); quota-lifecycle-integration unstable in this env (with-changes 3 pass/4 fail fast; baseline passes 2 then hangs 699s; reruns hit the 125s supervisor deadline). Both outside the required validation list.
- apply_patch format note: Update hunks need @@ <immediately-preceding-line> anchor plus -/+ body lines (space-prefixed context); pure-addition hunks without - lines land at EOF, use replace-style hunks instead.
- Remaining gaps/risks: willRetry/canContinue edge (canContinue==false returns entries without continue + notify; willRetry untouched); per-turn lane reconciliation no longer runs at turn_end (mid-run delivery advancement now relies on tool/agent boundaries + before_settle); answerDelivered flag fully removed from agent_end path (consumed at before_settle; user message_end still clears it); context-hook REQUEST_ATTENTION filter retained as safety alongside context_edit hides.
