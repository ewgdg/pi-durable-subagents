# Agent messaging and Requests

Every authenticated ordinary Agent can send an immutable free-form Message or correlated Request to a known Agent in the same Workflow. Each authored Message fixes either Deferred or Steer Delivery.

- Deferred waits until the recipient's current work settles and receives its own model turn.
- Steer waits for the current generation and its complete issued tool batch, then redirects the next model turn without aborting work or rolling back effects.

Omitting `deliveryMode` selects Deferred.

## Short Message references

`poll.messageId`, `retry.messageId`, and `cancel.requestMessageId` accept a full canonical ID or a unique case-sensitive suffix. Whitespace around the reference is ignored. Matching considers the caller's earlier authored Message sources, including Spawn Creation Requests; exact IDs take precedence. Ambiguity is rejected, so use a longer suffix or the full ID. Normal authorship, Message-kind, and Delivery validation still applies.

Full IDs remain literal references subject to existing evidence checks. For suffix expansion, the referring committed tool call fixes the candidate history. Later Messages cannot change what that call resolves to, including during retry, transcript reopen, or reconstruction. Receipts and Request relationships keep the full canonical ID. This uses retained transcript indexes without a separate allocation database or alias registry.

Collapsed Message tool rendering shows the final eight characters. Expand to see the full ID if that suffix is ambiguous. Structured tool results retain full IDs. Agent IDs remain Pi session IDs, with the existing Agent suffix matching described below. Message IDs remain deterministic source-derived hashes. This does not add cross-Workflow messaging or change Request scheduling.

## Select a recipient

For `send` and `request`, `targetAgent` accepts any of:

- an exact Agent label;
- a full Agent ID; or
- a unique suffix of an Agent ID.

```json
{
  "operation": "send",
  "targetAgent": "Researcher",
  "content": "Report the evidence you found."
}
```

```json
{
  "operation": "request",
  "targetAgent": "983c81e3",
  "question": "Which invariant should the fix preserve?"
}
```

Resolution follows one fixed order:

1. An exact full Agent ID resolves across the Workflow.
2. An Agent ID suffix resolves across the Workflow and must match exactly one Agent.
3. An exact label resolves within the caller's coordination neighborhood and must match exactly one addressable Agent.

An ordinary Agent's label neighborhood contains itself, its Direct Spawner, and its direct children. Owner and Moderator labels resolve across the whole Workflow. This keeps common local labels useful without weakening identity-based routing to other known Agents.

Selectors are exact and case-sensitive. Leading and trailing whitespace is ignored. Unknown and ambiguous selectors are rejected rather than resolved by roster order.

The initial author receipt includes the resolved full `targetAgentId`. Retry scheduling receipts repeat that canonical identity. The durable binding fixes the recipient for poll, retry, Run replacement, and cold recovery even if a later Agent creates the same label or suffix match.

## Send a Message

Call `agent_message` with the recipient and content:

```json
{
  "operation": "send",
  "targetAgent": "recipient-agent-id",
  "content": "Inspect the failing integration and report the smallest safe fix."
}
```

When the invocation authors a Message, its committed tool call fixes the Message identity, sender, recipient, Workflow, and content. These values cannot be supplied again or changed by retry.

Malformed Agent Message arguments author no protocol fact, including while Pi's native validation result is still pending. Unrelated Request inspection and Delivery continue during that interval. A successful result contradicting malformed arguments remains an invariant violation.

An Agent with an active Answer Obligation cannot author an ordinary Message to that Request's requester. The invocation returns `disposition: "rejected"` with reason `answer_required` and the active `requestMessageId` without creating a Message identity or retry path. Keep provisional findings local and use `answer` for the curated result. If progress depends on requester input or a decision, issue a reverse `request`. Ordinary Messages to other Agents remain available. Existing Messages are not withdrawn when an Answer Obligation begins.

Use Steer only when the next model turn needs exceptional direction:

```json
{
  "operation": "send",
  "targetAgent": "recipient-agent-id",
  "content": "Re-evaluate the fix against the newly discovered invariant.",
  "deliveryMode": "steer"
}
```

