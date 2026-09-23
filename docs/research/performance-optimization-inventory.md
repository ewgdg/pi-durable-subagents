# Performance optimization inventory: incremental work across Agents

Status: investigation and proposed work, not an implemented runtime design.

Inspected baseline: `e1d08de` on `main`, after withdrawing #129. Investigation date: 2026-09-22 in America/Vancouver (2026-09-23 UTC). Runtime used for the probes: Node `v24.21.0`.

The reported symptom is that disabling this extension noticeably improves Pi responsiveness, and that larger Agent populations make things worse. This investigation did not reproduce the exact interactive session or measure an extension-on/off comparison. It identifies concrete scaling costs in the current code and records the remaining candidates, rather than claiming that every candidate causes the reported lag.

The supplied handoff, `/tmp/handoff-pi-durable-subagents-2026-09-23.md`, was found by filesystem inspection but could not be read: DevSpace rejected both the file and `/tmp` as outside its allowed roots. Its contents have not been incorporated. The repository is `pi-durable-subagents` (plural), not the older singular path.

## 1. Recommendation

Keep the existing transcript cursor and disposable projections. Extend incremental processing upward into scheduling, relationship maintenance, moderation, and presentation.

The important distinction is:

> Processing no new entries is not the same as doing no work.

At present, an unchanged transcript can avoid parsing while still paying for public history enumeration, file metadata checks, roster traversal, per-Agent relationship bookkeeping, snapshot allocation, and subscriber notification. Some of that work multiplies by the total number of known Agents. [S1–S6]

The target is that ordinary work scales with **changed Agents, changed Requests, and affected dependents**, not all historical Agents multiplied by all other Agents. Initial admission, a global query, a genuinely workflow-wide dependency change, or recovery from an unknown invalidation can still require broader work. This is not a promise of constant-time cold startup or constant-time arbitrary graph changes.

Do not add a second durable coordination database or write `processed: true` into transcripts. Cursors, versions, dirty queues, dependency indexes, and cached results are disposable in-memory state. Durable authority remains committed transcript evidence. [S1, S2]

## 2. What already exists

These are existing optimizations, not new tasks:

- Entry cursors for SessionManager transcripts and byte cursors for file-backed JSONL; complete-record parsing and shared retained indexes. [S1, S2]
- Request-specific versions, a changed-Request journal, memoized resolutions, and incremental relationship membership. The missing piece is cheap identification of which consumers need those updates. [S2, S3]
- SessionManager adapter sharing by manager identity and weak file-adapter sharing by path. Weak lookup alone does not bound memory while AgentRecords strongly retain adapters. [S1]
- Lazy active-branch/model-context construction and snapshot-based presentation. Context construction still happens when a caller actually requests it. [S1, S10]
- Async catch-up with entry/chunk budgets and a relationship generator with a per-Agent step/time allowance. A per-Agent allowance is not a whole-pass latency bound. [S1–S3]
- Coalesced activity refresh and moderation scheduling. Both can still do broad work; activity notifications also occur immediately, outside the coalesced async refresh. [S4, S5]
- Cached Agent Template discovery with explicit refresh semantics. Do not propose a generic cache that duplicates or weakens that contract. [S13]

The durable protocol, cold-admission validation, delivery evidence, and exact-Run lifecycle fences should remain unchanged by this performance project.

## 3. Measurements from this investigation

### 3.1 Existing transcript benchmark

Command executed successfully on the inspected baseline:

```sh
node --expose-gc benchmarks/transcript-consumption.ts
```

Selected results from one run; milliseconds are machine- and load-dependent, not portable latency guarantees:

