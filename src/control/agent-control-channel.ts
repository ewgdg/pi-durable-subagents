import { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import { SerialLane } from "../runtime/serial-lane.ts";
import type { ControlTransport } from "./control-transport.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	ControlFrameSchema,
	type CancelFrame,
	type ControlFrame,
	type EventFrame,
	type RequestFrame,
	type ResponseFrame,
} from "./control-protocol-schemas.ts";

export { AGENT_CONTROL_PROTOCOL_VERSION } from "./control-protocol-schemas.ts";

const DEFAULT_MAXIMUM_CONTROL_FRAME_BYTES = 1024 * 1024;
const textEncoder = new TextEncoder();

export type ControlDefinition = Readonly<{
	request: TSchema;
	response: TSchema;
}>;

export type EventDefinition = Readonly<{
	payload: TSchema;
}>;

/** The methods and events one side sends to the other. */
export type ControlDirection = Readonly<{
	methods: Readonly<Record<string, ControlDefinition>>;
	events: Readonly<Record<string, EventDefinition>>;
}>;

export type AgentControlProtocol = Readonly<{
	childToOwner: ControlDirection;
	ownerToChild: ControlDirection;
}>;

/** Which end of the Control channel this is; it fixes what may be sent and received. */
export type ControlSide = "owner" | "child";

export type OutboundDirection<P extends AgentControlProtocol, S extends ControlSide> =
	S extends "owner" ? P["ownerToChild"] : P["childToOwner"];
export type InboundDirection<P extends AgentControlProtocol, S extends ControlSide> =
	S extends "owner" ? P["childToOwner"] : P["ownerToChild"];

export type AgentControlIdentity = Readonly<{
	protocolVersion: typeof AGENT_CONTROL_PROTOCOL_VERSION;
	workflowId: string;
	agentId: string;
}>;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/** Senders may pass readonly values; the channel only reads and serializes them. */
export type DeepReadonly<T> = T extends Primitive | ((...args: never[]) => unknown)
	// Checked first so branded primitives such as Pi's `string & {}` stay primitives.
	? T
	: T extends readonly []
	? readonly []
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
	: T extends object
		? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
		: T;

export type MethodName<D extends ControlDirection> = keyof D["methods"] & string;
export type EventName<D extends ControlDirection> = keyof D["events"] & string;
export type MethodRequest<D extends ControlDirection, M extends MethodName<D>> =
	Static<D["methods"][M]["request"]>;
export type MethodResponse<D extends ControlDirection, M extends MethodName<D>> =
	Static<D["methods"][M]["response"]>;
export type EventPayload<D extends ControlDirection, E extends EventName<D>> =
	Static<D["events"][E]["payload"]>;

export type ControlEvent<D extends ControlDirection> = {
	[E in EventName<D>]: Readonly<{
		event: E;
		payload: EventPayload<D, E>;
		sequence: number;
	}>;
}[EventName<D>];

/** One handler per method of a direction; a missing method is a type error. */
export type ControlServeMap<D extends ControlDirection> = {
	readonly [M in MethodName<D>]: (
		payload: MethodRequest<D, M>,
		signal: AbortSignal,
	) => Promise<DeepReadonly<MethodResponse<D, M>>> | DeepReadonly<MethodResponse<D, M>>;
};

/** The typed outbound requester of one channel side. */
export type ControlRequester<D extends ControlDirection> = <M extends MethodName<D>>(
	method: M,
	payload: DeepReadonly<MethodRequest<D, M>>,
	signal?: AbortSignal,
) => Promise<MethodResponse<D, M>>;

export type ControlHello = Readonly<{
	connectionToken: string;
	expectedSessionId: string;
}>;

export type ControlEventHandler<D extends ControlDirection> = (
	event: ControlEvent<D>,
) => Promise<void> | void;

type ServeHandler = (payload: unknown, signal: AbortSignal) => unknown;

type PendingRequest = {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	removeAbortListener: () => void;
};

type IncomingRequest = Readonly<{
	abortController: AbortController;
}>;

const MAXIMUM_NONCANONICAL_TERMINAL_IDS = 1_024;

class TerminalRequestIds {
	readonly #canonicalPrefix: string;
	readonly #noncanonical = new Set<string>();
	#canonicalHighWater = 0;

	constructor(agentId: string) {
		this.#canonicalPrefix = `${agentId}:`;
	}

	has(requestId: string): boolean {
		const sequence = this.#canonicalSequence(requestId);
		return sequence === undefined
			? this.#noncanonical.has(requestId)
			: sequence <= this.#canonicalHighWater;
	}

