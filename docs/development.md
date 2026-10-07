# Development

## Compatibility

Pi supplies the package's Pi peer modules. Compatibility is defined jointly by a fail-fast structural gate against the running host module world and the native behavioral conformance suite. The Pi version is diagnostic only.

Process-isolated Agent Runtimes select local IPC internally: Unix-domain sockets on Unix platforms and native named pipes on Windows. This transport choice is not user-configurable.

## Coordination module wiring

The Workflow Coordinator is a composition root. It constructs coordination modules in dependency order: Request evidence, Request Relationships, Message coordination, Agent Wait, Human Requests, Run Supervision, Operational Incident detection, Interactive Selection, then the Spawner. It holds no closure that reads a module constructed after it; callbacks into its own steps (Agent integration, begin shutdown, participant view resolution) are allowed.

A protocol link is one whose absence changes coordination outcomes: Delivery, waits, incidents, Operation Review, or shutdown. Each one is either a required constructor argument, for commands a module issues, or a subscription the consuming module makes in its own constructor, for notifications it consumes. For example, Operational Incident detection subscribes to Message coordination's Delivery progress and to Human Requests' human waiting, and Interactive Selection subscribes to native quit of child Runtimes. A test that hand-wires these modules therefore gets the production glue, and omitting a link is a type error. Optional callbacks remain only for clocks, boundary hooks used by tests, presentation adapters, and the Agent activity change notification.

## Running tests

`npm test` is the complete regression suite. Use the supervised npm entry points for all development runs: `test:fast` (four concurrent files), `test:process` (serial), and `test:conformance` (serial, the focused compatibility gate). They forward any other Node test flag, such as `--test-only`.

Direct `node --test` execution bypasses containment, and interrupted direct runs have leaked spinning workers and Pi processes. Every test file therefore starts with `import "./support/supervised-run.ts";`, which refuses to run unless the supervisor marked the run. Set `PI_TEST_UNSUPERVISED=1` to accept running without containment, for example in an IDE test runner. The supervisor refuses to start if a test file lacks that first import.

Select one file and optionally a test name without bypassing supervision:

```bash
npm run test:process -- --file=agent-request.test.ts --test-name-pattern='request'
npm run test:fast -- --file=host-shape.test.ts
npm run test:conformance -- --file=host-shape.test.ts --list
```

## Where child Runtime tests live

Test the Owner–child Control seam in one process through the Child Control Loopback (`tests/support/child-control-loopback.ts`): the real Owner-side proxy and Owner serving, a real child connection and binding, the in-memory transport, and a faux Pi session. Delivery, cancellation, interrupt, queue clearing, Moderator reminders, compaction, settlement, idle custom startup, faults, and reload continuity belong there, in the fast suite.

Keep a test in the process suite only when its subject is something the loopback lacks:

- the PTY and terminal bytes;
- the launch contract and extension shell: CLI arguments, bootstrap, the startup tool filter, extension load order, inherited input preflights, and file-backed snapshot inputs;
- hello and admission over an OS transport;
- a real reload;
- process exit, kill, and shutdown grace.

Keep one end-to-end process smoke per role (ordinary and Moderator).

Cases that inject an event ordering a real child cannot produce on demand (for example a compaction edge without a Run, or dispatch completion racing settlement) use the scripted link in `tests/support/scripted-child-control-link.ts`.

## Asserting after incident evaluation

Operational Incident reconciliation and Request relationship retention trail a visible Run state change by at least one lane hop. Before asserting that something did *not* happen, or reading `retentionReasons`, await the affected Agent's `coordinator.forAgent(agentId).reachSafeBoundary()`: it runs after the reconciliation that Agent's settlement queued. Do not yield a fixed number of ticks instead; under load the outcome lands on either side of the check.

Scope a negative check to the incident kind under test. A fixture that loses an admitted Delivery leaves a known scheduling loss, which can start a Delivery Stall Moderator on any obligated Request path reaching that recipient.

## Deadlines and containment

Node's file timeout is 5 seconds for fast tests and 120 seconds for process/conformance tests. Suites run with `--test-force-exit`, so a file whose test timed out, or that leaves a handle open, exits once its tests finish instead of holding the suite until the supervisor deadline; descendants it leaves behind stay contained until suite cleanup. Independently, the supervisor starts a wall-clock timer when it launches the Node runner: `ceil(selected files / suite concurrency) × file timeout + 5 seconds`. A focused process file therefore gets 125 seconds; a name filter does not reduce that budget. Expiry reports the deadline, sends SIGTERM, then uses existing descendant force-kill cleanup after at most 100 ms of termination grace, and exits with code 124. Startup before launch and cleanup add time beyond that budget. This timer remains responsive when a test worker spins synchronously.

Force-exit hides a leaked handle, and without it the leak hangs the runner, so the supervised-run module every test file imports first also fails any file whose tests leave resources keeping its process alive. It gives closing resources a 2-second grace and names where each leftover was created (`tests/support/leaked-handles.ts`). The check runs before any file-level `after` hook, so release resources with cleanup owned by a test (`t.after(...)` or `t.signal`) or by a `describe` suite. To keep a fake-model Agent live, hold its response with `heldUntilAborted(...)` rather than a slow `fauxTokensPerSecond`: the fake provider only observes an abort after each chunk's timer, which then outlives the test.

For a deliberately different budget, append `--deadline-ms=10000`. It must be an integer from 1 through 2147483647; zero cannot disable containment. Forwarded Node flags do not alter the independently calculated suite budget; use the explicit deadline override when changing concurrency or Node timeouts.

On Linux with writable cgroup-v2 support, the existing cgroup and guardian contain Node/PTY descendants even if the supervisor is killed. Otherwise cleanup is best-effort: Linux tracks observed descendants via `/proc` (short-lived/reparented processes can escape observation); other Unix systems kill the runner process group, and Windows kills only the root process. The deadline requires the supervisor itself to remain alive and responsive; it is not a machine-level resource limit.

## Releasing

Pull requests and `main` pushes run no CI; the Release workflow is the only automated gate. It runs `typecheck` and `test:ci` on Node 22, the engines floor; local development covers newer Node. `test:ci` is the fast suite with a 15-second file timeout and an 8-minute deadline, because shared runners can be several times slower than a development machine. Run `npm run test:process` locally before a release; it launches real Pi processes and stays out of CI.

Pushing a stable version tag (`X.Y.Z` or `vX.Y.Z`; pre-release tags are ignored) runs the Release workflow. After the Node 22 gate passes, it checks that the tag matches `package.json`, publishes to npm through Trusted Publishing (OIDC, with provenance), and creates a GitHub Release with generated notes.

```bash
npm version patch   # bumps package.json and package-lock.json, commits, tags vX.Y.Z
git push --follow-tags
```

The npm package must list `xian0x5a/pi-durable-subagents` with workflow `release.yml` as its trusted publisher (npmjs.com → package Settings → Trusted publishing).

The package is scoped as `@xian0x5a/pi-durable-subagents` because the unscoped name was claimed by an unrelated placeholder; `publishConfig.access` keeps it public. The first version is published by hand (`npm publish`), because npm only accepts a trusted publisher for an existing package. Its tag then runs the workflow, which skips versions already on npm and only creates the GitHub Release.
