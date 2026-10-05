# Read-only post-mortem Agent view

## Goal

When a Dormant Agent's configured Runtime cannot be prepared, keep its durable transcript inspectable instead of exposing the still-mounted Owner as though selection succeeded.

## Intention

Use Runtime preparation for the normal complete Agent experience. If and only if Dormant preparation fails before a usable projection exists, attach an Owner-hosted read-only transcript presentation for that durable Agent. This presentation is diagnostic evidence, not an Agent Runtime, Run, editor, or failed Agent lifecycle.

## Scope & Constraints

- Preserve the normal complete process-backed Agent view whenever Runtime preparation succeeds.
- Fallback only for a Dormant target with durable readable transcript evidence and no usable Runtime projection.
- Show the active durable transcript branch with native message styling where practical, plus the Runtime preparation error.
- Support Up/Down and `j`/`k`, Page Up/Page Down, Home/End, `a` for `/agents`, and Escape/`q` to restore the exact previous presentation.
- Do not append transcript evidence, admit a Run, retain or fabricate a Runtime, or mark the durable Agent failed.
- Render the surface in the Owner TUI; when invoked by a selected child, temporarily detach that child PTY and reattach the exact same projection after back navigation.
- Preserve Agent-to-Agent back navigation, including a previous live Agent selected through the child `/agents` path.

## Work Plan

1. Add a red public `/agents` regression: make a failed Dormant Moderator's future Runtime preparation invalid, select it, and require a read-only transcript view rather than Owner fallback.
2. Add the smallest presentation module for rendering and navigation. Cover its stable input/render contract, including `j`/`k`, arrows, paging, Home/End, `a`, Escape, and `q`.
3. Integrate fallback selection through the existing durable view seam without fabricating an Agent Runtime or weakening normal preparation errors.
4. Preserve exact previous-presentation restoration and selection behavior across Owner and Agent origins.
5. Document the shipped fallback contract in `docs/agent-selector.md` and update acceptance evidence.
6. Run focused tests, typecheck, relevant conformance, then the full release gates when ready.

## Validation

- Focused presentation tests.
- Failed dormant Moderator `/agents` integration test through the real process-backed host.
- Existing Agent view, selector, remote selector, operational incident, and physical attachment suites.
- `npm run typecheck`
- `npm test`
- `npm run test:conformance`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`

## Progress

- [x] Diagnosed preparation failure as the cause of apparent Owner fallback.
- [x] Created isolated worktree and branch.
- [x] Red tracer test.
- [x] Minimal implementation.
- [x] Navigation, typed remote outcome, and physical suspend/resume restoration coverage.
- [x] Documentation.
- [x] Focused review and validation, including fixes for the initial destructive-probe and child-local-rendering defects.
- [ ] Full-suite/conformance closure after the current branch-wide baseline failures are resolved.

## Surprises & Discoveries

- Pi exposes native message presentation modules but no public whole-transcript read-only renderer. The viewer composes the public message components over Pi's compaction-aware active transcript entries.
- `SessionManager.open()` is not a read-only seam: it rewrites legacy headers and materializes empty files. File-backed inspection now parses bytes directly and migrates only an in-memory clone.
- Pi's native message components assume ordinary session content and preserve terminal escapes. Post-mortem evidence therefore crosses an explicit recursive sanitization seam before component construction, with terminal image payloads disabled.
- Child-origin `/agents` needs a typed Control outcome, but the Owner both snapshots and renders the transcript; neither transcript contents nor paths cross bounded Control frames.
- The pre-acquisition view lane leaves the previous live Agent attachment untouched when target preparation fails, which makes exact back navigation a presentation concern rather than a rollback/reopen operation.
- Current HEAD has unrelated baseline failures in the Agent Spawn shape and Dormant Moderator selector label tests; the new focused suites and process Runtime suites pass, but full-suite closure is blocked by those failures.

## Outcomes & Retrospective

The implementation now performs one discriminated acquisition: either the exact prepared Runtime target is retained for the normal view, or a pre-projection Dormant failure becomes an immutable transcript snapshot. Owner and child `/agents` flows carry only a bounded typed outcome over Control. For child-origin fallback, the Owner temporarily restores its TUI, renders the snapshot, then reattaches the exact previous child projection on back. Navigation, post-mortem Moderator behavior, protocol schemas, remote selection, process Runtime adapters, typecheck, packaging, audit, and diff hygiene are covered and green.

## Decisions

- The fallback is a read-only post-mortem presentation, not an Agent status.
- Escape and `q` mean back; `a` opens the Agent selector; `j`/`k` mirror arrow scrolling.
