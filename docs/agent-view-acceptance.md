# Interactive Agent view acceptance matrix

This matrix records the production process-backed Agent-view contract and its regression evidence.

## Production paths

- `src/process-runtime/pi-child-process-runtime.ts` — exact Pi CLI process, PTY, Control admission, transcript handoff, and process-group cleanup.
- `src/process-runtime/pty-terminal-projection.ts` — startup ANSI diagnostics, hidden-output drainage, raw output subscription, terminal-reply ownership, input, resize, and exact exit.
- `src/process-runtime/pi-child-hosted-runtime.ts` — process-neutral Run intentions and lifecycle settlement.
- `src/process-runtime/child-runtime-bridge.ts` — truthful child TUI binding, lifecycle reporting, coordination tools, activity dock, and `/agents` registration.
- `src/process-runtime/remote-agent-selector.ts` — scoped selector snapshots and awaited Owner selection actions.
- `src/presentation/physical-terminal-attachment.ts` — Owner TUI suspension, atomic handoff buffering, physical-output backpressure, direct raw child PTY routing, retargeting, terminal reset, and Owner restoration.
- `src/presentation/agent-view-surface.ts` — attachment lifecycle, failure handling, and host-close integration.
- `src/coordination/durable-agent-view.ts` — one retargetable Workflow attachment.
- `src/coordination/workflow-coordinator.ts` — view authority, retention, retargeting, Human Attention focus, and shutdown.

## Process and terminal isolation

| Contract | Evidence |
|---|---|
| Every non-Owner Runtime is a distinct Pi CLI process | `tests/process-child-session-factory.test.ts`, `tests/pi-child-process-runtime.test.ts` |
| Child context is real TUI/UI | process Runtime handshake tests require `mode: "tui"` and `hasUI: true` |
| Child extensions cannot mutate Owner globals | Moderator theme isolation and Agent-view process probes |
| Physical Herdr pane ownership remains Owner-only | child environment tests and the real Herdr Owner → child → Owner gate |
| One process writes a live child transcript | transcript materialization, fresh-file inspection, successor, and cold-recovery tests |
| Process group, socket, bootstrap, context, and PTY cleanup are exact | process Runtime, launch cancellation, shutdown, and descendant cleanup tests |

## Complete child UI

| Contract | Evidence |
|---|---|
| Child editor, footer, status, widgets, notifications, commands, shortcuts, dialogs, and overlays remain native | `tests/agent-view.test.ts` file-backed process probes |
| Long transcript navigation, mouse input, streaming, and reflow work through a real PTY | `tests/coordinated-workflow-pty.test.ts` |
| Raw output and physical input remain buffered until native presentation reinitialization completes; physical-versus-emulated terminal replies, cursor, styles, wide cells, and resize remain separate and exact | physical attachment and PTY Terminal Projection tests |
| Hidden sessions continue IPC work and persistence without native rendering or background screen parsing; reattachment redraws current native state | Native-presentation and real process Runtime visibility regressions |
| Startup dialogs are visible before Runtime admission | Agent-view startup modal and process launch tests |
| Child input/render/initialization/process failures restore the Owner or retain the failed view according to Run state | Agent-view unit and fullscreen failure PTYs |
| Closing a pending view cannot orphan a hidden startup UI process | Dormant startup cancellation and Workflow shutdown tests |

## Durable `/agents` navigation

| Contract | Evidence |
|---|---|
| Owner and process children render the complete scoped selector | selector surface and remote selector snapshot tests |
| `o` returns to Owner by closing only the attachment and keeping retained child work alive | fullscreen return and interactive host conformance tests |
| Selecting another child retargets one physical attachment without restoring Owner between children | physical attachment tests, independent process-child switch tests, and fullscreen PTY switch |
| Raw output, native mouse input, ordinary input, and resize continue after retarget | physical attachment, mouse-scroll, complete-frame/input, and 100×30 PTY cases |
| Selecting the same child is safe; cancellation preserves selection | remote selector domain tests |
| Stale Human Attention or focus failure restores the previous Agent | `tests/remote-agent-selector.test.ts` |
| Escape remains native child input | custom editor and overlay tests |
| Activity and Attention update while the selector is open | Control snapshot/change events and activity dock tests |

