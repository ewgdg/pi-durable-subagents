# Development

## Compatibility

Pi supplies the package's Pi peer modules. Compatibility is defined jointly by a fail-fast structural gate against the running host module world and the native behavioral conformance suite. The Pi version is diagnostic only.

Process-isolated Agent Runtimes select local IPC internally: Unix-domain sockets on Unix platforms and native named pipes on Windows. This transport choice is not user-configurable.

## Running tests

`npm test` is the complete regression suite. Use the supervised npm entry points for all development runs: `test:fast` (four concurrent files), `test:process` (serial), and `test:conformance` (serial, the focused compatibility gate). Direct `node --test` execution bypasses containment and is not supported for development runs.

Select one file and optionally a test name without bypassing supervision:

```bash
npm run test:process -- --file=agent-request.test.ts --test-name-pattern='request'
npm run test:fast -- --file=host-shape.test.ts
npm run test:conformance -- --file=host-shape.test.ts --list
```

## Deadlines and containment

Node's file timeout is 5 seconds for fast tests and 120 seconds for process/conformance tests. Independently, the supervisor starts a wall-clock timer when it launches the Node runner: `ceil(selected files / suite concurrency) × file timeout + 5 seconds`. A focused process file therefore gets 125 seconds; a name filter does not reduce that budget. Expiry reports the deadline, sends SIGTERM, then uses existing descendant force-kill cleanup after at most 100 ms of termination grace, and exits with code 124. Startup before launch and cleanup add time beyond that budget. This timer remains responsive when a test worker spins synchronously.

For a deliberately different budget, append `--deadline-ms=10000`. It must be an integer from 1 through 2147483647; zero cannot disable containment. Forwarded Node flags do not alter the independently calculated suite budget; use the explicit deadline override when changing concurrency or Node timeouts.

On Linux with writable cgroup-v2 support, the existing cgroup and guardian contain Node/PTY descendants even if the supervisor is killed. Otherwise cleanup is best-effort: Linux tracks observed descendants via `/proc` (short-lived/reparented processes can escape observation); other Unix systems kill the runner process group, and Windows kills only the root process. The deadline requires the supervisor itself to remain alive and responsive; it is not a machine-level resource limit.
