# Run supervision

Workflow Owners, Direct Spawners, and Moderators can inspect and control authorized Agent Runs without changing Agent identity or the Workflow tree.

## Authority

The Workflow Owner may observe and control any verified non-Owner Agent. A Direct Spawner may observe and control only its immediate children. A Moderator may observe any known Workflow Agent and control any current non-Owner Run. An Agent may observe itself, but cannot control itself; a Moderator also cannot control the Owner Run. Knowing an Agent identity or exchanging Messages does not grant supervision authority.

`agent_observe` supports single-Agent status lookup or bounded search:

```json
{
  "operation": "status",
  "agentId": "child-agent-id"
}
```

For `status`, `agentId` accepts a full Agent ID, a unique Workflow-wide ID suffix, or an exact case-sensitive label. Full IDs take precedence over suffixes, then labels; ambiguous selectors fail rather than selecting an arbitrary Agent. Labels resolve only within the caller's observation scope: the Owner and Moderator can use any verified Workflow Agent's label; ordinary Agents can use their own and their direct children's labels. ID lookup does not bypass these permissions. Omit `agentId` to observe yourself. Unlike Message addressing, status labels do not include an ordinary Agent's Direct Spawner.

Quarantined identities still participate in ID matching. When quarantined label evidence prevents proving uniqueness, use a verified full ID instead. Lookup errors display their actual diagnostic, not a successful `observed` receipt. Observation never starts an Agent Run or prepares its Runtime.

```json
{
  "operation": "search",
  "scope": "authorized",
  "query": "review",
  "phase": "dormant",
  "limit": 20
}
```

Search scope is required:

- `"authorized"` searches the caller's complete existing observation set. The Owner and Moderator see every verified Workflow Agent; an ordinary Agent sees itself and its direct children.
- `"direct_children"` searches direct children of the caller and may omit all filters, preserving bounded child enumeration.
- `{ "directSpawnerAgentId": "parent-agent-id" }` searches the named Agent's exact direct children. Owner and Moderator authority follows the existing child-enumeration rule; an unauthorized or unverified parent produces no matches.

Search filters combine with AND. `query` is one case-insensitive substring over `label` and `description`; `agentIdSuffix` is a separate case-sensitive compact-ID suffix; `phase` is one of `starting`, `live`, `ending`, or `dormant`; and `limit` defaults to 20 with a maximum of 50. Broad `"authorized"` searches require at least one of `query`, `agentIdSuffix`, or `phase`. Search returns:

```json
{
  "matches": [],
  "hasMore": false
}
```

Results use deterministic relevance and canonical Agent order. Search is a live, non-atomic observation: each returned status has its own Run state and evidence watermark. It never prepares or activates a dormant Runtime. Full transcript-content inspection remains an explicit filesystem/`rg` technique rather than part of this operation.

Each status contains the durable Agent identity and structural relationship, the current semantic Run state, and bounded primary evidence:

- `primaryEvidence.transcriptPath` is the authorized Pi transcript location, or `null` for a non-file-backed session.
- `primaryEvidence.inspectedThrough` identifies the last physical transcript entry included in the observation.
- `run.phase` is `starting`, `live`, `ending`, or `dormant`. A live Run also reports `work`, `attention`, and counted `retentionReasons`. `run.suspension` identifies a quota-suspended Run and contains its retained provider evidence.

Retention categories are `owner_host_binding`, `pending_delivery`, `awaiting_answer`, `answer_owed`, `interactive_selection`, `interruption_hold`, and `moderator_handling`. Status never exposes Message payloads, prompts, history summaries, Run handles, or raw Pi objects.

The native status call and collapsed result identify the Agent as `label · compact identity`, using the final eight identity characters, and show its current semantic work status. When `agentId` is omitted for self-observation, the resolved identity appears in the result. Search returns the same `AgentStatus` contract, including `directSpawnerAgentId`, which identifies the one-hop Direct Spawner. Agent Control calls and receipts use the same identity format. Expanding a result identifies the Agent as `label · full identity`, followed by the exact structured observation or receipt.

## Generation failure

Coordination preserves Pi's user-configured compaction, retry, provider-retry, and transport behavior. A child-local Turn Compaction Gateway cancels threshold compaction requested after a Run only when no raw Pi continuation is queued. The child releases normally and recomputes the same configured threshold before its next idle native prompt or Owner Delivery. Manual compaction and overflow recovery remain Pi-native. The gateway owns only preparation and input commitment, never the model cycle, and creates no durable pending state or Runtime retention.

If Pi's configured native behavior ultimately ends the exact Run unexpectedly, the runtime retains a Run Failure Report, even when no Answer Obligation remains. It captures the observed error and stage, exact Agent and Run, affected work, and recovery findings or explicit uncertainty. Startup errors observed by the host do not require a child-side error transcript entry. Successfully recovered transient errors, ongoing provider recovery, deliberate termination, and recognized quota suspension are not Run Failures.

