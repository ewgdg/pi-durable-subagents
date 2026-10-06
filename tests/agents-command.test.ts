import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { registerAgentsCommand, type AgentsCommandRole } from "../src/tools/agents-command.ts";

const ownerStatus = {
	agentId: "owner",
	workflowId: "owner",
	label: "Owner",
	directSpawnerAgentId: null,
	primaryEvidence: {
		transcriptPath: "/sessions/owner.jsonl",
		inspectedThrough: { agentId: "owner", entryId: "owner-entry" },
	},
	run: { phase: "live", work: "settled", attention: "none", retentionReasons: [] },
	model: { provider: "provider", modelId: "model" },
	thinking: "high",
	compacting: false,
	queuedInputCount: 0,
} as const;
const childStatus = { ...ownerStatus, agentId: "child", label: "Child", directSpawnerAgentId: "owner" } as const;

type CapturedCommand = Readonly<{
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => unknown;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}>;

function captureCommand(role: AgentsCommandRole): CapturedCommand {
	let command: CapturedCommand | undefined;
	registerAgentsCommand({
		registerCommand(_name: string, options: CapturedCommand) {
			command = options;
		},
	} as unknown as ExtensionAPI, role);
	assert.ok(command);
	return command;
}

/** Records every Owner-side effect a registrar could cause. */
function recordingRoles() {
	const effects: string[] = [];
	const presentation = {
		async snapshot() {
			effects.push("snapshot");
			return {
				live: [ownerStatus, childStatus], dormant: [], selectedAgentId: "child",
				humanAttention: [], operationalAttention: [], reports: [],
			};
		},
		async setReportRead() { effects.push("read"); },
		async select(action: { kind: string; agentId?: string }) {
			effects.push(`select ${action.agentId}`);
			return { kind: "selected" as const };
		},
		addChangeHandler() {
			effects.push("subscribe");
			return () => undefined;
		},
	};
	const view = () => {
		effects.push("view");
		return {} as OrdinaryAgentCoordinatorView;
	};
	const roles = {
		participant: { kind: "participant", presentation },
		admitted_owner: { kind: "admitted_owner", view, tools: { refreshSpawnGuidance() {} } },
		blocked_owner: { kind: "blocked_owner", failure: new OwnerRecoveryError("admission", "owner", undefined, new Error("admission failed")) },
	} as const satisfies Record<string, AgentsCommandRole>;
	return { effects, roles };
}

function notifyingContext(mode: "tui" | "rpc") {
	const notifications: Readonly<{ message: string; type?: string }>[] = [];
	const ctx = {
		mode,
		ui: {
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			custom() { throw new Error("no surface may open"); },
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

const completionValues = (command: CapturedCommand, prefix: string) =>
	(command.getArgumentCompletions?.(prefix) as { value: string }[] | null)?.map(({ value }) => value) ?? null;

test("completions and usage list exactly the subcommands each mode offers", async () => {
	const { roles } = recordingRoles();
	const expected = {
		participant: { subcommands: ["owner"], usage: "Usage: /agents [owner]" },
		admitted_owner: { subcommands: ["owner", "diagnostics", "models"], usage: "Usage: /agents [owner|diagnostics|models]" },
		blocked_owner: { subcommands: ["diagnostics"], usage: "Usage: /agents [diagnostics]" },
	} as const;
	for (const kind of ["participant", "admitted_owner", "blocked_owner"] as const) {
		const command = captureCommand(roles[kind]);
		assert.deepEqual(completionValues(command, ""), expected[kind].subcommands, kind);
		assert.deepEqual(completionValues(command, "x"), null, kind);
		await assert.rejects(
			command.handler(" teammate ", notifyingContext("tui").ctx),
			(error: unknown) => error instanceof Error && error.message === expected[kind].usage,
			kind,
		);
	}
	assert.deepEqual(completionValues(captureCommand(roles.admitted_owner), "m"), ["models"]);
});

test("unsupported arguments are rejected before any snapshot, view, or selection", async () => {
	const { effects, roles } = recordingRoles();
	for (const role of Object.values(roles)) {
		for (const argument of ["teammate", "owner extra"]) {
			await assert.rejects(captureCommand(role).handler(argument, notifyingContext("tui").ctx), /^Error: Usage/);
		}
	}
	// A blocked Owner has no navigation, so `owner` is unsupported there too.
	await assert.rejects(captureCommand(roles.blocked_owner).handler("owner", notifyingContext("tui").ctx), /Usage: \/agents \[diagnostics\]/);
	assert.deepEqual(effects, []);
});

test("headless sessions explain that /agents surfaces need the terminal UI", async () => {
	const { effects, roles } = recordingRoles();
	for (const role of [roles.participant, roles.admitted_owner, roles.blocked_owner]) {
		const { ctx, notifications } = notifyingContext("rpc");
		await captureCommand(role).handler("", ctx);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /need Pi's terminal UI/);
		assert.equal(notifications[0]!.type, "warning");
	}
	assert.deepEqual(effects, []);
});

test("a blocked Owner points navigation to diagnostics and keeps diagnostics available", async () => {
	const { roles } = recordingRoles();
	const command = captureCommand(roles.blocked_owner);
	const { ctx, notifications } = notifyingContext("tui");
	await command.handler("", ctx);
	assert.deepEqual(notifications, [{
		message: "Subagent coordination is unavailable. Use /agents diagnostics.", type: "warning",
	}]);

	const headless = notifyingContext("rpc");
	await command.handler("diagnostics", headless.ctx);
	assert.match(headless.notifications[0]!.message, /Subagent coordination blocked/);
	assert.equal(headless.notifications[0]!.type, "error");
});

test("a participant returns to the Owner over Control without opening the selector", async () => {
	const { effects, roles } = recordingRoles();

	await captureCommand(roles.participant).handler(" owner ", notifyingContext("tui").ctx);

	assert.deepEqual(effects, ["snapshot", "select owner"]);
});
