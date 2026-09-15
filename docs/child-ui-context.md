# Child UI context

Every non-Owner ordinary Agent and Moderator runs in a fresh Pi CLI process with a real pseudoterminal. The child owns one `AgentSessionRuntime`, one `AgentSession`, one fullscreen `InteractiveMode`, and the live session JSONL. Its extension context is truthful: `ctx.mode === "tui"` and `ctx.hasUI === true`. During public TUI session binding, the Runtime Bridge associates Pi's public Runtime registration with the exact `SessionManager`. A zero-line extension widget receives and retains Pi's stable public `TUI` reference for physical presentation handoff.

The Owner process remains the Workflow authority. It owns scheduling, retention, Requests, Messages, Operational Incidents, child process supervision, and the physical human attachment.

## Per-Agent presentation

A child process owns its transcript components, editor, footer, statuses, widgets, notifications, selectors, dialogs, commands, shortcuts, tools, pending state, and focused overlays. Extension UI calls affect only that process. Child theme state, extension globals, signal handlers, listeners, and environment mutation cannot alter the Owner process or another Agent.

Process-local UI state is isolated, but user preferences are shared. Every Runtime uses the same Pi user configuration: an explicit preference action in a selected child view persists exactly as it would in the Owner view, while the model, explicit thinking level, and resources chosen during Runtime Preparation remain launch inputs and must not change those preferences. A Moderator without a Template model selection leaves thinking unset so Pi reads that shared default without copying the Owner's effective level. See [ADR 0001](adr/0001-share-pi-user-configuration-across-agent-runtimes.md).

The child TUI writes ANSI output to its PTY. The child environment declares `TERM=xterm-256color` and `COLORTERM=truecolor`, matching the owned xterm.js terminal's indexed- and 24-bit-color support rather than inheriting the Owner terminal's capability declaration. Startup diagnostics may use `@xterm/headless` before admission. Once admitted, a hidden child stops native rendering and bypasses background terminal parsing; its native Pi component and session data remain authoritative. While selected, the Owner suspends its own TUI and forwards the child's raw PTY output directly to the physical terminal; physical input, paste, mouse bytes, terminal replies, and resize travel directly between that terminal and the selected child PTY. Structured coordination never enters terminal traffic.

Opening an Agent view attaches the Workflow-global human attachment to the existing process projection and asks the child to resume its native TUI. Handoff output and physical input remain buffered until native presentation is ready, then Pi's ordered native output establishes the alternate-screen, mouse, paste, keyboard, cursor, and complete redraw state required by the physical terminal. If the physical output sink applies backpressure, the Owner pauses and resumes the selected child PTY instead of accumulating an unbounded live-output queue. Returning to Owner resets the physical terminal, restarts the exact mounted Owner TUI, and forces a complete Owner redraw. This does not rebind the Owner session or copy child UI state into the Owner TUI. Closing the view removes `interactive_selection` retention. A retained child process can continue running while unselected; an eligible settled Runtime exits and later work creates a fresh process from a newly resolved launch specification.

## Visibility lifecycle

- **Preparing:** the currently visible Owner or child keeps rendering, including selector loading feedback, while the next Runtime prepares.
- **Taking over:** the attachment transfers physical input/output ownership, resumes the replacement with public `tui.start()`, and requests a complete current frame with `tui.renderNow(true)`. Native startup negotiates keyboard/display capabilities with the terminal that owns replies.
- **Hidden:** public `tui.stop({ preserveScreen: true })` stops rendering and terminal input handling, not the session. Model work, IPC coordination, transcript persistence and extension UI-data updates continue. PTY output remains drained, including residual OSC progress metadata, without feeding a continuously updated cell grid.
- **Returning:** the existing native transcript, widgets, editor and overlays redraw at current dimensions. Hiding and showing do not restart the session or replay extension startup. Selection and cleanup do not reconstruct an offscreen terminal.

Hidden terminal input and interactive terminal queries are not a coordination channel. An extension that explicitly requests terminal state while hidden cannot assume a reply; interactive terminal negotiation belongs to startup and physical attachment. There is no generic hidden-query responder. Terminal dimensions are available independently of diagnostic screen snapshots, so resize checks do not allocate a cell grid.

## Child `/agents`

The Runtime Bridge registers `/agents` inside every process child. It requests a scoped selector snapshot from the Owner containing the live and dormant roster, selected Agent, Human Attention, and Operational Attention. The child renders the normal selector through its own `ctx.ui`.

Selection remains authoritative in the Owner:

- pressing `o` closes the active attachment without terminating the child Run;
- selecting another Agent retargets the same attachment to that Agent's PTY projection;
- selecting the current child closes the selector and keeps the attachment;
- cancellation leaves the current attachment unchanged;
- stale Human Attention or focus failure restores the previous selection.