An unresolved Answer Obligation still determines eligibility for ordinary Run Failure moderation; reporting does not broaden that policy. Reports use the Owner's existing read/unread, copy, and retained history surfaces. Marking read acknowledges the notification only: it does not clear live failure handling, settle Requests, or initiate recovery. See [Operational Incident moderation](operational-incident-moderation.md) for report grouping and recovery findings.

## Quota suspension

A terminal, evidence-backed quota error displays **Suspended · Usage limit reached** after Pi's configured native retry/fallback has finished. It retains the exact Run instead of failing it or starting a Moderator. The status and its acknowledgeable Runtime Report retain provider/model and the exact diagnostic; a reset time appears only when the provider supplied it. Each continuous suspension has one notice. Reading it does not resume execution.

Suspension preserves Requests, Answer Obligations, and pending work without replaying tools or starting a successor. Ordinary Agent Messages, heartbeat scheduling, and Workflow continuation cannot release it. A new human message in the selected Agent's editor is deliberate resumption, using that message as the resumption instructions. Suspended children relinquish execution capacity so unrelated children can progress. Quota-blocked work and its genuinely blocked dependency path do not generate obligation reminders, stall/deadlock moderation, or Moderator replacements; unrelated incidents remain eligible.

Restore quota or deliberately select an available model/account, then explicitly resume:

- A supervisor uses `agent_control` with `operation: "resume"`, the child Agent ID, and resumption instructions.
- The human sends a message in the Owner's or selected child's editor. There is no separate quota-resume command, and Agent controls do not gain authority over the Owner.

Human intent uses Pi's trusted `interactive` input provenance; queued follow-ups, extension `sendUserMessage`, and RPC input cannot resume the Run. Direct noninteractive native input is consumed before generation while suspended; ordinary coordination Messages remain queued with their original identities. This is not an authentication boundary: SDK callers must label their source truthfully (`session.prompt()` defaults to interactive).

Changing the model/account alone is not resumption. No new paid fallback, provider-wide suspension, guessed retry deadline, or automatic quota probe is introduced. Suspension is not a human-issued Interruption Hold. Request cancellation retains its normal one-hop semantics; it neither resumes the Run nor cancels descendants. Explicit termination ends the suspended Run without resolving its Requests, following the normal residual-Request contract.

If a resumed attempt ends before its input's transcript confirmation, its observed outcome is applied after confirmation: success releases retained input once, renewed quota establishes a new suspension notice, and another terminal error follows ordinary failure handling. An aborted attempt before confirmation retains the original stop and notice rather than inventing a human Interruption Hold.

The Owner transcript retains suspension independently of report read state. Cold recovery restores the stop before scheduling work, rather than silently starting a successor. See [cold recovery](cold-host-recovery.md) for the limits of reconstructing volatile queues and interrupted tools.

### Provider evidence and upstream limitation

The classifier accepts retained `usage_limit_reached` / `insufficient_quota` JSON error codes or types, including Pi's bare HTTP-status and OpenAI/Azure formatter envelopes. It also recognizes the exact observed Codex diagnostic `Codex error: The usage limit has been reached` and Codex's exact code-only variants. An explicit unrelated code takes precedence over prose. Generic HTTP 429, `rate_limit_exceeded`, arbitrary text containing “limit”, and ambiguous friendly usage-limit wording are not quota evidence. Temporary throttling stays on Pi's native recovery path; unknown terminal errors remain ordinary failures.

The installed Pi provider exposes `AssistantMessage.errorMessage`, not the original structured provider error. Codex streaming errors construct a `CodexApiError` with code/payload, but error formatting discards those fields. The HTTP formatter also conflates quota, temporary throttling, and other 429 responses into friendly text. This package cannot recover facts already discarded upstream.

Required upstream improvement: preserve provider code/type and provider-supplied absolute reset time through both HTTP and streaming error mapping into `AssistantMessage` and lifecycle events, independently of human-readable formatting. Until then, classification is intentionally limited to retained exact/JSON evidence. Installed provider packages are not patched.

## Child execution and Delivery

The child reports transport execution-cycle identities from actual Pi lifecycle events. The Owner adopts those identities; admitting or preparing a Delivery does not reserve the next cycle. Transport cycle IDs are separate from durable Agent Run sequences. Native editor or extension work can therefore start while a Delivery is pending without being mistaken for stale execution.

All Owner input uses `message.deliver`, correlated by a Delivery ID:

- The response reports transcript admission independently of execution completion.
- `message.dispatch.completed` covers that exact dispatch and native settlement, including input queued into active work. Preparation settlement cannot complete the Delivery.
- `message.cancel` remains available until dispatch completion, independently of transcript acknowledgment. It fences pending preparation or input preflight by Delivery ID. Once native execution starts, the child correlates its actual abort signal at the public Agent prompt boundary, before awaited extension start hooks finish. Cancellation rechecks that exact native signal before clearing queues or aborting; a successor signal is never targeted.
- `run.interrupt` and `queue.clear` target child-reported cycles and revalidate after waiting, immediately before mutation.

Delivery completion and rejection do not manufacture lifecycle events or fault a successor cycle. Actual lifecycle identity mismatches still fail the transport; unrelated native work is not accepted by bypassing that validation.

