# Agent selector and view

`/agents` first opens a centered, bounded roster overlay, leaving the surrounding chat visible and updating. The framed selector is at most 80 columns wide, stays within the terminal height, and shows at most ten roster rows at once. All tabs share the same terminal-bounded height, including empty tabs: shorter content is padded inside the frame, with space reserved for details, section headings, and the scroll indicator. Only terminal resizing changes that height. Pi's native `SelectList` supplies roster rows and scrolling; the selector keeps keyboard focus linear and renders the Agents breadcrumb and Owner footer outside the scrolling rows. `/agents owner` trims its argument and returns directly to the exact mounted Workflow Owner presentation without opening the selector; it is a harmless no-op when Owner is already mounted. Other arguments fail with `Usage: /agents [owner]`.

Enter on an Agent body opens that durable Agent's full-window interactive view. Selecting the already-mounted participant simply closes the selector without reopening or replacing its view. The Owner's native runtime session, services, diagnostics, transcript container, editor implementation and text, footer, and extension UI context remain mounted underneath. The fixed `Go to Owner [o]` footer above the help text is focusable from any tab and every Live scope. Enter on it (or the global `o` shortcut) returns to that exact existing Owner presentation; Owner is a global destination rather than a roster entry.

The mounted participant’s label is bold with an immediately attached `*` (`Builder*`) in either roster; mounted Owner uses `Go to Owner* [o]`, with only `Owner*` bold. This marker stays with the mounted identity as keyboard focus, tabs, and Live scope change. Focus and status styling remain independent; breadcrumbs, tabs, and report entries are not marked.

Agent selection prepares the target mode before dismissing the roster. The focused row shows an animated loading indicator throughout preparation. When switching between children, the current selector keeps rendering until the replacement frame takes over; the previous Runtime remains retained through the handoff. The selector retains keyboard focus during asynchronous preparation and ignores further selector input until the handoff completes. Its rendered rectangle blocks pointer fallthrough inside the panel. Outside the panel, Pi retains its native pointer behavior: clicks or wheel events can reach the underlying UI, and a click may move keyboard focus there. Pi 0.85.1 couples pointer blocking to painted overlay bounds; the selector does not blank the chat to create a full-screen input shield.

### Focus stability during roster updates

When an automatic roster update moves the focused Agent between Live and Dormant, its row stays in its current list position and tab until focus moves away. Its status and details still update: an `ending` Agent can therefore become `dormant` while remaining focused in Live, and Enter still opens that same Agent. Repeated refreshes do not replace it with Owner or a sibling.

Moving focus away, changing tabs or browsing scope, or closing the selector releases this temporary row retention. Navigation chooses its destination before removing the retained row, so removal does not skip a neighbor. If the Agent disappears from both rosters, ordinary focus fallback applies instead. This is presentation-only retention of the focused row, not the mounted Agent: it neither retains a Runtime or Run nor delays dormancy.

## Replay and admission

Opening the selector, including from another Agent, and returning to Owner use
the existing admitted Workflow projection. These navigation paths do not require
a fresh transcript replay. Ordinary lifecycle updates still update the roster
and Reports; navigation is not a recovery or `workflow_resume` operation.

Invalid historical Request/Answer record shapes are skipped and marked under
[skip-and-mark replay](coordination-replay-rejection-design.md), not treated as
failed Workflow admission. The existing verified participants remain navigable,
including Owner ↔ Moderator switching, without creating a repair participant or
resending rejected work. Selection alone does not start a model turn.

Genuine identity or bootstrap failures still refuse coordinator-backed
navigation: no Agent rows or membership are fabricated. The native Owner view
stays mounted, and `/agents diagnostics` remains available independently of the
failed coordinator. See [Owner blockage diagnostics](owner-blockage-diagnostics.md).
There is no repair bootstrap or repair writer-pause mechanism in this navigation
path.

## Pointer controls (fullscreen)

Pi's public fullscreen mouse routing supplies parsed events and component-local cell coordinates. The selector uses that API (verified with Pi 0.85.1), not terminal escape decoding or private overlay geometry. Regular terminal mode remains keyboard-only.

