import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_STEPS = 128;
const MAX_TEXT_CHUNK_BYTES = 48;
const MAX_ARGUMENT_CHUNK_BYTES = 96;

export const REPAIR_PROVIDER = "repair-fixture";
export const REPAIR_MODEL_ID = "repair-fixture-model";

export type RepairToolCall = {
	name: string;
	arguments: Record<string, unknown>;
};

export type RepairResponse =
	| string
	| { text: string }
	| RepairToolCall
	| { toolCall: RepairToolCall };

export type RepairRequest = {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	model: unknown;
	messages: unknown[];
	tools: unknown[];
	body: Record<string, unknown>;
	rawBody: string;
};

export type RepairResponseResolver = (
	request: RepairRequest,
	requestIndex: number,
) => RepairResponse | Promise<RepairResponse>;

type ResponseStep = RepairResponse | RepairResponseResolver;

type ModelsConfiguration = {
	providers: Record<string, {
		baseUrl: string;
		api: "openai-completions";
		apiKey: string;
		models: Array<{
			id: string;
			name: string;
			reasoning: false;
			input: ["text"];
			contextWindow: number;
			maxTokens: number;
			cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
		}>;
	}>;
};

export type RepairModelServer = {
	/** Base URL for Pi's OpenAI-compatible provider, including the `/v1` suffix. */
	baseUrl: string;
	provider: string;
	modelId: string;
	modelsConfiguration: ModelsConfiguration;
	setResponses: (...steps: ResponseStep[]) => void;
	requests: RepairRequest[];
	close: () => Promise<void>;
};

function json(res: ServerResponse, status: number, value: unknown): void {
	const payload = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		let bytes = 0;
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			req.destroy();
			reject(error);
		};
		req.on("data", (chunk: Buffer | string) => {
			const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += next.byteLength;
			if (bytes > MAX_REQUEST_BYTES) {
				fail(new Error(`repair fixture request exceeds ${MAX_REQUEST_BYTES} bytes`));
				return;
			}
			body += next.toString("utf8");
		});
		req.on("end", () => {
			if (!settled) {
				settled = true;
				resolve(body);
			}
		});
		req.on("error", (error) => fail(error));
	});
}

function normalizeResponse(step: RepairResponse): { text?: string; toolCall?: RepairToolCall } {
	if (typeof step === "string") return { text: step };
	if (typeof step !== "object" || step === null) throw new Error("invalid repair fixture response step");
	if ("text" in step) {
		if (typeof step.text !== "string") throw new Error("repair fixture text response must be a string");
		return { text: step.text };
	}
	const candidate = "toolCall" in step ? step.toolCall : step;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		typeof candidate.name !== "string" ||
		typeof candidate.arguments !== "object" ||
		candidate.arguments === null ||
		Array.isArray(candidate.arguments)
	) {
		throw new Error("repair fixture tool response must contain name and object arguments");
	}
	return { toolCall: { name: candidate.name, arguments: candidate.arguments as Record<string, unknown> } };
}

function splitByBytes(value: string, maxBytes: number): string[] {
	const chunks: string[] = [];
	let chunk = "";
	for (const character of value) {
		if (chunk && Buffer.byteLength(chunk + character) > maxBytes) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk += character;
	}
	if (chunk) chunks.push(chunk);
	return chunks;
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finishReason?: string): string {
	return `data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
	})}\n\n`;
}

