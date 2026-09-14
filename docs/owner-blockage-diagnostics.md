# Owner blockage diagnostics

When saved coordination evidence fails protocol validation during Owner admission, ordinary coordination stays disabled in that attachment. Pi and its editor remain usable. The extension retains the failure independently of the coordinator and shows a persistent warning-colored box above the editor:

> ⚠ Subagent coordination blocked: saved coordination data is invalid; the protocol may have changed.
>
> /agents diagnostics — inspect the failure and recovery availability

This is an admission failure, not permission to skip invalid evidence and resume coordination. Core protocol validators still throw; the Owner boundary contains known protocol failures, attempts partial-coordinator cleanup without disposing the native Pi session, and does not publish a healthy coordinator. Unrelated configuration and unsupported-role errors are not reclassified as invalid saved protocol data.

## Inspecting the failure

Run `/agents diagnostics` from the Owner presentation. When blocked, plain `/agents` reports “Subagent coordination is unavailable. Use /agents diagnostics.” It does not open diagnostics implicitly.

The read-only panel fills the terminal viewport, including blank space below short content, with its controls pinned to the bottom. It starts with **Problem**, **Impact**, and **Recovery**. It explains the underlying validation reason when retained, identifies the failure as the first encountered problem rather than a complete audit, and distinguishes disabled local coordination from the unknown state of other processes. A protocol version change is a possible explanation, not an asserted cause.

- **t** opens technical details: validation stage, Agent ID, transcript path, available entry/tool-call pointers, full error stack and causes, and any cleanup failure.
- **s** returns to the summary.
- **↑/↓**, **j/k**, mouse wheel, **PgUp/PgDn**, and **Home/End** scroll the current view.
- **Esc** or **q** closes the panel and returns to the editor. Closing diagnostics does not dismiss the blockage widget.

The panel does not append diagnostics to model conversation history. Terminal control sequences in evidence are stripped for display. The original error remains in memory for the current extension attachment; reopening or reloading reconstructs diagnostics if admission fails again. A successful admission clears the blockage widget. With no recorded failure, diagnostics explicitly says that this is not an exhaustive Workflow audit.

## Recovery availability

Transcript repair and context-preserving Owner forking after blocked admission are not available in this build. Diagnostics therefore does not advertise `/agents repair` or `/fork` as working recovery actions. Keep the original session and inspect the retained evidence before planning repair. This feature does not edit historical Messages or accept obsolete protocol shapes.

Startup, in-process session resume, and repeated failed-admission `/reload` use the same blockage surface. Unlike a chat-only notification, the widget remains outside restored conversation history. Its border and wrapped text use the theme’s warning foreground; it does not replace the editor. Revalidation of a previously healthy running coordinator after an extension upgrade is separate work; resource reload alone is not transcript repair.

Partial-recovery quarantined-Agent warnings remain separate from whole-Owner blockage. Their availability claim is emitted only after Owner initialization succeeds.