- Primary-click **Live**, **Dormant**, or **Reports** to switch tabs.
- Text buttons use unbracketed labels, with the Owner shortcut shown as `[o]`; spacing separates neighboring actions, and brackets in participant-provided labels remain unchanged.
- Click **Go to Owner [o]** to return to Owner and close. Click the Live **Agents** heading to return to the top-level list inside the menu; at root, this heading is a no-op.
- Click anywhere in an Agent summary's content area outside the trailing child control to open the Agent. The complete **N children ›** control browses children instead.
- Wheel over roster rows, spacing, or the scroll indicator to browse the visible roster window without changing the selected Agent or its details. Clicks and arrow/`j`/`k` keys select as usual; wheel at either bound is inert.
- Click a visible ancestor breadcrumb to browse that scope, preserving focus on the child along the previous path. Click the current scope segment to browse up one level, preserving focus on the current scope Agent; this is the same action as Left/h. The omitted **…** and partially clipped controls are informational.
- Attention summaries use their existing selection actions. Agent detail lines remain informational.
- Hover adds the theme’s neutral `userMessageBg` tint while preserving existing text colors. Keyboard selection uses the stronger `selectedBg` and wins when the selected control is also hovered. Agent-body highlighting ends at the separate child button; hovering that button colors only the button. Neither layer colors details, frame margins, or neighboring controls. Custom themes control the contrast between these background tokens. It never moves keyboard focus. Pi does not send a leave event when the pointer exits the overlay, so the last highlight can remain until another selector pointer or keyboard event. Middle and secondary buttons have no selector action.
- Tabs, Agents/path, Owner footer, details, borders, and help do not scroll the roster or the mounted editor. Wheel events outside the overlay follow Pi’s underlying UI behavior.

These controls apply only to `/agents`. The above-editor activity dock adds one pointer action of its own: a fullscreen primary click on any rendered dock row opens this same menu, while drags, wheel gestures, and non-primary buttons keep Pi's native behavior. Resize rebuilds the visible hit regions together with the panel; clipped and offscreen controls are not actionable.

## Live roster

Live uses one linear, non-circular focus order: Attention items, scoped Agent bodies, then the fixed Owner footer. Up on the first item and Down on the last item stay put.

- **Attention Inbox** contains Owner-visible Human `DECIDE` and unread Moderator or runtime `REPORT` items. Report rows open the dedicated report view described below. Terminal Run failures, failed Moderator attempts, and moderation unavailability use acknowledgeable Reports plus separate live status, not competing `ATTENTION` rows for the same incident. A `DECIDE` row identifies the requesting Agent and shows a bounded one-line question preview. The first attention item receives initial focus. Selecting `DECIDE` opens that Agent's full-window view at its pending request and focuses its native editor.
- **Scoped Agents**, below `Agents` and the current path, contains the current scope's direct ordinary children with a current Run, plus Dormant ancestors needed to reach those Agents at any depth. Current-Run children retain creation order; retained Dormant ancestors follow in roster recency order. Live Moderators appear at the Owner scope as standalone participants. Each row uses the human-facing work status: `active`, `compacting`, `idle`, `waiting` with its reason, `starting`, `ending`, or `dormant`.

Without Attention, initial focus prefers the selected non-Owner Agent, then the first Agent in scope, then Owner. Opening from Owner therefore starts on the first available Agent.

Agent bodies and hierarchy browsing are separate actions: Enter opens the Agent; Right Arrow or `l` activates its trailing `N children ›` control. Child controls add no extra Up/Down focus stop. A participant with no children in the Live roster has no child control, even if it has Dormant children. Live includes starting, idle, waiting, active, and ending Runs, not only children doing active work. Dormant ancestors retain their Dormant status and styling, can be opened normally, and can be expanded without preparing their Runtime or resuming work. Their child counts include the retained paths. Roster updates recompute these paths as Runs start or end.

Clicking **Agents** from a nested Live scope refocuses the previous top-level ancestor when available, otherwise the first root Agent. Right Arrow or `l` browses the focused Agent’s children, not the Owner footer. Left Arrow or `h` returns to the parent scope and refocuses the Agent along the previous path.

The Agents/path line stays visible while the roster scrolls, below any visible Attention rows. All breadcrumb segments use the same separator: `Agents › Architecture › Research`. Breadcrumbs retain at most the newest three Agent scopes and replace older segments with informational `…` as width tightens, preserving Agents and prioritizing the current scope. At widths too narrow for the current label, that label is truncated.

