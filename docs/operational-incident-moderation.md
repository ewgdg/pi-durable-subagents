# Operational Incident moderation

The host starts an isolated Moderator when live coordination evidence matches an Operation Review, Obligation Stall, Run Failure, Dependency Deadlock, or Delivery Stall. Operational Incidents are transient observations of blocked obligated work, not durable Agent or Workflow lifecycle states.

## Detection

Host state changes share one pending reconciliation. Each scheduled pass yields to native events before inspecting current evidence; changes during that inspection schedule a fresh successor pass. A safe-boundary wait includes passes queued before the wait. Creation Request lookup follows the child's Identity to its Spawner's committed source without scanning unrelated Agent histories.

An Obligation Stall exists while an ordinary Agent Run is live, settled, still owes an Answer, and has no admitted input, pending Delivery, Human attention, interactive selection, Interruption Hold, or outgoing Request path that can make progress. Before creating a Moderator for a simple Stall, the host delivers one model-visible `agent-coordination.obligation-reminder` for the exact Request. The reminder contains the Request identity, its canonical title, and direct Answer guidance; it does not repeat the Request body.

Reminder suppression is per durable Request identity. A successor Run or a later recurrence with the same unresolved obligation does not receive another reminder. The reminder uses ordinary Deferred custom Delivery scheduling and supplies its own model turn. If the Agent settles again without discharging that obligation, the host creates the Obligation Stall Moderator. A closed Dependency Deadlock is handled as one normalized condition instead of also reminding or independently moderating its member Stalls.

An Operation Review exists when an independently watched root Pi tool call reaches its review deadline while still unresolved and its Agent still owes an Answer. A Pi tool batch is effectively blocking when any call in the committed batch declares sequential execution; otherwise its calls are asynchronous. Blocking review begins at execution admission. Asynchronous review covers only a continuous unattended Idle interval and ends when Agent work resumes before expiry. Each call uses the Workflow Policy interval captured at admission.

Human Request setup is reviewed from execution admission until Human waiting begins. Human waiting is excluded. Human Answer arrival starts a fresh result-commit interval until the terminal tool result commits. Progress, logs, heartbeat, partial output, and internal awaits do not affect review. Expiry establishes only the need for review: it does not abort, retry, interrupt, terminate, or declare the tool's outcome.

Resumed attendance ends an asynchronous interval only before its deadline; once that interval expires, later attendance alone does not clear the review. Before Moderator Input commits, terminal tool-result commit, final Answer Obligation clearance, or Human waiting still suppresses the condition. After Moderator Input commits, Human waiting also cannot clear it; the tool must resolve, the final qualifying obligation must end, or a Moderator must renew the interval.

A Run Failure exists after one exact non-Moderator Run, including a Workflow Owner Run, ends unexpectedly after Pi's user-configured native recovery behavior has finished and the Agent still has an unresolved Answer Obligation. The condition clears when every qualifying obligation ends or a successor Run successfully starts. When a successor starts, the host delivers a visible `agent-coordination.run-failure-recovery` to the handling Moderator at its next settled boundary, directing immediate Resolution; the remaining Answer Obligation is ordinary Workflow work. A successor that later settles without progress is evaluated independently as an Obligation Stall.

Reporting is broader than moderation eligibility: every unexpectedly terminated ordinary Run receives a runtime-authored Report, including Runs without Answer Obligations. The report identifies the exact Agent and Run, observed error, failure stage and provenance, incoming obligations and outgoing Requests, and uncertainty about recovery. Host-observed startup errors are retained even before the child can record an error. Repeated observation of one failed Run does not publish again; a different failed Run has its own report identity.

Native/provider recovery still in progress is not terminal failure, and a successful retry creates no failure Report. The current Pi lifecycle exposes retry intent but no structured terminal quota-suspension discriminator. Reporting preserves those native signals rather than guessing quota suspension from provider error text.

