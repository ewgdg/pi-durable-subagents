import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import repairHelperEntry from "../src/repair/helper-entry.ts";
import { REPAIR_BOOTSTRAP_ENV } from "../src/repair/helper-process.ts";

test("failed control bootstrap and reload retain restrictions instead of exposing an unrestricted helper", async t => {
	const previous = process.env[REPAIR_BOOTSTRAP_ENV];
	t.after(() => {
		if (previous === undefined) delete process.env[REPAIR_BOOTSTRAP_ENV];
		else process.env[REPAIR_BOOTSTRAP_ENV] = previous;
	});
	delete process.env[REPAIR_BOOTSTRAP_ENV];
	for (const generation of ["failed bootstrap", "reload"]) {
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		let shutdown = false;
		let activeTools: string[] | undefined;
		const messages: string[] = [];
		const pi = {
			on: (name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler); },
			setActiveTools: (tools: string[]) => { activeTools = tools; },
		} as unknown as ExtensionAPI;
		await assert.doesNotReject(repairHelperEntry(pi), generation);
		assert.deepEqual(handlers.get("input")?.({ text: "do work" }), { action: "handled" });
		const bash = handlers.get("user_bash")?.({ command: "touch unsafe" }) as { result: { exitCode: number } };
		assert.equal(bash.result.exitCode, 1);
		assert.deepEqual(handlers.get("session_before_switch")?.({}), { cancel: true });
		assert.deepEqual(handlers.get("session_before_fork")?.({}), { cancel: true });
		await handlers.get("session_start")?.({ reason: generation === "reload" ? "reload" : "startup" }, {
			ui: { notify: (message: string) => messages.push(message) },
			shutdown: () => { shutdown = true; },
		} as unknown as ExtensionContext);
		assert.equal(shutdown, true);
		assert.deepEqual(activeTools, []);
		assert.match(messages.join("\n"), generation === "reload" ? /reload|reinitializ/i : /bootstrap/i);
	}
});
