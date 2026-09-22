import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { HumanPresentationCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
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

function mockHumanView(opts: {
  moderatorId?: string;
  disposition?: "created" | "joined";
  requestError?: Error;
  openError?: Error;
  statusAgentId?: string;
  opened?: string[];
}): HumanPresentationCoordinatorView {
  const opened = opts.opened ?? [];
  return {
    status: (() => ({ agentId: opts.statusAgentId ?? "owner", workflowId: "owner", label: "Owner" })) as HumanPresentationCoordinatorView["status"],
    requestManualRepair: (async () => {
      if (opts.requestError) throw opts.requestError;
      return { disposition: opts.disposition ?? "created", moderatorAgentId: opts.moderatorId ?? "moderator-1" };
    }) as HumanPresentationCoordinatorView["requestManualRepair"],
    openAgentPresentation: (async (agentId: string) => {
      opened.push(agentId);
      if (opts.openError && agentId === (opts.moderatorId ?? "moderator-1")) throw opts.openError;
      return { kind: "selected" };
    }) as HumanPresentationCoordinatorView["openAgentPresentation"],
    humanAttention: (() => []) as unknown as HumanPresentationCoordinatorView["humanAttention"],
  } as unknown as HumanPresentationCoordinatorView;
}

function mockUi(notifies: Array<{ message: string; kind: string }>): ExtensionUIContext {
  return { notify: (message: string, kind?: string) => { notifies.push({ message, kind: kind ?? "info" }); } } as unknown as ExtensionUIContext;
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

test("admitted repair switches to created Moderator", async () => {
  const opened: string[] = [];
  const notifies: Array<{ message: string; kind: string }> = [];
  const view = mockHumanView({ moderatorId: "moderator-created", disposition: "created", opened });
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => view, "admitted", () => view as never));
  await command.handler("repair triage test", { ui: mockUi(notifies) } as unknown as ExtensionCommandContext);
  assert.deepEqual(opened, ["moderator-created"]);
  assert.ok(notifies.some((n) => n.message.includes("moderator-created") && n.message.includes("created")));
});

test("admitted repair switches to live Moderator on joined", async () => {
  const opened: string[] = [];
  const notifies: Array<{ message: string; kind: string }> = [];
  const view = mockHumanView({ moderatorId: "moderator-live", disposition: "joined", opened });
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => view, "admitted", () => view as never));
  await command.handler("repair second call", { ui: mockUi(notifies) } as unknown as ExtensionCommandContext);
  assert.deepEqual(opened, ["moderator-live"]);
  assert.ok(notifies.some((n) => n.message.includes("moderator-live") && n.message.includes("active")));
});

test("admitted repair failure keeps window", async () => {
  const opened: string[] = [];
  const notifies: Array<{ message: string; kind: string }> = [];
  const view = mockHumanView({ requestError: new Error("boom"), opened });
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => view, "admitted", () => view as never));
  await command.handler("repair triage", { ui: mockUi(notifies) } as unknown as ExtensionCommandContext);
  assert.deepEqual(opened, []);
  assert.ok(notifies.some((n) => n.kind === "error" && n.message.includes("boom")));
});

test("admitted repair view failure keeps window", async () => {
  const opened: string[] = [];
  const notifies: Array<{ message: string; kind: string }> = [];
  const view = mockHumanView({ moderatorId: "moderator-1", opened, openError: new Error("view-boom") });
  const command = captureCommand((pi) => registerAgentsCommand(pi, () => view, "admitted", () => view as never));
  await command.handler("repair triage", { ui: mockUi(notifies) } as unknown as ExtensionCommandContext);
  assert.deepEqual(opened, ["moderator-1"]);
  assert.ok(notifies.some((n) => n.message.includes("moderator-1")));
  assert.ok(notifies.some((n) => n.kind === "error" && n.message.includes("view-boom")));
});

test("preadmission repair switches via host", async () => {
  const opened: string[] = [];
  const notifies: Array<{ message: string; kind: string }> = [];
  const host = mockHumanView({ moderatorId: "moderator-pre", disposition: "created", opened });
  const command = captureCommand((pi) =>
    registerAgentsCommand(pi, () => { throw new Error("not admitted"); }, admissionFailure, undefined, () => host),
  );
  await command.handler("repair preadmission triage", { ui: mockUi(notifies) } as unknown as ExtensionCommandContext);
  assert.deepEqual(opened, ["moderator-pre"]);
  assert.ok(notifies.some((n) => n.message.includes("moderator-pre")));
});

test("preadmission repair failure keeps window", async () => {
  const opened: string[] = [];
  const notifies: Array<{ message: string; kind: string }> = [];
  const host = mockHumanView({ requestError: new Error("pre-boom"), opened });
  const command = captureCommand((pi) =>
    registerAgentsCommand(pi, () => { throw new Error("not admitted"); }, admissionFailure, undefined, () => host),
  );
  await command.handler("repair triage", { ui: mockUi(notifies) } as unknown as ExtensionCommandContext);
  assert.deepEqual(opened, []);
  assert.ok(notifies.some((n) => n.kind === "error"));
});

test("diagnostics repair switches and closes on success", async () => {
  const opened: string[] = [];
  const notifies: Array<{ message: string; kind: string }> = [];
  const host = mockHumanView({ moderatorId: "moderator-diag", disposition: "created", opened });
  let diagComponent!: Component;
  let diagDone = false;
  const ui = {
    notify: (message: string, kind?: string) => { notifies.push({ message, kind: kind ?? "info" }); },
    custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
      return new Promise<T>((resolve) => {
        diagComponent = factory({ terminal: { rows: 20 }, requestRender() {} } as unknown as TUI,
          { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme,
          {} as KeybindingsManager,
          (v) => { diagDone = true; resolve(v); });
      });
    },
  } as unknown as ExtensionUIContext;
  const command = captureCommand((pi) =>
    registerAgentsCommand(pi, () => { throw new Error("not admitted"); }, admissionFailure, undefined, () => host),
  );
  const completed = command.handler("diagnostics", { ui, mode: "tui" } as unknown as ExtensionCommandContext);
  await new Promise((r) => setImmediate(r));
  assert.ok(diagComponent);
  diagComponent.handleInput?.("r");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(opened, ["moderator-diag"]);
  assert.ok(notifies.some((n) => n.message.includes("moderator-diag")));
  assert.equal(diagDone, true);
  await completed;
});

test("diagnostics repair failure keeps diagnostics open", async () => {
  const opened: string[] = [];
  const notifies: Array<{ message: string; kind: string }> = [];
  const host = mockHumanView({ requestError: new Error("diag-boom"), opened });
  let diagComponent!: Component;
  let diagDone = false;
  const ui = {
    notify: (message: string, kind?: string) => { notifies.push({ message, kind: kind ?? "info" }); },
    custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
      return new Promise<T>((resolve) => {
        diagComponent = factory({ terminal: { rows: 20 }, requestRender() {} } as unknown as TUI,
          { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme,
          {} as KeybindingsManager,
          (v) => { diagDone = true; resolve(v); });
      });
    },
  } as unknown as ExtensionUIContext;
  const command = captureCommand((pi) =>
    registerAgentsCommand(pi, () => { throw new Error("not admitted"); }, admissionFailure, undefined, () => host),
  );
  const completed = command.handler("diagnostics", { ui, mode: "tui" } as unknown as ExtensionCommandContext);
  await new Promise((r) => setImmediate(r));
  diagComponent.handleInput?.("r");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(opened, []);
  assert.ok(notifies.some((n) => n.kind === "error"));
  assert.equal(diagDone, false);
  diagComponent.handleInput?.("q");
  await completed;
});