## Runtime and Run ownership

| Contract | Evidence |
|---|---|
| Only Agent Identity or Moderator Input commits before process launch; resolved configuration remains volatile | spawn, transcript, and process factory tests |
| Dormant selection can prepare a Runtime without inventing model work | cold-recovery and Dormant Agent-view tests |
| Failed Dormant Runtime preparation opens durable read-only post-mortem evidence with keyboard and mouse wheel scrolling and restores the exact prior presentation | post-mortem surface, post-mortem fullscreen wheel, remote selector, and failed Moderator Agent-view tests |
| Extension, editor, command, Message, and `session_start` input activate exact Runs normally | Agent-view activation tests |
| Dormant Runtime compaction and input accepted into Pi's compaction queue survive Owner detachment until the operation ends or the input transfers to a successor Run | detached Dormant compaction Agent-view regression |
| `agent_settled` is authoritative; prompt acceptance is not settlement | hosted Runtime lifecycle and retry tests |
| Selected failure, termination, interruption, and Workflow shutdown preserve exact Run identity | Runtime supervisor and process fault tests |
| Successor and cold Runtimes re-resolve captured creation presets with current resources, trust, native project context-file loading, explicit system prompt, and ancestry | process factory, successor, and cold discovery tests |
| Nested spawning uses the admitted live parent Runtime or recursively resolves a dormant parent from canonical creation inputs | dynamic parent preparation and fullscreen nested-child tests |

## Release gates

The acceptance matrix is complete only when these commands pass:

```text
npm run typecheck
npm test
npm run test:conformance
npm pack --dry-run
npm audit --omit=dev
git diff --check
```

The real integration gate starts a Herdr-managed Pi Owner, delegates to a process child, waits for the child's Answer, confirms the final session reference remains the Owner session, confirms Herdr reaches `done` or underlying `idle`, and verifies no child process or transient Runtime artifact remains.

## Fullscreen selector pointer controls

`tests/agent-selector-pointer-fullscreen.test.ts` mounts the actual selector through
`TuiAltScreen.showOverlay`, sends terminal mouse reports through its real input
callback, and inspects the rendered screen with `@xterm/headless`. A mounted native
Editor records any input that escapes the selector.

Coverage includes tab/participant/Owner actions, the complete trailing child
control, ancestor paths (including wide characters), informational details and
omitted/current breadcrumbs, hover without keyboard-focus movement, middle/right
buttons, roster-scoped wheel scrolling, resize/clipping and hit targets after
scrolling, full-screen editor isolation before and during asynchronous preparation,
loading feedback across resize, and pointer actions independent of customized keyboard
confirmation bindings. The standard selector and remote-selection
suites retain keyboard and already-mounted-participant contracts.

Run only the relevant presentation suites:

```sh
node --test tests/agent-selector-surface.test.ts tests/agent-selector-pointer-fullscreen.test.ts tests/remote-agent-selector.test.ts tests/agent-view-surface.test.ts
npm run typecheck
```

This verifies the real fullscreen renderer in-process, not a manual terminal session.
Pi's regular terminal mode does not route component mouse input.

## Fullscreen activity dock pointer

`tests/agent-activity-dock-pointer-fullscreen.test.ts` mounts the dock inside the
host's widget container above a mounted native Editor and routes terminal mouse
reports through the real renderer. A primary click on any rendered dock row
dispatches the registered `/agents` command; a drag, wheel gesture, or
middle/secondary button reaches neither the menu nor the editor. Unit coverage in
`tests/agent-activity-surface.test.ts` pins the exact command dispatch
(`/agents` with template expansion), the informational dock without a menu
action, and the gesture boundary.

Run only the relevant presentation suites:

```sh
node --test tests/agent-activity-surface.test.ts tests/agent-activity-dock-pointer-fullscreen.test.ts
npm run typecheck
```

This exercises the same fullscreen renderer boundary as the selector, not a manual
terminal session.
