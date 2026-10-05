# Incremental Agent activity and cached authority order

## Goal and scope

Implement the first contained slice of the performance inventory: a presentation refresh for one known Agent must not read every other Agent transcript, repeated invalidations must coalesce without losing changes during an await, and structural authority order must be reusable until Agent admission changes it. Preserve the existing global selector notification contract, immediate host-state publication, authoritative explicit evidence reads, and all delivery/Run/Request semantics. Do not implement the separate relationship-graph redesign or claim that this removes its measured quadratic cost.

Baseline: `bdd4065`, including the performance inventory, atop upstream `e1d08de`. Work is isolated from the user's checkout. The advertised global ExecPlan guide was unavailable through DevSpace; this plan follows the repository's existing activity-redraw plan structure.

## Public test seams

Use `WorkflowCoordinator.forAgent()` activity refresh/subscription and selector/search surfaces with real transcript adapters and source-complete dormant Agent fixtures. Count transcript refreshes at the existing adapter interface to enforce the intended work bound. Test relevant behavior, not private queue layout. Keep process-heavy conformance tests out of the initial loop.

## Failure case and design

An Agent can append twice, or a different Agent can change, while one refresh awaits I/O. Detach each pending dirty batch before awaiting. New events accumulate separately and get a successor pass. Keep unscoped invalidation conservative for callers that cannot identify affected sources. Scoped presentation refresh does not certify global evidence freshness. Never share a borrowed observation across an await as if it were frozen.

Cache authority order at the coordinator, invalidating in the shared Agent integration path after admission has added its structural relationship. Return only a private read-only array. Use Set membership for disconnected/moderator roster entries and an iterative preorder traversal. Preserve existing order and authorization.

## Work plan

1. Add and run a failing scoped-refresh regression with dormant Agent transcripts; preserve an explicit all-transcript freshness test.
2. Replace the single activity-refresh flag with source-aware pending batches, retaining immediate notifications and controlled error containment. Thread known Agent IDs from host/model events; keep unscoped view/attention notifications conservative. Add a dirty-during-await regression.
3. Cache authority order at structural admission and check ordering through selector/search. Add a focused benchmark using the same public coordinator surface and count source observations independently of elapsed time.
4. Run typecheck and focused activity, selector, lifecycle, transcript, and relevant recovery tests. Review the diff for missed event sources, lost wakeups, shutdown/error loops, and stale topology. Update documentation and create a PR.

## Progress

- [x] Inspected baseline and existing activity/relationship code. Upstream main is `e1d08de`.
- [x] Red scoped-refresh regression: one Agent change originally refreshed all four fixture sources; it now refreshes one.
- [x] Dirty-source refresh and race coverage, including same-Agent changes, peer changes, duplicate dirtiness, visible errors, and later recovery without an automatic retry loop.
- [x] Cached authority order and ordering coverage: the repeated-observation test originally rebuilt order 154 times; it now builds once, then once more after real Agent identity admission with a controlled pre-Run failure.
- [x] Focused benchmark, checks, and diff review completed. Implementation is ready for PR review; GitHub records publication status.

## Results and review

184 tests passed across nine focused activity/selector/lifecycle/transcript/Request test files. Three additional native cold-recovery cases passed through the process test supervisor: dormant child rediscovery, physical authority order versus dormant recency, and standalone Moderator recovery. Typecheck and `git diff --check` passed. The full integration suite was not run.

The maintained `benchmarks/agent-activity.ts` probe ran 20 samples each at 10, 100, and 400 source-complete dormant Agents. Each case scheduled 20 transcript observations for 20 scoped activity refreshes, and built authority order once across 20 selector roster reads. Median scoped refresh times were 0.004-0.007 ms on Node v24.21.0. These timings exclude startup, rendering, and global relationship work and are not a claim about total interactive speedup.

Diff review checked the shared integration path for cold recovery, ordinary child creation, and Moderator admission; the global selector subscription contract; reentrant publication; successor batches during awaits; error containment; and shutdown checks before publication. No durable protocol or explicit all-source freshness checks changed.

Remaining scope is explicit: global moderation/attention refreshes, the O(A²) relationship bookkeeping, per-subscriber status/row materialization, and public history enumeration are not solved by this PR.

## Validation

Prefer deterministic source-refresh counts over timing assertions. Record timing only as supporting evidence. Confirm that explicit `refreshTranscriptFacts()` still sees silent appends to any Agent, while a scoped activity event reads only its source. Ensure queue events during refresh survive, a failed source is not silently accepted, and a disposed coordinator stops publication. Do not modify the live user session or run the full integration suite.