| Scenario | Elapsed time | Work observed |
| --- | ---: | --- |
| Owner, 2,000 historical entries, 100 unchanged reads | 2.33 ms | 100 enumerations; 200,100 entry references; zero parsing/consumption |
| Owner, 20,000 historical entries, 100 unchanged reads | 23.42 ms | 100 enumerations; 2,000,100 entry references; zero parsing/consumption |
| File-backed Agent, 20,000 historical entries, 100 unchanged reads | 0.33 ms | Zero file bytes read and zero parsing/consumption; this does not count metadata syscalls |
| Owner, 20,000 historical entries, one appended entry plus query | 2.01 ms | One entry consumed, but three enumerations totaling 60,006 references |
| File-backed Agent, 20,000 historical entries, one appended entry | 0.68 ms | One entry parsed/consumed; 698 bytes read including the cursor anchor |
| Two-Agent relationship fixture, 2,000 settled Requests, 100 unchanged refresh/query iterations | 23.96 ms | Zero new entries consumed; 2,400,400 references enumerated across both Agents |
| Same dense relationship fixture, one additional Request | 20.13 ms | Maximum sampled heartbeat gap 19.47 ms |
| Same dense relationship fixture, 2,000-conversation backlog | 354.34 ms | Maximum sampled heartbeat gap 39.75 ms |

The last two figures differ substantially from the older measurements in `docs/transcript-consumption.md`. They are a new single run, not proof of a regression: no controlled before/after comparison or repeat distribution was performed. The heartbeat gaps also include scheduling/runtime effects, not just isolated JavaScript CPU time. [S7]

At 20,000 entries the file-backed case retained approximately 19.6 MB of additional heap in this fixture, including parsed history. The Owner adapter retained approximately 4.1 MB beyond its already-loaded SessionManager. This motivates memory measurement at high Agent counts; it is not a claim that every real Agent uses those amounts. [S7]

### 3.2 Agent-count probe

A separate in-memory probe exercised the real `MessageCoordinator.refreshTranscriptFacts()` using the existing minimal `participant()` test helper. Every Agent had only its identity entry, no Requests, no running process, and no new appends. There were five warmups followed by ten samples at each size, yielding between samples.

| Known Agents | Median refresh | Maximum refresh | Entries consumed over all ten measured refreshes |
| ---: | ---: | ---: | ---: |
| 10 | 0.045 ms | 0.091 ms | 0 |
| 50 | 0.425 ms | 1.021 ms | 0 |
| 100 | 1.491 ms | 2.776 ms | 0 |
| 200 | 5.210 ms | 5.855 ms | 0 |
| 400 | 21.760 ms | 22.863 ms | 0 |

These are not full source-validated cold-recovery fixtures or an interactive lag reproduction. They isolate warm relationship refresh overhead in existing test scaffolding. The near-fourfold increase from 200 to 400 Agents is consistent with the nested roster scans visible in `RequestEvidence`: the outer refresh visits every Agent, and `#startRelationshipUpdate()` constructs and compares another full-roster observation/cursor map for each one. An unchanged pass therefore contains O(A²) roster bookkeeping despite zero new evidence. [S3, S8]

This is the strongest measured reason to prioritize dirty-Agent and dependency-directed processing rather than another JSON parsing cache.

## 4. Source-backed optimization inventory

Legend: **Observed** means the code path was inspected, not that its share of interactive latency was profiled. **Measured** additionally refers to section 3. **Candidate** means an audit or conditional optimization, not an established defect. Priorities are sequencing recommendations, not promises to implement every row.

### A. Events, lifecycle, and publication

| ID | Priority / evidence | Change to investigate | Intended gain and required constraint |
| --- | --- | --- | --- |
| A1 | First / Observed | Preserve `agentId` and reason when host/lifecycle changes call `#notifyAgentActivityChanged()`. Introduce a deduplicated dirty-Agent queue instead of a workflow-wide boolean alone. [S4] | Refresh changed sources and affected subscribers. A change arriving during a drain must remain queued for a successor pass. |
| A2 | First / Observed | Separate immediate host-state publication from async transcript-derived publication; publish only when the visible result changes. [S4, S11] | Avoid sending every subscriber effectively identical snapshots twice. Preserve immediate failure/attention feedback; do not merely delete the early notification. |
| A3 | First / Observed | Coalesce compatible lifecycle observations within one verified observation generation. [S4, S9] | Tool start, result commitment, settlement, and execution end currently request broad refreshes. Share work only until an await, append, or relevant lifecycle change invalidates freshness. |
| A4 | Next / Candidate | Add cheap relevance checks before expensive hook work, especially message-end paths and unrelated tool boundaries. [S9] | An ordinary tool may still be an ordering barrier for an earlier coordination result. A guard may skip work only when the applicable pending-obligation/reconciliation versions prove it unnecessary. |
| A5 | Next / Candidate | Scope subscriptions and child/Owner control-channel updates to affected views and changed payloads. [S4, S11] | Audit whether repeated global notifications produce repeated full-roster serialization. Count fan-out and bytes before changing the transport. Never drop ordered protocol messages. |

