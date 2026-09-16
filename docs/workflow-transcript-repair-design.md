# Workflow-owned transcript repair

`/agents repair` implements a bounded correction workflow for [#129](https://github.com/ewgdg/pi-durable-subagents/issues/129).
The command authorizes the attempt, including validated replacement and reopening:
**there is no subsequent confirmation.** For commands, cancellation, and crash
recovery, see [Workflow repair operations](workflow-repair-operations.md).

## Scope

Repair is only for an **actual current Owner transcript-admission failure**.
Successful admission returns "no repair needed" before helper creation, model
work, session replacement or transcript edits. Ordinary
[skip-and-mark replay](coordination-replay-rejection-design.md) already handles
rejected records: they remain unchanged and inert. Repair must never turn an old
rejected Request into newly eligible work after the Workflow has moved on.

The first supported blocker is redundant exact copies of accepted Message
Delivery envelopes in the Owner's current identity scope. Their duplicate
authority causes normal admission to fail. A correction may retain the first
envelope, remove later exact copies, and bypass removed native parent links.
It cannot choose between conflicting payloads or rewrite historical intent.

Eligibility binds the retained OwnerRecoveryError to the active native session,
path and identity; a generic unadmitted state is insufficient. Configuration,
model and cleanup failures are not transcript corrections. The immutable full
snapshot must independently certify the supported duplicate fault before model
work. Malformed native originals, unverifiable identity, ambiguous references,
and other unsupported blockers refuse. This is not a general repair engine.

Certification targets the repository's Pi 0.85.1 native grammar. Unknown native
variants, including unsupported compaction forms, refuse instead of being silently
ignored. Identity and membership remain strict even when ordinary replay rejects
individual coordination records.

## Same-terminal lifecycle

```text
repair invocation + actual supported transcript admission failure
  -> independent Node/Pi helper starts, with no snapshot/write authority yet
  -> close admission and join supported Owner/managed writers
  -> replace Owner session with an unrelated tagged repair-host session
  -> acknowledge actual cleanup and native session retirement
  -> immutable snapshot, certified blocker, verified repair Moderator bootstrap
  -> candidate copies -> whole-Workflow validation and effect audit
  -> backups, journal, replacement, durable disk commit
  -> open a fresh Owner session from disk in the same CLI terminal
```

The CLI process remains the terminal presenter. The helper is outside ordinary
Owner-managed shutdown; no Python, pidfd, extra terminal, permanent launcher, or
upstream Pi edit is needed. The temporary repair host is not an unrelated Owner
Workflow and grants no ordinary coordination authority.

Native replacement awaits only the short verified handoff, not the full model
turn. The editor returns while independent repair work continues. Live model and
tool updates and completed transcript entries are visible through `/agents` and
read-only inspection. The Owner row shows an immutable snapshot during repair;
the Repair Moderator row is presentation-only, not ordinary routing or membership.
It remains inspectable after completion, including archived attempts.

Responsive navigation does not authorize arbitrary native reopening. Switch
permission names the exact controlled transition, not the whole running attempt.
Open repair views are closed and joined before Owner reopening, with unsubmitted
editor text preserved. Expected refusal does not escape the native callback.

Pi opens a switch destination before old-session teardown. Switching first to an
unrelated repair-host transcript lets final Owner writes complete without opening
a stale Owner manager. The later return opens the committed Owner bytes while
shutting down a different native session. Neither `/reload` nor direct same-path
replacement is used as a repair barrier.

### Writer retirement

The production handoff joins actual coordinator shutdown, including pending
launches and exact managed-process exit Promises. Cleanup evidence is retained
independently of ordinary admission and across resource reloads; a failed cleanup
cannot become success merely because a later bootstrap has no new coordinator.
Positively established pre-coordinator initialization failure is distinguished
from unknown or failed cleanup.

Native retirement separately aborts and joins user bash through its final
persistence, aborts/joins native session work, checks for pending bash messages,
and verifies completed replacement. The native drain is rechecked after shutdown
handlers. A delivered shutdown event is not proof: Pi contains handler errors.
Expected refusal is recorded rather than thrown through `withSession`, where Pi
can treat an exception as a fatal replacement failure.

This is a cooperative writer contract, not filesystem revocation. Foreign
extensions retaining raw SessionManagers, external editors, and another bare Pi
writer must not modify affected files. The helper lease only excludes duplicate
helpers; it is not evidence that ordinary writers stopped. Unknown cleanup and
missing handoff refuse repair. No orphan takeover is inferred from PID checks,
EOF, quiet hashes, or a released lock.

## Identity, membership, and model authority

Before handoff, read-only persisted Owner identity must match the attached native
session and canonical path. The post-retirement immutable snapshot rechecks the
Workflow/session IDs and identity-entry cutoff. Missing or conflicting identity
does not authorize adoption or manufacture new membership.

A durable repair-only bootstrap binds a fresh Moderator to that verified Workflow,
with no Direct Spawner, plus the attempt ID, Owner identity, snapshot manifest
digest, and captured Moderator preset. It precedes the first model turn. Repair
artifacts and the Moderator transcript live outside ordinary participant discovery.
No child Creation Request or invented Operational Incident is needed.

The independent helper runs the installed stock Pi CLI in RPC mode with only its
dedicated extension. It exposes `repair_snapshot`, `repair_candidate`, and
`repair_report`; no shell, live-file write, spawn, ordinary messaging, approval,
or apply tool. Normal extensions, skills, prompt templates, and context files
are not inherited. The preset supplies model/guidance, not extra authority.
Extension-only model providers are consequently not inherited.

A model's completion report only submits a proposal. The host independently
seals and validates the generation. The model receives the retained failure and
correction constraints, not a prewritten candidate. The command authorizes an
in-scope repair; it does not waive identity, retirement, validation, or freshness.

## Validation and protocol-effect audit

The snapshot includes the Owner and every participant-directory JSONL candidate,
not merely successfully discovered Agents. Directory membership, original bytes,
file identities and permissions are bound. Unreadable or ambiguous candidates
prevent certification; successful ordinary admission with quarantine is insufficient.

Validation is read-only and in-memory: no `SessionManager.open`, model turn,
runtime initialization, scheduling, or `workflow_resume` is used as a validator.
The native grammar is checked over all physical entries, including off-branch
evidence. Shared normal readers evaluate membership, cross-Agent evidence and
actual recovery eligibility. Candidate certification requires zero quarantine;
unchanged historical rejections are allowed and must remain rejected.

The certificate independently derives the only allowed corrected generation:

- Duplicates must be accepted, whole, current-scope envelopes with exactly equal
  non-native fields, including literal content, display, and ordered sources.
  Repeated sources inside one rejected envelope and cross-cutoff copies are not
  this repair class. Partially overlapping batches and conflicting bodies refuse.
- Keep the first evidence. Bypass each removed native parent through its original
  surviving ancestor, and preserve the reopened native leaf. Deleting a tail
  duplicate must not switch the session to an abandoned branch.
- Refuse any non-parent or ambiguous reference to a removed entry across the full
  generation, including compaction boundaries, labels, branch origins, wait
  receipts, and opaque references. Do not guess how to retarget them.
- The candidate's header and retained records must equal this reference, with
  unchanged identities, file membership, call/source content and ordering,
  rejected payloads, and unrelated conversation. A missing-title "fix" alongside
  otherwise valid duplicate removal is rejected.

Both full textual differences and protocol-effect differences are retained:

- Accepted/rejected/changed/removed physical sources and accepted-source ordering.
- Authored Messages/Requests, local Answer duties, and awaiting Answers.
- Answer commitment separately from Delivery evidence.
- Pending Message, Request, Answer, and Cancellation deliveries, their recovery
  order, and responder continuations eligible on later explicit recovery.
- The original projection is unknown when duplicate authority blocks replay;
  its actual errors remain visible. The report separately identifies the
  certified reference, removed-to-retained mappings, and native parent rewrites.

The comparison basis is explicitly the certified duplicate reference, not an
invented empty original projection. A valid retained Delivery may carry an
existing duty even if its authored source was rejected. Certification preserves
that duty without making the rejected author into pending dispatch. Candidate
canonical facts and the unchanged rejection set remain inspectable.

An audit alone does not prevent stale-request resurrection. The permitted-edit
certificate does: rejected history cannot be corrected, removed, or converted
into executable evidence. Recovered participants still remain dormant, and
repair does not assert an interrupted external action never happened.

The restored Owner is also held until a **new interactive human message**.
This hold is established before coordinator integration: native setting changes
must not trigger reconciliation, an Obligation Stall reminder, and an empty
extension prompt. Existing duties remain pending, but startup/delivery/reminder
work cannot start a model turn or append fabricated user input. Navigation,
inspection and commands do not release the hold; the user's new message does.

The audit is inspection evidence, **not another approval gate**. Full reports
remain on disk even when terminal previews are bounded. Editing a candidate or
changing source membership/bytes invalidates the sealed validation generation.

## Commit and recovery

Before any replacement, backups and intent cover the entire write set. Staged
files are on the destination filesystem; replacements preserve mode, and the
journal uses file/directory fsync. Apply rechecks the exact sealed generation,
report binding, full original manifest, and original command's attempt identity.
Cancellation changes no originals before application begins.

Interrupted pre-commit application restores the whole preimage only after all
destination hashes and backups are checked. Any unknown destination refuses all
rollback writes. Interrupted rollback is retryable. Rejected or missing mutable
candidate/report payloads do not strand rollback when authoritative journal
bindings and backups remain valid; they still prevent new application.

**Disk commit precedes native reopening.** Once committed, failed admission never
restores originals over the repaired generation or later native startup writes.
Uncertain commit durability refuses reopening until journal recovery resolves it.

Ordinary helper recovery needs the positively acknowledged retirement handoff
as well as a safe disk generation. An absent intent says no replacement needs
rollback; it does not prove writers retired. Cross-restart recovery uses an
explicit operator-stopped attestation, recorded separately from observed process
exit. It can recover an existing attempt, not invent a missing handoff to start
new repair work. See the operations guide for the exact commands.

During unfinished repair, reopen only through the recorded repair-host/recovery
path. Arbitrary bare Pi attachment is not intercepted. After successful admission,
a new repair invocation is a no-op; archived hosts remain tied to their exact
earlier attempt. Journal recovery can safely restore the original blocked bytes
without fixing admission, and must report that distinction.

Pre-admission-only repair artifacts have an isolated archive/recovery reader so
existing journals are not stranded. Their old launch shape cannot start a new
helper, snapshot or model turn; the normal launch reader requires the bound
admission failure. This is recovery handling, not an alternate repair mode.

## Support and verification

Storage currently requires POSIX file/directory durability; Windows refuses.
Linux real-CLI tests and packed-package tests verify a real blockage widget and
inactive tools before duplicate correction, followed by fresh admitted Owner in
the same terminal. They also cover healthy/rejected-only/configuration no-ops,
unchanged stale rejected history and dormant children, native bash, cleanup
refusal, postcommit admission failure, cancellation and killed-helper recovery.
Reasoning-enabled CLI cases exercise setting-triggered reconciliation and verify
zero Owner calls until explicit human input. Held-model cases verify live
navigation, completed tool-result refresh, draft preservation, and refusal of
uncommitted native reopening. Packed-package checks cover these paths too.
Focused core tests exercise the permitted-edit certificate, sealing, freshness,
unknown hashes, interrupted apply/rollback, and post-commit native writes.
They are not a power-loss proof or exhaustive terminal resize/signal coverage.

Implementation modules live under `src/repair/`; operations are documented in
`docs/workflow-repair-operations.md`. Historical research records why the earlier
permanent-launcher/process-exit designs were rejected:

- [Native session replacement](research/pi-session-replacement.md).
- [Local launcher feasibility](research/local-repair-launch-feasibility.md).
- [Independent process-exit helper proof](research/independent-repairer-feasibility.md).
- [Same-terminal session-retirement proof](research/same-terminal-repair-feasibility.md).

The earlier rejected-to-accepted correction behavior, per-changeset confirmation,
admission-as-commit, and universal pre-open interception are superseded, not
alternate runtime paths.