At a safe boundary, all Steer Messages already pending for that recipient are frozen in admission order, deduplicated against transcript proof and existing dispatch reservations, and committed as one model-visible batch. A Request already queued to preempt Agent Wait keeps that single dispatch while its Delivery proof is pending. A Message admitted after that freeze waits for the next safe boundary. Steer takes precedence over Deferred when both are pending.

The initial receipt reports admission, not Delivery:

| `messageStatus` | Meaning | Next action |
| --- | --- | --- |
| `sent` | The recipient lane admitted the Message for asynchronous Delivery. It may still be queued and is not necessarily delivered. | Poll only when Delivery proof matters. |
| `not_sent` | This invocation was not admitted. `reason` distinguishes target availability, shutdown, and capacity exhaustion. | For an initial `request`, correct the problem and author a new Request. For other Messages or later retries, retry the existing identity. |
| `unknown` | Admission may have happened, but confirmation was lost. | Poll the same Message identity before retrying. |

A definitive `not_sent` result from the initial `agent_message.request` invocation creates no Request: its correlation ID is not an outstanding dependency, Answer obligation, or retryable Request. Reconstruction and Agent Wait exclude it. After correcting the admission problem, author a new Request. `unknown` is not definitive non-admission and preserves the same Request for inspection/retry. A later retry's `not_sent` never withdraws an already-admitted Request. Creation Requests remain canonical once the child Identity commits, even if startup or Delivery admission fails; Answer and Cancellation commitment likewise survives their Delivery failure.

An ordinary Message receipt returns its source-derived `messageId`. An Agent Request receipt instead returns `requestMessageId`, its source-derived correlation identity; definitive initial non-admission does not make that ID a canonical Request. Initial author receipts and later retry scheduling receipts also return the resolved full `targetAgentId`.

## Committed delivery receipts

Delivery inspection trusts a structurally readable, committed model-visible record in the intended recipient's current Workflow scope. It matches the source pointer, Message identity, sender, kind, and related Request (for Answers and Cancellations), not question, answer, reason, or content equality against the sender's original text. This applies to Creation Requests, ordinary Messages and Requests, Answers, Cancellations, and committed Answer retrieval results (including Wait).

Writers still deliver the requested content; receipt inspection does not re-prove that writer contract. Queued admission and incomplete transcript entries are not delivery. Delivery means available in the recipient's transcript/context, not necessarily processed by the model. Exact schemas, duplicate rejection, cursor advancement, and retry/Wait/Cancellation ordering are unchanged. Receipts use existing transcript facts, not a separate durable store.

### Runtime completion tracking

Transcript commitment and native prompt completion are separate. The child Control response confirms admission/commitment early; a Delivery-correlated completion event reports the actual dispatch Promise. An idle-started Delivery remains pending through that prompt's native settlement. Queued-active Delivery still waits for native settlement rather than treating queue acceptance as completion.

Preparation may start and finish an extension-owned Pi cycle before the Request starts another cycle. Both cycles keep their ordinary lifecycle events; transport cycle identity is not logical Agent Run identity. Completion tracking does not suppress settlement or change Run retention/release eligibility.

Orderly hosted Runtime disposal rejects pending completion tracking before removing its event listener, without synthesizing native lifecycle events.

The scheduler tracks dispatched Steer batches alongside Resume, Deferred, and Wait-preempting deliveries. It waits for dispatch completion outside the recipient's serial lane so the actual turn can reach awaited safe boundaries. It re-enters the lane and revalidates the exact Run and dispatch reservations before reconciliation; stale tracking cannot consume a newer dispatch.

## Delivery presentation

The recipient transcript renders each delivered item as a readable message block. Its collapsed view shows the Message type, sender label with the final eight characters of the Agent identity, and the first ten terminal-width-aware rows of the body. A standalone dim ellipsis on the following line marks a truncated preview. Outgoing Message and Request tool calls use the same body preview, label, and compact identity format for the receiver. Expanding the block shows the sender label with the full Agent identity and the complete Message, Request question, Answer, or Cancellation reason with Markdown formatting. Batched Deliveries keep each item's sender and type visible instead of presenting the protocol JSON.

