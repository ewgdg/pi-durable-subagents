import { access } from "node:fs/promises";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const CONTINUATION_PROVIDER = "settlement-continuation-test";
export const CONTINUATION_MODEL = "offline-continuation";
export const CONTEXT_ROLLOVER_TOOL = "context_rollover";
export const CONTINUATION_STARTED = "continuation-model-started";

const extension: ExtensionFactory = (pi) => {
	const releasePath = process.env.CONTINUATION_RELEASE_PATH!;
	const faux = createFauxCore({
		api: CONTINUATION_PROVIDER,
		provider: CONTINUATION_PROVIDER,
		models: [{
			id: CONTINUATION_MODEL, name: "Offline continuation", reasoning: false,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16384, maxTokens: 256,
		}],
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall(CONTEXT_ROLLOVER_TOOL, {}, { id: "context-rollover" }), { stopReason: "toolUse" }),
		async () => {
			pi.appendEntry(CONTINUATION_STARTED, {});
			// The parent releases actual model work only after inspecting hosted status.
			while (true) {
				try { await access(releasePath); break; }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			return fauxAssistantMessage("Continuation completed.");
		},
	]);
	pi.registerProvider(CONTINUATION_PROVIDER, {
		name: "Offline continuation", baseUrl: "http://127.0.0.1:1",
		api: CONTINUATION_PROVIDER, apiKey: "offline-test",
		models: faux.models, streamSimple: faux.streamSimple,
	});
	pi.registerTool({
		name: CONTEXT_ROLLOVER_TOOL, label: "Context rollover",
		description: "End the current model loop before its context continuation.",
		parameters: Type.Object({}), executionMode: "sequential",
		async execute(_id, _input, _signal, _update, ctx) {
			// Match new_context: abort without awaiting this tool's own settlement.
			ctx.abort();
			return { terminate: true, content: [{ type: "text", text: "New context prepared." }], details: {} };
		},
	});
	let continued = false;
	pi.on("agent_settled", () => {
		if (continued) return;
		continued = true;
		// Context-rollover extensions start the successor from this hook. Pi defers
		// that run until every settled handler finishes, so it follows the old settlement.
		pi.sendUserMessage("Continue in the next context window.");
	});
};
export default extension;
