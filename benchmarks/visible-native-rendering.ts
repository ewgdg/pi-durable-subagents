import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { PiChildProcessRuntime } from "../src/process-runtime/pi-child-process-runtime.ts";
import {
  PROCESS_RUNTIME_TEST_MODEL,
  PROCESS_RUNTIME_TEST_PROVIDER,
} from "../tests/fixtures/process-runtime-child-extension.ts";

const CHILD_COUNT = Number(process.env.PI_VISIBILITY_BENCHMARK_CHILDREN ?? 4);
const RESPONSE_DELAY_MS = Number(process.env.PI_VISIBILITY_BENCHMARK_DELAY_MS ?? 1200);
const SAMPLE_INTERVAL_MS = 50;
const COLUMNS = 120;
const ROWS = 40;
const CHILD_EXTENSION = fileURLToPath(new URL(
  "../tests/fixtures/process-runtime-child-extension.ts",
  import.meta.url,
));
const RENDER_PROBE_EXTENSION = fileURLToPath(new URL(
  "./visibility-render-probe-extension.ts",
  import.meta.url,
));

type Scenario = "hidden" | "one-visible";
type ChildMeasurement = {
  agentId: string;
  pid: number;
  nativeRenderCalls: number;
  initialNativeRenderCalls: number;
  totalNativeRenderCalls: number;
  ptyBytes: number;
  routedBytes: number;
  transcriptPersisted: boolean;
  responseEntries: number;
  transcriptPath: string;
};
type ScenarioMeasurement = {
  scenario: Scenario;
  childCount: number;
  elapsedMs: number;
  ownerResponsiveness: {
    samples: number;
    meanRoundTripMs: number;
    p95RoundTripMs: number;
    maxRoundTripMs: number;
    maxEventLoopGapMs: number;
  };
  children: ChildMeasurement[];
};

const artifactRoot = process.env.PI_VISIBILITY_BENCHMARK_ARTIFACT
  ?? join(
    process.env.HOME ?? tmpdir(),
    `.agents/artifacts/outputs/pi-durable-subagents/${new Date().toISOString().slice(0, 10)}/95-visible-native-rendering`,
  );
await mkdir(artifactRoot, { recursive: true });

const measurements: ScenarioMeasurement[] = [];
const transcriptEvidence: Array<Record<string, unknown>> = [];
for (const scenario of ["hidden", "one-visible"] as const) {
  measurements.push(await runScenario(scenario));
}
const result = {
  issue: 95,
  generatedAt: new Date().toISOString(),
  fixture: "tests/fixtures/process-runtime-child-extension.ts",
  renderProbe: "benchmarks/visibility-render-probe-extension.ts",
  children: CHILD_COUNT,
  responseDelayMs: RESPONSE_DELAY_MS,
  measurements,
  limitations: [
    "Native render counts come from a benchmark-only widget component in each child.",
    "PTY bytes count child output observed by the Owner projection; routed bytes count physical attachment output only.",
    "Owner responsiveness is queue.clear IPC round-trip latency and event-loop heartbeat, not a user-perceived terminal latency.",
    "Hidden children remain hidden after admission; the visible scenario attaches one child. This is not a before/after speedup comparison.",
    "The probe synchronously rewrites a JSON stats file on every render; render counts are directional and include this benchmark IO overhead.",
  ],
};
const resultPath = join(artifactRoot, "benchmark-result.json");
await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
await writeFile(join(artifactRoot, "transcript-evidence.json"), JSON.stringify(transcriptEvidence, null, 2) + "\n");
console.log(JSON.stringify({ resultPath, ...result }, null, 2));

