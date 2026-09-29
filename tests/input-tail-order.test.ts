import assert from "node:assert/strict";
import test from "node:test";

import { assertInputTailHandlesInputLast } from "../src/process-runtime/input-tail-order.ts";

const TAIL = "/runtime/child-runtime-input.ts";
const extension = (path: string, events: readonly string[] = []) => ({
	path,
	resolvedPath: path,
	handlers: new Map(events.map((event) => [event, [() => undefined]])),
});

test("Pi built-ins may load after the input tail while none handles input", () => {
	assert.doesNotThrow(() => assertInputTailHandlesInputLast([
		extension("/runtime/child-runtime-bridge.ts", ["session_start", "input"]),
		extension("/inherited/extension.ts", ["input"]),
		extension(TAIL, ["session_start", "input"]),
		extension("builtin:mcp", ["session_start"]),
	], TAIL));
});

test("an input handler loaded after the input tail fails startup", () => {
	assert.throws(
		() => assertInputTailHandlesInputLast([
			extension(TAIL, ["input"]),
			extension("builtin:future", ["input"]),
		], TAIL),
		/child_runtime_input_order: builtin:future handles input after the coordination input tail/,
	);
});

test("a runtime without the input tail fails startup", () => {
	assert.throws(
		() => assertInputTailHandlesInputLast([extension("builtin:mcp")], TAIL),
		/child_runtime_input_order: the coordination input tail is not loaded/,
	);
});
