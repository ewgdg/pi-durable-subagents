# Sticky Agent model selection

Issue: #220. Follows #216 / PR #219 (Virtual Models, preset thinking).

## Goal

A fresh Runtime for an existing Agent (dormant wake-up, successor Runtime, cold host recovery) keeps the Agent's current model and thinking level. Template model candidates, `agent_spawn.config.model`, and Virtual Model preset thinking are only the initial values.

## Intention

User's words: "model spawn config is just the initial values, later overwrite will be sticky just like normal pi sessions."

Pi saves a new session's starting model and thinking into the session and restores them on resume. A child session already holds Identity entries when Pi first opens it, so Pi treats it as an existing session and never records the `--model` we launch with. Today every fresh Runtime re-resolves from the creation preset and Spawn config and passes `--model` / `--thinking`, which override the session. A manual `/model` or thinking change is lost on restart.

## Design

- **The session is the source of truth.** The selection is the last `model_change` and the last `thinking_level_change` on the active branch. Preset mode is Pi's native Virtual Model router state (`pi.virtual-model-state` custom entry, `{ thinking: "preset" | "explicit" }`) for that virtual model.
- **Record the initial values at Identity commit.** Spawn and Moderator creation append `model_change`, `thinking_level_change` (when resolved), and preset state for a preset Virtual Model to the staging session before it is materialized. This is the same thing Pi does for a new session.
- **Fresh Runtime preparation** reads the recorded selection and uses it in place of the initial model/thinking resolution, when the recorded model is usable (catalogue + auth + not excluded; a Virtual Model must still be defined with a usable entry).
  - **Unusable or missing recorded selection** (user decision: fall back): resolve the initial values again, append the new selection to the session, and notify the Owner UI. A session with no `model_change` (Agents created before this change) takes the same path, once.
  - Thinking is clamped to the model like any launch value.
- **Launch is unchanged**: `--model` / `--thinking` still carry the prepared values, which now equal the recorded selection. The host keeps knowing the effective configuration without depending on Pi's restore fallback (`Could not restore model` → settings default).
- **Preset mode** is read from the session branch by the child's router. A manual thinking change while in preset mode appends `explicit` state. This replaces the in-memory `explicitThinkingSessions` global and the `presetVirtualModel` bootstrap field (control protocol 13 → 14).
- **Dormant parent inheritance** uses the parent's recorded selection (read only, no writes), so a child inherits what the parent would actually run.
- **Moderators** follow the same rule. A Moderator whose thinking is left to Pi's default records no thinking entry; Pi appends one on first start, and later Runtimes keep it.

## Scope & Constraints

- Only model and thinking. cwd, tools, skills, extensions, system prompt keep re-resolving.
- Nothing is persisted to user Pi settings (ADR 0001 still holds: the selection lives in the Agent's own session).
- Retained Runtimes are unaffected.

## Work Plan

1. Pure session-selection module: read recorded selection / preset state from branch entries; append a selection to a session manager.
2. Preparation: `recorded` input to configuration resolution; fallback on unusable.
3. Factory: read recorded selection for fresh Runtimes and dormant parents; persist fallback; notify. Spawn and Moderator creation record initial values.
4. Bridge + registrar: preset state from session; explicit switch appends state; drop bootstrap field, bump protocol.
5. Docs: `docs/agent-spawning.md`, `docs/workflow-policy.md` (exclusions, Virtual Models preset), ADR 0001 note if needed.
6. Independent tests (blind), then independent review.

## Validation

- `npm run typecheck`; focused `test:fast` / `test:process` files for spawn, preparation, virtual models, child process runtime.

## Progress

- [x] Investigation and design (user chose fallback for unusable recorded models).
- [x] Implementation (3f4993b) and docs + ADR 0009 (98ece34). Focused fast + process tests pass (virtual-models, child-runtime-preparation, agent-templates, process-child-session-factory, agent-spawn, cold-host-recovery).
- [x] Independent blind tests (b7b26af): 7 process tests, all pass; Moderators not covered (stall setup too costly).
- [x] Independent review; fixes in d288d13 / b77a14b.
- [x] Full `test:fast` and `test:process` pass after updating one Moderator transcript assertion.

## Decisions

- Keep passing `--model` / `--thinking` (equal to the recorded values) instead of omitting them and letting Pi restore. Rejected omitting: Pi only restores when the session has messages, falls back to the user's settings default instead of the initial values, and does not know `excludedModels`; the host would also lose its exact effective configuration.
- Preset state uses Pi's router-state entry rather than a new custom entry type: it is Pi's documented per-branch storage for router state.
- Leaving a preset Virtual Model through `/model` also records explicit mode, so selecting the same name again is explicit as the docs say.
- Selection = last `model_change` only (not Pi's "last answered physical model" rule): with initial values recorded, every Agent has a `model_change`, and a Virtual Model selection must not collapse to the physical model that answered.

## Surprises & Discoveries

- Pi records `model_change` on an ordinary child's first start (Identity is a `custom` entry, not a message), but not for a Moderator, whose input is a `custom_message`, and never the Virtual Model thinking mode. Recording at Identity commit covers both.
- Children spawned in preset mode between #219 and this change have no router-state entry, so their next fresh Runtime resumes in explicit mode. #219 is unreleased, so this is accepted.
- Review: the protocol bump broke six version-13 fixtures; a fallback that lands on the same (inherited, excluded) model kept dropping the manual thinking level; an unknown recorded level blocked startup. All fixed.

## Outcomes & Retrospective

- Landed in PR #222. Spawn configuration is now only the initial selection; every fresh Runtime launches with the selection recorded in the Agent's session, and an unusable one falls back to re-resolving the raw initial values (Template candidates, Spawn config, current parent) with an Owner warning.
- Preset thinking moved from process memory and the bootstrap into Pi router state on the session branch (control protocol 14).
- `"inherit"` is now captured once at spawn: a child no longer follows its parent's later model changes after a restart.
- Durable decisions live in `docs/agent-spawning.md#model-selection`, `docs/workflow-policy.md`, `GLOSSARY.md` (Recorded Model Selection), and ADR 0009.
- Retrospective: my focused test list missed the protocol fixtures and a Moderator transcript assertion; the independent review and the full process suite caught them. A protocol bump should always include a search for version fixtures.
