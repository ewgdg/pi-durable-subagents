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
	faux.setResponses(QUOTA_DIAGNOSTICS.map(errorMessage => fauxAssistantMessage([], { stopReason: "error", errorMessage })));
	pi.registerProvider("openai-codex", {
		name: "Offline quota evidence", baseUrl: "http://127.0.0.1:1",
		api: "quota-fixture", apiKey: "offline-test", models: faux.models, streamSimple: faux.streamSimple,
	});
};
export default extension;
