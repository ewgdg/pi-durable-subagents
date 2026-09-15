# Agent spawning

Every ordinary Agent can create one fresh child per `agent_spawn` call:

```ts
agent_spawn({
  title: "Diagnose the failing integration",
  request: "Inspect the failing integration and report the smallest safe fix.",
  template: "integration-researcher",
  label: "Integration researcher",
  description: "Investigates one integration failure",
  config: {
    cwd: "packages/integration",
    model: {
      id: "inherit",
      thinking: "high",
    },
    systemPrompt: "Reproduce the failure before proposing changes.",
    systemPromptMode: "append",
    loadContextFiles: true,
  },
})
```

`title` and `request` are required and nonblank. The immutable title identifies this Creation Request, independently of the child's label or description. `template`, `config`, `label`, and `description` are optional. Children always have isolated context; pass needed context explicitly in the Creation Request. The removed `conversation` field is rejected before a child or Creation Request is created. Runtime preparation inherits parent defaults, then applies captured Template rules and explicit configuration overrides.

## Agent delegation

Every Creation Request delegates work and follows the shared [Agent Delegation](agent-messaging.md#agent-delegation) rules. Once its Answer arrives, the parent synthesizes it, performs necessary validation, and integrates the result.

`config` may override the model and thinking level independently, working directory, tool allowlist, skills, explicit system prompt, system-prompt mode, and native loading of trusted project instruction files such as `AGENTS.md` and `CLAUDE.md`. This context-file setting does not inherit the parent conversation. The canonical `config` remains in the parent Spawn call and overlays the captured Template rules whenever a fresh Runtime is prepared. Both `config.model.id` and `config.model.thinking` are optional. Each omitted field uses the selected available Template model/thinking pair, or the current parent Runtime when the Template has no model candidates. Explicit `inherit` always uses that field from the current parent Runtime, even with a Template. Omitting `config.model` or providing `{}` uses those defaults for both fields. Template model candidates are resolved only when at least one field is omitted; if candidates are configured but none are available, resolution fails. Specifying both fields bypasses Template model candidates entirely. `allowedTools` and `skills` replace the captured or inherited selections, including with an empty array. Child extension selection is `inherit` or `none`; arbitrary per-child extension paths are not accepted.

Thinking levels follow the public `ThinkingLevel` type from `@earendil-works/pi-agent-core`. Coordination maintains one runtime list, compile-time checked for invalid and missing Pi levels, and derives its validators and schemas from that list. The Spawn-only `inherit` sentinel is separate; the Spawn schema is not restricted to the parent model’s supported levels.

Every Runtime shares the user's Pi configuration. The model and thinking pair resolved for a Spawn are explicit launch inputs only: preparing or starting the child must not persist them as user defaults. An explicit user preference action from an interactively selected Owner or child view updates the same shared configuration. Production child configuration must therefore not be isolated; tests that invoke persistent Pi APIs use an isolated fixture environment. See [ADR 0001](adr/0001-share-pi-user-configuration-across-agent-runtimes.md).

`allowedTools` is a capability ceiling, not an exact active-tool list. Pi and the selected extensions decide which allowed tools are registered and active, and may change their order during the Runtime. An allowed tool may therefore be unavailable or inactive. Role-required coordination tools are always added to the allowlist. Runtime startup rejects only an active tool outside the resolved allowlist.

The label resolves from the explicit label, selected template name, then `agent`. A description comes only from the explicit spawn input. Display metadata is trimmed, preserves Unicode, rejects line breaks and control characters, and is limited to 64 Unicode code points for labels and 240 for descriptions.

The authenticated calling Agent becomes the immutable Direct Spawner. Agent identity, Workflow membership, authority, role-required tool capabilities, and Creation Request delivery mode are not caller-supplied fields.

Every child receives a fresh durable Pi session and Agent identity. Its Identity commits the captured `creationPreset` atomically with display metadata, Workflow and Direct Spawner relationships, and a pointer to the canonical `agent_spawn` call. The preset is `null` when no Template was selected, and otherwise contains only Template rules: ordered model candidates and the exact optional-rule presence/value, including omitted versus explicit `extensions: inherit`. Template name, `useWhen`, and source path are not captured. The canonical Spawn call remains the source of explicit `config`, and a context-isolated child does not inherit the caller's transcript, branch, model context, assembled prompt, editor state, or queued input.

Immediately before each new Runtime, the host resolves the current parent configuration. A live parent contributes its configured tool allowlist and current remaining Runtime state; a dormant parent is resolved recursively from the current Owner, captured creation presets, and canonical ancestor Spawn inputs without starting those ancestors. The host then applies the child's captured `creationPreset`, canonical explicit Spawn configuration, role-required tool capabilities, current resources, trust, native project context-file loading, and explicit system prompt. It never re-selects the original Template name. The resulting launch specification is volatile and belongs only to that Runtime. Successor and cold-recovered Runtimes always prepare again; a retained Runtime keeps its resolved configuration across its exact Runs. Fresh preparation also loads that Runtime's descendant discovery and safe Template catalogue.

Only canonical file-backed inherited extensions cross the process boundary. `extensions: "none"` excludes them. Pi-owned built-ins are reconstructed by the fresh Pi CLI. Arbitrary injected, anonymous, and named inline factories are process-local composition details and are not child inheritance inputs.

## Agent Templates

Templates are discovered recursively from these roots, lowest to highest precedence:

1. `<coordination-package>/agents/`
2. `<Pi-agent-directory>/agents/`
3. `~/.agents/agents/`
4. `<current-parent-runtime-cwd>/.agents/agents/` when that project is trusted

Discovery follows file and directory symlinks with canonical-path cycle prevention. A higher-precedence file replaces the whole lower definition. Same-precedence duplicates make that name unavailable, and a malformed named higher-precedence definition blocks lower fallback.

A Template is UTF-8 Markdown with required leading YAML frontmatter:

```markdown
---
name: integration-researcher
useWhen: Use for integration work requiring external documentation or source verification.
models:
  - id: anthropic/claude-sonnet-4-5
    thinking: high
  - id: deepseek/deepseek-v4-flash
    thinking: medium
skills:
  - research
extensions: inherit
systemPromptMode: append
loadContextFiles: true
---
Use primary sources and record exact reproduction evidence.
```

`name` is required lowercase kebab-case. Optional `useWhen` is nonblank text that tells a spawning Agent when to select the Template. Optional `models` is a nonempty ordered sequence of `id` and `thinking` pairs. The full candidate order is captured; each Runtime preparation that needs model defaults selects the first currently available pair and fails if none are available. Availability requires both a catalogue entry and configured provider authentication. Without `models`, an ordinary Agent inherits the current parent model and thinking pair. A Moderator instead inherits the current Owner model and lets Pi apply its shared default thinking level; a `moderator` Template with `models` explicitly selects both values. `systemPromptMode` defaults to `append`, and `loadContextFiles` defaults to `true`. The remaining frontmatter fields are `allowedTools`, `skills`, and `extensions`; an omitted `extensions` field means inherit at Runtime, while explicit `inherit` and `none` are captured distinctly. `systemPromptMode` controls the explicit system-prompt channel; `loadContextFiles` controls native loading of trusted project instruction files such as `AGENTS.md` and `CLAUDE.md`. The Markdown body is the explicit child system prompt. Templates cannot define display metadata, working directory, the Creation Request, identity, authority, or lifecycle behavior. The reserved name `moderator` cannot be selected by ordinary `agent_spawn`.

Owner initialization and each child Runtime preparation load the full Template discovery result and safe catalogue together in memory for that spawning Agent. The active `agent_spawn` tool exposes the safe catalogue through prompt guidance; Pi owns ordinary system-prompt assembly, and coordination performs no per-Run discovery or system-prompt mutation. Selection and guidance use the same load, including missing, invalid, and ambiguous names, so filesystem edits or removal during the load cannot change either result. Runs in a retained Runtime reuse that load. Explicit reload refreshes only that Agent's future-spawn discovery; it does not mutate existing Agents' captured presets.

Under the `Available Agent Templates Snapshot` heading, each prompt entry exposes its name, `useWhen` guidance, configured frontmatter values, and flat `model` and `thinking` fields for the first pair available when the load was captured. The full candidate list is not exposed in prompt guidance. A Template whose configured candidates are all unavailable is omitted from the safe catalogue. This lets the Agent select a Template or deliberately override values through `agent_spawn.config` for isolated children. Invalid and ambiguous Templates, Template source paths, discovery diagnostics, and Markdown system-prompt bodies are not exposed. The catalogue is guidance only. At Spawn, the selected definition from the same full discovery load is captured into `creationPreset`; Runtime preparation later resolves that preset against current parent ancestry, resources, trust, and explicit overrides without selecting the original Template name again. Runtime Preparation also validates an explicitly overridden model against the current availability snapshot before committing the child Identity.

A spawning Runtime loads project-scoped Templates from its own cwd; children select from that prefetched load. The per-spawn `config.cwd` resolves against that cwd and determines the prepared Runtime cwd. Pi applies its current project-trust decision there, and the child natively discovers permitted project instruction files such as `AGENTS.md` and `CLAUDE.md` when `loadContextFiles` is true. The explicit system prompt is passed independently with `--append-system-prompt` or `--system-prompt`; `loadContextFiles: false` passes `--no-context-files`. An untrusted project cannot contribute selected resources. Changes to current resources, trust, or cwd can therefore affect a later descendant Runtime; changing a Template does not mutate an already captured preset.

## Commitment and delivery

The committed native `agent_spawn` tool call is the Creation Request source and retains the canonical explicit Spawn configuration. The child Identity append commits the child, its captured `creationPreset`, and Request together. After Identity commit, startup or scheduling failure never removes the child or Request.

The child starts a fresh Pi CLI/TUI process and admits its fixed-Deferred Creation Request into the same serialized incoming-Request lane used by ordinary [Agent messaging](agent-messaging.md). Creation Request Delivery establishes an Answer obligation. Deferred Requests enter in live admission order at Agent Wait or settled-work boundaries, irrespective of ancestry; Steer Requests take priority at safe boundaries. The child chooses which delivered unresolved Request to work on or answer. A successful spawn receipt reports volatile admission; it does not claim that Delivery committed, the model processed the Request, or an Answer exists.

Confirmed Delivery admission failure releases the new child Run to dormant while preserving the committed child and Creation Request. Once Delivery commits, the Run remains retained while the child owes the corresponding Answer.

An admission exception before dispatch removes its abandoned scheduling item and releases an otherwise unretained child Run before reporting the error. Dispatched or proven Delivery keeps its existing reconciliation ownership. Explicit retry preserves the original Request identity and rechecks an undispatched pending item's eligibility; an existing dispatch reservation prevents duplicate Delivery.

After child Identity commit, the Creation Request uses the ordinary [Request protocol](agent-messaging.md): the Spawner can poll, retry, retrieve its Answer, or cancel; the child Answers through `agent_message`. The Answer fulfills one Request obligation and does not represent child completion or lifecycle state.

## Receipts

- `spawnStatus: "created"` with `messageStatus: "sent"` — the child and Creation Request exist, the first Run started, and the Request was admitted for asynchronous Delivery. It may still be queued and is not necessarily delivered.
- `spawnStatus: "created"` with `messageStatus: "not_sent"` — the child and Creation Request exist, but confirmed Run startup or Delivery admission failed. `failedStage` identifies that exact stage and `reason` reports the failure.
- `spawnStatus: "not_created"` — validation failed before child Identity committed. `failedStage` and `reason` report where and why.
- `spawnStatus: "unknown"` — confirmation was lost at a boundary where effects may exist. Candidate Agent and Request Message identities are returned when available.

Created and uncertain receipts include the effective runtime configuration only after it has resolved and passed resource validation. A created receipt returns `agentId` and `requestMessageId`; an uncertain receipt names them as candidates. Collapsed native rendering shows the Spawn and Message statuses, the Agent as `label · compact identity` using the final eight identity characters, model, thinking level, and any confirmed failure stage and reason. Expanded rendering identifies the Agent as `label · full identity`, followed by the exact structured receipt and effective configuration.

Repeating `agent_spawn` creates a sibling. Unfiltered direct-child search returns children in canonical spawn-call order; filtered results use relevance first and that order as their deterministic tie-breaker. Observation is passive and supports exact status lookup plus bounded composable search over authorized Agent scopes. It returns identity, structural relationship, and live Run state without exposing a Pi session or Run handle; search never prepares a dormant Runtime.

Ordinary child transcripts share the Owner-derived Workflow directory regardless of effective Run cwd. A fresh host validates that directory to recover verified dormant Agents and authority; see [Cold host recovery](cold-host-recovery.md).