### B. Requests, relationship graphs, and moderation

| ID | Priority / evidence | Change to investigate | Intended gain and required constraint |
| --- | --- | --- | --- |
| B1 | First / Measured | Maintain reverse Request dependencies: a changed Request/source identifies its author, recipient, and any genuinely dependent relationships. [S2, S3] | Stop offering every changed Request to every Agent graph. Register negative and unresolved dependencies too, so later evidence can invalidate a previously absent result. |
| B2 | First / Measured | Queue dirty relationship graphs; let an unchanged graph return its retained result without rebuilding an all-Agent cursor map. [S3] | Remove warm O(A²) roster bookkeeping. Keep existing Request-version resolution logic rather than creating a parallel authority. |
| B3 | First / Observed | Track roster changes separately and process Agent admission as a structural delta. [S3] | Currently a roster mismatch clears retained membership/cursors and recollects sources. Adding one Agent should not normally rebuild unrelated old relationships. Identity replacement remains a different, stronger invalidation. |
| B4 | Next / Observed | Split moderation dirtiness into host condition, Request graph, delivery progress, and operation-review changes. [S5] | Avoid whole-workflow evidence/condition scans for unrelated presentation changes. Dependency-cycle changes can affect an entire connected region; permit a conservative full graph pass when necessary. |
| B5 | Next / Candidate | Index active Waits by captured Request IDs and share fallback observation across Waits. [S12] | Reconcile only Waits affected by an Answer/cancellation/delivery change. Retain the explicit Wait snapshot, exact recipient-Run fences, Hold semantics, and event-loss fallback. |
| B6 | Later / Candidate | Index pending human results, operation reviews, report attention, and active failure handling by the identities that can resolve them. [S4, S5, S12] | Audit repeated collection scans; advance relevant committed-result cursors instead of revisiting settled items. Historical reports remain accessible. |

### C. Presentation and Agent-count overhead

| ID | Priority / evidence | Change to investigate | Intended gain and required constraint |
| --- | --- | --- | --- |
| C1 | First / Observed | Cache authority/tree order by roster version; replace the `authorityOrder.includes(record)` loop with a membership Set; use iterative traversal where depth warrants it. [S4] | The membership fallback itself can be quadratic. Host-state changes do not change ancestry order. Preserve ordering, orphan/moderator handling, and authorization. |
| C2 | First / Observed | Retain per-Agent status/roster projections keyed by relevant host, settings, evidence, and inherited-Owner versions. [S4] | Avoid rebuilding every row and resorting dormant Agents on unrelated events. Include `inspectedThrough` where the consumer actually displays or relies on it; do not equate visual equality with evidence equality. |
| C3 | Next / Observed | Cache activity and selector render results by data version, width, theme, selection, and animation state. [S11] | Spinner ticks should update only animation-dependent output, not rerun whole roster/report filtering. The activity surface already captures snapshots outside `render()`; build on that. |
| C4 | Next / Observed | Reuse selector ID/parent maps and unchanged item objects; update visible rows before off-screen formatting. [S11] | Preserve selection, pointer hit regions, viewport, pending preparation, resize, and report detail behavior. The selector already limits visible output; focus on upstream rebuilding rather than claiming virtualization is entirely absent. |
| C5 | Next / Candidate | Audit hidden-view subscriptions, animation timers, and retained child native TUIs. [S11, S14] | Do not rebuild an unobserved presentation. Keep operational coordination active, keep valid retained Runs alive, and verify disposal removes only the obsolete subscriber. |
| C6 | Later / Observed | Cache PTY frames by terminal-output/resize/scroll/cursor generation; investigate dirty-line conversion if frame construction profiles hot. [S14] | `frame()` currently allocates cells across the whole viewport. Preserve complete handoff redraws and terminal parser state. Never skip parsing unselected PTY output merely because it is not displayed. |

