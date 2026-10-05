import { Check } from "typebox/value";

import {
	FramedAgentControlChannel,
	type AgentControlIdentity,
	type AgentControlProtocol,
} from "./agent-control-channel.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	HelloFrameSchema,
	type HelloFrame,
} from "./control-protocol-schemas.ts";
import type { ControlTransport, ControlTransportListener } from "./control-transport.ts";

const DEFAULT_MAXIMUM_CONTROL_FRAME_BYTES = 1024 * 1024;

/** The broker listens for children, so every channel it admits is the Owner's side. */
type OwnerControlChannel<P extends AgentControlProtocol> = FramedAgentControlChannel<P, "owner">;

export type ExpectedAgentControlAdmission = Readonly<{
	agentId: string;
	connectionToken: string;
	expectedSessionId: string;
}>;

type PendingAdmission<P extends AgentControlProtocol> = Readonly<{
	expected: ExpectedAgentControlAdmission;
	configure: (channel: OwnerControlChannel<P>) => void;
	resolve: (channel: OwnerControlChannel<P>) => void;
	reject: (error: Error) => void;
	removeAbortListener: () => void;
}>;

/** Routes raw connections to identity-bound channels only after a validated Hello. */
export class AgentControlAdmissionBroker<P extends AgentControlProtocol> {
	readonly #listener: ControlTransportListener;
	readonly #protocol: P;
	readonly #workflowId: string;
	readonly #maximumFrameBytes: number;
	readonly #pending = new Map<string, PendingAdmission<P>>();
	readonly #inspections = new Set<Promise<void>>();
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: {
		listener: ControlTransportListener;
		protocol: P;
		workflowId: string;
		maximumFrameBytes?: number;
	}) {
		const maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_MAXIMUM_CONTROL_FRAME_BYTES;
		if (options.workflowId.length === 0) {
			throw new Error("control_admission_invalid: workflowId is required");
		}
		if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
			throw new Error("control_admission_invalid: maximumFrameBytes must be a positive integer");
		}
		this.#listener = options.listener;
		this.#protocol = options.protocol;
		this.#workflowId = options.workflowId;
		this.#maximumFrameBytes = maximumFrameBytes;
		void this.#acceptConnections();
	}

	admit(
		expected: ExpectedAgentControlAdmission,
		configure: (channel: OwnerControlChannel<P>) => void,
		signal?: AbortSignal,
	): Promise<OwnerControlChannel<P>> {
		if (signal?.aborted) return Promise.reject(abortError());
		if (this.#closed) {
			return Promise.reject(new Error("control_admission_closed: broker is closed"));
		}
		if (expected.agentId.length === 0 || expected.connectionToken.length === 0
			|| expected.expectedSessionId.length === 0) {
			return Promise.reject(new Error("control_admission_invalid: identity, token, and session are required"));
		}
		if (this.#pending.has(expected.connectionToken)) {
			return Promise.reject(new Error("control_admission_duplicate_token: token is already pending"));
		}
		return new Promise<OwnerControlChannel<P>>((resolve, reject) => {
			let removeAbortListener: () => void = () => undefined;
			const pending: PendingAdmission<P> = {
				expected,
				configure,
				resolve,
				reject,
				removeAbortListener: () => removeAbortListener(),
			};
			const onAbort = () => {
				if (this.#pending.get(expected.connectionToken) !== pending) return;
				this.#pending.delete(expected.connectionToken);
				removeAbortListener();
				reject(abortError());
			};
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
			this.#pending.set(expected.connectionToken, pending);
		});
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		const cause = new Error("control_admission_closed: broker closed");
		this.#rejectPending(cause);
		this.#closePromise = (async () => {
			let listenerError: Error | undefined;
			try {
				await this.#listener.close();
			} catch (error) {
				listenerError = asError(error);
			}
			await Promise.allSettled([...this.#inspections]);
			if (listenerError) throw listenerError;
		})();
		return this.#closePromise;
	}

	async #acceptConnections(): Promise<void> {
		try {
			while (!this.#closed) {
				const transport = await this.#listener.accept();
				if (this.#closed) {
					await transport.close();
					return;
				}
				const inspection = this.#inspect(transport).finally(() => {
					this.#inspections.delete(inspection);
				});
				this.#inspections.add(inspection);
				void inspection;
			}
		} catch (error) {
			if (this.#closed) return;
			this.#closed = true;
			this.#rejectPending(asError(error));
		}
	}

	async #inspect(transport: ControlTransport): Promise<void> {
		const candidate = new AdmissionControlTransport(transport, this.#maximumFrameBytes);
		try {
			const hello = await candidate.readHello();
			const pending = this.#pending.get(hello.connectionToken);
			if (!pending) {
				throw new Error("control_admission_unknown_token: Hello token is not pending");
			}
			this.#pending.delete(hello.connectionToken);
			pending.removeAbortListener();
			if (hello.protocolVersion !== AGENT_CONTROL_PROTOCOL_VERSION
				|| hello.workflowId !== this.#workflowId
				|| hello.agentId !== pending.expected.agentId
				|| hello.expectedSessionId !== pending.expected.expectedSessionId) {
				const cause = new Error("control_admission_identity_mismatch: Hello does not match the pending child");
				pending.reject(cause);
				throw cause;
			}
			const identity: AgentControlIdentity = {
				protocolVersion: hello.protocolVersion,
				workflowId: hello.workflowId,
				agentId: hello.agentId,
			};
			const channel = new FramedAgentControlChannel({
				identity,
				protocol: this.#protocol,
				side: "owner",
				transport: candidate,
				maximumFrameBytes: this.#maximumFrameBytes,
			});
			try {
				// Install all inbound handlers before post-Hello bytes can resume.
				pending.configure(channel);
			} catch (error) {
				const cause = asError(error);
				pending.reject(cause);
				await channel.close();
				return;
			}
			candidate.activate();
			pending.resolve(channel);
		} catch {
			await candidate.close().catch(() => undefined);
		}
	}

	#rejectPending(cause: Error): void {
		for (const pending of this.#pending.values()) {
			pending.removeAbortListener();
			pending.reject(cause);
		}
		this.#pending.clear();
	}
}