## Interrupt an exact Run

```json
{
  "operation": "interrupt",
  "agentId": "child-agent-id"
}
```

Interruption resolves the target's exact current Run inside its serialized lane. It fences queued continuation, aborts active generation, waits for semantic settlement, and then establishes one exact `interruption_hold`. An active Human Request settles through its native error tool result before the Hold is reported.

The receipt disposition is:

- `held` when this invocation established the Hold.
- `already_held` when the exact current Run already has a Hold.
- `not_running` when no controllable current Run can be held.

While held, ordinary Messages, Requests, Answers, and Cancellations may remain admitted in the bounded recipient scheduler. They still consume ordinary capacity, but cannot commit Delivery, invoke the model, or clear the Hold. Native queued input cleared for safe interruption is retained for the exact Run and restored only after an explicit isolated resumption turn.

## Resume with explicit input

An authorized supervisor resumes through a model-visible Message:

```json
{
  "operation": "resume",
  "agentId": "child-agent-id",
  "content": "Continue, but verify the transcript watermark before acting."
}
```

Each held Agent has one reserved Supervisory Resume slot outside its ordinary Message capacity. The resume Delivery commits alone, clears only the exact Hold to which it was admitted, and receives one isolated model turn before the ordinary coordination backlog can proceed. A successful receipt returns the source-derived `messageId` with `messageStatus: "sent"`, matching other asynchronously admitted Messages. A rejected receipt reports `not_held`, `resume_slot_occupied`, or `target_unavailable`.

A resume that loses its bound Hold before Delivery becomes an ordinary Steer Message. It remains useful direction, but cannot clear a later Hold. Owner `workflow_resume({})` recovers successfully committed undelivered resume Messages under this same rule; a live reserved resume still coalesces in its existing isolated slot.

A supervisory dispatch failure reports an error, clears only the failed resumption attempt, and leaves the exact Hold available for an explicit retry.

The [Agent selector and view](agent-selector.md) present a durable Agent without changing protocol authority or Owner runtime ownership. `interactive_selection` retains the Agent Runtime without itself admitting work. Selecting a Dormant Agent prepares its ordinary configured session, complete Pi mode, and persisted evidence while observation remains Dormant. Extension behavior is not filtered: editor input, extension effects, and ordinary coordination Delivery may activate an exact Run in that same Runtime. Run release, failure, or termination can return the selected Agent to Dormant without replacing its projection. Switching or closing removes Runtime retention, and orderly shutdown closes the overlay before ending child Runs and disposing retained Runtimes.

The native above-editor activity dock identifies the selected durable Agent by label, compact Agent identity, and semantic work status. It also projects only that Agent's direct children with a current Run; Dormant children remain absent from activity. Owner scope prepends Owner-only attention. The child mode's complete fullscreen transcript, Run state, widgets, editor, footer, commands, and extension UI render inside the headerless outer overlay, while the Owner presentation remains mounted and unchanged underneath.

## Terminate an exact Run

```json
{
  "operation": "terminate",
  "agentId": "child-agent-id"
}
```

Termination fences and confirms the end of the target's exact current Run, bypasses every Retention Reason, and discards its uncommitted coordination and native input. The fence includes every native editor submission observed before termination: a submission still inside asynchronous input preflight cannot later admit a successor Run. It does not roll back effects, Answer or cancel Requests, notify participants, mutate descendants, remove the Agent, or create Agent lifecycle evidence. Later Message Delivery may start a fresh successor Run for the same Agent identity. Recovery of any discarded Message remains explicit through transcript inspection, poll, or retry.

A selected Agent with a ready Runtime keeps that Runtime and open view after termination; the Agent becomes Dormant in place, and only later editor submissions or Message Delivery may admit a successor Run in that same Runtime. If termination wins while the selected Runtime is still initializing, it fences that exact projection's input, cancels initialization outside the occupied Agent lane, and closes the not-yet-usable view instead of waiting for startup UI. An initialization-termination intention blocks queued successor admission until its lane-final receipt, so work queued behind startup cannot insert a new Run between cancellation and termination finalization. A successful or already-Dormant receipt reports `terminated` or `not_running` plus complete live `residualRequests.incoming` and `residualRequests.outgoing` counts.

Treat those residual counts as unresolved work, not as termination cleanup. If the supervisor authored a Request whose work is being abandoned, it cancels that Request by `requestMessageId` before delegating a replacement or calling `agent_wait`. If the work remains needed, an ordinary Message can reactivate the same durable Agent in a successor Run. A supervisor that did not author the Request cannot cancel it and must coordinate with its requester. A fresh `agent_wait` may also start a Dormant responder when its captured Request was never delivered; an already parked Wait cannot undo later termination. Delivered Requests are awaited without replay.

Coordinated shutdown remains a dedicated lifecycle path and closes any open Agent view before ending child Runs.

Interruption Holds, live scheduling, open Agent-view attachment, and exact Run handles are volatile. Pi transcripts remain the authority for durable identity, authored Messages, and committed Delivery.
