import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { HumanPresentationCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import type { DurableAgentView, PhysicalAgentViewSurface } from "../src/presentation/agent-view-surface.ts";
import { registerAgentsCommand } from "../src/tools/owner-surfaces.ts";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
type CapturedCommand = Readonly<{
  getArgumentCompletions?: (prefix: string) => unknown;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}>;
function captureCommand(register: (pi: ExtensionAPI) => void): CapturedCommand {
  let command: CapturedCommand | undefined;
  const pi = { registerCommand(_name: string, options: CapturedCommand) { command = options; } } as unknown as ExtensionAPI;
  register(pi);
  assert.ok(command);
  return command;
}
type PhysicalHarness = Readonly<{
  view: HumanPresentationCoordinatorView;
  opened: string[];
  bound: PhysicalAgentViewSurface[];
  unbound: PhysicalAgentViewSurface[];
  closedViews: string[];
  fakeView: DurableAgentView;
  moderatorId: string;
}>;
function mockHumanViewWithPhysical(opts: {
  moderatorId?: string;
  disposition?: "created" | "joined";
  requestError?: Error;
  openError?: Error;
  opened?: string[];
  bound?: PhysicalAgentViewSurface[];
  unbound?: PhysicalAgentViewSurface[];
  closedViews?: string[];
}): PhysicalHarness {
  const opened = opts.opened ?? [];
  const bound = opts.bound ?? [];
  const unbound = opts.unbound ?? [];
  const closedViews = opts.closedViews ?? [];
  const moderatorId = opts.moderatorId ?? "moderator-1";
  const fakeView = {
    agentId: moderatorId,
    label: "Moderator",
    projection() { throw new Error("not used in repair switch tests"); },
    addPresentationHandler() { return () => undefined; },
    addCloseHandler() { return () => undefined; },
    fail() {},
    close() { closedViews.push(moderatorId); return Promise.resolve(); },
  } as unknown as DurableAgentView;
  const view = {
    status: (() => ({ agentId: "owner", workflowId: "owner", label: "Owner" })) as HumanPresentationCoordinatorView["status"],
    requestManualRepair: (async () => {
      if (opts.requestError) throw opts.requestError;
      return { disposition: opts.disposition ?? "created", moderatorAgentId: moderatorId };
    }) as HumanPresentationCoordinatorView["requestManualRepair"],
    openAgentPresentation: (async (agentId: string) => {
      opened.push(agentId);
      if (opts.openError && agentId === moderatorId) throw opts.openError;
      return { kind: "selected", view: fakeView };
    }) as unknown as HumanPresentationCoordinatorView["openAgentPresentation"],
    bindPhysicalAgentSurface: ((surface: PhysicalAgentViewSurface) => {
      bound.push(surface);
      return () => { unbound.push(surface); };
    }) as HumanPresentationCoordinatorView["bindPhysicalAgentSurface"],
    humanAttention: (() => []) as unknown as HumanPresentationCoordinatorView["humanAttention"],
  } as unknown as HumanPresentationCoordinatorView;
  return { view, opened, bound, unbound, closedViews, fakeView, moderatorId };
}
function mockUiWithTransient(notifies: Array<{ message: string; kind: string }>, fakeTui: TUI, transientCalls: unknown[]): ExtensionUIContext {
  return {
    notify: (message: string, kind?: string) => { notifies.push({ message, kind: kind ?? "info" }); },
    custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
      transientCalls.push({ at: Date.now() });
      return new Promise<T>((resolve) => {
        const component = factory(fakeTui, { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme, {} as KeybindingsManager, (v: T) => resolve(v));
        void component;
      });
    },
  } as unknown as ExtensionUIContext;
}
type StartRecord = Readonly<{ view: DurableAgentView; ownerTui: TUI; surface: PhysicalAgentViewSurface }>;
function createFakeStart(records: StartRecord[], behavior: { throwError?: Error; returnUndefined?: boolean; readyError?: Error }) {
  return (view: DurableAgentView, opts: { ownerTui: TUI; requestShutdown: () => void }) => {
    if (behavior.throwError) throw behavior.throwError;
    if (behavior.returnUndefined) return undefined;
    let closedResolve!: () => void;
    const closedPromise = new Promise<void>((resolve) => { closedResolve = resolve; });
    const surface = {
      ready: behavior.readyError ? Promise.reject(behavior.readyError) : Promise.resolve(),
      closed: closedPromise,
      suspend() { return Promise.resolve(); },
      resume() { return Promise.resolve(); },
      close() { void view.close().catch(() => undefined).finally(() => closedResolve()); },
    } as unknown as PhysicalAgentViewSurface;
    records.push({ view, ownerTui: opts.ownerTui, surface });
    return surface;
  };
}
function fakeOwnerTui(): TUI {
  return { terminal: { rows: 20, columns: 80 }, requestRender() {}, stop() {}, start() {} } as unknown as TUI;
}
const admissionFailure = new OwnerRecoveryError(
  "Owner coordination initialization",
  "owner",
  "/tmp/owner-transcript.jsonl",
  new ProtocolInvariantError("committed Request is invalid", {
    source: { agentId: "owner", entryId: "source-entry", toolCallId: "source-call" },
    cause: new Error("missing-title"),
  }),
);
test("admitted repair switches to created Moderator via physical surface", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const transientCalls: unknown[] = [];
  const startRecords: StartRecord[] = [];
  const fakeTui = fakeOwnerTui();
  const harness = mockHumanViewWithPhysical({ moderatorId: "moderator-created", disposition: "created" });
  const fakeStart = createFakeStart(startRecords, {});
  const ui = mockUiWithTransient(notifies, fakeTui, transientCalls);
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => harness.view, "admitted", () => harness.view as never, undefined, { startRepairSurface: fakeStart as never }));
  await command.handler("repair triage test", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  assert.deepEqual(harness.opened, ["moderator-created"]);
  assert.equal(transientCalls.length, 1);
  assert.equal(startRecords.length, 1);
  assert.equal(startRecords[0] && startRecords[0].view, harness.fakeView);
  assert.equal(startRecords[0] && startRecords[0].ownerTui, fakeTui);
  assert.equal(harness.bound.length, 1);
  assert.equal(harness.bound[0], startRecords[0] && startRecords[0].surface);
  assert.deepEqual(harness.unbound, []);
  assert.deepEqual(harness.closedViews, []);
  assert.ok(notifies.some((n) => n.message.includes("moderator-created") && n.message.includes("created")));
});
test("admitted repair switches to live Moderator on joined via physical surface", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const transientCalls: unknown[] = [];
  const startRecords: StartRecord[] = [];
  const fakeTui = fakeOwnerTui();
  const harness = mockHumanViewWithPhysical({ moderatorId: "moderator-live", disposition: "joined" });
  const fakeStart = createFakeStart(startRecords, {});
  const ui = mockUiWithTransient(notifies, fakeTui, transientCalls);
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => harness.view, "admitted", () => harness.view as never, undefined, { startRepairSurface: fakeStart as never }));
  await command.handler("repair second call", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  assert.deepEqual(harness.opened, ["moderator-live"]);
  assert.equal(startRecords.length, 1);
  assert.equal(harness.bound.length, 1);
  assert.deepEqual(harness.closedViews, []);
  assert.ok(notifies.some((n) => n.message.includes("moderator-live") && n.message.includes("active")));
});
test("admitted repair failure keeps window with no surface attempt", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const transientCalls: unknown[] = [];
  const startRecords: StartRecord[] = [];
  const fakeTui = fakeOwnerTui();
  const harness = mockHumanViewWithPhysical({ requestError: new Error("boom") });
  const fakeStart = createFakeStart(startRecords, {});
  const ui = mockUiWithTransient(notifies, fakeTui, transientCalls);
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => harness.view, "admitted", () => harness.view as never, undefined, { startRepairSurface: fakeStart as never }));
  await command.handler("repair triage", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  assert.deepEqual(harness.opened, []);
  assert.deepEqual(startRecords, []);
  assert.deepEqual(harness.bound, []);
  assert.deepEqual(transientCalls, []);
  assert.ok(notifies.some((n) => n.kind === "error" && n.message.includes("boom")));
});
test("admitted repair prepare failure keeps window with no bind", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const transientCalls: unknown[] = [];
  const startRecords: StartRecord[] = [];
  const fakeTui = fakeOwnerTui();
  const harness = mockHumanViewWithPhysical({ moderatorId: "moderator-1", openError: new Error("view-boom") });
  const fakeStart = createFakeStart(startRecords, {});
  const ui = mockUiWithTransient(notifies, fakeTui, transientCalls);
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => harness.view, "admitted", () => harness.view as never, undefined, { startRepairSurface: fakeStart as never }));
  await command.handler("repair triage", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  assert.deepEqual(harness.opened, ["moderator-1"]);
  assert.deepEqual(startRecords, []);
  assert.deepEqual(harness.bound, []);
  assert.deepEqual(harness.closedViews, []);
  assert.ok(notifies.some((n) => n.message.includes("moderator-1")));
  assert.ok(notifies.some((n) => n.kind === "error" && n.message.includes("view-boom")));
});
test("admitted repair surface start failure releases prepared view with no half-switch", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const transientCalls: unknown[] = [];
  const startRecords: StartRecord[] = [];
  const fakeTui = fakeOwnerTui();
  const harness = mockHumanViewWithPhysical({ moderatorId: "moderator-1" });
  const fakeStart = createFakeStart(startRecords, { throwError: new Error("surface-boom") });
  const ui = mockUiWithTransient(notifies, fakeTui, transientCalls);
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => harness.view, "admitted", () => harness.view as never, undefined, { startRepairSurface: fakeStart as never }));
  await command.handler("repair triage", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  assert.deepEqual(harness.opened, ["moderator-1"]);
  assert.deepEqual(harness.bound, []);
  assert.deepEqual(harness.unbound, []);
  assert.deepEqual(harness.closedViews, ["moderator-1"]);
  assert.ok(notifies.some((n) => n.kind === "error" && n.message.includes("surface-boom")));
});
test("admitted repair surface ready failure closes and unbinds with no half-switch", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const transientCalls: unknown[] = [];
  const startRecords: StartRecord[] = [];
  const fakeTui = fakeOwnerTui();
  const harness = mockHumanViewWithPhysical({ moderatorId: "moderator-1" });
  const fakeStart = createFakeStart(startRecords, { readyError: new Error("ready-boom") });
  const ui = mockUiWithTransient(notifies, fakeTui, transientCalls);
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => harness.view, "admitted", () => harness.view as never, undefined, { startRepairSurface: fakeStart as never }));
  await command.handler("repair triage", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  assert.deepEqual(harness.opened, ["moderator-1"]);
  assert.equal(harness.bound.length, 1);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(harness.closedViews, ["moderator-1"]);
  assert.equal(harness.unbound.length, 1);
  assert.equal(harness.unbound[0], harness.bound[0]);
  assert.ok(notifies.some((n) => n.kind === "error" && n.message.includes("ready-boom")));
});
test("preadmission repair switches via host physical surface", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const transientCalls: unknown[] = [];
  const startRecords: StartRecord[] = [];
  const fakeTui = fakeOwnerTui();
  const harness = mockHumanViewWithPhysical({ moderatorId: "moderator-pre", disposition: "created" });
  const fakeStart = createFakeStart(startRecords, {});
  const ui = mockUiWithTransient(notifies, fakeTui, transientCalls);
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => { throw new Error("not admitted"); }, admissionFailure, undefined, () => harness.view, { startRepairSurface: fakeStart as never }));
  await command.handler("repair preadmission triage", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  assert.deepEqual(harness.opened, ["moderator-pre"]);
  assert.equal(startRecords.length, 1);
  assert.equal(startRecords[0] && startRecords[0].ownerTui, fakeTui);
  assert.equal(harness.bound.length, 1);
  assert.deepEqual(harness.closedViews, []);
  assert.ok(notifies.some((n) => n.message.includes("moderator-pre")));
});
test("preadmission repair failure keeps window", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const transientCalls: unknown[] = [];
  const startRecords: StartRecord[] = [];
  const fakeTui = fakeOwnerTui();
  const harness = mockHumanViewWithPhysical({ requestError: new Error("pre-boom") });
  const fakeStart = createFakeStart(startRecords, {});
  const ui = mockUiWithTransient(notifies, fakeTui, transientCalls);
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => { throw new Error("not admitted"); }, admissionFailure, undefined, () => harness.view, { startRepairSurface: fakeStart as never }));
  await command.handler("repair triage", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  assert.deepEqual(harness.opened, []);
  assert.deepEqual(startRecords, []);
  assert.deepEqual(harness.bound, []);
  assert.ok(notifies.some((n) => n.kind === "error"));
});
test("diagnostics repair switches via diagnostics TUI and closes on success", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const startRecords: StartRecord[] = [];
  const harness = mockHumanViewWithPhysical({ moderatorId: "moderator-diag", disposition: "created" });
  const fakeStart = createFakeStart(startRecords, {});
  let diagComponent!: Component;
  let diagDone = false;
  let diagTui: TUI | undefined;
  const ui = {
    notify: (message: string, kind?: string) => { notifies.push({ message, kind: kind ?? "info" }); },
    custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
      return new Promise<T>((resolve) => {
        diagComponent = factory(fakeOwnerTui(), { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme, {} as KeybindingsManager, (v) => { diagDone = true; resolve(v); });
        const withTui = diagComponent as unknown as { tui?: TUI };
        diagTui = withTui.tui;
      });
    },
  } as unknown as ExtensionUIContext;
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => { throw new Error("not admitted"); }, admissionFailure, undefined, () => harness.view, { startRepairSurface: fakeStart as never }));
  const completed = command.handler("diagnostics", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  await new Promise((r) => setImmediate(r));
  assert.ok(diagComponent);
  diagComponent.handleInput && diagComponent.handleInput("r");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(harness.opened, ["moderator-diag"]);
  assert.equal(startRecords.length, 1);
  assert.equal(harness.bound.length, 1);
  assert.equal(harness.bound[0], startRecords[0] && startRecords[0].surface);
  assert.deepEqual(harness.closedViews, []);
  assert.ok(notifies.some((n) => n.message.includes("moderator-diag")));
  assert.equal(diagDone, true);
  await completed;
});
test("diagnostics repair failure keeps diagnostics open with no surface", async () => {
  const notifies: Array<{ message: string; kind: string }> = [];
  const startRecords: StartRecord[] = [];
  const harness = mockHumanViewWithPhysical({ requestError: new Error("diag-boom") });
  const fakeStart = createFakeStart(startRecords, {});
  let diagComponent!: Component;
  let diagDone = false;
  const ui = {
    notify: (message: string, kind?: string) => { notifies.push({ message, kind: kind ?? "info" }); },
    custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
      return new Promise<T>((resolve) => {
        diagComponent = factory(fakeOwnerTui(), { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme, {} as KeybindingsManager, (v) => { diagDone = true; resolve(v); });
      });
    },
  } as unknown as ExtensionUIContext;
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => { throw new Error("not admitted"); }, admissionFailure, undefined, () => harness.view, { startRepairSurface: fakeStart as never }));
  const completed = command.handler("diagnostics", { ui, mode: "tui", shutdown() {} } as unknown as ExtensionCommandContext);
  await new Promise((r) => setImmediate(r));
  diagComponent.handleInput && diagComponent.handleInput("r");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(harness.opened, []);
  assert.deepEqual(startRecords, []);
  assert.deepEqual(harness.bound, []);
  assert.ok(notifies.some((n) => n.kind === "error"));
  assert.equal(diagDone, false);
  diagComponent.handleInput && diagComponent.handleInput("q");
  await completed;
});
