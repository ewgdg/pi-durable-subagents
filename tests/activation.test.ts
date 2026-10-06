import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import piAgentCoordination from "../src/index.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

const HEADLESS_MODES = ["print", "json", "rpc"] as const;

function hasOwnerIdentity(entries: readonly { type: string; customType?: string }[]): boolean {
	return entries.some((entry) =>
		entry.type === "custom" && entry.customType === "agent-coordination.identity"
	);
}

test("print, JSON, and RPC modes admit an Owner without a terminal UI", async (t) => {
	for (const mode of HEADLESS_MODES) {
		await t.test(mode, async (t) => {
			const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
			await bindTestOwnerHost(host, mode);

			assert.equal(hasOwnerIdentity(host.session.sessionManager.getEntries()), true);
			for (const tool of ["agent_spawn", "agent_message", "agent_wait", "agent_observe", "workflow_resume"]) {
				assert.equal(host.session.getActiveToolNames().includes(tool), true, tool);
			}
			assert.equal(
				host.ui.notifications.some(({ type }) => type === "error"),
				false,
				JSON.stringify(host.ui.notifications),
			);
			await host.runtime.dispose();
		});
	}
});

test("RPC /agents explains that Agent views need the terminal UI", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	await bindTestOwnerHost(host, "rpc");

	await host.session.prompt("/agents");

	assert.deepEqual(
		host.ui.notifications.filter(({ message }) => message.includes("terminal UI")).map(({ type }) => type),
		["warning"],
	);
	await host.runtime.dispose();
});

test("a headless print prompt runs with the admitted Owner", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	await bindTestOwnerHost(host, "print");
	host.model.setResponses([fauxAssistantMessage("Headless prompt completed.")]);

	await host.session.prompt("Run with Owner coordination.");

	assert.equal(host.session.getLastAssistantText(), "Headless prompt completed.");
	await host.runtime.dispose();
});

test("RPC startup rejects a malformed Runtime instead of running without coordination", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);
	const originalSendCustomMessage = host.session.sendCustomMessage;
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: undefined,
	});
	t.after(() => Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: originalSendCustomMessage,
	}));

	await assert.rejects(
		bindTestOwnerHost(host, "rpc"),
		(error: unknown) => error instanceof Error && error.message.includes("AgentSession.sendCustomMessage"),
	);
});

test("a headless SDK session bound without a Runtime hosts no Owner", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination);

	await host.session.bindExtensions({ mode: "print" });

	assert.equal(hasOwnerIdentity(host.session.sessionManager.getEntries()), false);
	assert.equal(host.session.getActiveToolNames().includes("agent_observe"), false);
	host.model.setResponses([fauxAssistantMessage("SDK prompt completed.")]);
	await host.session.prompt("Run without Owner coordination.");
	assert.equal(host.session.getLastAssistantText(), "SDK prompt completed.");
	await host.runtime.dispose();
});
