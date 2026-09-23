# Shared relationship source collection: #147, first increment

## Decision and scope

The warm quadratic bookkeeping is worth removing independently of the larger dependency-routing redesign. `RequestEvidence` now collects source progress once and shares a Request-change journal; each Agent graph retains one journal position rather than a full-roster cursor map. The Request evaluator, all-source authoritative freshness audit, and conservative roster/source invalidation remain in place.

This implements the shared change-collection increment requested by #147. It removes the measured O(A²) *unchanged-refresh bookkeeping*, not every source of quadratic work in changed or cold workflows. #147 remains open for reverse dependencies and dirty graph routing, incremental admission, and whole-pass scheduling. The runtime contract is documented in [Transcript consumption](../transcript-consumption.md#shared-relationship-source-progress).

## Reproduction

```sh
node --test tests/relationship-refresh.test.ts tests/request-evidence.test.ts
node --expose-gc benchmarks/relationship-refresh.ts
node --expose-gc benchmarks/transcript-consumption.ts
```

The new probe was run before and after the implementation on Node v24.21.0, with baseline `5c65502` (merged #146). Each size uses identity-only dormant Agent fixtures, no Requests, no processes, five warmups, and ten measured global refreshes. Both versions consumed zero new entries. The counted `inspect()` calls include calls served by a pinned observation; they measure redundant bookkeeping, not physical transcript reads.

| Agents | Before median (ms) | After median (ms) | Before inspections/pass | After inspections/pass | Source freshness checks/pass, both |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 0.044 | 0.019 | 210 | 30 | 10 |
| 50 | 0.641 | 0.068 | 5,050 | 150 | 50 |
| 100 | 1.698 | 0.105 | 20,100 | 300 | 100 |
| 200 | 6.659 | 0.197 | 80,200 | 600 | 200 |
| 400 | 26.258 | 0.326 | 320,400 | 1,200 | 400 |

At 400 Agents, this run improved the isolated idle path by approximately 80x. Maximum scheduled-turn delay fell from 28.55 ms to 0.67 ms in this probe. The garbage-collected warmed heap delta was approximately 14.64 MB before and 2.65 MB after, including fixture/transcript state; it is a noisy whole-fixture measurement, not isolated cache accounting.

These are same-machine synthetic observations, not interactive extension-on/off measurements, portable latency guarantees, or evidence that dense changed workflows are now cheap. The existing dense-history benchmark still measured about 20.8 ms for one new Request after 2,000 settled conversations, and a 2,000-conversation backlog took about 379 ms with a 38.9 ms maximum heartbeat gap. Public history enumeration, broad Request evaluation, and whole-pass budgeting remain significant. The full source-complete sparse/dense and zero/one/many-dirty-Agent matrix from #147 is deferred with dependency routing.

## Correctness and validation

The deterministic regression fails on the baseline: 40 Agents required 3,240 inspections and 80 required 12,880. It now requires linear inspection work while retaining one authoritative `refresh()` per source. Timing is not a CI assertion.

Eight focused refresh tests cover scaling, independent scoped/global readers, unchanged result reuse after ordinary appends, silently arriving Answers, concurrent Answer/admission during a yielding batch, evidence errors and retry, same-size record replacement, identity cutoff, and fresh adapter reconstruction. Existing tests cover Answer-before-author-result, cancellation delivery, Wait and retrieval, source/branch/compaction reconstruction, exact-Run fences, and recovery.

All 175 tests passed across these 13 selected files:

```sh
node --test --test-reporter=spec \
  tests/relationship-refresh.test.ts tests/request-evidence.test.ts \
  tests/request-resolution.test.ts tests/transcript-facts.test.ts \
  tests/request-inspection.test.ts tests/agent-transcript.test.ts \
  tests/agent-transcript-observation.test.ts tests/child-authoritative-lifecycle.test.ts \
  tests/wait-request-recovery.test.ts tests/run-projection-lifecycle.test.ts \
  tests/operational-failure-recovery.test.ts tests/dependency-deadlock.test.ts \
  tests/answered-dependency-deadlock.test.ts
npm run typecheck
```

The first broader run could not load three files because the isolated install omitted the native `node-pty` build. `npm rebuild node-pty` restored that prerequisite, after which all selected files passed. The complete integration/process suite was not run.

## Invalidation and retention review

A batch's captured source and journal end positions do not advance implicitly when an await permits another append. The next observation collects those changes. A source/identity or roster epoch change discards partial collection and invalidates old graph work. Failure in one graph leaves its old published result inaccessible through the fresh-read barrier until successful reconstruction; it does not erase shared source evidence or mark the failed graph clean.

The journal is disposable coordinator memory, not a second durable store. It retains Request ID references until its epoch is replaced; lagging graph readers must not lose entries they have not consumed. Bounding that retention belongs to inventory item E2. Source-map construction and graph result publication remain synchronous, and the graph evaluation budget remains per Agent; this increment does not claim a whole-pass latency limit.
