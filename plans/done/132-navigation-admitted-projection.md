# Navigation from the admitted projection (#132)

## Goal and scope
Keep `/agents` and returning to Owner independent of transcript refresh when an
admitted coordinator already supplies the roster. Preserve bootstrap and identity
failures, existing selection machinery, diagnostics, and explicit work admission.
Do not introduce repair, partial admission, or replacement participants.

## Plan and validation
Use existing command and Owner presentation-handler test seams. First demonstrate
that a failed refresh blocks navigation; remove only the two navigation refresh
dependencies; run focused selector and admission/diagnostics tests and typecheck.
Existing replay tests own malformed-record semantics; navigation consumes their
admitted projection rather than inventing a second replay contract.

## Progress
- Inspected local command, remote snapshot, and coordinator selection paths.
- Coordinator selection already requires admitted participants and does not call
  transcript refresh. Execution lifecycle refreshes remain out of scope.

## Outcomes and validation
- Removed only the local command and remote snapshot refresh dependencies.
- Observed two regression failures before implementation (local Owner return and
  remote snapshot); both now pass with refresh deliberately unavailable.
- Covered existing Owner/Moderator selection at the presentation boundary and
  local selector/report opening with refresh unavailable.
- Added real Owner bootstrap coverage with rejected Request and Answer history:
  selector, return-to-Owner and diagnostics remain usable, with no streaming.
- 38 focused selector, diagnostics, and replay tests pass; 3 selected bootstrap
  cases pass, including real conflicting-valid-record admission failures.
- Typecheck passes. No full suite run; no Pi APIs or replay contracts changed.

## Remaining scope
The Moderator round trip is a presentation-boundary test, not a new physical
process fixture. Existing participant acquisition and identity admission remain
unchanged. No repair engine, uncertainty state, writer pause or new bootstrap was
introduced. Parent owns documentation updates.
