# Shared relationship source collection (#147, first increment)

## Goal and boundary

Remove per-Agent full-roster cursor reconstruction from warm relationship refreshes. Preserve the existing Request evaluator and authoritative all-source freshness audit. This is the shared change-collection increment of #147, not completion of its dependency-routing, structural-admission, or whole-pass scheduling work. Build on merged #146 at `5c65502`; leave #129 and runtime ownership unchanged.

The global ExecPlan guide at `~/.agents/docs/plans.md` is outside DevSpace's allowed roots. This plan follows the repository's existing ExecPlan format.

## Decision

Weights: correctness 5, measured idle improvement 4, reviewability 3, full issue coverage 1. Scores (1–5): unchanged code 5/1/5/1 = 45; shared source collection 5/5/5/2 = 62; simultaneous dependency/roster/scheduler rewrite 3/5/2/5 = 46. Choose shared collection as an independently useful first increment.

## Design and failure case

Keep one disposable coordinator-owned source cursor per Agent and one shared Request-change journal per source/roster epoch. A relationship graph retains only its epoch and position in that journal, alongside its existing relationships. Precompute Creation Request IDs by direct spawner once per epoch. Collect each physical source's Request changes once; do not repeat source-map comparisons for each consumer.

An append can arrive while collection or graph evaluation yields. Capture batch end positions before draining; commit only those positions, and observe again for a successor batch. Source replacement, identity cutoff, and roster changes conservatively create a new epoch and invalidate unfinished old-epoch work. Failed graph evaluation resets that graph's position and membership, not the authoritative transcript or the shared journal. Shared collection must yield on a large Request backlog rather than moving previously budgeted work into an unbounded synchronous loop.

An ordinary non-coordination append still receives the normal authoritative source audit but must leave graph results untouched. Lazy Request binding may append change notifications during evaluation; a successor observation must collect them instead of silently consuming them for all graphs.

## Work plan

1. Add deterministic warm-refresh work-count coverage using real transcript adapters; run it against the baseline and record the failure. Add interleaved scoped/global and fresh-reconstruction coverage.
2. Share source collection and journal consumption while retaining conservative invalidation and current Request/Answer/Wait semantics.
3. Add a reproducible benchmark with separate source observations, transcript inspections, timing, and memory. Record baseline and patched runs; do not assert wall-clock timings.
4. Run focused Request, transcript, cancellation, Wait, lifecycle/recovery checks and typecheck. Review races and errors, update maintained docs, commit, and create a PR referencing #147 without closing it.

## Progress

- [x] Read #147, inspected current implementation and merged #146.
- [x] Red work-count regression and baseline benchmark: 3,240/12,880 inspections at 40/80 Agents; baseline median at 400 Agents was 26.258 ms and 320,400 inspections.
- [x] Shared source collection and correctness checks, including interleaved readers, same-size record replacement, scope/source reset, evidence errors, and admission during a yielding batch.
- [x] Focused validation, benchmark comparison, and diff review completed; ready for PR publication. GitHub records publication status.

## Results and review

All 175 tests passed across 13 selected Request, Wait, transcript, recovery, deadlock, and Run-lifecycle files. Typecheck and `git diff --check` passed. The initial broader run was blocked by the isolated install's missing native `node-pty` build; rebuilding that dependency restored all selected checks. The complete integration/process suite was not run.

The unchanged 400-Agent microbenchmark now performs 1,200 transcript inspections and 400 authoritative source refreshes, with a measured 0.326 ms median. Both before and after consume no new entries. These are synthetic isolated measurements, not interactive latency guarantees. The existing dense-history benchmark also completed and still exposes public enumeration, broad evaluation, and whole-pass latency costs. Full measurements and limitations are in `docs/research/shared-relationship-sources.md`.

Review checked captured batch ends, invalidation during a yielded collection, shared journal ownership versus independent graph consumers, missed notifications, lazy bindings, graph error retries, and source/identity epoch changes. Source collection retains its own bounded drain; it does not convert the whole operation into a bounded pass. Reverse dependencies, admission deltas, and journal compaction remain explicitly deferred rather than silently included.