An incoming upstream dependant cannot itself supply progress, and an ineligible queued Delivery is not progress. Outbound dependencies belong to the Agent regardless of attention order; a selected Wait narrows only that join, not general dependency tracking.

A Dependency Deadlock is a normalized closed component of current ordinary Runs. Every member must be live, settled, retained solely by unresolved Request relationships internal to the component, free of required attention and Holds, and have no other progress source. Self-cycles are valid components. Only unanswered Requests contribute dependency edges: a committed Answer no longer requires responder progress even while its requester-side Delivery remains outstanding for Wait. Any outgoing unanswered Agent-owned dependency outside the component, active or starting Run, admitted input, selection, Human attention, Hold, failed Run, or non-Request retention prevents declaration.

Deadlock detection is observational. It does not cancel a Request, interrupt or terminate a Run, control descendants, or grant authority.

Clean Run release, deliberate termination, orderly shutdown, optional work, ordinary model duration, Human waiting, and intentional Holds do not create Run Failure or Dependency Deadlock handling. Operation Review never times model generation or internal coordination machinery, including a parked `agent_wait`; the existing Request graph remains eligible for Dependency Deadlock observation. Primary interactive human input or an eligible inbound Agent Request preempts the parked Wait through normal coordination, so human redirection and reverse-Request flows do not depend on Dependency Deadlock moderation.

## Delivery Stall

A Delivery Stall is observed when an unresolved Answer Obligation depends on a Message whose delivery machinery has lost its continuation or exhausted its progress interval. The dependency is traced through outstanding Requests from an obligated ordinary Agent, including a parent parked in `agent_wait`. The undelivered recipient need not owe an Answer yet, and the path need not form a cycle. Pending retention alone is not evidence of progress.

Delivery progress uses the admission-time `deliveryProgressIntervalMs` from [Workflow Policy](workflow-policy.md):

| Transition or observation | Deadline effect |
| --- | --- |
| First observation of eligible pending scheduling | Start the captured interval |
| Frozen scheduling reservation, then dispatch to Pi | Reset at each meaningful transition |
| Transcript Delivery proof or Request suppression | Clear observation and handling |
| Execution-capacity wait, active recipient work before dispatch, or admission behind an existing Answer Obligation | Suspend; follow outstanding Request dependencies rather than timing the wait |
| Human attention, interactive selection, or intentional Hold on the recipient | Suspend; regain eligibility with a fresh interval |
| Poll, heartbeat, repeated state observation, or policy reload | No extension |
| Scheduling/dispatch exception with no continuing delivery path, including startup/admission exits before dispatch | Immediately request investigation once a qualifying obligation path exists |

A dispatch Promise can cover the entire Pi model turn. It is not Delivery proof, and waiting for its completion must not time model generation: transcript commitment ends delivery observation independently of that Promise. A proven Deferred Delivery may retain its dispatch reservation for prompt ownership and serialization, but that reservation is not an external progress source that excludes a parked `agent_wait` from Dependency Deadlock handling.

Human waiting, selection, and Holds anywhere along a qualifying path exclude that path. Active or starting intermediate Agents remain legitimate progress sources. An obligated parent doing ordinary model work does not qualify just because a child delivery is pending. Run termination does not cancel Requests or exempt stranded delivery work: an unproven Delivery losing its recipient Run remains observable as a known scheduling failure while an upstream obligation still qualifies. This does not restart the recipient or turn deliberate termination into Run Failure handling.

A known scheduling failure remains blocked while its recipient processes unrelated input: an ordinary nudge or successor Run does not restore the lost Message continuation. Only renewed scheduling progress, proof, suppression, explicit wait/exclusion, or qualifying-path clearance can end that condition.

One continuous blocked Message produces one handling instance containing affected Agent identities, bounded canonical Request source pointers along the dependency, the exact Message and recipient identities, and either the observed scheduling diagnostic or the expired stage and interval. Other triggers retain their contracts; affected Delivery Stall paths do not also receive simple Obligation Stall reminders. The condition ends when proof, suppression, meaningful progress, a legitimate wait/exclusion, or final qualifying obligation clearance removes the blockage. Later recurrence is independently handled.

