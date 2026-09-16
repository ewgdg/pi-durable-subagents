# pi-durable-subagents

Durable Pi agents that collaborate asynchronously under explicit Owner and Spawner supervision.

## Features

### Interactive Agent switching

Run `/agents` from the Owner or any Agent to open the Agent switcher. Use `/agents owner` to return directly to the exact mounted Workflow Owner presentation without opening the switcher:

![The Agent switcher overlay with Live and Dormant tabs](docs/images/agent-switcher.png)

Select a subagent to enter its complete Pi session and interact with it directly—read its transcript, type into its editor, or use its commands and tools.

### Coordination and supervision

- **Owner-directed Workflows:** the current interactive Pi session becomes the durable Workflow Owner. The Owner can fork or clone copied conversation into a fresh, independent Workflow.
- **Durable child Agents:** ordinary Agents can create configurable context-isolated children with `agent_spawn`.
- **Messaging and Requests:** `agent_message` supports immutable titled Requests, explicitly targeted Answers, retrieval, and cancellation. Deferred Requests enter in admission order when the recipient waits or settles; Steer retains priority. Background Messages and Requests wait until settlement with no Answers owed and no eligible higher-priority work. Agents choose their Answer order. `agent_wait` joins all outstanding outbound Request Answers or selected IDs/unique suffixes without consuming child execution capacity while parked.
- **Visible obligations:** `agent_observe` lists your outstanding Requests by ID, requester, and title, or retrieves the exact full Request by ID/unique suffix. Answer receipts identify the originating Request by title and ID.
- **Human decisions for spawned Agents:** `ask_user` lets a spawned Agent block its exact Run on one free-form Human Answer. The full request stays in the Agent transcript, while background requests appear as passive `DECIDE` attention.
- **Run supervision:** Workflow Owners and Direct Spawners can inspect authorized Agents with `agent_observe`, then interrupt, explicitly resume, or terminate exact Runs with `agent_control`.
- **Operational incident handling:** one bounded runtime reminder recovers simple forgotten Answers before isolated Moderators handle persistent Obligation Stalls, overdue answer obligations, answer-obligated Run Failures, closed live Dependency Deadlocks, and stalled deliveries blocking upstream obligations. Review renewal, Run control, Owner escalation, and Resolution are policy-bounded and mechanically gated.
- **Durable recovery:** a fresh host reconstructs verified authority, standalone Moderators, and residual Request retention from complete Pi transcripts without replaying volatile work.
- **Admission repair:** `/agents repair` handles supported transcript-admission failures in the same terminal, initially exact duplicate Delivery evidence. Healthy Workflows are unchanged; rejected history stays inert. No extra confirmation or upstream changes; currently POSIX only. See [repair operations](docs/workflow-repair-operations.md).

Coordination does not override Pi's user-configured compaction, retry, provider-retry, or transport behavior. One failed Moderator may be replaced once; a second failure creates passive, Owner-only Operational Attention.

## Installation

Install directly from the Git repository:

```bash
pi install git:github.com/ewgdg/pi-durable-subagents
```

## Usage

Start an interactive Pi TUI:

```bash
pi
```

The package adopts the current session as the Workflow Owner; no separate activation command is required. Print, JSON, and RPC modes do not activate coordination.

## Suggested agent templates

