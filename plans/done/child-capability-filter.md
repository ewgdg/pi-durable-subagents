# Child tools and skills become a withhold filter

## Goal and intention

Replace the startup tool/skill *selection* (which was inherited from the parent and
enforced at admission, and which failed report FO8C) with a **withhold filter**.
Baseline is the child runtime's own default surface: Pi's defaults plus whatever
the child's own extensions activate (`read,bash,edit,write`, or code mode's
`exec,wait,mcp_tools`, plus extension tools). `excludeTools` and `excludeSkills`
remove names from that baseline. Nothing about the parent's surface is inherited,
and nothing is verified: if a filtered name is absent, nothing happens.

The child bridge keeps its own role coordination tools active, so participation
never depends on the parent's list or on extension load order.

Decision record: `~/.agents/artifacts/outputs/pi-durable-subagents/2026-09-16/child-capability-filter/decision.md`
(weighted matrix; deny-list wins over no-fields by 81 to 80, and only because the
participant guarantee is included).

## Scope and constraints

- `excludeTools` / `excludeSkills` replace `tools` / `skills` everywhere: Spawn
  config, Template frontmatter, the Agent Template catalogue, and the child
  bootstrap. Delete, do not alias: a silent flip from activate-these to
  remove-these would be worse than a breaking rename.
- The parent's active tools and skill list are no longer inherited. Model, thinking,
  cwd, extensions, system prompt, and context-file loading are unchanged.
- The child resolves its own skills for its own cwd and agent directory; the filter
  removes names from that discovery. `--skill` still pins exact paths, and the
  startup snapshot still matches the resolved list.
- The filter applies to the active set only, at startup completion, before any input
  is admitted. It is not a security boundary and does not re-assert later.
- Role coordination tools are always active in a child; the filter cannot remove
  them.
- The startup tool admission check becomes a snapshot-integrity check for
  `toolExecutionModes`; mismatch failures about the parent's surface disappear.
- Control protocol version 9 carries the renamed bootstrap payload.

## Work plan

1. Protocol and data model: bootstrap `excludedTools`, catalogue `excludeTools` /
   `excludeSkills`, Spawn input validation, Template parser and types, template
   prompt guide, runtime configuration types.
2. Preparation: no tool or skill inheritance, child-owned skill discovery minus
   exclusions, drop the parent skill-source plumbing.
3. Child: bridge applies exclusion and re-merges its role tools at startup
   completion; role tool names come from the coordination tool registrar.
4. Host: drop the selection assertion, keep execution-mode integrity.
5. Tests: filter applied, role tools survive a clobbering extension, absent filter
   names are no-ops, no inheritance from the parent surface, preparation and
   protocol fixtures, version literals.
6. Docs: rewrite the tools/skills paragraphs in `docs/agent-spawning.md`.
7. Typecheck, focused fast and process suites, commit.

## Validation

Process tests own the behaviour: a child extension that rewrites the surface during
startup must stay admissible (the FO8C shape), an excluded tool must end up
inactive after startup, and the child's role tools must be active even when the
rewriting extension dropped them. Preparation tests own the filter union and the
child-owned skill discovery. Fast schema and template tests own the renamed fields
and protocol version.

Pre-existing failures in this environment, reproduced on a clean tree and unrelated:
two cases in `pi-child-process-runtime`, three in `agent-spawn`, one in
`child-launch-contract-containment`.

## Progress

- [x] Decision matrix and artifact.
- [x] Protocol and data model.
- [x] Preparation, child bridge, host check.
- [x] Tests and docs.

## Decisions and discoveries

- Pi's own child default is small: a plain child activates `read,bash,edit,write`
  while `grep,find,ls,powershell` stay registered but inactive; with this machine's
  codex extension the natural surface is code mode's `exec,wait,mcp_tools`. The
  runtime default is therefore genuinely different from the owner's surface, which
  is what made inheritance a bad contract.
- The filter ignores names it cannot find, for tools and skills alike: a deny list
  is scope control, not a boundary.
- Exclusions accumulate (Template rules plus Spawn config) instead of replacing,
  because a spawner adding a restriction should not drop the template's.

## Outcomes and retrospective

Shipped as one commit. Every part of the matrix's option A landed: `excludeTools` /
`excludeSkills` replace the selection fields everywhere (Template frontmatter,
catalogue, Spawn config, bootstrap `excludedTools`, protocol version 9), the parent
surface and skill list are no longer inheritance inputs, skills are discovered for
the child's own cwd and agent dir with exclusions applied, the child bridge applies
the filter and re-merges its role coordination tools when startup completes, and
host admission keeps only the execution-mode integrity check.

Two defects surfaced during the work and were fixed in the same change: the
creation-preset validator and the `agent_spawn` tool parameter schema still
declared the removed fields, and the spawn receipt's effective-configuration schema
did too. All three were runtime JSON schemas, so TypeScript stayed silent.

Verification: typecheck clean; focused fast, process, and conformance files run
per-file. Pre-existing environment failures, each reproduced on a pre-change tree
from `git archive HEAD`: two in `pi-child-process-runtime`, three in
`agent-spawn`, one in `child-launch-contract-containment`, one moderator timeout
in `process-child-session-factory`, five in `cold-host-recovery`; the
`agent-spawn` "successor Runtime retains its creation preset" case is flaky on both
trees (one pass in three).

Retrospective: the delegation split worked well — a child did the mechanical
fixture migration while the docs were rewritten in parallel — but its first pass
silently inverted intent where a fixture's `tools: [X]` meant "select X" and the
rename produced "exclude X"; the second child caught and fixed those. Src work
should stay with the author, who owns the semantics.

Follow-ups not in scope: the Agent roster has no archive or delete operation, so a
finished probe keeps its durable identity (noted when cleaning up after this work);
and the filter is intentionally not a boundary, so a child whose extension gains
new tools is not restricted by a stale deny list.
