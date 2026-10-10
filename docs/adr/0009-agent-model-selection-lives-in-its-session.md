---
status: accepted
---

# Agent model selection lives in its session

An Agent's model and thinking level are the selection its own Pi session records, as in any Pi session. Template candidates, `agent_spawn.config.model`, and Virtual Model preset thinking only supply the initial values, which Identity commit records in the child's session. Every fresh Runtime launches with the last recorded selection, so a manual `/model` or thinking change survives a dormant wake-up, a successor Runtime, or cold recovery. Preset mode is Pi's router state for the Virtual Model, so a switch to explicit mode survives as well. When the recorded model is no longer usable (missing from the catalogue, without authentication, excluded by model policy, or an undefined Virtual Model), preparation resolves the initial values again, records them, and warns. Before this, every fresh Runtime resolved the initial values again and passed them as `--model` / `--thinking`, which override the session, so the same Agent could run on a different model after a restart.

## Considered Options

- **Launch without `--model` / `--thinking` and let Pi restore.** Rejected: Pi restores only when the session has messages, falls back to the user's default model rather than the initial values, and does not apply `excludedModels`. The host would also lose the exact effective configuration it reports and passes to descendants.
- **Refuse to prepare when the recorded model is unusable.** Rejected: a durable Agent would stay stuck until a human edits policy or switches the model by hand.
- **Ignore exclusion for a recorded selection.** Rejected: exclusion exists to move work off a model, and a dormant Agent waking up should follow it.

## Consequences

- The host still passes `--model` / `--thinking`, now with the recorded values, so the launch, the receipt, and the recorded selection agree.
- A dormant parent passes on its recorded selection, so a child inherits what the parent would actually run.
- The child bootstrap no longer carries preset thinking (Control protocol 14).
- ADR 0001 still holds: the selection lives in the Agent's session, never in the shared user configuration. A Moderator left on Pi's default thinking keeps the level Pi chose on its first start.
