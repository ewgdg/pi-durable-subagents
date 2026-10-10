# Virtual models

Issue: #216. Related: #213 (Config tab edits these definitions later), #217 (spawn guidance trim).

## Goal

Let the user define named, ordered model lists once and use them anywhere a model id is accepted, so a retired or excluded model is fixed in one place and every Agent that uses the name follows on its next request.

## Intention

Model ids in Agent Templates go stale often, and the same fallback chain is copied across Templates. A **Virtual Model** is a named ordered list of `id` + `thinking` entries, exposed as the model id `virtual/<name>`. It also works as a thinking preset: each entry carries the level tuned for that model.

Pi 1.1 already ships native virtual models (`pi.registerVirtualModel()`, `node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md`, experimental since 0.99.0). Pi keeps the selection (`virtual/fast`, selected level) apart from the dispatch (real model, real level). Assistant messages record the real model, the footer shows `fast • high → deepseek-flash • max`, context limits and compaction follow the real model, and router state lives on the session branch. This plan only supplies definitions and a `route()` function. It writes no provider, streaming, or message conversion code.

## Scope & Constraints

- **Definitions** live in the existing Workflow Policy file `<agentDir>/config/pi-durable-subagents.json`, as one new optional field:

  ```json
  {
    "virtualModels": {
      "fast": [
        { "id": "openai-codex/gpt-6.1-luna", "thinking": "high" },
        { "id": "deepseek/deepseek-flash", "thinking": "max" }
      ]
    }
  }
  ```

  - Names are lowercase kebab-case (same rule as Template names). Each list is nonempty, entries hold exactly `id` (`provider/model`, a real model, never `virtual/*`) and `thinking` (a Pi thinking level), with no duplicate ids. Anything else rejects the whole file, like every other field.
