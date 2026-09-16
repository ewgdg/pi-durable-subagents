# Cold host recovery

Restarting the interactive host reconstructs the durable ordinary-Agent roster, structural authority, and standalone Moderators from Pi transcripts. It does not restore a previous runtime.

## Workflow transcript directory

Every ordinary child and Moderator session is stored in one Workflow-specific directory below the active Owner's native Pi session directory. The directory identity derives from the Owner's Agent ID, so all participants share it even when their first or later Runtime working directories differ. The resumed Owner continues using its native session file.

The Owner is validated before discovery. A cold admission enumerates the Workflow directory once and publishes a fresh in-memory projection only after candidate verification finishes. There is no registry file and no filesystem watcher.

## Candidate admission

A candidate must be one complete, current-version, LF-terminated UTF-8 Pi JSONL transcript. For an ordinary child, its native session header and current Identity must agree on Agent ID. The Identity supplies the Workflow, Direct Spawner, exact canonical `agent_spawn` pointer, and structurally valid captured `creationPreset`. A child keeps that Identity and preset as its root bootstrap. The physical spawn source must resolve uniquely, and no other candidate may claim the same Agent ID or spawn source. Accepted spawn input must have display metadata matching the transcript. Declared input-shape rejection instead skips the call's protocol effects without rejecting independently valid child membership or descendants: it supplies neither a Creation Request nor Runtime overrides. The header cwd records the first Runtime's native session origin; it is not recovery configuration. Historical calls containing removed fields follow the same rejection rule, but copied-prefix children without the required root bootstrap remain invalid. Source transcripts are never rewritten.

A Moderator candidate instead requires one strict model-visible Moderator Input as its first transcript entry, no ordinary Identity, fixed trigger-specific metadata, a structurally valid captured `creationPreset` in its details, a matching session and Workflow relationship, bounded Request sources, normalized affected-Agent watermarks, and any valid previous-attempt pointer. It remains standalone and has no Direct Spawner.

Following Direct Spawner edges must reach the active Owner without a cycle. Direct children use the physical order of their canonical spawn calls, including multiple calls in one assistant entry; timestamps, filenames, scan order, and Agent IDs do not affect structural order.

Malformed identity/bootstrap, unreadable, incomplete, foreign, cyclic, duplicate, and source-conflicting candidates are quarantined with descendants whose authority depends on them. Independently verified subtrees remain available. Admission emits one bounded Owner warning and never repairs, rewrites, removes, or appends to candidate transcripts. Operations that name identifiable quarantined proof fail with `evidence_unavailable`; unrelated unknown identities remain `unknown_identity`.

Ordinary coordination records that fail declared data-shape validation are different:
replay skips them without quarantining the Agent or failing Workflow admission.
The same rule covers every physical branch and survives compaction and reload.
Original evidence and structured validation diagnostics remain available; model
context presents rejected call/result groups once with `!`, without native orphan
tool results or a new model turn. `^` is reserved for inherited material, not an
alias for invalid. Identity, membership, role, and contradictions between otherwise
valid canonical records remain strict. See the
[rejection contract](coordination-replay-rejection-design.md).

## Dormant Agents and `/agents`

Quota-suspended Runs are an exception to dormant recovery: retained Owner-transcript suspension evidence restores their exact stopped Run sequence before scheduling. Observation remains passive, and neither `workflow_resume` nor queued Messages clear the stop. Explicit quota resumption is required; the notice's existing read state is preserved. Selecting a cold suspended Agent prepares its editor while preserving the stop, without model generation. A subsequent human message resumes the same Run; selection, model changes, and notice acknowledgement alone do not. Recovery restores an execution fence and any captured native-input checkpoint, not an interrupted tool. See [quota suspension](run-supervision.md#quota-suspension).

Recovered ordinary Agents and Moderators begin dormant. Observation and `/agents` do not resolve Runtime configuration, create Pi services, start a Run, invoke a model, or append transcript evidence. A later ordinary Message prepares a fresh Runtime by resolving the current ancestry, captured `creationPreset`, accepted canonical explicit Spawn configuration, resources, trust, native project context-file loading, and explicit system prompt. If the Spawn input was rejected, preparation uses the current ancestry and captured preset without overrides from that call, including when preparing a dormant ancestor. It does not re-select the original Template name. Fresh preparation also loads the descendant discovery and safe catalogue before starting work through the participant's normal role-bound Run path. Native interaction becomes available after that session is live and retained.

The [Agent selector](agent-selector.md) presents Live rows in creation hierarchy and Dormant rows by Pi session recency. Dormant recency uses the latest user or assistant activity time, then the native session creation time. Unfiltered direct-child search remains in canonical spawn-call order regardless of presentation recency; filtered results use relevance first and that order as their deterministic tie-breaker.

## Residual Requests