### D. Transcript observation and model-context work

| ID | Priority / evidence | Change to investigate | Intended gain and required constraint |
| --- | --- | --- | --- |
| D1 | First / Measured | Reduce repeated public `SessionManager.getEntries()` observations on a verified unchanged source. [S1, S6, S9] | The current API enumerates history even though the adapter consumes only its suffix. Start with call-site coalescing and observation reuse, not private-array access or monkey-patching append methods. |
| D2 | Later / Candidate | Investigate an upstream public append/revision interface, such as a generation plus bounded entries-since-cursor read. [S6] | This is a proposed capability, not an API assumed to exist. It needs explicit reset, off-branch append, and commit-notification semantics. Only upstream/public support can remove the remaining enumeration cost generically. |
| D3 | Next / Observed | Batch source metadata observations and evaluate async file operations where synchronous `stat/open/read` contributes to stalls. [S1] | Unchanged file reads still call `statSync`; zero `bytesRead` is not zero I/O. Notifications can accelerate freshness checks, but cannot be the sole correctness signal. |
| D4 | First / Observed | Apply an end-to-end cooperative budget to roster preparation, observation setup, Request-change collection, graph updates, and final publication. [S3, S5] | The current 8 ms allowance is per Agent and excludes some map/roster setup. Yield across the entire pass. Avoid synchronous `inspect()` catch-up from presentation or a supposedly budgeted final step. |
| D5 | Later / Observed | Wake only projections whose indexed buckets changed; audit append fan-out into historical scopes. [S2] | `RetainedTranscript.append()` visits retained scopes and installed projections. Keep historical evidence/query behavior; laziness must not erase current authority or required validation. |
| D6 | Next / Observed | Cache reusable fragments of coordination-history projection: marks, physical occurrences, call/result ownership, and already-projected groups. [S9, S10] | The marked-history path rebuilds branch/context maps and revisits visible groups. Invalidate affected fragments when a later result or rejection changes an earlier group; do not blindly append to the previous final output. |
| D7 | Next / Observed | Retain immutable-message keys and entry/occurrence lookup indexes instead of repeated content-key computation, filtering, and forward/backward ownership searches. [S10] | Physical entry ID plus occurrence/scope matters: native tool-call IDs can repeat in inherited history. Other extensions may clone or transform context; do not assume their message objects are immutable. |
| D8 | Later / Candidate | Cache unchanged obligation-attention and rejection-derived context fragments where versions prove equivalence. [S9, S10] | Preserve signed thinking, native call/result grouping, compaction boundaries, and newest Delivery placement. Never cache the complete context solely by transcript length; input messages and other extensions can change independently. |
| D9 | Later / Candidate | Profile very large JSONL records and partial-buffer copying separately from ordinary history length. [S1] | A single parse cannot yield halfway through `JSON.parse`; repeated `Buffer.concat` while assembling a large partial record may amplify copying. Consider segmented buffering or isolated CPU work only after measurements. Preserve strict UTF-8, complete-line commitment, and visible parse failures. |

### E. Memory, cold paths, and conditional alternatives