- **Provider id** is the fixed `virtual`. Pi treats a virtual model under an unused provider id as always available, so availability is decided by our own pre-check and `route()`.
- **Usable entry**: present in the catalogue, provider has configured auth, and not matched by `excludedModels`. The deny list applies to real entry ids as usual. A `virtual/*` or `virtual/<name>` deny entry also works on the selection id, with no special casing.
- **Routing** (`route(request, ctx)`):
  - `continuation` and `retry` stay on `request.previous` / `request.failed` when that model is still a usable entry of the definition, keeping prompt caches and thinking signatures valid (Pi's documented guidance).
  - Otherwise (`user`, `direct`, or the sticky model is no longer usable), pick the first usable entry.
  - No usable entry: throw with a message naming the virtual model and why each entry is unusable. Pi turns that into an error response.
  - Definitions used by `route()` are the latest valid read of the policy file, re-read when its mtime changes. An invalid file keeps the last valid definitions and reports a diagnostic, mirroring the Owner's existing policy reload behavior.
- **Thinking**:
  - **Explicit mode**: the selected level is used for every entry. Pi clamps it to the routed model.
  - **Preset mode**: each entry's own `thinking` is used, and the selected level is ignored.
  - Templates and `agent_spawn.config.model` accept `thinking: preset`, valid only on `virtual/*` ids. Any other id with `preset` is a parse/validation error.
  - A spawned child starts in the mode its resolved configuration names. In preset mode the launch passes `--thinking <first usable entry's level>`, so the footer selection matches the primary entry.
  - A virtual model registered for ordinary selection (`/model`, the Owner, inherited by a child from its parent) is in explicit mode.
  - A virtual model offers every thinking level supported by any of its entries (`thinkingLevels`), so a spawn does not clamp the level before routing.
- **Catalogue metadata**: `contextWindow` and `maxTokens` come from the first entry. Pi only shows them before the first response and then uses the routed model's limits. `input` stays Pi's default (text and image; models without image support receive placeholders).
- **Registration** happens in every process that may run a virtual selection:
  - The Owner extension (`src/index.ts`) registers at factory time and re-registers on `session_start` (which includes reload) from the Owner policy read.
  - The child bridge (`src/process-runtime/child-runtime-bridge.ts`) registers at factory time from its own read of the policy file, before Pi resolves `--model`. Children run with `--no-extensions --extension <bridge>`, so the Owner's registration does not reach them.
  - Adding or removing a name applies to new processes and to the Owner after reload. Editing the entries of an existing name applies on the next routed request everywhere.
- **Runtime preparation** (Owner process): a `virtual/<name>` candidate or explicit id is available only when the definition exists and at least one entry is usable now. This fails a spawn before the Agent Identity exists instead of at its first request. Existing error wording gains the virtual case.
- **Captured `creationPreset`** keeps storing the Template's candidates, which may now be `virtual/<name>` with a level or `preset`. The name binds late, so dormant Agents follow definition edits. No change to what is captured.
- **Peer dependency**: raise `@earendil-works/pi-coding-agent` (and the other `@earendil-works/*` peers) from `*` to `>=0.99.0`, the first release with `registerVirtualModel`.
- **Out of scope**:
  - The Config tab editor (#213). This plan only ships the file format and a writer usable by #213 later.
  - Switching a preset session to explicit when the user picks a thinking level by hand. See Layer 3.
  - Retry fallback to the next entry on provider errors (quota, overload). Possible follow-up.
  - Spawn guidance changes (#217).

## Work Plan

Grow in layers. Each layer ships working behavior on its own.

### Layer 1: virtual models in explicit mode

1. `src/policy/workflow-policy.ts`: parse and validate `virtualModels`. Add it to the snapshot type, defaults, and allowed fields.
2. New `src/policy/virtual-models.ts`: definition types, the usable-entry predicate (catalogue + auth + exclusions), and the pure routing decision (sticky vs first usable, error text). Keep it Pi-free apart from types so it is unit testable.
3. New Pi integration module (`src/pi-integration/virtual-model-registration.ts`): build `registerVirtualModel` definitions (provider `virtual`, `thinkingLevels`, limits) and the `route()` adapter. Owns the mtime-cached policy re-read.
4. Register from the Owner extension and from the child bridge.
5. Runtime preparation: the availability check handles `virtual/<name>` (definition exists + one usable entry). Check whether `modelRuntime.getAvailableSnapshot()` lists registered virtual models, and adapt `#catalogueModel` / `#clampThinking` if it does not.
6. Docs: `docs/workflow-policy.md` (new field and rules), `docs/agent-spawning.md` (virtual ids in Template candidates and spawn config, routing, late binding), `GLOSSARY.md` (Virtual Model term, Workflow Policy entry), README mention.

### Layer 2: preset thinking

1. Template parser and `agent_spawn` input: accept `thinking: preset` only with a `virtual/*` id. The captured `creationPreset` thinking type widens to include `preset`. This is transcript evidence, so the change is additive only: existing transcripts stay valid.
2. Resolved run configuration and child launch: carry the thinking mode to the child (through the bootstrap descriptor the bridge already reads). In preset mode pass the first usable entry's level as `--thinking`.
3. The child's router uses the entry level in preset mode.
4. Docs and glossary for preset mode.

### Layer 3 (proposal, needs a go-ahead): manual override

Pi emits `thinking_level_select` for every level change, including Pi's own startup application of `--thinking` and model cycling, so the event alone cannot tell a manual pick. The extension itself never calls `setThinkingLevel`, so any change after child startup completes is user- or extension-initiated. Treat that as switching to explicit mode, and persist the switch as router state so a resumed Runtime keeps it.

## Validation

- Per the user's verification rules, an independent agent writes the tests from the issue text and the public interfaces (policy file format, Template/spawn syntax, routing behavior), blind to this implementation.
- Expected coverage:
  - fast: policy parsing and rejection cases, the routing decision table (sticky, first usable, excluded, missing auth, retired, none usable), the `preset` validation rules, and preparation availability for virtual ids.
  - process: a spawned child with a `virtual/<name>` Template candidate starts, routes to the first usable entry, records the real model on its assistant message, and follows a definition edit on its next request. A preset child dispatches each entry's own level.
- Commands: `npm run test:fast -- --file=<name>.test.ts`, `npm run test:process -- --file=<name>.test.ts`, `npm run typecheck`. Full suites only before finishing.
- A separate independent agent reviews the final change before merge.

## Progress

- [ ] Plan reviewed by the user
- [ ] Layer 1
- [ ] Layer 2
- [ ] Layer 3 decision

## Surprises & Discoveries

- Pi ships native virtual models (0.99.0+). The first issue draft planned a custom router provider with `streamSimple`. That is no longer needed.
- `thinking_level_select` fires for programmatic changes too (`AgentSession.setThinkingLevel` emits it whenever the level changes), which is why manual override is a separate layer.
- Child processes load only the bridge extension, so registration is needed in two places.

## Decisions

- **Session history records the real model.** Pi does this natively. Rejected recording the virtual id: pi-ai only replays reasoning signatures when the message's provider/api/model match the target model.
- **Thinking is a preset in the definition, overridable by the Template.** Rejected: thinking only in Templates (loses per-model tuning inside one chain), and thinking only in definitions (no override).
- **Definitions live in the Workflow Policy file.** Rejected a new file: one user config file already holds model policy and has a strict parser and atomic writer.
- **Metadata from the first entry, Pi's default input types.** Rejected the earlier "smallest context window across entries" plan: Pi already switches to the routed model's limits after the first response and compacts per routed request.
- **Routing sticks to the previous model for continuations and retries.** Rejected always taking the first usable entry: it would switch models mid-turn and break prompt caches and thinking signatures.
- **Definitions bind late.** Rejected expanding the list into the `creationPreset` at spawn: dormant Agents would keep retired models, which is the problem this solves.

## Outcomes & Retrospective

(Filled when the work lands.)
