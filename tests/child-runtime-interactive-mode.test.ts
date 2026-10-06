import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { InteractiveMode } from "@earendil-works/pi-coding-agent";

test("child input lifecycle patch can retry after installation failure", async (t) => {
	const prototype = InteractiveMode.prototype;
	const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, "getUserInput");
	assert.ok(originalDescriptor);
	t.after(() => Object.defineProperty(prototype, "getUserInput", originalDescriptor));
	Object.defineProperty(prototype, "getUserInput", {
		...originalDescriptor,
		writable: false,
	});
	const moduleUrl = new URL(
		"../src/process-runtime/child-runtime-interactive-mode.ts",
		import.meta.url,
	);
	moduleUrl.searchParams.set("attempt", "failed");
	await assert.rejects(import(moduleUrl.href));

	Object.defineProperty(prototype, "getUserInput", originalDescriptor);
	const nativeGetUserInput = prototype.getUserInput;
	moduleUrl.searchParams.set("attempt", "retry");
	await import(moduleUrl.href);

	assert.notEqual(prototype.getUserInput, nativeGetUserInput);
});
