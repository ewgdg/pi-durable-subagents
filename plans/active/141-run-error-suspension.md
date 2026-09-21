# Runtime-error Run suspension

## Goal

Stop treating an unexpected terminal Run error as a reportable incident. The exact Run is retained as a visible, explicitly resumable suspension instead, so the Owner sees the stop and its error rather than an Attention Inbox report, and no Moderator is created for it.

## Intention

One concept already covers "this exact Run cannot continue until the human or a supervisor explicitly says so": the evidence-backed Run suspension built for provider quota. A terminal provider/model error is the same kind of stop, so it becomes a second suspension reason instead of a Run Failure. Reports stay for genuine runtime defects (coordination fences, startup failures, unavailable moderation), which are not provider exceptions.

## Scope and constraints

- `AgentRunSuspension` is a discriminated union: `provider_quota` keeps its structured `QuotaEvidence`; `runtime_error` carries the observed `AgentRunFailure` (stage, error, provenance).
- The supervisor establishes the suspension where Pi reports a terminal `agent_end` error, under the existing gates: no pending native retry, no interruption or expected interruption, no existing suspension, no fence, not already ending.
- A suspended Run keeps the existing quota contract: retained exact Run, released execution permit, ordinary Delivery blocked, reminder/stall/deadlock moderation suppressed along its blocked dependency path, resumption only from a human editor Message or an authorized Supervisory Resume Message, termination still available.
- No Runtime Report, finding, or Moderator is produced by a terminal provider/model error.
- Run Failure reporting and moderation remain for coordination faults (React-to-fence paths) and startup failures; they are runtime defects, not provider exceptions.
- Quota classification is unchanged and keeps precedence; its status label and evidence rendering stay recognizable.

## Work plan

1. Runtime host and supervisor: generalize the suspension type and names, establish `runtime_error` on terminal error, keep quota behavior identical.
2. Coordination: rename suspension gates, keep the blocked-path exclusions reason-agnostic, make resumption work for both reasons.
3. Control protocol and presentation: schema union, status labels, selector Run detail evidence.
4. Tests: convert terminal-failure expectations from reports to suspension; add resumption, capacity, moderation-suppression, and status coverage.
5. Documentation: run supervision, incident moderation, CONTEXT vocabulary.

## Validation

Focused runtime/coordination/presentation suites plus typecheck. Cover: no report and no Moderator for a terminal error; the exact Run retained and resumable; quota still classified as quota; a fenced Run still reports; capacity released so unrelated children progress.

## Progress

- Reconnaissance done: suspension machinery, incident reporting, moderation triggers, presentation surfaces, and the tests that pin them identified.
- Working in a worktree because another session is committing to the main tree concurrently.
- Runtime, coordination, protocol, and presentation implemented: `AgentRunSuspension` union, `runtime_error` established from a terminal error on a usable Runtime, reason-aware status labels and Run-detail evidence, `run_suspended` human-input mode. A terminal error from an already unavailable Runtime keeps the terminal Run Failure path so a dead child is still reported and moderated.
- `tests/run-suspension.test.ts` (renamed from `quota-suspension.test.ts`) covers both reasons, including resumption and the unavailable-Runtime exception: 11/11. `quota-lifecycle-integration.test.ts` passes end to end for reporter-free stops (7/7). `selected-agent-status`, `agent-activity-surface`, `control-protocol-schemas` (suspension cases), `quota-operational-incidents`, and `agent-runtime-supervisor-failure` pass.
- Documentation updated: run supervision, incident moderation, cold recovery, agent selector, CONTEXT vocabulary.
- `tests/operational-incidents.test.ts`: four provider-error tests converted to the suspension contract (child with obligation and released capacity, obligated Owner Run resumed by interactive input, cancellation retaining the stop, un-obligated Owner Run), all passing individually. Three moderator-flow tests were deleted because their flow no longer exists for a provider error: successor-start recovery notice, successor Stall after a cleared Run Failure, and failed successor startup. Those flows remain reachable through transport-death and startup Run Failures only.
- End-to-end verification: `quota-lifecycle-integration.test.ts` 8/8 including a new child test (suspend on a provider error, no report, no Moderator, explicit supervisor resume continues the same Agent); `quota-cold-recovery.test.ts` passes after its final step was made honest about the new contract; focused fast files pass.
- Branch baseline failures were verified by stashing this change: `control-protocol-schemas.test.ts` (hardcoded protocol version 9 against 10), `workflow-resume.test.ts` (`already_running` vs `continuation_admitted`), `operational-incidents.test.ts` first test (Moderator tool list), both native-quit tests, and ten `run-supervision.test.ts` cases. None are caused by this change; `run-supervision.test.ts` shows nine failures with it.

## Decisions and outcomes

- Keep Run Failure handling for coordination fences instead of deleting it, so a genuine runtime defect still reaches the Owner through the existing report and bounded moderation path.
- A terminal error suspends only while its Runtime is usable (`workState() !== "unavailable"`). A dead child Runtime cannot continue its exact Run in place, so it keeps the terminal Run Failure report and moderation path rather than pretending to hang resumably.
- Consequence: a stopped Run no longer ends, so tests and flows that relied on "the provider error ends the Run" must finish the Run explicitly. The cold-recovery integration test now terminates its recovered Run after the successful resume turn instead of relying on an exhausted model response to end it.
- Coverage gap for follow-up: the `run-failure-recovery` successor notice is now only reachable through a transport-death or startup Run Failure, and this branch's native-quit integration test already fails at baseline, so that path currently has no passing integration test.
