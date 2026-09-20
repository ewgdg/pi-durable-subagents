import {
	createFauxCore,
	type AssistantMessage,
	type TranscriptContext,
	type FauxProviderState,
	type FauxResponseStep,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderProcessModelExtension } from "../fixtures/process-model-broker-extension.ts";

const DEFAULT_PROVIDER_ID = "coordination-test";
const DEFAULT_MODEL_ID = "deterministic-owner";
const DEFAULT_MODEL_NAME = "Deterministic process model";
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

export type ProcessModelResponseOverride = (
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	model: Model<string>,
) => AssistantMessage | undefined | Promise<AssistantMessage | undefined>;

export type ProcessModelBrokerOptions = {
	providerId?: string;
	modelId?: string;
	modelName?: string;
	maxPayloadBytes?: number;
	responses?: FauxResponseStep[];
	responseOverride?: ProcessModelResponseOverride;
	tokensPerSecond?: number;
};

export type ProcessModelBroker = {
	readonly providerId: string;
	readonly modelId: string;
	readonly model: Model<string>;
	readonly extensionPath: string;
	readonly runtimeDirectory: string;
	readonly state: FauxProviderState;
	setResponses(responses: FauxResponseStep[]): void;
	appendResponses(responses: FauxResponseStep[]): void;
	getPendingResponseCount(): number;
	close(): Promise<void>;
};

export async function createProcessModelBroker(
	options: ProcessModelBrokerOptions = {},
): Promise<ProcessModelBroker> {
	const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
	const modelId = options.modelId ?? DEFAULT_MODEL_ID;
	const modelName = options.modelName ?? DEFAULT_MODEL_NAME;
	const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
	if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 256) {
		throw new Error("Process model broker maxPayloadBytes must be an integer of at least 256");
	}

	const fauxOptions = {
		api: providerId,
		provider: providerId,
		models: [{ id: modelId, name: modelName }],
		tokensPerSecond: options.tokensPerSecond,
	};
	const faux = createFauxCore(fauxOptions);
	if (options.responses) faux.setResponses(options.responses);
	const resolveMessage: ResolveBrokerMessage = async (model, context, streamOptions) => {
		const override = await options.responseOverride?.(context, streamOptions, model);
		if (!override) return faux.streamSimple(model, context, streamOptions).result();
		const overrideFaux = createFauxCore(fauxOptions);
		overrideFaux.setResponses([override]);
		return overrideFaux.streamSimple(model, context, streamOptions).result();
	};
	const token = randomBytes(32).toString("base64url");
	const activeRequests = new Set<AbortController>();
	const server = createServer((request, response) => {
		void handleBrokerRequest({
			request,
			response,
			token,
			maxPayloadBytes,
			providerId,
			modelId,
			resolveMessage,
			activeRequests,
		});
	});
	server.on("clientError", (_error, socket) => socket.destroy());

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	let endpoint: string | undefined;
	let runtimeDirectory: string | undefined;
	let extensionPath: string | undefined;
	try {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Process model broker did not bind a loopback TCP address");
		}
		endpoint = `http://127.0.0.1:${address.port}/response`;
		runtimeDirectory = await mkdtemp(join(tmpdir(), "pi-process-model-broker-"));
		await chmod(runtimeDirectory, 0o700);
		extensionPath = join(runtimeDirectory, "process-model-broker-extension.mjs");
		await writeFile(extensionPath, renderProcessModelExtension({
			piAiImportUrl: import.meta.resolve("@earendil-works/pi-ai"),
			endpoint,
			token,
			providerId,
			modelId,
			modelName,
			maxPayloadBytes,
		}), { mode: 0o600 });
	} catch (error) {
		await stopServer(server, activeRequests);
		if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
		throw error;
	}
	if (!endpoint || !runtimeDirectory || !extensionPath) {
		throw new Error("Process model broker runtime resources were not created");
	}
	const model = { ...faux.models[0], baseUrl: endpoint };

	let closePromise: Promise<void> | undefined;
	return {
		providerId,
		modelId,
		model,
		extensionPath,
		runtimeDirectory,
		state: faux.state,
		setResponses: faux.setResponses,
		appendResponses: faux.appendResponses,
		getPendingResponseCount: faux.getPendingResponseCount,
		close() {
			closePromise ??= closeBroker(server, activeRequests, runtimeDirectory);
			return closePromise;
		},
	};
}

