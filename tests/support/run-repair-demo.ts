// One-command live demo: materialize a tempfile broken session, then replace
// this process with interactive pi on it (current checkout code via -e).
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrokenOwnerSession } from "./broken-session-fixture.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = await mkdtemp(join(tmpdir(), "repair-live-demo-"));
const built = await buildBrokenOwnerSession(outDir, repoRoot);
const extension = join(repoRoot, "src", "index.ts");
console.log("broken session: " + built.sessionFile);
const result = spawnSync("pi", ["--session", built.sessionFile, "-ne", "-e", extension], { stdio: "inherit", cwd: repoRoot });
if (result.error) {
  console.error("launcher: cannot start pi: " + String(result.error));
  process.exit(1);
}
process.exit(result.status ?? 0);
