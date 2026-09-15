import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import type { HumanPresentationCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import type { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { registerAgentsCommand } from "../src/tools/owner-surfaces.ts";

type CapturedCommand = Readonly<{
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}>;

function captureCommands(
	register: (pi: ExtensionAPI) => void,
): ReadonlyMap<string, CapturedCommand> {
	const commands = new Map<string, CapturedCommand>();
	const pi = {
		registerCommand(name: string, options: CapturedCommand) {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	register(pi);
	return commands;
}

function viewWithQuotaResumer(resumeOwnerQuota: () => Promise<boolean>): HumanPresentationCoordinatorView {
	return { resumeOwnerQuota } as unknown as HumanPresentationCoordinatorView;
}

function commandContext(notifications: string[]): ExtensionCommandContext {
	return {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		} as unknown as ExtensionUIContext,
	} as ExtensionCommandContext;
}

test("Owner admission registers /quota-resume and resumes the Owner quota suspension", async () => {
	let calls = 0;
	const notifications: string[] = [];
	const commands = captureCommands((pi) => registerAgentsCommand(
		pi,
		() => viewWithQuotaResumer(async () => {
			calls++;
			return true;
		}),
		"admitted",
	));
	const command = commands.get("quota-resume");
	assert.ok(command);

	await command.handler("", commandContext(notifications));

	assert.equal(calls, 1);
	assert.deepEqual(notifications, ["Owner quota suspension resumed."]);
});

test("/quota-resume reports when no Owner quota suspension is active", async () => {
	const notifications: string[] = [];
	const commands = captureCommands((pi) => registerAgentsCommand(
		pi,
		() => viewWithQuotaResumer(async () => false),
		"admitted",
	));
	const command = commands.get("quota-resume");
	assert.ok(command);

	await command.handler(" ", commandContext(notifications));

	assert.deepEqual(notifications, ["No Owner quota suspension is active."]);
});

test("/quota-resume rejects arguments before invoking the coordinator", async () => {
	let calls = 0;
	const commands = captureCommands((pi) => registerAgentsCommand(
		pi,
		() => viewWithQuotaResumer(async () => {
			calls++;
			return true;
		}),
		"admitted",
	));
	const command = commands.get("quota-resume");
	assert.ok(command);

	await assert.rejects(
		command.handler(" unexpected ", commandContext([])),
		(error: unknown) => error instanceof Error && error.message === "Usage: /quota-resume",
	);
	assert.equal(calls, 0);
});

test("/quota-resume fails closed when the admitted view cannot resume quota", async () => {
	const commands = captureCommands((pi) => registerAgentsCommand(
		pi,
		() => ({}) as HumanPresentationCoordinatorView,
		"admitted",
	));
	const command = commands.get("quota-resume");
	assert.ok(command);

	await assert.rejects(
		command.handler("", commandContext([])),
		(error: unknown) => error instanceof Error && error.message ===
			"invariant_violation: admitted Owner view cannot resume quota",
	);
});

test("only an admitted Owner registers /quota-resume", () => {
	const view = () => viewWithQuotaResumer(async () => true);
	assert.equal(captureCommands((pi) => registerAgentsCommand(pi, view)).has("quota-resume"), false);
	assert.equal(captureCommands((pi) => registerAgentsCommand(
		pi,
		view,
		{} as OwnerRecoveryError,
	)).has("quota-resume"), false);
	assert.equal(captureCommands((pi) => registerAgentsCommand(pi, view, "admitted")).has("quota-resume"), true);
});