Detection does **not** establish a delivery outcome, retry a Message, recreate scheduling, cancel Requests, duplicate Delivery proof, or authorize new Moderator operations. Existing explicit Message Retry semantics remain unchanged.

## Continuous conditions

Each trigger has a deterministic transient Handling Key:

- Obligation Stall uses the affected Agent and sorted qualifying Request identities after any required reminder has been delivered.
- Run Failure uses the affected Agent and exact Run sequence.
- Dependency Deadlock uses sorted component Agent and Request identities.
- Operation Review uses the exact root tool-call pointer.
- Delivery Stall uses the blocked Message identity, aggregating current qualifying upstream paths.

The key suppresses duplicates only while that exact continuous predicate remains true. Relevant Run, Request, Delivery, input, selection, attention, and Hold transitions revalidate all current conditions. Clearing a predicate releases its key and the current Moderator's `moderator_handling` retention without aborting the Moderator or settling its ordinary Requests.

## Atomic Moderator bootstrap

Before starting a Moderator Run, the host commits one visible `agent-coordination.moderator-input` as the first transcript entry. It contains:

- the fresh Agent and Workflow relationship;
- fixed `moderator` metadata;
- the captured `creationPreset` (or `null` when the reserved Template is absent);
- one trigger snapshot;
- up to 16 exact qualifying Request sources;
- inspection watermarks for every affected Agent;
- for a replacement, the previous attempt's terminal transcript pointer.

Failure before this commit creates no Agent and consumes no attempt. A committed Input creates a standalone Moderator with no Direct Spawner, even if startup or its Run then fails. After Runtime admission, the host sends a hidden `agent-coordination.moderator-routine-start` message through ordinary public delivery to start the model turn; the durable identity and incident remain together in the preceding Input. Each new Moderator Runtime dynamically resolves the current Owner Runtime, the captured `creationPreset`, resources, trust, native project context-file loading, and explicit system prompt. It never re-selects the reserved `moderator` Template. Without a captured model selection, it inherits the Owner model but lets Pi apply the shared default thinking level instead of inheriting the Owner's effective level. Those resolved values are not part of Moderator Input.

An Operation Review trigger contains only `kind`, the exact `toolCall` pointer, and the elapsed `reviewIntervalMs`. It carries no inferred outcome, internal-stage details, deadline timestamp, adapter state, or eager diagnostics.

## Moderator handling reminders

The initial Moderator routine-start uses ordinary Deferred custom Delivery scheduling. Its pending native startup is progress even before the child reports `agent.start`; the first handling attempt must not be mistaken for settled, abandoned handling. Native transcript proof and settlement release that initial delivery through the same scheduler lifecycle as other inputs.

A live, settled Moderator that still owns incident handling receives one visible `agent-coordination.moderator-obligation-reminder` when it has no Delivery progress, Human attention, interactive selection, Interruption Hold, unresolved asynchronous call, or outgoing Request path supplying progress. An intentional parked Wait is excluded. The Deferred custom Delivery scheduler retains the reminder until the native Runtime is idle, then starts a model turn rather than merely adding transcript context. Conditional handling reminders never enter a native queue behind active work.

The reminder directs inspection of the original Moderator Input and current affected Agent/Request evidence, continued handling, and `moderator_control` Resolution only after the original condition and the Moderator's Request responsibilities clear. It does not instruct the Moderator to Answer an incident as though it were a Request.