| ID | Priority / evidence | Change to investigate | Intended gain and required constraint |
| --- | --- | --- | --- |
| E1 | Next / Measured motivation | Measure retained heap/RSS by Agent state; bound heavyweight disposable caches with explicit eviction or a memory budget. [S1, S2, S7] | Weak registries do not help objects still strongly retained by the roster. Dormant means no live Run, not no possible obligations. Preserve enough dependency information to wake an evicted projection or reconstruct it before authoritative use. |
| E2 | Later / Observed | Bound the append-only changed-Request journal and stale memo/scope retention. [S2, S3] | Compact only below all live consumers' cursors, or invalidate lagging consumers and rebuild on demand. Do not drop changes that an unrefreshed consumer still needs. |
| E3 | Next / Candidate | Measure idle native process, extension, PTY, and handle costs separately from dormant AgentRecords. [S13, S14] | Audit whether settled, unretained runtimes are actually released. Do not change retention, model concurrency, or user-selected child behavior merely to improve a benchmark. |
| E4 | Later / Candidate | Separate cold admission audit from nonessential UI/context materialization; use bounded discovery concurrency. [S15] | Initial admission still verifies identities and required sources. A discovery index or checkpoint, if ever justified, is disposable acceleration, not a replacement for current evidence. Do not restore cached live Runs or pending scheduling. |
| E5 | Later / Candidate | Investigate sharing template/resource discovery only where runtime cwd, trust, reload generation, and policy truly match. [S13] | Per-Agent catalogue caching already exists. Preserve explicit reload and fresh Runtime Preparation semantics; do not reuse stale effective launch configuration. |
| E6 | Later / Candidate | Audit report-history copies, retained diagnostics, listeners, timers, and per-event logging. [S4, S5, S11, S14] | Retain durable history while bounding UI materialization and diagnostic buffers. A leak or logging bottleneck was not demonstrated by this investigation. |
| E7 | Conditional / Candidate | Consider a small worker pool only for measured CPU-heavy parsing/projection work that remains after incrementalization. [N3] | Workers add ownership, transfer, cancellation, and invalidation costs. They do not eliminate O(A²) redundant work and are not the first choice for routine file I/O. |

## 5. Minimal cache and dirtiness contract

This is a design direction to validate in an implementation ExecPlan, not a new general-purpose cache framework.

### Separate kinds of change

Reuse the existing transcript and Request versions wherever possible. Add only the missing distinctions:

| Change token | What it protects |
| --- | --- |
| Source/identity epoch | Transcript replacement, manager replacement, new identity cutoff, or other reset invalidates all projections that depend on that source. |
| Committed append position/version | Physical evidence advanced. An ordinary non-coordination append need not dirty the Request graph. |
| Request version/change IDs | Only relevant Request resolutions and their dependent Agents/Waits/conditions need recomputation. |
| Host/Run version | Busy/idle/failure/Hold/retention/queue changes can matter without any transcript append. Include exact Run identity when publishing actions. |
| Context projection version | Active leaf, compaction/projection edits, input message sequence, and relevant marks determine model-context reuse. This is not interchangeable with the physical cursor. |
| Roster/policy version | Structural admission and policy changes invalidate the relevant shared topology/configuration projections. Some are legitimately global. |

A cache key must include every dependency that can change its result. Conversely, avoid one global version that forces all caches to miss on every append.

### Drain without losing changes

The queueing invariant should be simple:

1. A producer records the affected Agent/Request and advances the relevant version.
2. One scheduled drain takes the current batch out of the pending queue. New events go into a new pending batch immediately.
3. The drain reads committed evidence and computes affected projections under an explicit observation boundary, yielding as needed.
4. Before publishing a computed result or taking a lifecycle action, validate its source epoch, dependency versions, and exact Run. A stale computation does not overwrite newer state.
5. Publish changed results. Remaining or newly arrived dirtiness receives one successor drain.

Do not clear a shared dirty flag at the end of asynchronous work: that can erase events that arrived while it was running. Do not retry evidence errors in a tight drain loop. Preserve a visible error and use the existing controlled retry/reconciliation semantics.

Existing snapshots are borrowed views over mutable retained arrays, not immutable snapshots. Keeping a reference over an await does not prove that the same observation remains valid. Reacquire evidence or use explicit generation/prefix validation. [S1]

### Dirtiness is not authority

A dirty notification means "this source may have changed," not "a record committed." In particular, `message_end` precedes native publication in this integration and must not advance a committed cursor by itself. [S9]

File notifications also cannot certify that a source is unchanged: Node documents inode replacement and missing-filename caveats. Use them as hints, with appropriate authoritative read barriers and bounded reconciliation for missed/unknown changes. The existing event-loss fallback is part of the correctness model, not automatically waste to delete. [S1, S12, N2]

For a local Request query, refresh its known evidence/dependency closure. For a global negative claim or an unknown invalidation, broaden the audit appropriately. Merely checking the currently known positive dependencies can miss a newly appearing relationship.

## 6. Concrete failure cases the design must survive

