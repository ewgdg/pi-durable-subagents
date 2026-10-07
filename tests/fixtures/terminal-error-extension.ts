import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const TERMINAL_ERROR_FIXTURE_PROVIDER = "terminal-error-fixture";
export const TERMINAL_ERROR_FIXTURE_MODEL = "terminal-error-fixture";

const extension: ExtensionFactory = (pi) => {
	const faux = createFauxCore({
		api: TERMINAL_ERROR_FIXTURE_PROVIDER, provider: TERMINAL_ERROR_FIXTURE_PROVIDER,
		models: [{ id: TERMINAL_ERROR_FIXTURE_MODEL, name: "Offline terminal error", reasoning: false,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16384, maxTokens: 256 }],
	});
	const scenario = process.env.TERMINAL_ERROR_FIXTURE_SCENARIO;
	if (scenario === "error-signal-live" || scenario === "error-signal-aborted") {
		faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "This operation was aborted" }),
		]);
		if (scenario === "error-signal-aborted") {
			pi.on("agent_end", (_event, ctx) => {
				// Reproduce Pi's error-shaped setup cancellation at the public native
				// boundary, before session subscribers classify the exact Run signal.
				// Awaiting abort here would wait for this same agent_end hook to finish.
				void ctx.abort();
			});
		}
	} else if (scenario === "terminal-queue" || scenario === "native-retry") {
		const errorMessage = scenario === "native-retry" ? "429 Too Many Requests" : "ordinary terminal provider failure";
		faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage }),
			fauxAssistantMessage("Native continuation completed."),
			fauxAssistantMessage("Queued follow-up completed."),
		]);
		let queued = false;
		pi.on("agent_start", async () => {
			if (queued) return;
			queued = true;
			// Let the asynchronous extension-input pipeline enqueue this before the
			// first model response. It is existing native work, not a new post-end turn.
			pi.sendUserMessage("Retain this follow-up until explicit resume.", { deliverAs: "followUp" });
			await new Promise<void>(resolve => setImmediate(resolve));
		});
	} else {
		throw new Error(`Unknown terminal error fixture scenario: ${scenario}`);
	}
	pi.registerProvider(TERMINAL_ERROR_FIXTURE_PROVIDER, {
		name: "Offline terminal error", baseUrl: "http://127.0.0.1:1",
		api: TERMINAL_ERROR_FIXTURE_PROVIDER, apiKey: "offline-test", models: faux.models, streamSimple: faux.streamSimple,
	});
};
export default extension;
