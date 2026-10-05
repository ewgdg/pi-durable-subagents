import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ChildControlConnection } from "./child-control-connection.ts";

/**
 * Register the Pi extension hooks that feed the current child binding. The bridge
 * extension shell and the Child Control loopback's faux host share this wiring;
 * each installs the binding's input handler as its own last input hook.
 */
export function registerChildBindingHooks(
	pi: ExtensionAPI,
	currentConnection: () => ChildControlConnection | undefined,
): void {
	const currentBinding = () => currentConnection()?.currentBinding;
	// The bridge extension loads before inherited extensions. Capture the exact
	// terminal submission before any inherited input preflight can yield while
	// later PTY submissions continue advancing the terminal high-water mark.
	pi.on("input", (event) => {
		if (event.source !== "interactive" || event.streamingBehavior === "followUp") {
			return { action: "continue" };
		}
		const binding = currentBinding();
		if (!binding) throw new Error("child_runtime_control_unavailable: Runtime is not connected");
		binding.beginInteractiveInput();
		return { action: "continue" };
	});
	// Release child-local turn admission before the later participant lifecycle
	// handler asks the Owner to admit this exact execution.
	pi.on("agent_start", () => currentBinding()?.nativeTurnStarted());
	pi.on("session_before_compact", (event) => currentBinding()?.beforeCompaction(event));
	const publishRuntimeSnapshot = async () => {
		await currentBinding()?.publishRuntimeSnapshot();
	};
	const deferRuntimeSnapshot = () => {
		queueMicrotask(() => void publishRuntimeSnapshot().catch((error: unknown) =>
			currentConnection()?.reportFault("runtime_snapshot_failed", error)
		));
	};
	pi.on("model_select", deferRuntimeSnapshot);
	pi.on("thinking_level_select", deferRuntimeSnapshot);
	// Active tools have no Pi change event. This authoritative pre-generation
	// boundary publishes extension-driven tool mutations before they can execute.
	pi.on("before_agent_start", publishRuntimeSnapshot);
}