Each fresh Moderator Input assigns one handling responsibility to one fresh Agent. Durable reminder proof and Delivery identity bound reminders to one per such responsibility, including across successor Runs. A replacement Moderator has its own responsibility and reminder allowance. Native preparation precedes an authoritative handling check. That check and native transcript acknowledgement are ordered on the same reconciliation lane as handling clearance and Resolution: clearance first suppresses the reminder; commitment first records a valid reminder before clearance. Raw evidence writers are not distributed-locked. Enqueue acknowledgement is not delivery proof. Busy preparation, suppression, cancellation, and failed admission release the native reservation without clearing unrelated queues. Clearing handling requests automatic dormant release; outstanding Requests or other legitimate retention still prevent release.

Settling again after the reminder does not create recursive moderation, consume a failure attempt, or imply Resolution. The handling remains retained until its predicate clears. Further automatic escalation of a non-failing Moderator that ignores its reminder is not defined here; terminal failure continues to use the existing bounded replacement policy below.

## Bounded handling failure

One continuous condition permits at most two committed automatic attempts: the initial Moderator and one fresh replacement. A post-commit startup failure or terminal Moderator Run failure consumes its attempt. The replacement continues the original condition and points to the first attempt's terminal evidence; Moderator failure never becomes a nested Operational Incident.

Failed Moderator attempts are grouped beneath the original incident's runtime Report, not reported as unrelated failures or recursively moderated. If no report exists yet, the first failed attempt publishes one. Each attempt retains its Agent identity, exact Run when admitted, observed error/stage, and diagnostic and transcript evidence. After the second committed attempt fails, automatic creation stops and an exhaustion finding records that recovery remains unresolved. Owner surfaces show the unread Report in the Attention Inbox and separate live unresolved status, never a competing unacknowledgeable `ATTENTION` row for the same report. Reading the Report does not clear that live condition; the condition ends only when its predicate clears.

## Unavailable moderation and Owner attention

The moderation reconciliation boundary contains evidence-inspection and Moderator-creation failures. It retains a non-model-visible `agent-coordination.operational-diagnostic` entry in the Owner transcript with the error message and full stack, then publishes one runtime-authored Report referencing that exact diagnostic entry and transcript path. It does not invent a Moderator, Agent author, or reporting tool call.

The Report explains the failed stage and error, captured original trigger and affected Agent identities/labels, qualifying Request source pointers and identities, inspection watermarks, committed attempt count, any known Moderator and previous-attempt evidence, observed outcome and uncertainty. When inspection fails with existing handling, its captured incident facts remain available but are explicitly not revalidated. When no incident has been established, it says no trigger or affected Request graph was established: the Owner hosts the diagnostic and Report, not an invented affected culprit.

`Moderation Unavailable · live status` remains visible outside the Attention Inbox. The inbox contains the unread Report, not a second unacknowledgeable `ATTENTION` row. This is not a Moderator trigger or durable failure state. When the incident already has a runtime Report, the unavailable-moderation diagnostic is appended as a finding under that Report rather than publishing another notification.

A watchdog uses the current delivery-progress policy interval to publish the same kind of Report and live status if the inspection/bootstrap pass is still blocked. The Report distinguishes a missed completion deadline from a terminal failure. Both initial Moderator creation and replacement preparation after a terminal Moderator failure run within this timed containment; immediate replacements share their enclosing pass. It does not abort the Promise, unlock a lane, retry scheduling, or infer whether effects committed. Repeated activity does not duplicate Reports or diagnostic entries for the continuous fault, including after the Report is marked read. A creation exception retains faulted handling and stops further staging for that continuous condition, including failure before the first Moderator Input commits. Heartbeats, safe-boundary checks and unrelated activity do not retry preparation. Condition clearance releases the faulted handling; a later recurrence starts fresh. A preparation that only exceeded its deadline may still finish, without cancellation or another attempt. A successful inspection clears inspection status; successful creation or original-condition clearance clears creation status. Report history and Read State are retained. Clearance followed by recurrence publishes a new Report. Failure before Moderator Input commits consumes no committed attempt, but is not permission for repeated staging; committed handling keeps the existing two-attempt bound.

