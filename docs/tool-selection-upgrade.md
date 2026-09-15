# Upgrading tool selections

Agent configuration and Template frontmatter now use `tools` alongside `skills`. This is a breaking contract change: the former `allowedTools` ceiling is removed, not accepted as an alias.

## Maintained configuration

Rename `allowedTools` to `tools` in Spawn configuration and Templates. Review each list rather than mechanically retaining every old entry: all selected tools must be active when the child is admitted. Remove unavailable tools and tools that were listed only to permit possible later activation. Include any optional tools that inherited extensions activate during startup, or configure those extensions accordingly. Required role coordination tools are added by the runtime.

Omitting the selection uses the captured Template selection, otherwise the parent's current active tools. An empty list selects no optional tools. Later native tool activation is still supported; do not list a tool merely because a loader may activate it later.

This change does not edit user-owned Template files automatically. Refresh the spawning Runtime's Template catalogue after updating those files.

## Persisted Workflows

Captured creation presets and canonical Spawn inputs can contain the removed field. Those records are immutable protocol evidence, not ordinary configuration files. The new runtime does not translate or rewrite them. Updating a Template does not change an existing Agent's captured preset or original Spawn input.

Finish Workflows that depend on old-format records with their matching installed version. Start a new Workflow after upgrading. If preserving one of those Workflows is required, it needs a separate, explicit offline migration design that preserves protocol identity and evidence relationships; no such migration is included here. Do not search-and-replace session JSONL or assume an old record will silently inherit current tools.

Even a Workflow with no removed field can encounter a new startup failure if extensions alter its initial tool selection. The admission error identifies missing and unexpected tools. Treat this as a configuration mismatch rather than weakening the startup contract.

## Runtime inspection

Launch configuration `tools` records the selected initial set. Runtime snapshot `tools` reports the current active set. There is no separate allowed-tool ceiling in runtime snapshots. Consumers of the former snapshot field must update accordingly.
