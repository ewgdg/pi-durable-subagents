# Transcript facts and incremental consumption

Pi transcripts remain the durable authority. An Agent's transcript adapter retains
physical entries and disposable indexes in memory. Loaded child Identity, its captured
`creationPreset`, and `creationInput` are trusted records. Creation Request lookup derives
and retains its Request from the Identity spawn pointer and `creationInput` without
inspecting the Spawner again. Cold discovery
reads the referenced source once to obtain the required spawn input; missing or
unreadable required input prevents admission.

## Ownership and observations

One adapter owns physical consumption, entry positions, identity cutoffs, source
and result buckets, Delivery indexes, parsed Request sources, Answer Retrievals,
and model/thinking metadata. Protocol projections use that state rather than
keeping independent history caches. Once initialized, a projection advances as
its indexed entries arrive. The core coordination projections are installed at the
current Identity bootstrap, so initial parsing runs within the reader’s catch-up
budget. Request-specific versions invalidate only affected resolutions. Outstanding
relationships retain their membership and consume changed Request identities. An invalid projection reports its evidence error to
its consumer; it does not turn unrelated entries into invalid evidence.

SessionManager adapters are shared by manager identity. File adapters are shared
by path through weak references, so an unused transcript can be collected. Neither
registry is a second durable store. Reload or reopening after collection can
reconstruct the same facts. Reconstruction does not start Runs, schedule Messages,
restore pending deliveries, or recreate incident handling.

`refresh()` obtains current committed evidence asynchronously. Concurrent refreshes
share consumption. Catch-up yields after at most 256 entries or one 64 KiB file
chunk. Relationship catch-up also yields after 256 steps or roughly 8 ms; it
budgets both change collection and relationship evaluation. Coordination tool execution, lifecycle observations, incident reconciliation,
and explicit selector opening refresh before reading facts. Run startup awaits
relationship reconstruction while its existing startup fence is held; it preserves
the exact Run’s readiness and terminal lifecycle. The Owner awaits initialization
before publishing its participant view. Synchronous rendering
uses `snapshot()` while catch-up is running. `inspect()` is a synchronous current
read and drains the shared cursor, so latency-sensitive callers must refresh first
or use the rendering snapshot. A snapshot is a borrowed read-only view, not a frozen
copy of history. Its retained arrays advance with the transcript.

Branch and model-context construction is lazy. Coordination queries use all-branch
indexes. Selector model/thinking and recency use metadata retained during entry
consumption, without asking Pi to build model context or walk the active branch.

## Cursors and reconstruction

There are three different positions:

- The physical cursor tracks all appended entries. File readers separately retain
  the byte read position and an incomplete trailing buffer.
- The active leaf selects conversation context. Moving it does not remove
  coordination evidence on other branches.
- `inspectedThrough` names the last complete physical entry observed by a query.
  It is neither the active leaf nor a byte offset.

Synchronous consumers share an observation within each catch-up chunk. No
observation is held across an await. Each relationship chunk refreshes physical
sources asynchronously and pins the returned views without synchronously draining
later appends. Completed updates reacquire evidence before returning. Workflow scopes
capture the Agent roster before inspection and enter observations iteratively, so
roster size does not add synchronous call-stack depth. Nested scopes reuse or
explicitly override the pinned views and restore enclosing views in reverse order,
including when a reader or consumer throws.

A JSONL record commits only at its terminating newline. The reader retains split
UTF-8 bytes until the complete line is available and rejects invalid UTF-8 or JSON.
When the file changes, it rereads the incomplete tail from the last committed byte
so a rewritten partial entry cannot be spliced into invented evidence.
It indexes one complete entry and advances its committed cursor in the same
synchronous operation. It never treats `message_end` as proof of an append. Reads
check the source even when no live notification arrived.

Local sessions use public `SessionManager.getEntries()` and an entry cursor. Pi
has already parsed the entries; its O(total history) reference scan and shallow
list allocation are accepted costs. The adapter processes only entries after the
cursor. It does not use private storage or intercept append methods. A fresh list
identity is expected and does not invalidate state. Session header/path changes,
shortened history, or changed first/last-consumed entry references reconstruct the
adapter. Public session entries are immutable; branch/compaction appends retain
their physical evidence. Checking the leaf alone cannot detect off-branch appends.

A file replacement, truncation, same-size rewrite, or changed committed cursor
anchor reconstructs retained state. The reader checks the last 128 committed bytes
when the file grows, rather than rescanning the prefix. Normal appended compaction
and branch-summary entries do not reconstruct the file. A new matching Identity
resets the current coordination cutoff and its projections while retaining physical
history. Historical entries before that cutoff remain available to conversation
context and carry no current coordination authority.

## Validation and measurements

Run the focused transcript contracts with:

```sh
node --test tests/agent-transcript.test.ts tests/transcript-facts.test.ts tests/request-evidence.test.ts
node --expose-gc benchmarks/transcript-consumption.ts
```

The benchmark reports Owner SessionManager and Agent file-backed paths at 2,000 and
20,000 historical entries, including authored Requests. It measures initial
reconstruction, 100 unchanged reads, one appended entry, a 10,000-entry backlog,
bytes read, entries parsed/consumed, retained heap, and event-loop delay. Fixture
construction and writes are outside consumption timing. Heap measurements require
`--expose-gc` and include retained indexes; the file-backed path also retains parsed
history, while SessionManager already owns its history.

The benchmark also runs MessageCoordinator’s actual relationship refresh and
outstanding-Request query over 200 and 2,000 settled Request/Answer conversations,
then adds one Request and a 2,000-conversation backlog. A recurring heartbeat
records the maximum event-loop gap throughout each operation, including its final
synchronous work. Public list enumeration is timed separately for 100 reads.

On the implementation machine, unchanged reads reparsed and reconsumed zero
entries, and rebuilt no branch/context. Each fixed file append consumed one entry
and about 670 bytes including its cursor anchor. Public local enumeration took
about 2 ms at 2k entries and 24 ms at 20k entries for 100 calls: total local refresh
cost is not O(new entries). Retained heap at 20k entries was about 4.1 MB local
and 19.5 MB file-backed; the latter includes parsed history.

The 10k-entry backlogs took 20–31 ms with maximum heartbeat gaps below 2 ms.
The dense relationship backlogs took 153–154 ms with maximum gaps of 6.3–7.5 ms.
One additional Request took 0.5–0.8 ms. Repeating 100 unchanged dense queries in
one turn took 6–40 ms, including the permitted local enumeration cost. These are
measurements, not portable latency guarantees.

The copied workflow replay uses 89 source-complete Agent records, ten Owner
Creation Requests and six host changes. After warm reconstruction, reconciliation
took 13.0 ms; the maximum heartbeat gap was 12.9 ms. It performed zero file reads,
entry parsing/consumption or branch/context rebuilding; local public observations
enumerated 28,925 references over 89 calls. No records were excluded. These
measurements are not an identical-fixture comparison with the earlier #93 replay.
Raw measurements and the copied replay script remain with the task’s investigation
artifacts; the synthetic benchmark is reproducible from this repository.

## Further optimization work

The [performance optimization inventory](research/performance-optimization-inventory.md)
records new baseline measurements and proposed work above the existing transcript
cursor: dirty-Agent routing, dependency-directed relationship updates, observation
reuse, presentation caching, and bounded catch-up. Those proposals are not current
runtime guarantees.
