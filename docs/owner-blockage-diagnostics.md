# Owner blockage diagnostics

Invalid historical coordination record shapes do not block Owner admission. Replay skips their protocol effects, preserves the source evidence, and marks their projected call/result groups with `!`. Valid obligations remain, and `/agents` navigation stays available through the ordinary admitted Workflow. See [skip-and-mark replay](coordination-replay-rejection-design.md).

When required identity, membership, or other strict bootstrap evidence fails protocol validation during Owner admission, ordinary coordination stays disabled in that attachment. Pi and its editor remain usable. The extension retains the failure independently of the coordinator and shows a persistent warning-colored box above the editor:

> ⚠ Subagent coordination blocked
>
> Saved coordination data is invalid; the protocol may have changed.
>
> /agents diagnostics

This is a genuine admission failure, not an ordinary rejected coordination record. Identity, membership, and bootstrap validation remain strict; the Owner boundary contains known protocol failures, attempts partial-coordinator cleanup without disposing the native Pi session, and does not publish a healthy coordinator. Unrelated configuration and unsupported-role errors are not reclassified as invalid saved protocol data.

## Inspecting the failure

Run `/agents diagnostics` from the Owner presentation. After a genuine admission failure, plain `/agents` reports “Subagent coordination is unavailable. Use /agents diagnostics.” It does not invent a roster or open diagnostics implicitly. `/agents owner` cannot bypass failed admission or enable coordination tools; the native Owner presentation remains mounted.

The read-only panel fills the terminal viewport, including blank space below short content, with its controls pinned to the bottom. It starts with **Problem**, **Impact**, and **Recovery**. It explains the underlying validation reason when retained, identifies the failure as the first encountered problem rather than a complete audit, and distinguishes disabled local coordination from the unknown state of other processes. A protocol version change is a possible explanation, not an asserted cause.

- **t** opens technical details: validation stage, Agent ID, transcript path, available entry/tool-call pointers, full error stack and causes, and any cleanup failure.
- **s** returns to the summary.
- **↑/↓**, **j/k**, mouse wheel, **PgUp/PgDn**, and **Home/End** scroll the current view.
- **Esc** or **q** closes the panel and returns to the editor. Closing diagnostics does not dismiss the blockage widget.

The panel does not append diagnostics to model conversation history. Terminal control sequences in evidence are stripped for display. The original error remains in memory for the current extension attachment; reopening or reloading reconstructs diagnostics if admission fails again. A successful admission clears the blockage widget. With no recorded failure, diagnostics explicitly says that this is not an exhaustive Workflow audit.

## Recovery availability

Native `/fork` preserves selected conversation in a fresh independent Workflow, and `/clone` copies the active branch, even after coordination admission fails—provided bootstrap successfully established the source as an Owner before the failure. Diagnostics explains this condition; failed or incomplete role identification explicitly refuses fork. Child Agents and Moderators still cannot fork. Native `/new` remains available for a clean Owner session.

The fork appends a fresh Owner Identity cutoff only in the new session. Copied Messages, Requests, deliveries, and child relationships remain conversation context but grant no authority, pending obligations, or automatic continuation. The original transcript is unchanged and remains available for inspection. See [Owner fork and clone](owner-workflow.md#owner-fork-and-clone). Fork does not edit historical Messages or accept obsolete protocol shapes.

Startup, in-process session resume, and repeated failed-admission `/reload` use the same blockage surface. Unlike a chat-only notification, the widget remains outside restored conversation history. Its border and heading use the theme’s warning foreground; the explanation uses regular text. Available commands share a compact dim hint row without descriptions; action explanations stay in diagnostics. The widget does not replace the editor. Previously healthy Workflows also revalidate on Owner resource reload, using fresh projections under the newly loaded code. See [reload revalidation](cold-host-recovery.md#owner-resource-reload). Resource reload is not transcript repair.

Partial-recovery quarantined-Agent warnings remain separate from whole-Owner blockage. Their availability claim is emitted only after Owner initialization succeeds.

`/agents repair` is a separate recovery path for supported actual transcript
admission failures, initially redundant exact duplicate Delivery envelopes.
Healthy admitted Workflows and rejected-record-only histories need no repair.
Persisted Owner identity and clean writer retirement must be verified; invoking
the command authorizes the attempt without another prompt. Rejected history
stays unchanged. It cannot override failed cleanup or repair policy/model configuration. See
[repair operations](workflow-repair-operations.md) and the
[validation and recovery contract](workflow-transcript-repair-design.md).