Before every newly started Run proceeds, the host inspects complete physical current-scope evidence for that exact Agent. This includes evidence on abandoned branches and evidence summarized by later compaction.

- `awaiting_answer` is initialized for each canonical Request authored by the Agent that has neither a canonical requester Cancellation nor Answer Delivery.
- `answer_owed` is initialized for each canonical Request delivered to the Agent that has neither a canonical Answer commit nor Cancellation Delivery.

Creation Requests use the same predicates after verified child Identity makes them canonical. Durable Request Delivery, Answer, and Cancellation evidence reconstruct outstanding obligations, attention ordering, and Agent-owned outbound dependencies. Before new model authorship, startup reconciles model attention against the coordinator's verified obligations, including requester-side Answer proof that preceded the responder result. This reconciliation is volatile and refreshed on every execution; historical focus snapshots grant no obligation authority. Recovered relationships are exact Request-keyed Run Retention Reasons; they are not a durable or Workflow-global obligation store.

A valid recipient Request Delivery preserves its Answer obligation even when the
authored Request source is rejected. Answer commitment can resolve that local
obligation using the delivered metadata; with no authored Request, no new Answer
Delivery is scheduled. Rejected Answers cannot discharge obligations through old
receipts or focus snapshots. Missing-source Requests are not reconstructed for
retry, cancellation, Wait, or Workflow continuation; skipping is neither
cancellation nor permission to repeat external work.

Quarantining a peer does not erase relationships that the verified Agent's own transcript proves. Those local Retention Reasons return, while an operation that needs the quarantined peer's source transcript fails with `evidence_unavailable`.

