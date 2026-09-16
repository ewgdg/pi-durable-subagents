# Workflow repair operations

`/agents repair` authorizes one attempt only when the current Owner actually
failed transcript admission. Successful admission means no repair: no helper,
model work, session switch or transcript edits. Rejected historical records are
not admission blockers and remain unchanged. Configuration/model failures are
not transcript repair eligibility.

The initial supported correction is removing redundant exact copies of valid
Message Delivery envelopes, keeping the first copy and all unrelated evidence.
Conflicting duplicates, ambiguous native references and other failure classes
refuse. The real Moderator proposes independently; a deterministic certificate
and exhaustive validator constrain its candidate, not its claimed intent.

There is no later handoff or changeset confirmation. The existing Pi CLI and
terminal stay open:

```text
Owner session → unrelated repair-host session → freshly reopened Owner
                         │
               independent Node/Pi helper
               snapshot → Moderator → validate → commit
```

The helper uses the installed stock Pi CLI in RPC mode, with only the dedicated
repair extension and three scoped tools. It does not inherit ordinary
extensions, skills, context files, shell tools, or coordination tools. Its model
must be available through Pi's built-in providers or user model configuration;
an extension-only provider is not inherited. The captured `moderator` preset
supplies model selection and guidance, not additional tool authority.

## During an attempt

- The short native handoff returns editor control before model work. Progress,
  model text/thinking, tool-argument streaming counts and tool activity appear
  in the same terminal. `/agents` opens the Repair Moderator's live read-only
  transcript or the immutable Owner snapshot; completed native tool arguments
  and results refresh while the view stays open. Ordinary prompts cannot start
  work in the repair host, and native reopening of the original is refused until
  the controlled commit/reopen transition.
- `/agents repair inspect` and `/agents repair cancel` remain usable while the
  helper works. **Esc closes an open inspection/menu; outside those views it
  cancels before application.** No second terminal or confirmation is needed.
- The Moderator belongs to the verified original Workflow, has a fresh native
  session identity and no Direct Spawner, and is recorded in the separate repair
  store before its first model turn. It is not an ordinary child Request,
  Operational Incident, or new Owner Workflow.
- The Moderator reads immutable snapshots and writes candidate copies and
  reports. A completed report is only a proposal. Host validation certifies the
  exhaustive generation and records textual and protocol-effect changes.
- Disk commit precedes reopening. Failed fresh admission retains the committed
  repair, later native writes, and helper diagnostics. Participant Runs are not
  automatically resumed. The restored Owner also stays idle until a **new human
  message**: existing obligations remain pending, but reminders, setting changes
  and navigation cannot implicitly start a turn or append an empty user message.
  An unsubmitted editor draft is preserved across the final switch.

The Repair Moderator remains a read-only `/agents` presentation row after
completion, including archived attempts. Selecting it never creates an ordinary
Agent Run, Request, membership record or delivery route. Live views are closed
before automatic Owner reopening. Reloading or leaving the repair host can
invalidate its retained native context; a committed repair then remains on disk
for explicit recovery rather than forcing a switch through that stale context.

After refusal, `/agents repair` opens read-only progress, Owner snapshot,
Moderator transcript, and validation-audit pages. `/agents repair inspect`
always inspects the current/most recent attempt. After successful admission,
a new bare `/agents repair` reports that no repair is needed.
Archived repair-host sessions remain bound to their exact original attempt.
Inspection grants no new authority and never resumes work. Evidence paths are
shown in the terminal. Repair state lives alongside the Workflow participant
directory, under `pi-agent-coordination-repair/<encoded-workflow-id>/`:

- `hosts/<attempt-id>/`: launch, tagged host session, Moderator transcript and
  bootstrap, progress, helper diagnostics, admission/recovery outcomes.
- `storage/<attempt-id>/`: immutable snapshot, candidates, sealed audit and
  generation, application journal and backups.

## Refusal and recovery

Absent persisted Owner identity, child/Moderator identity, unknown cleanup,
failed cleanup, cancellation, stale files, and invalid or ambiguous proposals
refuse repair. Reloading does not erase a failed cleanup result. Repair cannot
correct unrelated runtime policy or model configuration failures.

- `/agents repair cancel` requests cancellation from the responsive repair-host
  editor. Application cannot be cancelled once it has begun.
- `/agents repair recover` asks the retained helper to recover its existing
  journal, then explicitly reopens the Owner if recovery establishes a safe
  generation. It requires the positively acknowledged retirement handoff and is
  available in the tagged repair host after the attempt ends. An absent journal
  intent establishes unchanged bytes, **not** retired writers; missing handoff
  therefore refuses ordinary recovery.
- If refusal left the original retired Owner attached, `/agents repair park`
  moves to its unrelated repair host without authorizing any snapshot or repair.
- After a CLI/helper crash, reopen the recorded **repair-host session**, not an
  affected Owner/participant transcript. Stop the old helper **and all affected
  transcript writers**, then invoke `/agents repair recover-stopped`.

`recover-stopped` is an explicit operator attestation, recorded as such. When
this CLI also observed the helper's real process exit, that evidence is recorded
separately. It is not a PID-existence guess or an automatic orphan takeover.
This exceptional command may recover/cancel only the already-authorized journal;
it cannot manufacture a missing retirement acknowledgment, start a new snapshot,
or start a Moderator. Unknown destination hashes still refuse recovery. A
committed generation is never rolled back over subsequent Owner writes.

Recovery can restore the original admission-blocking evidence. Safe disk
recovery is not proof that fresh Owner admission will succeed. Old repair
artifacts from before admission-only eligibility remain inspectable and their
existing journals recoverable, but cannot bootstrap another helper/model or
restart the superseded rejected-record repair behavior.

## Supported writer and platform boundary

Snapshot authorization requires the original coordinator's memoized cleanup
success, pending-launch joins and actual managed-process exit Promises, native
user-bash cancellation and final persistence, native abort/idle, and completed
replacement into the unrelated host. Shutdown-event delivery alone is not
cleanup success: Pi contains extension handler failures. The retirement checks
are repeated after replacement, and expected refusal never escapes Pi's
`withSession` callback.

This is a cooperative, trust-based writer contract, not filesystem revocation.
Captured raw SessionManagers, noncooperative extensions, other bare Pi processes,
and external editors must not write affected files during repair. There is no
global interceptor for arbitrary Pi launches. Follow the explicit recovery path
before reopening an unfinished repair.

No Python, Linux pidfd, second terminal, permanent launcher, or upstream Pi edit
is required. Storage currently requires POSIX file/directory durability; Windows
refuses. Real CLI tests cover terminal command continuity, not exhaustive
resize/signal UX or power-loss durability.
