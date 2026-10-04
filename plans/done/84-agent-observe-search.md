# Composable Agent observation search

## Goal

Let an Agent discover authorized dormant, transitional, or live Agents through one bounded model-facing observation operation, while replacing the old direct-child-only `agent_observe` operation.

## Intention

Keep exact identity lookup (`status`) and broad roster discovery (`search`) in the existing passive observation seam. Make structural scope, metadata matching, lifecycle filtering, and bounded results composable without preparing runtimes, reading transcript contents, or adding a separate search tool.

## Scope & Constraints

- Extend `agent_observe`; do not add `agent_search`.
- Keep `operation: "status"` for one exact Agent.
- Remove the public `operation: "children"`; `search` replaces it.
- Search scope is required: `"authorized"`, `"direct_children"`, or `{ "directSpawnerAgentId": "parent-id" }`.
- `authorized` preserves current observation authority: Owner and Moderator see their existing Workflow-wide set; ordinary Agents see themselves and direct children.
- `direct_children` means direct children of the caller. The object scope means exact direct children of the named Direct Spawner and obeys existing child-enumeration authority.
- Unauthorized or unverified structural scopes return no matches.
- Search filters are optional for direct-child scopes, but broad `authorized` searches require `query`, `agentIdSuffix`, or `phase`.
- `query` is one nonblank case-insensitive substring over label/description. `agentIdSuffix` is a separate case-sensitive compact-ID suffix match. `phase` accepts `starting`, `live`, `ending`, or `dormant`.
- No regex, glob, fuzzy, list, transcript-content, recursive-subtree, cursor, or total-count semantics.
- Results are `{ matches: AgentStatus[]; hasMore: boolean }`, with default limit 20 and maximum 50.
- Results are live, non-atomic observations. Search never prepares or activates a dormant Runtime.
- `AgentStatus.directSpawnerAgentId` remains the sole relationship field; no nested parent/role/ancestor data is added.
- Raw `rg`/filesystem transcript inspection remains an unrestricted, separate evidence-search technique.

## Work Plan

1. Add red public tool/schema tests for search scopes, matching, lifecycle filters, limits, ordering, and replacement of `children`.
2. Extend the participant coordination input/result types and TypeBox schemas.
3. Implement authorized candidate selection, structural scopes, metadata matching, deterministic relevance ordering, and bounded status materialization in `WorkflowCoordinator`.
4. Update child Control transport/proxies and tool registration/rendering for the new result shape.
5. Update all public observe tests and fixtures while preserving internal `children()` tree APIs used by runtime/presentation logic.
6. Update `docs/run-supervision.md`, `docs/owner-workflow.md`, and the project glossary/ADR if the final protocol decision remains surprising and hard to reverse.
7. Run focused tests, typecheck, conformance, and release validation.

## Validation

- Focused participant/coordinator, control-protocol, renderer, remote-control, spawn, cold-recovery, owner-fork, and process-runtime observation tests.
- `npm run typecheck`
- `npm run test:fast`
- Relevant process/conformance suites, then `npm test` when focused coverage is green.
- `npm run test:conformance`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`

## Progress

- [x] Confirmed design and public testing seams with the user.
- [x] Mapped current `agent_observe` implementation and public references.
- [x] Red tracer tests.
- [x] Minimal schema and coordinator implementation.
- [x] Remote transport/rendering integration.
- [x] Documentation and glossary/ADR.
- [x] Focused validation.
- [x] Full validation.

## Surprises & Discoveries

- The current `AgentStatus` already exposes `directSpawnerAgentId`; the search feature needs no new relationship field.
- Process integration files run serially under a 120-second top-level file guard because cumulative PTY/process setup can exceed individual test durations.
- Public observation fixtures now use `search`; internal `children()` methods and `AgentRecord.children` remain necessary for hierarchy and presentation behavior.
- Transcripts are Workflow-directory evidence, but current Run phase is volatile and must come from the runtime host rather than `rg`.

## Decisions

- Search is a generalized passive observation operation, not transcript search.
- The caller’s direct-child scope is represented by `"direct_children"`; an explicit parent uses `{ "directSpawnerAgentId": "..." }`.
- Full IDs use `status`; compact suffixes use `agentIdSuffix`.
- Search result status entries retain the existing `AgentStatus` contract.
