---
status: accepted
---

# Keep one model-facing tool per coordination concern

The model reaches the coordination protocol through separate tools: `agent_message`, `agent_wait`, `agent_spawn`, `agent_observe`, `agent_control`, `ask_user`, `report_to_user`, `moderator_control`, and the Owner's `workflow_resume`. We keep that shape, and we do not fold `agent_spawn` into `agent_message` or merge everything into one subagent tool. Pi grants tools to roles by tool name: a Moderator gets `agent_message` but not `agent_spawn`, so a folded tool would need a different `agent_message` schema per role under one name. `agent_message` is already a union that needs an object-root workaround for some providers, and each folded operation makes it larger. Separate tools also tell the model that spawning, messaging, and waiting are different actions. Old transcripts are not a reason: a historical call that fails current record validation becomes Invalid Context-only Coordination, so a rename needs no second reader.

## Considered Options

- **Fold Spawn into Message as a seventh operation.** Rejected: it needs a Moderator-specific `agent_message` schema and a larger union in a schema that already needs an object-root workaround for some providers. The gain (one shared delegation guide) is already available as shared guidance text.
- **One subagent tool for every operation.** Rejected for the same reasons, made worse: about 25 variants in one schema, and role gating moved inside the schema.
- **Prior art.** Claude Code keeps spawning (Agent tool) apart from messaging (SendMessage). Codex keeps `spawn_agent`, `send_input`, and `wait` as separate tools.

## Consequences

- Shared behaviour across tools (exposure, execution mode, result lifecycle, role activation) lives in one Coordination Tool Catalogue module, not in a merged tool.
- A later rename or merge leaves earlier calls as Invalid Context-only Coordination. It needs no compatibility reader, but in-flight Workflows lose those calls' protocol effects.
