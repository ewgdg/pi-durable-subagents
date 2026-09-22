// Smoke test: the shared broken-session fixture still blocks admission on a
// fresh file read. Prints the tempfile path plus launch command for live use.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
import { inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import { transcriptFromSessionFile } from "../src/pi-integration/session-manager-transcript.ts";
import { buildBrokenOwnerSession } from "./support/broken-session-fixture.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("broken Owner session blocks admission", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "repair-broken-smoke-"));
  const built = await buildBrokenOwnerSession(outDir, repoRoot);
  const inspection = await transcriptFromSessionFile(built.sessionFile, { fresh: true }).refresh();
  assert.throws(
    () => inspectMessageDeliveries({ recipientAgentId: built.agentId, transcript: inspection }),
    (error: unknown) => error instanceof ProtocolInvariantError && String((error as Error).message).indexOf("duplicate Deliveries") >= 0,
    "fresh file read must throw duplicate Deliveries",
  );
  console.log("broken session: " + built.sessionFile);
  console.log("launch: pi --session " + JSON.stringify(built.sessionFile) + " -ne -e " + JSON.stringify(join(repoRoot, "src", "index.ts")));
});