Input and resize continue through the newly selected projection after retargeting. Escape remains child UI input and is not repurposed as a hidden return key.

## Runtime preparation and Run admission

Before ordinary child or Moderator preparation, a bounded fresh Node probe checks
the installed bootstrap schema and protocol version against the Owner's contract.
Low-level launch rechecks before allocating process resources. An incompatible or
unverifiable contract blocks that factory's launch path for its remaining lifetime,
preventing repeated failed launches and Moderator diagnosis through the same path.
Diagnostics distinguish version mismatch from schema drift and identify affected
fields without exposing descriptor values or connection tokens. All rejection
paths use the shared `CHILD_LAUNCH_ALIGNMENT_GUIDANCE` in
[the bootstrap contract](../src/control/control-protocol-schemas.ts).
The probe is not an atomic installation lock and does not terminate existing Runs.

Only Agent Identity or Moderator Input bootstrap evidence commits before process launch. Child Identity and Moderator Input commit their captured `creationPreset` atomically with the rest of their bootstrap. The Owner dynamically resolves the current parent configuration, captured creation rules, canonical explicit spawn input, resources, trust, native project context-file loading, and explicit system prompt into a volatile launch specification; it never re-selects the original Template name. It materializes the bootstrap evidence to the exact session JSONL, drops its staging writer, and launches the exact installed Pi CLI with the prepared cwd, model, thinking, startup tool selection, skill paths, file-backed extensions, explicit system prompt artifact when configured, trust decision, and session path. Admission requires the resolved tool selection to match the initial active set, regardless of order. After admission, extensions may change active tools through normal Pi behavior. The launch specification uses native loading of trusted project instruction files such as `AGENTS.md` and `CLAUDE.md` when `loadContextFiles` is true, and passes the explicit child system prompt with its independent `systemPromptMode`. A replacement child can disable native context files with `loadContextFiles: false`. The launch specification is not transcript evidence and is resolved again for every successor Runtime.

The process may be prepared before model work. Extension `session_start` behavior remains native: dialogs and overlays can appear before Run admission, and extension-emitted user input activates work normally. Prompt acceptance is not settlement; the Owner changes Run state only from the awaited child lifecycle and durable transcript evidence, with `agent_settled` as the authoritative settlement boundary.

Control and presentation become available before startup completion so an inherited startup handler can await terminal input or a dialog without deadlocking admission. The bridge applies the initial tool selection once through Pi's public activation API before inherited startup handlers run. It does not use Pi's CLI tool filter, which would also restrict later tool registration and activation. The final input extension signals startup completion only after the inherited handlers settle; admission validates that final snapshot, including asynchronous startup changes. Early `runtime.ready` therefore means Control/presentation availability, while `runtime.startupComplete` supplies the snapshot used for final launch readiness. Reload does not reapply the initial selection. Startup interaction remains subject to the configured startup timeout.

A startup cancellation owns the exact process group. If graceful child shutdown cannot complete, the Owner force-kills the process group and waits for exact PTY exit. A pre-admission kill is not required to emit Pi `session_shutdown`; process exit and artifact cleanup are the authoritative evidence.

## Isolation from the physical pane

Children inherit ordinary provider, proxy, locale, and home-directory environment, but never inherit `HERDR_ENV`, `HERDR_SOCKET_PATH`, or `HERDR_PANE_ID`. A file-backed Herdr extension may load in the child, but without physical-pane ownership it remains inert. Only the Owner reports lifecycle state for the Herdr pane.


## Measurement and regression evidence

Run `node benchmarks/visible-native-rendering.ts` to measure four concurrent real Pi children with the offline provider, comparing all-hidden work with one physically attached view. `PI_VISIBILITY_BENCHMARK_CHILDREN` and `PI_VISIBILITY_BENCHMARK_DELAY_MS` control workload size; `PI_VISIBILITY_BENCHMARK_ARTIFACT` selects the evidence directory.

The benchmark records native widget render calls, drained PTY bytes, persisted responses, IPC round trips and parent event-loop gaps. The latter two are Owner-process responsiveness proxies, not human terminal latency. Startup/attachment activity is excluded from workload counters. Measurements are observations, not regression thresholds or a before/after speedup claim. The rendering probe writes stats synchronously, adding measurement overhead to visible render work.

Regression tests keep structural assertions separate: hidden work settles and persists, background frames stay unchanged, and fresh physical displays show current native state after repeated reattachment. Startup diagnostics and terminal-emulation test utilities remain supported without continuous hidden rendering.
