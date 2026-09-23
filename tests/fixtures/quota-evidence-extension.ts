import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const QUOTA_DIAGNOSTICS = [
	"Codex error: The usage limit has been reached",
	'{"error":{"code":"usage_limit_reached","resets_at":1893456000}}',
	'{"error":{"type":"insufficient_quota"}}',
	'{"error":{"code":"rate_limit_exceeded","message":"Codex error: The usage limit has been reached"}}',
	"429 Too Many Requests",
	"unrelated limit failure",
] as const;

const extension: ExtensionFactory = (pi) => {
	const faux = createFauxCore({
		api: "quota-fixture", provider: "openai-codex",
		models: [{ id: "quota-fixture", name: "Offline quota evidence", reasoning: false,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16384, maxTokens: 256 }],
	});
	const scenario = process.env.QUOTA_FIXTURE_SCENARIO;
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
	} else if (scenario === "terminal-queue" || scenario === "native-retry"
		|| scenario === "nonquota-terminal-queue" || scenario === "nonquota-native-retry") {
		const errorMessage = scenario === "native-retry" ? '429: {"code":"usage_limit_reached"}'
			: scenario === "nonquota-native-retry" ? "429 Too Many Requests"
				: scenario === "nonquota-terminal-queue" ? "ordinary terminal provider failure"
					: QUOTA_DIAGNOSTICS[0];
		faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage }),
			fauxAssistantMessage("Native continuation completed."),
			fauxAssistantMessage("Queued follow-up completed."),
		]);
	} else {
		faux.setResponses(QUOTA_DIAGNOSTICS.map(errorMessage => fauxAssistantMessage([], { stopReason: "error", errorMessage })));
	}
	if (scenario === "terminal-queue" || scenario === "nonquota-terminal-queue" || scenario === "nonquota-native-retry") {
		let queued = false;
		pi.on("agent_start", async () => {
			if (queued) return;
			queued = true;
			// Let the asynchronous extension-input pipeline enqueue this before the
			// first model response. It is existing native work, not a new post-end turn.
			pi.sendUserMessage("Retain this follow-up until explicit resume.", { deliverAs: "followUp" });
			await new Promise<void>(resolve => setImmediate(resolve));
		});
	}
	pi.registerProvider("openai-codex", {
		name: "Offline quota evidence", baseUrl: "http://127.0.0.1:1",
		api: "quota-fixture", apiKey: "offline-test", models: faux.models, streamSimple: faux.streamSimple,
	});
};
export default extension;
