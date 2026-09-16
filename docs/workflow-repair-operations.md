# Workflow repair operations

`/agents repair` authorizes one repair attempt. There is no later handoff or
changeset confirmation. The existing Pi CLI and terminal stay open:

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

- Progress appears in the same terminal. **Esc cancels before application.**
  Other terminal input is consumed while the native replacement callback waits;
  a typed slash command cannot interrupt that native wait.
- The Moderator belongs to the verified original Workflow, has a fresh native
  session identity and no Direct Spawner, and is recorded in the separate repair
  store before its first model turn. It is not an ordinary child Request,
  Operational Incident, or new Owner Workflow.
- The Moderator reads immutable snapshots and writes candidate copies and
  reports. A completed report is only a proposal. Host validation certifies the
  exhaustive generation and records textual and protocol-effect changes.
- Disk commit precedes reopening. Failed fresh admission retains the committed
  repair, later native writes, and helper diagnostics. Participant Runs are not
  automatically resumed.

After refusal, `/agents repair` opens read-only progress, Owner snapshot,
Moderator transcript, and validation-audit pages. `/agents repair inspect`
always inspects the current/most recent attempt. After successful admission,
a new bare `/agents repair` authorizes a new attempt without restarting Pi.
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

- `/agents repair cancel` requests cancellation when command input is available.
  During active replacement use **Esc** instead. Application cannot be cancelled
  once it has begun.
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