Opening a live Agent view attaches its Agent Runtime's complete Pi mode. `interactive_selection` retains that Runtime without itself admitting or prolonging a Run. Run failure or ordinary termination may end the exact Run while keeping a ready Runtime and view attached, leaving the Agent Dormant. Termination that wins during Runtime initialization instead cancels the unusable Runtime and closes its view without waiting for startup UI. Returning to Owner or switching Agents removes Runtime retention; an unselected Dormant Runtime is then disposed, while live work follows ordinary Run retention.

## Dormant roster

Dormant has an **Agents** heading and the shared **Go to Owner [o]** footer. Below the heading is a flat list of verified ordinary Agents and Moderators in fully Dormant branches: neither the Agent nor any descendant has a current Run. Dormant ancestors already retained in Live are not duplicated here. It follows Pi resume recency: latest user or assistant activity, then native session creation time. Moderator rows include their role and compact trigger description.

Selecting a Dormant Agent prepares its ordinary configured Agent Runtime over persisted evidence. The same session supplies its configured startup tool selection, extension-controlled active tools, extensions, editor, footer, commands, shortcuts, and extension UI before and during later work. Selection itself does not admit a Run, initialize Run-scoped Request relationships, invoke the model, or append transcript evidence; observation remains `phase: "dormant"`.

The selector keeps focus while the Runtime is prepared. Its mode is attached before `session_start` UI settles, so startup dialogs remain operable. Extension lifecycle behavior is not filtered: `session_start`, slash commands, shortcuts, and other extension actions keep their normal semantics, and any resulting Agent work activates a Run in this same Runtime. UI-only commands leave the Agent Dormant. Editor input and ordinary coordination Delivery likewise activate the same Runtime without replacing its projection or replaying `session_start`. Closing, switching, or Workflow shutdown cancels pending initialization and disposes a never-activated Runtime after removing selection retention.

If a Dormant Agent's current configured Runtime cannot be prepared before any usable projection exists, selection opens an Owner-hosted read-only post-mortem view over one coherent snapshot of that Agent's durable active transcript. Acquisition is single-pass: a successful prepared Runtime is used directly rather than probed and reopened. The file-backed snapshot parser migrates only an in-memory clone, so opening legacy or empty evidence cannot rewrite it. Before native text components receive the snapshot, all evidence-derived strings are stripped of terminal controls and image payloads are disabled. The fallback admits no Run, creates no Runtime or retention, appends no evidence, and does not mark the durable Agent failed. It shows the preparation error separately from the transcript. For child-origin selection, the Owner temporarily resumes its TUI while preserving the exact selected child projection for restoration; Control carries only a bounded outcome and no transcript path or contents. Up/Down, `j`/`k`, or the mouse wheel scroll one line, Page Up/Page Down scroll one page, Home/End jump to the boundaries, `a` opens `/agents`, and Escape or `q` restores the exact previously mounted Owner or Agent presentation.

## Full-window Agent view

The attachment adds no fixed header. It suspends Owner rendering and presents the selected child PTY directly, so the physical terminal receives the child mode's complete native Pi fullscreen output: transcript, pending and working state, tool rendering, widgets, editor, footer, notifications, selectors, dialogs, and child-local extension overlays.

A scoped activity dock lives inside the native above-editor widget area. For a selected non-Owner Agent, its first row is `label · compact Agent ID · status`; the label is accented and bold, the identity is dim, and only the status receives its semantic status color. Rendered statuses are lowercase: `dormant` when no exact Run exists, `active` while a Run executes work, `idle` when a current Run is settled, `waiting` with a named reason when progress needs human input, an Agent answer, or resumption, and `starting`, `ending`, or `failed` during those lifecycle conditions. While the selected Agent awaits a Human Answer, the dock also shows `ANSWER · Enter submits` directly above the unchanged native editor.