async function runScenario(scenario: Scenario): Promise<ScenarioMeasurement> {
  const root = await mkdtemp(join(tmpdir(), `pi-visible-native-rendering-${scenario}-`));
  const runtimes: PiChildProcessRuntime[] = [];
  const detachHandlers: Array<() => void> = [];
  const counters = new Map<string, { ptyBytes: number; routedBytes: number }>();
  const statsPaths = new Map<string, string>();
  const sessionPaths = new Map<string, string>();
  const transcriptPaths = new Map<string, string>();
  try {
    for (let index = 0; index < CHILD_COUNT; index += 1) {
      const agentId = `${scenario}-child-${index}`;
      const sessionId = `019a6b4d-1b22-7000-8000-${scenario === "hidden" ? "95" : "96"}${String(index).padStart(10, "0")}`;
      const cwd = join(root, `work-${index}`);
      const agentDir = join(root, `agent-${index}`);
      const sessionDirectory = join(root, "sessions");
      const sessionPath = join(sessionDirectory, `${agentId}.jsonl`);
      const statsPath = join(root, `${agentId}.stats.json`);
      await Promise.all([
        mkdir(cwd, { recursive: true }),
        mkdir(agentDir, { recursive: true }),
        mkdir(sessionDirectory, { recursive: true }),
      ]);
      await writeFile(sessionPath, `${JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd,
      })}\n`, { mode: 0o600 });
      statsPaths.set(agentId, statsPath);
      sessionPaths.set(agentId, sessionPath);
      const runtime = await PiChildProcessRuntime.start({
        workflowId: `visibility-benchmark-${scenario}`,
        agentId,
        role: "ordinary",
        expectedSessionId: sessionId,
        sessionPath,
        configuration: {
          cwd,
          model: { provider: PROCESS_RUNTIME_TEST_PROVIDER, modelId: PROCESS_RUNTIME_TEST_MODEL },
          thinking: "off",
          tools: [],
          skills: [],
          extensions: [CHILD_EXTENSION, RENDER_PROBE_EXTENSION],
          loadContextFiles: true,
        },
        skillPaths: [],
        projectTrusted: true,
        agentDir,
        ownerEnvironment: {
          ...process.env,
          PI_SKIP_VERSION_CHECK: "1",
          PROCESS_RUNTIME_RESPONSE_DELAY_MS: String(RESPONSE_DELAY_MS),
          PI_VISIBILITY_BENCHMARK_STATS: statsPath,
        },
        runtimeDirectory: root,
        columns: COLUMNS,
        rows: ROWS,
      });
      runtimes.push(runtime);
      counters.set(agentId, { ptyBytes: 0, routedBytes: 0 });
      runtime.addOutputHandler((data) => {
        counters.get(agentId)!.ptyBytes += Buffer.byteLength(data);
      });
    }
    if (scenario === "one-visible") {
      const visible = runtimes[0]!;
      const agentId = "one-visible-child-0";
      const counter = counters.get(agentId);
      const remove = await visible.beginPhysicalTerminalAttachment((data) => {
        if (counter) counter.routedBytes += Buffer.byteLength(data);
      });
      detachHandlers.push(remove);
    }
    // Discard startup and attach bytes so workload output is comparable.
    for (const counter of counters.values()) {
      counter.ptyBytes = 0;
      counter.routedBytes = 0;
    }
    const initialRenderCalls = new Map<string, number>();
    for (const index of runtimes.keys()) {
      const agentId = `${scenario}-child-${index}`;
      initialRenderCalls.set(agentId, (await readStats(statsPaths.get(agentId)!)).renderCalls);
    }
    const startedAt = performance.now();
    const runIds = runtimes.map((_, index) => `${scenario}-run-${index}`);
    const settled = runtimes.map((runtime, index) => waitForSettled(runtime, runIds[index]!));
    const prompts = runtimes.map((runtime, index) => runtime.prompt({
      runId: runIds[index]!,
      input: `Benchmark concurrent child ${index}; persist the offline response.`,
      kind: "initial",
    }));
    const promptCompletion = Promise.all(prompts);
    const ownerResponsiveness = await measureOwnerResponsiveness(runtimes, runIds, settled);
    await promptCompletion;
    await Promise.all(settled);
    const elapsedMs = performance.now() - startedAt;
    const children: ChildMeasurement[] = [];
    for (let index = 0; index < runtimes.length; index += 1) {
      const runtime = runtimes[index]!;
      const agentId = `${scenario}-child-${index}`;
      const stats = await readStats(statsPaths.get(agentId)!);
      const transcriptPath = join(artifactRoot, "transcripts", `${scenario}-${agentId}.jsonl`);
      await mkdir(join(artifactRoot, "transcripts"), { recursive: true });
      await writeFile(transcriptPath, await readFile(sessionPaths.get(agentId)!));
      transcriptPaths.set(agentId, transcriptPath);
      const entries = SessionManager.open(transcriptPath).getEntries();
      children.push({
        agentId,
        pid: runtime.pid,
        nativeRenderCalls: stats.renderCalls - (initialRenderCalls.get(agentId) ?? 0),
        initialNativeRenderCalls: initialRenderCalls.get(agentId) ?? 0,
        totalNativeRenderCalls: stats.renderCalls,
        ptyBytes: counters.get(agentId)!.ptyBytes,
        routedBytes: counters.get(agentId)!.routedBytes,
        transcriptPersisted: entries.some((entry) =>
          entry.type === "message" && JSON.stringify(entry.message).includes("PROCESS_RUNTIME_PROMPT_OK")
        ),
        responseEntries: entries.filter((entry) =>
          entry.type === "message" && JSON.stringify(entry.message).includes("PROCESS_RUNTIME_PROMPT_OK")
        ).length,
        transcriptPath: transcriptPaths.get(agentId)!,
      });
      transcriptEvidence.push({
        scenario, agentId, transcriptPath: transcriptPaths.get(agentId)!,
        persisted: entries.some((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("PROCESS_RUNTIME_PROMPT_OK")),
        responseEntries: entries.filter((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("PROCESS_RUNTIME_PROMPT_OK")).length,
      });
    }
    return { scenario, childCount: CHILD_COUNT, elapsedMs, ownerResponsiveness, children };
  } finally {
    for (const remove of detachHandlers) remove();
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
  }
}

async function readStats(path: string): Promise<{ renderCalls: number }> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { renderCalls?: unknown };
      if (typeof parsed.renderCalls === "number") return parsed as { renderCalls: number };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`render_probe_stats_timeout: ${path}`);
}