| Case | Required outcome |
| --- | --- |
| Agent A changes again while its prior update is awaiting I/O | The second version remains dirty; the old result cannot mark it clean. |
| Requester proof arrives before the responder's local result | The relevant earlier Request resolution is invalidated and reconstructed correctly. |
| Dormant Agent receives new evidence, or still has an unresolved obligation | Its identity is not discarded; affected consumers wake/rebuild even without a live process. |
| A child is admitted or a source epoch is replaced during an observation | Recheck topology/epoch before publication; do not commit mixed-generation results. |
| Transcript truncation, same-size rewrite, replacement, or a rewritten incomplete tail | Preserve the existing reset/reconstruction rules; never splice partial bytes into invented evidence. |
| Active leaf changes without new entries; compaction or projection edits change visible context | Rebuild the affected context, while retaining valid all-branch coordination evidence. |
| Host fails, resumes, terminates, or gains a Hold without an append | Host/Run dirtiness drives the required status, scheduling, and moderation update. |
| A dependency edge changes inside a cycle | Re-evaluate the affected graph region, widening to a full pass when needed; do not leave stale deadlock conclusions. |
| A marks cache encounters repeated native tool-call IDs, cloned input messages, or later results | Preserve physical occurrence/scope matching and mark the correct historical group. |
| UI width/theme/view changes, or a PTY switches alternate screen | Invalidate presentation caches independently of protocol caches; preserve handoff and full-redraw semantics. |
| A projection throws, a watcher is missed, or a subscriber is disposed during a drain | No silent stale-success result, missed permanent dirtiness, runaway retry, or notification of the obsolete view. |
| Cache eviction or process restart | Rebuild authority from transcripts; do not restore volatile scheduling, Wait intent, or Runs. |

## 7. Measurements and acceptance gates before implementation

Extend the existing benchmark rather than relying only on two large transcripts. Separate total known Agents, live native processes, total history per Agent, active Request edges, and dirty Agents per turn.

Use a compact matrix such as 1/10/50/100/200/400 Agents; fixed small and long histories; zero/one/many dirty Agents; and sparse/dense Request graphs. Include one-host-state-only change, one ordinary append, one Request/Answer, one new Agent, event bursts, cold reopen, Owner input, selector open/closed, and selected/unselected child output.

Measure extension enabled versus disabled on the same copied representative workflow. Avoid changing provider/model, terminal geometry, or running child count between comparisons. Provider latency is separate from input-to-render and coordination latency.

Counters worth adding:

- Refresh requests, actual drains, successor drains, and distinct dirty Agents/Requests.
- Agents scanned, relationship candidates evaluated, topology rebuilds, and cache hits/misses by reason.
- SessionManager enumerations/references, file metadata calls, bytes read, entries consumed, and physical reconstruction count.
- Subscriber calls, snapshots built, rows formatted, terminal cells converted, IPC payload bytes, and redraws.
- CPU/elapsed time by stage, event-loop delay, heap/RSS, GC pauses, live processes, and retained listeners/timers.

Node provides event-loop delay histograms and event-loop utilization in `perf_hooks`. Record those alongside CPU profiles and the existing heartbeat metric; utilization is not itself a CPU-usage measure. Disable or bound diagnostic output so measurement does not create a new hot path. [N1]

Acceptance should favor deterministic work counts over brittle absolute-time assertions:

| Scenario | Acceptance direction |
| --- | --- |
| No change after warmup | No parsing, no relationship reevaluation, no row rebuilding, and no global refresh initiated merely by a spinner. Explicit authoritative queries may still check source freshness. |
| One Agent changes in a large sparse workflow | Work follows that Agent and affected Request/dependency edges, not every unrelated Agent pair. |
| One ordinary non-coordination append | Consume its suffix and update relevant recency/context metadata without rebuilding all Request relationships. |
| One new Agent | Update structural order and relevant Creation Request relationships without invalidating unrelated settled history. |
| Large dirty backlog | Input/timer work receives turns throughout catch-up, including roster preparation and final publication; no nominally async all-Agent synchronous tail. |
| Evicted cache or cold restart | Results match full authoritative reconstruction, with no invented delivery or scheduling. |

