// Child process entry: runs Pi's public main() with the coordination input tail as
// an inline extension. Pi loads inline extensions after every path extension,
// built-ins included, so the tail awaits session_start last (marking settled
// startup) and sees each input after every other input handler.
//
// Plain JavaScript: Node refuses to type-strip .ts files under node_modules, where
// installed packages live, so this entry cannot import this package's .ts modules.
import { pathToFileURL } from "node:url";

// Shared with child-runtime-input-registry.ts, which the bridge loads through Pi.
const CHILD_RUNTIME_INPUT_REGISTRY_KEY = "__piAgentCoordinationChildRuntimeInputs";

function boundChildRuntimeInput(ctx) {
	const handler = globalThis[CHILD_RUNTIME_INPUT_REGISTRY_KEY]?.get(ctx.sessionManager);
	if (!handler) {
		throw new Error("child_runtime_input_unavailable: Runtime bridge is not bound");
	}
	return handler;
}

function coordinationInputTail(pi) {
	pi.on("session_start", async (_event, ctx) => {
		await boundChildRuntimeInput(ctx).completeStartup();
	});
	pi.on("input", (event, ctx) => boundChildRuntimeInput(ctx).input(event, ctx));
}

// Mirrors Pi's CLI process setup (its setupCli is not public). main() configures
// the HTTP proxy and dispatcher itself; Pi's default app name is "pi".
// No module compile cache, unlike Pi's bundled CLI: this entry loads Pi's unbundled
// graph, and Node flushes new cache entries synchronously inside process.exit. A cold
// flush took over 6 seconds on Windows, past the Owner's shutdown grace, so a graceful
// child was force-killed. A warm cache saved only tens of milliseconds at startup.
process.title = "pi";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = () => {};

const [piModulePath, ...piArguments] = process.argv.slice(2);
const { main } = await import(pathToFileURL(piModulePath).href);
await main(piArguments, {
	extensionFactories: [
		{ name: "coordination-input-tail", factory: coordinationInputTail, hidden: true },
	],
});