type BrokerRequestDependencies = {
	request: IncomingMessage;
	response: ServerResponse;
	token: string;
	maxPayloadBytes: number;
	providerId: string;
	modelId: string;
	resolveMessage: ResolveBrokerMessage;
	activeRequests: Set<AbortController>;
};

type ResolveBrokerMessage = (
	model: Model<string>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
) => Promise<AssistantMessage>;

async function handleBrokerRequest(dependencies: BrokerRequestDependencies): Promise<void> {
	const {
		request,
		response,
		token,
		maxPayloadBytes,
		providerId,
		modelId,
		resolveMessage,
		activeRequests,
	} = dependencies;
	try {
		if (request.method !== "POST" || request.url !== "/response") {
			writeJson(response, 404, { error: "Process model broker route not found" });
			return;
		}
		if (request.headers.authorization !== `Bearer ${token}`) {
			writeJson(response, 401, { error: "Process model broker token rejected" });
			return;
		}
		const contentLength = Number(request.headers["content-length"] ?? 0);
		if (contentLength > maxPayloadBytes) {
			request.resume();
			writeJson(response, 413, { error: payloadLimitMessage(maxPayloadBytes) });
			return;
		}
		const body = await readBoundedBody(request, maxPayloadBytes);
		const payload = JSON.parse(body) as {
			model?: Model<string>;
			context?: TranscriptContext;
			options?: SimpleStreamOptions;
		};
		if (
			payload.model?.provider !== providerId ||
			payload.model.api !== providerId ||
			payload.model.id !== modelId ||
			!payload.context || !Array.isArray(payload.context.messages)
		) {
			writeJson(response, 400, { error: "Process model broker request evidence is invalid" });
			return;
		}

		const cancellation = new AbortController();
		activeRequests.add(cancellation);
		const abort = () => cancellation.abort();
		request.once("aborted", abort);
		response.once("close", abort);
		try {
			const message = await resolveMessage(payload.model, payload.context, {
				...payload.options,
				signal: cancellation.signal,
			});
			if (response.destroyed) return;
			const serialized = JSON.stringify({ message });
			if (Buffer.byteLength(serialized) > maxPayloadBytes) {
				writeJson(response, 413, { error: payloadLimitMessage(maxPayloadBytes) });
				return;
			}
			writeSerializedJson(response, 200, serialized);
		} finally {
			request.off("aborted", abort);
			response.off("close", abort);
			activeRequests.delete(cancellation);
		}
	} catch (error) {
		if (response.destroyed || response.headersSent) return;
		const message = error instanceof PayloadLimitError
			? error.message
			: error instanceof Error ? error.message : String(error);
		writeJson(response, error instanceof PayloadLimitError ? 413 : 400, { error: message });
	}
}

async function readBoundedBody(request: IncomingMessage, maxPayloadBytes: number): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > maxPayloadBytes) throw new PayloadLimitError(maxPayloadBytes);
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

class PayloadLimitError extends Error {
	constructor(maxPayloadBytes: number) {
		super(payloadLimitMessage(maxPayloadBytes));
	}
}

function payloadLimitMessage(maxPayloadBytes: number): string {
	return `Process model broker payload exceeds ${maxPayloadBytes} bytes`;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
	writeSerializedJson(response, status, JSON.stringify(value));
}

function writeSerializedJson(response: ServerResponse, status: number, serialized: string): void {
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(serialized),
		"cache-control": "no-store",
	});
	response.end(serialized);
}

async function closeBroker(
	server: ReturnType<typeof createServer>,
	activeRequests: Set<AbortController>,
	runtimeDirectory: string,
): Promise<void> {
	await stopServer(server, activeRequests);
	await rm(runtimeDirectory, { recursive: true, force: true });
}

async function stopServer(
	server: ReturnType<typeof createServer>,
	activeRequests: Set<AbortController>,
): Promise<void> {
	for (const request of activeRequests) request.abort();
	if (!server.listening) return;
	const stopped = new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
	server.closeAllConnections();
	await stopped;
}