For correctness, compare the optimized projection with full reconstruction across a small number of consequential sequences: append, Answer-before-result, cancellation, branch/compaction change, source reset, dirty-during-await, graph-cycle change, and exact-Run replacement. Reuse existing transcript/Request/UI contracts. Do not add a large suite of tests coupled to internal cache layout.

## 8. Recommended implementation order

**Step 1: Baseline and two contained wins.** Preserve the Agent ID in activity changes and cache authority order with a Set-backed membership pass. Add work counters and an Agent-count benchmark. Prove unchanged subscribers do not rebuild unrelated rows. Keep protocol behavior unchanged.

**Step 2: Incremental relationships.** Add dirty Request/Agent routing and reverse dependencies around the existing Request-version logic. Remove the per-Agent full-roster cursor-map work. Handle new-Agent deltas without treating each admission as a global evidence reset. Compare against full reconstruction before touching moderation.

**Step 3: Share observations and narrow moderation/Wait work.** Coalesce compatible refreshes, retain exact boundary semantics, and enforce a whole-pass latency budget. Then move incident and Wait consumers onto the same change information without weakening fallback validation.

**Step 4: Profile the residual cost.** Optimize context projection, status rendering, file metadata observation, memory retention, or PTY conversion only where the representative profile justifies it. Investigate an upstream revision/entries-since interface if public enumeration remains dominant.

Do not combine this work with reopening #129, changing the durable protocol, rewriting Runtime ownership, or migrating to a different Pi extension architecture. Each slice should leave the current extension usable and independently reviewable.

### Decision matrix

Scores are qualitative engineering judgments from this inspection, not benchmark results. Scale 1–5, higher is better. Weights reflect responsiveness without another risky correctness rewrite: responsiveness 35%, correctness confidence 35%, simplicity 20%, memory/CPU footprint 10%.

| Approach | Responsiveness | Correctness confidence | Simplicity | Footprint | Weighted score |
| --- | ---: | ---: | ---: | ---: | ---: |
| Incremental dirty routing using existing transcript projections | 5 | 4 | 4 | 4 | 4.35 |
| Increase debounce intervals / refresh less often without dependency tracking | 2 | 3 | 5 | 3 | 3.05 |
| Move existing broad scans into workers first | 3 | 2 | 2 | 2 | 2.35 |
| Rewrite coordination around a second durable state store | 4 | 1 | 1 | 3 | 2.25 |

Recommendation: the first option, delivered in small slices. Lowering concurrency can be a temporary workload mitigation, but does not fix the measured cost of hundreds of already-known, unchanged Agents.

## 9. Reproduce the Agent-count probe

This command uses existing in-memory test helpers, starts no model or live Run, and does not write project files. It intentionally isolates empty-roster overhead; add realistic source-complete workflows to the maintained benchmark before accepting an implementation.

```sh
node --expose-gc --input-type=module -e '
import { participant } from "./tests/support/request-history.ts";
import { MessageCoordinator } from "./src/coordination/messages.ts";
import { WorkflowPolicyStore } from "./src/policy/workflow-policy.ts";
import { setImmediate as yieldTurn } from "node:timers/promises";
console.log(JSON.stringify({ node: process.version }));
for (const size of [10, 50, 100, 200, 400]) {
  const records = Array.from({ length: size }, (_, i) => participant(`probe-${i}`).record);
  const messages = new MessageCoordinator({
    agents: new Map(records.map(r => [r.identity.agentId, r])),
    workflowPolicy: new WorkflowPolicyStore(),
    isShuttingDown: () => false,
  });
  for (let i = 0; i < 5; i++) await messages.refreshTranscriptFacts();
  global.gc?.();
  const before = records.map(r => r.transcript.diagnostics());
  const times = [];
  for (let i = 0; i < 10; i++) {
    await yieldTurn();
    const started = performance.now();
    await messages.refreshTranscriptFacts();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const after = records.map(r => r.transcript.diagnostics());
  console.log(JSON.stringify({
    agents: size,
    samples: times.length,
    medianMs: (times[4] + times[5]) / 2,
    maxMs: times.at(-1),
    consumed: after.reduce((n, d, i) => n + d.entriesConsumed - before[i].entriesConsumed, 0),
    localEnumerations: after.reduce((n, d, i) => n + d.localEnumerations - before[i].localEnumerations, 0),
  }));
}
'
```

