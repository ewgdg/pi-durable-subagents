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

## Validation and outcome

Pending.