Except for an explicitly retained quota-suspension fence and its Run sequence, cold bootstrap reconstructs no per-responder Request queue, general delivery queue, Delivery Invocation, pending scheduling, previous Run, Run sequence, model turn, Operational Incident, Handling Key, Moderator attempt chain, exhausted Operational Attention, or automatic Message replay. Waiting Request order and every other uncommitted item remain lost. Transcript proof, polling, and explicit same-identity retry remain available. A fresh explicit [Agent Wait](agent-messaging.md#join-outstanding-answers) renews intent for its fixed snapshot and ensures same-identity scheduling for captured unanswered, undelivered Requests through normal admission, which may start a Dormant recipient. This is not cold-start replay: unfinished Wait calls are not reconstructed, and ordinary Messages and unrelated Requests remain unscheduled.

## Explicit Workflow continuation

After reopening the Owner session, call `workflow_resume({})` to renew continuation intent across that current Workflow. Only the Owner has this tool; it takes no Agent or Workflow selector. Cold bootstrap stays passive.

Successful admission already schedules eligible pending deliveries and continues eligible unfinished Requests; extra resume/wake-up Messages or replacement Requests are unnecessary. Messages carrying genuinely new instructions remain appropriate. Read blocked or indeterminate entries before choosing targeted recovery rather than treating the receipt as Delivery or completion proof.

Both the Owner's tool result and each resumed Agent's runtime continuation contain the same `outstandingRequests` array, scoped to that recipient's own outbound Requests in the recovery snapshot. Each entry gives `requestMessageId`, `targetAgentId`, `status`, and a `reason` when needed:

- `continuation_admitted`: the responder's continuation was admitted.
- `already_running`: the responder already owns running or queued continuation input.
- `delivery_scheduled`: original Request delivery is scheduled; no duplicate wake-up is needed.
- `blocked` or `indeterminate`: inspect the reason before targeted recovery.
- `resolved`: the delivered obligation resolved during admission.

These are admission-time facts, not promises about later execution. Requests already verified resolved or not created are omitted. Failed Message authoring calls verified not created are also omitted from recovery; contradictory Delivery or unavailable target proof still surfaces as an evidence error. Unavailable target evidence is reported on the affected outbound Request. The result is recipient-relative, not a report of every recovery operation in the Workflow. Continuations do not repeat incoming obligation identities or contents: restored Request relationships remain authoritative.

The tool renders the Owner's outbound Requests with their target, recovery status, and relevant reason. Compact rows abbreviate identities; expanded rows show full identities. An empty view says there are no outstanding outbound Requests for this recipient, not that the Workflow has no unfinished work.

Recovery takes a fixed snapshot of verified durable evidence, then admits work through the normal recipient lanes:

- Undelivered Messages and Requests retain their original identities, authorship, recipients, payloads, Delivery modes, and context preparation. Request titles and Delivery modes remain canonical. Deferred eligibility uses cooperative boundaries, not ancestry; Background still waits for settlement with no reconstructed Answer obligations owed or eligible higher-priority work.
- Successfully committed, undelivered supervisory resume Messages are included. If their process-local Hold reservation is gone, they recover as ordinary Steer direction and cannot clear a newer Hold. Live resume reservations coalesce without consuming ordinary capacity.
- Committed undelivered Answers return to their original requesters, not to the Owner requesting recovery. Completed responder work is not restarted.
- A dormant responder with delivered, unanswered Requests restores its transcript, outstanding obligations, attention ordering, and Agent-owned dependencies before a successor Run receives runtime-generated continuation input. The original Request is not redelivered and still owns the work; recovery authors no replacement Request or ordinary Agent Message.
- The continuation explicitly says that the Owner requested continuation and instructs the Agent to inspect interrupted operations before repeating them. Coordination recovery cannot determine whether an interrupted command already produced side effects.
- Runs already owning input or model activity remain running without duplicate continuation input. An empty successor started by a causally blocked sibling can receive the outstanding-obligations continuation in that same Run. Ordinary delivered Message history alone never justifies restarting a dormant Agent.

Recovery orders Agents by Agent ID and Messages within each Agent by physical author source order. Dormant obligation continuations are admitted before pending deliveries, to bring recovered obligations to attention. Competing admissions can still start an empty successor first; recovery checks input ownership in the recipient lane rather than treating existence of a Run as continuation. Continuation dispatch is gated until all recovery admissions have outcomes and all recipient-relative views are finalized. The gate holds no recipient lane, so cyclic delegations do not deadlock; queued sibling input cannot pass the unfinished gate. Admission failures still release the gate, while normal suppression and Run fences discard stale continuations. This is a new admission order from the snapshot, not a restoration of the lost waiting queue. Normal causal eligibility, capacity, applicable live Holds, and exact Run fencing still apply. Queued, reserved, and in-flight scheduling coalesces with recovery; live cancellation and completion suppress stale work. Repeated calls do not duplicate Delivery or continuation activation.

The call returns when recovery is admitted, not when the Workflow finishes. Its result contains only `workflowId` and the Owner-scoped `outstandingRequests`. Recovery still schedules work across the Workflow; internal scheduling outcomes are used to derive each recipient's view, not exposed as a separate global receipt. Admission is neither Delivery nor completion proof. Failures that cannot be represented on a verified Request—including Answer or ordinary Message recovery and unreadable Owner evidence—surface as tool errors after independent admissions and prepared-recipient releases. Dispatch-release failures also release every prepared recipient before reporting an error. Work may already be admitted or dispatched, so these errors do not imply rollback.

Use per-Message retry for one original authored Message, `agent_wait` for a fresh join of all the caller's outstanding outbound Requests or an explicit selection, and `workflow_resume` for Owner-requested Workflow continuation. Recovery does not restore volatile Wait calls, Promises, or timers. A recovered responder may call a fresh Wait when its next decision requires its restored dependencies.


## Owner resource reload

An Owner `/reload` ends ordinary coordination Runs before admitting the newly loaded extension. The native Owner conversation/editor is retained, but the old coordinator is never reused as proof that saved data is valid. Fresh cold discovery and fresh transcript projections validate the relevant Owner, child, and Moderator evidence under the loaded protocol.

- Admission and scheduling are fenced during shutdown and revalidation. Already-running children and ordinary Moderators are stopped, not allowed to keep writing behind disabled Owner tools.
- In-flight work is interrupted, not replayed. After valid admission, recovered participants are dormant and pending Requests remain available. A warning explains that you must check interrupted external effects before using `workflow_resume`; no automatic successor startup or duplicate delivery is introduced by reload.
- Genuine admission failures use the same persistent above-editor blockage and `/agents diagnostics` as cold admission, on the first reload. Ordinary record-shape rejections remain non-blocking; independently unverified child candidates retain the cold-recovery quarantine policy.
- Cleanup failure prevents replacement. The retained shutdown failure continues to fence later reload attempts; it is not evidence of a repair-safe snapshot. Pi/editor availability does not certify that unmanaged or failed-cleanup writers are gone.
- The latest valid Workflow Policy is retained if a reload policy is invalid. Template resources are captured afresh.

This is a coordination replacement, not transcript repair. Blocked reload offers the same diagnostics, native `/new`, and [safe Owner fork/clone](owner-workflow.md#owner-fork-and-clone) recovery as blocked cold admission. Fork requires successful Owner role identification in the current admission attempt; failure before that checkpoint remains fenced. The new Workflow uses copied conversation without inheriting source authority or resuming source work. [Workflow repair](workflow-repair-operations.md) is separate: it needs verified persisted Owner identity and clean writer retirement, uses a repair-only Moderator, and does not bypass retained cleanup failure. Fork does not run through the suspended ordinary coordinator.

Deployment constraint: shutdown executes the cleanup implementation captured when the Workflow was initialized. Installing this change cannot strengthen an already-running coordinator's cleanup closure. For the first upgrade to this shutdown contract, stop active work and restart the host before relying on reload quiescence; an in-process upgrade from an earlier implementation is not a proven repair-safe snapshot.
