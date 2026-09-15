import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { childRuntimeInputs } from "./child-runtime-input-registry.ts";

/** Runs after inherited input preflights while delegating to the current bridge generation. */
const childRuntimeInput: ExtensionFactory = (pi) => {
	// Pi awaits session_start handlers in extension load order. The bridge stays
	// first for startup UI/Control, while this last extension marks settled startup.
	pi.on("session_start", async (_event, ctx) => {
		const handler = childRuntimeInputs.get(ctx.sessionManager);
		if (!handler) {
			throw new Error("child_runtime_input_unavailable: Runtime bridge is not bound");
		}
		await handler.completeStartup();
	});

	pi.on("input", (event, ctx) => {
		const handler = childRuntimeInputs.get(ctx.sessionManager);
		if (!handler) {
			throw new Error("child_runtime_input_unavailable: Runtime bridge is not bound");
		}
		return handler.input(event, ctx);
	});
};

export default childRuntimeInput;
