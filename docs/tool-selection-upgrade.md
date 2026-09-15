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

## Updating an installation while a Workflow is running

Do not replace the extension beneath an active Workflow. The Owner can retain
its loaded producer code while the next child or Moderator loads the newly
installed consumer. Both can even claim the same protocol version if an older
release changed the bootstrap schema without bumping that version. Retrying a
resume or cancellation-delivery launch does not reconcile those contracts.

Use this upgrade sequence:

1. Finish work that requires the old contract using its matching installation.
   Stop active work and shut down the host before replacing that installation.
2. Upgrade the extension and review maintained Templates and Spawn configuration.
3. Start a fresh host with one consistent installation. Start a new Workflow if
   the saved Workflow depends on removed contracts. Reopen an existing Workflow
   only when its immutable evidence is valid under the installed version.
4. After valid recovery, inspect any interrupted external effects before using
   `workflow_resume`. Admission is not proof that interrupted tools completed or
   that their effects did not happen.

If an in-place update has already caused bootstrap rejection, stop issuing
launch retries and align the installation and host first. Restoring the matching
old installation may be necessary to finish an old-format Workflow. Do not edit
bootstrap descriptors, canonical Requests, or session transcripts to bypass the
error; launch rejection does not Answer, cancel, or authorize replay of a Request.

The compatibility checks in a new release cannot retrofit an Owner that was
already running older code. For the first upgrade, restart the host rather than
relying on the new checks or assuming `/reload` provides new cleanup guarantees
to an old coordinator. See [Owner resource reload](cold-host-recovery.md#owner-resource-reload)
for shutdown and revalidation constraints.

### Bootstrap compatibility checks

Control protocol 8 versions the required bootstrap `tools` field. Incompatible
bootstrap changes must change `AGENT_CONTROL_PROTOCOL_VERSION`; identical version
numbers alone do not prove compatible schemas.

Before ordinary child or Moderator preparation, the Owner checks the installed
bootstrap contract in a fresh, bounded Node process. This is a schema probe, not
a Pi session, Agent Run, or model call. It avoids the Owner's cached modules and
does not send connection tokens or Agent descriptors to the probe. The low-level
launch checks again before allocating its listener, startup artifacts, or PTY,
including when the launch preparation was cached.

An incompatible or unverifiable contract blocks that factory's launch path for
the rest of its lifetime. Repeated resume, cancellation-delivery, or Moderator
preparation attempts reuse the rejection rather than launching a diagnostic
Agent through the same path. Restoring files alone does not clear that rejection;
align the installation and restart the Owner. A rejection before runtime binding
does not create an exact Run failure or resolve any Request. Existing live
Runtimes are not proactively terminated by this check.

Diagnostics distinguish `control_bootstrap_protocol_mismatch` from
`control_bootstrap_schema_drift`. `control_bootstrap_probe_failed` means the
installed contract could not be verified, not that a version difference was
proved. Bootstrap validation reports schema field failures without printing
descriptor values or the connection token.

These diagnostics instruct the Owner to report the failure and its safe details
to the user immediately, stop child and Moderator launches, and guide the user to
stop active work, align the installed packages, and restart the Pi host running
the Workflow. Requests and transcripts must be preserved, and interrupted tool
effects inspected after restart before `workflow_resume`. This is agent guidance
carried by the error, not a separate automatic notification or host restart.

The check is not an atomic installation lock: files can still change between
verification and launch. It compares the bootstrap schema and protocol version,
not every implementation detail. Semantic contract changes still require version
discipline, and stopping the host before upgrading remains the safe procedure.

## Runtime inspection

Launch configuration `tools` records the selected initial set. Runtime snapshot `tools` reports the current active set. There is no separate allowed-tool ceiling in runtime snapshots. Consumers of the former snapshot field must update accordingly.
