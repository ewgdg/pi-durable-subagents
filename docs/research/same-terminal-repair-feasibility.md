# Same-terminal, Node-only repair lifecycle

Follow-up to #129's independent-repairer proof. **Disposable proof, not a shipped
repair command.** The proposed Linux/pidfd/Python/second-terminal requirement was
unnecessarily imposed by treating Owner session retirement as OS-process exit.
The user rejected that operating burden.

## Result

Stock Pi 0.85.1 can keep its existing CLI process and terminal while replacing
the Owner session with a temporary repair-host session. An independent Node child
repairs the offline transcript; the repair-host then reopens the Owner from disk.
The real CLI proof and an independent rerun passed all six expected checks.
No upstream patch, Python, pidfd, execve, or second user terminal was used.

```text
same CLI process and terminal throughout
Owner session -> temporary repair-host session -> fresh Owner session
                       |
              independent Node helper
              snapshot -> repair -> commit
```

The intermediate session matters: Pi opens a switch destination before shutting
down the current session. Opening an unrelated repair-host file first avoids
reading the Owner file before its final writes. Returning to Owner happens only
after repair commit, while shutting down a different session.

The repair command itself authorizes the attempt. There is no second handoff or
changeset confirmation. Validation, freshness, and refusal rules remain required;
textual and protocol-effect differences become audit evidence, not approval gates.

## Retirement evidence and limits

The fixture observes the **original** coordinator shutdown Promise, including
real managed Pi child cleanup. It separately awaits native user-bash cancellation
and completion, native abort/idle, then public replacement's `withSession` callback.
Only verified cleanup plus completed native replacement allows helper writes.
The helper starts before cleanup and is not an ordinary managed Agent.

Native `abort()`/idle alone do not join user bash. The proof starts a real shell,
cancels it, and observes `isBashRunning` still true immediately after cancellation.
Its final canceled `bashExecution` entry must finish before snapshot. The same
entry is present in the snapshot and reopened native manager.

This is a **cooperative supported-writer contract**, not revocation of filesystem
access. A deliberate append through the old captured raw SessionManager after
reopening changes disk without updating the fresh manager. That counterexample
passed as an expected limitation, not as evidence of universal writer exclusion.
External bare Pi writers and noncooperative extensions are likewise unsupported.

## Checks

| Case | Observed result |
| --- | --- |
| Clean | Same CLI PID and PTY; distinct reopened native manager; repaired generation and final Owner/child writes visible; subsequent terminal input works. |
| Native user bash | Actual asynchronous cancellation/final persistence finishes before retirement and helper snapshot. |
| Actual cleanup rejection | Injected native-disposal failure rejects original coordinator shutdown. Pi contains handler error, but helper refuses without repair writes. |
| Parking cancellation | Public before-switch cancellation refuses repair; no commit. |
| Actual fresh admission rejection | Invalid scratch policy rejects real admission after repair; committed bytes and helper diagnostics remain, accessible in the same terminal. |
| Unsupported stale raw writer | Retained raw SessionManager can write after disposal; fresh manager does not see the write. Explicit trust limitation. |

Expected refusal must be recorded without throwing from `withSession`: the
stock CLI can treat replacement callback errors as fatal. Busy managed startup
also produced a real cleanup rejection in an early attempt; positive tests wait
for managed settlement. Successful retirement during arbitrary active admission
is not established, and rejection remains a refusal, not permission to repair.

## Reproduction and scope

Prototype commit: `cd7a4fa423f1a65a07f72639b8d63bf468810aa0` on
`prototype/129-local-repair-lifecycle`, under `prototypes/129-session-retirement/`.

```sh
node prototypes/129-session-retirement/run.mjs
```

The disposable fixture has machine-local source paths. It uses real stock Pi CLI,
the project extension and managed PTY child, isolated scratch HOME/config/files,
and an in-memory faux model provider; no external model requests. It was tested on
Linux with existing Node/node-pty. Lifecycle code does not require Linux pidfds,
but the shell fixture and directory fsync are POSIX-oriented: Windows support is
**not** proved. Terminal checks cover command input, not full resize/signal UX.

199 executable lines versus 329 in the prior independent-repairer proof; neither
is a production estimate. The fixture's stage flag, cleanup observer, one-file
generation edit, and receipt are scaffolding, not production membership,
validation, writer inventory, or crash-safe transaction/recovery interfaces.
In particular, this proof is not a power-loss durability test.

Independent parent rerun: all six expected results, exit 0, 7.902 seconds. Evidence
is retained under
`~/.agents/artifacts/outputs/pi-durable-subagents/2026-09-15/129-session-retirement-proof/`,
including `parent-verification.log` and `parent-verification-scratch/`.

Production still needs explicit repair-host bootstrap, complete supported-writer
accounting and launch/input gates, real repair Moderator and validation/audit,
durable multi-file recovery, and diagnostic UI. Helper EOF never authorizes
application. A fatal native replacement failure can still end the CLI, so durable
recovery remains necessary even though ordinary repair needs no extra terminal.