This is the scoped containment required for delivery-blockage detection. It does not decide the broader participant lifecycle containment, fencing, or cleanup policy discussed in issue #75. Core evidence scanners continue throwing; no malformed-call race or scheduler-recovery behavior is changed. Reports and live unavailable status belong to the Owner surface, including the shared `/agents` view when a child Runtime supplies the selected presentation; it is not a generic Pi extension-error chat row.

## Diagnosis, escalation, and Resolution

A Moderator can inspect any known Workflow Agent and control any current non-Owner Run, but cannot control the Owner or itself and never receives `agent_spawn`. Every Message, Request, Human Request, observation, and control operation remains authenticated as the Moderator's own identity.

Task intent, priority, value, policy, risk, irreversible effects, and requested Owner action use an ordinary Agent Request to the Workflow Owner.

`moderator_control` can renew any current reviewed call in the same Workflow. `renew_review_deadline` selects the exact tool-call pointer, a positive `nextReviewInMs` no greater than the call's captured policy interval, and a rationale. The host revalidates the source, terminal result, and Answer Obligation before returning `renewed`; an expected completion race returns `stale`. Renewal starts only that call's selected interval immediately. Because renewal deliberately replaces an established condition, later attendance does not cancel that selected interval. Renewal never inspects, restarts, retries, interrupts, or otherwise changes the tool or Run.

`moderator_control` also records the handling summary and rationale. Resolution is blocked while the Moderator has an incoming or outgoing Request relationship or its mechanically checkable original condition remains. A Run Failure Moderator resolves immediately after its successor-start recovery notice and does not wait for the original Answer Obligation or adopt later Requests. Once clear, Resolution reports `resolved` when an original obligation still exists behind a credible progress source, or `already_cleared` when the original obligations ended.

## Nonblocking runtime defect reports

Investigate first: preserve exact evidence and attempt safe autonomous recovery. At the end of an investigation, use Moderator-only `report_to_user` for a suspected runtime defect, **not** `ask_user`. Report the symptom, why a defect is suspected, remaining uncertainty, recovery actions and observed outcome, and evidence references. A report is a suspicion supported by evidence, not a confirmed defect or a request for human judgment.

Before claiming a missing tool result or crash, obtain current Agent status, read `primaryEvidence.transcriptPath`, and match the exact `toolCallId` against `toolResult` entries across the physical transcript. Verify and cite the current physical tail entry ID and timestamp. `inspectedThrough` records an earlier observation; it is not a promise that no later entries exist. A selected branch, truncated excerpt, prior report, or scheduling diagnostic is not proof of the current tail or a runtime cause. Cite the call, matching result (if present), and verified tail; state the inspection limits and mark claims unverified when primary evidence is unavailable. An absent result alone does not establish a crash. This is investigation guidance, not a new report-admission gate.

The tool commits an immutable report to the Workflow Owner's durable transcript and immediately returns its report identity and creation timestamp. It does not wait for the user, create a Human Request or Agent Request, discharge an Answer Obligation, terminate the Moderator, or resolve handling. An unresolved incident still requires recovery; `moderator_control` retains its normal Resolution predicates. Reports can also be published after recovery has cleared the original condition.

Every Moderator-authored Report captures the stable reporting Moderator identity and label, timestamp, original transcript path, assistant entry ID, and exact reporting tool-call ID. Replaying the same committed source returns the original report rather than revising it. Publication and explicit read-state changes are separate Owner custom entries; neither depends on the current Moderator Run or incident lifetime.

Runtime-authored Reports use the same retained report store and explicit read-state records, with `source.kind: "runtime_diagnostic"` and an entry pointer instead of a tool-call pointer. They omit the Agent reporter. Process Control snapshots carry both report kinds. The source diagnostic identifies one publication; replay returns the original immutable Report, never revised findings or a fresh unread notification.

