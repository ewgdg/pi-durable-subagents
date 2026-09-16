# Human-message quota resumption

## Goal

Replace the separate `/quota-resume` command with deliberate human editor input as the explicit resumption action. Ordinary Agent Messages, heartbeat scheduling, report acknowledgement, and model changes alone must not release a quota stop.

## Work plan

1. Test native Owner and process-hosted child human input at the existing lifecycle seams; update core resumption to use actual human text/images and the existing exact-stop confirmation contract.
2. Let cold suspended child selection prepare its editor without generation; only a subsequent human message resumes the retained Run.
3. Remove the superseded command, synthetic resume API, and cold read-only quota presentation branch. Update notices and supported behavior docs.
4. Run focused native/process/cold tests, presentation checks, and typecheck; commit all task changes.

## Constraints and failure cases

- Programmatic or coordination input must not impersonate human intent.
- Selection/preparation alone must not clear the stop, generate, or replace the Run.
- Keep resume-confirmation ordering, queued input, Requests, cancellation, and capacity behavior intact.
- No compatibility alias for the removed command.

## Progress

- User confirmed a human message is sufficient deliberate resumption; the command was an unnecessarily narrow interpretation of explicit resume.
- Core/input and lifecycle tests delegated to the original lifecycle implementer. Parent owns retired surfaces, notices, documentation, and final validation.
- Removed the command and synthetic Owner-resume API. Human text/images use the existing exact-stop confirmation path; cold selection prepares an editor but preserves the stop.
- Native tests exposed that Pi swallows `agent_start` handler errors. Blocking there alone did not prevent programmatic generation; the existing input-mode hook now consumes noninteractive input before generation while stopped.
- Pi's existing interactive source label is the trusted provenance boundary, not an authentication mechanism. Known extension/RPC paths are tested as non-resuming; SDK callers can label their own source and must do so truthfully.

## Validation and outcome

- Final typecheck and diff check pass. Parent reran 31 focused quota/presentation/Control tests and all 8 native/process/cold quota integration cases successfully; no full suite run.
- Native tests prove exact human text/images resumes, extension/RPC inputs do not generate, and ordinary Agent Messages remain queued. Cold integration attaches the real child PTY: selection alone preserves suspension, then typed human input resumes the exact Run.
- Independent follow-up review found no actionable regressions and reran 14 source/host tests successfully.
- Two expanded lifecycle registrar prose expectations fail identically on the unchanged baseline; not changed in this task.
- Implementation commits: `d5621da` (retire command/presentation), `f37f500` (native provenance tests), `0193565` (human resumption and pre-generation gates).

## Retrospective

Explicit human intent does not require a dedicated command. The relevant distinction is human input versus automatic coordination, using the native trusted provenance seam. The pre-generation input hook matters because throwing from Pi's start hook does not reliably stop generation.