class AdmissionControlTransport implements ControlTransport {
	readonly #transport: ControlTransport;
	readonly #maximumFrameBytes: number;
	readonly #hello: Promise<HelloFrame>;
	readonly #buffered: Uint8Array[] = [];
	readonly #closeHandlers = new Set<(cause?: Error) => void>();
	#resolveHello!: (hello: HelloFrame) => void;
	#rejectHello!: (error: Error) => void;
	#helloBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
	#helloSettled = false;
	#activated = false;
	#closed = false;
	#closeCause: Error | undefined;
	#dataHandler: ((chunk: Uint8Array) => void) | undefined;
	#unsubscribeData: (() => void) | undefined;
	#unsubscribeClose: (() => void) | undefined;

	constructor(transport: ControlTransport, maximumFrameBytes: number) {
		this.#transport = transport;
		this.#maximumFrameBytes = maximumFrameBytes;
		this.#hello = new Promise<HelloFrame>((resolve, reject) => {
			this.#resolveHello = resolve;
			this.#rejectHello = reject;
		});
		// Stay subscribed across the Hello-to-Channel handoff so no Adapter can
		// drop coalesced or immediately following bytes while handlers are bound.
		this.#unsubscribeData = transport.onData((chunk) => this.#receive(chunk));
		this.#unsubscribeClose = transport.onClose((cause) => this.#finishClose(
			cause ?? new Error("control_admission_closed: transport closed"),
		));
	}

	readHello(): Promise<HelloFrame> {
		return this.#hello;
	}

	write(data: Uint8Array): Promise<void> {
		return this.#transport.write(data);
	}

	onData(handler: (chunk: Uint8Array) => void): () => void {
		if (this.#dataHandler) throw new Error("control_transport_handler_exists: data handler already registered");
		this.#dataHandler = handler;
		return () => {
			if (this.#dataHandler === handler) this.#dataHandler = undefined;
		};
	}

	onClose(handler: (cause?: Error) => void): () => void {
		if (this.#closed) {
			queueMicrotask(() => notifyCloseObserver(handler, this.#closeCause));
			return () => undefined;
		}
		this.#closeHandlers.add(handler);
		return () => this.#closeHandlers.delete(handler);
	}

	close(): Promise<void> {
		return this.#transport.close();
	}

	activate(): void {
		if (this.#activated) return;
		this.#activated = true;
		const handler = this.#dataHandler;
		if (!handler) throw new Error("control_admission_invalid: channel data handler is unavailable");
		for (const chunk of this.#buffered.splice(0)) handler(chunk);
	}

	#receive(chunk: Uint8Array): void {
		if (this.#closed) return;
		if (!this.#helloSettled) {
			const newline = chunk.indexOf(0x0a);
			const segment = newline < 0 ? chunk : chunk.subarray(0, newline);
			if (this.#helloBuffer.byteLength + segment.byteLength > this.#maximumFrameBytes) {
				this.#failHello(new Error("control_admission_frame_too_large: Hello exceeds limit"));
				return;
			}
			this.#helloBuffer = concatenateBytes(this.#helloBuffer, segment);
			if (newline < 0) return;
			if (this.#helloBuffer.byteLength === 0) {
				this.#failHello(new Error("control_admission_malformed_hello: empty first frame"));
				return;
			}
			let value: unknown;
			try {
				const line = new TextDecoder("utf-8", { fatal: true }).decode(this.#helloBuffer);
				value = JSON.parse(line);
			} catch {
				this.#failHello(new Error("control_admission_malformed_hello: first frame is not valid UTF-8 JSON"));
				return;
			}
			if (!Check(HelloFrameSchema, value)) {
				this.#failHello(new Error("control_admission_hello_required: first frame must be a closed Hello"));
				return;
			}
			this.#helloSettled = true;
			const remainder = chunk.subarray(newline + 1);
			if (remainder.byteLength > 0) this.#buffered.push(remainder.slice());
			this.#resolveHello(value);
			return;
		}
		if (this.#activated) this.#dataHandler?.(chunk.slice());
		else this.#buffered.push(chunk.slice());
	}

	#failHello(cause: Error): void {
		if (this.#helloSettled) return;
		this.#helloSettled = true;
		this.#rejectHello(cause);
	}

	#finishClose(cause: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeCause = cause;
		this.#unsubscribeData?.();
		this.#unsubscribeClose?.();
		this.#unsubscribeData = undefined;
		this.#unsubscribeClose = undefined;
		this.#failHello(cause);
		const closeHandlers = [...this.#closeHandlers];
		this.#closeHandlers.clear();
		for (const handler of closeHandlers) notifyCloseObserver(handler, cause);
	}
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	if (left.byteLength === 0) return right.slice();
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left);
	result.set(right, left.byteLength);
	return result;
}

function notifyCloseObserver(handler: (cause?: Error) => void, cause?: Error): void {
	try {
		handler(cause);
	} catch {
		// Observers cannot interrupt admission cleanup or block one another.
	}
}

function abortError(): Error {
	return new DOMException("The control admission was cancelled", "AbortError");
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
