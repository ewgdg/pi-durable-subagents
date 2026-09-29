import type { Extension } from "@earendil-works/pi-coding-agent";

/**
 * The coordination input tail must be the last `input` handler: Pi dispatches
 * input in extension load order, and inherited preflights must transform input
 * before coordination consumes it. Pi always loads its built-in extensions after
 * every file extension, so the tail is last only among files; this holds while no
 * extension loaded after it handles input.
 */
export function assertInputTailHandlesInputLast(
	extensions: readonly Pick<Extension, "resolvedPath" | "handlers">[],
	inputTailPath: string,
): void {
	const tailIndex = extensions.findIndex(({ resolvedPath }) => resolvedPath === inputTailPath);
	if (tailIndex === -1) {
		throw new Error("child_runtime_input_order: the coordination input tail is not loaded");
	}
	const lateInputHandlers = extensions
		.slice(tailIndex + 1)
		.filter(({ handlers }) => handlers.has("input"))
		.map(({ resolvedPath }) => resolvedPath);
	if (lateInputHandlers.length > 0) {
		throw new Error(
			`child_runtime_input_order: ${lateInputHandlers.join(", ")} handles input after the coordination input tail`,
		);
	}
}