## 10. Primary sources and inspected code locations

Locations refer to baseline `e1d08de`; line numbers can move after implementation. Measurements in section 3 came from the commands run during this investigation, not from the older timing claims in the documentation.

- **S1:** [Transcript consumption contract](../transcript-consumption.md), especially observation ownership, cursors, source reset, and snapshot semantics; [SessionManager/file readers](../../src/pi-integration/session-manager-transcript.ts), lines 35–109 and 113–283.
- **S2:** [Retained transcript](../../src/transcript/retained-transcript.ts), lines 10–29, 57–127, and 149–183: retained state, append fan-out, Request versions, journal, and memoization.
- **S3:** [Request evidence](../../src/coordination/request-evidence.ts), lines 435–635: workflow/Agent refresh, graph setup, roster invalidation, changed-Request collection, and incremental membership.
- **S4:** [Workflow coordinator](../../src/coordination/workflow-coordinator.ts), lines 685–688 and 995–1192: broad refresh entry point, authority ordering, roster/status/activity projections, notifications, and host integration.
- **S5:** [Operational incidents](../../src/coordination/operational-incidents.ts), lines 610–636, 719–802, and 1469–1486: scheduling, observation, broad condition reconciliation; [moderation contract](../operational-incident-moderation.md).
- **S6:** Installed Pi source `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`, `getEntries()` near line 1103; public-enumeration behavior also documented and measured in S1/S7. The proposed upstream API in D2 is not an existing-method claim.
- **S7:** [Existing transcript benchmark](../../benchmarks/transcript-consumption.ts): history fixtures, unchanged reads, work counters, dense relationships, heap, and heartbeat measurements.
- **S8:** [Request-history fixture](../../tests/support/request-history.ts), `participant()` near lines 76–98; actual refresh entry point in [MessageCoordinator](../../src/coordination/messages.ts), near line 287. See section 9 for the exact standalone measurement.
- **S9:** [Participant lifecycle](../../src/pi-integration/participant-lifecycle.ts), lines 76–128 and 139–216; [bootstrap lifecycle handlers](../../src/bootstrap/agent-extension.ts), lines 169–223.
- **S10:** [Coordination-history context projection](../../src/pi-integration/coordination-history-context.ts), lines 44–330: mark grouping, physical/context mapping, ownership searches, and compaction-aware occurrence handling.
- **S11:** [Activity surface](../../src/presentation/agent-activity-surface.ts), near lines 97–160 and 260–276; [selector surface](../../src/presentation/agent-selector-surface.ts), near lines 194–201, 342–491, 605–639, and 747–875. Some UI candidates are audit targets, not measured hot paths.
- **S12:** [Agent Waits](../../src/coordination/agent-waits.ts), near lines 298–413; [Wait contract](../agent-messaging.md#join-outstanding-answers), including the five-second fallback and exact-Run semantics.
- **S13:** [Process child factory](../../src/runtime/process-child-session-factory.ts), near lines 103, 292, and 341–395; [Agent spawning](../agent-spawning.md); [run supervision](../run-supervision.md).
- **S14:** [PTY projection](../../src/process-runtime/pty-terminal-projection.ts), lines 233–267; [child presentation contract](../child-ui-context.md); [Agent view acceptance](../agent-view-acceptance.md). Unselected-process and transport costs still require profiling.
- **S15:** [Cold discovery](../../src/bootstrap/cold-host-discovery.ts), near lines 93–194 and 332–336; [cold recovery contract](../cold-host-recovery.md).
- **N1:** [Node performance measurement APIs](https://nodejs.org/api/perf_hooks.html): event-loop delay and event-loop utilization. Consult APIs available in the project's actual supported Node versions, not only the current documentation's newer additions.
- **N2:** [Node filesystem watcher caveats](https://nodejs.org/api/fs.html#caveats): watcher behavior, inode replacement, and possibly absent filenames.
- **N3:** [Node worker threads](https://nodejs.org/api/worker_threads.html): CPU-intensive workloads, I/O limitations, and worker-pool overhead.