	add(requestId: string): void {
		const sequence = this.#canonicalSequence(requestId);
		if (sequence !== undefined) {
			this.#canonicalHighWater = Math.max(this.#canonicalHighWater, sequence);
			return;
		}
		this.#noncanonical.delete(requestId);
		this.#noncanonical.add(requestId);
		if (this.#noncanonical.size > MAXIMUM_NONCANONICAL_TERMINAL_IDS) {
			const oldest = this.#noncanonical.values().next().value as string;
			this.#noncanonical.delete(oldest);
		}
	}

	#canonicalSequence(requestId: string): number | undefined {
		if (!requestId.startsWith(this.#canonicalPrefix)) return undefined;
		const suffix = requestId.slice(this.#canonicalPrefix.length);
		const sequence = Number(suffix);
		return Number.isSafeInteger(sequence) && sequence > 0 && String(sequence) === suffix
			? sequence
			: undefined;
	}
}

/**
 * Ordered, validated NDJSON request/response/event channel over any byte stream.
 * Each side sends only its outbound direction and accepts only its inbound one; a
 * frame from the wrong direction is a protocol violation, like an unknown name.
 */
export class FramedAgentControlChannel<P extends AgentControlProtocol, S extends ControlSide> {
	readonly #identity: AgentControlIdentity;
	readonly #maximumFrameBytes: number;
	readonly #outbound: ControlDirection;
	readonly #inbound: ControlDirection;
	readonly #transport: ControlTransport;
	readonly #writer = new SerialLane();
	readonly #reader = new SerialLane();
	readonly #pending = new Map<string, PendingRequest>();
	readonly #outboundTerminal: TerminalRequestIds;
	readonly #incoming = new Map<string, IncomingRequest>();
	readonly #incomingTerminal: TerminalRequestIds;
	readonly #closeHandlers = new Set<(cause: Error) => void>();
	#buffer: Uint8Array = new Uint8Array();
	#closed = false;
	#closeCause: Error | undefined;
	#nextRequestSequence = 0;
	#nextEventSequence = 0;
	#expectedEventSequence = 1;
	#serveMap: Readonly<Record<string, ServeHandler>> | undefined;
	#eventHandler: ControlEventHandler<InboundDirection<P, S>> | undefined;
	#unsubscribeData: (() => void) | undefined;
	#unsubscribeClose: (() => void) | undefined;
	#transportClosePromise: Promise<void> | undefined;

	constructor(options: {
		identity: AgentControlIdentity;
		protocol: P;
		side: S;
		transport: ControlTransport;
		maximumFrameBytes?: number;
	}) {
		if (!Number.isSafeInteger(options.maximumFrameBytes ?? DEFAULT_MAXIMUM_CONTROL_FRAME_BYTES)
			|| (options.maximumFrameBytes ?? DEFAULT_MAXIMUM_CONTROL_FRAME_BYTES) < 1) {
			throw new Error("control_channel_configuration: maximumFrameBytes must be a positive integer");
		}
		this.#identity = options.identity;
		this.#outbound = options.side === "owner" ? options.protocol.ownerToChild : options.protocol.childToOwner;
		this.#inbound = options.side === "owner" ? options.protocol.childToOwner : options.protocol.ownerToChild;
		this.#transport = options.transport;
		this.#maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_MAXIMUM_CONTROL_FRAME_BYTES;
		this.#outboundTerminal = new TerminalRequestIds(this.#identity.agentId);
		this.#incomingTerminal = new TerminalRequestIds(this.#identity.agentId);
		this.#unsubscribeData = this.#transport.onData((chunk) => {
			void this.#reader.run(() => this.#receive(chunk)).catch((error: unknown) => {
				void this.#failClose(asError(error));
			});
		});
		this.#unsubscribeClose = this.#transport.onClose((cause) => {
			this.#finishClose(cause ?? new Error("control_channel_closed: transport closed"));
		});
	}

	/** Serve every inbound method; the channel validates each request and response. */
	serve(handlers: ControlServeMap<InboundDirection<P, S>>): () => void {
		this.#assertOpen();
		if (this.#serveMap) {
			throw new Error("control_channel_handler_exists: request handlers already registered");
		}
		const serveMap = handlers as Readonly<Record<string, ServeHandler>>;
		this.#serveMap = serveMap;
		return () => {
			if (this.#serveMap === serveMap) this.#serveMap = undefined;
		};
	}

	onEvent(handler: ControlEventHandler<InboundDirection<P, S>>): () => void {
		this.#assertOpen();
		if (this.#eventHandler) {
			throw new Error("control_channel_handler_exists: event handler already registered");
		}
		this.#eventHandler = handler;
		return () => {
			if (this.#eventHandler === handler) this.#eventHandler = undefined;
		};
	}

	onClose(handler: (cause: Error) => void): () => void {
		if (this.#closeCause) {
			queueMicrotask(() => notifyCloseObserver(handler, this.#closeCause as Error));
			return () => undefined;
		}
		this.#closeHandlers.add(handler);
		return () => this.#closeHandlers.delete(handler);
	}

	async sendHello(hello: ControlHello): Promise<void> {
		if (hello.connectionToken.length === 0 || hello.expectedSessionId.length === 0) {
			throw new Error("control_channel_invalid_hello: token and session identity are required");
		}
		await this.#send({ ...this.#identity, type: "hello", ...hello });
	}

	async request<M extends MethodName<OutboundDirection<P, S>>>(
		method: M,
		payload: DeepReadonly<MethodRequest<OutboundDirection<P, S>, M>>,
		signal?: AbortSignal,
	): Promise<MethodResponse<OutboundDirection<P, S>, M>> {
		this.#assertOpen();
		if (signal?.aborted) throw abortError();
		const definition = ownEntry(this.#outbound.methods, method);
		if (!definition || !Check(definition.request, payload)) {
			throw new Error(`control_channel_invalid_request: ${method}`);
		}
		const requestId = `${this.#identity.agentId}:${++this.#nextRequestSequence}`;
		let removeAbortListener: () => void = () => undefined;
		const result = new Promise<unknown>((resolve, reject) => {
			const onAbort = () => {
				if (!this.#pending.delete(requestId)) return;
				this.#outboundTerminal.add(requestId);
				removeAbortListener();
				reject(abortError());
				void this.#send({ ...this.#identity, type: "cancel", requestId }).catch(() => undefined);
			};
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
			this.#pending.set(requestId, { method, resolve, reject, removeAbortListener });
		});
		void this.#send({
			...this.#identity,
			type: "request",
			requestId,
			method,
			payload,
		}).catch((error: unknown) => {
			const pending = this.#pending.get(requestId);
			if (!pending) return;
			this.#pending.delete(requestId);
			pending.removeAbortListener();
			pending.reject(asError(error));
		});
		return await result as MethodResponse<OutboundDirection<P, S>, M>;
	}

	async sendEvent<E extends EventName<OutboundDirection<P, S>>>(
		event: E,
		payload: DeepReadonly<EventPayload<OutboundDirection<P, S>, E>>,
	): Promise<void> {
		this.#assertOpen();
		const definition = ownEntry(this.#outbound.events, event);
		if (!definition || !Check(definition.payload, payload)) {
			throw new Error(`control_channel_invalid_event: ${event}`);
		}
		let admitted = false;
		try {
			await this.#writer.run(async () => {
				this.#assertOpen();
				const sequence = this.#nextEventSequence + 1;
				const bytes = this.#serialize({
					...this.#identity,
					type: "event",
					sequence,
					event,
					payload,
				});
				// Sequence is committed only after the frame passes local admission.
				this.#nextEventSequence = sequence;
				admitted = true;
				await this.#transport.write(bytes);
			});
		} catch (error) {
			const cause = asError(error);
			if (!admitted) throw cause;
			await this.#failClose(cause);
			throw cause;
		}
	}

	async close(): Promise<void> {
		if (!this.#closed) {
			this.#finishClose(new Error("control_channel_closed: channel closed"));
		}
		await this.#closeTransport();
	}

	async #receive(chunk: Uint8Array): Promise<void> {
		if (this.#closed) return;
		let offset = 0;
		while (offset < chunk.byteLength) {
			const relativeNewline = chunk.subarray(offset).indexOf(0x0a);
			const end = relativeNewline < 0 ? chunk.byteLength : offset + relativeNewline;
			const segment = chunk.subarray(offset, end);
			if (this.#buffer.byteLength + segment.byteLength > this.#maximumFrameBytes) {
				throw new Error(
					relativeNewline < 0
						? "control_channel_frame_too_large: unterminated frame exceeds limit"
						: "control_channel_frame_too_large: frame exceeds limit",
				);
			}
			this.#buffer = concatenateBytes(this.#buffer, segment);
			if (relativeNewline < 0) return;
			if (this.#buffer.byteLength === 0) {
				throw new Error("control_channel_malformed_frame: empty frame");
			}
			const line = this.#buffer;
			this.#buffer = new Uint8Array();
			await this.#handleFrame(this.#parseFrame(line));
			if (this.#closed) return;
			offset = end + 1;
		}
	}

	#parseFrame(bytes: Uint8Array): ControlFrame {
		let line: string;
		try {
			line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error("control_channel_malformed_frame: frame is not valid UTF-8");
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error("control_channel_malformed_frame: invalid JSON");
		}
		if (isRecord(value) && typeof value.type === "string"
			&& !["hello", "request", "response", "event", "cancel"].includes(value.type)) {
			throw new Error("control_channel_unknown_frame: unsupported frame type");
		}
		if (!Check(ControlFrameSchema, value)) {
			throw new Error("control_channel_malformed_frame: frame does not match the closed schema");
		}
		this.#assertIdentity(value);
		return value;
	}

	async #handleFrame(frame: ControlFrame): Promise<void> {
		switch (frame.type) {
			case "hello": throw new Error("control_channel_unexpected_hello: Hello is consumed during admission");
			case "request": this.#handleRequest(frame); return;
			case "response": this.#handleResponse(frame); return;
			case "event": await this.#handleEvent(frame); return;
			case "cancel": this.#handleCancel(frame); return;
		}
	}

	#handleRequest(frame: RequestFrame): void {
		if (this.#incoming.has(frame.requestId) || this.#incomingTerminal.has(frame.requestId)) {
			throw new Error(`control_channel_duplicate_request: ${frame.requestId}`);
		}
		const definition = ownEntry(this.#inbound.methods, frame.method);
		if (!definition || !Check(definition.request, frame.payload)) {
			throw new Error(`control_channel_invalid_request: ${frame.method}`);
		}
		const handler = this.#serveMap && ownEntry(this.#serveMap, frame.method);
		if (!handler) {
			this.#incomingTerminal.add(frame.requestId);
			void this.#sendError(
				frame.requestId,
				"handler_unavailable",
				"No request handler is registered",
			).catch((error: unknown) => this.#failClose(asError(error)));
			return;
		}
		const abortController = new AbortController();
		this.#incoming.set(frame.requestId, { abortController });
		let result: Promise<unknown>;
		try {
			result = Promise.resolve(handler(frame.payload, abortController.signal));
		} catch (error) {
			result = Promise.reject(error);
		}
		void result.then(
			(value) => this.#completeIncoming(frame, definition, value),
			(error: unknown) => this.#failIncoming(frame, asError(error)),
		).catch((error: unknown) => this.#failClose(asError(error)));
	}

	async #completeIncoming(
		frame: RequestFrame,
		definition: ControlDefinition,
		result: unknown,
	): Promise<void> {
		if (!this.#incoming.delete(frame.requestId)) return;
		this.#incomingTerminal.add(frame.requestId);
		if (!Check(definition.response, result)) {
			await this.#sendError(
				frame.requestId,
				"request_failed",
				`control_channel_invalid_response: ${frame.method}`,
			);
			return;
		}
		await this.#send({
			...this.#identity,
			type: "response",
			requestId: frame.requestId,
			ok: true,
			result,
		});
	}

	async #failIncoming(frame: RequestFrame, error: Error): Promise<void> {
		if (!this.#incoming.delete(frame.requestId)) return;
		this.#incomingTerminal.add(frame.requestId);
		await this.#sendError(frame.requestId, "request_failed", error.message);
	}

	#handleResponse(frame: ResponseFrame): void {
		const pending = this.#pending.get(frame.requestId);
		if (!pending) {
			if (this.#outboundTerminal.has(frame.requestId)) return;
			throw new Error(`control_channel_unknown_response: ${frame.requestId}`);
		}
		this.#pending.delete(frame.requestId);
		this.#outboundTerminal.add(frame.requestId);
		pending.removeAbortListener();
		if (!frame.ok) {
			pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
			return;
		}
		const definition = ownEntry(this.#outbound.methods, pending.method);
		if (!definition || !Check(definition.response, frame.result)) {
			pending.reject(new Error(`control_channel_invalid_response: ${pending.method}`));
			return;
		}
		pending.resolve(frame.result);
	}

	async #handleEvent(frame: EventFrame): Promise<void> {
		if (frame.sequence !== this.#expectedEventSequence) {
			throw new Error(
				`control_channel_event_sequence: expected ${this.#expectedEventSequence}, received ${frame.sequence}`,
			);
		}
		const definition = ownEntry(this.#inbound.events, frame.event);
		if (!definition || !Check(definition.payload, frame.payload)) {
			throw new Error(`control_channel_invalid_event: ${frame.event}`);
		}
		this.#expectedEventSequence += 1;
		if (!this.#eventHandler) {
			throw new Error("control_channel_handler_unavailable: no event handler is registered");
		}
		await this.#eventHandler({
			event: frame.event,
			payload: frame.payload,
			sequence: frame.sequence,
		} as ControlEvent<InboundDirection<P, S>>);
	}

	#handleCancel(frame: CancelFrame): void {
		const incoming = this.#incoming.get(frame.requestId);
		if (incoming) {
			this.#incoming.delete(frame.requestId);
			this.#incomingTerminal.add(frame.requestId);
			incoming.abortController.abort();
			return;
		}
		if (this.#incomingTerminal.has(frame.requestId)) return;
		throw new Error(`control_channel_unknown_cancellation: ${frame.requestId}`);
	}

	async #sendError(requestId: string, code: string, message: string): Promise<void> {
		await this.#send({
			...this.#identity,
			type: "response",
			requestId,
			ok: false,
			error: { code, message },
		});
	}

	async #send(frame: ControlFrame): Promise<void> {
		this.#assertOpen();
		const bytes = this.#serialize(frame);
		try {
			await this.#writer.run(() => {
				this.#assertOpen();
				return this.#transport.write(bytes);
			});
		} catch (error) {
			const cause = asError(error);
			await this.#failClose(cause);
			throw cause;
		}
	}

	#serialize(frame: ControlFrame): Uint8Array {
		let serialized: string;
		try {
			serialized = JSON.stringify(frame);
			if (!Check(ControlFrameSchema, JSON.parse(serialized))) {
				throw new Error("serialized frame does not match the closed schema");
			}
		} catch (error) {
			throw new Error(`control_channel_malformed_frame: outgoing frame is not JSON-safe: ${asError(error).message}`);
		}
		const content = textEncoder.encode(serialized);
		if (content.byteLength > this.#maximumFrameBytes) {
			throw new Error("control_channel_frame_too_large: outgoing frame exceeds limit");
		}
		const bytes = new Uint8Array(content.byteLength + 1);
		bytes.set(content);
		bytes[bytes.byteLength - 1] = 0x0a;
		return bytes;
	}

	#assertIdentity(frame: AgentControlIdentity): void {
		if (frame.protocolVersion !== this.#identity.protocolVersion
			|| frame.workflowId !== this.#identity.workflowId
			|| frame.agentId !== this.#identity.agentId) {
			throw new Error("control_channel_identity_mismatch: frame identity is not admitted");
		}
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw this.#closeCause ?? new Error("control_channel_closed: channel is closed");
		}
	}

	async #failClose(cause: Error): Promise<void> {
		this.#finishClose(cause);
		await this.#closeTransport().catch(() => undefined);
	}

	#closeTransport(): Promise<void> {
		this.#transportClosePromise ??= this.#transport.close();
		return this.#transportClosePromise;
	}

	#finishClose(cause: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeCause = normalizeCloseCause(cause);
		this.#unsubscribeData?.();
		this.#unsubscribeClose?.();
		this.#unsubscribeData = undefined;
		this.#unsubscribeClose = undefined;
		for (const pending of this.#pending.values()) {
			pending.removeAbortListener();
			pending.reject(this.#closeCause);
		}
		this.#pending.clear();
		for (const incoming of this.#incoming.values()) incoming.abortController.abort();
		this.#incoming.clear();
		const closeHandlers = [...this.#closeHandlers];
		this.#closeHandlers.clear();
		for (const handler of closeHandlers) notifyCloseObserver(handler, this.#closeCause);
	}
}

/** A direction's own entry: names arriving off the wire must not reach prototype members. */
function ownEntry<T>(record: Readonly<Record<string, T>>, name: string): T | undefined {
	return Object.hasOwn(record, name) ? record[name] : undefined;
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	if (left.byteLength === 0) return right.slice();
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left);
	result.set(right, left.byteLength);
	return result;
}

function abortError(): Error {
	return new DOMException("The control request was cancelled", "AbortError");
}

function normalizeCloseCause(cause: Error): Error {
	if (cause.message.includes("control_channel_")) return cause;
	return new Error(`control_channel_closed: ${cause.message}`, { cause });
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function notifyCloseObserver(handler: (cause: Error) => void, cause: Error): void {
	try {
		handler(cause);
	} catch {
		// Observers cannot take ownership of channel cleanup or block one another.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
