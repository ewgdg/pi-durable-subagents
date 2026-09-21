import type { Model } from "@earendil-works/pi-ai";

export type ProcessModelExtensionTemplateOptions = {
	piAiImportUrl: string;
	endpoint: string;
	token: string;
	providerId: string;
	modelId: string;
	modelName: string;
	maxPayloadBytes: number;
};

export function renderProcessModelExtension(
	options: ProcessModelExtensionTemplateOptions,
): string {
	const model: Model<string> = {
		id: options.modelId,
		name: options.modelName,
		api: options.providerId,
		provider: options.providerId,
		baseUrl: options.endpoint,
		// The launched child resolves its thinking level against this same catalogue, so
		// it must match the host fixture: a non-reasoning model clamps every level to off.
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
	const constants = JSON.stringify({
		endpoint: options.endpoint,
		token: options.token,
		providerId: options.providerId,
		maxPayloadBytes: options.maxPayloadBytes,
		model,
	});

	return `import { createAssistantMessageEventStream } from ${JSON.stringify(options.piAiImportUrl)};

const { endpoint, token, providerId, maxPayloadBytes, model } = ${constants};
const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function errorMessage(message, stopReason = "error") {
  return {
    role: "assistant",
    content: [],
    api: providerId,
    provider: providerId,
    model: model.id,
    usage: emptyUsage,
    stopReason,
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function pushTerminal(stream, message) {
  const partial = { ...message, stopReason: "pending" };
  stream.push({ type: "start", partial });
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason, message });
  }
}

function serializableOptions(options) {
  if (!options) return undefined;
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(options, (key, value) => {
    if (key === "signal" || typeof value === "function" || typeof value === "symbol") return undefined;
    if (typeof value === "bigint") return String(value);
    if (value && typeof value === "object") {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  }));
}

function streamSimple(requestModel, context, options) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    if (options?.signal?.aborted) {
      pushTerminal(stream, errorMessage("Request was aborted", "aborted"));
      return;
    }
    try {
      const body = JSON.stringify({
        model: requestModel,
        context,
        options: serializableOptions(options),
      });
      if (Buffer.byteLength(body) > maxPayloadBytes) {
        pushTerminal(stream, errorMessage(\`Process model broker payload exceeds \${maxPayloadBytes} bytes\`));
        return;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: \`Bearer \${token}\`,
          "content-type": "application/json",
        },
        body,
        signal: options?.signal,
      });
      await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, requestModel);
      const payload = await response.json();
      if (options?.signal?.aborted) {
        pushTerminal(stream, errorMessage("Request was aborted", "aborted"));
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? \`Process model broker failed with HTTP \${response.status}\`);
      pushTerminal(stream, payload.message);
    } catch (error) {
      const aborted = options?.signal?.aborted || error?.name === "AbortError";
      pushTerminal(stream, errorMessage(
        aborted ? "Request was aborted" : error instanceof Error ? error.message : String(error),
        aborted ? "aborted" : "error",
      ));
    }
  });
  return stream;
}

export default function processModelBrokerExtension(pi) {
  pi.registerProvider(providerId, {
    name: "Deterministic process model broker",
    baseUrl: endpoint,
    api: providerId,
    apiKey: "private-test-broker",
    models: [model],
    streamSimple,
  });
}
`;
}
