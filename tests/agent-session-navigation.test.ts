import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { openLiveAgentView } from "./support/agent-session.ts";
import type { TestOwnerHost } from "./support/pi-host.ts";

function selectorHost(agentId: string) {
	const view: Component = { render: () => ["Agent view"], invalidate() {} };
	let atOwner = false;
	let inputs = 0;
	const surfaces: Component[] = [];
	const selector: Component = {
		render: () => atOwner
			? ["│ Agents │", "│ Go to Owner [o] │"]
			: [
				"│ Agents │",
				"│ → Worker │",
				"│   No description. │",
				`│   \x1b[0m${agentId}\x1b[0m │`,
				"│   Live · active │",
			],
		invalidate() {},
		handleInput(input) {
			// Fail synchronously if navigation spins: a test timeout cannot interrupt it.
			assert.ok(++inputs <= 10, "Selector navigation spun without progress");
			if (input === "j") atOwner = true; // Native selection clamps at the end.
			if (input === "\r") surfaces.splice(0, 1, view);
			if (input === "\x1b") surfaces.length = 0;
		},
	};
	const host = {
		session: { sessionId: "owner" },
		runtime: { session: { prompt: async () => { surfaces.push(selector); } } },
		ui: { customSurfaces: surfaces },
	} as unknown as TestOwnerHost;
	return { host, view };
}

test("live selector navigation matches terminal-styled Agent identities", async () => {
	const { host, view } = selectorHost("worker");
	const opened = await openLiveAgentView(host, "worker");
	assert.equal(opened.view, view);
});

test("live selector navigation fails when a clamped tree has no target", async () => {
	const { host } = selectorHost("another-worker");
	await assert.rejects(openLiveAgentView(host, "missing-worker"),
		/Agent missing-worker is absent from the Live selector hierarchy/);
	assert.equal(host.ui.customSurfaces.length, 0);
});