With Owner selected, the dock shows the Owner-only Attention Inbox before Owner's direct children that have a current Run. With another Agent selected, it shows only that Agent's identity and direct children that have a current Run. Starting, live, and ending child rows stay in creation order and project Run state, attention, model/thinking configuration, and queued-input count. Each dock section shows its first three rows; when more exist, a final dim `… N more` row reports the hidden remainder. Dormant Agents remain available through `/agents` but do not appear in the activity dock. Human `DECIDE` and unread Moderator or runtime `REPORT` items occur only in the Owner dock; `/agents` retains every attention item and its existing action. The Owner dock and shared `/agents` selector show `Moderation Unavailable · live status` or `Operational incident unresolved · live status` outside the inbox while the corresponding condition continues, even after its Report is marked read.

All input is routed directly to the selected child PTY. Printable text, paste, completion, commands, extension shortcuts, custom editors, and focused child overlays behave as they do in native Pi. The attachment does not steal Escape; custom editors such as pi-vim keep their normal Escape semantics.

`/agents` remains available inside the child mode:

- press `o` to return to the exact mounted Owner presentation;
- select another Agent to retarget the same full-window attachment without exposing the Owner editor; or
- select the current Agent to close the selector and keep the exact existing mode.

Pi's fullscreen transcript viewport and editor dock coexist. Page Up/Page Down, Home/End, configured prompt navigation, and mouse scrolling move the transcript while the editor remains available. At the tail, new output follows automatically. Scrolling away preserves the inspected region until the native end action restores tail following. Resize updates the selected PTY and lets the child TUI reflow its complete native frame within the available rows.

A terminally failed selected Run leaves the same Agent Runtime and full-window view in place while the Agent becomes Dormant. The failed transcript remains visible. Explicit input, extension effects, or ordinary coordination may activate a successor in that Runtime without replacing the projection. Switching or Workflow-driven disposal settles the attachment once, removes Runtime retention, and restores the untouched Owner when appropriate.

## Focused roster details and keys

The focused roster row reserves four detail lines:

1. optional description;
2. full Agent identity;
3. Dormant or current Run semantics with compact Retention Reasons;
4. provider/model, thinking level, and queued-input count.

An absent description leaves its line empty, keeping the overlay height stable as focus moves. On very short terminals, detail lines are trimmed only as needed to keep the focused summary, Owner footer, and frame visible.

- Tab or Shift-Tab: cycle Live, Dormant, and Reports
- `o`: return to Owner
- Up/Down or `k`/`j`: move linearly through Attention, Agent bodies, and the Owner footer; stop at both boundaries
- Right or `l`: activate the focused Agent's trailing child control
- Left or `h`: return to the parent Live scope and refocus the previous path
- Enter: perform the focused body or Owner action
- Escape: close the selector

## Reports

Unread Moderator defect reports and runtime-authored failure reports appear in the Attention Inbox. Enter opens a dedicated read-only report, without selecting or restarting an Agent. Tab to **Reports** for retained history. **m Toggle read** toggles the selected report in either the Attention Inbox or Reports tab, keeping the menu open. Marking read removes the inbox row and advances focus to its next neighbor; Reports retains the selected entry as Read. Marking unread restores its Attention Inbox entry. The separate Read/Unread status shows the current state, and the same shortcut works inside the report view. Only marking a report read acknowledges it; opening, copying, closing, or **View reporter** does not. **Copy report** produces ticket-ready Markdown. **View reporter** selects the captured stable Moderator identity and is absent for runtime Reports, which instead retain the exact runtime diagnostic reference. See [Operational Incident moderation](operational-incident-moderation.md#nonblocking-runtime-defect-reports) for provenance and navigation semantics.

Runtime Reports explain terminal Run failures, including those without obligations, as well as failed moderation. They capture affected Agents and Request evidence, the observed error and stage, known Moderator attempts, and remaining uncertainty. If inspection established no incident, the report says so. Marking read does not clear the live fault, retry anything, or imply recovery. A continuous fault publishes only once; distinct failed Runs remain separate. Failed Moderator attempts and later recovery observations appear as dated findings beneath their original incident Report, included in the read-only view and copied Markdown. A new retained finding marks the same report unread again; duplicate findings do not. Mark read acknowledges all currently recorded findings. Reopen the report to see findings added since it was opened.

The Reports tab uses only its History heading, with the same Owner footer above help. Down from the final item focuses the footer; Up returns to the final item, and Enter opens Owner. Empty tabs focus the footer directly.