## Request one Answer

Use a Request when the recipient owes one mechanically correlated Answer:

```json
{
  "operation": "request",
  "targetAgent": "responder-agent-id",
  "title": "Identify release handoff evidence",
  "question": "Which transcript entry proves the release handoff?"
}
```

The Request fixes its requester, responder, Workflow, required title, full question, Answer destination, and delivery mode. Choose a short, specific title identifying the work; whitespace-only titles are invalid. Titles need not be unique and never replace Message IDs for correlation or the full question for instructions. Request commitment retains the requester's current Run with `awaiting_answer`.

Outbound Requests belong to their author Agent. Delivered Requests create independent Answer obligations; receiving another Request does not replace or resolve earlier work.

Request delivery controls attention, not execution order. Deferred Requests remain queued during active work and enter one at a time in live admission order when the recipient parks in `agent_wait` or settles. Sibling and unrelated Requests qualify at those same cooperative boundaries; Request ancestry does not gate delivery. Steer Requests take priority at the next safe model boundary, after active generation and its complete tool batch finish. Ordinary Messages, Answers, Cancellations, and Supervisory Resume remain outside Request ordering. Receiving a Request does not choose which obligation the Agent must handle next.

Answer explicitly names any delivered unresolved Request addressed to the responder, using its canonical Message ID or a unique case-sensitive suffix among prior delivered incoming Requests:

```json
{
  "operation": "answer",
  "requestId": "request-id-suffix",
  "answer": "The model-visible Answer Delivery entry proves the handoff."
}
```

The coordinator validates the target and derives its recipient. Answer commitment ends exactly that obligation even if return scheduling fails. Fresh calls targeting resolved, undelivered, or unknown Requests are rejected; replaying the same committed source returns its existing receipt without resolving any other obligation. Answers use fixed Steer delivery.

Use Answer as the only tool call in its turn. Its tool implementation returns the messaging receipt and `terminate: true`, ending that model/tool loop without a redundant assistant recap. The receipt carries `requestTitle` from the canonical Request alongside its IDs and actual scheduling status, usually `sent`. The responder supplies only the Request reference and Answer body, never a replacement title. Direct Answer delivery and Wait/retry retrieval use that same title; there is no designated next Request.

When delivered unresolved obligations remain after a newly committed Answer, the runtime offers one neutral continuation unless native input already provides one. Before each model generation, a compact ID/requester/title listing of the current outstanding set replaces earlier attention snapshots in context and leaves work order to the Agent. Full instructions remain available through Request inspection instead of being repeated in every snapshot. Input already consumed after Answer counts as that continuation opportunity. With no remaining obligations, Answer creates no summary turn. Pi can still continue queued input before `agent_settled`.

Ordinary Messages to the requester of any unresolved obligation are rejected; use a reverse Request for a decision, or keep provisional findings local. Sending becomes available when no unresolved obligation owes that requester.

## Inspect Outstanding Requests

Use the read-only observation interface to recover what you owe:

```ts
agent_observe({ operation: "obligations" })
agent_observe({ operation: "request", requestId: "request-id-or-unique-suffix" })
```

`obligations` returns `requests`, each containing `requestMessageId`, `requesterAgentId`, and `title`. It lists only the caller's delivered Requests whose Answer obligations remain open. Answer commitment or Cancellation Delivery removes the corresponding entry. Undelivered Requests and the caller's outgoing dependencies are not incoming obligations. The list contains no full question bodies and creates no additional task state.

`request` returns those identifying fields plus `responderAgentId` and the exact full `question`. The reference resolves among Requests the caller authored or received, including closed Requests; ambiguous suffixes fail rather than choosing one. Inspection never delivers a queued Request, starts a responder, or resolves an obligation. A title is navigation, not a substitute for reading the instructions before acting.

## Agent delegation

An Agent Request can ask for existing information or a decision without delegating work. When `agent_message` operation `request` or `agent_spawn` delegates work, partition it into bounded, non-overlapping work units before sending the Request.

