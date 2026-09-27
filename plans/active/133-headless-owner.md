# Headless Owner coordination (issue #133)

## Goal

Run the durable subagent system from every non-TUI Pi mode: RPC, print (`pi -p`), and JSON. A headless Workflow must make progress without a human, and must never hang waiting for one.

## Intention

TUI means a human is present; every other mode is headless. A headless Workflow keeps the full Agent protocol (spawn, Request, Answer, Wait, supervision, recovery). It removes only the parts that need a human at a terminal: the blocking `ask_user` question, and terminal surfaces such as the Agent selector and views. Anything that would otherwise wait on a human is routed to the Agent's supervisor.

## Scope and constraints

- Admission is independent of TUI presentation. Every mode admits the Owner. Only TUI captures the native TUI presentation.
- Native fork/switch guards apply in every mode, because every mode now hosts an admitted Owner.
- Headless children and Moderators do not get `ask_user`. The Owner tells each child at launch whether a human is available. As a second line of defence, the Owner-side Human Request coordinator rejects `ask_user` in a headless Workflow.
- `report_to_user` stays. Reports stay durable in the transcript and appear when the session is reopened in the TUI (RPC, print, and JSON sessions all persist the same session file unless `--no-session` is used).
- A Run suspension (`provider_quota` / `runtime_error`) in a headless Workflow sends a model-visible notice to the suspended Agent's Direct Spawner. The notice preempts `agent_wait`. The supervisor then resumes with `agent_control` `resume`, terminates, or cancels. If nobody acts, Owner settlement parking ends the Owner turn as usual, so print/JSON exit instead of hanging. The notice fires only in headless Workflows; TUI behavior is unchanged (user decision).
- The Owner's own RPC input (`source: "rpc"`) counts as human input. The RPC client is the human for that Owner: it resumes a suspended Owner Run and its steer preempts `agent_wait`.
- Terminal-only surfaces (`/agents` selector, views, reports, model policy, activity dock) stay TUI-only. In headless mode `/agents` says so instead of silently doing nothing. Owner blockage is reported through `notify("error")` in RPC and through stderr when there is no UI (print/JSON).
- Children stay full TUI Pi processes in their own PTYs; nothing about the child runtime contract changes except the human-availability flag.

### Decision record: suspension handling in headless mode

A weighted matrix picked "notify the supervisor" (82%) over "park for a human" (44%, which hangs `agent_wait` forever in `pi -p`) and "abort the Owner turn" (68%, fails fast but never makes progress).

## Work plan

1. Admission layer: tests for RPC/print/JSON admission without a TUI capture; headless-aware bridge capture; widen the `index.ts` gates; headless blockage and `/agents` messages.
2. Human availability: Workflow interaction mode on the coordinator; child bootstrap flag that strips `ask_user`; Owner-side rejection.
3. RPC input provenance: `rpc` counts as human for input admission and primary steering (prompt and `steer`).
4. Suspension notice to the Direct Spawner in headless Workflows.
5. Real-process tests: `pi --mode rpc` and `pi -p` fixtures completing spawn → Request → Answer (including `agent_wait` and asynchronous Delivery) with child cleanup.
6. Docs: README, `docs/owner-workflow.md`, `docs/human-requests.md`, `docs/run-supervision.md`, CONTEXT vocabulary.

## Validation

Focused suites only (the full suite is slow): activation, owner bootstrap, human request, run suspension, quota input source, the new headless process tests; plus `npm run typecheck`.

## Progress

- Reconnaissance done (blockers listed in the issue confirmed; Pi 0.87 RPC/print mode source read).

## Surprises and discoveries

- Plain "park for a human" would hang `pi -p` forever: `agent_wait` only returns on committed Answers or inbound preemption, and moderation is suppressed along a suspended path.
- Print mode's `session.prompt()` defaults to `source: "interactive"`, so print prompts already count as human; only RPC uses `source: "rpc"`.
- RPC `steer` calls `session.steer()`, not `session.prompt()`, so primary steering must observe both.

## Decisions

- See scope. User decisions: RPC input is human for an RPC Owner; strip `ask_user` in every headless mode; keep `report_to_user` durable; notify the supervisor on suspension, headless only.

## Outcomes and retrospective

(pending)
