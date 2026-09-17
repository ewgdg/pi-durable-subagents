# Agent spawn model exclusion policy

## Goal

Give the user one fast, durable way to ban specific models from child Agent runtimes: an interactive toggle menu behind `/agents models`, persisted as an explicit deny list, enforced for Agent Templates and explicit `agent_spawn` configuration. Fold in the user policy filename rename to the current project name.

## Intention

Keep one deny list and enforce it at the single existing model-availability predicate, so Template guidance, ordered candidate fallback, and explicit model validation all inherit the rule without a new protocol surface, new message type, or per-Template configuration. Provider-wide banning is stored as one `<provider>/*` entry so later catalogue additions stay excluded.

## Scope & Constraints

- Storage is the existing user Workflow Policy file, renamed to `<getAgentDir()>/config/pi-durable-subagents.json`, with one added field:

```json
{ "excludedModels": ["openai-codex/*", "deepseek/deepseek-v4-flash"] }
```

- Exactly two entry forms are accepted: a provider entry `<provider>/*` and an exact `<provider>/<modelId>` identity. Anything else — `*`, `*/*`, `gpt*`, `*/flash`, a missing slash, an empty segment, or duplicate entries — rejects the whole file, consistent with its existing all-or-nothing contract.
- Matching is the union of the two forms: a model is excluded when its exact identity is listed or its provider has an entry. There is no negation and no exception syntax, so an individual model cannot be carved out of a provider entry.
- Enforcement is selection-only. An excluded model cannot be chosen from Template candidates and cannot be set through an explicit `config.model.id`. Inheritance is exempt: a Template without `models`, an omitted `config.model`, and `"inherit"` keep resolving to the current parent model, so banning the user's own model never breaks a plain spawn.
- Exclusion applies to every ordinary and Moderator Runtime preparation. All preparation runs in the Owner process (a child's `agent_spawn` is a `coordination.spawn` control request), so one predicate covers descendants too.
- Running Agents are unaffected. The effect is visible at the next Runtime preparation.
- The menu is owner-only, flat, type-to-filter, and mirrors Pi's native model list: `DynamicBorder`, title, search `Input`, rows, footer hints and counts. Model rows show `✓ <modelId> [<provider>]` when usable, dim without `✓` when banned, strikethrough `[unavailable]` when banned but absent from the availability snapshot. Provider rows show `✓ <provider>/*` when usable and dim when banned, and sort first within their provider. The list is available models, catalogue providers, file entries, and providers named by a file entry, so every ban is reversible.
- A model row covered by its provider entry renders as banned and is not individually toggleable; toggling reports that the provider entry is responsible. Removing the provider entry restores the individual rows.
- Keys: Enter toggles. Space is always search text. Ctrl+A allows all, Ctrl+X bans all, both scoped to the active filter and acting on model rows only. Escape closes. No reorder keys and no explicit save. The footer advertises every binding alongside the banned and unavailable counts.
- Bulk actions write exact identities for the matched model rows and never create a provider entry; provider-wide intent is expressed by its own row. Allowing a provider by row removes the provider entry and leaves other entries untouched.
- Unmatched or stale banned ids stay in the file and remain listed. They are never auto-pruned.
- No compatibility read of the old `pi-agent-coordination.json`. No migration path.
- Out of scope: the session state directory name (`src/runtime/workflow-session-directory.ts`) and the inline extension identities (`src/runtime/process-child-session-factory.ts`). `src/bootstrap/cold-host-discovery.ts` readdirs the session directory path, so renaming it silently drops cold recovery for workflows whose child sessions were written under the old name. Both belong to their own change.

## Work Plan

1. Red tests first.
   - `tests/workflow-policy.test.ts`: `excludedModels` absent yields `[]`; non-array, non-string, duplicate, non-canonical, and unsupported-pattern entries reject the file; unknown fields still reject the file; the renamed filename is the only file read; write succeeds, preserves unrelated fields, and reports failure without publishing.
   - New `tests/model-exclusion.test.ts`: provider entries match every model of that provider including a later catalogue addition; exact entries match one identity; a provider entry cannot be overridden by an absent exact entry; malformed patterns are rejected.
   - `tests/agent-templates.test.ts` and `tests/agent-spawn.test.ts`: an excluded Template candidate falls through to the next candidate; a Template whose candidates are all excluded is omitted from the catalogue; an excluded explicit `config.model.id` is refused with an exclusion-specific message; a Template without `models` still inherits a parent model that is excluded.
   - New `tests/model-policy-surface.test.ts`: row state rendering for allowed, banned, unavailable, and provider rows; locking of rows covered by a provider entry; search filtering; Enter toggling; filter-scoped Ctrl+A and Ctrl+X; Escape; a failed write leaves the displayed state unchanged and reports the error.
   - `tests/execution-scheduler.test.ts` and any other policy-path fixture move to the new filename.
2. Policy module (`src/policy/workflow-policy.ts`): add `excludedModels` to the snapshot, the default snapshot, and the accepted field set; add `writeWorkflowPolicy(agentDir, snapshot)` that reads the raw JSON object, replaces only this field, writes a temporary file, renames it over the target, and re-parses the result before reporting success.
3. Exclusion matching: add a small pure module for the two entry forms (`<provider>/*`, `<provider>/<modelId>`) with parse validation and a matcher that answers for one identity. No glob engine and no dependency.
4. Enforcement: pass the current policy snapshot into `ProcessChildSessionFactory` and make `#isModelAvailable` require availability and absence from the exclusion matcher. Report the two causes distinctly in `resolveAgentRunConfiguration` (`excluded by model policy` versus `unavailable`).
5. Refresh: after a successful write, publish the snapshot, clear `#templateLoads`, and re-capture each Agent record's Template snapshot so later guidance and later spawns see the new list.
6. Coordinator view: expose the model policy state (model rows with provider, model id, name, availability, banned and locked flags, plus provider rows with catalogue presence and entry presence) and a mutation that returns the new state. Keep the surface free of policy writing.
7. Presentation: add `src/presentation/model-policy-surface.ts` built from exported primitives (`Container`, `Input`, `Text`, `Spacer`, `fuzzyFilter`, `getKeybindings`, `matchesKey`, `Key` from `@earendil-works/pi-tui`, `DynamicBorder` from `@earendil-works/pi-coding-agent`). Pi's `ScopedModelsSelectorComponent` is the behavioral reference and is not importable.
8. Command: add the `models` argument to the owner-only `/agents` handler in `src/tools/owner-surfaces.ts`, and gate argument completions so the child-side registration in `src/process-runtime/remote-agent-selector.ts` does not advertise it.
9. Docs: `docs/workflow-policy.md` gains the renamed path, the `excludedModels` field with both entry forms, the menu, and both enforcement rules. The availability sentence in `docs/agent-spawning.md` must name the exclude list as a third condition alongside catalogue presence and provider authentication.

## Validation

- Focused: `tests/workflow-policy.test.ts`, `tests/agent-templates.test.ts`, `tests/execution-scheduler.test.ts`, `tests/agent-spawn.test.ts`, the new surface test, and any host-shape test if the asserted surface changes.
- `npm run typecheck`
- `npm run test:fast`
- Relevant process and conformance suites, then `npm test` when focused coverage is green.
- Manual TUI check: ban a model, confirm Template guidance and explicit spawn refusal, un-ban, confirm restoration.
- `git diff --check`

## Progress

- [x] Design decisions confirmed with the user.
- [x] Policy filename renamed to `pi-durable-subagents.json`.
- [ ] Red tests.
- [ ] Policy field and atomic writer.
- [ ] Predicate enforcement and error text.
- [ ] Snapshot refresh on policy change.
- [ ] Coordinator view accessor.
- [ ] Toggle surface.
- [ ] Command and completion wiring.
- [ ] Documentation.

## Surprises & Discoveries

- `modelRuntime.getAvailableSnapshot()` ignores Pi's `enabledModels` allow list. That setting only scopes Pi's own model selector, and Pi appends the current model to it when a selection falls outside the scope, so it cannot carry an exclusion contract.
- Pi's native model menu is an internal component. Only its primitives, themes, and `DynamicBorder` are exported.
- The catalogue is cached twice: `ProcessChildSessionFactory.#templateLoads` per Agent and `AgentRecord.agentTemplateSnapshot` per record.
- Every child Runtime preparation happens in the Owner process, including grandchildren, because `agent_spawn` is a `coordination.spawn` control request.
- Baseline failure, unrelated to this change: `execution-scheduler.test.ts` — "an input-required child Run releases capacity until work can resume" fails with `Expected execution scheduler condition was not reached` on an unmodified tree as well. It was reproduced with the working changes stashed.

## Decisions

- Deny list only, stored in the renamed Workflow Policy file, accepting `<provider>/*` provider entries and exact `<provider>/<modelId>` entries.
- Selection-only enforcement; inheritance and `inherit` are exempt.
- Global agent-dir scope, not per-project.
- Provider-wide banning is one `<provider>/*` entry toggled by its own row, so catalogue additions stay excluded without rewriting the file. No Ctrl+P action and no bulk provider expansion.
- Exclusion is union-only: no negation, so a model cannot be carved out of a provider entry. Carving out requires banning the individual models instead.
- Enter toggles; Space never toggles.
- The config filename rename ships with this change; the session directory and inline extension identity renames do not.
