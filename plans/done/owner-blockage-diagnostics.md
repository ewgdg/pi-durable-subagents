# Owner blockage diagnostics (#128)

## Goal and intention
Contain saved-protocol validation failure during Owner admission without treating invalid evidence as healthy coordination. Keep Pi usable and expose a persistent warning-colored above-editor box plus on-demand human diagnostics.

## Scope and constraints
Implement #128 only. No protocol compatibility, transcript repair, safe-fork admission changes (#130), healthy coordinator upgrade revalidation (#127), or quarantine presentation redesign (#125). Do not advertise unavailable repair or fork actions. Preserve strict protocol validators and original evidence/cause. Report the first encountered failure, not a complete audit.

## Work plan
1. Add failing Owner-host regression for an accepted Request missing its required title, including blocked tools and diagnostics after reload.
2. Preserve structured protocol failure source and underlying validation reason.
3. Clean failed coordinator admission, contain known recovery failures at the extension boundary, and display the widget.
4. Add `/agents diagnostics` with a read-only scrollable summary and technical-details view.
5. Run focused tests and typecheck; document behavior and commit.

## Validation
Use actual Pi ExtensionRunner/Owner-host tests for containment and command availability; UI tests for scrolling, narrow terminal bounds, details, and dismissal. Parent owns independent real CLI demo checks. Avoid the full integration suite.

## Progress
- Confirmed existing startup error occurs after child discovery, in Owner relationship initialization; initial quarantine notification currently precedes admission success.
- Confirmed Pi widgets remain separate from restored chat; use supported `setWidget` and `ui.custom` interfaces. Reuse the existing report surface conventions for read-only scrolling.

## Decisions
Known protocol errors are translated at Owner recovery/admission, not swallowed in validators. Ordinary unrelated setup failures retain their existing propagation. Diagnostics do not promise that all other processes have stopped. Fork and repair are explicitly unavailable in this scoped build.

## Validation outcomes
- Regression first failed with the exact escaped `invariant_violation: committed agent_message source accepted-request-missing-title is invalid` on startup, then passed after containment.
- New startup/reload and in-process resume cases pass, including ordinary native conversation after blocked admission.
- Focused request-resolution, diagnostics-surface, and remote-selector tests: 41 passed.
- Owner bootstrap file: 17 passed; existing prospective-policy reload test fails expecting `capacity_exhausted` but receives no reason. Reproduced the same failure on an untouched HEAD archive in `/tmp`; left unrelated behavior unchanged.
- `npm run typecheck` reports an existing `ActivePromptDelivery.deliveryCommitted` missing-property error in `message-delivery-scheduler.ts`. Reproduced on the same untouched HEAD archive; no added type errors.
- Parent owns real CLI demo/probe validation after handoff.

## Outcomes
Structured source/cause retention now feeds a scoped Owner recovery error; failed coordinator initialization is cleaned before the outer extension contains it. `/agents diagnostics` is available without admission and retains technical details without appending chat messages. The warning-colored boxed widget wraps within terminal width and does not replace the editor. Plain /agents reports unavailability; only explicit /agents diagnostics opens the panel. The panel fills every viewport row and cell, including short-content blank space, and pins controls to the bottom across resizes. Visible blockage headings use “Subagent coordination blocked”. Scope dependencies and keyboard controls are documented.

## Presentation validation
- Added regression checks for exact full-viewport coverage and bottom-pinned controls across short content and terminal sizes down to one row/column.
- Added warning-box border, width, and theme-color checks, plus native command distinction between plain /agents and explicit diagnostics. All were observed failing before the corresponding presentation changes.
- Focused presentation tests: 6 passed. Focused Owner startup/reload, in-process resume, and plain-command cases: 3 passed.
