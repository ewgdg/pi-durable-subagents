# Human Requests

Any spawned ordinary Agent or Moderator can call `ask_user` to ask the human one free-form question and block its current Run until the native tool call succeeds or is interrupted. The Workflow Owner does not have this tool.

```ts
ask_user({
  question: "Which boundary should remain authoritative?"
})
```

The question must contain non-whitespace text. Each Agent may have at most one unresolved Human Request, while different Agents may wait independently.

A successful Human Answer contains one nonblank free-form text value:

```json
{
  "requestId": "...",
  "answer": "Keep the native Pi boundary."
}
```

## Transcript presentation

The committed tool call renders in the requesting Agent's transcript as a full-width message-like row. The complete question is Markdown-rendered and wraps with the native transcript; it is not truncated to fit a modal surface.

While waiting:

```text
[Ask User]  waiting

Which boundary should remain authoritative?
```

After successful commitment, the canonical tool result renders as a visually separate user-style block:

```text
[Ask User]

Which boundary should remain authoritative?

[Answer]

Keep the native Pi boundary.
```

The question and Answer remain one native Tool Execution internally. The presentation appends no synthetic Message or custom transcript entry.

An interrupted request retains its question and renders the canonical error result separately:

```text
[Interrupted]

Human request interrupted before an answer was provided.
```

A non-user fence renders its actual failure text instead. Failed requests never render an `[Answer]` block.

## Attention and navigation

A background Human Request never changes views or takes focus. It adds one passive row to the Owner-scoped Attention Inbox:

```text
DECIDE  Agent label · Which boundary should remain authoritative?…
```

The row contains a bounded one-line question preview. Selecting it closes the roster, opens the requesting Agent's full-window view at the latest transcript position, and focuses that Agent's native editor. The request remains pending if the human switches to Owner or another Agent.

## Herdr attention

When Herdr's Pi integration is installed, the first pending Human Request immediately reports `blocked` with “An agent needs your input.” Other Agents may continue working: this state means human input is pending, not that all autonomous work has stopped. Herdr's status, state-based waits, and configured request notifications use that semantic blocked state.

The root Pi session emits one `herdr:blocked` activation for the whole pending-question episode. Additional questions or worker activity do not emit additional activations. It clears after the last successful Answer commits, or when the final question is interrupted or its Run is fenced. Submitted Answers remain pending until native result commitment; fenced calls do not keep the notification active while their error results finish committing.

This is a thin event adapter, not a Herdr CLI integration. With no Herdr listener, the events are harmless. It does not wake the Owner, fabricate Pi settlement, change `agent_wait` results, or affect passive parking. It observes coordination Human Requests, not generic Pi UI prompts (selectors, editors, or custom dialogs) or unrelated third-party question tools.

Shutdown releases only this adapter's activation and removes its subscription. Resource reload clears the old binding and reconstructs attention from the retained workflow after all extensions finish `session_start`; host loss does not resurrect historical questions. Herdr owns notification delivery and preferences, including presentation of a restored blocker after reload.

## Answer mode

A selected Agent with an unresolved Human Request shows one compact line above its native editor:

```text
ANSWER · Enter submits
```

The Human Request does not replace the editor, install a special editor, or alter its current draft. The human may keep, edit, delete, or copy the existing text. The primary Enter submission adopts the complete nonblank editor text as the Human Answer instead of queuing an ordinary Agent Message. Native multiline editing remains available.

Alt+Enter retains Pi's native follow-up behavior and leaves the Human Request unresolved. This path also retains skill and prompt-template expansion, allowing expanded input to be queued for later without answering the request. Built-in and extension commands retain their native behavior because Pi dispatches them before Answer adoption. All other primary-Enter text is submitted literally as the Answer, including recognized skill or prompt-template invocations and unrecognized slash-prefixed strings.

Human Answers are text-only. A submission containing images is rejected without resolving the request. Blank, image-bearing, stale, fenced, or otherwise rejected submissions restore their submitted text to the editor and report the reason, allowing correction and retry. A successful submission clears through the native editor path.

Human Request handling does not capture Escape. The default Pi editor may abort the blocked Run, while custom editors retain their own Escape semantics. Context-switching commands remain available without being treated as Answers.

## Commitment and scheduling

The committed `ask_user` call is the Human Request. Its matching successful native tool result is the sole Human Answer. Editor submission is only a candidate: `input_required` attention remains until that exact result is present in the transcript.

The tool runs sequentially, so later sibling calls wait for the Answer or interruption. Steer Messages wait for successful Answer commitment. Deferred and follow-up Messages wait until the answered turn settles. Other Agent Messages cannot answer a Human Request.

A Run fence after submission but before result commitment defeats the candidate, records the matching native error result, and restores the submitted text when the interactive editor remains available. A committed Human Answer remains canonical if the Run subsequently fails.

## Availability and lifetime

Human Requests require an interactive TUI with an available Agent editor. Without one, the tool call fails before establishing `input_required` attention; the system never admits a request the human cannot answer. In a [headless Workflow](owner-workflow.md#headless-workflows) no Agent is given `ask_user` at all.

Human attention, Answer mode, and uncommitted editor state are volatile. They are not reconstructed for a successor Run or after host loss. The Pi transcript remains authoritative for the committed Human Request and any terminal native tool result.
