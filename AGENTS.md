## Design philosophy

The goal is to design a trust-based communication protocol.
Complicated security boundaries are out of the scope.

## Testing

Integration tests can be slow, avoid running the full test suite.
Run tests only through `npm run test:fast|test:process|test:conformance`, focusing with `-- --file=<name>.test.ts --test-name-pattern=<pattern>`; never run `node --test` directly, since it skips process containment.

## Screenshots

When a change alters what the Agent selector shows (tabs, rows, hints, labels), regenerate the README screenshot with `node docs/images/agent-switcher.capture.ts` (needs `rsvg-convert`).
