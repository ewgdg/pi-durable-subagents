import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Whether a human at a terminal can answer Human Requests and use Agent views.
 * TUI is the only Pi mode with one; RPC, print, and JSON Workflows are headless.
 */
export type WorkflowInteraction = "terminal" | "headless";

export function workflowInteractionForMode(mode: ExtensionContext["mode"]): WorkflowInteraction {
	return mode === "tui" ? "terminal" : "headless";
}