Later recovery observations are separate immutable `agent-coordination.moderator-report-finding` entries linked to the original Report. The report view and copied Markdown include these dated findings: Moderator starts and failures, exhausted attempts, successor starts, and condition clearance where observed. A successor start proves resumption, not successful completion; condition clearance does not prove the underlying defect was repaired. Each genuinely new retained finding marks the same Report unread again, restoring its single inbox row without rewriting the publication. Replaying a previously retained finding does not change read state. Mark read acknowledges all findings currently recorded, without affecting recovery. Reopen a report to inspect findings recorded since it was opened.

A permanent child-launch contract rejection also publishes a Runtime Report immediately, even when no Operational Incident or Moderator exists. It records the sanitized diagnostic and the single remedy that diagnostic prescribes: restart the Owner host, or repair the installed extension before restarting when a fresh Node process cannot import its child launch contract. Repeated launches cannot clear the block or create duplicate notifications; reading the report only acknowledges it. See [Runtime preparation and Run admission](child-ui-context.md#runtime-preparation-and-run-admission).

### Human review

Both Moderator and runtime Reports appear in `/agents`. Unread reports appear as `REPORT` items in the **Attention Inbox**. Enter opens a dedicated read-only report view—not a live transcript, new Agent, or new session. The **Reports** tab retains all report history, including read reports.

- **m Toggle read** toggles the report’s read state. Mark read removes pending report attention; Mark unread restores it. Use it on a selected report in the Attention Inbox or Reports tab without leaving the menu, or inside the report view. The separate Read/Unread status shows the current state and the report always remains in history.
- **c · Copy report** copies the full ticket-ready Markdown report, including provenance and evidence.
- **v · View reporter** is available only for Moderator-authored Reports and switches to the stable reporting Moderator's current context using ordinary Agent selection. The report retains input focus and shows loading until preparation completes; failure stays visible in the report for retry.
- **Esc/q · Back** closes the report. Opening, closing, copying, or viewing the reporter does not acknowledge it.

View reporter deliberately does not rewind the Moderator's current conversation. The exact original transcript path, entry, and tool-call reference remain in the report and copied text, so the investigation can be located despite later work. Installed Pi exposes `switchSession` and `navigateTree`, but these replace the active session or move its branch leaf; neither is a read-only jump to an arbitrary transcript entry. Therefore reports do not invoke them. Pi's native `/tree` can be used in the reporter context to inspect the original investigation; selecting a tree entry changes the active branch. The original JSONL can also be inspected using its retained source reference.

Runtime Reports offer no reporter navigation; their full diagnostic path and entry identity remain visible and copyable. Terminal rendering sanitizes Report text rather than executing embedded control sequences. Marking a runtime Report read does not dismiss live unavailability, retry creation, reset the attempt bound, or claim recovery.

No ticket is filed automatically and no report file is exported. Clipboard availability follows Pi's native clipboard support.

## Cold recovery

Cold discovery validates committed Moderator Inputs and admits valid Moderators as standalone dormant Agents. Recovered Moderators remain routable and restart with the Moderator toolset.

Recovery reconstructs no timer, review interval, attendance, live condition, Handling Key, automatic attempt budget, previous Run, exhausted Operational Attention, scheduling, or Moderator reuse. Current live evidence after recovery must establish a fresh condition. If a cold-recovered Moderator later fails, its validated committed Input links the failure to its originating incident's retained Report when available, or supplies evidence for a new grouped Report. This historical linkage does not resurrect handling or schedule a replacement. Cold uncertainty and bounded Request evidence are explicit.

Reports, linked findings, and their latest read states are reconstructed from the Owner transcript on cold recovery, independent of whether the original incident still exists. Unread report attention persists; read report history remains accessible. Ephemeral or externally deleted Workflow transcripts cannot provide durable history. Pi does not persist a new Owner session until its first assistant entry: Reports, findings, and read-state changes published before that point share the native in-memory lifetime and cannot survive host loss unless Pi subsequently persists the session. This feature does not force a flush or synthesize assistant entries.