After Delivery admission, the responder owns the delegated work until its Answer arrives or the Request is cancelled. Continue only disjoint work that would remain necessary if the responder returned a complete, correct Answer. Otherwise end the turn. The runtime waits for turn-triggering input and resumes the existing continuation when it arrives. Duplicate investigation is appropriate only when the Request explicitly asks for an independent cross-check.

Reuse an existing Agent only when context acquired through its earlier work materially reduces rediscovery. Spawn a fresh Agent when that context is not relevant. A continuation Request may ask the idle recipient to prepare its existing context before Delivery:

```json
{
  "operation": "request",
  "targetAgent": "existing-agent-id",
  "title": "Continue the verified implementation",
  "question": "Continue the implementation using the constraints you already verified.",
  "contextPreparation": {
    "workScale": "medium",
    "contextDependence": "high"
  }
}
```

`workScale` estimates expected context growth as `small`, `medium`, or `large`. `contextDependence` estimates the value of exact prior context as `low`, `medium`, or `high`. Both fields are required inside `contextPreparation`. The committed Request owns these estimates; retry accepts only the Request identity and cannot replace them. The recipient sees the ordinary Request projection without preparation metadata.

Omit `contextPreparation` to retain ordinary Pi compaction behavior. When it is present, an idle child with automatic compaction enabled compares current context usage with the cost and runway threshold in [ADR 0003](adr/0003-continuation-working-zone-preparation.md). If preparation is warranted, the child calls the active public compaction strategy once before committing the Request. Pi summarization receives the prospective question only as relevance guidance and is told not to include, paraphrase, or claim receipt of the uncommitted Request. Extension-owned strategies may ignore that guidance and still provide the compaction result.

Unknown context usage and disabled automatic compaction skip the optional attempt. Active Steer Delivery keeps its exact queue order and skips proactive preparation. A below-native optional failure warns in the child and continues Delivery; failure at Pi's native threshold remains blocking. Coordination cancellation or Runtime replacement during preparation fences the exact Delivery.

A manual compaction attempt that Pi reports as aborted is a neutral outcome, not a preparation failure. Extensions may cancel compaction and start their own turn; Delivery then queues into that active turn and confirms transcript commitment without waiting for replacement work to finish. This follows Pi’s cancellation classification rather than inferring extension intent from error text.

## Retrieve an Answer

Retrying a Request selects one authoritative outcome:

- `answer_already_delivered` returns existing requester-side Delivery proof.
- `answer_delivered` returns a committed undelivered Answer directly in the native retry result. That committed result is the Answer Delivery proof and preserves the responder's immutable authorship.
- `request_delivered` reports a delivered unanswered Request without redelivery.
- `messageStatus: "sent"` reports that the same undelivered Request was readmitted under its authored mode.
- `messageStatus: "unknown"` reports that Request readmission may have happened but confirmation was lost; poll before retrying again.

Incomplete or contradictory evidence schedules nothing. If direct Answer Delivery already owns a frozen or dispatched scheduling reservation but has not committed proof yet, retry reports `messageStatus: "unknown"` with `reason: "inspection_incomplete"` rather than competing with that Delivery. The native retry result is re-arbitrated immediately before commitment: a newly reserved direct Delivery changes a selected retrieval to that same indeterminate outcome, while newly committed direct proof changes it to `answer_already_delivered`. A later explicit retry is required after an indeterminate result.

## Join outstanding Answers

`agent_wait` joins Answers when one next decision needs a set together. Without arguments, it captures all outstanding outbound Requests authored by the caller Agent:

```json
{}
```

To join only selected outbound Requests, provide `requestMessageIds`:

```json
{ "requestMessageIds": ["request-id-or-unique-suffix", "another-request-id"] }
```

The non-empty list accepts full IDs or unique case-sensitive suffixes from the caller's prior authored Requests, including Creation Requests. The whole selection is validated before any scheduling or parking: unknown, ambiguous, foreign-authored, non-Request, cancelled, and already-consumed targets fail explicitly. Canonical identities are deduplicated and ordered by authorship, not input order. Committed Answers without caller-side Delivery proof remain outstanding and can be retrieved by either form.

