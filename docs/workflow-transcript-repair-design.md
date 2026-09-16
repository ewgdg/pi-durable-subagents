# Workflow-owned transcript repair

`/agents repair` implements a bounded correction workflow for [#129](https://github.com/ewgdg/pi-durable-subagents/issues/129).
The command authorizes the attempt, including validated replacement and reopening:
**there is no subsequent confirmation.** For commands, cancellation, and crash
recovery, see [Workflow repair operations](workflow-repair-operations.md).

## Scope

Repair corrects rejected coordination evidence in otherwise verifiable native
Pi transcripts. It is optional: ordinary [skip-and-mark replay](coordination-replay-rejection-design.md)
already preserves valid responsibilities while ignoring malformed protocol records.
Repair is not required merely to use a Workflow with rejected coordination history.

The first implementation refuses malformed/unverifiable native originals rather
than trusting a model to reconstruct missing history. It preserves the file set,
native identities and identity cutoffs, and accepted coordination sources and
their relative order. New coordination sources cannot be invented, and accepted
ones cannot be silently rewritten or removed. Ambiguous intent must be refused.
It does not migrate historical formats, repair policy/model configuration, or
implement a general autonomous repair engine.

Certification targets the repository's Pi 0.85.1 native grammar. Unknown native
variants, including unsupported compaction forms, refuse instead of being silently
ignored. Identity and membership remain strict even when ordinary replay rejects
individual coordination records.

## Same-terminal lifecycle

```text
repair invocation authorizes one attempt
  -> independent Node/Pi helper starts, with no snapshot/write authority yet
  -> close admission and join supported Owner/managed writers
  -> replace Owner session with an unrelated tagged repair-host session
  -> acknowledge actual cleanup and native session retirement
  -> immutable snapshot and verified repair Moderator bootstrap
  -> candidate copies -> whole-Workflow validation and effect audit
  -> backups, journal, replacement, durable disk commit
  -> open a fresh Owner session from disk in the same CLI terminal
```

The CLI process remains the terminal presenter. The helper is outside ordinary
Owner-managed shutdown; no Python, pidfd, extra terminal, permanent launcher, or
upstream Pi edit is needed. The temporary repair host is not an unrelated Owner
Workflow and grants no ordinary coordination authority.

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
seals and validates the generation. The command authorizes an in-scope repair;
it does not waive identity, retirement, validation, or freshness checks.

## Validation and protocol-effect audit

The snapshot includes the Owner and every participant-directory JSONL candidate,
not merely successfully discovered Agents. Directory membership, original bytes,
file identities and permissions are bound. Unreadable or ambiguous candidates
prevent certification; successful ordinary admission with quarantine is insufficient.

Validation is read-only and in-memory: no `SessionManager.open`, model turn,
runtime initialization, scheduling, or `workflow_resume` is used as a validator.
The native grammar is checked over all physical entries, including off-branch
evidence. Shared normal readers evaluate membership, cross-Agent evidence and
actual recovery eligibility. Candidate certification requires zero quarantine
and zero rejected coordination evidence.

Both full textual differences and protocol-effect differences are retained:

- Accepted/rejected/changed/removed physical sources and accepted-source ordering.
- Authored Messages/Requests, local Answer duties, and awaiting Answers.
- Answer commitment separately from Delivery evidence.
- Pending Message, Request, Answer, and Cancellation deliveries, their recovery
  order, and responder continuations eligible on later explicit recovery.
- An unknown original projection is labeled unknown, never an empty before-state.

Concrete risk: correcting a rejected Request can make an external action eligible
for future delivery. The audit exposes that change; preserving accepted source
order also prevents an apparently harmless edit from silently changing FIFO.
Recovered participants remain dormant. Only a later explicit recovery action can
resume eligible work; repair does not assert an interrupted external action
never happened.

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
a new repair invocation authorizes a new attempt; archived hosts remain tied to
their exact earlier attempt rather than the latest attempt for the Owner path.

## Support and verification

Storage currently requires POSIX file/directory durability; Windows refuses.
Linux real-CLI tests and packed-package tests verify same-terminal operation,
managed final writes, native bash, actual rejected-record correction, cleanup
refusal, initial/fresh admission failure, cancellation, repeat attempts, and
killed-helper recovery. Focused core tests exercise sealing, freshness, unknown
hashes, interrupted apply/rollback, and preservation of post-commit native writes.
They are not a power-loss proof or exhaustive terminal resize/signal coverage.

Implementation modules live under `src/repair/`; operations are documented in
`docs/workflow-repair-operations.md`. Historical research records why the earlier
permanent-launcher/process-exit designs were rejected:

- [Native session replacement](research/pi-session-replacement.md).
- [Local launcher feasibility](research/local-repair-launch-feasibility.md).
- [Independent process-exit helper proof](research/independent-repairer-feasibility.md).
- [Same-terminal session-retirement proof](research/same-terminal-repair-feasibility.md).

The historical requirements for per-changeset confirmation, admission-as-commit,
and universal pre-open interception are superseded, not alternate runtime paths.