See [Agent Templates](docs/agent-spawning.md#agent-templates) for configuration details.

Templates are creation presets: selecting one at spawn captures its rules in the new Agent's durable bootstrap. Later Runtime preparation uses that captured preset with the canonical spawn `config` and current resources; it does not re-select the original template. Template edits take effect for future spawns after resource reload, without changing existing Agents' presets.

### `cheap-delegate`

A cost-efficient default for bounded implementation, routine execution, and targeted fact-finding.

Save as `~/.agents/agents/cheap-delegate.md`:

```markdown
---
name: cheap-delegate
useWhen: >-
  Use as a cost-efficient default delegate for tasks with clear goals and
  verifiable outcomes, such as implementation with explicit requirements or
  instructions and bounded scope, routine execution, or targeted fact-finding.
  Do not use for thorough review, open-ended investigation, high-stakes security
  or architecture work, or tasks requiring substantial ambiguity resolution.
  If its results remain inadequate after several iterations and show no obvious
  improvement, stop assigning that task to this template.
models:
  - id: openai-codex/gpt-5.6-luna
    thinking: high
---
```

### `moderator`

Use a cheaper model for incident handling. The `moderator` template is used automatically for incident handling.

Save as `~/.agents/agents/moderator.md`:

```markdown
---
name: moderator
useWhen: Use for moderation and incident response.
models:
  - id: openai-codex/gpt-5.6-luna
    thinking: high
  - id: deepseek/deepseek-v4-flash
    thinking: high
---
```

## Compatibility

Pi supplies the package's Pi peer modules. Compatibility is defined jointly by a fail-fast structural gate against the running host module world and the native behavioral conformance suite. The Pi version is diagnostic only.

Process-isolated Agent Runtimes select local IPC internally: Unix-domain sockets on Unix platforms and native named pipes on Windows. This transport choice is not user-configurable.

Maintainers can run the focused compatibility gate with:

```bash
npm run test:conformance
```

`npm test` remains the complete regression suite. Use the supervised npm entry points for all development runs: `test:fast` (four concurrent files), `test:process` (serial), and `test:conformance` (serial). Direct `node --test` execution bypasses containment and is not supported for development runs.

Select one file and optionally a test name without bypassing supervision:

```bash
npm run test:process -- --file=agent-request.test.ts --test-name-pattern='request'
npm run test:fast -- --file=host-shape.test.ts
npm run test:conformance -- --file=host-shape.test.ts --list
```

Node's file timeout is 5 seconds for fast tests and 120 seconds for process/conformance tests. Independently, the supervisor starts a wall-clock timer when it launches the Node runner: `ceil(selected files / suite concurrency) × file timeout + 5 seconds`. A focused process file therefore gets 125 seconds; a name filter does not reduce that budget. Expiry reports the deadline, sends SIGTERM, then uses existing descendant force-kill cleanup after at most 100 ms of termination grace, and exits with code 124. Startup before launch and cleanup add time beyond that budget. This timer remains responsive when a test worker spins synchronously.

For a deliberately different budget, append `--deadline-ms=10000`. It must be an integer from 1 through 2147483647; zero cannot disable containment. Forwarded Node flags do not alter the independently calculated suite budget; use the explicit deadline override when changing concurrency or Node timeouts.

On Linux with writable cgroup-v2 support, the existing cgroup and guardian contain Node/PTY descendants even if the supervisor is killed. Otherwise cleanup is best-effort: Linux tracks observed descendants via `/proc` (short-lived/reparented processes can escape observation); other Unix systems kill the runner process group, and Windows kills only the root process. The deadline requires the supervisor itself to remain alive and responsive; it is not a machine-level resource limit.

## Trust and persistence

Coordination is a trust-based protocol, not a security boundary. Owners, Spawners, ordinary Agents, and Moderators are trusted participants acting through role-scoped tools.

Pi transcripts are the durable authority for identity, Messages, Requests, Deliveries, and committed results. Scheduling queues, Holds, live Run state, UI attention, and open Agent-view attachment are volatile: orderly shutdown closes them, while abrupt process loss can discard them without claiming durable completion.

## Documentation

- [Owner Workflow](docs/owner-workflow.md) — activation and compatibility behavior
- [Owner blockage diagnostics](docs/owner-blockage-diagnostics.md) — persistent admission failure status and `/agents diagnostics`
- [Workflow repair operations](docs/workflow-repair-operations.md) — `/agents repair`, same-terminal repair Moderator, cancellation, and recovery
- [Transcript repair contract](docs/workflow-transcript-repair-design.md) — writer retirement, validation/audit, commit-before-reopen, and supported limits
- [Operational Incident moderation](docs/operational-incident-moderation.md) — trigger detection, bounded handling, Moderator authority, Resolution, and recovery
- [Cold host recovery](docs/cold-host-recovery.md) — transcript discovery, quarantine, dormant rosters, and residual Requests
- [Workflow Policy](docs/workflow-policy.md) — reloadable execution, delivery, and review limits
- [Agent spawning](docs/agent-spawning.md) — child creation and receipt semantics
- [Agent messaging](docs/agent-messaging.md) — delivery modes and Agent Requests
- [Human Requests](docs/human-requests.md) — transcript-native questions, Answer mode, and commitment
- [Agent selector](docs/agent-selector.md) — Live hierarchy, Dormant recency, attention, and keyboard navigation
- [Interactive Agent view acceptance](docs/agent-view-acceptance.md) — complete-mode rendering, input, transitions, isolation, and lifecycle evidence
- [Run supervision](docs/run-supervision.md) — observation, interruption, resumption, termination, and Agent-view retention