Select dependencies that can progress without an Answer you still owe. If strict fan-in is unnecessary, let ordinary Answer Delivery reactivate the Agent. Do not poll merely to wait. Ordinary Messages do not satisfy Agent Requests.

When the committed sequential `agent_wait` call begins execution, it fixes one non-empty snapshot of all outstanding outbound Requests or the explicit selection, independent of attention order. The snapshot preserves canonical Request authoring order, includes unanswered Requests and committed Answers without requester-side Delivery proof, and excludes cancellations and Answers already delivered to the requester. Later Request sources are outside the snapshot, including later calls in the same assistant tool batch. Unselected Requests remain outstanding and keep ordinary delivery behavior. A call with no outstanding Requests is rejected.

An explicit Wait renews delivery intent for its captured Requests. Shared Message scheduling inspects canonical evidence and ensures original, same-identity scheduling for unanswered, undelivered Requests, including Creation Requests. It preserves the original title, body, routing, Delivery mode, and context preparation. Queued, reserved, frozen, and in-flight scheduling coalesces without duplicating or reordering the same identity. Already delivered Requests are awaited without replay, cancelled Requests are never replayed, and committed Answers use ordinary retrieval.

The tool is sequential. After admission, it parks the exact caller Run until every Request in the snapshot has a canonical committed Answer. A child caller releases its child execution slot while parked; Owner and Moderator Runs consume no child slot at any time. A fresh Wait can start a Dormant recipient through normal admission when its captured Request is still undelivered. An already delivered Request does not start a successor through Wait: the Owner can call `workflow_resume({})` to continue dormant responders with outstanding obligations without authoring a new Message or Request. Committed Answers remain retrievable regardless of responder phase. Wait neither cancels Requests nor creates durable Wait state.

While the join is parked, its tool row lists Request titles and responder Agents in the fixed snapshot. When the join completes, the row replaces that progress with Answer Delivery blocks in snapshot order: each `[Answer] <Request title> from …` header is followed by the Answer body using the same collapsed preview and expanded Markdown presentation as direct Answer Delivery. Proof-only already-delivered results also retain the Request title. Expanding the Wait shows its protocol details.

Results preserve snapshot order. A committed Answer not previously delivered to the requester returns `answer_delivered` with the immutable Answer and its source; the committed `agent_wait` tool result becomes that Answer's requester-side Delivery proof. An Answer with existing requester-side Delivery proof instead returns `answer_already_delivered` with the prior proof and does not duplicate the body. If direct Answer Delivery already owns its frozen or dispatched scheduling reservation, the Wait remains parked until that Delivery commits and then returns proof-only. Pi re-arbitrates the aggregate at its native result-commit edge, replacing stale Answer bodies with proof-only slots when direct Delivery won meanwhile.

The wait registers before its final evidence inspection, responds to live Answer progress, and reconciles canonical transcript evidence and captured Request scheduling every five seconds as an event-loss fallback. Ongoing readmission stays within the recipient Runs captured or started by that explicit Wait: it respects Holds and cannot revive a terminated or failed Run, or transfer backlog to a successor. Caller preemption, interruption, and exact-Run fencing also end its readmission authority. If authoritative inspection or admission fails, Wait reports the Request identity and failure rather than silently parking on lost scheduling. Committed Answer retrieval does not wait behind delivery maintenance in a busy recipient lane. A successor Run may call `agent_wait` to snapshot and retrieve its still-outstanding Answers. Unfinished Wait calls and their timers are volatile and are not reconstructed after host loss.

Primary interactive human input directed at the waiting Agent continues through Pi's native steering path. Wait preemption begins only after Pi admits that steering input, so the non-error `{ "disposition": "preempted" }` result cannot start another model turn ahead of the user message. The next model generation receives both. Explicit follow-up input remains queued until later.

