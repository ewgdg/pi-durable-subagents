---
status: accepted
---

# Keep one model-facing tool per coordination concern

The model reaches the coordination protocol through separate tools: `agent_message`, `agent_wait`, `agent_spawn`, `agent_observe`, `agent_control`, `ask_user`, `report_to_user`, `moderator_control`, and the Owner's `workflow_resume`. We keep that shape, and we do not fold `agent_spawn` into `agent_message` or merge everything into one subagent tool. Tool names are durable protocol evidence. The Creation Request identity resolves the committed `agent_spawn` call by name, and protocol, coordination, and transcript code branch on that origin. Recovery reads old transcripts, so a renamed or folded tool would need both shapes read forever. Pi also gates tools per name: each role gets its tools through activation, and a folded tool would need different schemas under one name for different roles.

## Considered Options

- **Fold Spawn into Message as a seventh operation.** Rejected: it needs a permanent second reader for `agent_spawn` evidence, a Moderator-specific `agent_message` schema, and a larger union in a schema that already needs an object-root workaround for some providers. The gain (one shared delegation guide) is already available as shared guidance text.
- **One subagent tool for every operation.** Rejected for the same reasons, made worse: about 25 variants in one schema, and role gating moved inside the schema.
- **Prior art.** Claude Code keeps spawning (Agent tool) apart from messaging (SendMessage). Codex keeps `spawn_agent`, `send_input`, and `wait` as separate tools.

## Consequences

- Shared behaviour across tools (exposure, execution mode, result lifecycle, role activation) lives in one Coordination Tool Catalogue module, not in a merged tool.
- A later surface change that renames or merges a tool must come with an explicit migration decision for existing transcripts.