function waitForSettled(runtime: PiChildProcessRuntime, runId: string): Promise<void> {
  return new Promise((resolve) => {
    const remove = runtime.onEvent((event) => {
      if (event.event !== "agent.settled" || event.payload.runId !== runId) return;
      remove();
      resolve();
    });
  });
}

async function measureOwnerResponsiveness(
  runtimes: readonly PiChildProcessRuntime[],
  runIds: readonly string[],
  settled: readonly Promise<void>[],
) {
  const values: number[] = [];
  let last = performance.now();
  let maxEventLoopGapMs = 0;
  let finished = false;
  const heartbeat = new Promise<void>((resolve) => {
    const tick = () => {
      const now = performance.now();
      maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - last);
      last = now;
      if (finished) resolve();
      else setImmediate(tick);
    };
    setImmediate(tick);
  });
  try {
    let allSettled = false;
    const settlement = Promise.all(settled).then(() => { allSettled = true; });
    while (!allSettled || values.length === 0) {
      const started = performance.now();
      await Promise.all(runtimes.map((runtime, index) =>
        runtime.channel.request("queue.clear", { runId: runIds[index]! }),
      ));
      values.push(performance.now() - started);
      if (!allSettled) await Promise.race([
        settlement,
        new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS)),
      ]);
    }
    await settlement;
  } finally {
    finished = true;
    await heartbeat;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    meanRoundTripMs: average(values),
    p95RoundTripMs: percentile(sorted, 0.95),
    maxRoundTripMs: Math.max(...values),
    maxEventLoopGapMs,
  };
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
