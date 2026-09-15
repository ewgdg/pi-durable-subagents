# Strict startup tool selection

## Goal and intention

Replace the ambiguous `allowedTools` capability ceiling with a `tools` startup selection, matching `skills`. A spawned Agent must start with its resolved selected tools rather than silently accepting a subset. This is a trust-based configuration contract, not a permanent runtime restriction.

## Scope and constraints

- Rename public Spawn configuration, Template fields, captured creation rules, launch configuration, schemas, examples, and task-owned test fixtures to `tools`.
- Preserve precedence: explicit configuration, then captured Template selection, then current parent active tools. Empty selections remain meaningful; required role coordination tools are added.
- At the existing startup admission seam, compare actual and resolved selected tools as sets, rejecting missing and unexpected tools. Preserve tool execution-mode validation and permit later native activation changes.
- Remove obsolete ceiling state rather than retaining compatibility aliases. Runtime snapshots already report current active `tools`.
- Do not rewrite existing user Templates or immutable historical transcripts automatically. Assess persisted old fields and document the breaking change separately from normal runtime behavior.
- Do not fix unrelated scheduler errors or baseline process-test hangs.

## Work plan

1. Add failing behavior tests for public selection fields and exact startup admission.
2. Update configuration and runtime implementation plus affected fixtures; remove superseded ceiling plumbing.
3. Update maintained documentation and record upgrade implications.
4. Independently review startup timing, dynamic activation, recovery parsing, and explicit/empty/inherited selection behavior.
5. Run focused tests and typecheck, commit task-owned changes, and record outcomes here.

## Validation

Target Spawn/configuration/Template schema tests, runtime preparation, startup admission and snapshot tests, and descendant inheritance. Exercise reordered exact sets, missing tools, extra tools, empty optional tools, required role tools, and native post-admission tool changes where supported by existing seams. Avoid the full integration suite.

Known baseline: typecheck reports `ActivePromptDelivery.deliveryCommitted` in the scheduler; the ordinary real-process factory test times out after 45 seconds on unchanged HEAD as well as the previous fix.

## Progress

- Accepted design: strict initial selection, not a permanent fixed set and not coexisting ceilings.
- Initial inspection found references across configuration, protocol schemas, Template parsing, CLI launch, runtime snapshots, and tests. Source/test implementation is delegated as one cohesive change.
- Maintained spawning, selector, and child UI documentation now describes initial selection rather than a ceiling. Separate upgrade guidance records the immutable-history boundary; user configuration and stored sessions are not rewritten.
- Source and tests committed as `3f0cb44`: selection rename, exact startup validation, removed ceiling state, and post-admission dynamic activation coverage. Independent review findings were resolved in the subsequent commits below.
- Strict admission exposed inherited Owner-only `workflow_resume` in child preparation. The existing coordination-role normalization now removes it before adding child-role tools; focused ordinary/Moderator tests cover this enabling correction.
- Focused configuration, Template, protocol, preparation, process startup, hosted runtime, inheritance, and recovery checks pass. The standalone Moderator cold-recovery display assertion also fails against the unchanged preceding commit, with the same expected/actual text mismatch; it is unrelated to this change.
- Independent review found startup validation could precede an asynchronous inherited `session_start` handler. Commit `2352b16` separates early Control/presentation readiness from final startup completion, preserving real startup dialogs and cancellation while validating the settled handler snapshot.
- Review also found and corrected the remaining benchmark launch field and superseded domain-model ceiling wording. The benchmark now passes launch and fails later at its unchanged, obsolete `runtime.prompt` call; this adjacent benchmark repair is outside scope.
- Parent verification reran 87 focused tests successfully; typecheck still reports only the known scheduler error.
- Native source inspection revealed Pi's CLI tool flag is a persistent registry filter, not merely an initial active selection. Commit `e583c53` removes that filter and applies the bootstrap tool selection once through the public activation API. A real process test activates and successfully executes an initially unselected registered tool after admission.
- Follow-up validation passes 25 launch/CLI/schema/preparation tests, nine targeted real runtime tests, and two hosted admission/snapshot tests. The main process-runtime test's existing Owner-intention ordering assertion was independently reproduced on an unchanged archive and is not modified.
- Final parent checks reran the 25 launch/configuration tests and five exact startup-contract tests successfully. Independent re-review found no remaining issues and passed 12 targeted timing, dialog, cancellation, and activation checks. Test groups overlap and are not summed.

## Decisions

Selection names describe the initial contract. Runtime `tools` describes current active tools. No broad allowed-tool list remains part of runtime state.

## Outcomes

Implemented and reviewed. All task-owned changes are committed at the selection, startup readiness, native activation, and documentation/caller boundaries. The old field is rejected rather than aliased, and no user configuration or immutable history was rewritten.

The important corrections were semantic, not cosmetic: an exact startup contract requires waiting for asynchronous inherited handlers, while later dynamic activation requires avoiding Pi's persistent CLI registry filter. Early Control/presentation must remain usable during startup so validation does not deadlock dialogs.

Known unrelated failures remain documented above. The full suite and Windows validation were not run; reload preservation was reviewed in source but not exercised by a dedicated coordinated reload integration test.
