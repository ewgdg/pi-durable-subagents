# Workflow-owned transcript repair — proposed design

Design for [#129](https://github.com/ewgdg/pi-durable-subagents/issues/129).
**Not implemented; repair mechanics remain proposed.** `/agents repair` remains unavailable.
This document separates the proposed contract from existing behavior. It does not
authorize an autonomous repair engine or implement a missing-title migration.

## Goal and recommendation

Let a verified Owner with damaged coordination evidence ask a Moderator belonging
to its own Workflow to prepare repaired transcript copies. The host, not the Moderator, proves that the
copies validate, obtains approval, replaces the originals, and reopens the Owner
from disk. During the exclusive repair transaction, ordinary transcript writers
are paused; outside it, availability is determined per operation rather than by
the mere presence of invalid historical evidence.

### Accepted availability direction

[#131 — skip-and-mark replay](coordination-replay-rejection-design.md)
supersedes the earlier partial-admission proposal. Invalid coordination record
shapes have no protocol effect and do not block admission; their evidence stays
visible as informational context. Valid obligations remain. There is no
uncertainty graph or separate verified-identity/availability interface required
for ordinary navigation. Identity, membership, and bootstrap validation remain
strict.

`/agents` uses the admitted Workflow's existing participants, including
Moderators. Genuine admission failures retain diagnostics and safe recovery,
not invented membership. The repair-only navigation and writer exclusion below
remain proposed repair mechanics; they are not prerequisites for ordinary
navigation. A future repair writer fence is a temporary consistency requirement,
not a consequence of rejecting a historical coordination record.

### Proposed repair scope

- One repair transaction per Workflow; one fresh repair-only Moderator per attempt.
- Explicit human approval of the entire validated multi-file changeset. No
  per-file application and no deterministic-repair preauthorization initially.
- Hold exclusive writer access from snapshot through successful admission or
  completed rollback. Owner conversation is paused during that interval;
  diagnostics, repair progress, and cancellation stay usable outside conversation.
- On success, reopen automatically but leave recovered participant Runs dormant.
  Do not call `workflow_resume` or replay interrupted tools automatically.
- Refuse application when writer exclusion or durable identity cannot be proved.
  An idle editor, unchanged hashes, or a Moderator saying “fixed” proves neither.

## Existing facts and missing capabilities

| Fact | Evidence / consequence |
| --- | --- |
| Owner identification precedes coordination replay; failed admission retains a boolean identification checkpoint and diagnostics, not a healthy coordinator. | [`owner-bootstrap.ts`](../src/bootstrap/owner-bootstrap.ts), [`index.ts`](../src/index.ts). Retain a verified identity descriptor for repair rather than calling the failed coordinator. |
| Ordinary Owner identity adoption may append a fresh cutoff, including for copied identity evidence. | [`owner-identity.ts`](../src/protocol/owner-identity.ts). Repair must not invoke adoption as a way to invent membership or erase invalid evidence. |
| Moderators have a Workflow identity and no Direct Spawner. Existing bootstrap commits incident input before starting a Run. | [`moderator-input.ts`](../src/protocol/moderator-input.ts), [moderation](operational-incident-moderation.md#atomic-moderator-bootstrap). Reuse that relationship, not child Creation Requests. Existing incident inputs and report tools still depend on ordinary coordination. |
| Owner reload shuts down managed participant Runs and rebuilds coordination projections, not the active native transcript. | [Reload contract](cold-host-recovery.md#owner-resource-reload), [`WorkflowCoordinator.shutdown`](../src/coordination/workflow-coordinator.ts). Cleanup failure is a blocker, not proof of quiescence. |
| Cold discovery can quarantine candidates and still admit a partial Workflow. | [`cold-host-discovery.ts`](../src/bootstrap/cold-host-discovery.ts). A successful ordinary admission alone is too weak to certify a repair. |
| Current blocked-admission guards cancel native resume. | [`index.ts`](../src/index.ts). Repair needs a narrowly scoped reopening authorization, not a blanket exception for resume. |

The [Pi session-replacement investigation](research/pi-session-replacement.md)
owns the native lifecycle evidence. Its bounded probe confirms that Pi 0.85.1
opens the destination **before** abort/shutdown: a final shutdown append reaches
disk but is missing from the replacement manager. Current upstream retains that
ordering. The extension runner also catches shutdown-handler errors, so awaiting
native shutdown does not prove successful cleanup. Implementation must establish
writer retirement, pre-open recovery, and explicit admission acknowledgment
before enabling application; these capabilities do not exist in this project
today.

## Bootstrap identity and authority

The Owner bootstrap retains a repair descriptor independently of ordinary
admission: canonical Owner Agent ID, Workflow ID, native session ID, canonical
persisted path, and the exact identity-entry cutoff used at the successful
identification checkpoint. For an Owner, Agent ID and Workflow ID match the
native session ID. Also retain the failed-admission stage and cleanup outcome.

Before acquiring the fence, this descriptor is only a hint for locating the
affected paths and lease, not authority to create repair membership. After all
writers drain and the snapshot is frozen, a read-only identity check compares
the descriptor with the snapshot's native header and current-scope identity
evidence **under the lease**, before committing any repair Moderator bootstrap.
Reject absent persistence, ambiguous identity, a child or Moderator role,
conflicting paths/IDs, or identity that cannot be established without rewriting
it. The current `ownerIdentified` boolean alone is insufficient. A stale or
unavailable descriptor requires identity verification again, never Request/Answer
replay. If verification fails, show the limitation; native `/new` and existing
safe-fork eligibility rules remain unchanged.

Commit a versioned repair bootstrap record before starting model work. It binds
a fresh Moderator Agent ID to the verified Workflow ID, `directSpawnerAgentId:
null`, captured Moderator preset, transaction ID, Owner identity pointer, and
snapshot manifest digest. This is a **repair-only** input, not an invented
Operational Incident, ordinary Request, or unrelated Owner Workflow.

Keep this record, the repair Moderator transcript, reports, and transaction
journal under a dedicated repair directory alongside (not inside the ordinary
participant JSONL discovery set for) the verified Workflow. The repair store is
authoritative only for repair membership and repair progress. Its reader checks
identity bindings without inspecting ordinary Message history. Normal cold
discovery must not reinterpret a repair Moderator as an ordinary participant.
After completion it remains an archived Workflow-owned repair participant,
visible through repair history, without ordinary routing or an automatic Run.

The Moderator can read immutable snapshots and write candidate copies and repair
reports in its transaction workspace. The host supplies the task directly from
the committed repair input and starts a repair-only model turn. Dedicated
progress/proposal/completion tools write to the repair store; they do not use
`agent_message`, `ask_user`, `report_to_user`, or `moderator_control` through the
failed coordinator. No spawn, ordinary messaging, live transcript write, Run
control, apply, or approval authority is exposed.

This is a trust-based protocol, not an adversarial filesystem sandbox. Prefer
scoped snapshot-read/candidate-write tools over an unrestricted shell with live
paths. Host checks still enforce the write set and validation. A process that
ignores the writer protocol invalidates the safety claim; it is not silently
treated as a supported concurrent participant.

## Progress and human control

Proposed repair integration would keep host-owned navigation available even
during a genuine ordinary admission failure. The repair feature must establish
its own Workflow membership before exposing a repair Moderator; skip-and-mark
replay does not provide a repair bootstrap. The surface would select the Owner
or this Workflow's repair Moderator, show diagnostics, and expose repair
progress. Selection must not implicitly resume work or lift a writer fence. During
repair the Owner view remains selectable, but conversation writes stay paused;
the repair Moderator operates only on its permitted workspace. If identity is
unverified, expose diagnostics and safe recovery rather than inventing rows or
membership. Ordinary Agent navigation uses the existing admitted Workflow.

`/agents repair` opens the repair surface without successful ordinary admission.
It shows identity, current phase, paused-writer state, snapshot/proposal digests,
Moderator progress and evidence, validation failures, and the last durable
transaction outcome. Reopening this surface resumes inspection of the existing
transaction rather than starting a second Moderator.

The surface offers Cancel before application, Review when validation succeeds,
and Apply only for an explicitly approved current proposal. Model-authored text
cannot grant approval. In a noninteractive host, refusal to apply is the default;
an authenticated host approval interface would be a separate capability, not an
ordinary Message or inferred consent from “start repair.”

During application/reopening, diagnostics read the retained failure, immutable
snapshot, and repair journal, not a potentially mixed set of live destinations.

Approval binds the transaction, full input manifest, exact candidate bytes,
validator/host versions, validation report, and complete write set. Show both a
readable diff and affected-file/entry summary, including deletions and unresolved
semantic uncertainty. Large diffs must remain available in full. Editing a
candidate, adding a file, changing versions, or discovering a new source invalidates
validation and approval. Any semantically ambiguous correction requires a human
decision; passing a shape validator does not prove historical intent.

### Repair review after skip-and-mark replay

Repair is now an explicit correction of historical evidence, not a prerequisite
for using a Workflow that contains rejected coordination records. Keep that
distinction visible in the review: “admission succeeds” does not mean the repair
is necessary, nor that it preserves coordination meaning.

**Concrete failure case:** a rejected Request has no accepted Delivery, but its
text says an external action was requested. Correcting its record shape can make
it an authored Request and a pending Delivery candidate. A later explicit
`workflow_resume` could then dispatch it. Neither a small textual diff nor valid
record shape proves the action was never performed. Keeping participants dormant
at repair completion prevents immediate execution, but does not remove this
later effect.

The proposed review therefore includes a protocol-effect diff, computed with the
same read-only readers on the snapshot and sealed candidate generation:

- Records newly accepted, newly rejected, changed, or removed, attributed to
  their physical Agent/entry/call sources.
- Requests and local Answer obligations introduced, resolved, or removed;
  separately report Answer commitment and Answer Delivery evidence.
- Pending Message/Request/Answer/Cancellation Delivery candidates and responder
  continuations that become eligible or cease to be eligible on explicit recovery.
- Facts that cannot be compared because the original does not project. Label
  these unknown rather than claiming an unchanged or empty before-state.

For each change in protocol effect, the proposal must explain the supporting
evidence and intended correction. The human reviews these effects as part of the
single whole-changeset approval; there is no separate automatic acceptance for
apparently cosmetic corrections. Missing historical intent needs a human
decision, not a guessed Answer, Cancellation, or Delivery proof. Approval does
not itself grant permission to run pending work.

This is a repair audit requirement, not a change to #131's replay policy or a
missing-title migration. The existing
[`inspectCoordinationRejections`](../src/protocol/replay-rejection.ts) reader
provides physical rejection attribution; the recovery selection in
[`workflow-resume.ts`](../src/coordination/workflow-resume.ts) identifies the
observable effects the audit must compare. Do not call `resumeWorkflow` to obtain
the report: it activates responders and schedules Messages. Any extraction of
its read-only selection must preserve ordinary recovery behavior.

Before application, Cancel stops and joins the repair Moderator, archives the
attempt, and releases the writer fence only when originals are known unchanged
relative to the post-drain snapshot.
No automatic participant restart follows. Once application starts, Cancel cannot
interrupt between replacements: finish the bounded apply-or-rollback path first.
After safe cancellation, independently verified capabilities can become available
again under ordinary admission and skip-and-mark replay; cancellation does not
make rejected evidence valid or cancel valid obligations.
Diagnostics remain readable during it. Safe fork/new can proceed after the
transaction reaches a consistent state and the old session's stale writers are
retired; never fork from an unverified mixture or claim rollback restored the
native in-memory session.

## Writer exclusion and snapshots

The host acquires a Workflow-wide exclusive repair lease **before** snapshotting.
All supported Owner and participant launch/attach paths, including cold start,
must honor it. A repair marker must also fence admission after process restart
until an unfinished apply transaction is reconciled. An in-memory lock or PID
existence test alone is insufficient.

The supported host must consult a durable recovery locator by canonical target
path **before opening a native session for writing**. Publish locator entries for
the Owner and every frozen participant path, binding them to the transaction
journal and original identity/hash manifest, before the first replacement.
Also register the participant directory against new attachments. Startup must
find an incomplete transaction even when the destination JSONL is unreadable;
it must not need to recover Workflow identity from that JSONL first. Conflicting
locators block attachment. Locator publication/verification is part of the
pre-apply durable preparation; journal completion governs when it can be retired.
This requires a host startup interface outside ordinary extension bootstrap.
An offline restart without this preflight contract is not sufficient.

Under that lease:

1. Close ordinary admission, scheduling, and new writer attachment before awaits.
   Stop and join all managed child/Moderator Runs, pending spawn/bootstrap writes,
   deliveries, and active-view attachments using the existing shutdown contract.
   A retained cleanup failure prevents repair; do not discard it on reload.
2. Stop new native Owner prompts, tree/session mutations, compaction, extension
   appends, and delayed callbacks; abort active work and join its final writes.
   Retire or fence every native session writer. A UI overlay or `abort()` alone
   is not a write barrier. This requires a verified host capability beyond the
   current coordinator shutdown. Unknown external or older noncooperating writers
   require an exclusive/offline host restart; do not infer safety from quiet files.
3. Enumerate the persisted Owner and entire Workflow participant directory,
   including unreadable and quarantined candidates. Inventory native headers,
   canonical paths and file identities, lengths, content hashes, and scope cutoffs
   where readable. Directory names are discovery hints, not membership proof.
   Freeze the candidate set as well as file bytes; unresolved candidates block
   certification rather than disappearing from the audit.
4. Copy bytes to immutable snapshots and verify their hashes against originals
   while the fence remains held. Revalidate the retained Owner identity against
   these frozen bytes before authorizing the repair Moderator. Record
   absent/present directory state as well as every file. No file is repaired in
   place. Keep candidate copies separate from
   immutable evidence. The repair Moderator's own new transcript is outside this
   frozen set and is writable only in the repair store.

Hold the lease through review, apply, reopening, and admission. Pausing Owner
conversation for review is intentional: allowing it to append while waiting
would invalidate both the snapshot and approval. Cancellation can release that
pause once safe. Detect changed file identity, bytes, directory membership,
lease ownership, or runtime/version context immediately before application.
On any mismatch, do not apply: discard approval and require a fresh snapshot and
review. Hash checks detect broken assumptions; only writer exclusion closes the
check-to-replace race.

**Concrete failure case:** a child finishes a tool after review, appends its
result, and the repair then replaces that transcript with an older copy. A
snapshot hash recorded at review time cannot prevent this loss. Joining writers
before snapshotting and keeping the lease through replacement prevents this
case; an unjoined child makes application unavailable.

## Validation: copies first, normal rules unchanged

Use the same current protocol validators and projection/admission rules as normal
recovery, against a read-only candidate filesystem view. Keep repair transforms
and repair-store readers separate from ordinary validators. Do not add “repair
mode” tolerance, missing-title defaults, or silent historical compatibility.

Submission first stops/joins candidate writers and freezes an immutable candidate
generation, including unchanged snapshot files, **before any validator reads it**.
Validators, report hashes, approval, and application all reference that generation.
Subsequent edits create a new generation requiring new validation and approval;
never pair a report from mutable reads with a later hash of different bytes.

The host validates the **whole frozen Workflow**, not just changed lines:

- Strict physical JSONL/native entry structure and identity cutoffs; no parser
  silently skipping broken lines. Preserve native header IDs, entry IDs, branch
  structure, and identity bindings unless a separately reviewed repair explicitly
  justifies a change. This first scope does not change Workflow membership or IDs.
- Child creation sources, standalone ordinary Moderator inputs, duplicate claims,
  routing identities, and all current-scope Message/Request/Answer/Delivery and
  cancellation relationships across participants, including off-branch evidence
  consumed by the protocol. Copied pre-cutoff context grants no authority.
- Reconstruction of obligations and pending work, recording before/after where
  available. When the original cannot project, state that limitation rather than
  claiming semantic equivalence. No invented Answers, effects, or Delivery proofs.
- Zero unexplained quarantine, missing referenced files, or unresolved candidates.
  Successful admission with skipped records is not a passing repair audit.
- Side-effect-free full recovery/admission rehearsal: no native transcript writes,
  startup, scheduling, reminder/report publication, or identity adoption. Any
  necessary extraction of validation from initialization is an enabling refactor,
  not a second, more permissive validator.

Seal the report and exact frozen-generation hashes only after all checks pass.
Failed validation leaves originals byte-for-byte unchanged relative to the
post-drain snapshot; the Moderator can revise copies and submit a new generation.
Never validate one revision and apply another.

## Application and rollback

Use one host-owned transaction journal with explicit phases:

`quiescing → snapshotted → preparing → validated → approved → applying → reopening → admitted`

Before application, errors end in `blocked` or `cancelled` without repair writes
to originals. Legitimate final writes during quiescing precede the snapshot and
are not repairs. From `applying` onward, failure enters `rolling_back`, then `rolled_back`
or `recovery_required`. The journal records transaction/proposal IDs, manifests,
approval, backups, per-file progress, and failures. Progress is distinct from
ordinary Request/Answer completion.

Before the first replacement, durably record intent and verified backups of
**all** originals in the write set, including file metadata needed for restoration.
Stage replacement files on the destination filesystem, preserve required
permissions, flush them and the journal, and recheck the complete freshness
manifest under the lease. Replace each file with a same-filesystem atomic rename
and durably record progress; flush parent directories where supported. Reject
unsupported filesystem durability rather than claiming a stronger guarantee.
Do not use cross-filesystem moves as atomic replacements.

Several renames are not a multi-file atomic transaction. Safety comes from
excluding readers/writers during application plus a write-ahead recovery record.
At restart, read that record **before ordinary identity adoption/discovery or
native session writing**, compare each destination with original and candidate
hashes, and restore the full original write set for an incomplete transaction.
An unrecognized hash is an external change: do not overwrite it blindly. Keep
backups and journal, fence admission, and require operator recovery.

The durable `admitted` record is the commit point. A crash before it requires
whole-set restoration even if a native switch happened to succeed. After it,
normal authorized writes may have changed hashes; startup must not roll them
back to either manifest. Reconcile the committed locator and perform ordinary
fresh admission instead.

On a rename, flush, or verification failure, stop applying and restore all
originals from verified backups using staged same-filesystem replacement, then
verify the complete original manifest. If rollback fails, retain the fence and
report `recovery_required` with exact file states; never publish a healthy
coordinator. Keep the journal and backups after success or failure for diagnosis.
Cleanup/retention policy is separate from this first repair path.

## Reopening and admission

After replacement, reopen the exact canonical Owner session path through native
session replacement, not `/reload`. The old session's cached entries must never
flush over repaired bytes. The host owns the replacement call and transfers the
repair fence across extension/session lifecycle replacement.

Stock Pi's same-path switch reads too early. The required host route must finish
and verify old-writer shutdown before replacement and before opening the new
manager, and must not run another unfenced old shutdown callback afterward.
Calling `abort()` first or using the synchronous UI invalidation callback does
not establish that ordering for all writers. Prove a supported lifecycle
interface (upstream if necessary); do not patch private native state as a repair
shortcut.

Authorize only this transaction's exact Owner path and expected native identity
through the blocked-admission switch guard. The authorization is single-use and
does not permit arbitrary native `/resume`, native replacement with a participant
session, or a fresh Workflow with fabricated membership. Owner ↔ repair Moderator
presentation switching through `/agents` is separate from this transcript-reopening
authorization. Other native cancellation handlers remain effective.

Do not treat a fulfilled switch call as success. Require an explicit post-start
acknowledgment from the new Owner bootstrap: the native session was reread, its
identity and disk generation match the candidate manifest, fresh whole-Workflow
validation passed without quarantine, and a newly built coordinator is ready.
Keep native/ordinary writes fenced until that acknowledgment; release them only
after the durable `admitted` record. Recovered participant Runs remain dormant.

If switching is cancelled, throws, or admission fails, retire any partially
opened writer first, roll back all originals, and reopen the restored Owner with
diagnostics and fresh ordinary admission. Rejected coordination records remain
informational; strict identity and bootstrap failures still block admission.
Successful rollback does not make the old in-memory session valid. If
restored-session reopening also fails, keep application fenced
and display an out-of-band recovery report; a controlled host restart must
reconcile the journal before attaching the original. Never retry automatically
with the same consumed authorization or start an unrelated repair Workflow.

If writer retirement cannot be confirmed, do not race it with rollback. Enter
`recovery_required` and finish restoration from an exclusive restart. Diagnostics
and a clean native new session remain escape routes once the affected writer is
retired; safe fork additionally requires a verified, consistent Owner source.

## Module shape and validation plan

One repair module owns identity verification, writer-lease lifetime, snapshots,
proposal sealing, approval, apply/rollback, and recovery journal reconciliation.
Its interface is the host repair command/progress surface plus explicit human
approve/cancel actions. Future repair navigation must use the membership
established by that repair module without requiring ordinary Message replay.
Ordinary coordination calls no repair transforms. Pi
session replacement is the host seam; do not scatter repair exceptions across
Message validators or give a Moderator raw coordinator access.

Before enabling writes, exercise these observable contracts with bounded tests:

| Scenario | Required outcome |
| --- | --- |
| Invalid historical Request/Answer record shapes, valid persisted Owner identity | Ordinary admission skips rejected records and preserves valid obligations. Repair is not required for navigation; an explicitly started repair transaction fences all ordinary writers. |
| Ordinary admission fails while Owner/repair membership is verified | `/agents` and diagnostics remain available; Owner ↔ repair Moderator selection does not replay invalid Message history or resume uncertain work. |
| No repair transaction, or safely cancelled repair | Ordinary admission uses skip-and-mark replay; rejected evidence remains visible and valid obligations survive. |
| Missing/ambiguous identity, child, Moderator, or ephemeral source | No invented repair membership; diagnostic explains the refusal. |
| Owner identity changes while quiescing | Frozen identity check refuses before repair Moderator bootstrap. |
| Delayed child append, pending spawn, active Owner compaction, extension append, second host | Snapshot waits for proven retirement/exclusion or refuses; no lost write. |
| Candidate changes during validation/review; source/directory/version changes | Seal or approval is rejected; originals unchanged. |
| Rejected Request becomes valid without accepted Delivery evidence | Review exposes the newly eligible Request and later recovery effect; approval/application alone dispatches nothing. |
| Original cannot project, or Answer committed with its Request source unavailable | Review distinguishes unknown before-state and local commitment from Delivery; no fabricated proof or claim of semantic equivalence. |
| Malformed off-branch entry, bad cross-Agent Answer, hidden quarantine | Whole-Workflow certification fails; originals unchanged. |
| Moderator crash or misleading completion report | Repair report remains inspectable; no validation/approval bypass or ordinary Request dependency. |
| Fail before/after each rename, journal write, directory flush, or backup operation | Either untouched originals or verified whole-set rollback; uncertainty fences admission. |
| Process crash at every apply/reopen phase | Startup reconciles journal before any affected writer or identity adoption; no mixed Workflow is admitted. |
| Same-path native switch; cancellation; post-start protocol failure | Real disk reread and explicit admission acknowledgment, or blocked rollback/recovery; `/reload` never substitutes. |
| Successful repair with pending Requests and interrupted tools | Same Workflow IDs, preserved obligations, dormant participants, no automatic tool replay. |
| Cancel/new/fork during repair | No mid-transaction escape to stale or mixed evidence; diagnostics and safe recovery remain available. |

These are future implementation acceptance tests, not tests run for this design
ticket. The design deliverable is documentation and source-backed feasibility
research; no runtime or migration is changed.

## Decisions needed before implementation tickets

1. **Approval:** accept whole-changeset explicit human confirmation, with no
   deterministic preauthorization in the first scope?
2. **Pause and host prerequisites:** accept paused Owner conversation through
   review, and a required exclusive-writer/native pre-open fence capability
   (potentially upstream Pi work) rather than a hash-only online stopgap?
3. **Failure policy:** accept rollback of the entire changeset on application or
   post-apply admission failure, with exclusive restart when writer retirement
   cannot be established?
4. **Repair membership:** accept a dedicated repair-only Moderator input/store,
   archived with the same Workflow but never silently promoted into ordinary
   incident moderation or routing?

The #131 replay and presentation contracts are implemented; a separate
partial-admission interface is no longer a prerequisite. After the remaining
repair mechanics above are accepted, create bounded native child issues under
#129 for: host writer exclusion and journal
preflight; repair identity/bootstrap
and reporting; read-only whole-Workflow validation; snapshot-bound review and
transactional apply/rollback; native reopening and admission acknowledgment.
Each should include its relevant tests above and depend on the host capability
proof before live replacement is enabled. This list is a proposed partition,
not created issues or implementation authorization.