An eligible inbound Request preempts the parked Wait to bring work to attention. Deferred qualifies in live admission order regardless of Request ancestry, and Steer retains priority. Delivered Request Cancellation can also preempt. Its Delivery is reserved and committed before the next model generation. A complete Answer aggregate wins if already ready; otherwise Wait returns `{ "disposition": "preempted" }`, consumes no Answer, and creates no requester-side Answer Delivery proof. Consider the new input and choose what to handle next; an already-delivered unresolved obligation does not repeatedly preempt future Waits. Call `agent_wait` again only if a join is still needed, with the desired selection; each call fixes a fresh snapshot. Ordinary Deferred and Steer Agent Messages remain queued.

Interruption, exact-Run fencing, termination, or shutdown ends the live wait without consuming undelivered Answers. A successful aggregate result becomes Delivery proof only when its native tool result commits. Ordinary Answer Delivery or explicit Request retry therefore remains available if result commitment loses a race.

### Fan-out and strict fan-in

An Agent may send two Requests, continue disjoint inspection outside both requested work units, and join only when its next decision needs both Answers:

```json
{ "operation": "request", "targetAgent": "design-agent", "title": "Choose the interface invariant", "question": "Which invariant should the interface preserve?" }
```

```json
{ "operation": "request", "targetAgent": "test-agent", "title": "Identify the regression", "question": "Which observable regression must the test cover?" }
```

After completing that disjoint work, call `agent_wait` with `{}` if the implementation decision requires both outstanding Answers. If either Answer can be handled independently, settle instead and let each Answer activate an ordinary model turn.

### Interactive reverse Request

Suppose the requester calls `agent_wait`, but the responder needs a decision before it can produce its curated Answer. The responder keeps provisional findings local and authors a reverse Request instead of sending an ordinary Message:

```json
{ "operation": "request", "targetAgent": "original-requester", "title": "Decide unavailable-evidence behavior", "question": "Should the interface fail or skip unavailable evidence?" }
```

The reverse Request preempts the original requester's Wait. The original requester handles its new Answer obligation with `agent_message` operation `answer`, then calls `agent_wait` again only if its next decision still needs every outstanding Answer. The fresh Wait includes the unresolved original Request; the preempted Wait consumed no Answer Delivery.

## Cancel one Request

Only the requester may abandon its exact Request:

```json
{
  "operation": "cancel",
  "requestMessageId": "source-derived-request-id",
  "reason": "The result is no longer needed."
}
```

`requestMessageId` names the Request Message being withdrawn. A newly committed Cancellation receipt returns its own `messageId`, canonical `targetAgentId`, and Delivery outcome. If the Request was already resolved, the receipt instead returns `already_cancelled` with `cancellationMessageId` or `already_answered` with `answerMessageId`; it does not repeat the Request identity from the call.

Cancellation commitment ends only that requester wait. Fixed-Steer Cancellation Delivery removes only the named incoming obligation and supplies actionable context; it does not abort tools, retract facts, undo effects, or terminate a Run. Cancellation delivered before a waiting Request suppresses that Request without waking the responder for obsolete work. Other incoming obligations and Agent-owned outbound Requests remain intact, irrespective of attention order. Cancellation remains one hop: downstream Requests require explicit cancellation by their author. Answering an incoming Request likewise neither transfers nor cancels outbound dependencies.

Answer and Cancellation facts serialize independently in the requester and responder lanes. Either may commit while the other's Delivery is unavailable. Committed facts remain canonical, and a locally cancelled Request cannot be revived by retry or a late Answer.

Downstream cancellation is cooperative and one hop. A responder may cancel each Request it authored, but no cascade identity or subtree-success result exists.

## Check Delivery

Only the original sender can poll its Message:

```json
{
  "operation": "poll",
  "messageId": "source-derived-message-id"
}
```

| Disposition | Meaning | Evidence |
| --- | --- | --- |
| `delivered` | A valid model-visible Delivery exists in the recipient transcript. | `deliveryEvidence` points to that exact entry. |
| `not_observed` | A complete all-branch inspection found no Delivery at that observation point. | `inspectedThrough` identifies the physical append watermark. |
| `indeterminate` | Authoritative transcript inspection could not complete. | No absence or Delivery claim is made. |

