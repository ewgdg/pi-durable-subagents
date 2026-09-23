# Activity presentation

The activity dock displays the latest published Agent status snapshot. Lifecycle, runtime configuration, queue, selection, and attention changes refresh that snapshot through the activity source's change notifications. Editor input, resizing, theme invalidation, and animation redraw the retained snapshot without inspecting transcripts.

A new dock samples its source when installed, and disposal removes its subscription and animation timer. Active children animate between state changes; settlement stops the timer.

## Incremental refresh and structural order

Host state/settlement events and explicit per-Agent activity refreshes identify the changed Agent. Their asynchronous refresh reads only those dirty Agent transcripts. Synchronous bursts share one pending batch; changes received while a batch is awaiting evidence remain in a successor batch, including another change to the same Agent. Unscoped notifications remain conservative and refresh the whole roster. Explicit `refreshTranscriptFacts()` also keeps its full-source freshness checks, so missed notifications and silent appends are not hidden from authoritative consumers.

Activity docks and selectors still share global notifications: current host state is published immediately, followed by refreshed transcript state. This change does not narrow subscriber scope or suppress unchanged row materialization. A failed refresh retains the existing diagnostic/error behavior rather than entering an automatic retry loop.

Authority-tree order is retained until Agent integration changes the roster. Ordinary child admission, recovered Agents, and Moderator admission share that invalidation path. Model, Run, queue, and selection changes do not invalidate ancestry. Building an order uses iterative preorder traversal and Set membership instead of repeated whole-array membership checks. Selector status construction and dormant-recency sorting remain live work; the cache does not freeze those values.

`WorkflowCoordinator.presentationDiagnostics()` exposes disposable work counters for activity refresh passes, sources scheduled for those passes, and authority-order builds. Scheduled source counts are not a claim that failed reads succeeded. Run the isolated scaling probe with:

```sh
node --test benchmarks/agent-activity.ts
```

With 10, 100, and 400 source-complete dormant Agents, the first implementation's probe scheduled exactly 20 source observations for 20 known-Agent activity refreshes at every size. Twenty selector roster reads built authority order once. Median scoped refresh times were 0.004-0.007 ms on that machine; the probe excludes cold initialization, model work, native redraw, and global relationship reconciliation. These are isolated measurements, not end-to-end latency guarantees.

The [performance inventory](research/performance-optimization-inventory.md) tracks the remaining work. In particular, this slice does not remove all-Agent relationship bookkeeping, global moderation refreshes, unscoped attention refreshes, or public SessionManager enumeration costs.

Presentation snapshots are transient display data. Explicit Agent status and roster observations still inspect current durable evidence. Each roster entry shares one transcript inspection across its evidence pointer, model/thinking context, and recency ordering.

Compaction is a transient human-facing activity, not a Run phase or scheduling state. While a live Agent compacts, both its dock row and the open `/agents` selector show `compacting` instead of ordinary work or waiting status. Start and end signals refresh both surfaces without reopening the selector; ending compaction reveals the current underlying status, not an assumed idle state. Native completion includes failure and cancellation, and Runtime failure or disposal clears the indicator. Lifecycle termination and failure labels take precedence.

The selector subscribes while open and removes that subscription on disposal. Refreshes preserve its selected Agent and scope.

In fullscreen mode the dock is also a pointer target: a completed primary click on any rendered dock row dispatches the registered `/agents` command exactly as if it had been submitted from the editor. Only completed clicks are consumed, so presses still start drag-selection over the dock, wheel keeps scrolling the transcript, and middle or secondary buttons have no dock action. A visible overlay owns interaction, so the dock never stacks its menu from behind one. Pi's regular terminal mode does not route component mouse input, so the dock is keyboard-only there and the `/agents` command remains the only entry. A dock installed without a menu action stays purely informational.