async function writeSse(res: ServerResponse, model: string, response: { text?: string; toolCall?: RepairToolCall }): Promise<void> {
	const id = `repair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const write = async (value: string): Promise<void> => {
		if (res.destroyed || res.writableEnded) return;
		res.write(value);
		await new Promise<void>((resolve) => setImmediate(resolve));
	};

	await write(chunk(id, model, { role: "assistant" }));
	if (response.toolCall) {
		const { name, arguments: args } = response.toolCall;
		await write(chunk(id, model, {
			tool_calls: [{ index: 0, id: `${id}-call`, type: "function", function: { name, arguments: "" } }],
		}));
		const serializedArguments = JSON.stringify(args);
		for (const part of splitByBytes(serializedArguments, MAX_ARGUMENT_CHUNK_BYTES)) {
			await write(chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: part } }] }));
		}
		await write(chunk(id, model, {}, "tool_calls"));
	} else {
		for (const part of splitByBytes(response.text ?? "", MAX_TEXT_CHUNK_BYTES)) {
			await write(chunk(id, model, { content: part }));
		}
		await write(chunk(id, model, {}, "stop"));
	}
	// This final usage event is part of the standard OpenAI streaming response when
	// stream_options.include_usage is requested. Zeroes are intentional: this is a
	// deterministic test transport, not a tokenizer.
	await write(`data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [],
		usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
	})}\n\n`);
	await write("data: [DONE]\n\n");
	if (!res.writableEnded) res.end();
}

export async function createRepairModelServer(): Promise<RepairModelServer> {
	const requests: RepairRequest[] = [];
	let queuedSteps: ResponseStep[] = [];
	let persistentResolver: RepairResponseResolver | undefined;
	let server: Server | undefined;

	const setResponses = (...steps: ResponseStep[]): void => {
		const flattened = steps;
		if (flattened.length > MAX_RESPONSE_STEPS) throw new Error(`repair fixture supports at most ${MAX_RESPONSE_STEPS} response steps`);
		queuedSteps = [...flattened];
		persistentResolver = flattened.length === 1 && typeof flattened[0] === "function" ? flattened[0] : undefined;
	};

	server = createServer(async (req, res) => {
		try {
			if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
				json(res, 200, { object: "list", data: [{ id: REPAIR_MODEL_ID, object: "model", owned_by: REPAIR_PROVIDER }] });
				return;
			}
			if (req.method !== "POST" || (req.url !== "/v1/chat/completions" && req.url !== "/chat/completions")) {
				json(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
				return;
			}
			const rawBody = await readBody(req);
			let body: Record<string, unknown>;
			try {
				const parsed = JSON.parse(rawBody);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be an object");
				body = parsed as Record<string, unknown>;
			} catch (error) {
				json(res, 400, { error: { message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`, type: "invalid_request_error" } });
				return;
			}
			const request: RepairRequest = {
				method: req.method,
				path: req.url ?? "",
				headers: req.headers,
				model: body.model,
				messages: Array.isArray(body.messages) ? body.messages : [],
				tools: Array.isArray(body.tools) ? body.tools : [],
				body,
				rawBody,
			};
			const requestIndex = requests.push(request) - 1;
			let step: ResponseStep | undefined;
			if (persistentResolver) step = persistentResolver;
			else step = queuedSteps.shift();
			if (step === undefined) {
				json(res, 500, { error: { message: "repair fixture has no configured response step", type: "fixture_error" } });
				return;
			}
			const resolved = typeof step === "function" ? await step(request, requestIndex) : step;
			await writeSse(res, String(body.model ?? REPAIR_MODEL_ID), normalizeResponse(resolved));
		} catch (error) {
			if (!res.headersSent) json(res, 500, { error: { message: error instanceof Error ? error.message : String(error), type: "fixture_error" } });
			else res.destroy(error instanceof Error ? error : undefined);
		}
	});
	server.requestTimeout = 10_000;

	await new Promise<void>((resolve, reject) => {
		server!.once("error", reject);
		server!.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("repair fixture did not receive a TCP address");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	const modelsConfiguration: ModelsConfiguration = {
		providers: {
			[REPAIR_PROVIDER]: {
				baseUrl,
				api: "openai-completions",
				apiKey: "repair-fixture-key",
				models: [{
					id: REPAIR_MODEL_ID,
					name: "Repair fixture model",
					reasoning: false,
					input: ["text"],
					contextWindow: 128_000,
					maxTokens: 8_192,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}],
			},
		},
	};
	const close = async (): Promise<void> => {
		if (!server) return;
		await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
		server = undefined;
	};
	return { baseUrl, provider: REPAIR_PROVIDER, modelId: REPAIR_MODEL_ID, modelsConfiguration, setResponses, requests, close };
}