Delivery proves that the Message became available to recipient session context. It does not prove that the model read it, acted on it, or produced a useful result.

## Retry an undelivered Message

Retry uses the original immutable Message and its authored delivery mode:

```json
{
  "operation": "retry",
  "messageId": "source-derived-message-id"
}
```

For an ordinary Message, retry returns existing Delivery proof when present. Otherwise it coalesces with the same Message already pending in the recipient lane or admits one new volatile item after authoritative absence. At most one recipient transcript Delivery can prove a Message.

Retry does not accept `deliveryMode`; it cannot turn Deferred into Steer or Steer into Deferred.

If retry admission may have happened but its confirmation is lost, retry returns `messageStatus: "unknown"`; poll before deciding whether to retry again.

If recipient evidence cannot be inspected, retry is rejected without scheduling. This prevents a new delivery from being admitted while the coordinator cannot establish whether proof already exists.

## Bounded scheduling

Each recipient admits at most the current Workflow Policy's `maxPendingDeliveriesPerAgent` distinct pending Message identities across Deferred and Steer; the default is 256. A retry of an already-pending identity consumes no additional capacity. Admitted work is never evicted, including when Owner reload lowers the limit.

Waiting Requests consume this same pending Delivery capacity. A Request receipt with `messageStatus: "sent"` means the recipient lane admitted it; the Request may still be waiting for a cooperative or safe delivery boundary under its authored mode.

When capacity is exhausted, the invocation returns `messageStatus: "not_sent"` with reason `capacity_exhausted`. An initial Agent Request is not created in this case and must be authored anew after capacity becomes available. Other canonical Messages, including already-admitted Requests whose retry failed, remain retryable; there is no hidden overflow or automatic retry.

An exact [Interruption Hold](run-supervision.md) blocks every ordinary Message, Request, Answer, and Cancellation from committing Delivery or invoking the recipient model. Held items remain admitted and consume ordinary capacity. One Supervisory Resume Message uses a separate reserved slot and cannot evict ordinary work.

See [Workflow Policy](workflow-policy.md) for strict file validation and prospective reload behavior.

## Delivery across dormant Runs

Agent identity and a selected Agent Runtime can outlive any individual Run. When a child has no work and no Run Retention Reason, its current Run is released and the Agent becomes dormant. A Message, Request, Answer, or Cancellation to that Agent activates a successor Run in its prepared Runtime when available, commits at the first boundary allowed by its authored mode, and releases the successor again when no Run Retention Reason remains.

Before an idle model-starting custom Delivery commits, the child Turn Compaction Gateway recomputes Pi's current native threshold. A continuation Request with `contextPreparation` also applies its working-zone threshold. The gateway calls the active public strategy at most once for that exact admission, preserves the exact custom message, and completes preparation before Delivery transcript commitment. A custom Delivery that does not trigger a model turn commits without compaction or interruption. Active Steer and Follow-up Delivery uses Pi's raw queue; when work is queued after `agent_end`, Pi's native threshold compaction proceeds before the continuation.

Live scheduling, including per-responder waiting Request order, is intentionally disposable. Run failure, exact Run termination, or Workflow shutdown discards every uncommitted scheduling item for that host. A successor reconstructs titled Requests, outstanding obligations, and Agent-owned outbound dependencies from durable source, Delivery, and resolution evidence; it does not reconstruct waiting queue order. Receipts are not rewritten, Messages are not replayed automatically, and backlog is not transferred to a successor Run. Poll, same-identity retry, and a fresh all-Requests or selected Wait remain available. Owner `workflow_resume` additionally renews Workflow-wide scheduling and continuation for dormant responders with delivered unanswered Requests; cold bootstrap itself remains passive.

Malformed or contradictory transcript evidence is an invariant violation. Unknown Agents, cross-Workflow routes, and poll or retry by anyone other than the original sender are rejected before they can claim Delivery state.

### Durable focus and recovery

The retained transcript projection records delivered obligations at each committed assistant source so references remain bound to the evidence available when authored. Wait snapshots derive from the caller's authored outbound Requests and the committed Wait selection, not attention frames. Physical protocol entries survive compaction. Later calls may take fresh snapshots; pending Promises are never reconstructed.

If an Answer reached its requester before the responder saved its result, startup reconciles canonical cross-transcript proof and appends a local focus recovery boundary before new model authorship. All remaining obligations are presented before generation, including after compaction, with work order left to the Agent. No additional mutable obligation database is needed.

### Workflow continuation versus retry and Wait

Only the Owner can call `workflow_resume({})`, implicitly scoped to its current Workflow. It takes a fixed verified recovery snapshot and admits original undelivered Messages, Requests, and committed Answers through normal scheduling. Answers still go to their original requesters.

For a dormant responder with delivered unanswered Requests, it restores the transcript, outstanding obligations, and Agent-owned dependencies, then admits runtime-generated continuation input once for that activation. The input identifies Owner-requested continuation and requires checking interrupted operations before repeating their possible effects. It is not an authored Agent Message, replacement Request, or redelivery; the original Requests retain their obligations. Running Agents get no duplicate continuation, and ordinary delivered Message history alone does not trigger activation.

Per-Message `retry` repairs or retrieves one caller-authored identity. `agent_wait` renews delivery for its captured dependencies and joins their Answers; it does not restart already-delivered responder work. `workflow_resume` resumes coordination across the Workflow and returns an admission report without waiting for completion. None restores a lost Promise, Wait call, or waiting-queue order. Holds, capacity, cooperative delivery boundaries, and Run fences remain effective; stale cancelled/completed work is skipped and unverifiable evidence is surfaced. See the [recovery contract](cold-host-recovery.md#explicit-workflow-continuation).

## Asynchronous Delivery failure notices

`sent` confirms scheduling admission, not Delivery. If an admitted Message (including a Request or Creation Request) subsequently loses its dispatch/transport continuation, the scheduler sends its author a model-visible `agent-coordination.delivery-failure` notice. Initial `not_sent` outcomes remain synchronous and do not generate a notice. Ordinary Messages qualify without an upstream Request obligation.

The notice includes the original Message ID (also `requestMessageId` for Requests), recipient, message kind, failure reason, and recipient transcript inspection cursor when available. `confirmed_not_delivered` means this scheduling attempt failed before handoff to a Runtime. Once handed off, a dispatch exception or transport loss is `uncertain`: it cannot prove the recipient did not commit Delivery. Unavailable transcript evidence is explicitly `indeterminate`. The notice describes a snapshot; poll for current evidence.

Notices use ordinary custom-input scheduling: a settled author gets a turn, a dormant author may start a successor Run under normal startup/capacity rules, and an active author receives the input at a settled delivery boundary. A parked Agent Wait is preempted, returning `preempted`, rather than completed with fabricated Answers. Interruption holds and isolated resumption defer notice dispatch. Shutdown suppresses pending/new notices and prevents notice-driven startup; terminating an author Run discards its queued scheduling like other pending input.

Each live scheduling attempt emits at most one notice, even if both dispatch rejection and Run failure report the same loss. Explicit same-identity retry after scheduling loss creates a fresh attempt, so another failure remains observable. Recipient proof is checked before admission and again before notice dispatch; a late committed Delivery suppresses a queued notice. Notices themselves have transcript proof for deduplication, but are not Message Delivery proof and create no Answer obligation. Notification scheduling is process-local; cold recovery does not replay historical failure notices.

The author chooses whether to poll, retry the original identity, cancel an outstanding Request, or escalate. A notice never retries, replaces a Message, or resolves a Request. A failed dispatch that never starts a native turn still fences its exact failed recipient Run, releasing the lost reservation so explicit retry can proceed safely.

Delivery Stall moderation remains independent: it may inspect the same failed progress when an upstream obligation qualifies, whether or not the author was notified. Notification startup failure remains a scheduling diagnostic rather than recursively notifying a failed notice. Request Wait reconciliation retains its existing authority to renew selected Request scheduling; a failure notice only preempts the join and leaves the Request outstanding.
